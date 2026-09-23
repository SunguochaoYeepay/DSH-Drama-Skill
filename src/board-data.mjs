/**
 * board-data.mjs — 看板的数据层（纯函数，不碰 HTTP）。
 *
 * 背景（2026-09-22 看板独立）：DSH 里的 dsh-storyboard 面板借 DSH 的只是壳，
 * 数据 100% 来自剧目目录的文件。本模块把这些读取逻辑沉淀成纯函数，
 * `web/server.mjs` 与 `tests/kanban.test.mjs` 共用同一份实现 —— 读取契约只有
 * 一个所有者，面板和服务不会各读各的。
 *
 * 读取契约（与 dsh-storyboard 客户端半核对过）：
 * - board.json                板子（meta/shots/characters/identities/scenes/props）
 * - story.md                  剧本正本（读不到退回 board.story.source）
 * - board.direction.json      导演稿（units[].shots[].lines 是剧本行号，不是台词）
 * - render.plan.json          生成计划（units[].keyframe 是关键帧的权威索引）
 * - review.approvals.json     人工票据（direction/assets/keyframes/final/clips）
 * - units/<id>.result.json    视频片段（files[].local_path）
 * - out/final.mp4             成片（约定路径）
 *
 * 2026-09-22 增补：`gates`（各阶段票状态）与 `directionUnits`（行号已解成台词）。
 * 画布要按「阶段 / 单元」画节点、按票判卡点，这两块是它的一等输入。
 */

import fs from 'node:fs';
import path from 'node:path';

function readJson(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const value = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    return value;
  } catch {
    return null;
  }
}

/** 读纯文本：读不到给 null —— 提示词文件缺是常态（阶段没走到），不是错误。 */
function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** 文本 → 送模型的形态（去首尾空白）；空串按「没有」处理。 */
function trimOrNull(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  return t || null;
}

/** 归档区目录名：归档剧目住这里，不进主线清单。 */
export const ARCHIVE_DIRNAME = '_archive';

/**
 * 剧目名必须是**单层路径段**：拒 `..`、盘符、路径分隔符、`.` 与归档区名。
 * 服务端路由、归档、删除共用这一份 —— 路径校验只有一个所有者。
 */
export function isValidProjectName(name) {
  return typeof name === 'string'
    && name.length > 0
    && !/[\\/]/.test(name)
    && !name.includes('..')
    && !/^[A-Za-z]:/.test(name)
    && name !== '.'
    && name !== ARCHIVE_DIRNAME;
}

/**
 * 剧目的创建时间，三级取值：
 * 1. `board.json` 的 **`meta.created_at`** —— 立项时由 `cli/init-board.mjs` 写死，
 *    之后任何阶段都不许改。这是正主。
 * 2. 退回 **board.json 的 mtime** —— 老剧目没这个字段（本 CLI 之前不写）。
 *    为什么不用目录时间（2026-09-22 实测踩过）：22 个剧目从 E 盘拷进仓库时
 *    **目录是新建的**，21 个目录的 birthtime/mtime 全被抹成同一刻，拿它排等于乱排；
 *    而**文件**的 mtime 会被 `copyFileSync` 带过来（Windows CopyFile 保留
 *    LastWriteTime），所以它是迁移后唯一活着的信号。
 *    ⚠ 它的语义是「板子最后一次写入」，改板会前移 —— 只是推断，不是事实。
 * 3. 再退回**目录 mtime**，都读不到给 null（界面按「无时间」排最后）。
 *
 * @returns {string|null} ISO 字符串。
 */
function createdAtOf(dir, board) {
  const explicit = board?.meta?.created_at;
  if (typeof explicit === 'string') {
    const t = Date.parse(explicit);
    if (Number.isFinite(t)) return new Date(t).toISOString();   // 写歪了就当没有，往下退
  }
  const boardFile = path.join(dir, 'board.json');
  try {
    if (fs.existsSync(boardFile)) return fs.statSync(boardFile).mtime.toISOString();
  } catch { /* 读不到就往下退 */ }
  try {
    return fs.statSync(dir).mtime.toISOString();
  } catch {
    return null;
  }
}

