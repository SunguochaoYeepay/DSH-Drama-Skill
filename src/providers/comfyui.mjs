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
import { COMFY_GEN, WINGET_PACKAGES, requireComfyPython } from '../runtime-paths.mjs';
import { LOCAL_IMAGE_MODEL } from '../config.mjs';

const GEN = COMFY_GEN;

const FFMPEG = (() => {
  const base = WINGET_PACKAGES;
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
 * 项目风格 → gen.py `--style` 预设名。**这张表是"画面像不像"的真正开关。**
 *
 * gen.py 的预设只有 `realistic/anime/cyberpunk/healing/vintage/none`，
 * **没有 3D 卡通档**，所以 `cartoon3d` 只能投降映射成 `anime`（本地 A/B 实测观感最接近）。
 * 注意 `anime` 的负向词里也含「3D渲染」，同样是妥协 —— 这是上游通道的能力边界，不是本仓能修的。
 *
 * 🔁 **2026-09-17 实测：本地资产的画面风格一直不受控，根因就在这里。**
 *    `realistic` 预设的**负向词里写着「CG感，卡通，动漫」**，正向词还会追加
 *    「写实摄影风格…生活快照般随手抓拍」。于是 prompt 里写多少「3D 卡通动画长片质感」
 *    都被负向条件抵消 —— **改 prompt 措辞根本无效，因为负向条件不在我们手里**。
 *
 * 🔁 **2026-09-20：edit 分支也必须吃这张表。** gen.py 的 `build_edit` 过去把 negative
 *    **硬编码成空串**且不接受 `--style`，本仓据此不给图生图传它。后果是身份图与
 *    **全部关键帧**（两者都走 edit）拿到空的负向条件，写实剧被系统性画成插画
 *    —— 而 t2i 的肖像与场景主图因为有这张表一直正常。上游已修。
 *    判据：**任何走 edit 的产物都必须显式传 `--style`**，不传就是把这个洞重新打开。
 */
export const LOCAL_STYLE = {
  realistic: 'realistic',
  anime: 'anime',
  cartoon3d: 'anime',
  cyberpunk: 'cyberpunk',
  healing: 'healing',
  vintage: 'vintage',
};

/** 未知风格**显式给 `none`**，不要退回 gen.py 的默认 realistic —— 那条路的负向词会反卡通，静默把画面拉走。 */
export function localStyle(style) {
  return LOCAL_STYLE[style] || 'none';
}

/**
 * 参考图降采样。
 *
 * 实测：直接喂 2688×1536 的身份图，单张关键帧要 **121 秒**。
 * 参考图不需要那么大 —— 缩到 1024 长边，编码快很多，而一致性靠的是内容不是像素。
 * （2.1 家族节点自带 `resolution` 缩放，这里仍先缩 —— 上传字节少、历史行为不变。）
 * @returns {{files: string[], cleanup: () => void}}
 */
function shrinkRefs(images, maxEdge = 1024, fit = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-ref-'));
  const out = [];
  for (const [i, src] of (images || []).entries()) {
    const dst = path.join(dir, `ref${i}.png`);
    // `fit` 给了就"等比缩进 + 补边"到目标画布。
    //
    // **为什么必须这么干**：本地 Qwen-Image-Edit 的**输出画幅就是输入画幅** ——
    // `gen.py` 的 edit 分支压根不接 `width`/`height`（只有 t2i 分支接）：
    //     prompt, width=width, height=height, ...   ← t2i
    //     prompt, uploaded, ...                     ← edit
    // 实测：喂 16:9 的身份图出 1328×800、喂 1:1 的肖像出 1024×1024，
    // 四张竖屏关键帧**一张都没落位**（工程的画幅核对拦下的）。
    // 我们的肖像与身份图底色本身是纯灰，补灰边是无缝的。
    const vf = fit
      ? `scale=${fit.w}:${fit.h}:force_original_aspect_ratio=decrease,`
        + `pad=${fit.w}:${fit.h}:(ow-iw)/2:(oh-ih)/2:color=0x808080`
      : `scale='min(${maxEdge},iw)':'min(${maxEdge},ih)':force_original_aspect_ratio=decrease`;
    const ok = spawnSync(FFMPEG, [
      '-y', '-i', src,
      '-vf', vf,
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
  const py = requireComfyPython();
  const r = spawnSync(py, [GEN, ...args], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  let parsed = null;
  try { parsed = JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch { /* 非 JSON 输出就忽略 */ }
  return { status: r.status, stderr: r.stderr || '', json: parsed };
}

function normalizeImages(files, target) {
  if (!target) return files;
  for (const file of files) {
    const temp = file + '.normalized.png';
    const vf = `scale=${target.w}:${target.h}:force_original_aspect_ratio=decrease,`
      + `pad=${target.w}:${target.h}:(ow-iw)/2:(oh-ih)/2:color=0x808080`;
    const ok = spawnSync(FFMPEG, ['-y', '-i', file, '-vf', vf, '-frames:v', '1', temp], { stdio: 'ignore' }).status === 0;
    if (ok && fs.existsSync(temp)) {
      fs.copyFileSync(temp, file);
      fs.rmSync(temp, { force: true });
    }
  }
  return files;
}

/** 文生图。`--batch` 是 gen.py 的批量参数（**只对 t2i/music 有效**）。 */
export async function generate({ prompt, ratio = '16:9', n = 1, outDir, prefix = 'img', style, fast = true, width, height, steps, cfg, lora, imageModel = LOCAL_IMAGE_MODEL, timeoutMs = 900000 }) {
  fs.mkdirSync(outDir, { recursive: true });
  const before = snapshot(outDir);
  const args = ['t2i', '--prompt', prompt, '--batch', String(n), '--out-dir', outDir];
  // 画幅：显式宽高优先，其次 ratio。**不传的话走 IMAGE_DEFAULT = (1024,576) 横屏。**
  if (width && height) args.push('--width', String(width), '--height', String(height));
  else args.push('--ratio', ratio);
  args.push(...imageModelArg(imageModel));
  args.push(...stepArgs({ steps, cfg, lora, fast, imageModel }));
  if (style) args.push('--style', style);
  const r = run(args, timeoutMs);
  return { files: newFiles(outDir, before), status: r.status, stderr: r.stderr, json: r.json };
}

/**
 * 步数 / `--fast` / LoRA 的取舍 —— **按图像模型家族分开**。
 *
 * 两个家族的采样参数完全不同：
 *   · `qwen21`（Qwen Image 2.1，默认）：官方档 25 步 cfg 1，**没有**蒸馏/加速 LoRA
 *     （骨架与旧 Qwen 不同，挂旧 LoRA 是错配 —— 上游会直接拒绝，这里提前拦并说清楚）。
 *     想快只能减 steps，画质同步下降。
 *   · `qwen`（旧 Qwen-Image / Qwen-Image-Edit 2511）：三种情况分开处理：
 *     - **给了 lora** → 成套下发 lora + steps + cfg（配错，比如 8 步 LoRA 配 20 步，会糊）；
 *     - **给了 steps/cfg 但没给 lora** → 按“跑 N 步基础模型”处理，**不挂 `--fast`**，
 *       否则是"4 步 LoRA + N 步 + cfg 1.0"这种谁都没验证过的组合；
 *     - **都没给** → `--fast` 让上游挂通道自己的默认 LoRA。
 */
function stepArgs({ steps, cfg, lora, fast, imageModel }) {
  if ((imageModel || LOCAL_IMAGE_MODEL) === 'qwen21') {
    if (lora) {
      throw new Error('Qwen Image 2.1 没有可用的蒸馏/加速 LoRA（骨架与旧 Qwen 不同）；要更快请减小 steps，或退回 imageModel="qwen"');
    }
    const out = [];
    if (steps) out.push('--steps', String(steps));
    if (cfg) out.push('--cfg', String(cfg));
    return out; // 2.1 无 --fast 档，fast 被忽略
  }
  if (lora) {
    return ['--lora', lora, '--steps', String(steps ?? 20), '--cfg', String(cfg ?? 4)];
  }
  const out = [];
  if (steps) out.push('--steps', String(steps));
  if (cfg) out.push('--cfg', String(cfg));
  if (fast && !steps) out.push('--fast');
  return out;
}

/** 家族值必须显式校验：拼错只会落到上游 argparse 的报错，晚而且难读。 */
function imageModelArg(imageModel) {
  const v = String(imageModel || LOCAL_IMAGE_MODEL).toLowerCase();
  if (!['qwen21', 'qwen'].includes(v)) throw new Error(`imageModel 只能是 qwen21 / qwen，收到 ${v}`);
  return ['--image-model', v];
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
 *
 * `style` 现在**必须传**（2026-09-20 修）：gen.py 的 edit 分支过去把 negative 硬编码成空串，
 * 画质预设完全不参与 —— 写实剧的身份图与关键帧被系统性画成插画，而 t2i 因为有
 * `realistic` 的负向词「CG感，卡通，动漫」一直正常。上游已改成 edit 也取预设，
 * 这里负责把它送过去。**不传 = 落回 gen.py 的默认 realistic**，显式传才与项目风格一致。
 */
export async function edit({ images, instruction, n = 1, outDir, prefix = 'edit', fast = true, ratio, width, height, steps, cfg, lora, style, imageModel = LOCAL_IMAGE_MODEL, timeoutMs = 900000 }) {
  fs.mkdirSync(outDir, { recursive: true });
  const ratioSize = {
    '16:9': { w: 1024, h: 576 },
    '9:16': { w: 576, h: 1024 },
    '1:1': { w: 1024, h: 1024 },
  }[ratio];
  const target = (width && height) ? { w: width, h: height } : ratioSize;
  const { files: refs, cleanup } = shrinkRefs(images, 1024, target || null);
  const files = [];
  let lastErr = '';
  try {
    for (let i = 0; i < Math.max(1, n); i++) {
      const before = snapshot(outDir);
      const args = ['edit'];
      for (const img of refs) args.push('--image', path.resolve(img));
      args.push('--prompt', instruction, '--out-dir', outDir);
      // **画幅一定要传，而且要传宽高、不能只传 ratio。**
      //
      // 旧家族（qwen）：edit 输出画幅跟着参考图走，`--ratio` 被忽略 ——
      // 只有显式宽高能定住它。2.1（qwen21）没有这个问题（画布由 EmptyLatentImage
      // 决定），但显式传无害且与旧家族行为一致。
      if (target) args.push('--width', String(target.w), '--height', String(target.h));
      else if (ratio) args.push('--ratio', ratio);
      args.push(...imageModelArg(imageModel));
      args.push(...stepArgs({ steps, cfg, lora, fast, imageModel }));
      if (style) args.push('--style', style);
      if (n > 1) args.push('--seed', String(1000 + i * 7919));   // 固定但互不相同的种子：可复现
      const r = run(args, timeoutMs);
      if (r.status !== 0) lastErr = r.stderr || `exit ${r.status}`;
      files.push(...normalizeImages(newFiles(outDir, before), target));
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
