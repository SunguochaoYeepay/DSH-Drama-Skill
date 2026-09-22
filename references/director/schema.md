# 导演交什么 —— 格式与含义

> 你交一份 JSON。**下面的格式与边界是硬性要求**，人工会据此判断这一稿能不能用。
> 它约束的是"技术错误"，不是你的创作 —— 但有一条是死线：**你没有资格写台词**。

---

## 整体形状

```jsonc
{
  "logline": "一句话概括你的处理思路（给人看的，不是校验字段）",

  "version": 6,
  "units": [                          // 连续表演单元。**每个 ≤15 秒**
    {
      "id": "u1",
      "boundary_trigger": "opening",
      "keyframe_cast": ["c_001_default", "c_002_default"],
      "action_complexity": {
        "level": "medium",
        "high_risk_events": [
          { "at_s": 3.2, "type": "multi_actor_contact", "description": "她扑进他的怀里，由分离变为接触" }
        ],
        "strategy": "single_transition"
      },
      "why": "为什么这些镜头适合放在同一次生成里",
      "duration_reason": "台词最低3.7秒，表演与停顿1.0秒，因此取4.7秒",
      "keyframe_start": "0秒时她刚转头看向画面右侧，嘴唇闭合，尚未开始说话",
      "end_state": "两人仍在道路上稳定站立，身体未发生接触",
      "continuity": { "mode": "independent", "reason": "开场" },

      "shots": [                      // 单元内部的镜头。可以任意多
        {
          "n": 1,
          "at": 0.0,                  // 在**本单元内**的起点，秒
          "duration_s": 4.2,

          "framing": "全景",
          "camera": "固定",
          "scene": "scene_01",
          "on_screen": ["c_001_default", "c_002_default"],
          "props": [],

          "action": "两人在林间古道走着，他略前半步，她落后半步跟着",
          "emotion_analysis": [
            {
              "character": "c_001_default",
              "cause": "两人仍在安全的同行状态",
              "internal_state": "平静",
              "visible_behavior": "肩背放松，步幅稳定，嘴部自然闭合",
              "gaze": "看向前方道路",
              "avoid_symbols": ["惊恐瞪眼", "夸张微笑"]
            }
          ],
          "lighting": "晨光斜射穿过枝叶，空气通透",

          "lines": [],                // 这一镜里说**第几行台词**（剧本行号）
          "audio": "脚步踩在石板路上，树叶沙沙"
        },
        {
          "n": 2,
          "at": 4.2,
          "cut": "the camera cuts to",  // 从上一镜怎么过来
          "duration_s": 3.3,
          "framing": "近景",
          "camera": "固定",
          "on_screen": ["c_002_default"],
          "facing": { "c_002_default": "right" },
          "action": "她侧头看他，眼里带笑",
          "lines": [16],
          "audio": "树叶沙沙"
        }
      ]
    }
  ]
}
```

---

## 字段含义

### `units[]` —— 生成单元

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 随便起，但要唯一 |
| `why` | ✅ | 为什么这些镜头适合共享一次生成和一张首帧 |
| `audience_knows` | ✅ | 这一单元**开始时**，观众知道什么、角色知道什么，写成一句对比（例：`观众已经看见猫把花盆踩翻出外沿，她还低着头没往上看`）。它管的是**悬念与因果**：意外必须有来路，观众与角色必须有一次知情错位，否则只剩惊吓。**没写就等于没想过这件事** —— 提示词、参考图配额、镜头切分都不会替你问这个问题 |
| `duration_reason` | ✅ | 台词、动作、反应和停顿如何共同决定时长 |
| `keyframe_start` | ✅ | 0 秒首帧的确切状态：同时写静态动作、景别/画面截取范围、机位/构图、可见角色与空间关系，以及尚未发生的动作；不写整段动作结果 |
| `boundary_trigger` | ✅ | 第一单元为 `opening`；后续只允许 `scene_change` / `time_jump` / `identity_anchor` / `spatial_reset` / `state_transition_anchor` / `engine_limit` 六类硬理由 |
| `keyframe_cast` | ✅ | 0 秒关键帧需要身份参考的角色，必须是本单元角色子集；本地 Qwen 最多 2 名 |
| `action_complexity` | ✅ | H3 动作复杂度；每单元最多一个高风险状态转换 |
| `end_state` | v6 必填 | 单元应停住的稳定、可观察状态，供下一单元承接和实际尾帧核对。**它只是核对基准，不进生成提示词** —— 时间线由 `shot.action` 的文本决定；要让单元真的停在这个状态，必须把结尾动作写进该单元**最后一镜的 `action`**（只把单元时长加长是无效的，`desk_quake` 2026-09-22 实测：5.0s→6.0s 仍停在仰头喝水，把"咽下后放下杯子"写进 `action` 才走到位） |
| `continuity` | v6 必填 | 第一单元为 `independent`。后续可为 `independent`；若关键帧必须参考上一段实际尾帧，使用 `reference_previous` 并提供 `previous_unit/deferred_keyframe:true/allowed_changes`；若还必须继承动作状态，使用 `continue_previous` 并额外提供 `handoff_state` |
| `shots` | ✅ | 至少一镜 |

