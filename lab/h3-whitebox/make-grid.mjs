#!/usr/bin/env node
/**
 * E1 对照网格：上排白膜、下排成片，同一组时间点逐列对比。
 * 走 spawnSync 直传参数数组（不经 shell，filter_complex 里的 \\, 不会被当元字符）。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const FF = 'C:/Users/Administrator/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-7.1.1-full_build/bin/ffmpeg.exe';
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const WB = process.argv[2] || path.join(ROOT, 'lab/whitebox/out/whitebox/fight/fight.mp4');
const GEN = process.argv[3] || path.join(ROOT, 'lab/h3-whitebox/out/e1-json/MiniMax_H3_00008_.mp4');
const OUT = process.argv[4] || path.join(ROOT, 'lab/h3-whitebox/out/e1_grid.png');

const FRAMES = [0, 24, 48, 72, 96, 120, 144, 167];
const sel = FRAMES.map((n) => `eq(n\\,${n})`).join('+');
const row = (label) => `[${label}:v]select='${sel}',scale=240:432,tile=8x1[a${label}]`;
const filter = [row(0), row(1), '[a0][a1]vstack=inputs=2[out]'].join(';');

const r = spawnSync(FF, ['-y', '-i', WB, '-i', GEN, '-filter_complex', filter,
  '-map', '[out]', '-frames:v', '1', OUT], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
if (r.error || r.status !== 0) { console.error('失败', r.error || r.status); process.exit(1); }
console.log('OK ' + OUT);
