/**
 * providers/index.mjs — 生图通道的路由。
 *
 * 原判据是从 DramaClaw 的 `.env` 抄的：
 *   资产（角色肖像 / 身份图 / 场景 / 道具）→ **线上**：数量少、要一致性、要质量
 *   关键帧（批量草稿）                    → **本地**：数量多、要便宜、要快
 *
 * **但「关键帧走本地」这条被实测推翻了。** 同镜、同参考图 A/B：
 *
 * | | 线上 qwen-image-3.0 | 本地 Qwen-Image-Edit |
 * |---|---|---|
 * | 构图是否对得上分镜 | ✅ 大师兄在前、小师妹在后 | ❌ 两人位置调换 |
 * | 人脸 | 真人质感、有细节 | 娃娃脸，头身比不对 |
 * | 服装/道具细节 | 薄纱层次、剑鞘都在 | 外衫发平，剑变小 |
 * | 耗时 | 133s | 120s |
 * | 价格 | 0.24 元/张 | 0 元 |
 *
 * **时间几乎一样，只差 0.24 元。** 而关键帧是观众真正看到的画面 ——
 * 14 张也就 3.4 元换整片画质，这个账不用算。
 *
 * 本地通道保留：探构图、批量试错、线上不可用时兜底。
 *
 * 环境变量可覆盖：AIH_ASSET_PROVIDER / AIH_KEYFRAME_PROVIDER = bailian | comfyui | volcengine
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
