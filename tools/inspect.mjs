#!/usr/bin/env node
/**
 * inspect.mjs — **检查一个视频/图片**：规格 + 抽帧图。
 *
 * 为什么要有它：我每次手动拼 ffmpeg 命令去抽帧，**次次翻车**：
 *   - `scale=300:533` 高度是奇数 → yuv420p 直接报错
 *   - 逐帧抽出来高度差 2px → `hstack` 拒绝
 *   - PowerShell 循环里 `-ss` 拼错 → 只写出第 1 帧
 *   - 想裁字幕带却把画面裁歪
 *
 * **检查产物是高频动作，就该是个钉死的工具，而不是每次现场编命令。**
 *
 * 用法：
 *   node tools/inspect.mjs <video|image> [选项]
 *
 * 选项：
 *   --frames <N>    抽几帧（默认 6；图片忽略）
 *   --height <px>   每帧高度（默认 360，**偶数对齐**）
 *   --out <path>    抽帧图输出路径（默认与源文件同目录的 `<name>_frames.png`）
 *   --aspect <a:b>  核对画幅（如 9:16）；不给就只报告
 *   --tolerance <p> 画幅容差，默认 0.02（2%）
 *   --first-last    额外单独导出首帧和末帧（做衔接时要用）
 *
 * 退出码：0 = 全部通过；1 = 有检查项不过。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// ---------------------------------------------------------------- 工具定位

const FFMPEG = (() => {
  const base = 'C:\\Users\\Administrator\\AppData\\Local\\Microsoft\\WinGet\\Packages';
  try {
    for (const dir of fs.readdirSync(base)) {
      if (!dir.startsWith('Gyan.FFmpeg_')) continue;
      const c = path.join(base, dir, 'ffmpeg-7.1.1-full_build', 'bin', 'ffmpeg.exe');
      if (fs.existsSync(c)) return c;
    }
  } catch { /* 退回 PATH */ }
  return 'ffmpeg';
})();
const FFPROBE = FFMPEG.replace(/ffmpeg\.exe$/i, 'ffprobe.exe');
const NUL = process.platform === 'win32' ? 'NUL' : '-';

const run = (bin, args) => spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });

// ---------------------------------------------------------------- 参数

const argv = process.argv.slice(2);
const src = argv.find((a) => !a.startsWith('--') && argv.indexOf(a) > 0 ? !argv[argv.indexOf(a) - 1].startsWith('--') : false)
  || argv.find((a) => !a.startsWith('--'));

function flag(name, def) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) return true;
  return v;
}

if (!src || argv.includes('--help') || argv.includes('-h')) {
  console.log(`
用法: node tools/inspect.mjs <video|image> [选项]

  --frames <N>     抽几帧（默认 6）
  --height <px>    每帧高度（默认 360，偶数对齐）
  --out <path>     抽帧图输出路径
  --aspect <a:b>   核对画幅（如 9:16）
  --tolerance <p>  画幅容差（默认 0.02）
  --first-last     额外导出首帧/末帧（做衔接时要用）
`);
  process.exit(src ? 0 : 2);
}

const srcAbs = path.resolve(src);
if (!fs.existsSync(srcAbs)) { console.error(`✗ 找不到文件：${srcAbs}`); process.exit(2); }

const NFRAMES = Math.max(2, Number(flag('frames', 6)) || 6);
const RAW_H = Number(flag('height', 360)) || 360;
const HEIGHT = RAW_H % 2 === 0 ? RAW_H : RAW_H - 1;   // **偶数** —— yuv420p 的硬要求
const EXPECT = flag('aspect', null);
const TOL = Number(flag('tolerance', 0.02)) || 0.02;
const WANT_EDGES = Boolean(flag('first-last', false));
const isImage = /\.(png|jpe?g|webp|bmp)$/i.test(srcAbs);
const outSheet = flag('out', null) || path.join(path.dirname(srcAbs), `${path.basename(srcAbs, path.extname(srcAbs))}_frames.png`);

// ---------------------------------------------------------------- 探测

