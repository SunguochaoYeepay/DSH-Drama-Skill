# whitebox-json — 白膜规划 JSON 规范（whitebox/1）

> 状态：v1 定稿（2026-09-28，whitebox-pipeline 分支）。这是「剧本 → 白膜 → 成片」链路里
> **AI 唯一要填的表**。AI 只做规划：不建模、不写 Blender 代码、不做骨骼绑定。

## 它解决什么

白膜锁三样 LLM 最难写对的东西：**空间关系、镜头、时序**。其余（光线、材质、表情、氛围）
本来就归提示词管，白膜不碰。

**三通道判据**（一个单元走哪条路，先看这个）：

| 通道 | 适用 | 依据 |
|---|---|---|
| 原路（提示词 + 首帧/落幅） | 文字写得清的：站、坐、对话、常规走位 | pilot-04：多人位置文字命中 11/12 |
| **白膜（本文档）** | 运动**能表示为刚体轨迹**的复杂：多人走位、机位同步、时序因果、刚体特技 | 坐标可控，预制动作/轨迹够用 |
| 真实参考视频 | 菜单外的**软组织连续动量**特技（空中转体、托马斯、后空翻） | 预制拼接断动量；`control_video` 不挑输入 |

判据的精确边界：**不是「复杂度」，是「运动能否表示为刚体轨迹」**。
飞机导弹交错 = 可拆解的复杂 ✅；人体极限特技 = 不可拆解的复杂 ❌（走参考视频）。

误判代价不对称：不该用用了 = 浪费几十秒渲染；该用没用 = 推翻整个单元。**宁多勿少。**
同一场戏里一个镜头命中，**整场戏都上白膜**（混用两套空间锚会剪不接）。

## 交付物（渲染器从一份 JSON 产出三样）

1. **白膜视频** → H3 Fun ControlNet `control_video`
2. **静帧**（`outputs.stills` 指定的帧）→ 首帧/落幅的构图基准 + 人工预检
3. **期望屏幕坐标表**（`outputs.screen_coords`）→ 生成后审核的标准答案（机器只报告不阻断）

三样从同一份坐标长出来，「关键帧和白膜视频对不上」在发生前被消灭。

## Schema

```jsonc
{
  "schema": "whitebox/1",            // 必填，版本标识
  "scene_name": "fight",             // 必填
  "total_frames": 168,               // 必填，1..10000
  "fps": 24,                         // 24 或 30（白膜帧率，对齐 H3 时自行换算）
  "stage": {                         // 必填
    "preset": "room",                // room | valley | empty
    "size": [8, 6, 3.2]              // room 必填：[x宽, y深, z高] 米；墙即边界
  },
  "assets": [ /* 至少 1 个，见下 */ ],
  "camera": { /* 见下 */ },
  "outputs": {
    "video": true,
    "stills": [1, 122, 168],         // 预检静帧 + 首帧/落幅基准
    "screen_coords": true
  },
  "notes": "自由文本，给审片人看"
}
```

坐标系：**X 左右，Y 纵深，Z 高度**，单位米，地面 z=0。角色位置是脚底 [x, y]。

### assets[] — 角色（kind: "character"）

```jsonc
{
  "asset_id": "A",                   // 字母开头，全场景唯一
  "kind": "character",
  "asset_type": "male",              // 只能从 manifest.roles 选：male | female | kid
  "clips": [                         // 按帧区间顺序排列，禁止重叠（允许留空档=离场）
    {
      "frame_range": [1, 48],
      "animation": "Walk_Loop",      // 只能从 manifest.animations 选，禁止编造
      "start_pos": [-1.35, -1.15],   // 必填
      "end_pos": [0.02, 0.20],       // 位移类动作必填（见下「位移类清单」）
      "facing": "auto_move",         // auto_move | towards:B | 角度数（0..360，0=+Y）
      "motion_curve": "ease",        // static | linear | ease（默认 ease）
      "blend_frames": 4              // 与下一段的 NLA 过渡帧数，0..12，默认 4
    }
  ]
}
```

规则：
- **facing 必填**。`auto_move` = 朝运动方向（位移段默认值）；`towards:<asset_id>` = 始终面朝某人；
  数字 = 世界角度。**不写朝向 = 歪着身子出拳**（fight.py 学费）。
