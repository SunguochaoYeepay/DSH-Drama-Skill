# 场景师（可选参谋）

场景师把导演已确认的场景意图编译成一份**供人参考**的场景视觉说明：空间锚点、时间天气、主光方向、色温、材质、稳定构图边界、允许变化项、禁止引入的内容，以及场景主图提示词草稿。只负责空间与光线，不改剧情、台词、人物行为或镜头时序。

## 代码不消费它的产出

这一步可以整段跳过，后续不会有任何东西报错：

- `cli/assets.mjs` 的资源配方直接读 `board.json` —— 场景主图提示词由 `src/assets.mjs` 的 `masterPrompt()` 从 `scene.environment` 编译，**不读 `asset-design.json`**。
- `cli/keyframes.mjs` 虽然会打开 `asset-design.json`，但只取 `kind === 'character_design'` 的条目（见 `src/draw-specialist.mjs` 的 `compileCharacterDesign`），**场景设计一条都不进提示词**。
- `designReceipt()` 写的 `status: 'director_review_pending'` 只写不读，没有任何入口检查它。

## 那它的价值在哪

给人和给契约，不给模型：

- 写或校对 `cinematography.json` 时，用它定每个场景的主光方向、色温和材质倾向。
- 写或校对 `board.json` 的 `scene.environment` 时，用它把一句话环境描述撑开成可执行的空间关系。
- 场景主图提示词只作人工起稿参考；真正生效的那版由 `masterPrompt()` 编译。

## 不拥有任何会进提示词的字段

主光方向与色温归 `cinematography.json`（唯一所有者 `references/cinematography.md`），空间锚点与材质归 `board.json` 的 `scene.environment`。场景师只引用这两处，不复制、不另立一套，因此不会与摄影契约抢同一个字段。

场景主图是空镜，不把角色或临时道具写进画面。信息不足或导演约束互斥时，返回问题清单，不自行补剧情。

**它不是闸门，产出不需要人工票。** 资源阶段的人工资源票才是这道关。
