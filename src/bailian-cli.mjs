/**
 * bailian-cli.mjs — 百炼 CLI（`bl image` / `bl speech` / `bl vision`）的**唯一调用者**。
 *
 * ## 为什么不用 `bl.ps1`
 *
 * npm 在 `%APPDATA%\npm\bl.ps1` 放了个 PowerShell 包装器，原来三个通道都走它。
 * **但本机 PowerShell 无法启动外部进程** —— 实测：
 *
 * ```
 * powershell -Command "Write-Output HELLO"          → ✅ HELLO
 * powershell -Command "& 'node.exe' --version"      → ❌ 静默，stdout 空，status 0
 * ```
 *
 * 于是每个走 PS 的通道都退化成**「exit 0 但什么都没产出」**——最难查的一类故障：
 * 没有报错、没有退出码、只是静默。资产、关键帧（百炼）、语音、质检全中招。
 *
 * ## 所以：直接 node 执行 CLI 入口，参数用数组传
 *
 *   node <...>/node_modules/bailian-cli/dist/bailian.mjs image edit --prompt "……"
 *
 * 三个好处，都不是顺带的：
 *   1. **不经过 PowerShell，也不经过任何 shell** —— 沙箱限制、`-File` 转发、编码，全都绕开了；
 *   2. 顺带治好「PS 5.1 吃双引号」——提示词再也不用先写临时文件、不用把 `"` 换成全角；
 *   3. argv 逐项直传，提示词里有多少换行、引号、全角标点都不怕。
 */

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { BAILIAN_ENTRY, NODE } from './runtime-paths.mjs';

/**
 * 就位检查。入口不在就**当面说清楚**，不要让它表现成"静默无产出"。
 * 单行中文错误，由 `installCliErrorHandler()` 统一兜住。
 */
export function assertBailianCli() {
  if (!fs.existsSync(BAILIAN_ENTRY)) {
    throw new Error(`找不到百炼 CLI 入口：${BAILIAN_ENTRY}（装：npm i -g bailian-cli；或设 AIH_BAILIAN_ENTRY 指到 dist/bailian.mjs）`);
  }
}

/**
 * 跑一次百炼 CLI。
 *
 * @param {string[]} args 逐项参数，**不拼命令行**（如 `['image','edit','--prompt','……']`）
 * @returns {{status:number|null, stdout:string, stderr:string, error:any, argv:string[]}}
 *          `argv` 原样带回：调用方要留档（如关键帧的 `_request/`）时直接写盘。
 */
export function runBailian(args, { timeoutMs = 600000 } = {}) {
  assertBailianCli();
  const argv = [NODE, BAILIAN_ENTRY, ...args];
  const r = spawnSync(argv[0], argv.slice(1), {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error, argv };
}