function probe(file) {
  const v = run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,nb_frames,r_frame_rate', '-of', 'default=noprint_wrappers=1', file]).stdout || '';
  const f = run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).stdout || '';
  const hasAudio = (run(FFPROBE, ['-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file]).stdout || '').includes('audio');
  const num = (k) => Number((v.match(new RegExp(`${k}=(.+)`)) || [])[1]);
  const fr = (v.match(/r_frame_rate=(\d+)\/(\d+)/) || []);
  return {
    w: num('width'),
    h: num('height'),
    frames: num('nb_frames') || null,
    fps: fr[1] ? Number(fr[1]) / Number(fr[2]) : null,
    duration: Number(String(f).trim()) || null,
    hasAudio,
  };
}

/** 音频响度（解全部）。 */
function loudness(file) {
  const r = run(FFMPEG, ['-i', file, '-af', 'volumedetect', '-f', 'null', NUL]);
  const t = String(r.stderr || '');
  const m = t.match(/mean_volume:\s*(-?[\d.]+) dB/);
  const x = t.match(/max_volume:\s*(-?[\d.]+) dB/);
  return { mean: m ? Number(m[1]) : null, max: x ? Number(x[1]) : null };
}

/** 完整解码一遍，数报错行。 */
function decodeErrors(file) {
  const r = run(FFMPEG, ['-v', 'error', '-i', file, '-f', 'null', NUL]);
  return String(r.stderr || '').split(/\r?\n/).filter((l) => l.trim()).length;
}

// ---------------------------------------------------------------- 抽帧

/**
 * 抽 N 帧。**逐帧单独抽，再拼** —— 不用 `select`+`tile`，
 * 那样帧号对不上、还会因为尺寸差 1px 直接失败。
 */
function grabFrames(file, shots, tmpDir) {
  const made = [];
  shots.forEach((t, i) => {
    const out = path.join(tmpDir, `f${String(i).padStart(2, '0')}.png`);
    // **按同一高度缩放**（宽度 -2 保证偶数），这样 hstack 的高度必然一致
    const r = run(FFMPEG, ['-y', '-v', 'error', '-ss', t.toFixed(3), '-i', file,
      '-frames:v', '1', '-vf', `scale=-2:${HEIGHT}`, out]);
    if (fs.existsSync(out) && fs.statSync(out).size > 0) made.push(out);
    else if (r.stderr) console.error(`      ⚠ 第 ${i + 1} 帧（t=${t.toFixed(2)}s）没抽出来：${String(r.stderr).slice(0, 120)}`);
  });
  return made;
}

/** 把一批同高的帧横向拼起来。 */
function hstack(files, out) {
  if (files.length === 1) { fs.copyFileSync(files[0], out); return true; }
  const args = [];
  for (const f of files) args.push('-i', f);
  const L = `${files.map((_, i) => `[${i}:v]`).join('')}hstack=${files.length}[out]`;
  const script = path.join(path.dirname(out), '.inspect-filter.txt');
  fs.writeFileSync(script, L, 'ascii');
  const r = run(FFMPEG, ['-y', '-v', 'error', ...args, '-filter_complex_script', script, '-map', '[out]', '-frames:v', '1', out]);
  try { fs.unlinkSync(script); } catch { /* 无所谓 */ }
  if (!fs.existsSync(out) || fs.statSync(out).size === 0) {
    console.error(`      ✗ hstack 失败：${String(r.stderr || '').slice(0, 200)}`);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------- 画幅判据

function aspectOk(w, h, aspect, tol) {
  const m = String(aspect).match(/^(\d+(?:\.\d+)?)[:/](\d+(?:\.\d+)?)$/);
  if (!m) return { ok: false, why: `画幅 "${aspect}" 解析不出来` };
  const want = Number(m[1]) / Number(m[2]);
  const got = w / h;
  const diff = Math.abs(got - want) / want;
  return { ok: diff <= tol, got, want, diff, why: `实际 ${w}×${h}（${got.toFixed(4)}）≠ 期望 ${aspect}（${want.toFixed(4)}）` };
}

// ---------------------------------------------------------------- 主流程

const info = probe(srcAbs);
const fails = [];
const warns = [];

console.log(`\n检查 ${path.basename(srcAbs)}`);
console.log('─'.repeat(60));
console.log(`  尺寸      ${info.w}×${info.h}` + (info.fps ? `  @ ${info.fps}fps` : ''));
if (info.duration) console.log(`  时长      ${info.duration.toFixed(3)}s`);
if (info.frames) console.log(`  帧数      ${info.frames}`);
console.log(`  音轨      ${info.hasAudio ? '有' : '**没有**'}`);

if (!info.w || !info.h) fails.push('量不到尺寸');
if (EXPECT && info.w && info.h) {
  const a = aspectOk(info.w, info.h, EXPECT, TOL);
  console.log(`  画幅      期望 ${EXPECT} → ${a.ok ? '✓ 通过' : '✗ 不符'}（偏离 ${(a.diff * 100).toFixed(2)}%，容差 ${(TOL * 100).toFixed(1)}%）`);
  if (!a.ok) fails.push(`画幅不符：${a.why}`);
}
if (!info.hasAudio && !isImage) warns.push('没有音轨');

if (!isImage) {
  const dec = decodeErrors(srcAbs);
  console.log(`  解码报错  ${dec} 行` + (dec === 0 ? ' ✓' : ' ✗'));
  if (dec > 0) fails.push(`解码报错 ${dec} 行`);

  if (info.hasAudio) {
    const l = loudness(srcAbs);
    console.log(`  响度      mean ${l.mean} dB / max ${l.max} dB`);
    if (l.mean !== null && l.mean < -50) fails.push(`整片平均电平 ${l.mean} dB —— 基本是静音`);
    else if (l.mean !== null && l.mean < -38) warns.push(`电平偏低（${l.mean} dB）—— 如果这镜有台词，就是有问题`);
    if (l.max !== null && l.max >= -0.1) warns.push(`峰值顶到 ${l.max} dB，有削波`);
  }
}

// 抽帧
const dur = info.duration || 1;
const shots = [];
if (!isImage) {
  for (let i = 0; i < NFRAMES; i++) shots.push((dur * (i + 0.5)) / NFRAMES);
}
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inspect-'));
let sheetOk = false;
if (!isImage) {
  const files = grabFrames(srcAbs, shots, tmpDir);
  console.log(`  抽帧      ${files.length}/${NFRAMES} 帧` + (files.length === NFRAMES ? ' ✓' : ' ✗'));
  if (files.length < 2) fails.push(`只抽出 ${files.length} 帧`);
  if (files.length) sheetOk = hstack(files, outSheet);
  if (sheetOk) console.log(`  抽帧图    ${outSheet}`);
} else {
  sheetOk = true;
  console.log(`  抽帧图    （图片无需抽帧）`);
}

// 首末帧（做衔接要用）
if (WANT_EDGES && !isImage) {
  const dir = path.dirname(srcAbs);
  const base = path.basename(srcAbs, path.extname(srcAbs));
  const first = path.join(dir, `${base}_first.png`);
  const last = path.join(dir, `${base}_last.png`);
  run(FFMPEG, ['-y', '-v', 'error', '-i', srcAbs, '-frames:v', '1', '-vf', `scale=-2:${HEIGHT}`, first]);
  run(FFMPEG, ['-y', '-v', 'error', '-sseof', '-0.1', '-i', srcAbs, '-frames:v', '1', '-vf', `scale=-2:${HEIGHT}`, last]);
  const mk = (f) => (fs.existsSync(f) && fs.statSync(f).size > 0 ? '✓' : '✗');
  console.log(`  首帧      ${first}  ${mk(first)}`);
  console.log(`  末帧      ${last}  ${mk(last)}`);
}

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log('─'.repeat(60));
for (const w of warns) console.log(`  ⚠ ${w}`);
for (const f of fails) console.log(`  ✗ ${f}`);
console.log(fails.length ? `\n✗ ${fails.length} 项不通过` : '\n✓ 全部通过');
process.exit(fails.length ? 1 : 0);