/**
 * 列出剧目根下的剧目：读得出 board.json 的目录才算，空壳目录不进下拉
 * （与 dsh-storyboard 的判据一致：能读出板子 = 是剧目）。
 * 排除点开头（系统/隐藏）与**归档区** —— 归档剧目走 listArchived，不混进主线。
 *
 * **按创建时间倒序**（新的在前）；时间相同（或都读不到）时按目录名升序，
 * 保证顺序稳定、不会因为文件系统返回顺序抖动。排序只在数据层做一次 ——
 * 左侧列表与顶栏下拉用的是同一个数组，不会各排各的。
 *
 * @returns {Array<{name:string,title:string,createdAt:string|null}>}
 */
export function listProjects(root) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === ARCHIVE_DIRNAME) continue;
    const board = readJson(path.join(root, e.name, 'board.json'));
    if (!board) continue;
    out.push({
      name: e.name,
      title: String(board.meta?.title || '').trim() || e.name,
      createdAt: createdAtOf(path.join(root, e.name), board),
    });
  }
  const rank = (p) => (p.createdAt ? Date.parse(p.createdAt) : 0);
  return out.sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name));
}

/**
 * 把板子里写的资产路径归一成「剧目内相对路径」。
 * - 相对路径 → 原样（规范化分隔符）；
 * - 绝对路径在剧目目录**里面** → 转相对；
 * - 绝对路径在剧目外（老项目的 E 盘残留）→ null（服务端没法喂，界面显示缺）。
 * @returns {string|null}
 */
export function relInside(projectDir, p) {
  const s = String(p || '');
  if (!s) return null;
  if (!/^[A-Za-z]:[\\/]|^\\\\|^\//.test(s)) {
    return s.replace(/\\/g, '/').replace(/^\/+/, '');
  }
  const rel = path.relative(projectDir, s);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.replace(/\\/g, '/');
}

/** 视频扩展名（与 dsh-storyboard 的 isVideoPath 同集）。 */
export function isVideoPath(p) {
  return /\.(mp4|m4v|webm|mov|mkv)$/i.test(String(p || ''));
}

/**
 * 阶段闸门（人工票）的顺序，与 `references/workflow.md` 的阶段序一致。
 * `handoffs` 不在内 —— 它是交接记录，不是阶段闸门。
 */
export const GATE_STAGES = ['story', 'board', 'direction', 'assets', 'keyframes', 'clips', 'final'];

/**
 * 把 `review.approvals.json` 摊成「每阶段签没签」。
 *
 * 形状差异：除 `clips` 外都是单个票据对象（{at, by, artifact_hash}）；
 * `clips` 是**按单元**一张（{g001: {...}}），所以单独算计数。
 * 缺票一律 `signed:false`，不抛 —— 老剧目本来就缺。
 *
 * @param {object|null} tickets review.approvals.json 的内容
 * @param {string[]} unitIds 计划单元 id（算 clips 的分母）
 */
export function gateSummary(tickets, unitIds = []) {
  const approvals = (tickets && typeof tickets === 'object' && tickets.approvals) || {};
  const one = (key) => {
    const v = approvals[key];
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { signed: false };
    return { signed: true, at: v.at || null, by: v.by || null, hash: v.artifact_hash || null };
  };
  const out = {};
  for (const key of GATE_STAGES) {
    if (key !== 'clips') out[key] = one(key);
  }
  const clipsRaw = approvals.clips && typeof approvals.clips === 'object' ? approvals.clips : {};
  const perUnit = {};
  for (const id of unitIds) perUnit[id] = Boolean(clipsRaw[id]);
  const signedCount = unitIds.filter((id) => perUnit[id]).length;
  out.clips = {
    signed: unitIds.length > 0 && signedCount === unitIds.length,
    signedCount,
    total: unitIds.length,
    perUnit,
  };
  return out;
}

/**
 * 一条记录下来的媒体路径 → 「剧目内相对路径」的**候选**（按可信度排序，调用方逐个验存在性）。
 *
 * 为什么要多候选：产物路径有三种历史写法 ——
 * 1. 剧目内相对（`units/x.mp4`）—— 现在的写法；
 * 2. **相对仓库根**（`projects/desk_quake/units/x.mp4`）—— 老 CLI 就是这么写的；
 * 3. 当时所在盘的绝对路径（`E:\…`）—— 搬家后落到剧目外。
 *
 * 只按 1 处理会出事：2 会被 `relInside` 原样返回，看板拼成
 * `/media/<剧>/projects/<剧>/units/x.mp4` → **404**（desk_quake 2026-09-23 实测：
 * `units/g001.result.json` 写着 `projects\desk_quake\units\i2v_….mp4`）。
 * 所以这里把三种写法都列成候选，**由调用方验存在性**决定用哪个。
 * @returns {string[]} 剧目内相对路径候选（不含明显越界的）
 */
