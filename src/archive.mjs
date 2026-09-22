/**
 * archive.mjs — 剧目的归档 / 恢复 / 删除（进系统回收站）与归档区到期清理。
 *
 * 2026-09-22 新增（用户拍板：归档可恢复、删除要填中文名校验、归档满 7 天自动清）。
 *
 * ## 与「只读红线」的关系
 *
 * 看板曾立过「只读红线」：不代签人工票。**这条不变** —— 归档/删除是**管理动作**，
 * 是人对自己产物的处置；票（review.approvals.json）仍然只由 `cli/review-gate.mjs`
 * 在用户明确说「通过」之后落笔。两者不是一回事，别混。
 *
 * ## 三件事
 * - **归档**：`<root>/<name>/` → `<root>/_archive/<name>/`，落 `.archived.json` 记时间与标题。
 * - **恢复**：反向移动 + 删标记；主线已有同名剧目时**拒绝**（绝不覆盖）。
 * - **删除**：整目录移入 **Windows 系统回收站**（可还原）。
 *
 * ## 删除为什么不能信退出码（2026-09-22 实测）
 *
 * `FileSystem.DeleteDirectory(dir, ..., SendToRecycleBin)` 把目录移进回收站后，
 * 内部还会再访问一次该路径，此时文件已不在 → 抛 `FileNotFoundException`，
 * PowerShell 退出码 **1**。**但删除其实成功了**（回收站里按名搜得到）。
 * 所以成功判据只能是**状态验证**：「原目录消失」+「回收站同名条目数增加」，两条同时成立。
 * 只消失、回收站没涨 = 可能被永久删除 → 按**失败**报出并叫人去查，绝不静默。
 *
 * @see tests/archive.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isValidProjectName, ARCHIVE_DIRNAME } from './board-data.mjs';

// 归档区目录名在 board-data 定义（listProjects 要排除它）—— 这里 re-export，
// 调用方从一个地方取，避免两处各写一个 '_archive' 然后走散。
export { ARCHIVE_DIRNAME };

/** 归档保留天数：到期由 runGc 移入系统回收站。 */
export const RETENTION_DAYS = 7;
/** 归档标记文件名（落在归档目录内，跟着目录走，不会与目录状态脱节）。 */
export const MARKER = '.archived.json';
/** 自动清理流水账（在归档区内，`*.log` 已被 gitignore 挡住）。 */
export const GC_LOG = '_purged.log';

const DAY_MS = 24 * 60 * 60 * 1000;

// ── 小工具 ────────────────────────────────────────────────────────────────

function readJson(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function statMtime(dir) {
  try {
    return fs.statSync(dir).mtime;
  } catch {
    return null;
  }
}

/** 剧目中文标题（board.json 的 meta.title），读不到退回目录名。 */
export function titleOf(dir, fallbackName) {
  const board = readJson(path.join(dir, 'board.json'));
  const t = String(board?.meta?.title ?? '').trim();
  return t || String(fallbackName || path.basename(dir));
}

/**
 * 删除确认串是否通过：必须与剧目中文标题**逐字相等**（只忽略首尾空白）。
 *
 * 标题可能重名（实测 `no_chute` 与 `no_chute_v2` 都叫《没说完的那句》），
 * 所以确认串不是「唯一定位符」——定位靠「你点的是哪一个」，确认串只是
 * 「你确实知道自己在删什么」的凭证。界面上必须同时把目录名摊出来。
 */
export function confirmMatches(confirm, title) {
  return String(confirm ?? '').trim() === String(title ?? '').trim();
}

// ── 归档区路径 ────────────────────────────────────────────────────────────

export function archiveRoot(root) {
  return path.join(root, ARCHIVE_DIRNAME);
}

export function archivedPath(root, name) {
  return path.join(archiveRoot(root), name);
}

// ── 归档 / 恢复 ───────────────────────────────────────────────────────────

/**
 * 归档：`<root>/<name>` → `<root>/_archive/<name>`。
 * 归档区已有同名剧目时拒绝（避免覆盖一份别人的归档）。
 * @returns {{ok:true,name:string,title:string,archivedAt:string,warning?:string}|{ok:false,error:string}}
 */
export function archiveProject(root, name, { now = new Date() } = {}) {
  if (!isValidProjectName(name)) return { ok: false, error: '非法剧目名' };
  const src = path.join(root, name);
  const dst = archivedPath(root, name);
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
    return { ok: false, error: '剧目不存在' };
  }
  if (fs.existsSync(dst)) {
    return { ok: false, error: '归档区已有同名剧目，先恢复或删除它' };
  }
  const title = titleOf(src, name);
  try {
    fs.mkdirSync(archiveRoot(root), { recursive: true });
    fs.renameSync(src, dst);
  } catch (e) {
    return { ok: false, error: `移动失败：${e.message}` };
  }
  const archivedAt = now.toISOString();
  try {
    fs.writeFileSync(path.join(dst, MARKER),
      JSON.stringify({ archived_at: archivedAt, title, from: name }, null, 2) + '\n');
  } catch (e) {
    // 标记写不进去不是致命错：归档时间会退回目录 mtime，GC 照常工作
    return { ok: true, name, title, archivedAt, warning: `归档标记写入失败：${e.message}` };
  }
  return { ok: true, name, title, archivedAt };
}