> **一个单元 = 一次生成 = 一个连续的世界。**
> 里面的镜头共享一张 0 秒关键帧。换说话人、动作或景别不自动产生新关键帧；
> 只有 `boundary_trigger` 的硬理由成立时才开启新单元。

`action_complexity.high_risk_events[].type` 只能是：
`multi_actor_contact` / `possession_change` / `appearance_or_disappearance` /
`large_displacement` / `transformation` / `spatial_reconfiguration`。
`strategy` 只能是 `none` / `single_transition` / `simplified_staging`。

### `shots[]` —— 镜头

| 字段 | 必填 | 约束 |
|---|---|---|
| `n` | ✅ | 单元内从 **1** 开始，连续不跳号 |
| `at` | ✅ | 在**本单元内**的起点（秒）。**第 1 镜必须是 0**；后面严格递增 |
| `duration_s` | ✅ | > 0。**`at` + `duration_s` 不能超过 15** |
| `framing` | ✅ | 只能是 `远景` / `全景` / `中景` / `近景` / `特写` |
| `camera` | ✅ | 摄影机怎么动。`固定` / `缓慢前推` / `小幅左移` / `跟随` … |
| `scene` | ✅ | 板子里已有的 `scenes[].id`。每一镜必须明确落在哪个场景，不能由执行器猜 |
| `on_screen` | ✅ | 画面里有谁。**必须用板子里已有的造型 id**（见输入材料） |
| `props` | ✅ | 画面使用的道具 id；没有就填 `[]` |
| `action` | ✅ | 这一镜里**画面发生什么** —— 谁在做什么、什么表情 |
| `lighting` | 建议 | 光的氛围描述。不写的话沿用场景默认 |
| `lighting_setup` | 可选 | 结构化光：`key_direction` / `quality` / `ratio` / `temperature` / `fill` / `rim` / `practicals`。**逐项**覆盖项目摄影契约，没写的项仍继承 |
| `optics` | 可选 | 覆盖项目摄影契约的镜头参数：`lens_mm` / `depth_of_field` / `camera_height` |
| `rule_overrides` | 可选 | 翻转项目契约里的全片物理规则：`{ "<规则 id>": "本镜的例外写法" }`。**空串＝本镜不适用这条**。只影响本镜 |
| `lines` | 建议 | 这一镜里说了**第几行台词**（剧本行号）。不说就空数组 |
| `facing` | 正反打必填 | 谁朝画面哪边看：`left` / `right` / `toward` / `away` |
| `looks_at` | 可选 | 谁在看谁：`[{"who":"c_002_default","at":"c_001_default"}]`。⚠ 它编译出来是**全程约束**（「始终注视…全过程不看镜头」），不是"起始时在看"。**只在这一镜里双方确实一直互相注视时才写**；如果这一镜中途有人把视线移开（听到画外的动静、被别的东西吸引），**不要写** —— 它会和镜头动作里的转向直接打架。`pot_hit`（2026-09-20）实测：`looks_at` 要求大爷全程盯着棋友，而那一镜的戏恰恰是两人一起转向门洞；删掉它之后动作才成立 |
| `emotion_analysis` | v5 必填 | 每个 `on_screen` 角色各一项：`character/cause/internal_state/visible_behavior/gaze/avoid_symbols`；角色不能遗漏或重复 |
| `audio` | 建议 | 环境音。**不要写台词** |
| `cut` | n≥2 必填 | 从上一镜怎么过来。用词见下 |

