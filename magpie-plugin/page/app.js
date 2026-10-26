// 人设页：只负责把人设 id 和模式写进这个插件的 options，真正改写请求的是 hooks.js。
// 沙箱页是 classic script（不是 module），所以整段包在 async IIFE 里。
// 页面里没有 fetch、读不到磁盘，因此清单来自 gen-personas.mjs 生成的 personas.js。
(async () => {
	await magpie.ready;

	const MODES = [
		["", "跟随 agent-purge（state.json）"],
		["strict", "strict — 只发人设，宿主 system 全丢"],
		["replace", "replace — 人设 + 宿主去掉身份句"],
		["append", "append — 人设在前，宿主原样"],
		["off", "off — 不注入"],
	];

	const $ = (id) => document.getElementById(id);
	let busy = false;
	let picked = { persona: "", mode: "" };

	function paint() {
		const list = $("list");
		list.textContent = "";
		const rows = window.PERSONAS ?? [];
		for (const p of rows) {
			const b = document.createElement("button");
			b.textContent = (p.id === picked.persona ? "✓ " : "") + (p.name || p.id);
			if (p.description) b.title = `${p.id} — ${p.description}`;
			b.disabled = busy;
			b.onclick = () => save({ persona: p.id });
			const row = document.createElement("p");
			row.append(b);
			list.append(row);
		}
		$("mode").value = picked.mode;
		$("status").textContent = busy
			? "已提交，magpie 正在重载插件…"
			: `当前：人设 ${picked.persona || "（跟随 state.json）"} / 模式 ${picked.mode || "跟随 state.json"}`;
	}

	async function save(patch) {
		if (busy) return;
		busy = true;
		picked = { ...picked, ...patch };
		paint();
		try {
			await magpie.options.set({ persona: picked.persona, mode: picked.mode });
		} catch (e) {
			$("status").textContent = `保存失败：${e?.message ?? e}`;
		}
		// options.set 每秒只收一次，留余量
		setTimeout(() => {
			busy = false;
			paint();
		}, 1100);
	}

	for (const [value, label] of MODES) $("mode").append(new Option(label, value));
	$("mode").onchange = (e) => save({ mode: e.target.value });

	const saved = (await magpie.options.get()) ?? {};
	picked = { persona: saved.persona ?? "", mode: saved.mode ?? "" };
	paint();
	// 清单是本机生成的（不进仓库），没生成过就只能是空的
	if (!(window.PERSONAS ?? []).length) $("status").textContent = "人设清单还没生成：跑 node magpie-plugin/gen-personas.mjs";
})();
