/**
 * api.js — 与看板服务的数据契约（唯一的取数入口）。
 *
 * 服务端实现见 `web/server.mjs`，数据形态见 `src/board-data.mjs`。
 *
 * **人工票仍然是只读的**：这里没有任何签票接口 —— 票永远由人走
 * `cli/review-gate.mjs` 落笔。这里的写接口只有**管理动作**（归档 / 恢复 / 删除，
 * 2026-09-22 增加），删除还要过中文名校验。
 */

/** 剧目清单：[{name, title}]。 */
export async function fetchProjects() {
  const r = await fetch('/api/projects');
  if (!r.ok) throw new Error(`剧目清单读取失败（HTTP ${r.status}）`);
  const j = await r.json();
  return j.projects || [];
}

/** 归档清单：{archived:[{name,title,archivedAt,expiresAt,daysLeft,expired}], retentionDays}。 */
export async function fetchArchived() {
  const r = await fetch('/api/archived');
  if (!r.ok) throw new Error(`归档清单读取失败（HTTP ${r.status}）`);
  const j = await r.json();
  return { archived: j.archived || [], retentionDays: j.retentionDays ?? 7 };
}

/** 单剧目快照（含 units / assets / gates / directionUnits / 原始档案）。 */
export async function fetchProject(name) {
  const r = await fetch(`/api/project?name=${encodeURIComponent(name)}`);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || `剧目读取失败（HTTP ${r.status}）`);
  return j;
}

/** 剧目内媒体 → 可访问 URL（逐段编码，中文文件名不会掉）。 */
export function mediaUrl(project, rel) {
  const tail = String(rel || '').split('/').map(encodeURIComponent).join('/');
  return `/media/${encodeURIComponent(project)}/${tail}`;
}

/** 视频扩展名判据（与服务端 board-data.isVideoPath 同集）。 */
export function isVideo(p) {
  return /\.(mp4|m4v|webm|mov|mkv)$/i.test(String(p || ''));
}

/* ── 管理动作（归档 / 恢复 / 删除）─────────────────────────────────────────
 *
 * 每个写请求都带 `X-Kanban-Action` 头 —— 服务端的跨源防护第一道就认它：
 * 浏览器里任意页面想跨源发这个头会触发 CORS 预检，而服务端不回 CORS 头，
 * 于是被浏览器拦掉。少了这个头服务端直接 403。
 */

async function writeJson(route, body) {
  const r = await fetch(route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Kanban-Action': '1' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(j.error || `操作失败（HTTP ${r.status}）`);
    err.expected = j.expected;      // 删除校验失败时服务端回显的期望标题
    throw err;
  }
  return j;
}

/** 归档：主线 → 归档区（可恢复）。 */
export const archiveProject = (name) => writeJson('/api/archive', { name });

/** 恢复：归档区 → 主线。 */
export const restoreProject = (name) => writeJson('/api/restore', { name });

/**
 * 删除到系统回收站。`confirm` 必须与剧目**中文标题逐字相等**才执行 ——
 * 服务端还会再校验一次，前端这道只是别让你白点。
 */
export const deleteProject = (name, confirm, archived = false) =>
  writeJson('/api/delete', { name, confirm, archived });
