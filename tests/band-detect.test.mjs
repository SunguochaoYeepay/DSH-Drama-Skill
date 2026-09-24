/**
 * `tools/band_detect.py` —— 自动找字幕带。
 *
 * 这里守的是**它会不会瞎指位置**：找不到时必须返回 null（人再去 cli/subcheck.mjs 量），
 * 而不是给一个"看起来有"的带 —— 带错了的代价是把画面中间重画一遍。
 *
 * 用合成视频做真值：字幕是 ffmpeg drawtext 画上去的，位置我们说了算。
 * 抽帧/PIL 缺一不可，缺了就**跳过**（不判失败）—— 这些是机器侧前置，不是代码问题。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { COMFY_PYTHON, FFMPEG } from '../src/runtime-paths.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'tools', 'band_detect.py');
let pass = 0;
let fail = 0;
let skip = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const skipAll = (why) => { skip++; console.log(`  ⚠ 跳过：${why}`); };

const pythonOk = Boolean(COMFY_PYTHON) && fs.existsSync(COMFY_PYTHON)
  && spawnSync(COMFY_PYTHON, ['-c', 'import numpy, PIL'], { encoding: 'utf8' }).status === 0;
const ffmpegOk = spawnSync(FFMPEG, ['-version'], { encoding: 'utf8' }).status === 0;

if (!pythonOk || !ffmpegOk) {
  skipAll(!pythonOk ? '没有可用的 ComfyUI python（numpy/PIL）' : '没有可用的 ffmpeg');
  console.log(`\n结果：${pass} 通过 / ${fail} 失败 / ${skip} 跳过`);
  process.exit(fail ? 1 : 0);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-banddetect-'));
const W = 240;
const H = 432;
const TEXT_Y = 0.72;                 // 真值：字幕中心在这一高度
const FONT = 'C\\:/Windows/Fonts/arial.ttf';   // filter 里冒号要转义，否则被当成选项分隔符

function makeVideo(out, withText) {
  const vf = withText
    ? `drawtext=fontfile='${FONT}':text='TEST SUBTITLE':fontcolor=white:fontsize=26:`
      + `borderw=3:bordercolor=black:x=(w-text_w)/2:y=${TEXT_Y}*h-text_h/2`
    : null;
  const args = ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x303030:s=${W}x${H}:d=1:r=12`];
  if (vf) args.push('-vf', vf);
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', out);
  const r = spawnSync(FFMPEG, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`合成视频失败：${String(r.stderr).slice(0, 300)}`);
  return out;
}

function detect(video, samples = 12) {
  const r = spawnSync(COMFY_PYTHON, [SCRIPT, '--video', video, '--ffmpeg', FFMPEG, '--samples', String(samples)], { encoding: 'utf8' });
  try { return JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch { return { error: `解析不出 JSON：${String(r.stdout).slice(0, 200)}` }; }
}

try {
  console.log('合成视频上有字幕：必须找到，且位置对得上');
  const withText = makeVideo(path.join(TMP, 'has-text.mp4'), true);
  const j = detect(withText);
  check('找到了候选', Boolean(j.band) && !j.error, j.error || j.evidence?.reason || '');
  if (j.band) {
    const mid = (j.band.top + j.band.bottom) / 2;
    check('纵向中心落在画的字上（±0.05）', Math.abs(mid - TEXT_Y) < 0.05, `中心 ${mid.toFixed(3)}，真值 ${TEXT_Y}`);
    check('行带够高（≥13 行，不是零散亮点）', j.evidence.row_run >= 13, `run=${j.evidence.row_run}`);
    // 横向只断言"是横跨中线的一段、且在画面内"：合成视频里的字是长串，
    // 真实字幕的左右边界精度是在真实片段上核对的（见 lab/spatial/FINDINGS.md）。
    check('横向范围合理（跨越中线、在画面内、没铺满全宽）',
      j.band.left >= 0 && j.band.right <= 1 && j.band.left < 0.5 && j.band.right > 0.5
      && (j.band.right - j.band.left) < 0.98,
      `x ${j.band.left}–${j.band.right}`);
  }

  console.log('同样的画面但没有字：必须返回 null（不许硬给一个带）');
  const noText = makeVideo(path.join(TMP, 'no-text.mp4'), false);
  const j2 = detect(noText);
  check('没字 → band 为 null', j2.band === null, JSON.stringify(j2.band));
  check('null 时给出原因', Boolean(j2.evidence && j2.evidence.reason), JSON.stringify(j2.evidence));

  console.log('输入不存在：报错而不是给带');
  const j3 = detect(path.join(TMP, 'nope.mp4'));
  check('返回 error 字段', Boolean(j3.error), JSON.stringify(j3).slice(0, 120));
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败 / ${skip} 跳过`);
if (fail) process.exit(1);
