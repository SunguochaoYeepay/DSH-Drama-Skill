#!/usr/bin/env node
/**
 * wait-ready.mjs — **等 ComfyUI 真的ready，再提交。**
 *
 * ## 踩过的坑
 *
 * ComfyUI 的 HTTP 端口**先于节点注册**开放。启动过程是：
 *
 * ```
 * 22:50:09  开始加载 custom_nodes
 * 22:50:14  MiniMax H3 Director HTTP routes registered
 * 22:50:21  MiniMaxH3Director 加载完（0.0 秒）
 * 22:50:48  ComfyUI-Manager 还在拉 GitHub（跟我们就绪无关）
 * ```
 *
 * 我只看端口通就提交，结果 u3/u5 **0 秒就失败**，
 * 我还以为是"ComfyUI 又崩了"——**其实是它还在启动**。
 *
 * ## 怎么算就绪
 *
 * 轮询 `/object_info/MiniMaxH3Director`，能拿到节点定义才算 ready
 * （端口通 ≠ 节点可用）。顺便确认队列是空的。
 *
 * 用法：
 *   node tools/wait-ready.mjs [--timeout 180] [--quiet]
 *
 * 退出码：0 = 就绪；1 = 超时
 */

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true); };
const TIMEOUT = Number(flag('timeout', 180)) || 180;
const QUIET = argv.includes('--quiet');
const URL = String(flag('url', 'http://127.0.0.1:8188'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 4000);
  try {
    const r = await fetch(URL + path, { signal: ctl.signal });
    return r.ok ? await r.json() : null;
  } catch { return null; } finally { clearTimeout(t); }
}

const started = Date.now();
let lastNote = '';
for (;;) {
  const elapsed = (Date.now() - started) / 1000;

  // ① 端口 + 节点定义都在
  const info = await get('/object_info/MiniMaxH3Director');
  const nodeReady = Boolean(info && info.MiniMaxH3Director);
  if (nodeReady) {
    // ② 队列空（不要接着别人的活）
    const q = await get('/queue');
    const busy = q ? (q.queue_running || []).length + (q.queue_pending || []).length : 0;
    if (busy === 0) {
      if (!QUIET) console.log(`✓ ComfyUI 就绪（${elapsed.toFixed(1)}s）—— 节点已注册，队列空`);
      process.exit(0);
    }
    lastNote = `节点已就绪，但队列有 ${busy} 个任务在跑`;
  } else {
    lastNote = '节点还没注册（ComfyUI 仍在启动）';
  }

  if (elapsed > TIMEOUT) {
    console.error(`✗ 等了 ${TIMEOUT}s 还没就绪：${lastNote}`);
    console.error('  → 检查 ComfyUI 是不是还在启动，或者启动失败了');
    process.exit(1);
  }
  if (!QUIET) process.stderr.write(`\r  等待中 ${elapsed.toFixed(0)}s —— ${lastNote}          `);
  await sleep(2000);
}
