/**
 * loudness-policy.mjs — 合成时的**响度策略**（纯判据，不碰 ffmpeg）。
 *
 * ## 为什么需要"静音段"这一档（2026-09-24 `divorce_standoff` 实测）
 *
 * 合成是**逐段** loudnorm 到同一目标（`-16 LUFS`），这样段间响度差不会原样进成片。
 * 但 loudnorm 不知道"这一段本来就没内容"：g003 是"她一言不发地看着他"的反应镜，
 * 源片实测 mean **−51.3 dB**（只剩房间底噪），归一化把它**放大了约 37 dB** ——
 * 成片里那一段变成 mean −14.3 dB / max −2.0 dB，比周围有台词的段落还响，
 * 观众听到的是一段嘶声。逐段归一这条设计没错，缺的是"没有内容"这一档。
 *
 * 判据用整段实测响度（loudnorm 第一遍的 `input_i`）：真台词段不会低于 −40 LUFS。
 * `-inf` / 解析失败（全静音）也判为静音。阈值可被调用方覆盖（环境变量调试用）。
 */

/**
 * 低于它就别做响度归一（LUFS）。
 *
 * **为什么是 −50**：两个实测点把它夹出来的 ——
 *   · 真静音段（`divorce_standoff` g003，无台词反应镜）：**−53.0 LUFS**，只剩房间底噪；
 *   · "很轻但有内容"的夹具（`tests/assemble-review.test.mjs` 的 0.06 幅度素材）：**−46.2 LUFS**。
 * 取 −50 让两边各留约 3 LU 余量：既不会把底噪放大成嘶声，也不会把"轻素材"误跳过归一。
 * 不是"最优解"而是"有实测支撑的一条线"；可用 `AIH_ASSEMBLE_SILENT_LUFS` 覆盖。
 */
export const SILENT_LUFS = -50;

/**
 * 这一段是不是"没有内容的底噪"？
 *
 * @param {{input_i?: string|number}|null|undefined} measured loudnorm 第一遍的 JSON
 * @param {number} [floor] 阈值，默认 {@link SILENT_LUFS}
 * @returns {boolean} true = 跳过响度归一（保持原样），false = 照常归一
 */
export function isSilentSegment(measured, floor = SILENT_LUFS) {
  if (!Number.isFinite(Number(floor))) throw new Error(`静音阈值必须是数字，收到 ${floor}`);
  if (!measured) return false;                       // 第一遍就没量成：照旧归一（好过不做）
  const raw = measured.input_i;
  if (raw === undefined || raw === null || String(raw).trim() === '') return false;
  // `-inf` 是 loudnorm 对"全静音"的写法，它是**测出来的**结论，算静音。
  if (/^-?\s*(inf|infinity)/i.test(String(raw).trim())) return true;
  const i = Number(raw);
  if (!Number.isFinite(i)) return false;             // 其它读不懂的值：不改变行为
  return i <= Number(floor);
}
