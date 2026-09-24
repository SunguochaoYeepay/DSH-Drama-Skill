/**
 * 计划级"静默失败"检查：**在花钱出图之前，把"你以为发生了什么"和"实际会发生什么"对齐。**
 *
 * 来历（都是真事，不是假想）：
 *
 * 1. **缺落幅是静默的。** `provider=table_for_two` 那个项目里，g001 是唯一没有
 *    `keyframe-prompts/g001.last.txt` 的单元 → 它自动退回 i2v，**没有任何提示**。
 *    而 i2v 与 fl2v 的差别实测很大（相邻帧差中位 23.2 → 6.2、背景漂移 p90 130 → 50.5），
 *    失败的那一镜恰好就是唯一裸奔的那一镜。
 *
 * 2. **道具声明的和实际下发的是两回事。** 本地/百炼/火山通道的 `refsFor` 只下发
 *    「场景 + 身份」，**道具一张都不传**；而看板的「用到的资源」会把道具列出来。
 *    结果：操作者（包括写这份代码的我）会以为"每人面前一只盘子"作为参考图进了模型，
 *    于是往错误的方向找原因。**面板说的不等于模型看到的。**
 *
 * 两个函数都是纯函数，只返回给人看的建议字符串（无建议返回 null），
 * 不改变任何生成行为 —— 这条边界很重要：检查不该悄悄把流程改成另一个样子。
 */

/** 通道是否会把道具作为参考图下发。 */
export function channelPassesProps(channel) {
  // 只有绘梦那条老路把 `assets.props` 拼进参考图；本地/百炼/火山都不传。
  return channel === 'huimeng';
}

/**
 * 落幅建议。
 *
 * @param {object} o
 * @param {string} o.unitId
 * @param {boolean} o.hasLastKeyframe 实际解析到的落幅文件是否存在
 * @param {boolean} o.planDeclaresSlot 计划里是否声明了 `last_keyframe` 槽位
 * @param {boolean} o.hasLastPromptFile `keyframe-prompts/<unit>.last.txt` 是否存在
 * @returns {string|null}
 */
export function lastKeyframeAdvice({ unitId, hasLastKeyframe, planDeclaresSlot, hasLastPromptFile }) {
  if (hasLastKeyframe) return null;
  // 计划要落幅、或有人写了落幅直写文件，却没生成/没落到槽位 —— 这是"以为会走 fl2v，其实走了 i2v"，要喊。
  if (planDeclaresSlot && !hasLastPromptFile) {
    return `⚠ ${unitId} 计划声明了落幅槽位，但缺 keyframe-prompts/${unitId}.last.txt → 落幅不会生成，本镜退回 i2v（构图不受端帧约束）。`;
  }
  if (hasLastPromptFile) {
    return `⚠ ${unitId} 有 keyframe-prompts/${unitId}.last.txt，但落幅文件还没生成/没落到计划槽位 → 本镜会退回 i2v。先跑 keyframes --with-last。`;
  }
  // 这条项目本来就不用落幅：只报一句事实，不制造噪音。
  return `ℹ ${unitId} 本镜没有落幅，走 i2v：构图**不受端帧约束**（模型可自行改机位）。落点重要的镜头建议补 keyframe-prompts/${unitId}.last.txt。`;
}

/**
 * 道具/参考图建议：把"声明了什么"和"这一通道实际下发什么"摆在一起。
 *
 * @param {object} o
 * @param {string} o.unitId
 * @param {string} o.channel local / bailian / volcengine / huimeng
 * @param {number} o.refCount 实际下发的参考图张数
 * @param {string[]} o.declaredProps 单元声明的道具 id
 * @returns {string|null}
 */
export function referenceAdvice({ unitId, channel, refCount, declaredProps = [] }) {
  if (!declaredProps.length) return null;
  if (channelPassesProps(channel)) {
    return `ℹ ${unitId} 声明了 ${declaredProps.length} 个道具（${declaredProps.join('、')}），${channel} 通道会一并下发，共 ${refCount} 张参考图。`;
  }
  return `ℹ ${unitId} 本通道实际只下发 ${refCount} 张参考图（场景 + 身份），**声明的 ${declaredProps.length} 个道具（${declaredProps.join('、')}）不进参考图** —— 它们只出现在提示词文字里。别把道具当成空间锚去找原因。`;
}
