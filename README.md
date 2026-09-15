# DSH-Drama-Skill

> **故事 → 分镜表 → 资产 → 关键帧 → 成片。**
> 一条**给 AI agent 用**的短剧流水线 —— 没有 Web UI，没有编排引擎，**AI 助手本人就是编排器**。

---

## 这是什么

把一段故事文本，编译成一部可以出片的短剧：

```
剧本.md
  │
  ├─ literal        纯代码把剧本切成镜头，**台词逐字保真**（模型碰不到台词）
  ├─ assets         人物肖像 / 身份图 / 场景 —— 线上生图
  ├─ durations      本地估每句台词要几秒（0 元、0 网络）
  ├─ keyframes      逐镜首帧 —— 线上生图
  ├─ clips          逐镜片段（含同步人声与环境音）—— 本地 H3
  └─ assemble       ffmpeg 拼接 + 响度归一 + 字幕 + **成片自检**
```

每一步都可能花真金白银、或烧几十分钟算力，所以**每一步前面都有一道闸门**。

---

## 和别的方案有什么不同

大多数 AI 视频工具是**给人用的产品**：拖时间轴、点按钮、一镜一镜手动做。

这个工程是**给 agent 用的能力**：它把"怎么做一部短剧"的判断、约束、验收标准，
全部写成**可执行的契约和测试**，让 AI 助手照着做 —— 而不是让 AI 助手凭感觉做。

| | 产品式（如 DramaClaw / OpenMontage） | 本工程 |
|---|---|---|
| 谁在编排 | 人点按钮 | **AI 助手照着 SKILL.md 做** |
| 质量靠什么保证 | 人的眼睛 | **契约 + 闸门 + 250 条断言** |
| 人的介入点 | 每一步 | **只在 4 个闸门看图点头** |
| 换一部剧的成本 | 重新走一遍流程 | **换一个板子文件** |

---

## 核心设计

### 1. 身份与造型分离（最重要的一条）

```jsonc
"characters": [{ "id": "c_001", "face_prompt": "…", "portrait": "…" }],   // 脸 —— 全片一份
"identities": [{ "id": "c_001_default", "character": "c_001",
                 "appearance_details": "…", "sheet": "…" }]               // 服装 —— 按造型
```

脸是跨全片复用的锚；服装是按剧情变化的层。混在一起，换一套衣服就得重做一张脸。

### 2. 必需的外观属性**由代码兜底**

模型不会自觉。凡是"必需的"，必须有代码拥有者：

| 属性 | 谁拥有 | 不兜底的后果（实测） |
|---|---|---|
| 年龄 | `age_group` 枚举 | 成年角色 → **幼儿园小孩** |
| 族裔 | `regionAnchor()` | 古风仙侠主角 → **白人** |
| 风格 | `styleAnchor()` | 写实剧角色 → **卡通人** |
| 音色 | `resolveVoice()` | 全片一个声音 |

### 3. 台词由**代码搬运**，模型碰不到

`literal` 模式不调用任何模型：剧本里的台词被代码原样搬进分镜，逐字保真。
模型只负责**写画面**，不负责**写台词**。

### 4. 闸门：**程序不许替你点头**

```
① 故事 → ② 分镜表 → ③ 资产 → ④ 关键帧 → ⑤ 出片
```

**每道闸门后面都是真金白银。** 未确认的阶段，下游一律不许消费。
而且每个阶段跑完会自动生成**审阅图**（`out/assets_review.jpg`）——
没东西看的闸门等于没有闸门。

### 5. 成片必须自检

`"文件存在" ≠ "成片能看"`。跑完 `assemble` 会强制自检，**不过就是 exit 1**：

| 检查 | 判据 |
|---|---|
| **完整解码一遍数报错** | 必须 0 行 |
| 音轨 | 存在、不是静音、不削波 |
| 时长 | 与时间轴差 ≤3 帧 |
| 抽 5 帧 | 不能全黑或全白 |
| 字幕 | 条数与时间轴核对 |

