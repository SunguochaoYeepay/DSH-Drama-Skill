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
 *   POST /api/regenerate          { name, unit, kind }        重出某个单元的产物（关键帧/视频）
 *   GET  /api/regenerate?id=x     重抽任务状态（轮询用）
 *   POST /api/prompt              { name, unit, kind, text }  写提示词（keyframe / clip 两种落点）
 *   POST /api/sign                { name, stage, unit? }       请 review-gate 落一张票
 *   GET  /media/<剧目>/<相对路径>  媒体文件（限剧目目录内，防目录穿越）
 *
 * ## 「签署」为什么不破坏"看板不代签"（2026-09-23）
 *
 * 原始契约是：`review.approvals.json` **只能**由 `cli/review-gate.mjs` 落笔。
 * 这条现在是这么守住的 —— 看板里**没有任何写 approvals 的代码路径**：
 * 「签署」按钮做的是把用户明确的「通过」**转交给唯一所有者执行**
 * （起 `cli/review-gate.mjs approve --project <剧目> --stage keyframes`，等它退出、原样回显结果）。
 * 票仍然是 review-gate 落的，人仍然是唯一的批准者；看板只是那个"点一下"。
 * 可签的阶段白名单目前只有 `keyframes`（用户当前动线需要的那一张），要放开再加。
 *
 * ## 「重出图片」为什么不算越界（2026-09-23）
 *
 * 用户改完 `keyframe-prompts/<单元>.txt` 后想在看板里直接重抽，不必回终端拼命令。
 * 这不是闸门动作：它**只产出新图**，一个字都不碰 `review.approvals.json`；
 * 图一变，那张关键帧票在 `review-gate status` 看来就失效了（票绑的是文件内容哈希），
 * 得由人重新签 —— 代签的口子仍然一个都没有。
 * 同时它是一条**执行动作**（要占 GPU、要写项目文件），所以：
 * - 只允许跑**当前这一个单元**（`--units <单元>`），不接受"跑全批"；
 * - 同一时刻只允许一个任务在跑，第二个请求回 409。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listProjects, loadProject, isValidProjectName } from '../src/board-data.mjs';
import {
  archiveProject, restoreProject, purgeProject, listArchived, runGc,
  titleOf, confirmMatches, archivedPath, RETENTION_DAYS,
} from '../src/archive.mjs';
import { PROJECT_ROOT } from '../src/config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 仓库根：CLI 与 .env 都在这里，子进程的 cwd 必须是它。 */
const REPO_ROOT = path.resolve(HERE, '..');

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
 * 重抽任务的命令行参数（**纯函数**，便于测试钉住：只跑一个单元、不碰别的）。
 * - 关键帧：`cli/keyframes.mjs <board.json> --direction <plan> --units <单元>`
 * - 视频片段：`cli/unit.mjs <board.json> --direction <plan> --unit <单元>`
 *   （单数 `--unit`，两个 CLI 的参数名不同，别抄错。）
 */
export function regenerateArgs(projectDir, unit, kind = 'keyframe') {
  const common = [
    path.join(projectDir, 'board.json'),
    '--direction', path.join(projectDir, 'render.plan.json'),
  ];
  return kind === 'clip' ? [...common, '--unit', unit] : [...common, '--units', unit];
}

/** 两种产物的 CLI 落点。 */
export function regenerateScript(kind = 'keyframe') {
  return path.join(REPO_ROOT, 'cli', kind === 'clip' ? 'unit.mjs' : 'keyframes.mjs');
}

/** 允许重抽的产物类型（白名单：它决定跑哪个脚本、写哪个文件）。 */
export const REGEN_KINDS = ['keyframe', 'clip'];

/** 单元 id 只允许字母数字下划线连字符 —— 它要进命令行，不做白名单就是命令注入。 */
export function isValidUnitId(unit) {
  return /^[A-Za-z0-9_-]{1,40}$/.test(String(unit || ''));
}

/** 看板可以从界面「签署」的阶段白名单（关键帧整批一张；片段票是每单元一张）。 */
export const SIGNABLE_STAGES = ['keyframes', 'clip'];

/** 提示词落点：**看板唯一会写的那两个文件**（都由产物类型决定，单元 id 已过白名单）。 */
export function promptPathFor(projectDir, unit, kind = 'keyframe') {
  return kind === 'clip'
    ? path.join(projectDir, 'units', `.${unit}.prompt.txt`)
    : path.join(projectDir, 'keyframe-prompts', `${unit}.txt`);
}

/** 提示词长度上限：CLI 的自检是 500 字，这里留够并给前端一个明确的天花板。 */
export const PROMPT_MAX_CHARS = 4000;

/** 重抽日志最多留这么多字符（够看清报错，又不至于把内存吃满）。 */
const REGEN_LOG_LIMIT = 8000;

/**
 * 起服务（可导入：测试用 port 0 拿临时端口）。
 * @param {{root?:string, port?:number, webDist?:string, gc?:boolean, trash?:Function, spawn?:Function}} [options]
 *   `gc:false` 关掉归档区定时清理；`trash` 注入回收站实现 —— 两者都是给测试用的，
 *   免得测试真往用户回收站里扔东西。
 *   `spawn` 注入子进程实现（默认 node:child_process.spawn）—— 测试用它避免真去调模型。
 * @returns {Promise<{server:import('node:http').Server, port:number, root:string, webDist:string}>}
 */
