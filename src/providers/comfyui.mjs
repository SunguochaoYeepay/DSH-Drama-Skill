/**
 * comfyui.mjs — 本地生图/生视频：复用 comfy-studio 的 gen.py。
 *
 * 定位：**批量草稿**。免费、无限重抽，适合探构图；
 * 角色/场景/道具这类"出一张定一张"的资产走线上（那边多参考合成强一档）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const PY = process.env.AIH_PYTHON || 'E:\\AI-Image\\ComfyUI-aki-v1.4\\python\\python.exe';
const GEN = process.env.AIH_GEN || 'C:\\Users\\Administrator\\.agents\\skills\\comfy-studio\\scripts\\gen.py';

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

/**
 * 参考图降采样。
 *
 * 实测：直接喂 2688×1536 的身份图，单张关键帧要 **121 秒**。
 * 参考图不需要那么大 —— 缩到 1024 长边，编码快很多，而一致性靠的是内容不是像素。
 * @returns {{files: string[], cleanup: () => void}}
 */
function shrinkRefs(images, maxEdge = 1024) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-ref-'));
  const out = [];
  for (const [i, src] of (images || []).entries()) {
    const dst = path.join(dir, `ref${i}.png`);
    const ok = spawnSync(FFMPEG, [
      '-y', '-i', src,
      '-vf', `scale='min(${maxEdge},iw)':'min(${maxEdge},ih)':force_original_aspect_ratio=decrease`,
      '-frames:v', '1', dst,
    ], { stdio: 'ignore' }).status === 0;
    out.push(ok && fs.existsSync(dst) ? dst : src);
  }
  return { files: out, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function snapshot(dir) {
  if (!fs.existsSync(dir)) return new Set();
  return new Set(fs.readdirSync(dir));
}

function run(args, timeoutMs) {
  const r = spawnSync(PY, [GEN, ...args], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  let parsed = null;
  try { parsed = JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch { /* 非 JSON 输出就忽略 */ }
  return { status: r.status, stderr: r.stderr || '', json: parsed };
}

/** 文生图。`--batch` 是 gen.py 的批量参数（**只对 t2i/music 有效**）。 */
export async function generate({ prompt, ratio = '16:9', n = 1, outDir, prefix = 'img', style, fast = true, width, height, timeoutMs = 900000 }) {
  fs.mkdirSync(outDir, { recursive: true });
  const before = snapshot(outDir);
  const args = ['t2i', '--prompt', prompt, '--batch', String(n), '--out-dir', outDir];
  // 画幅：显式宽高优先，其次 ratio。**不传的话走 IMAGE_DEFAULT = (1024,576) 横屏。**
  if (width && height) args.push('--width', String(width), '--height', String(height));
  else args.push('--ratio', ratio);
  if (fast) args.push('--fast');   // 以前这里写死 `--fast`，成品出不来细节
  if (style) args.push('--style', style);
  const r = run(args, timeoutMs);
  return { files: newFiles(outDir, before), status: r.status, stderr: r.stderr, json: r.json };
}

/**
 * 图生图 / 多参考合成（Qwen-Image-Edit 最多 3 张）。
 *
 * `fast` 默认开（Lightning 4 步）—— 探构图时够用、快 5 倍。
 * **但成品的关键帧应该关掉它**：4 步和 20 步的细节差得很明显，
 * 而关键帧是整片画面的源头，它糊了后面全部跟着糊。
 *
 * `--batch` **对 edit 无效**，所以抽多个候选只能循环、每次换个种子；串行跑，
 * ComfyUI 是单卡的，并发提交只会互相排队。
 */
export async function edit({ images, instruction, n = 1, outDir, prefix = 'edit', fast = true, ratio, width, height, timeoutMs = 900000 }) {
  fs.mkdirSync(outDir, { recursive: true });
  const { files: refs, cleanup } = shrinkRefs(images);
  const files = [];
  let lastErr = '';
  try {
    for (let i = 0; i < Math.max(1, n); i++) {
      const before = snapshot(outDir);
      const args = ['edit'];
      for (const img of refs) args.push('--image', path.resolve(img));
      args.push('--prompt', instruction, '--out-dir', outDir);
      // **画幅一定要传。** 不传的话 gen.py 走 `IMAGE_DEFAULT = (1024, 576)` —— 永远是横屏，
      // 竖屏短剧的关键帧会被生成成横的（这是个真踩过的坑）。
      if (width && height) args.push('--width', String(width), '--height', String(height));
      else if (ratio) args.push('--ratio', ratio);
      if (fast) args.push('--fast');
      if (n > 1) args.push('--seed', String(1000 + i * 7919));   // 固定但互不相同的种子：可复现
      const r = run(args, timeoutMs);
      if (r.status !== 0) lastErr = r.stderr || `exit ${r.status}`;
      files.push(...newFiles(outDir, before));
    }
  } finally {
    cleanup();
  }
  return { files, status: files.length ? 0 : 1, stderr: lastErr, json: null };
}

/** 目录里新增的图片文件。 */
function newFiles(dir, before) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    if (before.has(f)) continue;
    if (!/\.(png|jpe?g|webp)$/i.test(f)) continue;
    out.push(path.join(dir, f));
  }
  return out.sort();
}

export const name = 'comfyui';