/**
 * 恢复：`<root>/_archive/<name>` → `<root>/<name>`。
 * 主线已有同名剧目时**拒绝**（恢复绝不能覆盖在用的剧目）。
 */
export function restoreProject(root, name) {
  if (!isValidProjectName(name)) return { ok: false, error: '非法剧目名' };
  const src = archivedPath(root, name);
  const dst = path.join(root, name);
  if (!fs.existsSync(src)) return { ok: false, error: '归档区没有这个剧目' };
  if (fs.existsSync(dst)) return { ok: false, error: '主线已有同名剧目，恢复会覆盖 —— 拒绝' };
  try {
    fs.renameSync(src, dst);
  } catch (e) {
    return { ok: false, error: `移动失败：${e.message}` };
  }
  try {
    fs.rmSync(path.join(dst, MARKER), { force: true });
  } catch { /* 标记删不掉不影响剧目本身 */ }
  return { ok: true, name };
}

// ── 归档清单与到期判定 ────────────────────────────────────────────────────

/** 归档时间是否已满保留期（`>=`：正好 7 天即到期）。 */
export function isExpired(archivedAt, now, retentionDays = RETENTION_DAYS) {
  const t = parseDate(archivedAt);
  if (!t) return false;
  return now.getTime() - t.getTime() >= retentionDays * DAY_MS;
}

/**
 * 列出归档剧目。
 * 归档时间取 `.archived.json` 的 `archived_at`；标记缺失/损坏时**退回目录 mtime**，
 * 这样手工挪进归档区的目录也会被 GC 管到，不会永远赖着。
 * @returns {Array<{name,title,archivedAt,expiresAt,daysLeft,expired}>}
 */
export function listArchived(root, { now = new Date(), retentionDays = RETENTION_DAYS } = {}) {
  const dir = archiveRoot(root);
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;                       // 归档区还不存在 = 没有归档剧目
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    const marker = readJson(path.join(full, MARKER));
    const archivedAt = parseDate(marker?.archived_at) || statMtime(full);
    if (!archivedAt) continue;
    const expiresAt = new Date(archivedAt.getTime() + retentionDays * DAY_MS);
    const msLeft = expiresAt.getTime() - now.getTime();
    out.push({
      name: e.name,
      title: String(marker?.title ?? '').trim() || titleOf(full, e.name),
      archivedAt: archivedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      daysLeft: Math.max(0, Math.ceil(msLeft / DAY_MS)),
      expired: msLeft <= 0,
    });
  }
  return out.sort((a, b) => a.archivedAt.localeCompare(b.archivedAt));
}

// ── 删除：进系统回收站 ────────────────────────────────────────────────────

const PS = 'powershell.exe';

/** PowerShell 单引号字符串（内部单引号翻倍）。目录名可能带引号，必须转义。 */
function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function runPowerShell(script, timeout) {
  try {
    return spawnSync(PS, ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout, windowsHide: true });
  } catch (e) {
    return { status: -1, stdout: '', stderr: String(e.message), error: e };
  }
}

/**
 * 回收站里「显示名 === name」的条目数。
 * `Shell.Application` 的 `NameSpace(10)` 是回收站，`Item.Name` 是**原始文件名**
 * （不是 `$R…` 内部名）—— 实测确认。读不到返回 `-1`（调用方必须当成"不能验证"）。
 */
