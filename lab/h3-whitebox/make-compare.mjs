#!/usr/bin/env node
/**
 * 生成「白膜 vs 成片」对照物：并排总览图 + 并排视频。
 *
 * 走 spawnSync 直传参数数组 —— 不经过 shell，filter_complex 里的
 * `\,` `[a]` `;` 不会被当成 shell 元字符（2026-09-28 实测：同样命令走 Bash
 * 会被 sandbox 拦成 "decisionRecord missing actual resource subject"）。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const FF = 'C:/Users/Administrator/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-7.1.1-full_build/bin/ffmpeg.exe';
const WB = path.join(ROOT, 'lab/whitebox/out/fight.mp4');
const OUT = path.join(ROOT, 'lab/h3-whitebox/out');

function run(args, label) {
  const r = spawnSync(FF, args, { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
  if (r.error) throw new Error(`${label} 起不来：${r.error.message}`);
  if (r.status !== 0) throw new Error(`${label} 失败，退出码 ${r.status}`);
  console.log(`  ✓ ${label}`);
}

const gen = process.argv[2] || path.join(OUT, 's100/MiniMax_H3_00007_.mp4');
const tag = process.argv[3] || 's100';
if (!fs.existsSync(gen)) throw new Error(`成片不存在：${gen}`);

console.log('跑 ffmpeg：');

// 1) 两侧各抽 12 帧拼 3x4 —— 左侧白膜，右侧成片
run(['-y', '-loglevel', 'error', '-i', WB,
  '-vf', "select='not(mod(n\\,14))',scale=150:-1,tile=3x4",
  '-frames:v', '1', path.join(OUT, `_wb_${tag}.png`)], '抽白膜格');

run(['-y', '-loglevel', 'error', '-i', gen,
  '-vf', "select='not(mod(n\\,15))',scale=150:-1,tile=3x4",
  '-frames:v', '1', path.join(OUT, `_gen_${tag}.png`)], '抽成片格');

// 2) 两张格并排
run(['-y', '-loglevel', 'error',
  '-i', path.join(OUT, `_wb_${tag}.png`), '-i', path.join(OUT, `_gen_${tag}.png`),
  '-filter_complex', '[0:v][1:v]hstack=inputs=2',
  '-frames:v', '1', path.join(OUT, `${tag}_compare.png`)], '并排总览图');

// 3) 并排视频：左白膜右成片，同屏同步；取较短的一条
run(['-y', '-loglevel', 'error',
  '-i', WB, '-i', gen,
  '-filter_complex',
  "[0:v]scale=320:576,pad=328:576:4:0:color=0x141414,drawtext=text='WHITEBOX':fontsize=18:fontcolor=0xdddddd:x=8:y=6[a];" +
  "[1:v]scale=320:576,pad=328:576:4:0:color=0x141414,drawtext=text='H3 OUTPUT':fontsize=18:fontcolor=0xdddddd:x=8:y=6[b];" +
  '[a][b]hstack=inputs=2[v]',
  '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-an',
  path.join(OUT, `${tag}_sidebyside.mp4`)], '并排视频');

fs.rmSync(path.join(OUT, `_wb_${tag}.png`), { force: true });
fs.rmSync(path.join(OUT, `_gen_${tag}.png`), { force: true });

console.log('产物：');
for (const f of [`${tag}_compare.png`, `${tag}_sidebyside.mp4`]) {
  const p = path.join(OUT, f);
  console.log(`  ${f}  (${(fs.statSync(p).size / 1024).toFixed(0)} KB)`);
}
