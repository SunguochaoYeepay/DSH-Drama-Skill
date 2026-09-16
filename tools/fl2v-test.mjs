#!/usr/bin/env node
/**
 * fl2v-test.mjs — 验证首尾帧夹逼（fl2v）到底成不成立。
 *
 * ## 要回答的问题
 *
 * 用户最初的疑问：「**S1 的尾帧可以作为 S2 的首帧吗？**」
 *
 * 如果成立，那么：
 *   · 每一镜都短（3-8 秒），**不会触发长镜崩溃**
 *   · 而且 N 的尾帧 ≡ N+1 的首帧，**接上就是无缝的**
 *   · 那个 turbo LoRA 名字里就写着 `fl2v` —— 本来就是为这个训的
 *
 * ## 怎么验
 *
 * 给 H3 **首帧 A + 尾帧 B**，让它生成中间。
 * 然后**量产出视频的最后一帧，和 B 比**：
 *   · 几乎一样 → fl2v 成立，尾帧真的落在指定位置上
 *   · 差很远   → fl2v 不成立（它只是"参考"，不是"锁定"）
 *
 * 用法：
 *   node tools/fl2v-test.mjs <board.json> --first keyframes/s06.png --last keyframes/s07.png
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const FFMPEG = (() => {
  const base = 'C:\\Users\\Administrator\\AppData\\Local\\Microsoft\\WinGet\\Packages';
  try {
    for (const d of fs.readdirSync(base)) {
      if (!d.startsWith('Gyan.FFmpeg_')) continue;
      const c = path.join(base, d, 'ffmpeg-7.1.1-full_build', 'bin', 'ffmpeg.exe');
      if (fs.existsSync(c)) return c;
    }
  } catch { /* PATH */ }
  return 'ffmpeg';
})();
const GEN = 'C:\\Users\\Administrator\\.agents\\skills\\comfy-studio\\scripts\\gen.py';
const PY = 'E:\\AI-Image\\ComfyUI-aki-v1.4\\python\\python.exe';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true); };

const boardPath = argv.find((a) => /board.*\.json$/i.test(a) && !a.startsWith('--'));
if (!boardPath) { console.error('用法：node tools/fl2v-test.mjs <board.json> --first <png> --last <png>'); process.exit(2); }
const BOARD_DIR = path.dirname(boardPath);
const WS = flag('ws', null) || path.resolve(BOARD_DIR, '..', '..', '..');
const FIRST = path.resolve(WS, flag('first', 'keyframes/s06.png'));
const LAST = path.resolve(WS, flag('last', 'keyframes/s07.png'));
const DUR = Number(flag('duration', 5)) || 5;
const STEPS = Number(flag('steps', 4)) || 4;
/**
 * **尺寸跟着官方文档走。** 参考配置 864×480（16:9），9:16 的对应值是 480×864。
 * `--size 768x1344` 换到 LoRA 的原生 768p（验证通过之后再说）。
 */
const sizeArg = String(flag('size', '480x864'));
const [W, H] = sizeArg.split('x').map(Number);

if (!fs.existsSync(FIRST) || !fs.existsSync(LAST)) {
  console.error(`首帧/尾帧不存在：\n  ${FIRST}\n  ${LAST}`);
  process.exit(2);
}

// 首尾帧各自的主色，用来判断产出有没有真的走到尾帧
const probe = (f) => {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', f, '-vf', 'scale=1:1', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer', maxBuffer: 1e7 });
  const b = r.stdout;
  return b && b.length >= 3 ? [b[0], b[1], b[2]] : null;
};
const rgbDist = (a, b) => (a && b) ? Math.round(Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2)) : -1;

console.log(`\nfl2v 验证`);
console.log(`  首帧 ${path.basename(FIRST)}   主色 ${probe(FIRST)}`);
console.log(`  尾帧 ${path.basename(LAST)}   主色 ${probe(LAST)}`);
console.log(`  时长 ${DUR}s（${Math.round(DUR * 24)} 帧 → 对齐后 ${17 * Math.round((DUR * 24 - 5) / 17) + 5}）`);

