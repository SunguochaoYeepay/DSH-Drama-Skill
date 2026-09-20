---
name: character-designer
description: 将已确认的导演方案和角色资料编译为脸部、妆发、服装、配饰及人物连续性提示词；产出只在关键帧阶段被消费，不改剧情或镜头调度。
---

# 人物造型师

规则正本：[../../references/character-designer.md](../../references/character-designer.md)。

确定性入口：`node cli/design-assets.mjs <项目/board.json> --out <项目/asset-design.json>`。

角色身份与具体造型分开维护。缺失细节必须列为问题，不得静默猜测。**产出只进关键帧**（资源阶段直连 `board.json`），不需要人工票。
