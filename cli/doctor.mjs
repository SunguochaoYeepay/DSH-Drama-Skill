#!/usr/bin/env node
/**
 * doctor.mjs — 依赖自检：一台新机器上"能不能跑"逐项报有/缺。
 *
 * 背景（2026-09-22 工程化收编）：工具已进仓（vendor/comfy-studio + 本地依赖
 * bailian-cli），但 ComfyUI 引擎、ffmpeg、Docker 仍是机器侧前置条件。
 * 收编的验收标准是"干净机器上文档 + 自检能把依赖备齐"，这个 CLI 就是那台仪器。
 *
 * 用法：
 *   node cli/doctor.mjs            人读表格
 *   node cli/doctor.mjs --json     机读 JSON（tests/doctor.test.mjs 断言用）
 *
 * 退出码：必需项全在 = 0；缺任何必需项 = 1。可选项（Docker）只警告不扣分。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { COMFY_PYTHON, COMFY_GEN, FFMPEG, BAILIAN_ENTRY } from '../src/runtime-paths.mjs';
import { PROJECT_ROOT } from '../src/config.mjs';

const JSON_MODE = process.argv.includes('--json');
const PROJECTS_ROOT = path.join(PROJECT_ROOT, 'projects');

/** 一个检查项。required=false 的缺了只警告（desub 这类可选路径的依赖）。 */
function check({ name, required = true, hint, test }) {
  let status, detail;
  try {
    const r = test();
    status = r.ok ? 'ok' : 'missing';
    detail = r.detail || '';
  } catch (error) {
    status = 'missing';
    detail = String((error && error.message) || error);
  }
  return { name, required, hint: hint || '', status, detail };
}

function fileExists(p) {
  return { ok: Boolean(p && fs.existsSync(p)), detail: p || '(空)' };
}

const checks = [
  check({
    name: 'Node 运行时',
    hint: '本 CLI 自身就在跑，这一项不会失败',
    test: () => ({ ok: true, detail: process.version }),
  }),
  check({
    name: '生图入口 gen.py（仓内 vendor）',
    hint: '仓内快照缺失：vendor/comfy-studio/ 下的 gen.py/graphs.py/routes.py 应随仓库一起在；或设 AIH_GEN',
    test: () => fileExists(COMFY_GEN),
  }),
  check({
    name: 'ComfyUI Python（引擎侧，不入仓）',
    hint: '装 ComfyUI 后设 AIH_PYTHON 指向其 python.exe',
    test: () => fileExists(COMFY_PYTHON),
  }),
  check({
    name: 'ffmpeg',
    hint: 'winget install Gyan.FFmpeg，或设 AIH_FFMPEG 指向 ffmpeg.exe',
    test: () => {
      // runtime-paths 找不到 winget 安装时回退裸命令名 —— 那样只能在部分终端碰巧可用，
      // 所以再实跑一次 `-version` 确认真身可用。
      if (FFMPEG !== 'ffmpeg') return fileExists(FFMPEG);
      const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
      return { ok: r.status === 0, detail: 'PATH 上的 ffmpeg' };
    },
  }),
  check({
    name: '百炼 CLI（本地依赖）',
    hint: 'npm install 后 node_modules 里应有；或 npm i -g bailian-cli；或设 AIH_BAILIAN_ENTRY',
    test: () => fileExists(BAILIAN_ENTRY),
  }),
  check({
    name: 'Docker（可选项：desub 去字幕）',
    required: false,
    hint: '只有跑 cli/desub.mjs 才需要；docker desktop 起着即可',
    test: () => {
      const r = spawnSync('docker', ['--version'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
      return { ok: r.status === 0, detail: (r.stdout || '').trim().split('\n')[0] || 'docker' };
    },
  }),
  check({
    name: '剧目目录 projects/',
    hint: '没有也能跑流水线（新机器从零开剧），只是没有现成剧目可看',
    required: false,
    test: () => {
      if (!fs.existsSync(PROJECTS_ROOT)) return { ok: false, detail: '不存在（新机器正常）' };
      const dirs = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true })
        .filter((e) => e.isDirectory()).length;
      return { ok: true, detail: `${dirs} 个剧目目录` };
    },
  }),
];

const failed = checks.filter((c) => c.required && c.status !== 'ok');

if (JSON_MODE) {
  console.log(JSON.stringify({ ok: failed.length === 0, checks }, null, 2));
} else {
  for (const c of checks) {
    const mark = c.status === 'ok' ? '✓' : c.required ? '✗' : '⚠';
    console.log(`${mark} ${c.name.padEnd(28)} ${c.detail}`);
    if (c.status !== 'ok') console.log(`  ${c.required ? '必需，' : '可选，'}${c.hint}`);
  }
  console.log('');
  if (failed.length === 0) {
    console.log('必需依赖全就位。' + (checks.some((c) => !c.required && c.status !== 'ok') ? '（有可选项缺失，只影响对应功能）' : ''));
  } else {
    console.log(`缺 ${failed.length} 项必需依赖，按上面的提示补齐后重跑。`);
  }
}
process.exit(failed.length === 0 ? 0 : 1);