function candidateRels(projectDir, p) {
  const out = [];
  const push = (v) => {
    if (!v) return;
    const norm = String(v).replace(/\\/g, '/').replace(/^\/+/, '');
    if (!norm || norm === '.' || norm.startsWith('..') || out.includes(norm)) return;
    out.push(norm);
  };
  const s = String(p).replace(/\\/g, '/');
  const projectName = path.basename(projectDir);
  // 2) 相对仓库根：砍掉开头的 `<…>/<剧名>/` 前缀
  if (!/^[A-Za-z]:[\\/]|^\//.test(s)) {
    const marker = `/${projectName}/`;
    const at = s.lastIndexOf(marker);
    if (s.startsWith(`${projectName}/`)) push(s.slice(projectName.length + 1));
    else if (at >= 0) push(s.slice(at + marker.length));
  }
  // 1) 剧目内相对 → 原样；绝对在剧目内 → 转相对；绝对在剧目外 → null
  push(relInside(projectDir, p));
  // 3) 兜底：末级目录名/文件名（老项目把产物随项目一起搬过的情况）
  push(`${path.basename(path.dirname(s))}/${path.basename(s)}`);
  return out;
}

/**
 * 读一个单元的视频片段路径（units/<id>.result.json 的 files[].local_path）。
 * 多条时优先**项目内是否存在**（result.json 同时记着 ComfyUI 原始路径与项目内路径）。
 *
 * 迁移坑（2026-09-22 实测）：老项目的 result.json 里 local_path 是**当时所在盘**
 * 的绝对路径（E:\…），项目搬进仓库后它落在项目外 —— 但产物实体已随项目一起搬。
 * 第二种坑（2026-09-23 实测）：路径是**相对仓库根**的（`projects/<剧>/units/…`），
 * 而 `relInside` 对相对路径原样返回、不检查是否真在剧目内，于是前端拼出双层前缀 404。
 * 两种坑都由 `candidateRels` + **存在性校验**兜住：拿到候选逐个试，存在才算数。
 * @returns {string|null} 剧目内相对路径。
 */
function clipOf(projectDir, unitId) {
  const result = readJson(path.join(projectDir, 'units', `${unitId}.result.json`));
  for (const f of (result?.files) || []) {
    const p = typeof f === 'string' ? f : (f?.local_path || f?.localPath || f?.path);
    if (!p || !isVideoPath(p)) continue;
    for (const rel of candidateRels(projectDir, p)) {
      if (fs.existsSync(path.join(projectDir, rel))) return rel;
    }
  }
  return null;                     // 所有候选都不存在才按缺处理
}

/**
 * 单元的**关键帧提示词**。
 *
 * 正主是 `keyframe-prompts/<unit>.txt`（2026-09-21 起的 LLM 直写制：`cli/keyframes.mjs`
 * 逐字把它送进模型，工程拼装链已废）。老剧目走的是工程通道，提示词落在
 * `keyframes_<通道>/raw/<unit>/_request/prompt.txt`，目录名不固定，所以扫一遍
 * `keyframes*` 目录兜底 —— 只是**看**，不参与生成。
 * @returns {string|null}
 */
export function keyframePromptOf(dir, unitId) {
  const own = trimOrNull(readText(path.join(dir, 'keyframe-prompts', `${unitId}.txt`)));
  if (own) return own;
  let dirs = [];
  try {
    dirs = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('keyframes'))
      .map((e) => e.name)
      .sort();
  } catch {
    return null;
  }
  for (const d of dirs) {
    const p = trimOrNull(readText(path.join(dir, d, 'raw', unitId, '_request', 'prompt.txt')));
    if (p) return p;
  }
  return null;
}

/**
 * 单元的**视频提示词**：`cli/unit.mjs` 写 `units/.<unit>.prompt.txt`
 * （点开头，与出片产物区分）。个别老剧目写成了不带点的同名文件，兜一层。
 * @returns {string|null}
 */
export function videoPromptOf(dir, unitId) {
  return trimOrNull(readText(path.join(dir, 'units', `.${unitId}.prompt.txt`)))
    ?? trimOrNull(readText(path.join(dir, 'units', `${unitId}.prompt.txt`)));
}

/**
 * 场景图 / 角色图的**生成提示词**：`asset-design.json` 的 `designs[].prompt`。
 * 只收带提示词的条目 —— 老文件里没写 prompt 的设计不占位。
 * @returns {Array<{id:string,kind:string,label:string,text:string}>}
 */
