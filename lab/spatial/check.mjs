/**
 * 主体存在性审计：给任意一批图（我们的成片关键帧、任意目录）做"画里有没有人"的体检。
 *
 * 用途有两层：
 *   1. 立刻审计我们自己已交付的短片——有没有"漏人"这种最严重的空间失败；
 *   2. 将来接进主线时，同一段逻辑就是"主体缺失 → 挡回重抽"的核查项。
 *
 * 用法：
 *   node lab/spatial/check.mjs --image a.png --image b.png
 *   node lab/spatial/check.mjs --dir examples/demo-show/keyframes_local_v2
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runtimePaths, LAB_DIR, REPO_ROOT } from './lib/gen.mjs';

function argAll(name) {
  const out = [];
  process.argv.forEach((a, i) => {
    if (a === `--${name}`) out.push(process.argv[i + 1]);
  });
  return out.filter(Boolean);
}
function arg(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const IMAGES = argAll('image');
const DIRS = argAll('dir');
const PATTERN = String(arg('pattern', '*.png'));
const WEIGHTS = path.join(REPO_ROOT, '.tmp', 'spatial-lab', 'weights', 'yolo11n.pt');

const { requireComfyPython } = await runtimePaths();
const py = requireComfyPython();

const args = [path.join(LAB_DIR, 'py', 'presence.py')];
for (const i of IMAGES) args.push('--image', i);
for (const d of DIRS) args.push('--dir', d);
args.push('--pattern', PATTERN, '--weights', WEIGHTS, '--json');
if (!fs.existsSync(WEIGHTS)) args.push('--weights', 'yolo11n.pt');

const out = await new Promise((resolve, reject) => {
  const child = spawn(py, args, { cwd: REPO_ROOT, windowsHide: true });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d.toString()));
  child.stderr.on('data', (d) => (stderr += d.toString()));
  child.on('error', reject);
  child.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(`presence.py 退出码 ${code}\n${stderr.slice(-800)}`))));
});

const data = JSON.parse(out);
console.log(`检查 ${data.summary.checked} 张，检测器可用 ${data.summary.detector_ok} 张，出人率 ${(data.summary.present_rate * 100).toFixed(0)}%`);
if (data.summary.missing_subject.length) {
  console.log('\n没检出主体（最严重的空间失败，需人工确认是否真空场景）:');
  for (const m of data.summary.missing_subject) console.log('  - ' + m);
} else {
  console.log('\n没有发现"画面里没人"的图。');
}
console.log('\n明细：');
for (const r of data.results) {
  const n = r.n_person ?? '?';
  const h = r.largest ? r.largest.height_ratio : '—';
  console.log(`  ${r.present ? 'OK  ' : r.present === false ? 'MISS' : '??  '} n=${n} 最大主体高占比=${h}  ${path.relative(REPO_ROOT, r.image)}`);
}
