---
name: scene-designer
description: 将已确认的导演方案编译成场景视觉参考（空间、光线、材质、构图边界）；产出供人工撰写摄影契约与环境描述时参考，不进任何提示词，也不是闸门。
---

# 场景师（可选参谋）

规则正本：[../../references/scene-designer.md](../../references/scene-designer.md)。

确定性入口：`node cli/design-assets.mjs <项目/board.json> --out <项目/asset-design.json>`。

**产出不进提示词，也不需要人工票。** 资源阶段读 `board.json`，关键帧只取人物造型条目。它用于给人和给契约，不是给模型。整段跳过不会阻断后续任何步骤。
