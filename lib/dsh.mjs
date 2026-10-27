// dsh（DeepSeek Harness）的插件通道，三形态（desktop / web / headless）共用一套写法。
//
// 两个插件名，互不覆盖：
//   agent-purge          常驻：每次 assemble 读 state.json + active.md，off 即时生效
//   agent-purge-session  一次性：persona 快照编译进源码，进程退出即删
//
// 三个 profile 都要装：paths 推导自 profile 的 dirname（src/index.js → package root），
// 所以包必须放在 <profile>/node_modules/<name> 下。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DSH_PROFILES = ["desktop", "web", "headless"];
export const RESIDENT = "agent-purge";
export const SESSION = "agent-purge-session";

export const dshHome = () => process.env.DSH_HOME || join(homedir(), ".dsh");
export const profileDir = (p) => join(dshHome(), "profiles", p);
export const pluginDir = (p, name = RESIDENT) => join(profileDir(p), "node_modules", name);
const patchFile = (p) => join(profileDir(p), "cordis.patch.yml");

const mark = (name) => [`# >>> agent-purge:${name}`, `# <<< agent-purge:${name}`];

/** 这个 package.json 是 agent-purge 写的吗（别碰同名外来目录）。 */
const isOurs = (meta) => existsSync(meta) && /"?agentPurge"?\s*:\s*true/.test(readFileSync(meta, "utf8"));

/** 常驻插件：不编译人设，每次请求现读 state；off 就原样放过宿主的结果。 */
export function residentSource(root, activePath) {
	const state = join(root, "state.json").replace(/\\/g, "/");
	// active.md 是派生物，实际位置是 <root>/personas/active.md（由 createStore().materialize 给出）
	const active = String(activePath).replace(/\\/g, "/");
	return `// 由 agent-purge 生成；删掉本目录 + patch 段即取消。
import { readFileSync } from "node:fs";
const STATE = ${JSON.stringify(state)};
const ACTIVE = ${JSON.stringify(active)};
function cfg() {
  try {
    const st = JSON.parse(readFileSync(STATE, "utf8"));
    // 磁盘卸载后内存里的回调还在：armed 里没有 install 就当成已关闭
    const armed = st && st.armed && st.armed.dsh;
    if (!Array.isArray(armed) || !armed.includes("install")) return null;
    const mode = (st && st.default && st.default.mode) || "replace";
    if (mode === "off") return null;
    const body = readFileSync(ACTIVE, "utf8").trim();
    return body ? { mode, body } : null;
  } catch {
    return null;
  }
}
export default {
  name: ${JSON.stringify(RESIDENT)},
  inject: ["systemPrompt"],
  apply(ctx) {
    const prompt = ctx.systemPrompt;
    const orig = prompt.assemble.bind(prompt);
    prompt.assemble = async (...rest) => {
      const asm = await orig(...rest);
      const c = cfg();
      if (!c) return asm;
      if (c.mode === "append") return { ...asm, sections: [...(asm.sections || []), { name: ${JSON.stringify(RESIDENT)}, text: c.body }] };
      return { ...asm, sections: [{ name: ${JSON.stringify(RESIDENT)}, text: c.body }] };
    };
  },
};
`;
}

/** 一次性插件：人设快照内嵌，进程结束就没。 */
export function sessionSource(personaText, mode) {
	const body =
		mode === "append"
			? `\t\tctx.systemPrompt.section({ name: ${JSON.stringify(SESSION)}, order: 5100, interpolate: false, text: PERSONA });`
			: `\t\tconst prompt = ctx.systemPrompt;\n\t\tconst orig = prompt.assemble.bind(prompt);\n\t\tprompt.assemble = async (...rest) => {\n\t\t\tconst asm = await orig(...rest);\n\t\t\treturn { ...asm, sections: [{ name: ${JSON.stringify(SESSION)}, text: PERSONA }] };\n\t\t};`;
	return `// 由 agent-purge 生成（一次性，进程退出即删）。
const PERSONA = ${JSON.stringify(personaText.trim())};

export default {
  name: ${JSON.stringify(SESSION)},
  inject: ["systemPrompt"],
  apply(ctx) {
${body}
  },
};
`;
}

