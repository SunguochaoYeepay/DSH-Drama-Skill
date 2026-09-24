import { loadWorkflow } from './comfy-workflow.mjs';

export { loadWorkflow as loadVoidWorkflow };

/**
 * **VOID 去字幕**：把"声明好的字幕带"变成 VOID 工作流的 quadmask。
 *
 * ## 为什么是这条路（B 路线）
 *
 * VOID 自带的工作流用 `SAM3_Detect(text=...)` 出掩码，但实测：
 * · 文字提示认不出烧入的中文字幕（`subtitle`/`caption`/`text` 全圈不到）
 * · 点提示落在字形缝隙里，会把背后的毛衣当成目标
 * 而字幕位置对我们是**已知的固定带**（`cli/desub.mjs --top/--bottom` 早就有这个约定，
 * `cli/subcheck.mjs` 里也记过实测值）—— 这件事根本不需要模型。
 *
 * ## 极性（踩过一次）
 *
 * VOID 的 quadmask 是「**白=保留，黑=要修**」，与 ComfyUI 的常规相反。判定的办法：
 * · 全白掩码 → 输出与原片一模一样（全部保留 = 透传）
 * · 白带黑底 → 输出变成无关画面（只保留那条带 = 其余全被重画）
 * 掩码由 `tools/band_mask.py` 按这个极性生成（带子黑、其余白），这里只负责读入与接线。
 *
 * ## 边界
 *
 * 只做"把带内重画掉"，不做任何识别；带错了就会重画错的地方 —— 所以带必须由人/声明给。
 */

/**
 * 百分比带 → 像素矩形（含边界钳制与最小尺寸校验）。
 *
 * **取整方式必须与 `tools/band_mask.py` 一致**（两条边各算各的再相减）：
 * 掩码是按那个脚本画的，这里若按"宽度 = 比例×宽"另算一遍，两者会差 1 像素 ——
 * 于是"我量的带"和"我修的带"不是一个带。`tests/void-desub.test.mjs` 里有等价性断言。
 */
export function bandToPixels(band, { width, height }) {
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const top = num(band.top, 0.7);
  const bottom = num(band.bottom, 0.8);
  const left = num(band.left, 0.28);
  const right = num(band.right, 0.72);
  for (const [k, v] of Object.entries({ top, bottom, left, right })) {
    if (!(v >= 0 && v <= 1)) throw new Error(`字幕带 ${k}=${v} 必须在 0~1 之间`);
  }
  if (!(bottom > top)) throw new Error(`字幕带 bottom(${bottom}) 必须大于 top(${top})`);
  if (!(right > left)) throw new Error(`字幕带 right(${right}) 必须大于 left(${left})`);
  if (!(width > 0 && height > 0)) throw new Error(`视频尺寸非法：${width}x${height}`);

  const x0 = Math.max(0, Math.min(width - 1, Math.round(left * width)));
  const y0 = Math.max(0, Math.min(height - 1, Math.round(top * height)));
  const x1 = Math.max(x0 + 1, Math.min(width, Math.round(right * width)));
  const y1 = Math.max(y0 + 1, Math.min(height, Math.round(bottom * height)));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** 按 class_type / _meta.title 找节点，找不到就报清楚（不静默走错节点）。 */
function findNode(graph, predicate, what) {
  for (const [id, node] of Object.entries(graph)) {
    if (predicate(node, id)) return { id, node };
  }
  throw new Error(`工作流里找不到${what}`);
}
const byClass = (c) => (n) => n.class_type === c;
const byTitle = (kw) => (n) => String(n._meta?.title || '').includes(kw);

/**
 * 把一个 API 格式的 VOID 工作流改造成"用声明带掩码去字幕"。
 *
 * @returns {{graph: object, plan: object}} 改造后的图与它做了什么
 */
export function buildVoidDesubGraph({
  workflow,
  videoWidth,
  videoHeight,
  band,
  passes = 2,
  durationSeconds = null,
  maskFileName,
  prompt = 'a clean background matching the surrounding scene',
}) {
  if (!maskFileName) throw new Error('缺 maskFileName：掩码必须由 tools/band_mask.py 先生成再上传');
  const graph = structuredClone(workflow);
  const rect = bandToPixels(band, { width: videoWidth, height: videoHeight });

  const inpaint = findNode(graph, byClass('VOIDInpaintConditioning'), 'VOIDInpaintConditioning 节点');
  const widthNode = findNode(graph, byTitle('Width'), 'Width 节点');
  const heightNode = findNode(graph, byTitle('Height'), 'Height 节点');
  const durNode = findNode(graph, byTitle('duration'), '时长节点');
  const skipNode = findNode(graph, byTitle('Skip Pass 2'), 'Skip Pass 2 节点');
  const posNode = findNode(graph, byTitle('Positive Prompt'), 'Positive Prompt 节点');

  // 掩码走文件：`tools/band_mask.py` 生成"带子黑、其余白"的 PNG，上传后由这里读入。
  // 极性由那个脚本负责并在测试里断言（VOID 要的是"白=保留，黑=要修"）。
  graph.desub_mask = { class_type: 'LoadImageMask', inputs: { image: maskFileName, channel: 'red' } };
  graph.desub_quad = { class_type: 'VOIDQuadmaskPreprocess', inputs: { mask: ['desub_mask', 0], dilate_width: 0 } };

  inpaint.node.inputs.quadmask = ['desub_quad', 0];
  widthNode.node.inputs.value = videoWidth;
  heightNode.node.inputs.value = videoHeight;
  if (durationSeconds != null) durNode.node.inputs.value = Number(durationSeconds);
  skipNode.node.inputs.value = passes < 2;
  posNode.node.inputs.value = prompt;

  return {
    graph,
    plan: {
      band_px: rect,
      band_frac: band,
      video: { width: videoWidth, height: videoHeight },
      passes,
      mask_file: maskFileName,
      wired: {
        quadmask_from: inpaint.id,
        width_node: widthNode.id,
        height_node: heightNode.id,
        duration_node: durNode.id,
        skip_pass2_node: skipNode.id,
        positive_node: posNode.id,
      },
    },
  };
}
