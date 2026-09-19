/**
 * providers/index.mjs — 生图通道的路由。
 *
 * ## 当前决策（2026-09-19）：默认走本地 ComfyUI
 *
 * 用户决定不再依赖线上生图通道。所以 `AIH_ASSET_PROVIDER` / `AIH_KEYFRAME_PROVIDER`
 * 默认都是 `comfyui`；线上通道保留为**显式覆盖**（`--provider bailian`），不是默认路径。
 *
 * ## 这个默认值的已知代价（曾经的 A/B 实测，结论已反转但数据仍然有效）
 *
 * 同镜、同参考图，线上 qwen-image-3.0 对本地 Qwen-Image-Edit：
 *
 * | | 线上 qwen-image-3.0 | 本地 Qwen-Image-Edit |
 * |---|---|---|
 * | 构图是否对得上分镜 | ✅ 大师兄在前、小师妹在后 | ❌ 两人位置调换 |
 * | 人脸 | 真人质感、有细节 | 娃娃脸，头身比不对 |
 * | 服装/道具细节 | 薄纱层次、剑鞘都在 | 外衫发平，剑变小 |
 * | 耗时 | 133s | 120s |
 * | 价格 | 0.24 元/张 | 0 元 |
 *
 * 也就是说：**本地在构图、人脸、细节三项上确实更弱**，省下的只有钱（时间几乎一样）。
 * 走本地时要主动盯这三项 —— 关键帧是观众真正看到的画面，构图对不上分镜就得重抽，
 * 不能因为"本地不要钱"就接受明显跑偏的画面。
 *
 * 环境变量可覆盖：AIH_ASSET_PROVIDER / AIH_KEYFRAME_PROVIDER = comfyui | bailian | volcengine
 */

import * as bailian from './bailian.mjs';
import * as comfyui from './comfyui.mjs';
import * as volcengine from './volcengine.mjs';
import { ASSET_PROVIDER, KEYFRAME_PROVIDER } from '../config.mjs';

const REGISTRY = { bailian, comfyui, volcengine };

export function provider(name) {
  const p = REGISTRY[name];
  if (!p) throw new Error(`未知的生图通道 "${name}"，可用：${Object.keys(REGISTRY).join(' / ')}`);
  return p;
}

/** 资产默认走线上；没有线上通道就退本地，并说清楚为什么退。 */
export function assetProvider() {
  return provider(ASSET_PROVIDER);
}

export function keyframeProvider() {
  return provider(KEYFRAME_PROVIDER);
}

export const AVAILABLE = Object.keys(REGISTRY);
