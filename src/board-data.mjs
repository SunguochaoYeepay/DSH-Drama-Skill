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

/**
 * 列出剧目根下的剧目：读得出 board.json 的目录才算，空壳目录不进下拉
 * （与 dsh-storyboard 的判据一致：能读出板子 = 是剧目）。
 * @returns {Array<{name:string,title:string}>} 按目录名排序。
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
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const board = readJson(path.join(root, e.name, 'board.json'));
    if (!board) continue;
    out.push({ name: e.name, title: String(board.meta?.title || '').trim() || e.name });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
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
    keyframe: u.keyframe ? relInside(dir, u.keyframe) : null,
    clip: clipOf(dir, u.id),
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
