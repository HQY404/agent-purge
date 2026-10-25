// 零依赖 Web 服务：配置台。选默认 harness/mode、管理 persona、常驻安装、探测。
// 刻意不做"运行"：交互式 harness 属于终端/桌面，Web 只负责选（见 ARCHITECTURE.md）。
import { createServer } from "node:http";import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detect } from "../lib/detect.mjs";
import { oneshots } from "../backends/index.mjs";
import { createStore } from "../lib/personas.mjs";
import { MODES, armedOf, loadState, patchState, setArmed, setDefault, setPersona } from "../lib/state.mjs";
import { install, status as persistStatus, uninstall } from "../lib/persist.mjs";
import { plans, summary as armorSummary } from "../lib/armor.mjs";
import { installShim, shimStatus, uninstallShim } from "../lib/shim.mjs";
import { installSlash, refreshSlashes, slashStatus, uninstallSlash } from "../lib/slashes.mjs";
import { reconcileArmed } from "../lib/armed.mjs";
import { capsFor } from "../lib/caps.mjs";

const ROOT = process.versions.bun ? dirname(process.execPath) : dirname(dirname(fileURLToPath(import.meta.url)));
// 运行期真正被改写的层（≠ bench 能测到的层）：每家只有它自己暴露的那一个写入点。
// sys = 系统提示/配置文件/插件 splice；user = 只落在用户消息里（zcode 的 hook）。
const LAYER = {
	pi: "sys", codex: "sys", codebuddy: "sys", claude: "sys", grok: "sys",
	omp: "sys", opencode: "sys", hermes: "sys", antigravity: "sys",
	// zcode 只有文档说它会读 AGENTS.md，桌面版闭源、无法复核，层就不claim（UI 显示“—”+「文档」）
	zcode: "",
};
const matrix = JSON.parse(readFileSync(join(ROOT, "matrix.json"), "utf8"));
const store = createStore(ROOT);

export function serveWeb(port = 7788) {
	const server = createServer(handle);
	server.on("error", (e) => {
		// 端口被旧实例占着的时候，--detach 是静默的 → 这里必须说人话，否则用户看到的是旧 UI
		if (e.code === "EADDRINUSE") {
			console.error(`${port} 已被占用：老实例还在跑（可能是改动前的版本，UI 会是旧的）。`);
			console.error(`清掉再启：Get-NetTCPConnection -LocalPort ${port} -State Listen | % { Stop-Process -Id $_.OwningProcess -Force }`);
		} else {
			console.error(`web 启动失败：${e.message}`);
		}
		process.exit(1);
	});
	server.listen(port, "127.0.0.1", () => {
		console.log(`agent-purge web → http://127.0.0.1:${port}`);
	});
}

async function handle(req, res) {
	const url = new URL(req.url, "http://127.0.0.1");
	const p = url.pathname;

	if (req.method === "GET" && (p === "/" || p === "/index.html")) return html(res);
	if (req.method === "GET" && p === "/api/state") return send(res, 200, await state(url.searchParams.get("versions") === "1"));
	if (req.method === "GET" && p === "/api/armor") return send(res, 200, armorState());
	if (req.method === "POST" && p === "/api/defaults") return send(res, 200, saveDefaults(await body(req)));
	if (req.method === "POST" && p === "/api/persona") return send(res, 200, savePersona(await body(req)));
	if (req.method === "DELETE" && p === "/api/persona") return send(res, 200, deletePersona(url.searchParams.get("id")));
	if (req.method === "POST" && p === "/api/use") return send(res, 200, usePersona(await body(req)));
	if (req.method === "POST" && p === "/api/install") return send(res, 200, applyInstall(await body(req)));
	if (req.method === "POST" && p === "/api/arm") return send(res, 200, applyArm(await body(req)));
	if (req.method === "POST" && p === "/api/arm-all") return send(res, 200, applyArmAll(await body(req)));
	send(res, 404, { error: "not found" });
}

function armorState() {
	const rows = plans(matrix).map((x) => ({
		id: x.id,
		class: x.class,
		bare: x.bare,
		persona: x.persona,
		recommended: x.recommended,
		blocked: x.blocked,
		warnings: x.warnings,
		requiresSeed: x.requiresSeed,
		mode: x.mode ?? null,
		defaultLayers: x.defaultLayers ?? [],
		cmd: x.cmd,
	}));
	return {
		target: matrix.armorTarget ?? null,
		measuredAt: matrix.armorMeasuredAt ?? null,
		judge: matrix.armorJudge ?? null,
		rows,
	};
}

