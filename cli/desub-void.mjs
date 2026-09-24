#!/usr/bin/env node
/**
 * **用 VOID 去掉烧入字幕**（本地、不用 Docker）。
 *
 * 与 `cli/desub.mjs`（VSR Docker）的关系：**并存，谁好用用谁**。
 * 这条路的依据见 `src/void-desub.mjs` 的文档：掩码来自"声明好的字幕带"而不是模型识别，
 * 极性是「白=保留，黑=要修」（踩过一次，判定方法写在那个文件里）。
 *
 * 用法：
 *   node cli/desub-void.mjs <video.mp4> [--top 0.695 --bottom 0.805 --left 0.28 --right 0.72 | --auto-band]
 *       [--passes 2] [--blur 6] [--prompt "..."] [--workflow workflows/void-video-inpainting.json]
 *       [--out <file>] [--mask-out <png>] [--mask <png>] [--no-verify] [--dry-run]
 *
 * 跑完默认会把"带内差 / 带外差"量出来（`src/video-diff.mjs`）—— 去字幕最容易的翻车
 * 是"输出存在、能播，但整帧被重画 / 字幕根本没动"，这两类只有数字能挡。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildVoidDesubGraph, loadVoidWorkflow } from '../src/void-desub.mjs';
import { collectOutputs, downloadOutputs, patchVideoInputs, runGraph, uploadVideo } from '../src/comfy-workflow.mjs';
import { COMFY_PYTHON, FFMPEG, FFPROBE } from '../src/runtime-paths.mjs';
import { PROJECT_ROOT } from '../src/config.mjs';
import { verifyBandEdit } from '../src/video-diff.mjs';
import { installCliErrorHandler } from '../src/cli-errors.mjs';

installCliErrorHandler();

const argv = process.argv.slice(2);
const value = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const input = argv.find((a) => !a.startsWith('--') && /\.(mp4|mov|mkv)$/i.test(a));
if (!input) {
  console.error('用法：node cli/desub-void.mjs <video.mp4> [--top 0.7 --bottom 0.8] [--passes 2] [--dry-run]');
  process.exit(2);
}

const video = path.resolve(input);
if (!fs.existsSync(video)) throw new Error(`视频不存在：${video}`);
const workflowFile = path.resolve(value('workflow', 'workflows/void-video-inpainting.json'));

// 字幕带：默认值只是兜底。**用默认值等于赌字幕恰好在那个位置**，所以有两种更靠谱的来源：
//   · 显式 --top/--bottom/--left/--right（你在 cli/subcheck.mjs 那张图上量到的）
//   · --auto-band（tools/band_detect.py 找候选；显式给的项仍然覆盖它）
const DECLARED = { top: value('top', 0.7), bottom: value('bottom', 0.8), left: value('left', 0.28), right: value('right', 0.72) };
const EXPLICIT = Object.fromEntries(Object.entries(DECLARED).filter(([k]) => argv.includes(`--${k}`)));
let band = { ...DECLARED };
const passes = Number(value('passes', 2));
const blur = Number(value('blur', 6));
const prompt = value('prompt', 'a clean background matching the surrounding scene');
const outFile = path.resolve(value('out', video.replace(/\.(mp4|mov|mkv)$/i, '_desubvoid.mp4')));
const DRY = argv.includes('--dry-run');

/** 视频尺寸与帧数（复用仓库里 ffprobe 的解析，不自己写死二进制名）。 */
function probe(file) {
  const r = spawnSync(FFPROBE, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,nb_frames,r_frame_rate',
    '-of', 'json', file,
  ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout) throw new Error(`ffprobe 读不出尺寸：${String(r.stderr || '').slice(0, 200)}`);
  const s = JSON.parse(r.stdout).streams?.[0] || {};
  const [num, den] = String(s.r_frame_rate || '0/1').split('/').map(Number);
  const fps = den ? num / den : 0;
  return { width: Number(s.width), height: Number(s.height), frames: Number(s.nb_frames) || null, fps };
}

const info = probe(video);
const secondary = info.frames && info.fps ? Math.round(info.frames / info.fps) : Number(value('seconds', 3));
console.log(`输入：${path.basename(video)}  ${info.width}x${info.height}  ${info.frames ?? '?'} 帧  ${info.fps.toFixed(2)} fps`);

