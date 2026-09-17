import path from 'node:path';

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

/** 视频/图像处理。质检做并排对照图时用得上。 */
export const FFMPEG = process.env.AIH_FFMPEG || 'ffmpeg';

/**
 * 百炼 CLI 的 **JS 入口** —— 注意**不是** `%APPDATA%\npm\bl.ps1`。
 *
 * `bl.ps1` 是 npm 生成的 PowerShell 包装器，而**本机 PowerShell 起不了外部进程**
 * （实测 `& 'node.exe' --version` 静默返回空、status 0）。走它 = 每个通道都"成功但没产出"。
 * 详见 `src/bailian-cli.mjs` 的说明。
 */
export const BAILIAN_ENTRY = process.env.AIH_BAILIAN_ENTRY
  || path.join(npmGlobal, 'node_modules', 'bailian-cli', 'dist', 'bailian.mjs');