async function state(withVersions) {
	// 先跟磁盘对账，再报数：armed 是缓存，磁盘才是真相
	const reconciled = await reconcileArmed(ROOT);
	const found = detect({ versions: withVersions });
	const persisted = persistStatus(ROOT);
	const { state: st } = loadState(ROOT);
	const shims = shimStatus();
	const slashes = slashStatus(ROOT);
	const harnesses = Object.entries(matrix.harnesses).map(([id, m]) => {
		const d = found[id] ?? {};
		const inst = persisted.find((x) => x.name === id);
		const armed = armedOf(st, id);
		return {
			id,
			class: m.class,
			override: m.override === true ? "yes" : m.override ? String(m.override) : "no",
			inject: Boolean(m.inject),
			hotSwitch: Boolean(m.hotSwitch),
			chars: m.defaultSystemChars != null ? `${m.defaultSystemChars} → ${m.purgedSystemChars ?? "?"}` : null,
			version: d.version ?? m.measuredVersion ?? null,
			residue: m.residue ?? null,
			reason: m.reason ?? null,
			supported: m.class !== "unsupported",
			oneshot: Boolean(oneshots[id]),
			layer: LAYER[id] ?? (m.class === "unsupported" ? null : "sys"),
			found: Boolean(d.found),
			bin: d.bin ?? null,
			home: d.home ?? null,
			homeExists: Boolean(d.homeExists),
			persistable: Boolean(inst),
			installed: Boolean(inst?.installed),
			persistFile: inst?.file ?? null,
			armed,
			shim: Boolean(shims.find((s) => s.id === id)?.installed),
			slash: slashes.find((s) => s.id === id) ?? null,
			// 每条通道「能不能用 + 为什么不能用」由 lib/caps.mjs 统一裁决：
			// UI 只负责画，不再自己猜（以前 shim 硬编码可点，zcode 点了必然无效）
			caps: capsFor(id, { bin: d.bin ?? null }),
		};
	});
	return {
		harnesses,
		reconciled,
		personas: store.list().map((x) => ({ id: x.id, meta: x.meta, body: x.body, chars: x.body.trim().length })),
		active: store.activeId(),
		persona: st.persona,
		defaults: st.default,
		armed: st.armed ?? {},
		modes: MODES,
		shimDir: shimStatus()[0]?.dir ?? null,
		slashes: slashes,
	};
}

function saveDefaults(payload) {
	const { harness, mode } = payload;
	const spec = matrix.harnesses[harness];
	if (!spec) return { error: `未知 harness: ${harness}` };
	if (spec.class === "unsupported") return { error: `${harness} 做不到：${spec.reason}` };
	if (mode && !MODES.includes(mode)) return { error: `mode 只能是 ${MODES.join(" / ")}` };
	try {
		return { ok: true, defaults: setDefault(ROOT, { harness, mode: mode ?? "replace" }) };
	} catch (e) {
		return { error: e.message };
	}
}