export function recycleBinCount(name) {
  const script = '$sh = New-Object -ComObject Shell.Application; '
    + '$rb = $sh.NameSpace(10); '
    + `if ($rb -eq $null) { Write-Output '-1' } `
    + `else { Write-Output (@($rb.Items() | Where-Object { $_.Name -eq ${psQuote(name)} }).Count) }`;
  const r = runPowerShell(script, 60000);
  const n = Number(String(r.stdout || '').trim());
  return Number.isFinite(n) ? n : -1;
}

/**
 * 把一个目录移入系统回收站，并用**状态验证**判成功（不看退出码）。
 *
 * `trash` 可注入：测试用假实现跑纯逻辑，不碰真回收站、不污染用户环境。
 * @returns {{ok:boolean, verified?:string, reason?:string}}
 */
export function sendDirToTrash(dir) {
  if (process.platform !== 'win32') {
    return { ok: false, reason: '只有 Windows 支持系统回收站' };
  }
  if (!fs.existsSync(dir)) return { ok: false, reason: '目录不存在' };
  const name = path.basename(dir);

  const before = recycleBinCount(name);
  if (before < 0) return { ok: false, reason: '读不到系统回收站（Shell.Application 不可用），不敢删' };

  const script = 'try { Add-Type -AssemblyName Microsoft.VisualBasic; '
    + `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(${psQuote(path.resolve(dir))},'OnlyErrorDialogs','SendToRecycleBin') `
    + '} catch { }';                  // 退出码不可信（见文件头），异常一律吞掉，只认状态
  runPowerShell(script, 300000);

  const gone = !fs.existsSync(dir);
  const after = recycleBinCount(name);
  if (gone && after > before) {
    return { ok: true, verified: `原目录消失，回收站同名条目 ${before} → ${after}` };
  }
  if (gone) {
    return { ok: false, reason: '目录消失了但回收站条目没增加 —— 可能被永久删除，请立刻检查回收站' };
  }
  return { ok: false, reason: '目录仍在，删除未生效' };
}

/**
 * 删除剧目：整目录进回收站。
 * @param {boolean} archived 删的是归档区里的（true）还是主线上的（false）
 */
export function purgeProject(root, name, { archived = false, trash = sendDirToTrash } = {}) {
  if (!isValidProjectName(name)) return { ok: false, error: '非法剧目名' };
  const dir = archived ? archivedPath(root, name) : path.join(root, name);
  if (!fs.existsSync(dir)) {
    return { ok: false, error: archived ? '归档区没有这个剧目' : '剧目不存在' };
  }
  const r = trash(dir);
  if (!r.ok) return { ok: false, error: r.reason || '删除失败' };
  return { ok: true, name, verified: r.verified || '' };
}

// ── 到期自动清理 ──────────────────────────────────────────────────────────

function appendGcLog(root, lines) {
  try {
    fs.mkdirSync(archiveRoot(root), { recursive: true });
    fs.appendFileSync(path.join(archiveRoot(root), GC_LOG), lines.join('\n') + '\n');
  } catch { /* 流水账写不进去不该影响清理本身 */ }
}

/**
 * 归档区到期清理：满 `retentionDays` 的归档剧目 → 系统回收站。
 * 每次跑都追加流水账（谁、什么时候、因为归档于何时被清掉），便于事后追。
 *
 * @returns {{purged:Array, failed:Array, retentionDays:number}}
 */
export function runGc(root, {
  now = new Date(), retentionDays = RETENTION_DAYS, trash = sendDirToTrash, log = true,
} = {}) {
  const purged = [];
  const failed = [];
  for (const item of listArchived(root, { now, retentionDays })) {
    if (!item.expired) continue;
    const r = trash(archivedPath(root, item.name));
    if (r.ok) purged.push({ name: item.name, title: item.title, archivedAt: item.archivedAt });
    else failed.push({ name: item.name, title: item.title, error: r.reason || '删除失败' });
  }
  if (log && (purged.length || failed.length)) {
    const stamp = now.toISOString();
    const lines = [
      `# ${stamp} 清理（归档满 ${retentionDays} 天）`,
      ...purged.map((p) => `${stamp}\tpurged\t${p.name}\t《${p.title}》\t归档于 ${p.archivedAt}`),
      ...failed.map((f) => `${stamp}\tFAILED\t${f.name}\t《${f.title}》\t${f.error}`),
    ];
    appendGcLog(root, lines);
  }
  return { purged, failed, retentionDays };
}
