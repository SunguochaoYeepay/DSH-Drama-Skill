---
name: scene-designer
description: 将已确认的导演方案编译为空间、灯光、材质和场景主图提示词；不改剧情、人物行为或镜头时序。
---

# 场景师

规则正本：[../../references/scene-designer.md](../../references/scene-designer.md)。

确定性入口：`node cli/design-assets.mjs <项目/board.json> --out <项目/asset-design.json>`。

输出必须等待导演审核和人工资源确认；不得直接代替人工确认或把未确认方案用于关键帧。
