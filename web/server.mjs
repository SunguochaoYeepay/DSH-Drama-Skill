#!/usr/bin/env node
/**
 * server.mjs — 独立看板服务：剧目 → 链路画布，不依赖 DSH。
 *
 * 背景（2026-09-22）：看板原来寄居在 DSH 的 dsh-storyboard 插件里，看个剧目
 * 还得先起 DSH。本服务用 Node 内建 http 起，零第三方依赖；前端是
 * `web/`（Vite + React + React Flow）的构建产物，由本服务托管。
 *
 * ## 读写的边界
 *
 * **人工票仍然是只读的**：`review.approvals.json` 只能由 `cli/review-gate.mjs`
 * 在用户明确说「通过」之后落笔 —— 看板不代签任何票。
 *
 * 2026-09-22 起另外增加了**管理动作**（归档 / 恢复 / 删除），它们不是闸门动作：
 * - 归档 / 恢复：移动剧目目录，可逆；
 * - 删除：必须带 `confirm`（与剧目中文标题逐字相等）才执行，且只移入**系统回收站**。
 *
 * 写操作有两道跨源防护 —— 本地服务也不能让浏览器里随便一个页面删掉你的项目：
 * 1. 必须带自定义头 `X-Kanban-Action`：跨源带自定义头会触发 CORS 预检，而本服务
 *    不回任何 CORS 头，浏览器直接拦掉；同源的看板页面自己能带上。
 * 2. 带 `Origin` 时它必须与请求的 `Host` 同源。
 *
 * 用法：
 *   node web/server.mjs [--root <剧目根>] [--port <端口>] [--web-dist <前端产物目录>]
 *   环境变量：AIH_PROJECTS_ROOT / AIH_KANBAN_PORT / AIH_WEB_DIST 同名覆盖
 *
 * 路由：
 *   GET  /                        看板前端（web/dist/index.html）
 *   GET  /assets/*                前端静态资源
 *   GET  /api/projects            剧目清单
 *   GET  /api/project?name=x      单剧目快照（src/board-data.mjs 的 loadProject）
 *   GET  /api/archived            归档剧目清单（含剩余自动清理天数）
 *   POST /api/archive             { name }                     归档
 *   POST /api/restore             { name }                     恢复
 *   POST /api/delete              { name, confirm, archived? }  删除到系统回收站
 *   GET  /media/<剧目>/<相对路径>  媒体文件（限剧目目录内，防目录穿越）
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listProjects, loadProject, isValidProjectName } from '../src/board-data.mjs';
import {
  archiveProject, restoreProject, purgeProject, listArchived, runGc,
  titleOf, confirmMatches, archivedPath, RETENTION_DAYS,
} from '../src/archive.mjs';
import { PROJECT_ROOT } from '../src/config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 定时清理间隔：6 小时扫一次归档区。 */
const GC_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** MIME：按扩展名（img/video 播放依赖正确的 Content-Type）。 */
function mimeOf(p) {
  const ext = path.extname(p).toLowerCase().slice(1);
  const map = {
    html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
    js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
    json: 'application/json; charset=utf-8',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml',
    mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
    mp3: 'audio/mpeg', wav: 'audio/wav', md: 'text/plain; charset=utf-8',
  };
  return map[ext] || 'application/octet-stream';
}

/**
 * 起服务（可导入：测试用 port 0 拿临时端口）。
 * @param {{root?:string, port?:number, webDist?:string, gc?:boolean, trash?:Function}} [options]
 *   `gc:false` 关掉归档区定时清理；`trash` 注入回收站实现 —— 两者都是给测试用的，
 *   免得测试真往用户回收站里扔东西。
 * @returns {Promise<{server:import('node:http').Server, port:number, root:string, webDist:string}>}
 */
export function startServer({ root, port = 0, webDist, gc = true, trash } = {}) {
  const projectsRoot = root || process.env.AIH_PROJECTS_ROOT
    || path.join(PROJECT_ROOT, 'projects');
  const dist = webDist || process.env.AIH_WEB_DIST || path.join(HERE, 'dist');
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      handle(req, res, projectsRoot, dist, trash).catch((error) => {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(String((error && error.message) || error));
      });
    });
    const gcTimer = gc ? startArchiveGc(projectsRoot, trash) : null;
    server.on('close', () => { if (gcTimer) clearInterval(gcTimer); });
    server.listen(port, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, root: projectsRoot, webDist: dist });
    });
  });
}

/**
 * 归档区到期清理：启动先跑一次，之后每 6 小时一次。
 * 定时器 `unref` —— 别让它拖住进程退出。
 */
