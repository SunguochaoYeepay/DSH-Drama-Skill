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
		/**
		 * 剧目工作区根（绝对路径）。
		 *
		 * **为什么需要它**：真实项目按 `README.md` 的规定落在仓库外，
		 * 而 `workspaceFiles.list` **只在会话工作区根内**可用 —— 所以"发现剧目"不能用它，
		 * 要用 `directoryPicker.list`（收绝对路径）。`workspaceFiles.readAll` 收绝对路径，
		 * 所以选中剧目后直接读它的文件即可，不必把项目复制进工作区。
		 */
		const PROJECTS_ROOT_DEFAULT = "E:\\AI-Tool\\DeepSeek\\story2video\\projects";
		/** 剧目根的覆盖键（换机器时改它）。 */
		const ROOT_KEY = "dsh-storyboard.projectsRoot";
		/** 当前选中的剧目名。 */
		const PROJECT_KEY = "dsh-storyboard.project";
		/** 剧目里要读出来的文本产物（相对剧目根）。 */
		const PROJECT_FILES = ["story.md", "board.direction.json", "render.plan.json", "review.approvals.json"];
		/** 现行人工票据的显示名。每段视频只保留当前产物的一张票。 */
		const TICKETS = [
			["direction", "导演方案"],
			["assets", "资源"],
			["keyframes", "关键帧"],
			["final", "最终成片"]
		];

		/** apply 时装进来的宿主能力。组件拿不到 ctx，服务留在闭包里。 */
		const host = { readAll: null, list: null, listDir: null };

		/**
		 * 最近一次渲染的现场快照。
		 *
		 * 面板崩溃时 React 会卸载子树，**组件内部的状态就再也读不到了** ——
		 * 所以每次渲染把关键值写进这个函数级变量，让错误边界能把现场一起显示出来。
		 * 没有它，就只有一个 `Cannot read properties of null` 的孤零零消息，无法定位。
		 */
		let renderSnapshot = "";
		function trace() { return renderSnapshot; }

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
			assetsRow: { display: "flex", gap: "8px", overflowX: "auto", paddingBottom: "4px" },
			assetCard: {
				// 原来的 104px + 58px 缩略图，标签「关键帧　g001」换行后被裁，看着像压在图上。
				// 放大卡片与缩略图，并给标签固定两行高度、超出用省略号。
				flex: "0 0 auto", width: "132px", padding: "4px", borderRadius: "6px",
				border: "1px solid rgba(127,127,127,.28)", background: "transparent",
				color: "inherit", cursor: "pointer", textAlign: "left", overflow: "hidden"
			},
			assetCardOn: { border: "1px solid rgba(90,140,255,.75)", background: "rgba(90,140,255,.12)" },
			assetThumb: { width: "100%", height: "84px", objectFit: "cover", borderRadius: "3px", display: "block", background: "#000" },
			assetThumbEmpty: {
				width: "100%", height: "84px", borderRadius: "3px", display: "flex",
				alignItems: "center", justifyContent: "center", background: "rgba(127,127,127,.15)", opacity: 0.5
			},
			assetLabel: { display: "block", fontSize: "10.5px", opacity: 0.75, marginTop: "4px", lineHeight: 1.35, overflowWrap: "anywhere" },
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

		/**
		 * 把板子里的资产路径解析成可读路径。
		 *
		 * **为什么必须做这一步**：板子里的 `portrait` / `sheet` / `master` / `ref_image` /
		 * `first_frame` 都是**相对路径**（`assets/xxx.png`），而 `workspaceFiles` 会把相对路径
		 * 按**会话工作区根**解析 —— 剧目在仓库外时（本项目就是这样）永远找不到，
		 * 表现是资源带全是裂图、没有报错。所以相对路径要拼到**剧目目录**上。
		 *
		 * 已经是绝对路径（`C:\…` / `\\server\…` / `/…`）的原样返回。
		 *
		 * @param filePath - 板子里写的路径。
		 * @param base - 剧目目录（绝对，以分隔符结尾）；空则原样返回。
		 * @returns 可读路径。
		 */
		function resolveAssetPath(filePath, base) {
			const p = String(filePath || "");
			if (!p) return p;
			if (/^[A-Za-z]:[\\/]|^\\\\|^\//.test(p)) return p;
			if (!base) return p;
			return base.replace(/[\\/]+$/, "") + "\\" + p.replace(/^[\\/]+/, "");
		}

		/** 读上一次选过的分镜文件；localStorage 不可用就退回默认。 */
		function readStoredPath() {
			try {
				return window.localStorage.getItem(STORAGE_KEY) || BOARD_PATH;
			} catch (error) {				return BOARD_PATH;
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

		/** 读写任意 `localStorage` 键；失败无所谓。 */
		function readKey(key, fallback) {
			try {
				const v = window.localStorage.getItem(key);
				return v === null || v === "" ? fallback : v;
			} catch (error) {
				return fallback;
			}
		}
		function storeKey(key, value) {
			try {
				if (value) window.localStorage.setItem(key, value);
				else window.localStorage.removeItem(key);
			} catch (error) {
				// 静默跳过
			}
		}

		/**
		 * 读一个剧目的**中文剧名**（`board.json` 的 `meta.title`），同时充当"这个目录是不是剧目"的判据。
		 *
		 * 契约把 `meta.title` 定位成"给人看的剧名"、`meta.project` 定位成"英文目录名"
		 * （见 `CHANGELOG.md` 的「中文剧名契约」）。所以下拉要显示剧名，而不是只显示目录名。
		 *
		 * @param sessionId - 会话身份。
		 * @param dirPath - 剧目目录（绝对路径）。
		 * @param fallback - **有板子但没有剧名**时用的名字（老板子可能没写中文剧名）。
		 * @param signal - 取消信号。
		 * @returns 显示用标签；**`null` 表示这个目录里没有可读的 `board.json`**（空壳，应隐藏）。
		 */
		async function readProjectTitle(sessionId, dirPath, fallback, signal) {
			try {
				const r = await host.readAll(sessionId, dirPath.replace(/[\\/]+$/, "") + "\\board.json", signal);
				if (!r || r.ok !== true) return null;   // 没板子 → 不是剧目
				const board = JSON.parse(new TextDecoder().decode(fromBase64(r.value.data)));
				const title = String((board.meta && board.meta.title) || "").trim();
				return title || fallback;
			} catch (error) {
				// 读到了但 JSON 坏了，同样算"不可用"，不要留在下拉里
				return null;
			}
		}

		/**
		 * 列出剧目工作区根下的剧目目录，并**给每个剧目配上中文剧名**。
		 *
		 * **必须走 `directoryPicker.list`，不能走 `workspaceFiles.list`** ——
		 * 后者的 `list` 只在会话工作区根内可用，而真实项目按 `README.md` 规定落在仓库外。
		 * 该动词只在 `browse` 后端组合下存在（`native` 后端只有系统选目录框），
		 * 缺失时**优雅降级**：返回失败原因，由调用方提示用户手动填根路径，而不是让插件整体崩掉。
		 *
		 * @param sessionId - 会话身份。
		 * @param root - 剧目工作区根（绝对路径）。
		 * @param signal - 取消信号。
		 * @returns `{ok:true, projects:[{name,title}]}` 或 `{ok:false, why}`。
		 */
		async function listProjects(sessionId, root, signal) {
			if (!host.listDir) return { ok: false, why: "宿主未提供目录列举能力" };
			try {
				const result = await host.listDir(root, signal);
				if (!result || result.ok !== true) {
					const failure = result && result.error;
					return { ok: false, why: failure ? failure.code + " · " + failure.message : "列举失败" };
				}
				// `DirectoryListing.entries` 是**直接子目录**，`DirectoryEntry` 只有
				// `{name, path, hidden}` —— **没有 `type` 字段**（曾经按 `e.type === "directory"`
				// 过滤，那永远为假，下拉里一个剧目都出不来）。
				// 返回顺序已按名称排序，这里再排一次无所谓；隐藏目录按约定排除。
				const entries = (result.value && result.value.entries) || [];
				const names = entries.filter(function (e) { return e && e.name && !e.hidden; })
					.map(function (e) { return e.name; }).sort();
				const base = root.replace(/[\\/]+$/, "");
				// 串行读剧名：多部剧也就几次小读取，不值得引入并发与它带来的取消复杂度。
				//
				// **读不到 `board.json` 的目录不进下拉** —— 它们是空壳（例如只剩 assets/out
				// 几个空目录的历史残留），选进去只会得到一句"读不到分镜文件"。
				// 判据就是"能不能读出板子的 `meta.title`"：能读=有板子，不能读=空壳。
				const projects = [];
				let skipped = 0;
				for (let i = 0; i < names.length; i++) {
					if (signal && signal.aborted) break;
					const title = await readProjectTitle(sessionId, base + "\\" + names[i], names[i], signal);
					if (title === null) { skipped++; continue; }
					projects.push({ name: names[i], title: title });
				}
				return { ok: true, projects: projects, skipped: skipped };
			} catch (error) {
				return { ok: false, why: String((error && error.message) || error) };
			}
		}

		/**
		 * 读剧目里的文本产物。路径用绝对形式 —— `workspaceFiles.readAll` 收绝对路径。
		 * @returns 每项 `{name, kind:'text'|'missing', text?}`。
		 */
		async function readProjectFiles(sessionId, base, signal) {
			const out = [];
			for (let i = 0; i < PROJECT_FILES.length; i++) {
				const name = PROJECT_FILES[i];
				try {
					const r = await host.readAll(sessionId, base + name, signal);
					if (!r || r.ok !== true) { out.push({ name: name, kind: "missing" }); continue; }
					out.push({ name: name, kind: "text", text: new TextDecoder().decode(fromBase64(r.value.data)) });
				} catch (error) {
					out.push({ name: name, kind: "missing" });
				}
			}
			return out;
		}

		/**
		 * 读一个剧目的**产物索引**：关键帧、视频片段、成片。
		 *
		 * ## 为什么必须靠索引、不能扫目录
		 *
		 * 插件**没有"列文件"的能力**：
		 * - `workspaceFiles.list` 只在**工作区根内**可用（工作区外报 `workspace-file/outside-workspace`）；
		 * - `directoryPicker.list` 的契约是「**direct child directories**」——**只返回子目录，不返回文件**。
		 *
		 * 但**读文件不受限**（`readAll` 收绝对路径）。所以走"已知路径 + 索引"：
		 *
		 * | 产物 | 索引 |
		 * |---|---|
		 * | 关键帧 | `render.plan.json` 的 `units[].keyframe`（`keyframes_render/g00N.png`） |
		 * | 视频 | `units/g00N.result.json` 的 `files[].local_path` |
		 * | 成片 | 约定路径 `out/final.mp4` |
		 *
		 * **为什么板子里的 `first_frame` / `clip` 不能信**：完整走完流程的项目里它们是 `null`
		 * —— 现行流程把产物登记在**生成计划**和 **`*.result.json`** 里，不回填板子。
		 *
		 * @returns `{keyframes:{unitId:path}, clips:{unitId:path}, final:path|null}`
		 */
		async function readArtifactIndex(sessionId, base, signal) {
			const root = base.replace(/[\\/]+$/, "");
			const index = { keyframes: {}, clips: {}, final: null, unitShots: [] };
			const readText = async (rel) => {
				try {
					const r = await host.readAll(sessionId, root + "\\" + rel, signal);
					if (!r || r.ok !== true) return null;
					return new TextDecoder().decode(fromBase64(r.value.data));
				} catch (error) {
					return null;
				}
			};
			const readJson = async (rel) => {
				const text = await readText(rel);
				if (text === null) return null;
				try { return JSON.parse(text); } catch (error) { return null; }
			};

			// 关键帧：生成计划是权威（导演协议 v6 计划里 units[].keyframe）
			const plan = await readJson("render.plan.json");
			for (const u of (plan && plan.units) || []) {
				if (u && u.id && u.keyframe) index.keyframes[u.id] = u.keyframe;
				// 单元内部镜数 + 时长：用来把板子镜头映射到单元，并按单元画表
				if (u && u.id) {
					index.unitShots.push({
						id: u.id,
						count: ((u.shots) || []).length,
						content_duration_s: u.content_duration_s,
						generation_duration_s: u.generation_duration_s
					});
				}
			}
			// 视频：逐单元读 result.json
			const ids = Object.keys(index.keyframes);
			for (let i = 0; i < ids.length; i++) {
				if (signal && signal.aborted) return index;
				const result = await readJson("units/" + ids[i] + ".result.json");
				const files = (result && result.files) || [];
				for (let j = 0; j < files.length; j++) {
					const f = files[j];
					const p = typeof f === "string" ? f : (f && (f.local_path || f.localPath || f.path));
					// result.json 里同时有 ComfyUI 原始路径与项目内路径，优先项目内的那份
					if (p && /\.(mp4|mov|webm|m4v)$/i.test(p) && (!index.clips[ids[i]] || p.indexOf(root) === 0)) {
						index.clips[ids[i]] = p;
					}
				}
			}
			// 成片：约定路径（没有就按 null 处理，界面显示"未合成"）
			index.final = root + "\\out\\final.mp4";
			return index;
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
			const [boardState, setBoardState] = React.useState({ kind: "loading" });
			const [picked, setPicked] = React.useState(0);
			const [asset, setAsset] = React.useState({ kind: "none" });
			// 剧目工作区（真实项目在仓库外，靠 directoryPicker 发现）
			const [projectsRoot, setProjectsRoot] = React.useState(function () {
				return readKey(ROOT_KEY, PROJECTS_ROOT_DEFAULT);
			});
			const [projects, setProjects] = React.useState(null);
			const [project, setProject] = React.useState(function () { return readKey(PROJECT_KEY, ""); });
			const [projectNote, setProjectNote] = React.useState("");
			// 剧目文本产物：story.md / 导演稿 / 计划 / 票据
			const [projectFiles, setProjectFiles] = React.useState(null);
			/** 产物索引：关键帧 / 视频片段 / 成片（板子里的 first_frame、clip 在完整项目里是 null）。 */
			const [artifacts, setArtifacts] = React.useState(null);
			/** 内容分页：①剧本 ②资源 ③关键帧与视频。顶部选题器与票据行**常驻**，不随分页切换。 */
			const [tab, setTab] = React.useState(0);
			/**
			 * 「② 导演与计划」里当前选中的**单元名**（三层结构的第一层：单元名 tabs）。
			 * `null` 表示还没选 —— 渲染时落到第一个单元。
			 */
			const [openUnit, setOpenUnit] = React.useState(null);

			// 发现剧目：列出剧目工作区根下的目录
			React.useEffect(function () {
				let alive = true;
				const controller = new AbortController();
				setProjects(null);
				(async function () {
					const found = await listProjects(sessionId, projectsRoot, controller.signal);
					if (!alive) return;
					setProjects(found.ok ? found.projects : []);
					setProjectNote(found.ok
						? (found.skipped ? "已隐藏 " + found.skipped + " 个没有 board.json 的目录" : "")
						: "列不到剧目目录：" + found.why);
				})();
				return function () { alive = false; controller.abort(); };
			}, [projectsRoot, scanToken]);

			/**
			 * 产物目录：**按实际选中的板子路径推导**。
			 *
			 * - 相对路径（工作区内的板子）→ 保持相对，让 `workspaceFiles` 按工作区根解析。
			 * - 绝对路径（剧目下拉给的仓库外板子）→ 取同目录的绝对前缀。
			 */
			const fileBase = (function () {
				const at = Math.max(boardPath.lastIndexOf("\\"), boardPath.lastIndexOf("/"));
				return at > 0 ? boardPath.slice(0, at + 1) : "";
			})();

			// 读剧目文本产物（含 story.md 全文）
			React.useEffect(function () {
				if (!sessionId || !host.readAll || !fileBase) { setProjectFiles(null); return undefined; }
				let alive = true;
				const controller = new AbortController();
				(async function () {
					const found = await readProjectFiles(sessionId, fileBase, controller.signal);
					if (alive) setProjectFiles(found);
				})();
				return function () { alive = false; controller.abort(); };
			}, [sessionId, fileBase]);

			// 读产物索引（关键帧 / 视频片段 / 成片）—— 板子里这些字段在完整项目里是 null
			React.useEffect(function () {
				if (!sessionId || !host.readAll || !fileBase) { setArtifacts(null); return undefined; }
				let alive = true;
				const controller = new AbortController();
				(async function () {
					const found = await readArtifactIndex(sessionId, fileBase, controller.signal);
					if (alive) setArtifacts(found);
				})();
				return function () { alive = false; controller.abort(); };
			}, [sessionId, fileBase]);

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
					setBoardState({ kind: "error", message: "没拿到 session 或 workspaceFiles 服务" });
					return undefined;
				}
				let alive = true;
				const controller = new AbortController();
				setBoardState({ kind: "loading" });
				(async function () {
					try {
						const result = await host.readAll(sessionId, boardPath, controller.signal);
						if (!result || result.ok !== true) {
							const failure = result && result.error;
							throw new Error(failure ? failure.code + " · " + failure.message : "读取失败");
						}
						const text = new TextDecoder().decode(fromBase64(result.value.data));
						const board = JSON.parse(text);
						// **必须校验顶层是对象**：`JSON.parse("null")` 是合法的，会得到 `null`；
						// 顶层是数组或字符串时同样不该当板子用。那种板子放进去，
						// 后面每一处 `board.meta` 都会抛 `Cannot read properties of null (reading 'meta')`
						// → React 卸载整棵子树 → **面板全黑**（实测踩过）。
						if (board === null || typeof board !== "object" || Array.isArray(board)) {
							const what = board === null ? "null" : Array.isArray(board) ? "数组" : typeof board;
							throw new Error("board.json 顶层不是对象（实际是 " + what + "）—— 文件可能损坏或被写空了");
						}
						if (alive) setBoardState({ kind: "ready", board: board });
					} catch (error) {
						if (alive) setBoardState({ kind: "error", message: String((error && error.message) || error) });
					}
				})();
				return function () { alive = false; controller.abort(); };
			}, [sessionId, boardPath]);

			// 现场快照：崩溃后组件状态读不到了，但这里写下的值还在（函数级变量）。
			// 放在归一化与所有早退**之前**，所以 loading/error 路径崩溃时也有现场。
			renderSnapshot = [
				"板子路径=" + boardPath,
				"剧目=" + (project || "(未选)"),
				"载入=" + (boardState && boardState.kind),
				"板子类型=" + (boardState && boardState.kind === "ready"
					? (boardState.board === null ? "null" : Array.isArray(boardState.board) ? "数组" : typeof boardState.board)
					: "—")
			].join("　");

			/**
			 * 载入状态的**归一化**：`kind:"ready"` 但板子不是对象时，**在渲染之前**降级为 `error`。
			 *
			 * 这是**根治**：面板里凡读 `board.xxx` 的地方，都隐含"ready ⇒ board 是对象"这个前提。
			 * 只要有一处打破它（曾被写空的 board.json、`JSON.parse("null")` 得到 `null`、
			 * 上游返回畸形数据），后面就会抛 `Cannot read properties of null (reading 'meta')`，
			 * 而 React 一抛异常就卸载整棵子树 → **整屏黑**。这里把不合法状态**挡在渲染之前**，
			 * 让它变成一个能读的错误提示，而不是崩溃。
			 *
			 * 归一化结果取名 `view`：**不要**用 `load` 这个变量名去遮蔽上面的 `boardState`，
			 * 否则下面的 `load.kind` 会命中 TDZ。状态叫 `boardState`，归一化结果叫 `view`。
			 */
			const view = (function () {
				const raw = boardState;
				if (raw && raw.kind === "ready") {
					const b = raw.board;
					if (b === null || typeof b !== "object" || Array.isArray(b)) {
						const what = b === null ? "null" : Array.isArray(b) ? "数组" : typeof b;
						return {
							kind: "error",
							message: "板子载入后不是对象（实际是 " + what + "）：" + boardPath
								+ "　—— 文件可能损坏或被写空；请检查该文件，或在剧目下拉里换一个剧目"
						};
					}
				}
				return raw;
			})();

			const board = view.kind === "ready" ? view.board : null;
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
			//
			// 每项带 `tab` 归属：`0`=①剧本用的、`1`=②资源、`2`=③关键帧与视频。
			// **资源阶段（肖像/身份图/场景/道具）归 ②，关键帧与视频归 ③** ——
			// 关键帧是"生成"阶段的产物，不该混在资源里（用户指出过这一点）。
			const assetList = [];
			const charName = {};
			for (const c of (board && board.characters) || []) charName[c.id] = c.name || c.id;
			for (const c of (board && board.characters) || []) {
				if (c.portrait) {
					assetList.push({ key: "portrait:" + c.id, tab: 1, group: "肖像", label: charName[c.id], path: c.portrait });
				}
			}
			for (const x of (board && board.identities) || []) {
				if (x.sheet) {
					const who = charName[x.character] || x.character;
					const look = x.name && x.name !== "默认造型" ? "·" + x.name : "";
					assetList.push({ key: "sheet:" + x.id, tab: 1, group: "身份图", label: who + look, path: x.sheet });
				}
			}
			for (const s of (board && board.scenes) || []) {
				if (s.master) assetList.push({ key: "scene:" + s.id, tab: 1, group: "场景", label: s.name || s.id, path: s.master });
				if (s.reverse_master) assetList.push({ key: "rev:" + s.id, tab: 1, group: "反向", label: (s.name || s.id) + "·反向", path: s.reverse_master });
				if (s.spatial_layout) assetList.push({ key: "lay:" + s.id, tab: 1, group: "平面", label: (s.name || s.id) + "·平面", path: s.spatial_layout });
			}
			for (const p of (board && board.props) || []) {
				if (p.ref_image) assetList.push({ key: "prop:" + p.id, tab: 1, group: "道具", label: p.name || p.id, path: p.ref_image });
			}
			// 关键帧也列出来 —— ④关键帧那道闸门同样需要审阅面。
			//
			// **两个来源**：板子的 `shots[].first_frame`（旧流程会回填），
			// 以及**生成计划的 `units[].keyframe`**（现行流程的权威 —— 完整跑完的项目里
			// 板子的 first_frame 是 null，而 `keyframes_render/g00N.png` 实际存在）。
			for (const s of (board && board.shots) || []) {
				if (s.first_frame) assetList.push({ key: "kf:" + s.id, tab: 2, group: "关键帧", label: s.id, path: s.first_frame });
			}
			for (const unitId of Object.keys((artifacts && artifacts.keyframes) || {})) {
				assetList.push({ key: "kf:" + unitId, tab: 2, group: "关键帧", label: unitId, path: artifacts.keyframes[unitId] });
			}
			// 视频片段：索引来自 `units/g00N.result.json`
			for (const unitId of Object.keys((artifacts && artifacts.clips) || {})) {
				assetList.push({ key: "clip:" + unitId, tab: 2, group: "视频片段", label: unitId, path: artifacts.clips[unitId] });
			}
			// 成片：约定路径 `out/final.mp4`
			if (artifacts && artifacts.final) {
				assetList.push({ key: "final", tab: 2, group: "成片", label: "final.mp4", path: artifacts.final });
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
							const url = await readBlobUrl(sessionId, resolveAssetPath(assetList[i].path, fileBase), controller.signal);
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
			// ① 文件选择器：扫到的板子 + 当前值（**保持第一个 select**，见集成测试的契约）
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

			// ② 剧目下拉：真实项目在仓库外，靠 directoryPicker 列目录发现。
			// **只在用户真正选择时才改板子路径**，否则会抢掉文件选择器里的手选。
			const projectPicker = React.createElement("div", { style: S.picker },
				React.createElement("select", {
					value: project,
					style: S.select,
					title: "选择剧目（" + projectsRoot + "）",
					onChange: function (event) {
						const next = event.target.value;
						setProject(next);
						setPicked(0);
						storeKey(PROJECT_KEY, next);
						if (next) {
							const path = projectsRoot.replace(/[\\/]+$/, "") + "\\" + next + "\\board.json";
							setBoardPath(path);
							storePath(path);
						}
					}
				}, [{ key: "__none__", value: "", label: projects === null ? "正在列剧目…" : "（未选择剧目）" }]
					.concat((projects || []).map(function (p) {
						// 契约把 `meta.title` 定为"给人看的剧名"、`meta.project` 定为"英文目录名"。
						// 两者不同时都显示出来；相同时只显示一个，免得重复。
						return { key: p.name, value: p.name, label: p.title === p.name ? p.name : p.title + " · " + p.name };
					}))
					.map(function (o) { return React.createElement("option", { key: o.key, value: o.value }, o.label); })),
				React.createElement("button", {
					type: "button", style: S.btn, title: "重新列举剧目目录",
					onClick: function () { setScanToken(scanToken + 1); }
				}, "重列"),
				React.createElement("button", {
					type: "button", style: S.btn, title: "改剧目工作区根（绝对路径）",
					onClick: function () {
						const next = window.prompt("剧目工作区根（绝对路径）", projectsRoot);
						if (next) { setProjectsRoot(next); storeKey(ROOT_KEY, next === PROJECTS_ROOT_DEFAULT ? "" : next); }
					}
				}, "根"));

			/**
			 * **loading / error 早退必须放在这里** —— `picker` / `projectPicker` **之后**，
			 * 所有依赖 `board` 的表达式**之前**。
			 *
			 * 这是"面板全黑"的真正根因（实测）：`React.createElement("p", …, board.meta && …)`
			 * 这类表达式在**函数体顺序执行时**就求值了。所以早退如果写在函数末尾，
			 * 那时 `board` 是 `null` 的那些行**早就执行过了** → 抛
			 * `Cannot read properties of null (reading 'meta')` → React 卸载整棵子树 → 全黑。
			 *
			 * 位置约束是**两头**的：
			 * - 不能早于 `picker` / `projectPicker`（会命中它们的 TDZ）
			 * - 不能晚于任何 `board.xxx` 访问（loading 时 board 为 null）
			 */
			if (view.kind === "loading") {
				return React.createElement("div", { style: S.panel },
					React.createElement("div", { style: S.head },
						React.createElement("p", { style: S.note }, "正在读 " + boardPath + " …"),
						picker,
						projectPicker));
			}
			if (view.kind === "error") {
				return React.createElement("div", { style: S.panel },
					React.createElement("div", { style: S.head },
						React.createElement("p", { style: S.bad }, "读不到分镜文件"),
						React.createElement("p", { style: S.note }, view.message),
						React.createElement("p", { style: S.note }, project
							? "剧目：" + project + "　根：" + projectsRoot
							: "没选剧目。真实项目按 README 规定落在仓库外，workspaceFiles 只在工作区根内列举 —— 用下面的剧目下拉（走 directoryPicker），或点「根」改工作区根。"),
						projectNote ? React.createElement("p", { style: S.bad }, projectNote) : null,
						picker,
						projectPicker));
			}

			// ↓↓↓ 以下都可以安全假定 `board` 是对象（`view` 已归一化 + 上面已早退）↓↓↓
			const meta = board.meta || {};
			const total = shots.reduce(function (sum, s) { return sum + (Number(s.duration_s) || 0); }, 0);

			/**
			 * ③ 剧目文本产物 + **剧本阅读**。
			 *
			 * 剧本有两个来源，都读出来：
			 * - `story.md`（项目的剧本正本）
			 * - `board.story.source`（板子里的剧本原文 —— 台词逐字搬运的权威来源）
			 * 面板此前只画镜头表，从不显示剧本文字；这里补上。
			 */
			const storyText = (function () {
				const md = (projectFiles || []).find(function (f) { return f.name === "story.md" && f.kind === "text"; });
				if (md) return md.text;
				const src = board && board.story && board.story.source;
				return typeof src === "string" ? src : "";
			})();
			const storyPaths = [
				[(projectFiles || []).find(function (f) { return f.name === "story.md"; }), "story.md"],
				[(projectFiles || []).find(function (f) { return f.name === "board.direction.json"; }), "导演方案"],
				[(projectFiles || []).find(function (f) { return f.name === "render.plan.json"; }), "生成计划"],
				[(projectFiles || []).find(function (f) { return f.name === "review.approvals.json"; }), "人工票据"]
			];

			/**
			 * 行号 → 剧本原文。**表里显示台词文字，但行号仍然保留**。
			 *
			 * 为什么导演稿里只有行号：**导演没有资格写台词**
			 * （`references/director/schema.md` 的死线 —— 它输出里出现任何一句台词原文都算校验失败），
			 * 所以它只能填行号，原文由代码逐字搬运。这是**构造上的保真**，不是缺陷。
			 *
			 * 但"给人读"时只看行号没法用 —— 所以这里去剧本原文里把那一行取出来显示。
			 * 行号同时留着：它是**溯源**（能对回 `story.md` 的第几行），也是校验的依据。
			 */
			const scriptLines = String(storyText || "").split(/\r?\n/);
			const lineTextOf = function (lineNo) {
				const raw = scriptLines[Number(lineNo) - 1];
				if (raw === undefined) return null;
				// 剧本行形如「苏晚（吃痛，瞪眼）：你有病啊！」—— 去掉「说话人（提示）：」前缀，
				// 只留台词正文；前缀里的说话人和情绪在别处已经有了。
				const m = String(raw).match(/^[^：:]{1,12}(?:[（(][^）)]*[）)])?\s*[:：]\s*(.+)$/);
				return (m ? m[1] : String(raw)).trim();
			};
			const ticketValue = (function () {
				const hit = (projectFiles || []).find(function (f) { return f.name === "review.approvals.json" && f.kind === "text"; });
				if (!hit) return null;
				try { return JSON.parse(hit.text); } catch (error) { return null; }
			})();
			/** ① 剧本页内容：产物清单 + 剧本正文（来自 `story.md`，读不到退回 `board.story.source`）。 */
			const storyPanel = React.createElement("div", { style: S.assets },
				React.createElement("div", { style: S.assetsHead },
					storyPaths.map(function (pair) {
						const info = pair[0];
						return React.createElement("span", { key: pair[1], style: S.assetLabel },
							pair[1] + (info && info.kind === "text" ? " " + info.text.length + "字" : " —"));
					})),
				storyText
					? React.createElement("pre", {
						style: {
							whiteSpace: "pre-wrap", margin: "6px 0 0",
							font: "11.5px/1.5 ui-monospace,Consolas,monospace",
							opacity: 0.92, overflow: "auto"
						}
					}, storyText)
					: React.createElement("p", { style: S.note }, "没有读到剧本（story.md 缺失，板子里也没有 story.source）"));

			/**
			 * ② 导演方案 / ③ 生成计划：**两张表格**，不再摊 JSON 原文。
			 *
			 * 分工：
			 * - **导演方案**回答"怎么切" —— 单元 / 边界理由 / 时长依据 / 首帧状态 / 高风险动作 / 包含哪些镜。
			 * - **生成计划**回答"怎么跑" —— 生成时长 / 关键帧槽位 / 演员与场景 / 包含哪些镜。
			 *
			 * 两者都读各自 JSON（读不到就显示原因），**不猜内容、不编造字段**。
			 */
			const jsonOf = function (name) {
				const hit = (projectFiles || []).find(function (f) { return f.name === name && f.kind === "text"; });
				if (!hit) return null;
				try { return JSON.parse(hit.text); } catch (error) { return null; }
			};
			const direction = jsonOf("board.direction.json");
			const plan = jsonOf("render.plan.json");

			/** 单元表通用外壳：给一份列名 + 若干行。 */
			const unitTable = function (cols, rows) {
				return React.createElement("div", { style: S.scroll },
					React.createElement("table", { style: S.table },
						React.createElement("thead", null, React.createElement("tr", null, cols.map(function (c) {
							return React.createElement("th", { key: c, style: S.th }, c);
						}))),
						React.createElement("tbody", null, rows)));
			};
			/**
			 * 一行单元格。
			 * @param opts - 可选 `{ onClick, active }`：给了 `onClick` 就是可点行（单元行），
			 *   `active` 为真时高亮 —— 用来表示"这个单元的镜头正展开在下面"。
			 */
			const cells = function (key, values, opts) {
				const style = opts && opts.active
					? Object.assign({}, S.row, S.rowOn)
					: (opts && opts.onClick ? S.row : null);
				return React.createElement("tr", {
					key: key,
					style: style || undefined,
					onClick: opts && opts.onClick ? opts.onClick : undefined
				}, values.map(function (v, i) {
					return React.createElement("td", { key: i, style: S.td }, v === null || v === undefined || v === "" ? "—" : v);
				}));
			};

			/** 镜头行：按单元归类，供两张表复用。 */
			/**
			 * 把动作文字里的**角色名高亮**出来 —— 替掉单独的「画面里有谁」列。
			 *
			 * 依据：动作文本里本来就写着谁在做什么，单开一列是把同一信息说两遍；
			 * 但直接删列会让"谁在场"变难扫，所以改成在文字里标出来。
			 *
			 * 名字来源两处，都取自板子：`characters[].name`（角色名）与
			 * `identities[].name`（造型名，如"沙滩比基尼"）。**按长度降序匹配**，
			 * 避免"苏晚"先命中、导致"苏晚·沙滩比基尼"这种更长的名字永远匹配不到。
			 */
			const highlightNames = function (text) {
				const s = String(text === null || text === undefined ? "" : text);
				if (!s) return "—";
				const nameSet = new Set();
				for (const c of ((board && board.characters) || [])) if (c.name) nameSet.add(c.name);
				for (const x of ((board && board.identities) || [])) if (x.name && x.name !== "默认造型") nameSet.add(x.name);
				const names = [...nameSet].sort(function (a, b) { return b.length - a.length; });
				const hits = [];
				for (const n of names) {
					let from = 0;
					while (true) {
						const at = s.indexOf(n, from);
						if (at < 0) break;
						hits.push({ at: at, end: at + n.length, name: n });
						from = at + n.length;
					}
				}
				if (!hits.length) return s;
				// 按位置排序，重叠时保留先到的（长的已先扫到）
				hits.sort(function (a, b) { return a.at - b.at; });
				const out = [];
				let cursor = 0;
				for (const h of hits) {
					if (h.at < cursor) continue;
					if (h.at > cursor) out.push(s.slice(cursor, h.at));
					out.push(React.createElement("span", {
						key: "n" + h.at,
						style: {
							padding: "0 3px", borderRadius: "3px", fontWeight: 600,
							background: "rgba(90,140,255,.22)", border: "1px solid rgba(90,140,255,.5)"
						}
					}, h.name));
					cursor = h.end;
				}
				if (cursor < s.length) out.push(s.slice(cursor));
				return out;
			};

			/**
			 * 造型 id → 角色名。`emotion_analysis[].character` 存的是**造型 id**
			 * （如 `lin_xiaoya_default`），直接显示对读剧本的人没意义。
			 *
			 * 找不到就原样返回 —— 有些旧项目的该字段直接写的是角色名，
			 * 也有写了板子里不存在 id 的情况，那时保持原值比编一个名字诚实。
			 */
			const nameOfId = function (id) {
				const key = String(id === null || id === undefined ? "" : id);
				if (!key) return "";
				const identity = ((board && board.identities) || []).find(function (x) { return x.id === key; });
				if (!identity) return key;
				const character = ((board && board.characters) || []).find(function (c) { return c.id === identity.character; });
				return (character && character.name) || key;
			};

			/**
			 * 一个人物的情绪因果链：**名字高亮 + 内在状态 · 可观察表演 · 视线**。
			 * 与动作列的 `highlightNames` 用同一套配色，扫起来是一致的那几个名字。
			 */
			const emotionOf = function (e) {
				const who = nameOfId(e.character);
				const rest = [e.internal_state, e.visible_behavior, e.gaze].filter(Boolean).join(" · ");
				return React.createElement("span", { style: { display: "inline-block", marginRight: "8px" } },
					React.createElement("span", {
						style: {
							padding: "0 3px", borderRadius: "3px", fontWeight: 600,
							background: "rgba(90,140,255,.22)", border: "1px solid rgba(90,140,255,.5)"
						}
					}, who),
					rest
						? React.createElement("span", null, " · " + rest)
						: null);
			};

			/**
			 * 分节标题。**表头已经能说明列是什么，所以这里只说"这一节讲什么"** ——
			 * 不再在表内重复一个「单元」列（那会让"单元"两个字出现两遍）。
			 */
			const sectionLabel = function (key, text) {
				return React.createElement("p", {
					key: key,
					style: { margin: "12px 0 4px", fontSize: "11.5px", fontWeight: 600, opacity: 0.85 }
				}, text);
			};
			/** 展开状态的一句话提示 + 「显示全部」按钮。 */
			const shotFilterBar = function (key, total, unit) {
				return React.createElement("p", { key: key, style: Object.assign({ marginTop: "10px" }, S.note) },
					"镜头（每一刀怎么拍）　共 " + total + " 镜"
					+ (unit ? "　当前只看 " + unit : ""),
					unit
						? React.createElement("button", {
							type: "button", style: Object.assign({ marginLeft: "8px" }, S.btn),
							onClick: function () { setOpenUnit(null); }
						}, "显示全部")
						: null);
			};

			// ② 导演与计划：**一张单元表 + 一张镜头表**（原来分成两个 tab，内容高度重叠）。
			//
			// 数据来源两份，职责互补：
			// - `board.direction.json`（导演交的）—— 为什么这么切、时长依据、首帧状态、情绪因果链。
			// - `render.plan.json`（编译器出的）—— **可执行字段**：生成时长（可能被 H3 帧网格撑大）、
			//   关键帧槽位、演员/场景/道具。
			// 合并后按单元对齐：**某一侧缺失时那一列显示 `—`，不猜、不编**。
			const dirUnits = (direction && direction.units) || [];
			const planUnits = (plan && plan.units) || [];
			const planById = {};
			for (const u of planUnits) planById[u.id] = u;
			/** 单元清单：优先用导演稿的顺序；只有计划没有导演稿时退回计划。 */
			const mergedUnits = dirUnits.length
				? dirUnits.map(function (u) { return { dir: u, plan: planById[u.id] || null }; })
				: planUnits.map(function (u) { return { dir: null, plan: u }; });

			/**
			 * 「② 导演与计划」= **三层结构**：
			 *   第一层  单元名 tabs（点一下切换单元）
			 *   第二层  该单元的**基本信息**
			 *   第三层  该单元的**镜头信息**
			 *
			 * 与"一张大表列全部单元"的区别：单元之间本就该对比着看，
			 * 但每个单元的字段多、镜头多，平铺在一张表里会互相挤 —— 三层结构让它一次只看一个单元。
			 */
			const activeUnit = (function () {
				if (!mergedUnits.length) return null;
				if (openUnit) {
					const hit = mergedUnits.find(function (p) {
						return (p.dir && p.dir.id === openUnit) || (p.plan && p.plan.id === openUnit);
					});
					if (hit) return hit;
				}
				return mergedUnits[0];   // 没选 / 选了个不存在的 → 落到第一个
			})();
			const activeId = activeUnit ? ((activeUnit.dir || activeUnit.plan).id) : null;
			const activeShots = activeUnit ? (((activeUnit.dir || activeUnit.plan).shots) || []) : [];

			/** 只画当前单元的镜头行。 */
			const activeShotRows = activeShots.map(function (s) {
				// 情绪因果链：**角色名高亮**（原来显示的是造型 id，人读不懂）
				const emo = (s.emotion_analysis || []).map(function (e) { return emotionOf(e); });
				// 台词：**显示原文，行号退到后面当溯源**。
				// 导演稿里只有行号（它没有资格写台词），原文由代码从剧本逐字搬来。
				const speech = (s.lines || []).map(function (no) {
					const text = lineTextOf(no);
					return React.createElement("div", { key: "l" + no, style: { marginBottom: "2px" } },
						React.createElement("span", { style: { opacity: 0.5, fontSize: "10px", marginRight: "4px" } }, "L" + no),
						text === null
							? React.createElement("span", { style: S.bad }, "（剧本第 " + no + " 行取不到）")
							: React.createElement("span", null, "「" + text + "」"));
				});
				return cells(activeId + ":" + (s.n || 0), [
					String(s.n || "—"),
					Number(s.at || 0).toFixed(2) + "s",
					Number(s.duration_s || 0).toFixed(2) + "s",
					s.framing || "—",
					s.camera || "—",
					highlightNames(s.action),   // 角色名在这里高亮，不再单开「画面里有谁」列
					speech.length ? speech : "—",
					s.cut || "—",
					emo.length ? emo : "—"
				]);
			});

			/** 基本信息：键值两列，比横表好读（字段名不会被挤成两行）。 */
			const infoRow = function (key, label, value) {
				return React.createElement("tr", { key: key },
					React.createElement("td", { style: Object.assign({}, S.td, { opacity: 0.6, whiteSpace: "nowrap" }) }, label),
					React.createElement("td", { style: S.td }, value === null || value === undefined || value === "" ? "—" : value));
			};
			/**
			 * 基本信息：**只留导演自己写的东西**。
			 *
			 * 这一页的用途是"读导演的剧本"，不是读生成配置 —— 所以按"谁写的"筛选：
			 *   ✅ 留：含几镜 / 内容时长 / 首帧状态 / 为什么放一起　（都是导演的判断）
			 *   ❌ 去：边界理由（五类枚举标签，给校验器看的，不是人话）
			 *         生成时长（编译器从 H3 帧网格算的执行参数，不是导演写的）
			 *          关键帧槽位（`keyframes_render/g001.png` 是文件路径）
			 *          高风险动作（`multi_actor_contact@6.5s` 是校验器判据，术语；
			 *                     动作本身已经写在镜头表的「动作」列里）
			 *
			 * 砍掉的字段**不删数据**，只是不在这里显示 —— 仍在各自的 JSON 里。
			 */
			const unitInfoTable = function (pair) {
				const u = pair.dir || pair.plan;
				const contentEnd = Math.max.apply(null, ((u.shots) || []).map(function (s) {
					return (s.at || 0) + (s.duration_s || 0);
				}).concat([0]));
				return React.createElement("table", { style: S.table },
					React.createElement("tbody", null, [
						infoRow("c", "含几镜", String(((u.shots) || []).length) + " 镜"),
						infoRow("d", "内容时长", contentEnd.toFixed(2) + "s"),
						infoRow("f", "首帧状态（0 秒）", u.keyframe_start),
						infoRow("i", "为什么放一起", u.why)
					]));
			};

			const directionPanel = (direction === null && plan === null)
				? React.createElement("p", { style: S.note }, "没读到 board.direction.json 与 render.plan.json")
				: React.createElement("div", null,
					// 这一行**只显示给人看的东西**。
					//
					// 原来显示的是**导演层的** `direction.logline`，那是导演写给自己的方案自述，
					// 术语密集（实测：「两个连续单元完成同一场海滩误会：先在不接触的关键帧里完成
					// 接近、犹豫与拍肩…」）—— 用户直接说"看不懂"。而**故事层的**
					// `board.meta.logline` 才是给人读的一句话（「沙滩上他以为她肩头落了只蚊子，
					// 一巴掌拍下去——那是她的纹身。」），每个项目都写得清楚。
					//
					// 导演层那句不是没用（它解释切分策略），但它属于**技术自述**，
					// 不该占表头的位置；真要查可以去看 `board.direction.json` 原文。
					//
					// 注意：这里**不能用后文才声明的 `meta` / `total`** —— 同样的 `const` 作用域里
					// 提前引用会命中 TDZ（`Cannot access before initialization`），
					// 而语法检查发现不了。所以就地从 `board` 取。
					React.createElement("p", { style: S.note }, (board.meta && board.meta.logline) || "（板子里没有 logline）"),
					React.createElement("p", { style: S.dim },
						((board.meta && board.meta.style) || "?") + " · " + ((board.meta && board.meta.aspect) || "?")
						+ " · 共 " + shots.reduce(function (n, s) { return n + (Number(s.duration_s) || 0); }, 0).toFixed(2) + "s"
						+ (plan
							? "　｜　项目 " + ((plan.provenance && plan.provenance.project_id) || "?")
								+ "　计划绑定导演协议 v" + ((plan.provenance && plan.provenance.direction_version) || "?")
							: "　｜　（没有生成计划，可执行字段留空）")
						+ (direction ? "　｜　导演稿 version " + (direction.version || "?") : "　｜　（没有导演稿）")),
					// ── 第一层：单元名 tabs ──────────────────────────────
					React.createElement("div", { style: S.gates },
						mergedUnits.map(function (pair) {
							const id = (pair.dir || pair.plan).id;
							return React.createElement("button", {
								key: id, type: "button",
								style: id === activeId ? S.gateNow : S.gateOff,
								onClick: function () { setOpenUnit(id); }
							}, id);
						})),
					// ── 第二层：该单元的基本信息 ──────────────────────────
					sectionLabel("h1", "基本信息　" + (activeId || "")),
					activeUnit
						? unitInfoTable(activeUnit)
						: React.createElement("p", { style: S.note }, "没有单元"),
					// ── 第三层：该单元的镜头信息 ──────────────────────────
					// 列里**没有「画面里有谁」** —— 动作文字里本来就写着谁在做什么，
					// 单开一列是把同一件事说两遍；改成在动作里把**角色名高亮**。
					sectionLabel("h2", "镜头信息　共 " + activeShots.length + " 镜"),
					unitTable(
						["镜", "起点", "时长", "景别", "运镜", "动作", "台词", "切法", "情绪因果链"],
						activeShotRows));

			// 旧位置：早退块已移到函数开头（见上方注释 —— 放这里太晚，board.meta 会先被求值）。
			// 这里的 meta / total 也一并移走了，避免重复声明。

			/**
			 * 现行人工票据行（**常驻**，不随分页切换）：
			 * 从 `review.approvals.json` 读各阶段票，以及每段视频的当前票。
			 */
			const ticketRow = React.createElement("div", { style: S.gates },
				TICKETS.map(function (entry) {
					const a = ticketValue && ticketValue.approvals ? ticketValue.approvals[entry[0]] : null;
					return React.createElement("span", { key: entry[0], style: a ? S.gateOn : S.gateOff },
						entry[1] + (a ? " ✅" : " ⬜"));
				}),
				(function () {
					const clips = (ticketValue && ticketValue.approvals && ticketValue.approvals.clips) || null;
					if (!clips) return null;
					return Object.keys(clips).sort().map(function (id) {
						const v = clips[id] || {};
						const confirmed = Boolean(v.artifact_hash || v.final && v.final.artifact_hash);
						return React.createElement("span", { key: "clip:" + id, style: confirmed ? S.gateOn : S.gateOff },
							id + (confirmed ? " ✅" : " ⬜"));
					});
				})(),
				// `projectNote` 有两类：列目录**失败**（红字）与**隐藏了空壳目录**的提示（灰字）
				projectNote
					? React.createElement("span", { style: /^列不到/.test(projectNote) ? S.bad : S.dim }, projectNote)
					: null);

			const head = React.createElement("div", { style: S.head },
				React.createElement("div", { style: S.title }, (meta.title || "未命名") + " · 分镜确认表"),
				React.createElement("div", { style: S.dim }, meta.logline || ""),
				// 这里原来还画一行**板子自己的闸门**（①故事 ②分镜表 ③资产 ④关键帧 ⑤出片），
				// 取自 `board.meta.approvals`。那是**旧票模型**，与下面 `review.approvals.json`
				// 的现行票据行重复 —— 用户要求去掉，只留现行票据。
				ticketRow,
				React.createElement("div", { style: Object.assign({ marginTop: "6px" }, S.dim) },
					// `.toFixed(2)` —— 不格式化会显示成 `89.14999999999999s`（浮点累加）
			shots.length + " 个镜头 · 共 " + total.toFixed(2) + "s · " + (meta.aspect || "") + " · " + (meta.style || "")),
				// **文件选择器必须排在第一个 `<select>`** —— 那是契约（集成测试钉住 `selects[0]`），
				// 不能因为新增剧目下拉就把它挤到后面。
				React.createElement("div", { style: { display: "none" } }, picker),
				projectPicker);

			/**
			 * 板子镜头 → 生成单元的映射。
			 *
			 * **为什么需要它**：表格画的是"单元 → 它包含哪些镜"，而关键帧和视频按生成单元
			 * （`g001`/`g002`）存在 —— 两套编号必须对起来。
			 *
			 * 依据是**确定性的**：生成计划里每个单元的内部镜头都有 `source={unit, shot}`，
			 * 把各单元的内部镜头按顺序摊平，正好按顺序覆盖板子的那些镜
			 * （`plan.units` 顺序 = 该剧的镜头顺序，`compile-units` 保证）。
			 *
			 * 摊平后的长度与板子镜头数不一致时**不猜**：返回空数组，
			 * 由调用方退回按镜头画，避免把图错标到别的镜上。
			 */
			const unitOfShot = (function () {
				const flat = [];
				for (const u of (artifacts && artifacts.unitShots) || []) {
					for (let n = 0; n < u.count; n++) flat.push(u.id);
				}
				return flat.length === shots.length ? flat : [];
			})();

			/**
			 * 表格按层级画：**一行一个生成单元，后面跟它包含的镜号**。
			 *
			 * 为什么不是按镜头画：**关键帧与视频是"每单元一份"**（一次生成内部可以切好几刀，
			 * 见 `references/directing.md` 的「单元不是机械剪辑点」）。按镜头画会让同一单元的多行
			 * 重复显示同一对图 —— 粒度对不上。
			 *
			 * 板子里没有生成计划时（例如只给了 board.json）**退回按镜头画**：
			 * 那时没有单元信息，硬按单元画会得到一张空表。
			 */
			const shotsForUnit = (function () {
				const map = {};
				for (let i = 0; i < unitOfShot.length; i++) {
					const uid = unitOfShot[i];
					(map[uid] || (map[uid] = [])).push(shots[i]);
				}
				return map;
			})();
			const unitOrder = (artifacts && artifacts.unitShots) || [];
			const useUnits = unitOrder.length > 0;

			const header = React.createElement("tr", null, (useUnits
				? ["单元", "镜头", "生成时长", "本单元包含的画面", "关键帧", "视频片段"]
				: ["镜号", "时长", "画面描述", "单元", "关键帧", "视频片段"]
			).map(function (label) {
				return React.createElement("th", { key: label, style: S.th }, label);
			}));

			/**
			 * 一个媒体格：缩略图（视频带 ▶），点它 → 下方细节区看大图或播放。
			 * @param kind - `kf` 关键帧 / `clip` 视频片段。
			 * @param key - `assetList` 里的键。
			 */
			const mediaCell = function (kind, key) {
				const url = assetUrls[key];
				if (!url) return React.createElement("span", { style: S.dim }, "—");
				const path = (kind === "clip"
					? artifacts && artifacts.clips && artifacts.clips[key.slice(5)]
					: artifacts && artifacts.keyframes && artifacts.keyframes[key.slice(3)]) || "";
				const isVid = isVideoPath(path);
				return React.createElement("div", {
					style: { position: "relative", width: "64px", cursor: "zoom-in" },
					onClick: function (event) { event.stopPropagation(); setFocus(key); }
				},
					isVid
						? React.createElement("video", {
							src: url + "#t=0.1", preload: "metadata", muted: true, playsInline: true,
							style: { width: "64px", height: "44px", objectFit: "cover", borderRadius: "3px", display: "block", background: "#000" }
						})
						: React.createElement("img", {
							src: url, alt: path,
							style: { width: "64px", height: "44px", objectFit: "cover", borderRadius: "3px", display: "block" }
						}),
					isVid
						? React.createElement("span", {
							style: {
								position: "absolute", inset: 0, display: "flex", alignItems: "center",
								justifyContent: "center", fontSize: "15px", color: "#fff",
								textShadow: "0 0 6px rgba(0,0,0,.9)", pointerEvents: "none"
							}
						}, "▶")
						: null);
			};

			/**
			 * 镜号列表压成紧凑写法：连续的三镜以上写成 `s01–s04`，否则逐个列。
			 */
			const shotsLabel = function (ids) {
				if (!ids.length) return "—";
				const nums = ids.map(function (id) { return String(id).replace(/^[a-z]+/i, ""); });
				const isSeq = function (a) {
					for (let i = 1; i < a.length; i++) if (Number(a[i]) !== Number(a[i - 1]) + 1) return false;
					return true;
				};
				const prefix = String(ids[0]).replace(/[0-9]+$/, "");
				if (ids.length >= 3 && isSeq(nums)) return prefix + ids[0].slice(prefix.length) + "–" + ids[ids.length - 1];
				return ids.join("、");
			};

			const rows = useUnits
				? unitOrder.map(function (u, index) {
					const group = shotsForUnit[u.id] || [];
					const label = shotsLabel(group.map(function (s) { return s.id; }));
					const thumb = function (kind) {
						const url = assetUrls[(kind === "clip" ? "clip:" : "kf:") + u.id];
						if (!url) return React.createElement("span", { style: S.dim }, "—");
						// **必须带 `artifacts &&` 前缀**：`artifacts` 在索引读完之前是 `null`，
						// 那时直接读 `artifacts.clips` 会抛
						// `Cannot read properties of null (reading 'clips')` → React 卸载整棵子树 → **面板全黑**。
						// 同族的 mediaCell（另一处）一直有这层保护，这两行漏了 —— 实测就是这么黑的。
						const path = (kind === "clip"
							? artifacts && artifacts.clips && artifacts.clips[u.id]
							: artifacts && artifacts.keyframes && artifacts.keyframes[u.id]) || "";
						const isVid = isVideoPath(path);
						return React.createElement("div", {
							style: { position: "relative", width: "64px", cursor: "zoom-in" },
							onClick: function () { setFocus((kind === "clip" ? "clip:" : "kf:") + u.id); }
						},
							isVid
								? React.createElement("video", {
									src: url + "#t=0.1", preload: "metadata", muted: true, playsInline: true,
									style: { width: "64px", height: "44px", objectFit: "cover", borderRadius: "3px", display: "block", background: "#000" }
								})
								: React.createElement("img", { src: url, alt: path,
									style: { width: "64px", height: "44px", objectFit: "cover", borderRadius: "3px", display: "block" } }),
							isVid
								? React.createElement("span", {
									style: {
										position: "absolute", inset: 0, display: "flex", alignItems: "center",
										justifyContent: "center", fontSize: "15px", color: "#fff",
										textShadow: "0 0 6px rgba(0,0,0,.9)", pointerEvents: "none"
									}
								}, "▶")
								: null);
					};
					return React.createElement("tr", {
						key: u.id,
						style: index === picked ? Object.assign({}, S.row, S.rowOn) : S.row,
						onClick: function () { setPicked(index); }
					},
						td("unit", u.id),
						td("shots", label, { whiteSpace: "nowrap" }),
						td("dur", Number(u.content_duration_s || 0).toFixed(2) + "s"),
						td("act", group.map(function (s) { return s.action || ""; }).filter(Boolean).join(" → ") || "—"),
						td("kf", thumb("kf"), { whiteSpace: "nowrap" }),
						td("clip", thumb("clip"), { whiteSpace: "nowrap" }));
				})
				: shots.map(function (item, index) {
					const unitId = unitOfShot[index] || null;
					return React.createElement("tr", {
						key: item.id,
						style: index === picked ? Object.assign({}, S.row, S.rowOn) : S.row,
						onClick: function () { setPicked(index); }
					},
						td("id", item.id),
						td("dur", item.duration_s + "s"),
						td("act", item.action),
						td("unit", unitId || "—", { whiteSpace: "nowrap", opacity: unitId ? 1 : 0.5 }),
						td("kf", unitId ? mediaCell("kf", "kf:" + unitId) : React.createElement("span", { style: S.dim }, "—"), { whiteSpace: "nowrap" }),
						td("clip", unitId ? mediaCell("clip", "clip:" + unitId) : React.createElement("span", { style: S.dim }, "—"), { whiteSpace: "nowrap" }));
				});

			const table = React.createElement("div", { style: S.scroll },
				React.createElement("table", { style: S.table },
					React.createElement("thead", null, header),
					React.createElement("tbody", null, rows)));

			// 资产带：**按分页归属过滤**。
			// ② 资源页只放资源阶段产物（肖像 / 身份图 / 场景 / 道具）；
			// ③ 关键帧与视频页放关键帧和视频（`assetList` 全体仍参与读取与签名，
			// 所以切页不会重复拉图）。
			const assetsForTab = assetList.filter(function (a) { return a.tab === 1; });
			const mediaForTab = assetList.filter(function (a) { return a.tab === 2; });
			const stripOf = function (items) {
				return items.length
					? React.createElement("div", { style: S.assets },
						React.createElement("div", { style: S.assetsHead },
							items.length + " 个　（点一下看大图）"),
						React.createElement("div", { style: S.assetsRow }, items.map(function (item) {
							const url = assetUrls[item.key];
							const video = isVideoPath(item.path);
							return React.createElement("button", {
								key: item.key,
								type: "button",
								title: item.path,
								style: focus === item.key ? Object.assign({}, S.assetCard, S.assetCardOn) : S.assetCard,
								onClick: function () { setFocus(focus === item.key ? null : item.key); }
							},
								url && video
									? React.createElement("div", { style: { position: "relative" } },
										React.createElement("video", {
											src: url + "#t=0.1", preload: "metadata", muted: true, playsInline: true,
											style: S.assetThumb
										}),
										React.createElement("span", {
											style: {
												position: "absolute", inset: 0, display: "flex", alignItems: "center",
												justifyContent: "center", fontSize: "20px", color: "#fff",
												textShadow: "0 0 6px rgba(0,0,0,.9)", pointerEvents: "none"
											}
										}, "▶"))
									: url
										? React.createElement("img", { src: url, alt: item.label, style: S.assetThumb })
									: React.createElement("div", { style: S.assetThumbEmpty }, "…"),
							React.createElement("span", { style: S.assetLabel }, item.group + "　" + item.label));
					})))
					: React.createElement("p", { style: S.note }, "这一页在本剧目里没有对应产物。");
			};
			const assetStrip = stripOf(assetsForTab);

			/**
			 * 细节区：**关键帧 / 视频在这里看**（列表里只放小缩略图）。
			 *
			 * 从表格移走的那些列（景别 / 光影 / 对白 · 旁白 / 音效 / 运镜 / 剪辑）也在这里展开 ——
			 * 它们挤在 12 列的表格里读不动，这里宽度充足。
			 */
			const focused = focus ? assetList.filter(function (a) { return a.key === focus; })[0] : null;
			const focusUrl = focused ? assetUrls[focused.key] : null;
			const focusIsVideo = focused ? isVideoPath(focused.path) : false;
			const detail = focused
				? React.createElement("div", { style: S.detail },
					React.createElement("p", { style: { margin: "0 0 6px", fontWeight: 600 } },
						focused.group + "：" + focused.label),
					React.createElement("div", { style: S.stage },
						focusUrl
							? (focusIsVideo
								? React.createElement("video", { src: focusUrl, controls: true, playsInline: true, style: S.media })
								: React.createElement("img", { src: focusUrl, alt: focused.label, style: S.assetBig }))
							: React.createElement("p", { style: S.note }, "正在读…")),
					React.createElement("p", { style: S.note }, focused.path))
				: React.createElement("div", { style: S.detail },
					shot
						? [
							React.createElement("p", { key: "h", style: { margin: "0 0 6px", fontWeight: 600 } },
								shot.id + "　" + shot.shot_size + " / " + shot.camera + " / " + shot.duration_s + "s"),
							line("画面", shot.prompt),
							line("对白", dialogueOf(board, shot)),
							line("光影", shot.lighting || "—"),
							line("音效", shot.audio || "—"),
							line("运镜", shot.camera || "—"),
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

			/**
			 * 内容分页：**① 剧本 / ② 资源 / ③ 关键帧与视频**。
			 *
			 * 做法：三个 body 都挂进 DOM，非活动的用 `display:none` 隐藏 ——
			 * 这样资产图的 `useEffect` 不受分页影响（切页不会重复拉图），
			 * 而且隐藏的图像仍在树上，不影响集成测试对渲染结果的断言。
			 * 顶部的标题、闸门、票据行、两个下拉**常驻**，切页不丢上下文。
			 */
			const TAB_NAMES = ["① 剧本", "② 导演与计划", "③ 资源", "④ 关键帧与视频片段", "⑤ 成片"];
			const tabBar = React.createElement("div", { style: S.gates },
				TAB_NAMES.map(function (name, index) {
					return React.createElement("button", {
						key: name,
						type: "button",
						style: index === tab ? S.gateNow : S.gateOff,
						onClick: function () { setTab(index); }
					}, name);
				}));
			const bodyOf = function (index, node) {
				return React.createElement("div", { style: index === tab ? { flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column" } : { display: "none" } }, node);
			};
			// ⑤ 成片页：只放最终成片 —— 全片一个，不属于任何单镜，所以不做进表格。
			const finalPath = artifacts && artifacts.final;
			const finalUrl = finalPath ? assetUrls["final"] : null;
			const finalPanel = React.createElement("div", { style: S.assets },
				finalUrl
					? React.createElement("div", { style: S.stage },
						React.createElement("video", { src: finalUrl, controls: true, playsInline: true, style: S.media }))
					: React.createElement("p", { style: S.note }, "还没有成片（约定路径：out/final.mp4）"),
				React.createElement("p", { style: S.note }, finalPath || ""));

			/**
			 * ④ 页直接是表格：**关键帧与视频片段在同一行并排**（两个媒体列），
			 * 不再有内层切换标签。成片不在这里 —— 它归 ⑤ 成片页。
			 */
			return React.createElement("div", { style: S.panel },
				head,
				React.createElement("div", { style: S.head }, tabBar),
				bodyOf(0, React.createElement("div", { style: S.scroll }, storyPanel)),
				bodyOf(1, React.createElement("div", { style: S.scroll }, directionPanel)),
				bodyOf(2, React.createElement("div", { style: S.scroll }, assetStrip)),
				bodyOf(3, React.createElement("div", { style: { flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column" } },
					table, detail)),
				bodyOf(4, React.createElement("div", { style: S.scroll }, finalPanel)));
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

		/**
		 * 需要的浏览器服务：槽位注册表、右侧栏 tab 注册表、Remote 载体及其命名空间。
		 *
		 * `remote.directoryPicker` 用来**列举剧目目录**（收绝对路径）——
		 * `workspaceFiles.list` 只在会话工作区根内可用，而真实项目按 `README.md` 规定在仓库外。
		 */
		const inject = ["slots", "sidebarRightTabs", "remote", "remote.workspaceFiles", "remote.directoryPicker"];

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
			// 目录列举是**可选能力**：宿主组合没挂 directoryPicker 时不让插件整体注册失败，
			// 而是让剧目下拉优雅降级并给出可操作的提示。
			host.listDir = function (dirPath, signal) {
				const picker = ctx.remote && ctx.remote.directoryPicker;
				if (!picker || typeof picker.list !== "function") {
					return Promise.resolve({
						ok: false,
						error: { code: "directory-picker-absent", message: "宿主未组合 directoryPicker，无法列举工作区外的目录" }
					});
				}
				return picker.list(dirPath, signal);
			};

			const attempt = (label, fn) => {
				try {
					ctx.effect(fn, label);
				} catch (error) {
					console.error("[dsh-storyboard] " + label + " 注册失败", error);
				}
			};

			/**
			 * 面板的错误边界。
			 *
			 * **为什么必须有它**：面板抛异常时 React 会卸载整棵子树，用户看到的是**全黑**，
			 * 连错误信息都看不到 —— 那是最没法排查的失败方式（实测踩过：切到另一个剧目后黑屏）。
			 * 有了边界，失败时至少能看到消息、堆栈的组件名，以及"重试"按钮。
			 *
			 * **没有 `React.Component` 时退化为原面板**（测试用的假 React 没有 Component）：
			 * 直接 `class extends undefined` 会在**工厂函数执行时**就抛错，导致整个插件加载失败 ——
			 * 那是比"少一个边界"严重得多的后果。
			 */
			const SafeBoardPanel = (function () {
				const Base = React.Component;
				if (typeof Base !== "function") return BoardPanel;   // 环境没有 Component → 不加边界
				class PanelBoundary extends Base {
					constructor(props) {
						super(props);
						this.state = { error: null };
					}
					componentDidCatch(error) {
						const where = error && error.stack ? String(error.stack).split("\n").slice(0, 4).join(" ← ") : "";
						console.error("[dsh-storyboard] 面板渲染失败", error, where);
					}
					render() {
						if (!this.state.error) return this.props.children;
						// **把现场数据一起显示出来** —— 光有错误消息不够，
						// "哪个剧目、载入状态是什么、板子是什么类型"才是定位的关键。
						const snap = (typeof trace === "function" ? trace() : "") || "（没有现场数据）";
						return React.createElement("div", { style: { padding: "12px", font: "12px/1.6 system-ui,sans-serif" } },
							React.createElement("p", { style: { color: "#e06c6c", margin: "0 0 6px", fontWeight: 600 } }, "分镜面板渲染失败"),
							React.createElement("p", { style: { margin: "0 0 6px", opacity: 0.9 } }, String((this.state.error && this.state.error.message) || this.state.error)),
							React.createElement("p", { style: { margin: "0 0 6px", opacity: 0.85, fontSize: "11px", overflowWrap: "anywhere" } }, "现场：" + snap),
							React.createElement("p", { style: { margin: "0 0 8px", opacity: 0.6, fontSize: "10.5px", overflowWrap: "anywhere" } },
								String((this.state.error && this.state.error.stack) || "").split("\n").slice(0, 5).join("  ←  ")),
							React.createElement("button", {
								type: "button",
								style: S.btn,
								onClick: function () { this.setState({ error: null }); }.bind(this)
							}, "重试"));
					}
				}
				if (typeof PanelBoundary.getDerivedStateFromError !== "function") {
					PanelBoundary.getDerivedStateFromError = function (error) { return { error: error }; };
				}
				return function (props) {
					return React.createElement(PanelBoundary, null, React.createElement(BoardPanel, props));
				};
			})();

			attempt("dsh-storyboard: tab type", () => ctx.sidebarRightTabs.register(definition()));

			attempt("dsh-storyboard: tab body", () => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
				name: "sidebar.right.pane.tab",
				key: ID
			}, SafeBoardPanel)));

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
