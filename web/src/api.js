/**
 * api.js — 与看板服务的数据契约（唯一的取数入口）。
 *
 * 服务端实现见 `web/server.mjs`，数据形态见 `src/board-data.mjs`。
 * 只读：这里没有任何写接口 —— 人工票永远由人走 `cli/review-gate.mjs` 落笔。
 */

/** 剧目清单：[{name, title}]。 */
export async function fetchProjects() {
  const r = await fetch('/api/projects');
  if (!r.ok) throw new Error(`剧目清单读取失败（HTTP ${r.status}）`);
  const j = await r.json();
  return j.projects || [];
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