### `cut` 的合法用词（这是 H3 认的表）

```
the camera cuts to
the shot cuts to
the shot transitions to
the shot changes to
the shot switches to
```

**第 1 镜不能有 `cut`**（它没有上一镜）。

---

## ⛔ 你没有资格做的事

**1. 你不能写台词。**

`lines` 里填的是**行号**，不是文字。台词原文会由代码逐字搬进来。

> 你的输出里**任何一句剧本台词的文字**都会导致**校验失败**。
> 这是死线 —— 因为台词要一字不差，而"生成文字"这件事天生做不到一字不差。

**2. 你不能超过 15 秒。**

`at + duration_s` 超过 15 的单元会被退回。这是引擎的硬上限，不是建议。
**15 秒不是目标。** 内容只需要 4 秒就设计成 4 秒；长对白真正需要 12 秒就使用 12 秒。

**镜头也不能短于台词的最低口播时间。** 输入材料会在每个台词行号旁标出最低秒数，
人工会逐镜核对；短于该时间的镜头不可用。

**3. 你不能用不存在的人。**

`on_screen` 和 `facing` 的键必须是输入材料里给出的造型 id。

**4. 你不能漏台词、也不能重复放台词。**

剧本里的每一句台词，**必须在某一镜的 `lines` 里出现，且只出现一次**。

---

## 你会收到的输入

跑的时候会给你这些：

```
剧本全文（带行号）        ← 台词行号就是从这里来的
人物与造型（id + 长相 + 服装）
场景（id + 环境描述）
道具（id + 描述）
本片画幅（竖屏 9:16 之类）
```

**台词行号以剧本原文为准**，例如：

```
 16: 小师妹（眉眼带庆幸，语气温软）：大师兄，昨天晚上，谢谢你救了我。
                                              ↑ 行号 16
```

那么这一句就该写成 `"lines": [16]`，**而不是**把「大师兄，昨天晚上…」抄进去。

---

## 交之前自己数一遍

```
□ 每个单元 ≤ 15 秒
□ JSON 顶层是 `"version": 6`
□ 每个单元都有 why / duration_reason / keyframe_start
□ 每个单元都有合法 boundary_trigger；不能用“节奏需要”冒充关键帧理由
□ 每个单元都有 action_complexity；高风险状态转换不超过一个
□ 每镜的 at + duration_s ≤ 15
□ 每句台词的镜头时长 ≥ 输入给出的最低口播秒数
□ 每个单元都写了 `audience_knows`，而且**至少有一处观众与角色的知情是错位的**（先让观众看见危险，再让角色走进危险）
□ 每一个「突然发生」的事都有观众看得见的来路（谁碰的、什么松了、为什么是现在）——**没有来路的事件，观众看到的是「道具自己动了」**
□ 落物与运动有**正上方的落点**，而且被砸/被撞的人**先站到了落点上**。这个空间关系必须写进 `keyframe_start`，不要只在文字里写一句「从正上方落下」——**文字对、调度错，是最常见的一种自相矛盾**
□ 内容总时长和按每单元至少 5.17 秒计算的预计交付时长，都不超过**用户立项时确认的时长**的 10% 余量。⚠ 「契约目标」= 用户确认的时长，**不是** `board.meta.total_duration_s` —— 后者只是索引编译器按「索引镜头数 × 约 3 秒」对剧本长度的估算。交叉剪辑结构（单元多、单元内还切镜）下它会明显偏低：`pot_hit`（2026-09-20）实测索引估算 29s、用户确认「约 36 秒」、导演稿 33.1s。两者不一致时以用户确认为准，并在闸门上把差额说明给人听
□ 第 1 镜 at = 0，后面严格递增，n 连续
□ 剧本每一句台词都出现了，且只出现一次
□ 正反打的两人 facing 相反
□ on_screen 里全是输入材料给过的 id
□ 每镜 emotion_analysis 覆盖全部 on_screen 角色，情绪由剧情事实推导，外显动作可被摄像机观察
□ 每单元有稳定 end_state；连续单元标记 continue_previous，关键帧延迟到上一段视频通过后生成
□ 我没有在任何地方写出台词原文
```
