#!/usr/bin/env node
/**
 * server.mjs — 独立看板服务：剧目 → 链路画布，不依赖 DSH。
 *
 * 背景（2026-09-22）：看板原来寄居在 DSH 的 dsh-storyboard 插件里，看个剧目
 * 还得先起 DSH。本服务用 Node 内建 http 起，零第三方依赖；前端是
 * `web/`（Vite + React + React Flow）的构建产物，由本服务托管。
 *
 * ## 只读红线
 *
 * 本服务**只读**。人工票（review.approvals.json）仍由 `cli/review-gate.mjs`
 * 在用户明确说「通过」之后落笔 —— 看板是给人看产物、对状态的地方，
 * 不代签任何票。
 *
 * 用法：
 *   node web/server.mjs [--root <剧目根>] [--port <端口>] [--web-dist <前端产物目录>]
 *   环境变量：AIH_PROJECTS_ROOT / AIH_KANBAN_PORT / AIH_WEB_DIST 同名覆盖
 *
 * 路由：
 *   GET /                        看板前端（web/dist/index.html）
 *   GET /assets/*                前端静态资源
 *   GET /api/projects            剧目清单
 *   GET /api/project?name=x      单剧目快照（src/board-data.mjs 的 loadProject）
 *   GET /media/<剧目>/<相对路径>  媒体文件（限剧目目录内，防目录穿越）
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listProjects, loadProject } from '../src/board-data.mjs';
import { PROJECT_ROOT } from '../src/config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

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
 * @param {{root?:string, port?:number, webDist?:string}} [options]
 * @returns {Promise<{server:import('node:http').Server, port:number, root:string, webDist:string}>}
 */
export function startServer({ root, port = 0, webDist } = {}) {
  const projectsRoot = root || process.env.AIH_PROJECTS_ROOT
    || path.join(PROJECT_ROOT, 'projects');
  const dist = webDist || process.env.AIH_WEB_DIST || path.join(HERE, 'dist');
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      handle(req, res, projectsRoot, dist).catch((error) => {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(String((error && error.message) || error));
      });
    });
    server.listen(port, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, root: projectsRoot, webDist: dist });
    });
  });
}

async function handle(req, res, root, webDist) {
  const url = new URL(req.url, 'http://localhost');
  let route = url.pathname;
  try {
    route = decodeURIComponent(route);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('路径编码非法');
  }

  if (route === '/api/projects') {
    return sendJson(res, { projects: listProjects(root) });
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
  return sendWeb(res, webDist, route);
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

/** 剧目名必须是单层路径段 —— `..`、盘符、分隔符都拒。 */
function isValidProjectName(name) {
  return /^[^\\/]+$/i.test(name) && !name.includes('..') && !/^[A-Za-z]:/.test(name);
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
