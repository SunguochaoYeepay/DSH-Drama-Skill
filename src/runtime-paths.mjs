import fs from 'node:fs';
import path from 'node:path';
import './config.mjs';

/** Runtime locations that vary by machine. Environment variables always win. */
export const WINGET_PACKAGES = process.env.AIH_WINGET_PACKAGES
  || path.join(process.env.LOCALAPPDATA || 'C:\\Users\\Administrator\\AppData\\Local', 'Microsoft', 'WinGet', 'Packages');

const userProfile = process.env.USERPROFILE || 'C:\\Users\\Administrator';
const npmGlobal = path.join(process.env.APPDATA || path.join(userProfile, 'AppData', 'Roaming'), 'npm');

export const COMFY_PYTHON = process.env.AIH_PYTHON
  || 'E:\\AI-Image\\ComfyUI-aki-v1.4\\python\\python.exe';
export const COMFY_GEN = process.env.AIH_GEN
  || path.join(userProfile, '.agents', 'skills', 'comfy-studio', 'scripts', 'gen.py');

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
 */
export const BAILIAN_ENTRY = process.env.AIH_BAILIAN_ENTRY
  || path.join(npmGlobal, 'node_modules', 'bailian-cli', 'dist', 'bailian.mjs');
