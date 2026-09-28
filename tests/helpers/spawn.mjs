/**
 * 测试里跑子进程（通常是 `node <某个 cli>`）的统一入口。
 *
 * ## 为什么不是各测试自己写 spawnSync
 *
 * 21 个测试文件、64 处调用点各自 `spawnSync(process.execPath, ..., { encoding: 'utf8' })`，
 * 其中 17 个在拿不到管道的环境里（实测：某些沙箱/受限终端创建 stdio 管道会 `EBUSY`）
 * **集体假红** —— 报的是 `null !== 0` 这种断言失败，看起来像回归，实际是"接不到输出"。
 * 排一次这种假红要花掉真回归该有的注意力，所以统一收口：
 *
 * 1. **先走管道**（正常环境的老路径，行为一字不变）；
 * 2. 管道起不来（`result.error`）→ **降级到临时文件重定向**再跑一次，照样拿得到 stdout/stderr；
 * 3. 两条路都不通 → `result.error` 保留，由 `skipIfUnavailable()` 明确跳过并打印原因，
 *    **绝不伪装成断言失败**。
 *
 * 判据始终是项目那条：「它守护的行为今天还在不在」。环境起不来 ≠ 行为不在，
 * 所以第三档是 skip + 原因，不是红。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

/**
 * 跑一次外部命令并拿回 stdout/stderr。
 * @param {string} command 可执行文件（node / ffmpeg / git / python…）
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, timeout?: number, maxBuffer?: number }} [opts]
 * @returns {{ status: number|null, stdout: string, stderr: string, error?: Error, via: 'pipe'|'file'|'none' }}
 */
export function runCommand(command, args, opts = {}) {
  const base = {
    cwd: opts.cwd || REPO_ROOT,
    windowsHide: true,
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.timeout ? { timeout: opts.timeout } : {}),
    ...(opts.maxBuffer ? { maxBuffer: opts.maxBuffer } : {}),
  };

  const piped = spawnSync(command, args, { ...base, encoding: 'utf8' });
  if (!piped.error) {
    return { status: piped.status, stdout: piped.stdout || '', stderr: piped.stderr || '', via: 'pipe' };
  }

  const viaFile = spawnCapturedToFile(command, args, base);
  if (!viaFile.error) return { ...viaFile, via: 'file' };

  return { status: null, stdout: '', stderr: '', error: piped.error, via: 'none' };
}

/**
 * 跑一次 `node <args...>`。
 * @param {string[]} args 传给 node 的参数（第一个通常是脚本绝对路径或 `-e`）
 */
export function runNode(args, opts = {}) {
  return runCommand(process.execPath, args, opts);
}

/** 管道不可用时：把子进程的 stdout/stderr 各写进一个临时文件，跑完读回来。 */
function spawnCapturedToFile(command, args, base) {
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-spawn-'));
    const outPath = path.join(dir, 'stdout.log');
    const errPath = path.join(dir, 'stderr.log');
    const outFd = fs.openSync(outPath, 'w');
    const errFd = fs.openSync(errPath, 'w');
    let result;
    try {
      result = spawnSync(command, args, { ...base, stdio: ['ignore', outFd, errFd] });
    } finally {
      fs.closeSync(outFd);
      fs.closeSync(errFd);
    }
    return {
      status: result.status,
      stdout: fs.readFileSync(outPath, 'utf8'),
      stderr: fs.readFileSync(errPath, 'utf8'),
      error: result.error,
    };
  } catch (error) {
    return { status: null, stdout: '', stderr: '', error };
  } finally {
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 临时目录清不掉不影响判据 */
      }
    }
  }
}

let pipesProbe;
/**
 * 本机能不能给子进程接管道（stdio: 'pipe'）。
 *
 * 有些受限终端/沙箱**连管道都建不起来**（实测：`EBUSY`），这时：
 * · 本 helper 靠临时文件降级照样能跑 CLI；
 * · 但**被测 CLI 自己**内部也会 spawn ffmpeg/ffprobe，它拿不到输出就一律报"没有音轨"之类，
 *   看起来像代码坏了。所以依赖"CLI 内部还要起子进程"的测试，先用这个探针判一次环境，
 *   不可用就跳过并写明原因 —— 不是把失败藏起来，是别把环境当回归。
 */
export function pipesAvailable() {
  if (pipesProbe === undefined) {
    const r = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8', windowsHide: true });
    pipesProbe = !r.error;
  }
  return pipesProbe;
}

/**
 * 环境真的起不了子进程时，明确跳过并说明原因（而不是让它红成断言失败）。
 * 用法：`if (skipIfUnavailable(t, result)) return;`
 * @returns {boolean} 已跳过则返回 true，调用方应直接 return
 */
export function skipIfUnavailable(t, result) {
  if (!result || !result.error) return false;
  const code = result.error.code || result.error.message;
  t.skip(`本机无法运行子进程（${code}）：这条断言在正常终端与 CI 里仍会执行`);
  return true;
}
