#!/usr/bin/env node
/**
 * desub.mjs — **去掉画面上的硬字幕**（走 Docker 里的 VSR）。
 *
 * ## 为什么要这一步
 *
 * H3 会**不稳定地烧字幕** —— 同一个尺寸、同样的提示词，有的片段有、有的没有。
 * 实测 u2/u3 稳定出，u1/u4/u5 稳定不出。**加提示词排除压不住。**
 *
 * 也不能裁 —— 字幕在画面高度约 74%–80%，裁掉要损失 26%，
 * 768×1344 会变成 768×994（比例 0.57 → 0.77），竖屏构图就废了。
 *
 * **所以放在后期做**：出片 → 去字幕 → 再放大到交付尺寸。
 *
 * ## 工具
 *
 * `YaoFANGUK/video-subtitle-remover`（12.9k stars），走 Docker 镜像
 * `eritpchy/video-subtitle-remover:1.4.0-cuda12.6`（4090 = compute 8.9）。
 *
 * **实测**：768×1344 的 13.6 秒片段 **21 秒**跑完；67 秒整片 **66 秒**跑完。
 *
 * ## 坑
 *
 * Docker Desktop 的代理配置可能是**陈旧的** —— 我们这台机器上它写着
 * `127.0.0.1:7890`，而 Clash 早换到 `52740` 了，于是 `docker pull` 直接失败。
 * 改 `%APPDATA%\Docker\settings-store.json` 的 `OverrideProxyHTTP/HTTPS`，
 * **退出 Docker Desktop 再改再启动**（运行中改会被覆盖回去）。
 *
 * 用法：
 *   node cli/desub.mjs <视频> [--out <路径>] [--top 0.71] [--bottom 0.87] [--mode sttn-det]
 *       [--auto-band] [--no-verify] [--dry-run]
 *
 * ## 这是**唯一**一条去字幕通道（2026-09-24 用户拍板）
 *
 * 曾经并行做过第二条（本地 ComfyUI + VOID 扩散修复，`cli/desub-void.mjs`），已删除。
 * 同一条 11.5 秒 / 480×864 片段实测：**这条 37 秒**（含 mpeg4→h264 重编码），
 * VOID 那条跑 10 分钟没跑完（按 3 秒片段 247 秒推算 ≈950 秒，慢约 25 倍），
 * 且带外差更大（3.76 vs 这条的 2.5）。差距来自模型类别：VSR 默认的 `sttn-det`
 * 是传播式修复，不逐帧采样。
 *
 * **留下的是那条路上真正有用的两件**（都与修复算法无关，已接到本 CLI）：
 * `--auto-band` 自动找字幕带（`tools/band_detect.py`）与跑完的"带内差/带外差"核查
 * （`src/video-diff.mjs`）。复盘见 `lab/void-desub/FINDINGS.md`。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { COMFY_PYTHON, FFMPEG, FFPROBE } from '../src/runtime-paths.mjs';
import { PROJECT_ROOT } from '../src/config.mjs';
import { rectOf, verifyBandEdit } from '../src/video-diff.mjs';

const IMAGE = 'eritpchy/video-subtitle-remover:1.4.0-cuda12.6';
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true); };
const DRY = argv.includes('--dry-run');

const src = argv.find((a) => !a.startsWith('--') && fs.existsSync(a));
if (!src) {
  console.error(`用法: node cli/desub.mjs <视频> [--out <路径>] [--top 0.71] [--bottom 0.87] [--mode sttn-det] [--auto-band]

  --top / --bottom / --left / --right  字幕带在画面里的比例（默认 0.71 / 0.87 / 0 / 1）—— **必须是你量到的**
  --auto-band       用 tools/band_detect.py 自动找带（显式给的项覆盖它）；找不到候选就拒绝跑
  --mode            算法：sttn-auto | sttn-det | lama | propainter | opencv（默认 sttn-det）
  --no-verify       跑完不做"带内差/带外差"核查
  --dry-run         只打印将要执行的 docker 命令，不跑（也不需要 Docker）`);
  process.exit(2);
}

const srcAbs = path.resolve(src);
const OUT = path.resolve(String(flag('out', path.join(path.dirname(srcAbs), `${path.basename(srcAbs, path.extname(srcAbs))}_nosub.mp4`))));
const MODE = String(flag('mode', 'sttn-det'));

// 量源视频尺寸，把比例换成像素（VSR 要的是 ymin ymax xmin xmax）
const probe = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
  '-show_entries', 'stream=width,height', '-of', 'csv=p=0', srcAbs], { encoding: 'utf8' });
let W;
let H;
{
  const p = String(probe.stdout || '').trim().split(',');
  W = Number(p[0]);
  H = Number(p[1]);
}
if (!W || !H) {
  console.error(`量不到源视频尺寸（ffprobe：${FFPROBE}）`);
  process.exit(1);
}

// ---- 字幕带：默认值只是兜底，两种更靠谱的来源 ----
// 「带 → 像素」的取整走 `rectOf`（唯一一份实现，两条边各算各的再相减）：
// 核查窗口与切给 VSR 的窗口必须是**同一个矩形**，否则量出来的数答非所问。
const DECLARED = {
  top: Number(flag('top', 0.71)), bottom: Number(flag('bottom', 0.87)),
  left: Number(flag('left', 0)), right: Number(flag('right', 1)),
};
const EXPLICIT = Object.fromEntries(Object.entries(DECLARED).filter(([k]) => argv.includes(`--${k}`)));
let band = { ...DECLARED };
if (argv.includes('--auto-band')) {
  if (!COMFY_PYTHON) throw new Error('--auto-band 需要 AIH_PYTHON（ComfyUI 的 python，含 numpy/PIL）');
  const d = spawnSync(COMFY_PYTHON, [
    path.join(PROJECT_ROOT, 'tools', 'band_detect.py'),
    '--video', srcAbs, '--ffmpeg', FFMPEG, '--samples', String(flag('samples', 24)),
  ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  let j = null;
  try { j = JSON.parse(String(d.stdout).trim().split('\n').pop()); } catch { j = null; }
  if (!j || j.error) throw new Error(`自动找字幕带失败：${(j && j.error) || String(d.stderr || '').slice(0, 300)}`);
  if (!j.band) throw new Error(`自动找字幕带：没找到候选（${j.evidence?.reason || '原因不明'}）—— 请用 cli/subcheck.mjs 抽帧人工量，再显式传 --top/--bottom`);
  band = { ...j.band, ...EXPLICIT };
  console.log(`自动找带：y ${j.band.top}–${j.band.bottom}  x ${j.band.left}–${j.band.right}`
    + `  行 ${JSON.stringify(j.evidence.row_span)} 列 ${JSON.stringify(j.evidence.col_span)}`
    + `  ${j.evidence.frames_with_text}/${j.evidence.n_frames} 帧有字形`
    + (Object.keys(EXPLICIT).length ? `（${Object.keys(EXPLICIT).join('/')} 用你显式给的值）` : ''));
}
const rect = rectOf(band, W, H);
const ymin = rect.y;
const ymax = rect.y + rect.height;
const xmin = rect.x;
const xmax = rect.x + rect.width;

// 挂载：把源和输出所在目录挂进容器（可能是同一个目录，也可能不是）
const dirs = [...new Set([path.dirname(srcAbs), path.dirname(OUT)])];
const mounts = [];
const relOf = (p) => {
  for (const d of dirs) {
    if (p.startsWith(d)) return { dir: d, inner: '/data' + (dirs.length > 1 ? String(dirs.indexOf(d)) : '') + p.slice(d.length).replace(/\\/g, '/') };
  }
  return null;
};
dirs.forEach((d, i) => {
  const inner = dirs.length > 1 ? `/data${i}` : '/data';
  mounts.push('-v', `${d}:${inner}`);
});
const innerOf = (p) => {
  const idx = dirs.findIndex((d) => p.startsWith(d));
  const base = dirs.length > 1 ? `/data${idx}` : '/data';
  return base + p.slice(dirs[idx].length).replace(/\\/g, '/');
};

console.log(`\n去硬字幕`);
console.log(`  源    ${srcAbs}`);
console.log(`  出    ${OUT}`);
console.log(`  尺寸  ${W}×${H}　字幕带 x ${xmin}–${xmax} / y ${ymin}–${ymax}（比例 y ${band.top}–${band.bottom} x ${band.left}–${band.right}）`);
console.log(`  算法  ${MODE}　镜像 ${IMAGE}`);

const DOCKER_ARGS = ['run', '--rm', '--gpus', 'all', ...mounts, IMAGE,
  'python', 'backend/main.py',
  '-i', innerOf(srcAbs), '-o', innerOf(OUT),
  '-c', String(ymin), String(ymax), String(xmin), String(xmax),
  '--inpaint-mode', MODE,
];

if (DRY) {
  console.log('\n--dry-run：将要执行的命令（没跑，也不需要 Docker）');
  console.log('  docker ' + DOCKER_ARGS.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' '));
  process.exit(0);
}

const sw = Date.now();
const r = spawnSync('docker', DOCKER_ARGS, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 3600000 });

const lines = String(r.stdout || '').split(/\r?\n/).filter((l) => /Processing time|Complete|Error|error|Traceback/.test(l));
for (const l of lines.slice(-6)) console.log('  ' + l.trim());
console.log(`  耗时 ${Math.round((Date.now() - sw) / 1000)} 秒`);

if (!fs.existsSync(OUT)) {
  const err = String(r.stderr || '');
  // VSR 自己也会在给定带里找字幕（`sttn-det` 的 "det"）。带里没字时它**拒绝产出**，
  // 而不是给你一个"看起来没动"的文件 —— 这是好行为，但报错得说清楚，
  // 否则人会去查 Docker（我第一眼就是这么想的）。
  if (/NoSubtitleDetected|No subtitles detected/i.test(err)) {
    console.error(`\n✗ 带里没有检测到字幕。两种可能：`);
    console.error(`    ① 带画错了 —— 你给的带是 x ${xmin}–${xmax} / y ${ymin}–${ymax}（y ${band.top}–${band.bottom}）`);
    console.error(`    ② 这段的字**已经去过了**（拿干净版再跑一遍就会这样）`);
    console.error('  先用 node cli/subcheck.mjs <视频> 抽帧确认，或直接用 --auto-band。');
    process.exit(1);
  }
  console.error('\n✗ 没产出。检查：docker 是否在跑、镜像是否拉过、代理是否配好。');
  if (err) console.error(err.slice(0, 500));
  process.exit(1);
}
const d = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', OUT], { encoding: 'utf8' });
void d;

// ------------------------------------------------------------------ ⚠ 必须重编码
//
// **VSR 输出的是 `mpeg4`（MPEG-4 Part 2 / Simple Profile），不是 h264。**
//
// 那个编码很多播放器和浏览器**根本打不开**。我（AI）当时没查编码就把文件发给用户，
// 用户直接回了一句「打不开」。**"文件存在、ffmpeg 能解码" ≠ "用户能播"。**
//
// 所以这里强制转 h264 + aac 44.1kHz + faststart（网页里也能边下边播）。
const REENC = OUT.replace(/\.mp4$/i, '_h264.mp4');
console.log('\n重编码 mpeg4 → h264（VSR 默认输出 mpeg4，多数播放器打不开）');
const rr = spawnSync(FFMPEG, ['-y', '-v', 'error', '-i', OUT,
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '192k', '-ar', '44100',
  '-movflags', '+faststart', REENC,
], { encoding: 'utf8' });
if (!fs.existsSync(REENC)) {
  console.error('✗ 重编码失败，保留 VSR 原始产物（mpeg4，可能打不开）');
  console.error(String(rr.stderr || '').slice(0, 300));
} else {
  fs.unlinkSync(OUT);                       // 删掉那个打不开的，只留能播的
  fs.renameSync(REENC, OUT);
}

const d2 = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', OUT], { encoding: 'utf8' });
const codec = String(spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
  '-show_entries', 'stream=codec_name,profile', '-of', 'csv=p=0', OUT], { encoding: 'utf8' }).stdout || '').trim();

console.log(`\n✓ ${OUT}`);
console.log(`  ${Math.round(Number(String(d2.stdout).trim()))} 秒  ${(fs.statSync(OUT).size / 1048576).toFixed(1)} MB  编码 ${codec}`);

// 核查：这一趟到底改在哪（口径见 src/video-diff.mjs）。
// 去字幕最容易的翻车是"文件在、能播，但字幕没动 / 整帧被重画" —— 两个数就能挡住。
if (!argv.includes('--no-verify')) {
  const stats = verifyBandEdit({
    input: srcAbs, output: OUT, width: W, height: H,
    frames: Number(String(spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=nb_frames', '-of', 'csv=p=0', srcAbs], { encoding: 'utf8' }).stdout || '').trim()) || 0,
    band, tmpDir: path.resolve('.tmp'),
  });
  if (!stats) {
    console.log('  核查：抽帧读不出内容，跳过（--no-verify 可显式跳过）');
  } else {
    const 判 = {
      band_only: '✔ 带内被重画、带外基本保留 —— 改动落在字幕带上',
      band_untouched: '✗ 带内几乎没动 —— 字幕大概率还在（带画错了？）',
      suspicious_whole_frame: '⚠ 带外也被改得不比带内少 —— 整帧可能被重画',
    }[stats.verdict];
    console.log(`  核查  带内差 ${stats.band}　带外差 ${stats.outside}　倍数 ${stats.ratio ?? '∞'}　带 ${JSON.stringify(stats.rect)}`);
    console.log(`  ${判}`);
  }
}
console.log('  ⚠ 自己抽帧看一眼再信 —— 别只看"文件存在"');
