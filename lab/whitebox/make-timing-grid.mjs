// 把一段白膜 mp4 抽 8 个等距帧拼成 4x2 网格图（审片用一眼看时序）。
// 用法：node lab/whitebox/make-timing-grid.mjs <in.mp4> <out.png>
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const [inp, outp] = process.argv.slice(2);
if (!inp || !outp) {
  console.error('用法: node make-timing-grid.mjs <in.mp4> <out.png>');
  process.exit(2);
}

// 8 个等距帧（按 168 帧算）：1, 25, 49, 73, 97, 121, 145, 168 → 0-based
const picks = [0, 24, 48, 72, 96, 120, 144, 167];
const sel = picks.map((n) => `eq(n\\,${n})`).join('+');
const vf = `select='${sel}',scale=270:486,tile=4x2:padding=4:color=white`;

const r = spawnSync('ffmpeg', ['-y', '-i', inp, '-vf', vf, '-frames:v', '1', outp], { stdio: 'inherit', windowsHide: true });
process.exit(r.status ?? 1);
