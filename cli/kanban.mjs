#!/usr/bin/env node
/**
 * kanban.mjs — 看板的一键启动器：**已在跑就不重复起、起完自动开浏览器**。
 *
 * 为什么需要它：`npm run kanban` 是**前台**进程（关掉终端就没了），用户要的是
 * "下次我自己启动、双击一下就能看"（2026-09-23 用户要启动脚本）。
 *
 * 行为（每一步都先判断，不猜）：
 *   1. 端口已被**本项目的看板**占着 → 直接开浏览器，不重复起第二个进程；
 *   2. 端口被**别的程序**占着 → 明确拒绝并让人换端口（`--port`），而不是撞上去报 EADDRINUSE；
 *   3. 否则后台起 `web/server.mjs`，日志写 `web/kanban.log`、PID 写 `web/kanban.pid`，
 *      **轮询到真的就绪**（默认 20 秒）再开浏览器；起不来就打印日志尾部；
 *   4. `--stop` 结束上次由本启动器起的那个进程。
 *
 * 用法：
 *   node cli/kanban.mjs [--port 8787] [--no-open] [--stop] [--foreground]
 *
 * 注：`--foreground` 在当前窗口跑服务（调试用，Ctrl+C 停）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PORT = 8787;
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
export const LOG_FILE = path.join(ROOT, 'web', 'kanban.log');
export const PID_FILE = path.join(ROOT, 'web', 'kanban.pid');

/** 端口取值顺序：`--port` > `AIH_KANBAN_PORT` > 8787。非法值直接抛，不静默兜底。 */
export function parsePort(argv = [], env = {}) {
  const at = argv.indexOf('--port');
  const raw = at >= 0 ? argv[at + 1] : env.AIH_KANBAN_PORT;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`端口不合法：${raw}`);
  return n;
}

/**
 * 探一次端口：是**我们的看板**、是**别的程序**、还是**没人**。
 *
 * 判据是内容不是端口 —— 端口被占不等于看板在跑（可能是别的开发服务）。
 * @returns {Promise<{up:boolean, kind:'kanban'|'other'|'down', status?:number}>}
 */
export async function probe(port, { timeoutMs = 1500 } = {}) {
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}/api/projects`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return { up: false, kind: 'down' };
  }
  try {
    const body = await res.json();
    if (Array.isArray(body?.projects)) return { up: true, kind: 'kanban', status: res.status };
  } catch { /* 不是 JSON —— 那就是别人的服务 */ }
  return { up: true, kind: 'other', status: res.status };
}

/** 轮询到「本项目看板」真的应答为止。 */
export async function waitReady(port, { timeoutMs = 20000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const p = await probe(port);
    if (p.up && p.kind === 'kanban') return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** 用系统默认浏览器打开。失败不影响主流程（服务本身已经起来了）。 */
export function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch { /* 打不开就算了，URL 已经打印出来了 */ }
}

function tailLog(lines = 12) {
  try {
    const text = fs.readFileSync(LOG_FILE, 'utf8').trimEnd().split(/\r?\n/);
    return text.slice(-lines).join('\n');
  } catch {
    return '（日志还没写出来）';
  }
}

function stopPrevious() {
  let pid = null;
  try {
    pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
  } catch { /* 没记录过 */ }
  if (!pid) {
    console.log('没有本启动器记下的 PID（可能是用 `npm run kanban` 前台起的，或已经被关掉了）。');
    return 1;
  }
  try {
    process.kill(pid, 'SIGTERM');
    fs.rmSync(PID_FILE, { force: true });
    console.log(`已结束看板进程 ${pid}。`);
    return 0;
  } catch {
    fs.rmSync(PID_FILE, { force: true });
    console.log(`进程 ${pid} 已经不在了（PID 记录已清掉）。`);
    return 0;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const port = parsePort(argv, process.env);
  const url = `http://127.0.0.1:${port}`;
  const open = !argv.includes('--no-open');

  if (argv.includes('--stop')) process.exit(stopPrevious());

  const before = await probe(port);
  if (before.up && before.kind === 'kanban') {
    console.log(`看板已经在跑：${url}`);
    if (open) openBrowser(url);
    return;
  }
  if (before.up) {
    console.error(`端口 ${port} 被别的程序占着（它回的不是本项目的 /api/projects）。`
      + `\n换一个端口：node cli/kanban.mjs --port 8788`);
    process.exit(1);
  }

  if (argv.includes('--foreground')) {
    const child = spawn(process.execPath, [path.join(HERE, '..', 'web', 'server.mjs'), '--port', String(port)], {
      cwd: ROOT, stdio: 'inherit',
    });
    child.on('exit', (code) => process.exit(code ?? 0));
    return;
  }

  const out = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [path.join(HERE, '..', 'web', 'server.mjs'), '--port', String(port)], {
    cwd: ROOT, detached: true, stdio: ['ignore', out, out],
  });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid), 'utf8');

  const ready = await waitReady(port);
  if (!ready) {
    console.error(`看板没能在 20 秒内就绪。日志：${LOG_FILE}\n--- 尾部 ---\n${tailLog()}`);
    process.exit(1);
  }
  console.log(`看板已起：${url}`);
  console.log(`日志：${LOG_FILE}　停止：node cli/kanban.mjs --stop`);
  if (open) openBrowser(url);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`启动失败：${(error && error.message) || error}`);
    process.exit(1);
  });
}
