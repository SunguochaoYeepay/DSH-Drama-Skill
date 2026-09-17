/**
 * dsh-storyboard 客户端半 —— 右侧栏的「分镜」面板。
 *
 * 里程碑 1：读会话工作区里的分镜契约文件，渲染确认表，点一行看那一镜的素材。
 *
 * 两条关键契约（都核对过源码）：
 *  - 读文件走 Host 的 Remote：ctx.remote.workspaceFiles.readAll(sessionId, path, signal)，
 *    返回 RemoteResult<{ data: base64 }>；path 可以是绝对路径，也可以是相对工作区根的路径。
 *  - 客户端调用不 reject，而是 resolve 出 { ok: false, error }，所以必须显式判 ok。
 */
window.__ModuleLoader__.load({
	id: "dsh-storyboard",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let React = require("react");

		/** tab 类型的身份，同时也是 body 注册的 key。 */
		const ID = "dsh-storyboard";
		/** tab 类型的判别符。 */
		const KIND = "storyboard";
		/** 兜底的分镜文件，相对会话工作区根。 */
		const BOARD_PATH = "board.json";
		/** 找分镜文件时依次尝试的目录。 */
		const BOARD_DIRS = ["."];
		/**
		 * 流水线写的「当前板子」指针。**面板先读它，读不到才扫目录。**
		 * 必须有它：`workspaceFiles.list` 不返回修改时间，扫目录没法判哪个是在用的。
		 */
		const POINTER_PATH = "current.json";
		/** 用户选过的文件记在这里，换标签、换会话都还在。 */
		const STORAGE_KEY = "dsh-storyboard.boardPath";

		/** 闸门顺序与显示名。 */
		const GATES = [
			["story", "① 故事"],
			["shots", "② 分镜表"],
			["assets", "③ 资产"],
			["keyframes", "④ 关键帧"],
			["rendering", "⑤ 出片"]
		];

		/** apply 时装进来的宿主能力。组件拿不到 ctx，服务留在闭包里。 */
		const host = { readAll: null, list: null };

		/** 面板样式。颜色走主题语义 token，带深色兜底。 */
		const S = {
			panel: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0, font: "12px/1.55 system-ui,'Segoe UI',sans-serif" },
			head: { padding: "10px 12px", borderBottom: "1px solid rgba(127,127,127,.25)", flex: "0 0 auto" },
			title: { fontWeight: 600, fontSize: "13px", marginBottom: "2px" },
			dim: { opacity: 0.6 },
			gates: { display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "7px", fontSize: "11px" },
			gateOn: { padding: "1px 7px", borderRadius: "999px", background: "rgba(64,160,96,.20)", border: "1px solid rgba(64,160,96,.55)" },
			gateNow: { padding: "1px 7px", borderRadius: "999px", background: "rgba(220,160,40,.20)", border: "1px solid rgba(220,160,40,.65)" },
			gateOff: { padding: "1px 7px", borderRadius: "999px", opacity: 0.45, border: "1px solid rgba(127,127,127,.35)" },
			scroll: { flex: "1 1 auto", overflow: "auto", minHeight: 0 },
			table: { borderCollapse: "collapse", width: "100%", fontSize: "11.5px" },
			th: { position: "sticky", top: 0, zIndex: 1, background: "var(--dsw-alias-bg-base, #1b1b1d)", textAlign: "left", padding: "6px 8px", fontWeight: 600, opacity: 0.75, borderBottom: "1px solid rgba(127,127,127,.35)", whiteSpace: "nowrap" },
			td: { padding: "6px 8px", borderBottom: "1px solid rgba(127,127,127,.15)", verticalAlign: "top" },
			rowOn: { background: "rgba(90,140,255,.15)" },
			row: { cursor: "pointer" },
			detail: { flex: "0 0 auto", maxHeight: "48%", overflow: "auto", padding: "10px 12px", borderTop: "1px solid rgba(127,127,127,.3)", background: "rgba(127,127,127,.05)" },
			note: { margin: "0 0 6px", opacity: 0.6 },
			bad: { margin: "0 0 6px", color: "#e06c6c" },
			kv: { margin: "0 0 4px" },
			key: { opacity: 0.55, marginRight: "6px" },
			stage: { marginTop: "8px", display: "flex", justifyContent: "center" },
			media: { maxWidth: "100%", maxHeight: "240px", borderRadius: "4px", background: "#000" },
			picker: { display: "flex", gap: "6px", marginTop: "7px", alignItems: "center" },
			select: {
				flex: "1 1 auto", minWidth: 0, font: "11px/1.4 system-ui,sans-serif",
				padding: "2px 4px", borderRadius: "4px", color: "inherit",
				background: "var(--dsw-alias-bg-base, #1b1b1d)",
				border: "1px solid rgba(127,127,127,.35)"
			},
			btn: {
				flex: "0 0 auto", font: "11px/1.4 system-ui,sans-serif", padding: "2px 8px",
				borderRadius: "4px", color: "inherit", background: "transparent",
				border: "1px solid rgba(127,127,127,.35)", cursor: "pointer"
			},
			assets: { flex: "0 0 auto", padding: "8px 12px", borderBottom: "1px solid rgba(127,127,127,.25)" },
			assetsHead: { fontSize: "11px", opacity: 0.6, marginBottom: "6px" },
			assetsRow: { display: "flex", gap: "8px", overflowX: "auto", paddingBottom: "2px" },
			assetCard: {
				flex: "0 0 auto", width: "104px", padding: "4px", borderRadius: "6px",
				border: "1px solid rgba(127,127,127,.28)", background: "transparent",
				color: "inherit", cursor: "pointer", textAlign: "left"
			},
			assetCardOn: { border: "1px solid rgba(90,140,255,.75)", background: "rgba(90,140,255,.12)" },
			assetThumb: { width: "100%", height: "58px", objectFit: "cover", borderRadius: "3px", display: "block" },
			assetThumbEmpty: {
				width: "100%", height: "58px", borderRadius: "3px", display: "flex",
				alignItems: "center", justifyContent: "center", background: "rgba(127,127,127,.15)", opacity: 0.5
			},
			assetLabel: { display: "block", fontSize: "10.5px", opacity: 0.75, marginTop: "3px", lineHeight: 1.3 },
			assetBig: { maxWidth: "100%", maxHeight: "300px", borderRadius: "4px" }
		};

		/** base64 → Uint8Array。 */
		function fromBase64(base64) {
			const raw = atob(base64);
			const out = new Uint8Array(raw.length);
			for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
			return out;
		}

		/** 从路径取小写后缀。 */
		function extensionOf(filePath) {
			const clean = String(filePath || "").split("?")[0];
			const dot = clean.lastIndexOf(".");
			return dot < 0 ? "" : clean.slice(dot + 1).toLowerCase();
		}

		/** 后缀 → MIME（Blob 类型不对，img/video 会拒播）。 */
		function mimeOf(filePath) {
			const ext = extensionOf(filePath);
			if (ext === "png") return "image/png";
			if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
			if (ext === "gif") return "image/gif";
			if (ext === "webp") return "image/webp";
			if (ext === "svg") return "image/svg+xml";
			if (ext === "mp4" || ext === "m4v") return "video/mp4";
			if (ext === "webm") return "video/webm";
			if (ext === "mov") return "video/quicktime";
			if (ext === "mp3") return "audio/mpeg";
			if (ext === "wav") return "audio/wav";
			return "application/octet-stream";
		}

		/** @returns 该路径是否按视频播放。 */
		function isVideoPath(filePath) {
			const ext = extensionOf(filePath);
			return ext === "mp4" || ext === "m4v" || ext === "webm" || ext === "mov" || ext === "mkv";
		}

		/**
		 * 读一个工作区文件成 blob URL。调用方负责 revoke。
		 * @param sessionId - 会话身份。
		 * @param filePath - 绝对路径或相对工作区根的路径。
		 * @param signal - 取消信号。
		 * @returns blob URL。
		 */
		async function readBlobUrl(sessionId, filePath, signal) {
			const result = await host.readAll(sessionId, filePath, signal);
			if (!result || result.ok !== true) {
				const failure = result && result.error;
				throw new Error(failure ? failure.code + " · " + failure.message : "读取失败");
			}
			return URL.createObjectURL(new Blob([fromBase64(result.value.data)], { type: mimeOf(filePath) }));
		}

		/** 读上一次选过的分镜文件；localStorage 不可用就退回默认。 */
		function readStoredPath() {
			try {
				return window.localStorage.getItem(STORAGE_KEY) || BOARD_PATH;
			} catch (error) {
				return BOARD_PATH;
			}
		}

		/** 记住用户的选择；失败无所谓，不影响这次使用。 */
		function storePath(filePath) {
			try {
				window.localStorage.setItem(STORAGE_KEY, filePath);
			} catch (error) {
				// localStorage 被禁用时静默跳过
			}
		}

		/**
		 * 依次扫候选目录，收集其中的分镜文件。
		 *
		 * **先读「当前板子」指针** `current.json` —— 它是流水线写的，
		 * 明确指向正在制作的那一块板子。
		 *
		 * 为什么非要指针不可：`workspaceFiles.list` 的条目**只有 `{name, type, size}`，
		 * 没有修改时间**，而且返回顺序是"稳定的名称顺序"。所以既排不了时间，
		 * 也没法用"谁产物多就是谁"（板子刚被清空时，反而是更旧的那个产物多）。
		 *
		 * 读不到指针才退回目录扫描：优先 `*.storyboard.json`；某个目录一个都没有就试下一个。
		 * 返回「目录/文件名」形式的相对路径，直接可以喂给 readAll。
		 *
		 * @param sessionId - 会话身份。
		 * @param signal - 取消信号。
		 * @returns 找到的路径数组（可能为空）。
		 */
		async function discoverBoards(sessionId, signal) {
			// ---------- 一、先问流水线：现在在做的就是哪一块 ----------
			try {
				const pinpoint = await host.readAll(sessionId, POINTER_PATH, signal);
				if (pinpoint && pinpoint.ok === true && pinpoint.value) {
					const text = new TextDecoder().decode(fromBase64(pinpoint.value.data));
					const named = text ? (JSON.parse(text).board || "") : "";
					if (named) return [named];
				}
			} catch (error) { /* 没有指针就走扫描 */ }

			// ---------- 二、退回目录扫描 ----------
			const loose = [];
			for (let i = 0; i < BOARD_DIRS.length; i++) {
				const dir = BOARD_DIRS[i];
				let result;
				try {
					result = await host.list(sessionId, dir, signal);
				} catch (error) {
					continue;
				}
				if (!result || result.ok !== true) continue;
				const entries = (result.value && result.value.entries) || [];
				const names = entries
					.filter(function (entry) { return entry.type === "file" && /\.json$/i.test(entry.name); })
					.map(function (entry) { return entry.name; });
				const strict = names.filter(function (name) { return /\.storyboard\.json$/i.test(name); });
				const bucket = strict.length ? strict : (dir === BOARD_DIRS[0] ? names : []);
				for (let j = 0; j < bucket.length; j++) {
					const path = dir === "." ? bucket[j] : dir + "/" + bucket[j];
					if (loose.indexOf(path) < 0) loose.push(path);
				}
				if (loose.length) break;
			}
			return loose;
		}

		/** 一行单元格。 */
		function td(key, content, extra) {
			return React.createElement("td", { key: key, style: Object.assign({}, S.td, extra || {}) }, content);
		}

		/** 一行文字。 */
		function line(label, value) {
			return React.createElement("p", { key: label, style: S.kv },
				React.createElement("span", { style: S.key }, label),
				React.createElement("span", null, value));
		}

		/** 台词列的内容。 */
		function dialogueOf(board, shot) {
			const list = shot.dialogue || [];
			if (!list.length) return "—";
			return list.map(function (entry) {
				const who = (board.characters || []).find(function (c) { return c.id === entry.character; });
				return (who ? who.name : entry.character) + "：「" + entry.text + "」";
			}).join("　");
		}

		/**
		 * 面板主体。
		 * @param props - 槽位标准输入（session 作用域，带 sessionId）。
		 * @returns 面板元素。
		 */
		function BoardPanel(props) {
			const sessionId = props.sessionId;
			const [boardPath, setBoardPath] = React.useState(readStoredPath);
			const [boards, setBoards] = React.useState(null);
			const [scanToken, setScanToken] = React.useState(0);
			const [load, setLoad] = React.useState({ kind: "loading" });
			const [picked, setPicked] = React.useState(0);
			const [asset, setAsset] = React.useState({ kind: "none" });

			// 扫描候选目录，列出可选的分镜文件
			React.useEffect(function () {
				if (!sessionId || !host.list) { setBoards([]); return undefined; }
				let alive = true;
				const controller = new AbortController();
				(async function () {
					const found = await discoverBoards(sessionId, controller.signal);
					if (alive) setBoards(found);
				})();
				return function () { alive = false; controller.abort(); };
			}, [sessionId, scanToken]);

			// 读选中的分镜契约文件
			React.useEffect(function () {
				if (!sessionId || !host.readAll) {
					setLoad({ kind: "error", message: "没拿到 session 或 workspaceFiles 服务" });
					return undefined;
				}
				let alive = true;
				const controller = new AbortController();
				setLoad({ kind: "loading" });
				(async function () {
					try {
						const result = await host.readAll(sessionId, boardPath, controller.signal);
						if (!result || result.ok !== true) {
							const failure = result && result.error;
							throw new Error(failure ? failure.code + " · " + failure.message : "读取失败");
						}
						const text = new TextDecoder().decode(fromBase64(result.value.data));
						const board = JSON.parse(text);
						if (alive) setLoad({ kind: "ready", board: board });
					} catch (error) {
						if (alive) setLoad({ kind: "error", message: String((error && error.message) || error) });
					}
				})();
				return function () { alive = false; controller.abort(); };
			}, [sessionId, boardPath]);

			const board = load.kind === "ready" ? load.board : null;
			const shots = board ? (board.shots || []) : [];
			const shot = shots[picked];
			const assetPath = shot ? (shot.clip || shot.first_frame || null) : null;

			// 选中镜头变了就换素材
			React.useEffect(function () {
				if (!assetPath || !sessionId || !host.readAll) {
					setAsset({ kind: "none" });
					return undefined;
				}
				let alive = true;
				let url = null;
				const controller = new AbortController();
				setAsset({ kind: "loading" });
				(async function () {
					try {
						url = await readBlobUrl(sessionId, assetPath, controller.signal);
						if (alive) setAsset({ kind: "ready", url: url, video: isVideoPath(assetPath) });
					} catch (error) {
						if (alive) setAsset({ kind: "error", message: String((error && error.message) || error) });
					}
				})();
				return function () {
					alive = false;
					controller.abort();
					if (url) URL.revokeObjectURL(url);
				};
			}, [sessionId, assetPath]);

			// 资产清单：肖像 / 身份图 / 场景 / 道具。
			//
			// **这里曾经读的是 `c.ref_image` / `s.ref_image` —— 那是旧 schema 的字段。**
			// 现在的契约用的是 `character.portrait`、`identity.sheet`、`scene.master`，
			// 所以「③资产」那一栏永远是空的（用户问过：「资产不是都生成了吗？我怎么看不见」）。
			// 身份图是**按造型**的（一个角色多套衣服），所以要连角色名一起显示。
			const assetList = [];
			const charName = {};
			for (const c of (board && board.characters) || []) charName[c.id] = c.name || c.id;
			for (const c of (board && board.characters) || []) {
				if (c.portrait) {
					assetList.push({ key: "portrait:" + c.id, group: "肖像", label: charName[c.id], path: c.portrait });
				}
			}
			for (const x of (board && board.identities) || []) {
				if (x.sheet) {
					const who = charName[x.character] || x.character;
					const look = x.name && x.name !== "默认造型" ? "·" + x.name : "";
					assetList.push({ key: "sheet:" + x.id, group: "身份图", label: who + look, path: x.sheet });
				}
			}
			for (const s of (board && board.scenes) || []) {
				if (s.master) assetList.push({ key: "scene:" + s.id, group: "场景", label: s.name || s.id, path: s.master });
				if (s.reverse_master) assetList.push({ key: "rev:" + s.id, group: "反向", label: (s.name || s.id) + "·反向", path: s.reverse_master });
				if (s.spatial_layout) assetList.push({ key: "lay:" + s.id, group: "平面", label: (s.name || s.id) + "·平面", path: s.spatial_layout });
			}
			for (const p of (board && board.props) || []) {
				if (p.ref_image) assetList.push({ key: "prop:" + p.id, group: "道具", label: p.name || p.id, path: p.ref_image });
			}
			// 关键帧也列出来 —— ④关键帧那道闸门同样需要审阅面。
			for (const s of (board && board.shots) || []) {
				if (s.first_frame) assetList.push({ key: "kf:" + s.id, group: "关键帧", label: s.id, path: s.first_frame });
			}
			const assetSignature = assetList.map(function (a) { return a.key + "=" + a.path; }).join("|");
			const [assetUrls, setAssetUrls] = React.useState({});
			const [focus, setFocus] = React.useState(null);

			// 资产图一次读完；换板子时全部回收
			React.useEffect(function () {
				setFocus(null);
				if (!sessionId || !host.readAll || !assetList.length) {
					setAssetUrls({});
					return undefined;
				}
				let alive = true;
				const controller = new AbortController();
				const made = [];
				(async function () {
					const next = {};
					for (let i = 0; i < assetList.length; i++) {
						if (controller.signal.aborted) return;
						try {
							const url = await readBlobUrl(sessionId, assetList[i].path, controller.signal);
							made.push(url);
							next[assetList[i].key] = url;
						} catch (error) {
							next[assetList[i].key] = null;
						}
					}
					if (alive) setAssetUrls(next);
					else for (const url of made) URL.revokeObjectURL(url);
				})();
				return function () {
					alive = false;
					controller.abort();
					for (const url of made) URL.revokeObjectURL(url);
				};
			}, [sessionId, assetSignature]);

			// 文件选择器：每个分支都要有，否则文件读不到时用户就没法换
			const options = (boards || []).slice();
			if (options.indexOf(boardPath) < 0) options.unshift(boardPath);
			const picker = React.createElement("div", { style: S.picker },
				React.createElement("select", {
					value: boardPath,
					style: S.select,
					title: "选择要显示的分镜文件",
					onChange: function (event) {
						const next = event.target.value;
						setBoardPath(next);
						storePath(next);
					}
				}, options.map(function (path) {
					return React.createElement("option", { key: path, value: path }, path);
				})),
				React.createElement("button", {
					type: "button",
					style: S.btn,
					title: "重新扫描工作区里的分镜文件",
					onClick: function () { setScanToken(scanToken + 1); }
				}, boards === null ? "扫描中…" : "扫描"));

			if (load.kind === "loading") {
				return React.createElement("div", { style: S.panel },
					React.createElement("div", { style: S.head },
						React.createElement("p", { style: S.note }, "正在读 " + boardPath + " …"),
						picker));
			}

			if (load.kind === "error") {
				return React.createElement("div", { style: S.panel },
					React.createElement("div", { style: S.head },
						React.createElement("p", { style: S.bad }, "读不到分镜文件"),
						React.createElement("p", { style: S.note }, load.message),
						React.createElement("p", { style: S.note }, "找过的目录（相对工作区根）：" + BOARD_DIRS.join("、")),
						picker));
			}

			const meta = board.meta || {};
			const approvals = meta.approvals || {};
			const total = shots.reduce(function (sum, s) { return sum + (Number(s.duration_s) || 0); }, 0);

			const head = React.createElement("div", { style: S.head },
				React.createElement("div", { style: S.title }, (meta.title || "未命名") + " · 分镜确认表"),
				React.createElement("div", { style: S.dim }, meta.logline || ""),
				React.createElement("div", { style: S.gates }, GATES.map(function (entry) {
					const key = entry[0];
					const approved = Boolean(approvals[key]);
					const current = meta.stage === key;
					return React.createElement("span", {
						key: key,
						style: approved ? S.gateOn : (current ? S.gateNow : S.gateOff)
					}, entry[1] + (approved ? " ✅" : current ? " ⏳" : ""));
				})),
				React.createElement("div", { style: Object.assign({ marginTop: "6px" }, S.dim) },
					// `.toFixed(2)` —— 不格式化会显示成 `89.14999999999999s`（浮点累加）
			shots.length + " 个镜头 · 共 " + total.toFixed(2) + "s · " + (meta.aspect || "") + " · " + (meta.style || "")),
				picker);

			const header = React.createElement("tr", null, ["镜号", "时长", "画面描述", "景别", "光影氛围", "对白/旁白", "音效", "运镜", "最终剪辑提示", "状态"].map(function (label) {
				return React.createElement("th", { key: label, style: S.th }, label);
			}));

			const rows = shots.map(function (item, index) {
				const has = item.clip ? "已出片" : item.first_frame ? "有首帧" : "待生成";
				return React.createElement("tr", {
					key: item.id,
					style: index === picked ? Object.assign({}, S.row, S.rowOn) : S.row,
					onClick: function () { setPicked(index); }
				},
					td("id", item.id),
					td("dur", item.duration_s + "s"),
					td("act", item.action),
					td("size", item.shot_size),
					td("light", item.lighting || "—"),
					td("dlg", dialogueOf(board, item)),
					td("audio", item.audio || "—"),
					td("cam", item.camera),
					td("edit", item.edit_note || "—"),
					td("st", has, { whiteSpace: "nowrap", opacity: item.clip || item.first_frame ? 1 : 0.5 }));
			});

			const table = React.createElement("div", { style: S.scroll },
				React.createElement("table", { style: S.table },
					React.createElement("thead", null, header),
					React.createElement("tbody", null, rows)));

			// 资产带：角色 / 场景 / 道具，缩略图 + 点开看大图
			const assetStrip = assetList.length
				? React.createElement("div", { style: S.assets },
					React.createElement("div", { style: S.assetsHead },
						"资产 " + assetList.length + " 个　（点一下看大图）"),
					React.createElement("div", { style: S.assetsRow }, assetList.map(function (item) {
						const url = assetUrls[item.key];
						return React.createElement("button", {
							key: item.key,
							type: "button",
							title: item.path,
							style: focus === item.key ? Object.assign({}, S.assetCard, S.assetCardOn) : S.assetCard,
							onClick: function () { setFocus(focus === item.key ? null : item.key); }
						},
							url
								? React.createElement("img", { src: url, alt: item.label, style: S.assetThumb })
								: React.createElement("div", { style: S.assetThumbEmpty }, "…"),
							React.createElement("span", { style: S.assetLabel }, item.group + "　" + item.label));
					})))
				: null;

			const focused = focus ? assetList.filter(function (a) { return a.key === focus; })[0] : null;
			const detail = focused
				? React.createElement("div", { style: S.detail },
					React.createElement("p", { style: { margin: "0 0 6px", fontWeight: 600 } },
						focused.group + "：" + focused.label),
					React.createElement("div", { style: S.stage },
						assetUrls[focused.key]
							? React.createElement("img", { src: assetUrls[focused.key], alt: focused.label, style: S.assetBig })
							: React.createElement("p", { style: S.note }, "正在读资产图…")),
					React.createElement("p", { style: S.note }, focused.path))
				: React.createElement("div", { style: S.detail },
					shot
						? [
							React.createElement("p", { key: "h", style: { margin: "0 0 6px", fontWeight: 600 } },
								shot.id + "　" + shot.shot_size + " / " + shot.camera + " / " + shot.duration_s + "s"),
							line("画面", shot.prompt),
							line("音效", shot.audio || "—"),
							line("剪辑", shot.edit_note || "—"),
							asset.kind === "ready"
								? React.createElement("div", { key: "a", style: S.stage },
									asset.video
										? React.createElement("video", { src: asset.url, controls: true, playsInline: true, style: S.media })
										: React.createElement("img", { src: asset.url, alt: shot.id + " 首帧", style: S.media }))
								: asset.kind === "loading"
									? React.createElement("p", { key: "a", style: S.note }, "正在读素材…")
									: asset.kind === "error"
										? React.createElement("p", { key: "a", style: S.bad }, "素材读取失败：" + asset.message)
										: React.createElement("p", { key: "a", style: S.note }, "这一镜还没有素材（首帧和成片都是空的）")
						]
						: React.createElement("p", { style: S.note }, "选一行看细节"));

			return React.createElement("div", { style: S.panel }, head, assetStrip, table, detail);
		}

		/** 会话头部那颗按钮。 */
		function StoryboardAction() {
			return React.createElement("button", {
				type: "button",
				title: "右侧栏 → 加号 → 分镜，打开分镜确认表",
				style: {
					padding: "2px 8px", fontSize: "12px", borderRadius: "999px",
					border: "1px solid rgba(127,127,127,.35)", background: "transparent",
					color: "inherit", cursor: "default"
				}
			}, "分镜 ✓");
		}

		/** tab 类型的注册定义。页面类型按 kind 打开，所以不需要 patterns。 */
		function definition() {
			return {
				id: ID,
				kind: KIND,
				priority: "extension",
				title: () => "分镜",
				guide: [{
					order: 20,
					title: () => "分镜",
					description: () => "故事 → 分镜表 → 关键帧"
				}]
			};
		}

		/** 需要的浏览器服务：槽位注册表、右侧栏 tab 注册表、Remote 载体及其命名空间。 */
		const inject = ["slots", "sidebarRightTabs", "remote", "remote.workspaceFiles"];

		/**
		 * 客户端插件入口。
		 * @param ctx - 客户端根上下文。
		 */
		function apply(ctx) {
			host.readAll = function (sessionId, filePath, signal) {
				return ctx.remote.workspaceFiles.readAll(sessionId, filePath, signal);
			};
			host.list = function (sessionId, filePath, signal) {
				return ctx.remote.workspaceFiles.list(sessionId, filePath, signal);
			};

			const attempt = (label, fn) => {
				try {
					ctx.effect(fn, label);
				} catch (error) {
					console.error("[dsh-storyboard] " + label + " 注册失败", error);
				}
			};

			attempt("dsh-storyboard: tab type", () => ctx.sidebarRightTabs.register(definition()));

			attempt("dsh-storyboard: tab body", () => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
				name: "sidebar.right.pane.tab",
				key: ID
			}, BoardPanel)));

			attempt("dsh-storyboard: header action", () => ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
				name: "conversation.session.header.actions",
				id: "storyboard",
				order: 100
			}, StoryboardAction)));

			console.log("[dsh-storyboard] client half loaded");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