- **blend_frames ≥3**。两段动画切换若姿态差大，0 过渡就是姿态瞬移 —— 白膜的存在意义
  是消灭瞬移，不能自己制造。渲染器强制执行，写 0 会被拒。
- 位移类清单（必须有 `end_pos`）：`Walk_Loop`、`Walk_Formal_Loop`、`Jog_Fwd_Loop`、
  `Sprint_Loop`、`Crouch_Fwd_Loop`、`Swim_Fwd_Loop`、`Driving_Loop`、`Push_Loop`、
  `Roll_RM`、`Sword_Attack_RM`。其余动作只需 `start_pos`（原地做）。
- 这些 loop 是 in-place 动画，平移由渲染器叠加 —— **白膜层面滑步可接受**
  （锁构图/时序，不锁脚部细节），成片外观由 H3 重绘。

### assets[] — 刚体道具（kind: "prop"）

```jsonc
{
  "asset_id": "jet1",
  "kind": "prop",
  "asset_type": "jet",               // 渲染器内置基本体：jet | missile | crate | car
  "color": 0.5,                      // 可选灰度覆盖 0..1
  "path": {                          // prop 用轨迹，不用 clips
    "frame_range": [1, 168],
    "waypoints": [[-6, -3, 8], [0, 0, 5], [3, 4, 1.5], [3.2, 4.5, 6]],
    "motion_curve": "ease",
    "bank": true,                    // 沿轨迹切线自动侧倾（飞机/导弹默认 true）
    "spin": [0, 0, 0]                // 可选：整段附加旋转总量（度）
  }
}
```

轨迹由渲染器做 Catmull-Rom 平滑插值，朝向 = 切线方向。waypoints ≥2，z 不得 < 0（穿地即拒）。
内置基本体只保证**剪影和比例正确**（白膜不需要细节）；尾焰/爆炸/烟雾是外观层，归 H3。

### camera — 参数化模板（不是枚举机位）

```jsonc
"camera": {
  "type": "pan-follow",              // static | dolly-in | pan-follow | orbit
  "track": "A",                      // pan-follow / orbit 必填：注视哪个 asset_id
  "keys": [                          // 至少 2 个（static 可 1 个），frame 升序
    { "frame": 1,   "angle": 233, "dist": 4.5, "height": 1.6, "fov": 35 },
    { "frame": 122, "angle": 190, "dist": 2.8, "height": 1.4, "fov": 42 },
    { "frame": 168, "angle": 152, "dist": 3.5, "height": 1.8, "fov": 35 }
  ],
  "shake": { "frame_range": [122, 168], "amp": 0.03 }   // 可选，指数衰减抖动
}
```

- `angle` = 方位角（度，绕注视点，0=+Y 方向看过去）；`dist`/`height` 米；`fov` 10..120。
- 机位由「注视点 + 方位角 + 距离 + 高度 + 焦距」逐帧反推（fight.py 的 `cam_at` 模式）。
- 四种类型差别只在注视点：`static`=固定点、`dolly-in`=固定点+dist 插值、
  `pan-follow`=track 对象、`orbit`=track 对象+angle 必须单调变化。

### 边界校验（渲染器硬性拒绝）

- 任何位置 |x| > size[0]/2 或 |y| > size[1]/2（出墙）；z < 0（穿地）
- 相机位置算出后在墙外（room 预设下）—— 出墙会渲出全灰空帧
- `outputs.stills` 帧号超出 [1, total_frames]

## 不适用（写进 schema 是为了让 AI 主动绕开）

- 菜单外的高难度连续特技（空中转体 / 托马斯 / 后空翻）→ 走真实参考视频通道
- 实时物理模拟（布料、碰撞、爆炸碎裂）→ 外观层，归 H3
- 面部表演、手指细节 → 提示词 + 参考图

## 流水线位置（后续步骤落地，此处仅约定）

```
direction.json →（三判据命中）→ whitebox/<unit-id>.json（本规范，Agent 直写，票 agent_draft）
  → 校验器（src/whitebox-schema.mjs）→ 静帧预检 → 人工确认 → 渲全片（白膜票，哈希绑 JSON）
  → H3 成片（clip 票）。改 JSON ⇒ 白膜票废 ⇒ clip 票连带废。
```

粒度：**一个编译单元 = 一个白膜 JSON = 一段白膜视频**。
