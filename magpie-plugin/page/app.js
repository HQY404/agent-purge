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
	// magpie.options.set 每秒只收一次；两次调用之间必须留够间隔
	const RATE_MS = 1000;

	const $ = (id) => document.getElementById(id);
	const rows = () => window.PERSONAS ?? [];
	const nameOf = (id) => rows().find((p) => p.id === id)?.name || id;
	const pickKey = () => JSON.stringify([picked.persona, picked.mode]);
	// 跟随态写空串：hooks.js 只认 MODES 里的值，其余回退 state.json
	const modeText = (m) => m || "跟随 state.json";

	let base = {}; // 服务端已知的完整 options：页面不管的键（如 agents）原样带回去
	let picked = { persona: "", mode: "" }; // 页面上的选择，可能还没落地
	let sent = ""; // 最后一次成功落地的选择
	let sending = false;
	let lastAt = 0;
	let failed = "";

	function paintStatus() {
		const st = $("status");
		const only = Array.isArray(base.agents) && base.agents.length ? `（只对 ${base.agents.join(" / ")} 生效）` : "";
		st.hidden = false;
		st.dataset.state = failed ? "error" : sending ? "busy" : "ok";
		st.textContent = failed
			? failed
			: sending
				? "正在保存…"
				: `${picked.persona ? nameOf(picked.persona) : "跟随 state.json"} · ${modeText(picked.mode)}${only}`;
	}

	function paint() {
		$("now-persona").textContent = picked.persona ? nameOf(picked.persona) : "跟随 state.json";
		$("now-mode").textContent = modeText(picked.mode);
		$("mode").value = picked.mode;

		const q = $("q").value.trim().toLowerCase();
		const hits = rows().filter(
			(p) => !q || [p.id, p.name, p.description].some((s) => (s ?? "").toLowerCase().includes(q)),
		);

		const list = $("list");
		// 重建会销毁按钮，键盘用户选完后焦点不能掉回 body
		const focused = document.activeElement?.dataset?.persona ?? "";
		let again = null;
		$("count").textContent = q ? `匹配 ${hits.length} / ${rows().length}` : `全部 ${rows().length}`;
		list.textContent = "";
		if (!hits.length) {
			const empty = document.createElement("p");
			empty.className = "empty";
			empty.textContent = rows().length
				? "没有匹配的人设"
				: "人设清单还没生成：跑 node magpie-plugin/gen-personas.mjs";
			list.append(empty);
		}
		for (const p of hits) {
			const on = p.id === picked.persona;
			const b = document.createElement("button");
			b.type = "button";
			b.className = on ? "persona on" : "persona";
			b.dataset.persona = p.id;
			if (p.id === focused) again = b;
			b.setAttribute("aria-pressed", on ? "true" : "false");
			b.title = p.description || p.id;
			const name = document.createElement("strong");
			name.textContent = (on ? "✓ " : "") + (p.name || p.id);
			b.append(name);
			if (p.description) {
				const desc = document.createElement("span");
				desc.textContent = p.description;
				b.append(desc);
			}
			if (p.id !== (p.name || p.id)) {
				const id = document.createElement("code");
				id.textContent = p.id;
				b.append(id);
			}
			b.onclick = () => save({ persona: p.id });
			list.append(b);
		}
		if (again) again.focus();
		paintStatus();
	}

	function save(patch) {
		failed = "";
		picked = { ...picked, ...patch };
		paint();
		void flush();
	}

	// 串行化 + 合并：点击期间不丢，最终以最后一次选择为准
	async function flush() {
		if (sending) return; // 正在跑的那一轮收尾时会自己再检查一次
		sending = true;
		try {
			while (sent !== pickKey()) {
				const key = pickKey();
				const body = { ...base, persona: picked.persona, mode: picked.mode };
				const wait = Math.max(0, RATE_MS + 50 - (Date.now() - lastAt));
				if (wait) await new Promise((r) => setTimeout(r, wait));
				lastAt = Date.now();
				let saved = body;
				try {
					// set 返回保存后的完整 options，以它为准（magpie 可能补默认值）
					saved = (await magpie.options.set(body)) ?? body;
				} catch (e) {
					failed = `保存失败：${e?.message ?? e}`;
					picked = { persona: base.persona ?? "", mode: base.mode ?? "" };
					paint();
					return;
				}
				// 回包如果只是归一化后的部分键，也别把 body 里它没回的键丢掉
				base = typeof saved === "object" && saved ? { ...body, ...saved } : body;
				sent = key;
				paint();
			}
		} finally {
			sending = false;
			paintStatus();
		}
	}

	for (const [value, text] of MODES) $("mode").append(new Option(text, value));

	// 先拿到完整 options 再开放交互：否则这期间的点击会用空 base 组 body，把 agents 写没
	try {
		base = (await magpie.options.get()) ?? {};
	} catch (e) {
		$("status").hidden = false;
		$("status").dataset.state = "error";
		$("status").textContent = `读不到当前 options：${e?.message ?? e}`;
		return;
	}
	picked = { persona: base.persona ?? "", mode: base.mode ?? "" };
	sent = pickKey();
	paint();
	$("mode").onchange = (e) => save({ mode: e.target.value });
	$("q").oninput = () => paint();
})();
