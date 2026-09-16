# DSH-Drama-Skill

**把一段故事，变成一部能发出去的短剧。** 一个 AI 导演编排镜头，五条命令出片，四个确认点。

[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/tests-303%20passed-brightgreen)](#测试)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

```
剧本.md ──▶ 🎬导演编排 ──▶ 分镜表 ──▶ 资产 ──▶ 关键帧 ──▶ 成片.mp4
            镜头/景别/运镜    (JSON)     (图)     (图)      竖屏 · 带人声
            切点/朝向
```

---

## 它解决什么问题

AI 生视频工具很多，但**做一部完整的短剧**要处理的事它们不管：

- **镜头怎么排** —— 什么时候切、什么时候让摄影机自己动、两人朝哪看
- 台词要**一字不差**地念出来，不能改
- 同一个角色在十几个镜头里要**长得一样**、**穿得一样**
- 换一套衣服不能把脸也换掉
- 一镜 45 个字的台词要 12 秒，画面不能只给 5 秒
- 镜与镜之间要接得上，不能全靠硬切
- **花的是真钱** —— 哪一步错了，得在下游烧钱之前拦住

这个工程把这些**写成可执行的契约和测试**，交给 AI 助手去执行。

---

## 🎬 导演：让 AI 排镜头，而不是让代码套公式

**这是本工程跟"模板流水线"最大的区别。**

切与不切是**判断**，不是公式：
规则能说"只变距离就别切"，**说不出**「她说完那句话之后那半秒沉默，值得切到她脸上」。

所以这里有一个**导演角色**（[`director/BRIEF.md`](director/BRIEF.md)）——
一份**职业简报**，不是规则条文：他是谁、他的判断工具、这部片的技术事实、他的底线。

```bash
node src/board.mjs direct board.json          # 请导演（qwen3.8-max）
node src/board.mjs direct board.json --dry-run  # 只看简报，0 成本
```

**他交出来的东西**：若干个**生成单元**（每个 ≤15 秒），每个单元里可以切多刀 ——

```
u1 (14.0s)  [Shot 1]          全景  缓慢前推   两人在林间走
            [Shot 2] At 3.20s 近景  切         她道谢
            [Shot 3] At 6.20s 近景  切         他推辞
            [Shot 4] At 11.6s 特写  切         她委屈
```

**单元内是一次生成** —— 里面切多少刀，人物/光线/声音都是连续的。
**接缝从 13 个降到 4 个，生成次数从 14 次降到 5 次。**

### 职责边界

| | 归谁 | 为什么 |
|---|---|---|
| **台词** | ❌ **代码** | **逐字保真，导演一个字都不许碰** |
| 镜头划分 / 景别 / 运镜 / 构图 / 朝向 | ✅ 导演 | 这是创作判断 |
| ≤15 秒 / 画幅 / 人物引用有效 | ❌ 校验器 | 硬约束，越界就拦 |

**导演可以自由创作，但越界会被拦下。** 有一条是死线：
**他的输出里出现任何一句台词原文 → 直接报错**（台词只能用行号引用）。

> 实测：他排出的 17 个镜头里，180 度线是对的；
> 我第一版校验器反而把他**对的**报了 5 次错 —— 对话戏的正反打本来就该
> "她永远朝右、他永远朝左"。**是我的校验器错了。**

---

## 快速开始

```bash
git clone https://github.com/SunguochaoYeepay/DSH-Drama-Skill.git
cd DSH-Drama-Skill

# 依赖：Node ≥ 20、ffmpeg；线上生图需要百炼 bl CLI（见「依赖」）
export AIH_WORKSPACE=/path/to/your/data      # 产物目录
```

**① 剧本 → 分镜表**

```bash
node src/board.mjs literal 剧本.md --out board.json --workspace "$AIH_WORKSPACE"
node src/board.mjs table   board.json          # 打一张人能读的表
```

**② 看一眼，然后确认**

```bash
node src/board.mjs approve board.json --stage story
node src/board.mjs approve board.json --stage shots
```

**③ 出资产**（人物形象 / 场景）

```bash
node src/render.mjs board.json --workspace "$AIH_WORKSPACE" --stage assets
# 自动生成审阅图 → 看过之后确认
node src/board.mjs approve board.json --stage assets
```

**④ 出关键帧**

```bash
node src/render.mjs board.json --workspace "$AIH_WORKSPACE" --stage keyframes
node src/board.mjs approve board.json --stage keyframes
```

**⑤ 出成片**

```bash
node src/render.mjs board.json --workspace "$AIH_WORKSPACE" --stage clips
node src/render.mjs board.json --workspace "$AIH_WORKSPACE" --stage assemble
```

`assemble` 跑完会做**成片自检**，不过就是 `exit 1`：

```
成片自检：✓ 通过
  10.7 MB　87.97s　2110 帧　解码报错 0
  音频 mean -18 dB / max -1.4 dB　(44100Hz 2ch)
  抽帧亮度 73.4 / 92.7 / 74.3 / 95.4 / 72.5　字幕 12 条
```

---

## 工具：检查产物、看节奏、等就绪

**都是踩坑踩出来的 —— 每次手动拼 ffmpeg 抽帧都会翻车，所以钉成了工具。**

```bash
node tools/inspect.mjs <video|image> [--aspect 9:16] [--first-last]
```

量尺寸 / 帧数 / 时长 / 响度 / 解码报错，抽帧拼图，退出码 0/1。

```
检查 s01.mp4
────────────────────────────────────────
  尺寸      1088×1920  @ 24fps
  画幅      期望 9:16 → ✓ 通过（偏离 0.74%）
  解码报错  0 行 ✓
  响度      mean -16 dB / max -0.6 dB
  抽帧      6/6 帧 ✓
✓ 全部通过
```

```bash
node tools/animatic.mjs board.json --direction board.direction.json
```

**把分镜按真实时长拼成能看的预览（0 成本）。**
用户的话：「我不是导演，我不知道合不合理，**我只能看到片子才知道是不是太长了**。」
—— 那就不该拿文字分镜表让人审批。**先给能看的东西，再谈生成。**

```bash
node tools/wait-ready.mjs            # 端口通 ≠ 就绪，等节点注册完
node tools/fl2v-test.mjs <board> --first a.png --last b.png   # 验证首尾帧夹逼
node tools/unit.mjs <board> --direction d.json --unit u1 --size 768x1344
```

---

## 命令

### `board.mjs` — 契约层

| 命令 | 作用 |
|---|---|
| `literal <script.md>` | **纯代码**把剧本编译成分镜表，台词逐字保真、不调用模型 |
| `story <idea.txt>` | 让模型写分镜表（需要 Ollama） |
| `validate <board.json>` | 校验契约（结构 + 语义），打印警告和错误 |
| `table <board.json>` | 打印人能读的分镜表 |
| `approve <board.json> --stage <s> --by <名字>` | 确认某道闸门 |
| `plan <board.json>` | 打印"下一步该做什么" |

### `render.mjs` — 渲染层

```bash
node src/render.mjs <board.json> --workspace <DIR> --stage <阶段> [选项]
```

| 阶段 | 做什么 | 产出 |
|---|---|---|
| `durations` | 本地估每句台词的时长（0 元） | 更新 `duration_s` |
| `assets` | 人物肖像 / 身份图 / 场景 | `assets/*.png` |
| `keyframes` | 逐镜首帧 | `keyframes/s01.png…` |
| `clips` | 逐镜片段（含人声与环境音） | `clips/s01.mp4…` |
| `assemble` | 拼装 + 响度归一 + 字幕 + **自检** | `out/final.mp4` |
| `contact` | 只重摆审阅图，不生成任何东西 | `out/*_review.jpg` |
| `tts` | 配音（只在要替换 H3 人声时用） | `audio/*.mp3` |
| `all` | 除 `tts` 外全跑 | |

常用选项：

| 选项 | 说明 |
|---|---|
| `--shots s01,s05` | 只做指定镜头 |
| `--force` | 重出已有的 |
| `--only <id>` | 只重出指定资产 |
| `--hq` | 25 步（**默认是 4 步**，见「常见问题」） |
| `--with-scene-extras` | 额外生成反向场景图与俯视平面图 |
| `--crop-caption` | 裁掉画面底部 13%（**默认关**，见「常见问题」） |
| `--skip-gate` | 跳过闸门检查（正式跑别用） |

> **采样步数默认 4 步**（`--fast`），25 步要显式加 `--hq`。
> 理由：4 步和 25 步的差别**没对照过**，不该拿"没验证过的质量"换"实实在在的时间"。
> 看过了、确认没问题，再上 `--hq`。

---

## 它是怎么工作的

### 五阶段 + 四道闸门

```
① 故事 ──▶ ② 分镜表 ──▶ ③ 资产 ──▶ ④ 关键帧 ──▶ ⑤ 出片
            ✅闸门        ✅闸门       ✅闸门
```

**每道闸门后面都是真钱或真算力。** 未确认的阶段，下游一律不许消费。

每个阶段跑完会自动生成**审阅图**（`out/assets_review.jpg`），
配上终端的阅读顺序，看过再点头：

```
【关键帧（逐镜首帧）】审阅
  审阅图 -> story2video/projects/dashixiong/out/keyframes_review.jpg
  阅读顺序（左→右、上→下，每行 4 个）：
     1. s01  全景  3s  （无台词）
     2. s02  近景  4.48s  「大师兄，昨天晚上，谢谢你救了」
     …
  看没问题就点头：
    node src/board.mjs approve board.json --stage keyframes --by <你的名字>
```

**程序不会替你点头** —— `approve` 是唯一能推进闸门的入口。

### 身份与造型分离

一部剧里，脸只有一份，衣服按剧情有多套：

```jsonc
"characters": [{
  "id": "c_001",
  "face_prompt": "东亚男性，约二十二岁，剑眉星目…",
  "portrait": "assets/portrait_c_001.png"       // 脸部锚点：正面、灰底、不带服装
}],
"identities": [{
  "id": "c_001_battle",
  "character": "c_001",
  "appearance_details": "月白色交领长袍，外罩浅青薄纱外衫，腰束深青布带…",
  "sheet": "assets/sheet_c_001_battle.png"       // 4 面板设定图：正/侧/背/脸部特写
}]
```

镜头通过 `cast` 引用**造型**（不是角色），所以换衣服不用换脸。

### 台词由代码搬运

`literal` 模式**不调用任何模型**：剧本里的台词被代码原样搬进分镜，逐字保真。
模型只写画面，不写台词。

```
镜   类型       字数   时长
s02  spoken      16   4.48s   「大师兄，昨天晚上，谢谢你救了我。」
s05  spoken      44  12.65s   「大师兄，昨晚的事，你千万不要跟别人说。」
```

### 时长从台词推

配音先出（或用本地估算），量出真实秒数再定画面长度 —— 顺序反了必然对不齐。

### 逐维打分挑候选

一镜出多个候选，按**脸**和**服装**分别打分，两个都过线才采纳，总分不能替代它们：

```bash
node src/score.mjs <图片> --kind portrait --expect "圆脸杏眼，双螺髻"
# → { face_score: 9, clothing_score: 8, critical: [], pass: true }
```

### 成片自检

`"文件存在" ≠ "成片能看"`。跑完强制检查，**不过即 fail**：

| 检查 | 判据 |
|---|---|
| 完整解码一遍数报错 | 必须 0 行 |
| 音轨 | 存在、不是静音、不削波 |
| 时长 | 与时间轴差 ≤3 帧 |
| 抽 5 帧 | 不能全黑或全白 |
| 字幕 | 条数与时间轴核对 |

### 成本账本

每次线上调用当场记一笔，跑完打表：

```
成本（公示价估算，不是账单）

  模型                    调用   张数  参考  字符      金额
  ──────────────────────────────────────────────────────────
  qwen-image-3.0           13     13    31      0     2.960 元
  cosyvoice-v3-flash        2      2     0    278     0.028 元
  ──────────────────────────────────────────────────────────
  合计                       15                         2.988 元
```

按**轮次**分组（首轮 / 重出 / 局部），所以重出花掉的钱单独可见。

---

## 契约

分镜表是一个 JSON 文件，schema 在 [`schema/storyboard.schema.json`](schema/storyboard.schema.json)。
最小结构：

```jsonc
{
  "meta": {
    "title": "大师兄的离谱负责",
    "aspect": "9:16",              // 9:16 / 16:9 / 1:1
    "style": "realistic",
    "language": "zh",
    "approvals": { "story": null, "shots": null, "assets": null, "keyframes": null }
  },
  "characters": [ /* 脸 */ ],
  "identities": [ /* 造型 */ ],
  "scenes":     [ /* 场景 */ ],
  "props":      [ /* 道具 */ ],
  "beats":      [ /* 故事节拍 */ ],
  "shots": [{
    "id": "s02",
    "scene": "scene_01",
    "cast": ["c_001_default"],        // 引用造型，不是角色
    "props": [],
    "source_lines": [12, 13],          // 对应剧本哪几行（可追溯）
    "duration_s": 4.48,
    "shot_size": "近景",
    "camera": "固定镜头",
    "prompt": "{{c_001_default}}，近景，固定镜头",
    "dialogue": [{
      "character": "c_001_default",
      "kind": "spoken",                // spoken | voiceover
      "text": "大师兄，昨天晚上，谢谢你救了我。",
      "emotion": "眉眼带庆幸，语气温软"
    }],
    "transition": { "type": "cut" },
    "first_frame": null, "clip": null
  }]
}
```

`{{identity_id}}` 和 `[[prop_id]]` 是**绑定标记** —— 渲染器会把它们展开成实际的造型/道具描述。
标记写错（引用了不在 `cast` 里的造型）会直接校验失败。

---

## 配置

### 环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `AIH_WORKSPACE` | **产物目录（必需）** | 无，不设会拒绝运行 |
| `AIH_ASSET_PROVIDER` | 资产通道 | `bailian` |
| `AIH_KEYFRAME_PROVIDER` | 关键帧通道 | `bailian` |
| `AIH_TTS_PROVIDER` | 配音通道 | `bailian` |
| `AIH_PRICE_<MODEL>` | 覆盖公示单价 | 内置表 |

通道可选 `bailian`（线上）或 `comfyui`（本地）。

### 依赖

| | 用途 | 必需 |
|---|---|---|
| Node ≥ 20 | 全部代码 | ✅ |
| ffmpeg + ffprobe | 混音、拼接、测量、自检 | ✅ |
| [百炼 `bl` CLI](https://help.aliyun.com/zh/model-studio/developer-reference/bailian-cli) | 线上生图 / 配音 | ✅ |
| [ComfyUI](https://github.com/comfyanonymous/ComfyUI) + MiniMax H3 | 本地出片段 | 可选 |

`bl` 认证：

```bash
bl auth login            # 或配置 DASHSCOPE_API_KEY
bl auth status
```

### 产物目录结构

```
$AIH_WORKSPACE/story2video/
  projects/<剧名>/
    board.json        分镜契约
    story.md          剧本
    assets/           portrait_<id>.png / sheet_<id>.png / scene_<id>.png
    keyframes/        s01.png …
    clips/            s01.mp4 …            ← 按镜号命名，不是时间戳
    audio/            s02.mp3 …
    pool/             s02/1.png 2.png 3.png   候选池
    out/              final.mp4 / final.srt / *_review.jpg
  current.json        「当前在做的板子」指针（面板插件读它）
  costs.json          成本账本
```

---

## 测试

**303 条断言，十一套。** 其中多套是**负例驱动** —— 故意造坏东西，必须被拦下。

```bash
B=board.json
node tests/contract.test.mjs   $B    #  9 项  契约能拒掉每一类错误
node tests/assets.test.mjs     $B    # 59 项  配方可断言，出图前就知道对不对
node tests/orchestrate.test.mjs $B   # 82 项  帧落网格、总长=各镜之和、字幕首尾相接、**画幅核对**
node tests/literal.test.mjs    $B    # 14 项  台词逐字保真
node tests/scenes.test.mjs     $B    # 24 项  场次确定性解析
node tests/compiler.test.mjs   $B    # 16 项  补强层不抹平真错误
node tests/score.test.mjs      $B    # 36 项  脸和服装都得过线
node tests/gate.test.mjs       $B    #  5 项  闸门只看用户的票
node tests/cost.test.mjs             # 23 项  算钱算对
node tests/director.test.mjs   $B    # 35 项  **导演可以自由创作，但越界会被拦下，台词碰不得**
node tests/review.test.mjs film.mp4 $B   # 13 项  四种病都得拦下
```

---

## 作为 DSH Skill 使用

装上薄壳，之后直接对 AI 助手说「把这个故事做成片子」：

```bash
mkdir -p ~/.agents/skills/story2video
cat > ~/.agents/skills/story2video/SKILL.md <<'EOF'
---
name: story2video
description: 故事 → 分镜表 → 资产 → 关键帧 → 视频的分阶段流水线
---
读 <本仓库路径>/SKILL.md，那是规则正本。
EOF
```

**规则正本在 [`SKILL.md`](SKILL.md)。** 里面有完整的字段语义、配方约束、
以及每条规则的实测依据。

---

## 常见问题

**Q：成片没有声音？**
先看自检有没有报解码错误。`bl` 和本地生成的音轨采样率不同，
如果没统一 `-ar 44100` 就拼接，AAC 码流会坏掉 —— 播放器能读出时长，但听不到声音。

**Q：画面里有字幕/文字？**
**H3 会不稳定地烧字幕** —— 同一个尺寸、同样的提示词，有的出有的不出（实测）。
试过加 `on_screen_text: none`，**只对一部分有效，压不住**。
裁切也不行（字幕在画面 74%–80%，裁掉 26% 会毁竖屏构图）。

**正解：去字幕工具。** 首选
[`YaoFANGUK/video-subtitle-remover`](https://github.com/YaoFANGUK/video-subtitle-remover)（12.9k stars，
本地跑、无需 API、无损分辨率）。流程：**出片 → 去字幕 → 再放大到交付尺寸。**

**Q：角色长得不对 / 像卡通人？**
三个最可能的原因：`face_prompt` 没写族裔、`meta.style` 对应的风格锚点没生效、
或者字段还是占位符（`validate` 会点名）。

**Q：某张图明显坏了，要全部重出吗？**
不用。先 `--stage contact` 重摆审阅图，逐张开原图确认，
再 `--shots s07,s09` 定点重出。**别在缩图上判断好坏。**

**Q：关键帧出成横的了？**
线上通道只认 `size`，本地通道只认 `ratio`，两个都要传。
`bailian.dryRun()` 可以打出真实请求体，0 成本验证参数。

**更多排查**：见 [`SKILL.md`](SKILL.md)。

---

## 项目结构

```
SKILL.md                       规则正本（给 AI 助手读）
README.md                      你正在看的
schema/storyboard.schema.json  分镜契约
director/
  BRIEF.md         🎬 **导演的职业简报** —— 身份 / 判断工具 / 底线
  schema.md        他交什么格式
src/
  board.mjs        CLI 中枢：校验 / 批准 / 编译 / 出表 / **direct**
  render.mjs       渲染驱动：五阶段 + 闸门 + 审阅图
  director.mjs     导演驱动 + 校验器（含台词死线）
  literal.mjs      纯代码编译（台词逐字保真）
  parse-script.mjs 剧本行分类器
  parse-scenes.mjs 场次确定性解析
  assets.mjs       资产配方 + 提示词构造（纯函数，可断言）
  orchestrate.mjs  时间线 / 帧网格 / 转场 / 时长估算 / **画幅核对**
  score.mjs        候选池逐维打分
  review.mjs       成片自检
  cost.mjs         成本账本
  providers/       通道路由（线上 bailian / 本地 comfyui）
tools/
  unit.mjs         生成单元 → H3 多镜提示词 → 出片
  inspect.mjs      检查产物（规格 + 抽帧 + 首末帧）
  animatic.mjs     动态分镜：0 成本把节奏变成能看的东西
  wait-ready.mjs   等 ComfyUI 真的就绪（端口通 ≠ 就绪）
  fl2v-test.mjs    验证首尾帧夹逼（尾帧是否真的落在指定位置）
tests/             十一套验收，303 条断言
prompts/           故事→分镜的提示词模板
plugin/dsh-storyboard/   DSH 面板插件：分镜确认表 + 资产/关键帧审阅
```

---

## License

MIT