### 6. 成本账本

每次线上调用当场记一笔，跑完打表，按**轮次**分组 ——
**重出花掉的钱单独可见**，因为那正是最该被看见的部分。

---

## 安装 / 使用

### 作为 DSH skill

```bash
# 工程放到任意位置，然后把薄壳指向它
mkdir -p ~/.agents/skills/story2video
cat > ~/.agents/skills/story2video/SKILL.md <<'EOF'
---
name: story2video
description: 故事 → 分镜表 → 资产 → 关键帧 → 视频的分阶段流水线
---
读 <本工程>/SKILL.md，那是规则正本。
EOF
```

然后对 AI 助手说「把这个故事做成片子」。

### 依赖

| | 用途 | 必需 |
|---|---|---|
| Node ≥ 20 | 全部代码 | ✅ |
| ffmpeg + ffprobe | 混音、拼接、测量、自检 | ✅ |
| [百炼 `bl` CLI](https://help.aliyun.com/zh/model-studio/) | 线上生图 / 配音 | ✅（或换别的通道） |
| ComfyUI + MiniMax H3 | 本地出片段 | 可选 |

### 环境变量

```bash
AIH_WORKSPACE=<数据目录>              # 必需：产物落在哪
AIH_ASSET_PROVIDER=bailian|comfyui   # 资产通道，默认线上
AIH_KEYFRAME_PROVIDER=bailian|comfyui # 关键帧通道，默认线上
AIH_TTS_PROVIDER=bailian             # 配音通道
AIH_PRICE_<模型名>                    # 覆盖公示单价
```

### 跑

```bash
node src/board.mjs  validate  <board.json>
node src/render.mjs <board.json> --workspace <数据目录> --stage assets
node src/render.mjs <board.json> --workspace <数据目录> --stage contact   # 只重摆审阅图
```

---

## 目录

```
SKILL.md                      规则正本（38 KB，15 条实测教训）
schema/storyboard.schema.json 分镜契约
src/
  board.mjs         CLI 中枢：校验 / 批准 / 编译 / 出表
  render.mjs        渲染驱动：五阶段 + 闸门 + 审阅图
  literal.mjs       纯代码编译（台词逐字保真）
  parse-script.mjs  剧本行分类器
  parse-scenes.mjs  场次确定性解析
  assets.mjs        配方（提示词是可断言的纯函数）+ H3 官方格式
  orchestrate.mjs   时间线 / 帧网格 / 转场 / 时长估算
  score.mjs         候选池逐维打分
  review.mjs        成片自检
  cost.mjs          成本账本
  providers/        通道路由（线上 / 本地）
tests/              十套验收，250 条断言
prompts/            故事→分镜的提示词模板
plugin/dsh-storyboard/   DSH 面板插件：分镜确认表 + 资产/关键帧审阅
```

---

## 踩过的坑 —— 这部分最值钱

工程里每一条规则背后都是一次真实的失败。挑几条：

### 「H3 会把对白烧成字幕」—— **这条被推翻了**

我一度确信 H3 会把台词烧成画面文字，还给**每一镜**都裁掉了底部 13%。
后来把工作区所有旧片段扫了一遍：**一处字幕都没有。**

真相是：剧本里有一张**「片尾字幕」卡**，文字是**我们要它画的**。
我把一张**本该有字**的结尾卡，误判成了模型的坏毛病。

> **一个没被证实的 13% 裁切，比一个假想的字幕更糟。**

### H3 的提示词必须用**官方格式**

[MiniMax 官方指南](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md) 规定：

- 台词必须在 `integrated_multimodal_description` 里，包成 **`<d>[语言] 台词</d>`**，逐字保留
- **`overall_soundscape` 明令禁止重复台词**（那里只放环境音）
- 说话者要有稳定 ID `(S1)`；画外音必须用固定短语 `says in an off-screen voiceover`
- I2VA 必须带对齐指令 `For the target video, at 0.00 seconds … <Picture 1> …`
- **屏上文字是"显式声明制"**：用引号写出来才会出现，**不写就不会有**

我把台词写成散文塞进了"环境音"字段 —— 模型没有结构可依。

### 画幅是所有尺寸的根，**先问，别沿用**

竖屏短剧（9:16）我沿用了继承来的 16:9，**一次都没问过**。切过去时资产全废。

还有一层更隐蔽的：**线上通道和本地通道的参数名不一样**

```js
线上 bailian：只认 size   （'1:1' / '16:9' / '9:16'）
本地 comfyui：只认 ratio  （或 width/height）
```

关键帧只传了后者，线上 `size` 走了默认 `'16:9'` ——
**13 张竖屏关键帧全按横屏生成、再被裁掉 68% 像素。**

> **参数有没有传到，看请求体，别信代码"应该会传"。**（`bailian.dryRun()` 打真实请求体，0 成本）

### 别在缩图或聚合数字上下结论

同一个错误犯了很多次，每次都是**拿降级的观测当真**：

| 我看到的 | 我下的结论 | 真相 |
|---|---|---|
| `volumedetect` 报 −20 dB | "音轨正常" | AAC 比特流是坏的，**用户用耳朵发现没声音** |
| 缩图里"白+灰" | "模型给她穿了现代便装" | 原图是**交领+比甲的汉服** |
| 缩图里"深青色袍子" | "服装描述没照做" | 原图是**月白袍 + 深青腰带** |

> **判断画面 → 开原图。审阅图只用来"找哪里要看"，不用来"下结论"。**

### 景别不是写两个字就够的

`近景` 埋在一大段服装描述中间 → 模型按整段读 → **出成全身站像**。

正确做法：景别**放最前**，且展开成明确取景范围：

```
近景（medium close-up shot）：只取胸部以上，脸占画面三分之一以上，绝对不出现腰部以下
```

### "便宜通道做草稿、贵通道做成品"—— 要验证

从别处抄来的判据：关键帧走本地（便宜）。同镜 A/B 之后推翻了：

| | 线上 | 本地 |
|---|---|---|
| 构图对不对得上分镜 | ✅ | ❌ **两人位置调换** |
| 人脸 | 真人质感 | 娃娃脸 |
| 耗时 | 133s | 120s |
| 价格 | 0.24 元 | 0 |

**时间几乎一样，只差 0.24 元。** 而关键帧是观众真正看到的画面。

> **抄来的判据必须验证** —— 否则最贵的一层会落在最弱的通道上。

### 还有十几条

编码 bug（AAC 拼接）、死锁（`apad` + `amix` + `-shortest`）、
`amix` 默认把音量除以路数、帧网格 17k+5、时长决定顺序……
全部写在 **[`SKILL.md`](SKILL.md)** 里，每条都带实测数据。

---

## 测试

```bash
node tests/contract.test.mjs   <board.json>   #  9 项：契约能拒掉每一类错误
node tests/assets.test.mjs     <board.json>   # 59 项：配方可断言，出图前就知道对不对
node tests/orchestrate.test.mjs <board.json>  # 64 项：帧落网格、总长=各镜之和
node tests/literal.test.mjs    <board.json>   # 14 项：台词逐字保真
node tests/scenes.test.mjs     <board.json>   # 24 项：场次确定性解析
node tests/compiler.test.mjs   <board.json>   # 16 项：补强层不抹平真错误
node tests/score.test.mjs      <board.json>   # 36 项：脸和服装都得过线
node tests/gate.test.mjs       <board.json>   #  5 项：闸门只看用户的票
node tests/cost.test.mjs                      # 23 项：算钱算对
node tests/review.test.mjs <film.mp4> <board.json>  # 13 项：四种病都得拦下
```

**250 条断言。** 其中 `review` 和 `cost` 是**负例驱动** ——
故意造全黑、静音、时长不符、码流损坏的片子，**必须都被拦下**。

---

## 免责

本工程产出的一切内容由使用者负责。请遵守所依赖的模型服务条款。

## License

MIT
