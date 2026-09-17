import path from 'node:path';

/** Runtime locations that vary by machine. Environment variables always win. */
export const WINGET_PACKAGES = process.env.AIH_WINGET_PACKAGES
  || path.join(process.env.LOCALAPPDATA || 'C:\\Users\\Administrator\\AppData\\Local', 'Microsoft', 'WinGet', 'Packages');

const userProfile = process.env.USERPROFILE || 'C:\\Users\\Administrator';

export const COMFY_PYTHON = process.env.AIH_PYTHON
  || 'E:\\AI-Image\\ComfyUI-aki-v1.4\\python\\python.exe';
export const COMFY_GEN = process.env.AIH_GEN
  || path.join(userProfile, '.agents', 'skills', 'comfy-studio', 'scripts', 'gen.py');
export const POWERSHELL = process.env.AIH_POWERSHELL
  || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
export const BAILIAN_CLI = process.env.AIH_BAILIAN_CLI
  || path.join(process.env.APPDATA || path.join(userProfile, 'AppData', 'Roaming'), 'npm', 'bl.ps1');