function startArchiveGc(root, trash) {
  const tick = () => {
    try {
      const r = runGc(root, trash ? { trash } : undefined);
      for (const p of r.purged) {
        console.log(`[清理] 归档满 ${r.retentionDays} 天 → 回收站：《${p.title}》（${p.name}）`);
      }
      for (const f of r.failed) {
        console.error(`[清理] 失败：《${f.title}》（${f.name}）—— ${f.error}`);
      }
    } catch (e) {
      console.error('[清理] 异常：', (e && e.message) || e);
    }
  };
  tick();
  const timer = setInterval(tick, GC_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

async function handle(req, res, root, webDist, trash) {
  const url = new URL(req.url, 'http://localhost');
  let route = url.pathname;
  try {
    route = decodeURIComponent(route);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('路径编码非法');
  }

  // ── 读接口 ────────────────────────────────────────────────────────────
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (route === '/api/projects') {
      return sendJson(res, { projects: listProjects(root) });
    }
    if (route === '/api/archived') {
      return sendJson(res, { archived: listArchived(root), retentionDays: RETENTION_DAYS });
    }
    if (route === '/api/project') {
      const name = url.searchParams.get('name') || '';
      if (!isValidProjectName(name)) return sendJson(res, { error: '非法剧目名' }, 400);
      const snapshot = loadProject(root, name);
      return sendJson(res, snapshot, snapshot.error ? 404 : 200);
    }
    if (route.startsWith('/media/')) {
      return sendMedia(res, root, route.slice('/media/'.length));
    }
    // 没匹配上的 /api/* 不落到 SPA 回退 —— 否则拼错的接口会回一坨 HTML 200，
    // 把错误盖得严严实实（写接口必须 POST，GET 访问明确报 405）。
    if (route.startsWith('/api/')) {
      return sendJson(res, { error: `未知接口 ${route}（写操作用 POST）` }, 405);
    }
    return sendWeb(res, webDist, route);
  }

  // ── 写接口（管理动作：归档 / 恢复 / 删除）──────────────────────────────
  if (route.startsWith('/api/')) {
    if (req.method === 'OPTIONS') {
      // 跨源预检：本服务不回任何 CORS 头 → 浏览器直接拦掉实际请求。
      // 显式 405 比落到 SPA 回退更清楚，省得 preflight 看起来"成功"。
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('405');
    }
    if (req.method !== 'POST') {
      return sendJson(res, { error: `不支持的方法 ${req.method}` }, 405);
    }
    return handleAction(req, res, root, route, trash);
  }

  return sendWeb(res, webDist, route);
}

/**
 * 写操作的跨源防护（文件头那两道防线）。
 * @returns {{ok:true}|{ok:false,status:number,error:string}}
 */
function writeGuard(req) {
  if (req.headers['x-kanban-action'] === undefined) {
    return { ok: false, status: 403, error: '缺少 X-Kanban-Action 头（跨源防护）' };
  }
  const origin = req.headers.origin;
  if (origin) {
    let host = null;
    try {
      host = new URL(origin).host;
    } catch { /* 畸形 Origin 按跨源拒 */ }
    if (host !== req.headers.host) {
      return { ok: false, status: 403, error: '拒绝跨源请求' };
    }
  }
  return { ok: true };
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/** 管理动作分发：归档 / 恢复 / 删除。删除必须过中文名校验才落手。 */
async function handleAction(req, res, root, route, trash) {
  const guard = writeGuard(req);
  if (!guard.ok) return sendJson(res, { error: guard.error }, guard.status);

  let body;
  try {
    body = JSON.parse((await readBody(req)) || '{}');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('不是对象');
  } catch {
    return sendJson(res, { error: '请求体不是合法 JSON 对象' }, 400);
  }

  const name = String(body.name ?? '');
  if (!isValidProjectName(name)) return sendJson(res, { error: '非法剧目名' }, 400);

  if (route === '/api/archive') {
    const r = archiveProject(root, name);
    return r.ok
      ? sendJson(res, { ok: true, name: r.name, title: r.title, archivedAt: r.archivedAt, warning: r.warning })
      : sendJson(res, { error: r.error }, 400);
  }

  if (route === '/api/restore') {
    const r = restoreProject(root, name);
    return r.ok
      ? sendJson(res, { ok: true, name })
      : sendJson(res, { error: r.error }, 400);
  }

  if (route === '/api/delete') {
    const archived = Boolean(body.archived);
    const dir = archived ? archivedPath(root, name) : path.join(root, name);
    if (!fs.existsSync(dir)) {
      return sendJson(res, { error: archived ? '归档区没有这个剧目' : '剧目不存在' }, 404);
    }
    const title = titleOf(dir, name);
    if (!confirmMatches(body.confirm, title)) {
      // 回显期望值：界面拿它显示「请输入：XXX」
      return sendJson(res, { error: '确认名不匹配', expected: title, name }, 400);
    }
    const r = purgeProject(root, name, { archived, trash });
    return r.ok
      ? sendJson(res, { ok: true, name, title, verified: r.verified })
      : sendJson(res, { error: r.error }, 500);
  }

  return sendJson(res, { error: '未知操作' }, 404);
}

/**
 * 托管前端产物。
 * - 命中 dist 内的真实文件 → 原样发；
 * - 其余路径（含 `/`）→ 回退 index.html（单页应用没有路由，回退是万能兜底）；
 * - dist 不存在（还没构建）→ 给一页构建引导，**不要白页**。
 */
function sendWeb(res, dist, route) {
  const base = path.resolve(dist);
  const index = path.join(base, 'index.html');
  const rel = String(route).replace(/^\/+/, '');
  if (rel) {
    const file = path.resolve(base, rel);
    if (file.startsWith(base + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      return sendFile(res, file);
    }
  }
  if (fs.existsSync(index)) return sendFile(res, index);
  return sendBuildHint(res, base);
}

function sendBuildHint(res, dist) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>看板前端尚未构建</title>
<style>body{margin:0;background:#0e1114;color:#e9eef3;font:14px/1.7 system-ui,"Microsoft YaHei",sans-serif;padding:48px}
code{background:#20262c;padding:2px 6px;border-radius:4px;font-family:ui-monospace,Consolas,monospace}
p{color:#a3aeb9;max-width:640px}h1{font-size:16px;font-weight:500}</style></head>
<body><h1>看板前端尚未构建</h1>
<p>服务是活的（API 与媒体都能用），但前端产物不在：<br><code>${escapeHtml(dist)}</code></p>
<p>在仓库根目录跑一次：</p>
<p><code>npm run web:setup</code>　# 安装依赖 + 构建</p>
<p>然后刷新本页。开发前端时用 <code>npm run web:dev</code>（5173，自动反代到本服务）。</p>
</body></html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function sendJson(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function sendFile(res, file) {
  let data;
  try {
    data = fs.readFileSync(file);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`读不到 ${path.basename(file)}`);
    return;
  }
  res.writeHead(200, { 'Content-Type': mimeOf(file) });
  res.end(data);
}

/** 媒体路由：解码 → 限制在剧目目录内 → 落盘读取。穿越企图直接 403。 */
function sendMedia(res, root, raw) {
  let rel;
  try {
    rel = decodeURIComponent(raw);
  } catch {
    return sendJson(res, { error: '路径编码非法' }, 400);
  }
  const name = rel.split('/')[0];
  const rest = rel.slice(name.length + 1);
  if (!isValidProjectName(name) || !rest) return sendJson(res, { error: '非法媒体路径' }, 403);
  const projectDir = path.resolve(root, name);
  const file = path.resolve(projectDir, rest);
  if (file !== projectDir && !file.startsWith(projectDir + path.sep)) {
    return sendJson(res, { error: '拒绝：路径越出剧目目录' }, 403);
  }
  if (!fs.existsSync(file)) return sendJson(res, { error: '文件不存在' }, 404);
  res.writeHead(200, {
    'Content-Type': mimeOf(file),
    'Content-Length': fs.statSync(file).size,
  });
  fs.createReadStream(file).pipe(res);
}

// ── 作为脚本直跑时才监听；被 import（测试）时不占端口 ──────────────────────
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const arg = (flag) => {
    const i = process.argv.indexOf(flag);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const port = Number(arg('--port') || process.env.AIH_KANBAN_PORT || 8787);
  const root = arg('--root');
  const webDist = arg('--web-dist');
  startServer({ root, port, webDist }).then(({ server, port: actual, root: usedRoot, webDist: usedDist }) => {
    console.log(`看板已起：http://127.0.0.1:${actual}`);
    console.log(`剧目根：${usedRoot}`);
    console.log(fs.existsSync(path.join(usedDist, 'index.html'))
      ? `前端产物：${usedDist}`
      : `前端产物：${usedDist} —— 还没构建，跑一次 \`npm run web:setup\``);
    console.log('Ctrl+C 停止。');
    server.on('close', () => process.exit(0));
  });
}
