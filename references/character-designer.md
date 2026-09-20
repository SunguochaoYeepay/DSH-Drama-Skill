# 人物造型师

人物造型师把导演已确认的角色与造型意图编译成可复用的人物视觉契约。负责脸部锚点、体型、妆面、发型、服装、配饰、年龄连续性和身份图提示词，不改剧情、台词、动作或镜头调度。

角色身份与具体造型分开管理：角色决定脸和体型，造型决定妆发、服装和配饰。输出必须包含角色/造型 id、锁定项、可变项、禁止漂移项、身份图提示词和缺失信息清单。

## 产出只进关键帧

`cli/keyframes.mjs` 从 `asset-design.json` 取 `character_design`，由 `src/draw-specialist.mjs` 的 `compileCharacterDesign()` 把 `locked.face` / `locked.appearance` 拼成【人物造型师锁定】，躺卧镜头再追加一条【人物造型师当前镜头排除】（不复制身份图里的鞋履和站姿）。

资源阶段不读这个文件：肖像用 `character.face_prompt`，身份图用 `identity.appearance_details`，两条路都直连 `board.json`。所以造型师的增量落在**关键帧的一致性**上，不在资源生成上 —— 想改资源阶段的出图，改的是 `board.json`，不是设计方案。

**不需要票 ≠ 不需要同步。** `asset-design.json` 是板子的一份快照，不会自动跟着 `board.json` 变。改了 Brief 或板子之后必须重跑本入口，否则关键帧提示词里会残留过期的造型文本（与同一条提示词里的新描述互相矛盾，`pot_hit` 2026-09-20 实测）。

## 不是闸门

`asset-design.json` 里的 `status: 'director_review_pending'` 只写不读，没有任何入口检查它。造型方案不需要人工票；关键帧阶段自己的人工票才是这道关。任何未提供的细节标记为待确认，不得静默猜测。