function savePersona(payload) {
	const id = String(payload.id || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
	if (!id) return { error: "id 不能为空（小写字母/数字/-/_）" };
	if (!payload.body?.trim()) return { error: "正文不能为空" };
	try {
		const saved = store.save(id, { meta: { ...payload.meta, id }, body: payload.body });
		return { ok: true, persona: { id: saved.id, meta: saved.meta, body: saved.body } };
	} catch (e) {
		return { error: e.message };
	}
}

function deletePersona(id) {
	if (!id) return { error: "缺少 id" };
	if (store.list().length <= 1) return { error: "至少保留一个 persona" };
	store.remove(id); // remove 内部会处理“删的就是 active”的指针改道
	return { ok: true, active: store.activeId() };
}

function usePersona(payload) {
	if (!payload.id) return { error: "缺少 id" };
	try {
		store.setActive(payload.id);
		// 两个指针必须一起写，否则 UI 选的“当前人设”和 `agent-purge` 实际用的不是同一个
		setPersona(ROOT, payload.id);
		const { state: st } = loadState(ROOT);
		const slashTargets = Object.entries(st.armed ?? {})
			.filter(([, a]) => a.includes("slash"))
			.map(([k]) => k);
		const refreshed = refreshSlashes(ROOT, slashTargets, { personaId: payload.id, personaBody: store.read(payload.id).body.trim() });
		return { ok: true, active: payload.id, refreshed };
	} catch (e) {
		return { error: e.message };
	}
}

/** 全局总开关：所有 harness × 选定通道一次折腾完（= `agent-purge 注册 --all` / `disarm --all`）*/
function applyArmAll(payload) {
	const { action } = payload;
	const channel = payload.channel ?? "all";
	const verb = verbOf(action);

	// 全局总闸 = 电源，不只是注册表：撤的时候把 default.mode 置 off（记下 prevMode），
	// 否则 `agent-purge <h>` 这条入口永远注入 —— 用户实测“关了也能直接接管”就出在这。
	// 开的时候把上次的 mode 还回去。
	const { state: cur } = loadState(ROOT);
	const m = cur.default?.mode ?? "off";
	if (verb === "off" && m !== "off" && cur.default?.harness) {
		setDefault(ROOT, { harness: cur.default.harness, mode: "off" });
		patchState(ROOT, { prevMode: m });
	}
	if (verb === "on" && m === "off" && cur.default?.harness) {
		const back = MODES.includes(cur.prevMode) && cur.prevMode !== "off" ? cur.prevMode : "replace";
		setDefault(ROOT, { harness: cur.default.harness, mode: back });
	}

	const perHarness = [];
	const failed = [];
	for (const [h, spec] of Object.entries(matrix.harnesses)) {
		if (spec.class === "unsupported") {
			failed.push(`${h}: 做不到（${spec.reason}）`);
			continue;
		}
		const r = applyArm({ harness: h, channel, action: verb, persona: payload.persona });
		if (r.error) failed.push(`${h}: ${r.error}`);
		else perHarness.push({ harness: h, done: (r.done ?? []).map((d) => d.channel), skipped: r.skipped ?? [] });
	}
	if (!perHarness.length) return { error: failed.join("；") || "没有可注册的 harness" };
	const after = loadState(ROOT).state.default;
	return { ok: true, action: verb, channel, mode: after?.mode ?? null, harnesses: perHarness, failed };
}

function applyInstall(payload) {
	const { harness, action } = payload;
	if (action === "uninstall") {
		const r = uninstall(harness);
		setArmed(ROOT, harness, "install", false);
		return { ok: true, result: r };
	}
	// 装谁就把谁设为 active：active.md 与 install 指向始终是同一份正文
	const wanted = payload.persona ?? store.activeId();
	if (!store.read(wanted)) return { error: "没有可用 persona" };
	store.setActive(wanted);
	const r = install(harness, { root: ROOT, active: store.refreshActive() });
	if (r.error) return { error: r.error };
	setArmed(ROOT, harness, "install", true);
	return { ok: true, result: r };
}

/** UI 传 install/uninstall、CLI 传 on/off —— 统一成 on/off，否则 uninstall 会被当成安装 */
const VERB_OFF = new Set(["off", "uninstall", "remove", "stop", "false", false, 0]);
function verbOf(action) {
	return VERB_OFF.has(action) ? "off" : "on";
}

/** 裸命令接管（shim）、/purge（slash）、常驻（install）：Web 上一个开关全部搞定 */
function applyArm(payload) {
	const { harness, channel, action } = payload;
	const id = payload.persona ?? store.activeId();
	if (!store.read(id)) return { error: "没有可用 persona" };
	const verb = verbOf(action);
	const channels = !channel || channel === "all" ? ["install", "shim", "slash"] : [channel];
	const done = [];
	const skipped = [];
	for (const ch of channels) {
		const r = armChannel(harness, ch, verb, id);
		if (r.error) skipped.push(`${ch}: ${r.error}`);
		else done.push({ channel: ch, ...r });
	}
	if (!done.length) return { error: skipped.join("；") || "没有可用通道" };
	return { ok: true, harness, action: verb, done, skipped };
}

function armChannel(harness, channel, verb, id) {
	// 开之前先问能力表：这条通道在这家身上本来就无效的，不写任何文件、直接说明原因
	if (verb === "on") {
		const cap = capsFor(harness)[channel];
		if (cap && !cap.ok) return { error: cap.why };
	}
	if (channel === "install") {
		const r = verb === "off" ? applyInstall({ harness, action: "uninstall" }) : applyInstall({ harness, action: "install", persona: id });
		return r.error ? { error: r.error } : (r.result ?? { ok: true });
	}
	if (channel === "shim") {
		if (verb === "off") {
			const r = uninstallShim(ROOT, harness);
			if (r.error) return { error: r.error };
			setArmed(ROOT, harness, "shim", false);
			return { removed: r.removed };
		}
		const r = installShim(ROOT, harness);
		if (r.error) return { error: r.error };
		setArmed(ROOT, harness, "shim", true);
		return { file: r.file, real: r.real };
	}
	if (channel === "slash") {
		if (verb === "off") {
			const r = uninstallSlash(harness, ROOT);
			if (r.error) return { error: r.error };
			setArmed(ROOT, harness, "slash", false);
			return { removed: r.removed };
		}
		const r = installSlash(harness, ROOT, { personaId: id, personaBody: store.read(id).body.trim() });
		if (r.error) return { error: r.error };
		setArmed(ROOT, harness, "slash", true);
		return { file: r.file, layer: r.layer };
	}
	return { error: `未知通道: ${channel}` };
}

const send = (res, code, obj) => res.writeHead(code, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(obj));
const html = (res) =>
	res
		.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
		.end(readFileSync(join(ROOT, "web", "ui.html"), "utf8"));

function body(req) {
	return new Promise((resolve) => {
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", () => {
			try {
				resolve(JSON.parse(raw || "{}"));
			} catch {
				resolve({});
			}
		});
	});
}

// 只有被直接当脚本跑（node web/server.mjs --serve 7788）才自启动；
// 被 bin 导入时必须保持安静——否则 `agent-purge web --serve 7789` 会两个端口各起一个实例，
// 并在第二个 bind 时吐出误导性的“端口已被占用：老实例还在跑”。
const isEntry = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry && process.argv.includes("--serve")) serveWeb(Number(process.argv[process.argv.indexOf("--serve") + 1] ?? 7788));