// --auto-band：让 tools/band_detect.py 找候选（见该脚本：靠"亮+细+带描边"的字形特征，
// 而不是让模型认字）。**它只是候选**：显式给的 --top/--bottom/--left/--right 仍然覆盖它。
if (argv.includes('--auto-band')) {
  if (!COMFY_PYTHON) throw new Error('--auto-band 需要 AIH_PYTHON（ComfyUI 的 python，含 numpy/PIL）');
  const d = spawnSync(COMFY_PYTHON, [
    path.join(PROJECT_ROOT, 'tools', 'band_detect.py'),
    '--video', video, '--ffmpeg', FFMPEG, '--samples', String(value('samples', 24)),
  ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  let j = null;
  try { j = JSON.parse(String(d.stdout).trim().split('\n').pop()); } catch { j = null; }
  if (!j || j.error) throw new Error(`自动找字幕带失败：${(j && j.error) || String(d.stderr || '').slice(0, 300)}`);
  if (!j.band) throw new Error(`自动找字幕带：没找到候选（${j.evidence?.reason || '原因不明'}）—— 请用 cli/subcheck.mjs 抽帧人工量，再显式传 --top/--bottom`);
  band = { ...j.band, ...EXPLICIT };
  const over = Object.keys(EXPLICIT).length ? `（其中 ${Object.keys(EXPLICIT).join('/')} 用你显式给的值）` : '';
  console.log(`自动找带：y ${j.band.top}–${j.band.bottom}  x ${j.band.left}–${j.band.right}`
    + `  行 ${JSON.stringify(j.evidence.row_span)} 列 ${JSON.stringify(j.evidence.col_span)}`
    + `  ${j.evidence.frames_with_text}/${j.evidence.n_frames} 帧有字形${over}`);
}
console.log(`字幕带：y ${band.top}–${band.bottom}  x ${band.left}–${band.right}`);

// 掩码：默认交给 tools/band_mask.py 按声明带生成（极性"白=保留、黑=要修"由它负责，见该文件文档）；
// `--mask <png>` 可以直接给现成掩码（手画的、或做对照实验用的）。
const givenMask = value('mask', null);
const maskFile = givenMask ? path.resolve(givenMask) : path.resolve(value('mask-out', '.tmp/desub-void-mask.png'));
let maskLine;
if (givenMask) {
  if (!fs.existsSync(maskFile)) throw new Error(`--mask 指定的文件不存在：${maskFile}`);
  // 用现成掩码时**必须先核对尺寸** —— 掩码和视频尺寸不一致会静默套错地方。
  const dim = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', maskFile], { encoding: 'utf8' });
  const [mw, mh] = String(dim.stdout || '').trim().split(',').map(Number);
  if (mw !== info.width || mh !== info.height) {
    throw new Error(`--mask 尺寸 ${mw}x${mh} 与视频 ${info.width}x${info.height} 不一致（掩码必须逐像素对齐）`);
  }
  maskLine = `掩码：${path.basename(maskFile)}  ${mw}x${mh}（--mask 指定；极性不做检查，白=保留、黑=要修）`;
} else {
  if (!COMFY_PYTHON) throw new Error('需要 AIH_PYTHON（ComfyUI 的 python）来生成掩码，见 .env');
  const maskRun = spawnSync(COMFY_PYTHON, [
    path.join(PROJECT_ROOT, 'tools', 'band_mask.py'),
    '--size', `${info.width}x${info.height}`,
    '--top', String(band.top), '--bottom', String(band.bottom),
    '--left', String(band.left), '--right', String(band.right),
    '--blur', String(blur), '--out', maskFile,
  ], { encoding: 'utf8' });
  if (maskRun.status !== 0) throw new Error(`生成掩码失败：${String(maskRun.stderr || '').slice(0, 300)}`);
  const maskInfo = JSON.parse(String(maskRun.stdout).trim().split('\n').pop());
  maskLine = `掩码：${path.basename(maskFile)}  ${JSON.stringify(maskInfo.band_px)}  黑占 ${(maskInfo.black_ratio * 100).toFixed(2)}%（${maskInfo.polarity}）`;
}
const maskBase = path.basename(maskFile);
console.log(maskLine);

// 干跑不碰网络：用本地文件名先把图写出来看接线对不对。
if (DRY) {
  const { graph: dryGraph } = buildVoidDesubGraph({
    workflow: loadVoidWorkflow(workflowFile),
    videoWidth: info.width, videoHeight: info.height, band, passes,
    durationSeconds: secondary, maskFileName: maskBase, prompt,
  });
  const dump = path.resolve('.tmp/desub-void-dry.json');
  fs.mkdirSync(path.dirname(dump), { recursive: true });
  fs.writeFileSync(dump, JSON.stringify(dryGraph, null, 2) + '\n', 'utf8');
  console.log(`干跑：已写出将要提交的图 ${dump}`);
  process.exit(0);
}

// 掩码也要传到 ComfyUI 的 input/ —— LoadImageMask 认的是那边的文件名，本地路径它读不到。
const maskName = await uploadVideo(maskFile);
const { graph, plan } = buildVoidDesubGraph({
  workflow: loadVoidWorkflow(workflowFile),
  videoWidth: info.width,
  videoHeight: info.height,
  band,
  passes,
  durationSeconds: secondary,
  maskFileName: maskName,
  prompt,
});
console.log(`处理分辨率 ${info.width}x${info.height}；趟数 ${passes}；时长 ${secondary}s；四方位掩码接到 ${plan.wired.quadmask_from}`);

const videoName = await uploadVideo(video);
patchVideoInputs(graph, videoName);
const { seconds, history } = await runGraph(graph, { timeoutMs: 60 * 60 * 1000 });
console.log(`跑完：${seconds} 秒`);

// VHS 那类节点把视频报在 `gifs` 里，所以不能只按 kind === 'video' 过滤 —— 按**扩展名**认产物。
const outputs = collectOutputs(history).filter((o) => /\.(mp4|webm|mov|mkv|gif)$/i.test(o.filename || ''));
if (!outputs.length) {
  fs.mkdirSync(path.resolve('.tmp'), { recursive: true });
  fs.writeFileSync(path.resolve('.tmp/desub-void-history.json'), JSON.stringify(history, null, 2) + '\n', 'utf8');
  const seen = collectOutputs(history).map((o) => `${o.kind}:${o.filename}`).join(', ') || '(无)';
  throw new Error(`没有产出视频。图里报出来的产物：${seen}；完整 history 见 .tmp/desub-void-history.json`);
}
console.log(`产物候选：${outputs.map((o) => o.filename).join(', ')}`);
// 图里可能夹着"原片回声"（某个 SaveVideo 把输入原样写出来）。挑错就等于"成功地把原片复制了一遍" —— 所以先排除它。
const echoes = new Set([path.basename(video).toLowerCase(), path.basename(outFile).toLowerCase()]);
const candidates = outputs.filter((o) => !echoes.has(String(o.filename).toLowerCase()));
if (!candidates.length) throw new Error(`产物里只有输入的回声（${[...echoes].join('/')}），没有 VOID 的结果`);
// 两趟时取 pass2；一趟时取 pass1；再兜底取剩下的最后一个（pass2 总在 pass1 之后产出）
const pick = candidates.find((o) => /pass2/i.test(o.filename))
  || candidates.find((o) => /pass1/i.test(o.filename))
  || candidates[candidates.length - 1];
const saved = await downloadOutputs([pick], path.dirname(outFile));
const got = saved[0];
if (!got) throw new Error('下载失败');
if (path.resolve(got) !== outFile) fs.copyFileSync(got, outFile);
console.log(`✓ 去字幕结果：${outFile}`);
console.log(`  原始输入（未改动）：${video}`);

// ---------------------------------------------------------------- 自核查
//
// 去字幕是"看起来很容易成功"的操作：输出存在、能播，但字幕可能没动（带画错）
// 或者整帧被重画（掩码极性反了）。所以这里**默认量一次**：带内差 vs 带外差。
// 抽查帧（每隔 step 帧取一张）而不是全片 —— 目的只是判"有没有做该做的事"。
if (!argv.includes('--no-verify')) {
  const stats = verifyBandEdit({
    input: video, output: outFile,
    width: info.width, height: info.height, frames: info.frames || 0,
    band, tmpDir: path.resolve('.tmp'),
  });
  if (!stats) {
    console.log('\n核查：抽帧读不出内容，跳过（--no-verify 可显式跳过）');
  } else {
    const 判 = {
      band_only: '✔ 带内被重画、带外基本保留 —— 这次去字幕做了该做的事',
      band_untouched: '✗ 带内几乎没动 —— 字幕大概率还在（带画错了？）',
      suspicious_whole_frame: '⚠ 带外也被改得不比带内少 —— 掩码极性/位置可疑，整帧可能被重画',
    }[stats.verdict];
    console.log(`\n核查（抽 ${stats.frames} 帧，带 ${JSON.stringify(stats.rect)}）`);
    console.log(`  带内差 ${stats.band}　带外差 ${stats.outside}　倍数 ${stats.ratio ?? '∞'}`);
    console.log(`  ${判}`);
    console.log('  最后仍要抽帧用眼睛看一遍 —— 数字只排除"整个搞反了"这一类错误');
  }
}
