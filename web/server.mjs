#!/usr/bin/env node
/**
 * server.mjs — 独立看板服务：剧目 → 分镜确认表，不依赖 DSH。
 *
 * 背景（2026-09-22）：看板原来寄居在 DSH 的 dsh-storyboard 插件里，看个剧目
 * 还得先起 DSH。本服务用 Node 内建 http 起，零第三方依赖，读 `projects/`
 * 下的剧目目录，页面是 `web/index.html`（原生 JS，无构建）。
 *
 * ## 只读红线
 *
 * 本服务**只读**。人工票（review.approvals.json）仍由 `cli/review-gate.mjs`
 * 在用户明确说「通过」之后落笔 —— 看板是给人看产物、对状态的地方，
 * 不代签任何票。
 *
 * 用法：
 *   node web/server.mjs [--root <剧目根>] [--port <端口>]
 *   环境变量：AIH_PROJECTS_ROOT / AIH_KANBAN_PORT 同名覆盖
 *
 * 路由：
 *   GET /                        看板页面
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
 * @returns {Promise<{server:import('node:http').Server, port:number, root:string}>}
 */
export function startServer({ root, port = 0 } = {}) {
  const projectsRoot = root || process.env.AIH_PROJECTS_ROOT
    || path.join(PROJECT_ROOT, 'projects');
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      handle(req, res, projectsRoot).catch((error) => {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(String((error && error.message) || error));
      });
    });
    server.listen(port, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, root: projectsRoot });
    });
  });
}

async function handle(req, res, root) {
  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname;

  if (route === '/' || route === '/index.html') {
    return sendFile(res, path.join(HERE, 'index.html'));
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
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404');
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
  startServer({ root, port }).then(({ server, port: actual, root: usedRoot }) => {
    console.log(`看板已起：http://127.0.0.1:${actual}`);
    console.log(`剧目根：${usedRoot}`);
    console.log('Ctrl+C 停止。');
    server.on('close', () => process.exit(0));
  });
}