export function startServer({ root, port = 0, webDist, gc = true, trash, spawn: spawnImpl } = {}) {
  const projectsRoot = root || process.env.AIH_PROJECTS_ROOT
    || path.join(PROJECT_ROOT, 'projects');
  const dist = webDist || process.env.AIH_WEB_DIST || path.join(HERE, 'dist');
  // 重抽任务表：单机单人工具，同一时刻只允许一个在跑，历史也只在内存里留着看完为止
  const jobs = new Map();
  let runningJobId = null;
  let seq = 0;

  /** 起一次重抽（只跑这一个单元）。 */
  const startRegenerate = (name, unit, kind = 'keyframe') => {
    if (runningJobId) {
      return { status: 409, error: '已经有一个重抽在跑，等它结束再来', jobId: runningJobId };
    }
    const projectDir = path.join(projectsRoot, name);
    if (!fs.existsSync(path.join(projectDir, 'board.json'))) {
      return { status: 400, error: '这个剧目没有 board.json' };
    }
    const id = `regen-${Date.now()}-${++seq}`;
    const job = {
      id, name, unit, kind, state: 'running',
      startedAt: new Date().toISOString(), endedAt: null, exitCode: null, log: '',
    };
    jobs.set(id, job);
    runningJobId = id;

    const push = (buf) => {
      job.log = (job.log + buf.toString('utf8')).slice(-REGEN_LOG_LIMIT);
    };
    const finish = (state, exitCode) => {
      if (job.state !== 'running') return;
      job.state = state;
      job.exitCode = exitCode;
      job.endedAt = new Date().toISOString();
      if (runningJobId === id) runningJobId = null;
    };

    let child;
    try {
      child = (spawnImpl || spawn)(
        process.execPath,
        [regenerateScript(kind), ...regenerateArgs(projectDir, unit, kind)],
        { cwd: REPO_ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (e) {
      job.log = `[起进程失败] ${(e && e.message) || e}`;
      finish('failed', null);
      return { job };
    }
    child.stdout?.on('data', push);
    child.stderr?.on('data', push);
    child.on('error', (e) => {
      push(Buffer.from(`\n[进程错误] ${(e && e.message) || e}\n`));
      finish('failed', null);
    });
    child.on('close', (code) => finish(code === 0 ? 'done' : 'failed', code));
    return { job };
  };

  /** 任务状态（轮询用）：给 id 就查它，不给就查"正在跑的 / 最近一个"。 */
  const jobView = (id) => {
    const job = (id && jobs.get(id)) || (runningJobId && jobs.get(runningJobId)) || [...jobs.values()].pop();
    if (!job) return null;
    const end = job.endedAt ? Date.parse(job.endedAt) : Date.now();
    return {
      id: job.id, name: job.name, unit: job.unit, kind: job.kind, state: job.state,
      exitCode: job.exitCode, startedAt: job.startedAt, endedAt: job.endedAt,
      durationMs: Math.max(0, end - Date.parse(job.startedAt)),
      log: job.log,
    };
  };

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      handle(req, res, projectsRoot, dist, trash, {
        startRegenerate,
        jobView,
        reviewGatePath: path.join(REPO_ROOT, 'cli', 'review-gate.mjs'),
        spawnImpl,
      }).catch((error) => {
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

async function handle(req, res, root, webDist, trash, regen) {
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
    if (route === '/api/regenerate') {
      const view = regen.jobView(url.searchParams.get('id') || null);
      return view ? sendJson(res, view) : sendJson(res, { error: '没有重抽任务' }, 404);
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
    return handleAction(req, res, root, route, trash, regen);
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

/** 管理动作分发：归档 / 恢复 / 删除 / 重抽关键帧。删除必须过中文名校验才落手。 */
async function handleAction(req, res, root, route, trash, regen) {
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

  if (route === '/api/regenerate') {
    // 重出某个单元的产物（关键帧或视频片段）：改词 → 重抽这条动线，看板里点一下就够。
    // **不是签票**：只产出新文件，票一个字都不碰（产物变了票自然失效，要人重签）。
    const unit = String(body.unit ?? '');
    const kind = String(body.kind ?? 'keyframe');
    if (!isValidUnitId(unit)) return sendJson(res, { error: '非法单元 id' }, 400);
    if (!REGEN_KINDS.includes(kind)) return sendJson(res, { error: `产物类型只能是 ${REGEN_KINDS.join(' / ')}` }, 400);
    const r = regen.startRegenerate(name, unit, kind);
    if (r.error) return sendJson(res, { error: r.error, jobId: r.jobId }, r.status);
    return sendJson(res, { ok: true, jobId: r.job.id, unit, kind, name });
  }

  if (route === '/api/prompt') {
    // 写提示词：这是看板唯一会写**项目文件**的地方，而且只写这两个之一 ——
    // 关键帧 `keyframe-prompts/<单元>.txt`、视频 `units/.<单元>.prompt.txt`。
    // 直写制的文件就是送模型的那份原文，改它就是改下一份产物 —— 别的一个字不碰。
    const unit = String(body.unit ?? '');
    const kind = String(body.kind ?? 'keyframe');
    if (!isValidUnitId(unit)) return sendJson(res, { error: '非法单元 id' }, 400);
    if (!REGEN_KINDS.includes(kind)) return sendJson(res, { error: `产物类型只能是 ${REGEN_KINDS.join(' / ')}` }, 400);
    const text = typeof body.text === 'string' ? body.text : null;
    if (text === null) return sendJson(res, { error: 'text 必须是字符串' }, 400);
    if (text.length > PROMPT_MAX_CHARS) {
      return sendJson(res, { error: `提示词太长了（${text.length} 字，上限 ${PROMPT_MAX_CHARS}）` }, 400);
    }
    const projectDir = path.join(root, name);
    if (!fs.existsSync(projectDir)) return sendJson(res, { error: '剧目不存在' }, 404);
    const trimmed = text.trim();
    if (!trimmed) return sendJson(res, { error: '提示词不能是空的' }, 400);
    const file = promptPathFor(projectDir, unit, kind);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${trimmed}\n`, 'utf8');
    return sendJson(res, { ok: true, unit, kind, chars: trimmed.length });
  }

  if (route === '/api/sign') {
    // 签署：**转交给唯一所有者**（cli/review-gate.mjs）执行，看板自己不写 approvals 文件。
    const stage = String(body.stage ?? '');
    if (!SIGNABLE_STAGES.includes(stage)) {
      return sendJson(res, { error: `看板只能签这些阶段：${SIGNABLE_STAGES.join(' / ')}` }, 400);
    }
    const projectDir = path.join(root, name);
    if (!fs.existsSync(projectDir)) return sendJson(res, { error: '剧目不存在' }, 404);
    // 片段票是**每单元一张**，必须带 --id；关键帧票是整批一张，不带。
    const args = ['approve', '--project', projectDir, '--stage', stage];
    if (stage === 'clip') {
      const unit = String(body.unit ?? '');
      if (!isValidUnitId(unit)) return sendJson(res, { error: '签片段票要带上单元 id' }, 400);
      args.push('--id', unit);
    }
    args.push('--by', '用户（看板）');
    const r = await runOnce(regen.reviewGatePath, args, { spawnImpl: regen.spawnImpl });
    return r.code === 0
      ? sendJson(res, { ok: true, stage, output: r.output })
      : sendJson(res, { error: `签名失败（退出码 ${r.code}）`, output: r.output }, 400);
  }

  return sendJson(res, { error: '未知操作' }, 404);
}

/**
 * 跑一次短命令并等它结束（签署是读哈希 + 写一个 json，秒级）。
 * 超时兜底 30 秒 —— 卡住的话宁可报错也别把请求挂着。
 */
function runOnce(script, args, { spawnImpl, timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      resolve({ code, output: out.trim().slice(-4000) });
    };
    let child;
    try {
      child = (spawnImpl || spawn)(process.execPath, [script, ...args], {
        cwd: REPO_ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      return finish(null, String((e && e.message) || e));
    }
    const push = (b) => { out += b.toString('utf8'); };
    child.stdout?.on('data', push);
    child.stderr?.on('data', push);
    child.on('error', (e) => { push(`\n[进程错误] ${(e && e.message) || e}`); finish(null); });
    child.on('close', (code) => finish(code));
    const timer = setTimeout(() => {
      push('\n[超时] 30 秒没结束\n');
      try { child.kill(); } catch { /* 已经退了 */ }
      finish(null);
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
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

/** 媒体路由：解码 → 限制在剧目目录内 → 落盘读取。穿越企图直接 403。
 *
 * 视频必须支持 Range（206）：浏览器 <video> 加载元数据/拖进度条都发
 * `Range: bytes=…`，服务端只会回 200 全量时，部分 Chromium 媒体栈直接
 * 摆烂（进度条 0:00、播放键无响应）。所以这里按 RFC 7233 实现单区间。
 */
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
  const size = fs.statSync(file).size;
  const base = {
    'Content-Type': mimeOf(file),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  };

  const range = /^bytes=(\d*)-(\d*)$/.exec(String(res.req?.headers?.range || ''));
  if (!range || (!range[1] && !range[2])) {
    res.writeHead(200, { ...base, 'Content-Length': size });
    return fs.createReadStream(file).pipe(res);
  }

  // 单区间解析：bytes=a-b / bytes=a- / bytes=-suffix。start > size 是真越界；
  // start === size 的空区间按 416 回（Chromium 探测尾字节时会发这种）。
  let start, end;
  if (range[1] === '') {
    const suffix = Number(range[2]);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(range[1]);
    end = range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
  }
  if (start > end || start >= size) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    return res.end();
  }
  res.writeHead(206, {
    ...base,
    'Content-Range': `bytes ${start}-${end}/${size}`,
    'Content-Length': end - start + 1,
  });
  fs.createReadStream(file, { start, end }).pipe(res);
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
