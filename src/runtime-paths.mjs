import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROJECT_ROOT } from './config.mjs';

/**
 * Runtime locations that vary by machine. Environment variables always win.
 *
 * ⚠ **纪律（2026-09-22）：这里不许出现任何本机绝对路径。**
 * 曾经把某台机器的用户目录和某块盘的 ComfyUI 安装路径写死在兜底里 ——
 * 别人 clone 下来它是在猜一台不存在的机器，而本机早就有 `.env` 覆盖了那些值
 * （兜底纯属冗余）。现在一律：**不猜，缺就是缺**。
 * 缺失判据由 `cli/doctor.mjs` 报，缺失后果由使用方自己喊清楚（见 requireComfyPython）。
 */

/** Winget 包目录：没有 LOCALAPPDATA（非 Windows）就是空串，扫描函数会兜住。 */
const localAppData = process.env.LOCALAPPDATA || '';
export const WINGET_PACKAGES = process.env.AIH_WINGET_PACKAGES
  || (localAppData ? path.join(localAppData, 'Microsoft', 'WinGet', 'Packages') : '');

const userProfile = process.env.USERPROFILE || os.homedir();
const npmGlobal = path.join(process.env.APPDATA || path.join(userProfile, 'AppData', 'Roaming'), 'npm');

/**
 * ComfyUI 的 python.exe —— **本机才知道在哪，工程不猜**。
 *
 * 没配 `AIH_PYTHON` 时是空串：不要拿它去 spawn（会得到莫名其妙的 ENOENT），
 * 走 {@link requireComfyPython} 拿值，缺了它会喊人话。
 */
export const COMFY_PYTHON = process.env.AIH_PYTHON || '';

/** 取 ComfyUI 的 python.exe；没配就抛出可操作的错误，而不是让 spawn 失败。 */
export function requireComfyPython() {
  if (!COMFY_PYTHON) {
    throw new Error(
      '还没配 ComfyUI 的 Python：请在仓库根 .env 里写 AIH_PYTHON=<你的 ComfyUI>/python/python.exe。\n'
      + '不确定就先跑 node cli/doctor.mjs 看体检结果。',
    );
  }
  return COMFY_PYTHON;
}
// 生图入口走**仓内快照**（2026-09-22 收编：别人 clone 仓库即可用，不再依赖
// `~/.agents/skills/comfy-studio/` 这台机器的私搭路径）。`AIH_GEN` 仍可覆盖。
// ⚠ 这是 vendored snapshot：上游 comfy-studio 改了 gen.py/graphs.py/routes.py，
// 这里的拷贝**不会自动跟**——要跟就得三个文件一起重拷并回归验证。
const VENDORED_GEN = path.join(PROJECT_ROOT, 'vendor', 'comfy-studio', 'gen.py');
export const COMFY_GEN = process.env.AIH_GEN || VENDORED_GEN;

/** 当前 Node 运行时。用它执行 CLI 入口，**不经过任何 shell**。 */
export const NODE = process.env.AIH_NODE || process.execPath;

/**
 * 视频/图像处理。
 *
 * 本机 ffmpeg 是 **winget 装的**，不在 PATH 里 —— 写死 `'ffmpeg'` 只在
 * 少数终端里碰巧能用。所以扫一遍 winget 目录找真身，找不到才退回 PATH。
 * 环境变量 `AIH_FFMPEG` 永远优先（想在别处换二进制时用）。
 */
export const FFMPEG = process.env.AIH_FFMPEG || resolveFfmpeg();

/** ffprobe 与 ffmpeg 同目录。 */
export const FFPROBE = process.env.AIH_FFPROBE
  || FFMPEG.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');

function resolveFfmpeg() {
  try {
    for (const dir of fs.readdirSync(WINGET_PACKAGES)) {
      if (!dir.startsWith('Gyan.FFmpeg_')) continue;
      const c = path.join(WINGET_PACKAGES, dir, 'ffmpeg-7.1.1-full_build', 'bin', 'ffmpeg.exe');
      if (fs.existsSync(c)) return c;
    }
  } catch { /* winget 目录不存在 → 退回 PATH */ }
  return 'ffmpeg';
}

/**
 * 百炼 CLI 的 **JS 入口** —— 注意**不是** `%APPDATA%\npm\bl.ps1`。
 *
 * `bl.ps1` 是 npm 生成的 PowerShell 包装器，而**本机 PowerShell 起不了外部进程**
 * （实测 `& 'node.exe' --version` 静默返回空、status 0）。走它 = 每个通道都"成功但没产出"。
 * 详见 `src/bailian-cli.mjs` 的说明。
 *
 * 2026-09-22 收编：默认用**仓内依赖**（`package.json` 的 `bailian-cli`，钉 1.26.0，
 * 与全局装过的同版本）；装了依赖它就在 `node_modules` 里，别人 clone + `npm install`
 * 即齐。找不到仓内那份才回退 npm 全局安装的位置。`AIH_BAILIAN_ENTRY` 永远最优先。
 */
const LOCAL_BAILIAN = path.join(PROJECT_ROOT, 'node_modules', 'bailian-cli', 'dist', 'bailian.mjs');
export const BAILIAN_ENTRY = process.env.AIH_BAILIAN_ENTRY
  || (fs.existsSync(LOCAL_BAILIAN) ? LOCAL_BAILIAN
    : path.join(npmGlobal, 'node_modules', 'bailian-cli', 'dist', 'bailian.mjs'));
