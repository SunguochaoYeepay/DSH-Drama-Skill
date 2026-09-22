/**
 * 一个通道到底能挂几张参考图。
 *
 * **容量由「通道 + 图像模型家族」共同决定，不是全局常量。**
 *
 * 起因（2026-09-21 实测）：本文件原先硬编码 `provider === 'huimeng' ? 9 : 3`，
 * 而本地通道早已默认切到 Qwen Image 2.1。上游源码写着：
 *   `graphs.py:47`  参考图上限：旧家族 3 张 / **2.1：16 张**（COMFY_AUTOGROW_V3）
 *   `graphs.py:73`  `QWEN21_MAX_IMAGES = 16`
 *   `graphs.py:679` `build_image21` 只在 `len(images) > 16` 时报错
 *   `gen.py:429`    `--image` 是 `action="append"`（可重复，不设上限）
 * 于是「连续承接 = 交接帧 + 场景 + 2 名角色 = 4 张」被本仓自己拦住，
 * 报 `连续承接需要 4 张参考图，local 上限 3` —— **而通道其实吃得下**。
 *
 * **放开的是容量，不是质量承诺。** 参考图变多会不会互相干扰，仍是需要
 * 「同镜 3 张 vs 全给」对照才能判的行为问题（同类浮注见 `src/assets.mjs`）。
 * 这里只做一件事：让上限说真话，不再把 2.1 的能力当成 3。
 *
 * 百炼 / 火山保持 3：它们的多参考上限没有像 2.1 这样在上游源码里写死，
 * 不跟着一起放开。
 */
export function refImageLimit(provider, imageModel = null) {
  if (provider === 'huimeng') return 9;
  if (provider === 'local' || provider === 'comfyui') {
    return String(imageModel || '').toLowerCase() === 'qwen21' ? 16 : 3;
  }
  return 3;
}

export function withHandoffReference(refs, stableFrame, provider, { imageModel = null } = {}) {
  const limit = refImageLimit(provider, imageModel);
  const combined = [{ file: stableFrame, role: 'handoff' }, ...refs];
  if (combined.length > limit) {
    throw new Error(`连续承接需要 ${combined.length} 张参考图，${provider} 上限 ${limit}；请调整构图或减少参考职责，不能静默丢掉角色`);
  }
  return combined;
}
