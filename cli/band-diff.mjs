#!/usr/bin/env node
/**
 * band-diff —— **独立核查两个视频**：带内改了多少、带外改了多少。
 *
 * 存在的理由：去字幕都是"看起来成功很容易"的操作 ——
 * 文件在、时长大致对、能播，但可能字幕没动、或者整帧被重画。
 * 这个 CLI 把"改在哪"变成两个数字，供人/测试判定，不依赖哪条通道产出的。
 *
 * 用法：
 *   node cli/band-diff.mjs 原片.mp4 处理后.mp4 --top 0.695 --bottom 0.805 --left 0.28 --right 0.72
 *       [--samples 12] [--json]
 *
 * 退出码：band_only → 0；band_untouched / suspicious_whole_frame → 1（判读为"这次改得不对"）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { FFPROBE } from '../src/runtime-paths.mjs';
import { verifyBandEdit } from '../src/video-diff.mjs';
import { installCliErrorHandler } from '../src/cli-errors.mjs';

installCliErrorHandler();

const argv = process.argv.slice(2);
const value = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const files = argv.filter((a) => !a.startsWith('--') && /\.(mp4|mov|mkv|webm)$/i.test(a));
if (files.length !== 2) {
  console.error(`用法：node cli/band-diff.mjs <原片> <处理后> --top 0.7 --bottom 0.8 [--left 0.28 --right 0.72] [--samples 12] [--json]

  --top/--bottom/--left/--right  字幕带（画面比例）—— **必须是你量到的那个带**
  --samples                      抽多少帧比对（默认 12；全片都抽不值得）
  --json                         机读输出`);
  process.exit(2);
}

const band = {
  top: Number(value('top', 0.7)),
  bottom: Number(value('bottom', 0.8)),
  left: Number(value('left', 0.28)),
  right: Number(value('right', 0.72)),
};
const samples = Number(value('samples', 12));

/** 只认第一个视频流的尺寸/帧数；读不出就报清楚（别静默按 0 处理）。 */
function probe(file) {
  if (!fs.existsSync(file)) throw new Error(`视频不存在：${file}`);
  const r = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,nb_frames', '-of', 'json', file], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) throw new Error(`ffprobe 读不出 ${file}：${String(r.stderr || '').slice(0, 200)}`);
  const s = JSON.parse(r.stdout).streams?.[0] || {};
  return { width: Number(s.width), height: Number(s.height), frames: Number(s.nb_frames) || 0 };
}

const [a, b] = files.map((f) => path.resolve(f));
const ia = probe(a);
const ib = probe(b);
if (ia.width !== ib.width || ia.height !== ib.height) {
  // 尺寸不同还要比，"带"就不是同一个带 —— 直接拒绝，别给一个没法解释的数。
  throw new Error(`两个视频尺寸不同：${ia.width}x${ia.height} vs ${ib.width}x${ib.height}，没法按同一个带比`);
}

const stats = verifyBandEdit({
  input: a, output: b,
  width: ia.width, height: ia.height,
  frames: Math.min(ia.frames || 0, ib.frames || 0) || ia.frames,
  band, sampleFrames: samples, tmpDir: path.resolve('.tmp'),
});
if (!stats) throw new Error('抽帧失败：ffmpeg 解不出这两段视频的灰度帧');

const VERDICT = {
  band_only: { ok: true, text: '✔ 带内被重画、带外基本保留 —— 改动落在字幕带上' },
  band_untouched: { ok: false, text: '✗ 带内几乎没动 —— 字幕大概率还在（带画错了？）' },
  suspicious_whole_frame: { ok: false, text: '⚠ 带外也被改得不比带内少 —— 掩码极性/位置可疑，整帧可能被重画' },
};
const v = VERDICT[stats.verdict] || { ok: false, text: `未知判读：${stats.verdict}` };

if (argv.includes('--json')) {
  console.log(JSON.stringify({ input: a, output: b, band, ...stats, ok: v.ok }, null, 2));
} else {
  console.log(`\n带内/带外差异`);
  console.log(`  原片    ${path.basename(a)}`);
  console.log(`  处理后  ${path.basename(b)}`);
  console.log(`  尺寸    ${ia.width}x${ia.height}　带 ${JSON.stringify(stats.rect)}　抽 ${stats.frames} 帧`);
  console.log(`  带内差  ${stats.band}（峰值 ${stats.band_max}）`);
  console.log(`  带外差  ${stats.outside}（峰值 ${stats.outside_max}）　倍数 ${stats.ratio ?? '∞'}`);
  console.log(`  ${v.text}`);
  console.log('\n数字只排除"整个搞反了"这一类错误 —— 结论仍要抽帧用眼睛确认。');
}
process.exit(v.ok ? 0 : 1);
