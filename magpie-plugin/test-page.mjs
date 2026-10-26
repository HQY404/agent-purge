// 假 DOM + 假 magpie，直接跑真实的 page/app.js。
// 真页面跑在 magpie 沙箱里，这里只验逻辑：搜索过滤、options 合并（agents 不丢）、
// 连点不丢、保存失败回滚。跑法：node magpie-plugin/test-page.mjs
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const appSrc = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "page/app.js"), "utf8");

class Node {
	constructor(tag = "div") {
		this.tag = tag;
		this.children = [];
		this.dataset = {};
		this.attrs = {};
		this.className = "";
		this.value = "";
		this.title = "";
		this.disabled = false;
		this.hidden = false;
		this._text = "";
	}
	set textContent(v) {
		this._text = String(v);
		this.children = [];
	}
	get textContent() {
		return this._text;
	}
	append(...kids) {
		for (const k of kids) this.children.push(k);
	}
	setAttribute(k, v) {
		this.attrs[k] = String(v);
	}
}

const ids = ["now-persona", "now-mode", "mode", "q", "list", "status", "count"];
const nodes = Object.fromEntries(ids.map((id) => [id, new Node()]));
// index.html 上 #status 带 hidden，app.js 必须自己解开它
nodes.status.hidden = true;
const document = { getElementById: (id) => nodes[id], createElement: (tag) => new Node(tag) };
class Option {
	constructor(text, value) {
		this.text = text;
		this.value = value;
	}
}

// 假时钟：把 1 秒限流变成瞬时，测试才能确定性地跑完
const realSetTimeout = globalThis.setTimeout;
let clock = 1_000_000;
const fakeSetTimeout = (fn) => {
	clock += 5000;
	queueMicrotask(fn);
	return 0;
};

const PERSONAS = [
	{ id: "terse", name: "极简", description: "只回答，不解释" },
	{ id: "neutral", name: "中性助手", description: "最小身份" },
	{ id: "ctf", name: "ctf", description: "" },
];
const window = { PERSONAS };

const calls = [];
let store = { persona: "terse", mode: "append", agents: ["claude"] };
let failNext = false;
const magpie = {
	ready: Promise.resolve(),
	options: {
		async get() {
			return { ...store };
		},
		async set(o) {
			calls.push({ ...o });
			if (failNext) {
				failNext = false;
				throw new Error("boom");
			}
			store = { ...o };
			return { ...store };
		},
	},
};

const tick = () => new Promise((r) => realSetTimeout(r, 0));
// 按钮的文字在子节点里，取整棵子树的文本
const textOf = (n) => (n._text ?? "") + (n.children ?? []).map(textOf).join(" ");
const ok = (cond, msg) => {
	if (!cond) {
		console.error(`✗ ${msg}`);
		process.exitCode = 1;
	} else console.log(`✓ ${msg}`);
};
const btn = (name) => nodes.list.children.find((b) => textOf(b).includes(name));

// page/app.js 是 classic script（不是 module），在沙箱里跑就和浏览器里一样
runInNewContext(appSrc, {
	magpie,
	document,
	Option,
	window,
	Promise,
	setTimeout: fakeSetTimeout,
	Date: { now: () => clock },
});
await tick();

// 1) 初始渲染：当前设置、状态行可见、模式下拉、人设列表
ok(nodes["now-persona"].textContent === "极简", "当前人设显示名字而不是 id");
ok(nodes["now-mode"].textContent === "append", "当前模式已显示");
ok(nodes.status.hidden === false, "状态行不再被 hidden 藏住（原 bug）");
ok(nodes.mode.children.length === 5, "模式下拉有 5 项（含跟随）");
ok(nodes.mode.value === "append", "模式下拉回显已保存的值");
ok(nodes.list.children.length === 3, "人设列表渲染了 3 个");
ok(nodes.count.textContent === "全部 3", "标题显示总数");
ok(nodes.status.textContent.includes("只对 claude 生效"), "状态行提示 agents 过滤仍然生效");

// 2) 搜索框真的过滤（原 bug：从未绑定）
nodes.q.value = "极简";
nodes.q.oninput();
ok(nodes.list.children.length === 1 && textOf(nodes.list.children[0]).includes("极简"), "搜索「极简」只剩 1 个");
ok(nodes.count.textContent === "匹配 1 / 3", "标题跟着过滤结果变");
nodes.q.value = "zzz";
nodes.q.oninput();
ok(nodes.list.children.length === 1 && nodes.list.children[0].className === "empty", "搜不到时给出空状态");
nodes.q.value = "";
nodes.q.oninput();

// 3) 点人设：options.set 必须带上原有的 agents（原 bug：整对象覆盖，丢用户 CLI 配置）
btn("中性助手").onclick();
await tick();
const first = calls.at(-1);
ok(first.persona === "neutral", "点击写入 persona");
ok(JSON.stringify(first.agents) === '["claude"]', "agents 过滤被保留，没有被覆盖掉（原 bug）");
ok(first.mode === "append", "没动的 mode 原样带回去");

// 4) 模式下拉：改 mode 不能丢 persona / agents
nodes.mode.value = "strict";
nodes.mode.onchange({ target: nodes.mode });
await tick();
const byMode = calls.at(-1);
ok(byMode.mode === "strict", "改 mode 会写进 options");
ok(byMode.persona === "neutral" && JSON.stringify(byMode.agents) === '["claude"]', "改 mode 时 persona 和 agents 都在");

// 5) 连点两次：不能丢最后一次（原 bug：1.1s 内直接 return）
btn("ctf").onclick();
btn("中性助手").onclick();
await tick();
ok(store.persona === "neutral", "第二次连点生效（最终状态以最后一次为准）");

// 6) 保存失败要回滚，不能显示假状态
failNext = true;
btn("ctf").onclick();
await tick();
ok(nodes.status.dataset.state === "error", "失败时状态行标成 error");
ok(nodes.status.textContent.includes("保存失败"), "失败时显示原因");
ok(nodes["now-persona"].textContent === "中性助手", "失败后 UI 回滚到已保存的值（原 bug：乐观更新不回滚）");

// 7) 读不到 options 时不开放交互（否则这期间的点击会用空 base 把 agents 写没）
const nodes2 = Object.fromEntries(ids.map((id) => [id, new Node()]));
nodes2.status.hidden = true;
runInNewContext(appSrc, {
	magpie: {
		ready: Promise.resolve(),
		options: {
			async get() {
				throw new Error("offline");
			},
		},
	},
	document: { getElementById: (id) => nodes2[id], createElement: (tag) => new Node(tag) },
	Option,
	window,
	Promise,
	setTimeout: fakeSetTimeout,
	Date: { now: () => clock },
});
await tick();
ok(nodes2.status.hidden === false && nodes2.status.dataset.state === "error", "读不到 options 时把错误写在状态行");
ok(nodes2.list.children.length === 0 && nodes2.mode.onchange === undefined, "读不到 options 时一个人设都不渲染、事件也不绑");

console.log(process.exitCode ? "\n有失败项" : `\n全部通过（共 ${calls.length} 次 options.set）`);