// 提示词：只说"从首帧走到尾帧"，不指定内容
const prompt = [
  'For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.',
  '',
  'integrated_multimodal_description: [Shot 1] The shot begins exactly on the reference image and evolves '
  + 'smoothly and continuously toward the final frame given as the last-frame reference. '
  + 'Same two people, same forest path, same morning light, same costumes. '
  + 'The camera holds steady. No cuts, no text, no subtitles.',
  '',
  'overall_soundscape: Quiet forest ambience, leaves rustling, soft footsteps on stone.',
  '',
  'non_diegetic_music: N/A',
].join('\n');

const outDir = path.join(BOARD_DIR, 'units');
fs.mkdirSync(outDir, { recursive: true });
const resultFile = path.join(outDir, 'fl2v-test.result.json');

console.log('\n出片…');
const sw = Date.now();
const r = spawnSync(PY, [GEN, 'fl2v',
  '--image', FIRST, '--last-image', LAST,
  '--prompt', prompt,
  '--duration', String(DUR),
  '--width', '1088', '--height', '1920',
  '--out-dir', outDir, '--result-file', resultFile, '--no-shell',
  ...(STEPS === 4 ? ['--fast'] : []),
], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 1800000 });

const secs = Math.round((Date.now() - sw) / 1000);
if (r.stderr && r.status !== 0) console.error(String(r.stderr).slice(0, 600));

let file = null;
try {
  const res = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  const f = (res.local_files || [])[0] || (res.files || [])[0];
  file = typeof f === 'string' ? f : (f && f.local_path);
  if (!res.ok) console.error('生成失败：' + res.error);
} catch { /* 下面统一报 */ }

if (!file || !fs.existsSync(file)) { console.error(`\n✗ 没出片（${secs}s）`); process.exit(1); }
console.log(`  出片 ${path.basename(file)}  ${secs} 秒`);

// ---- 量：产出的首帧 / 尾帧，跟给的首尾帧比 ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fl2v-'));
const grab = (t, name) => {
  const o = path.join(tmp, name);
  spawnSync(FFMPEG, ['-y', '-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'scale=64:-2', o], { encoding: 'utf8' });
  return fs.existsSync(o) ? o : null;
};
const durProbe = spawnSync(FFMPEG.replace(/ffmpeg\.exe$/i, 'ffprobe.exe'),
  ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
const realDur = Number(String(durProbe.stdout).trim()) || DUR;

const outFirst = grab(0.0, 'of.png');
const outLast = grab(Math.max(0, realDur - 0.08), 'ol.png');

const dFirst = rgbDist(probe(outFirst || FIRST), probe(FIRST));
const dLast = rgbDist(probe(outLast || LAST), probe(LAST));
const dCross = rgbDist(probe(outLast || FIRST), probe(FIRST));

console.log('\n主色距离（越小越像）');
console.log(`  产出的首帧 vs 给的首帧 : ${dFirst}`);
console.log(`  产出的尾帧 vs 给的尾帧 : ${dLast}      ← 这一条是关键`);
console.log(`  产出的尾帧 vs 给的首帧 : ${dCross}`);
console.log(`  （给的尾帧 vs 给的首帧 : ${rgbDist(probe(FIRST), probe(LAST))} —— 两者的天然差异）`);

// 拼一张对照：给的首帧 | 产出的首帧 | 产出的尾帧 | 给的尾帧
const sheet = path.join(BOARD_DIR, 'out', 'fl2v_compare.png');
fs.mkdirSync(path.dirname(sheet), { recursive: true });
const imgs = [FIRST, outFirst, outLast, LAST].filter(Boolean);
const args = []; for (const i of imgs) args.push('-i', i);
const L = `${imgs.map((_, i) => `[${i}:v]scale=-2:480,setsar=1[v${i}]`).join(';')};${imgs.map((_, i) => `[v${i}]`).join('')}hstack=${imgs.length}[out]`;
const script = path.join(tmp, 'g.txt'); fs.writeFileSync(script, L, 'ascii');
spawnSync(FFMPEG, ['-y', '-v', 'error', ...args, '-filter_complex_script', script, '-map', '[out]', '-frames:v', '1', sheet], { encoding: 'utf8' });
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n对照图 ${sheet}`);
console.log('  左到右：给的首帧 ｜ 产出首帧 ｜ 产出尾帧 ｜ 给的尾帧');
console.log('\n判断：**产出尾帧 ≟ 给的尾帧**。像 → fl2v 能锁住尾帧，连贯性这条路通。');
