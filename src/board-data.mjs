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
 * 剧目的创建时间：**board.json 的 mtime**，读不到退回目录 mtime，再退回 null。
 *
 * 为什么不能用目录的 birthtime/mtime（2026-09-22 实测踩过）：22 个剧目从 E 盘
 * 拷进仓库时，**目录是新建的**，全部 21 个目录的 birthtime 与 mtime 都被抹成
 * 拷贝那一刻（02:16），拿它排序等于乱排。而**文件**的 mtime 会被
 * `copyFileSync` 带过来（Windows 的 CopyFile 保留 LastWriteTime），所以
 * board.json 的时间是完好的 —— 这是唯一还活着的创建时间信号。
 *
 * 语义提醒：它是「板子最后一次写入」的时间，改板会让它前移。对找剧目来说
 * 这个语义比严格的立项时间更好用（最近动过的排在前面）。
 * @returns {string|null} ISO 字符串。
 */
function createdAtOf(dir) {
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
      createdAt: createdAtOf(path.join(root, e.name)),
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
 * 读一个单元的视频片段路径（units/<id>.result.json 的 files[].local_path）。
 * 多条时优先**项目内路径**（result.json 同时记着 ComfyUI 原始路径与项目内路径）。
 *
 * 迁移坑（2026-09-22 实测）：老项目的 result.json 里 local_path 是**当时所在盘**
 * 的绝对路径（E:\…），项目搬进仓库后它落在项目外 —— 但产物实体已随项目一起搬。
 * 所以项目外路径退回「末级目录名/文件名」在项目内找同名拷贝，找不到才算缺。
 * @returns {string|null} 剧目内相对路径。
 */
function clipOf(projectDir, unitId) {
  const result = readJson(path.join(projectDir, 'units', `${unitId}.result.json`));
  for (const f of (result?.files) || []) {
    const p = typeof f === 'string' ? f : (f?.local_path || f?.localPath || f?.path);
    if (!p || !isVideoPath(p)) continue;
    const rel = relInside(projectDir, p);
    if (rel) return rel;
    const tail = `${path.basename(path.dirname(p))}/${path.basename(p)}`;
    if (fs.existsSync(path.join(projectDir, tail))) return tail;
  }
  return null;                     // 两头都落空才按缺处理
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
    keyframe: u.keyframe ? relInside(dir, u.keyframe) : null,
    clip: clipOf(dir, u.id),
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
