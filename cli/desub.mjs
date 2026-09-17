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
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const IMAGE = 'eritpchy/video-subtitle-remover:1.4.0-cuda12.6';
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true); };

const src = argv.find((a) => !a.startsWith('--') && fs.existsSync(a));
if (!src) {
  console.error(`用法: node cli/desub.mjs <视频> [--out <路径>] [--top 0.71] [--bottom 0.87] [--mode sttn-det]

  --top / --bottom   字幕带在画面高度的比例（默认 0.71 / 0.87）—— **实测值**
  --mode             算法：sttn-auto | sttn-det | lama | propainter | opencv（默认 sttn-det）`);
  process.exit(2);
}

const srcAbs = path.resolve(src);
const OUT = path.resolve(String(flag('out', path.join(path.dirname(srcAbs), `${path.basename(srcAbs, path.extname(srcAbs))}_nosub.mp4`))));
const TOP = Number(flag('top', 0.71));
const BOTTOM = Number(flag('bottom', 0.87));
const MODE = String(flag('mode', 'sttn-det'));

// 量源视频高度，把比例换成像素（VSR 要的是 ymin ymax xmin xmax）
const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
  '-show_entries', 'stream=width,height', '-of', 'csv=p=0', srcAbs], { encoding: 'utf8' });
let W;
let H;
{
  const p = String(probe.stdout || '').trim().split(',');
  W = Number(p[0]);
  H = Number(p[1]);
}
if (!W || !H) {
  console.error('量不到源视频尺寸（ffprobe 不在 PATH？）');
  process.exit(1);
}
const ymin = Math.round(H * TOP);
const ymax = Math.round(H * BOTTOM);

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
console.log(`  尺寸  ${W}×${H}　字幕带 高度 ${TOP * 100}%–${BOTTOM * 100}% → ymin=${ymin} ymax=${ymax}`);
console.log(`  算法  ${MODE}　镜像 ${IMAGE}`);

const sw = Date.now();
const r = spawnSync('docker', ['run', '--rm', '--gpus', 'all', ...mounts, IMAGE,
  'python', 'backend/main.py',
  '-i', innerOf(srcAbs), '-o', innerOf(OUT),
  '-c', String(ymin), String(ymax), '0', String(W),
  '--inpaint-mode', MODE,
], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 3600000 });

const lines = String(r.stdout || '').split(/\r?\n/).filter((l) => /Processing time|Complete|Error|error|Traceback/.test(l));
for (const l of lines.slice(-6)) console.log('  ' + l.trim());
console.log(`  耗时 ${Math.round((Date.now() - sw) / 1000)} 秒`);

if (!fs.existsSync(OUT)) {
  console.error('\n✗ 没产出。检查：docker 是否在跑、镜像是否拉过、代理是否配好。');
  if (r.stderr) console.error(String(r.stderr).slice(0, 500));
  process.exit(1);
}
const d = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', OUT], { encoding: 'utf8' });
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
const rr = spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', OUT,
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

const d2 = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', OUT], { encoding: 'utf8' });
const codec = String(spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
  '-show_entries', 'stream=codec_name,profile', '-of', 'csv=p=0', OUT], { encoding: 'utf8' }).stdout || '').trim();

console.log(`\n✓ ${OUT}`);
console.log(`  ${Math.round(Number(String(d2.stdout).trim()))} 秒  ${(fs.statSync(OUT).size / 1048576).toFixed(1)} MB  编码 ${codec}`);
console.log('  ⚠ 自己抽帧看一眼再信 —— 别只看"文件存在"');