/** 装一个插件名到三个 profile，并在 patch 里挂上（同一段 marker 幂等）。 */
export function addPlugin(name, source) {
	const pkg = JSON.stringify({ name, version: "0.0.0", type: "module", main: "index.js", agentPurge: true }, null, 1);
	const [begin, end] = mark(name);
	const block = `\n${begin}\n- insert:\n    - id: ${name}\n      name: ${name}\n${end}\n`;
	const files = [];
	const touched = []; // { dir, patch, before }：中途抛错时按相反顺序回滚
	// 预检：同名目录要么不存在，要么是我们的（package.json 带 agentPurge 标记），否则不碰
	for (const p of DSH_PROFILES) {
		const dir = pluginDir(p, name);
		const meta = join(dir, "package.json");
		if (existsSync(dir) && !isOurs(meta)) throw new Error(`${dir} 已存在且不是 agent-purge 装的，拒绝覆盖`);
	}
	try {
		for (const p of DSH_PROFILES) {
			const dir = pluginDir(p, name);
			const patch = patchFile(p);
			const before = existsSync(patch) ? readFileSync(patch, "utf8") : null;
			// 先登记再动手：下面任何一步抛错，这一轮的产物都能被回滚
			touched.push({ dir, patch, before });
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "package.json"), pkg);
			writeFileSync(join(dir, "index.js"), source);
			files.push(dir);
			const old = before ?? "# agent-purge 新建的 patch 层\n";
			if (old.includes(begin)) continue;
			// `[]` 是合法空数组，后面接 `- insert:` 就是非法 YAML：整份换成我们的段
			// 不存在也算“空”：走 stash 分支才能把“原本没有这个文件”记下来，卸载后才不会留个空壳
			const empty = before === null || /^\s*(\[\s*\]\s*)?$/.test(old);
			const next = empty ? block.slice(1) : old + block;
			if (empty) {
				// 整份替换会把原文端掉：原文 + 我们写出的成品都存下，卸载时对得上才整份还原
				// （对不上 = 期间被人改过，那就只剔自己那段）
				writeFileSync(join(dir, ".patch.before"), JSON.stringify({ before, after: next }));
			}
			writeFileSync(patch, next);
		}
	} catch (e) {
		// 回滚：撤销本次已写的文件，宁可完全没装也不留半套
		for (const { dir, patch, before } of touched.reverse()) {
			rmSync(dir, { recursive: true, force: true });
			if (before === null) rmSync(patch, { force: true });
			else writeFileSync(patch, before);
		}
		throw e;
	}
	return { dirs: files, profiles: DSH_PROFILES };
}

/** 只撤自己那一段：目录 + patch marker，别的配置原样。 */
export function removePlugin(name) {
	const [begin, end] = mark(name);
	// 删 install 写入的那一段：前导 \n 可有可无（整份替换的形态没有），尾随 \n 一并吃掉
	const re = new RegExp(`(?:^|\\n)${begin}[\\s\\S]*?${end}\\n?`, "g");
	for (const p of DSH_PROFILES) {
		const dir = pluginDir(p, name);
		const meta = join(dir, "package.json");
		// 只删自己装的；同名但不是我们的目录留着（可能被用户或其他包占了）
		const ours = isOurs(meta);
		const stashFile = join(dir, ".patch.before");
		// 当初整份替换过的：记录躲在插件目录里，先读出来，不然删目录就丢了
		let stash = null;
		if (ours && existsSync(stashFile)) {
			try {
				stash = JSON.parse(readFileSync(stashFile, "utf8"));
			} catch {
				stash = null;
			}
		}
		if (ours) rmSync(dir, { recursive: true, force: true });
		const patch = patchFile(p);
		if (!existsSync(patch)) continue;
		const text = readFileSync(patch, "utf8");
		// 我们整份写的、且此后没人动过 → 整份还原（原本没这个文件就删掉它）
		if (stash && text === stash.after) {
			if (stash.before === null) rmSync(patch, { force: true });
			else writeFileSync(patch, stash.before);
			continue;
		}
		if (text.includes(begin)) writeFileSync(patch, text.replace(re, ""));
	}
}

/** patch 里还挂着这个名字吗（status 用；不许在有其他 insert 时谎报干净）。 */
export function hasPlugin(name) {
	const [begin] = mark(name);
	return DSH_PROFILES.every((p) => {
		const patch = patchFile(p);
		return existsSync(join(pluginDir(p, name), "index.js")) && existsSync(patch) && readFileSync(patch, "utf8").includes(begin);
	});
}
