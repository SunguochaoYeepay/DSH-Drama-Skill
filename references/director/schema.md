# 导演交什么 —— 格式与含义

> 你交一份 JSON。**这份 JSON 会被逐字段校验**，不过就退回重做。
> 校验器挡的是"技术错误"，不是你的创作 —— 但有一条是死线：**你没有资格写台词**。

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
| `duration_reason` | ✅ | 台词、动作、反应和停顿如何共同决定时长 |
| `keyframe_start` | ✅ | 0 秒首帧的确切状态，只写动作起点，不写整段动作结果 |
| `boundary_trigger` | ✅ | 第一单元为 `opening`；后续只允许 `scene_change` / `time_jump` / `identity_anchor` / `spatial_reset` / `state_transition_anchor` / `engine_limit` 六类硬理由 |
| `keyframe_cast` | ✅ | 0 秒关键帧需要身份参考的角色，必须是本单元角色子集；本地 Qwen 最多 2 名 |
| `action_complexity` | ✅ | H3 动作复杂度；每单元最多一个高风险状态转换 |
| `end_state` | v6 必填 | 单元应停住的稳定、可观察状态，供下一单元承接和实际尾帧核对 |
| `continuity` | v6 必填 | 第一单元为 `independent`。后续为 `independent`，或 `continue_previous` 并提供 `previous_unit/handoff_state/deferred_keyframe:true/allowed_changes` |
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
| `lighting` | 建议 | 光。不写的话沿用场景默认 |
| `lines` | 建议 | 这一镜里说了**第几行台词**（剧本行号）。不说就空数组 |
| `facing` | 正反打必填 | 谁朝画面哪边看：`left` / `right` / `toward` / `away` |
| `looks_at` | 可选 | 谁在看谁：`[{"who":"c_002_default","at":"c_001_default"}]` |
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
校验器会逐镜计算；短于该时间会直接退回。

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
□ 内容总时长和按每单元至少 5.17 秒计算的预计交付时长，都不超过契约目标的 10% 余量
□ 第 1 镜 at = 0，后面严格递增，n 连续
□ 剧本每一句台词都出现了，且只出现一次
□ 正反打的两人 facing 相反
□ on_screen 里全是输入材料给过的 id
□ 每镜 emotion_analysis 覆盖全部 on_screen 角色，情绪由剧情事实推导，外显动作可被摄像机观察
□ 每单元有稳定 end_state；连续单元标记 continue_previous，关键帧延迟到上一段视频通过后生成
□ 我没有在任何地方写出台词原文
```