export function assetPromptsOf(dir, board = {}) {
  const design = readJson(path.join(dir, 'asset-design.json'));
  const out = [];
  for (const d of design?.designs || []) {
    const text = trimOrNull(d?.prompt);
    if (!text) continue;
    const id = d.scene_id || d.character_id || d.prop_id || '';
    const scene = (board.scenes || []).find((s) => s.id === d.scene_id);
    const character = (board.characters || []).find((c) => c.id === d.character_id);
    const label = scene?.name || character?.name || id || d.kind || '设计';
    out.push({ id, kind: d.kind || 'design', label, text });
  }
  return out;
}

/**
 * 读一个剧目的完整快照（看板一屏要的全部数据，一次给齐）。
 * 任何单文件缺失都不抛 —— 缺的字段置 null / 空数组，界面按「—」画。
 *
 * @param {string} root 剧目根
 * @param {string} name 剧目目录名（调用方负责校验：单一层路径段）
 * @returns {{error:string}|object} 出错给 {error}，成功给快照。
 */
export function loadProject(root, name) {
  const dir = path.join(root, name);
  const board = readJson(path.join(dir, 'board.json'));
  if (!board) return { error: `读不到 ${name}/board.json` };

  const meta = board.meta || {};
  const storyFile = path.join(dir, 'story.md');
  let story = fs.existsSync(storyFile) ? fs.readFileSync(storyFile, 'utf8') : null;
  if (story === null && typeof board.story?.source === 'string') story = board.story.source;

  const direction = readJson(path.join(dir, 'board.direction.json'));
  const plan = readJson(path.join(dir, 'render.plan.json'));
  const tickets = readJson(path.join(dir, 'review.approvals.json'));

  const dirUnits = (direction?.units) || [];
  const planUnits = (plan?.units) || [];

  /** 这个单元是不是"要参考上一段实际尾帧"的连续性单元。 */
  const isHandoffUnit = (u) => ['reference_previous', 'continue_previous'].includes(u?.continuity?.mode);
  /** 尾帧的约定落点（与实际路径一致：`handoffs/<单元>.stable-tail.png`）。 */
  const HANDOFF_FRAME_OF = (unitId) => `handoffs/${unitId}.stable-tail.png`;

  // 可执行视图（④ 关键帧与视频）：**以生成计划为权威**，与 dsh-storyboard 的
  // readArtifactIndex 同规则 —— 关键帧/片段/时长都在计划与 result.json 里，
  // 板子和导演稿不回填。没有计划时退回导演稿（那时没有关键帧/片段可索引）。
  const units = (planUnits.length ? planUnits : dirUnits).map((u) => ({
    id: u.id,
    shotCount: (u.shots || []).length,
    contentDuration: u.content_duration_s ?? null,
    generationDuration: u.generation_duration_s ?? null,
    scene: u.scene || '',
    cast: Array.isArray(u.cast) ? u.cast : [],
    audienceKnows: u.audience_knows || '',
    why: u.why || '',
    // 计划里的 `units[].keyframe` 是**编译期就写死的路径**，关键帧生成前它必然不存在。
    // 不查存在性就会给一个不存在的文件渲染 <img>（裂图 + alt 文本漏到页面上，
    // desk_quake 2026-09-22 实测）。视频那一路（clipOf）一直是查的，这里对齐。
    keyframe: u.keyframe && fs.existsSync(path.join(dir, u.keyframe)) ? relInside(dir, u.keyframe) : null,
    clip: clipOf(dir, u.id),
    // 连续性单元的**实际稳定尾帧**（`prepare-handoff` 提出来的那张）。
    // 同样只在文件真的存在时给路径 —— 没提出来就保持 null，由前端说一句"还没提"，
    // 而不是渲染一个 404 的 <img>。用户 2026-09-23 问「这种图是不是也可以回显」，这就是那一路。
    handoffFrame: isHandoffUnit(u) && fs.existsSync(path.join(dir, HANDOFF_FRAME_OF(u.id)))
      ? HANDOFF_FRAME_OF(u.id)
      : null,
    keyframePrompt: keyframePromptOf(dir, u.id),
    videoPrompt: videoPromptOf(dir, u.id),
  }));

  // 导演单元：**行号就地解成台词正文**（导演稿的 lines 只有行号，原文在剧本里）。
  // 前端不重复实现这套规则 —— 解行号只有一个所有者，就是这个函数。
  const resolveShot = (s) => ({
    n: s.n ?? null,
    at: s.at ?? null,
    duration_s: s.duration_s ?? null,
    framing: s.framing || '',
    camera: s.camera || '',
    scene: s.scene || '',
    action: s.action || '',
    lighting: s.lighting || '',
    audio: typeof s.audio === 'string' ? s.audio : '',
    cut: s.cut || '',
    emotion_analysis: Array.isArray(s.emotion_analysis) ? s.emotion_analysis : [],
    lines: (Array.isArray(s.lines) ? s.lines : []).map((no) => ({ n: no, text: lineTextOf(story, no) })),
  });
  const directionUnits = dirUnits.map((u) => ({
    id: u.id,
    keyframe_start: u.keyframe_start || '',
    why: u.why || '',
    duration_reason: u.duration_reason || '',
    audience_knows: u.audience_knows || '',
    shots: (u.shots || []).map(resolveShot),
  }));

  // 资产清单（tab 归属与面板一致：资源阶段的归 ③ 资源，生成阶段的归 ④）
  const assets = [];
  const charName = {};
  for (const c of board.characters || []) charName[c.id] = c.name || c.id;
  for (const c of board.characters || []) {
    if (c.portrait) assets.push({ key: `portrait:${c.id}`, tab: 1, group: '肖像', label: charName[c.id], path: relInside(dir, c.portrait) });
  }
  for (const x of board.identities || []) {
    if (x.sheet) {
      const who = charName[x.character] || x.character;
      const look = x.name && x.name !== '默认造型' ? `·${x.name}` : '';
      assets.push({ key: `sheet:${x.id}`, tab: 1, group: '身份图', label: who + look, path: relInside(dir, x.sheet) });
    }
  }
  for (const s of board.scenes || []) {
    if (s.master) assets.push({ key: `scene:${s.id}`, tab: 1, group: '场景', label: s.name || s.id, path: relInside(dir, s.master) });
    if (s.reverse_master) assets.push({ key: `rev:${s.id}`, tab: 1, group: '反向', label: `${s.name || s.id}·反向`, path: relInside(dir, s.reverse_master) });
    if (s.spatial_layout) assets.push({ key: `lay:${s.id}`, tab: 1, group: '平面', label: `${s.name || s.id}·平面`, path: relInside(dir, s.spatial_layout) });
  }
  for (const p of board.props || []) {
    if (p.ref_image) assets.push({ key: `prop:${p.id}`, tab: 1, group: '道具', label: p.name || p.id, path: relInside(dir, p.ref_image) });
  }
  for (const u of units) {
    if (u.keyframe) assets.push({ key: `kf:${u.id}`, tab: 2, group: '关键帧', label: u.id, path: u.keyframe });
    if (u.clip) assets.push({ key: `clip:${u.id}`, tab: 2, group: '视频片段', label: u.id, path: u.clip });
  }
  const finalRel = fs.existsSync(path.join(dir, 'out', 'final.mp4')) ? 'out/final.mp4' : null;
  if (finalRel) assets.push({ key: 'final', tab: 2, group: '成片', label: 'final.mp4', path: finalRel });

  return {
    name,
    title: String(meta.title || '').trim() || name,
    logline: meta.logline || '',
    style: meta.style || '',
    aspect: meta.aspect || '',
    board,
    story,
    direction,
    plan,
    tickets,
    units,
    directionUnits,
    assetPrompts: assetPromptsOf(dir, board),
    gates: gateSummary(tickets, units.map((u) => u.id)),
    assets,
    finalRel,
    files: {
      'story.md': story !== null,
      'board.direction.json': direction !== null,
      'render.plan.json': plan !== null,
      'review.approvals.json': tickets !== null,
    },
  };
}

/**
 * 剧本行号 → 台词正文（导演稿只有行号，原文从这里逐字搬）。
 * 行形如「苏晚（吃痛，瞪眼）：你有病啊！」—— 去「说话人（提示）：」前缀。
 */
export function lineTextOf(storyText, lineNo) {
  const raw = String(storyText || '').split(/\r?\n/)[Number(lineNo) - 1];
  if (raw === undefined) return null;
  const m = String(raw).match(/^[^：:]{1,12}(?:[（(][^）)]*[）)])?\s*[:：]\s*(.+)$/);
  return (m ? m[1] : String(raw)).trim();
}
