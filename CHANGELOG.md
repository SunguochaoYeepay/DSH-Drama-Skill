# Change Log

记录工程级行为变化。具体剧目的抽卡结果、耗时和逐帧评价留在对应项目目录，不写入这里。

## 2026-09-21 - 本地生图默认家族切到 Qwen Image 2.1（上游 + 本仓）

用户拍板：comfy-studio 上游与本仓都接入 2.1，**默认使用**。

- **上游 comfy-studio**（`graphs.py`/`gen.py`）：新增 `build_image21()` —— t2i 与 edit
  共用一张图（`ComfySwitchNode` 切 latent 来源）；文本编码换成单节点
  `TextEncodeQwenImage21`（同时出 positive/negative/latent，参考图以 VAE latent 拼进序列）；
  参考图上限 3→16；参考图缩放交给节点自带 `resolution`；默认 25 步 cfg 1 +
  `QwenImage21Cache`。**刻意不追加 style 正向句**（旧链路「。，」拼接疤痕与
  自检口径失真的根源），负向条件由 `--style` 预设 + `--negative` 合并，edit 且非
  `--style none` 时负向为空直接拒绝。`--image-model qwen` 保留旧 2511 链路作逃生口；
  2.1 下传 `--lora` 直接报错（骨架错配）。
- **本仓**：`config.mjs` 新增 `AIH_LOCAL_IMAGE_MODEL`（默认 `qwen21`）与 21 家族自己的
  步数/CFG 常量；`cli/keyframes.mjs` 与 `cli/assets.mjs` 的本地参数按家族分发
  （21 → `--image-model qwen21 --steps 25 --cfg 1`，绝不挂 LoRA；legacy 三件套不变）；
  `src/providers/comfyui.mjs` 的 `generate()/edit()` 接受 `imageModel` 并在 21 下拒绝 LoRA、
  忽略 `fast`。generation record 的 model 记为 `local-comfyui/<家族>`。
- **参考图上限保持 3 张不动**：2.1 支持 16 张，但"参考图变多后画面受不受干扰"是
  行为决策，等 3 张 vs 全给的同镜对照再放开。
- 实测：同镜同提示词同参考图，2.1（25 步）**17–18 秒**出 1152×2048，比旧 8 步
  Lightning（29 秒）更快；构图/物件/光线明显更好（手悬空位置、屏幕亮起都对上）。
- 测试：`keyframe-local-args`/`asset-local-args`/`generation-config` 按新默认改写并
  新增 legacy 家族反例，41/41 全绿。

## 2026-09-21 - 关键帧提示词：清掉四处"没用的成分"（有人物的镜头一字未变）

起因：not_awake g002（柜面近景、无人）提示词 615 字报超字数。查下来字数不是病，
**病是三类无效/反向成分被硬套进了不适用场景**。清理后同一份导演稿降到 481 字自检通过。

- `cli/keyframes.mjs` **无人镜头不再产出残句**：模板 `请把参考图中的${names}放进同一个镜头`
  在 `names` 为空时拼出「请把参考图中的放进同一个镜头」，且它是提示词第一句。
  现在无人时只交代风格与参考图职责。
- `cli/keyframes.mjs` **身份保持句按参考图裁剪**：「保持参考图的角色身份…不得重设计脸部」
  只在真的挂了身份/肖像/尾帧参考图时出现；只有场景图时它是一句无对象的话。
- `src/draw-specialist.mjs` **约束冲突不再下发给模型**：`conflicts` 是给人看的诊断，过去经
  `prompt` 进了模型，等于在近景镜头里告诉模型「应改用中景或斜侧中景」——与我们的意图相反。
  现在 `compileDrawPlan` 仍返回 conflicts 供 CLI 打终端，`prompt` 里没有它。
- `src/draw-specialist.mjs` **禁鞋禁站立句要求画面里有人**：过去只要文本含"床/枕头/被褥"就追加，
  柜面特写上会出现"不要把身份图中的鞋履…复制过来"。现在要求 `ids` 非空。
- `cli/keyframes.mjs` 关键帧审阅票据 `reviews/keyframes.md` 增加**抽卡师删减留档**
  （每单元送模型字数、自检违规则、被删条目、冲突提示）。人是照 `keyframe_start` 审图的，
  而模型看的是删后版——现在这两份的差异看得见。
- 行为测试 5 条（draw-specialist 2 + keyframe-prompt 3），含"有人镜头必须照旧带上身份锚"的
  反向守卫。全量 41/41 绿。有人有身份图的 g001/g003 提示词一字未变。

## 2026-09-21 - director-skills 吸收：动作戏工艺 + 首帧空间审计 + 音效三层（纯文档）

- 新增 `references/story-craft/action.md`：动作戏工艺（2–3 秒时序拆段对齐单元切镜、动作
  因果链防瞬移穿模、打击感四环、硬碰硬四步、运镜节奏供料、生成友好约束——群战降级/
  武器立项/动作段台词 3 字每秒/战后状态分层/追逐空间账）。来源 action-fight-prompt（MIT）。
- `assets-and-keyframes.md` 人工审阅加**首帧空间审计**四问（前景/中景/背景盘点、机位
  可达性、规定时长内动作物理可完成、无进入路径的元素不得凭空出现）。来源 travel-skill。
- `video-h3.md` soundscape 指引补**音效三层**（力量/材质/生物），动作戏三层都要有。
- 接线：story-craft.md 路由表 + 自检清单 12 条、genres.md 战神行挂链、SKILL.md、README。
  纯文档层，无代码变更。

## 2026-09-21 - H3 提示词修复第 3 条 + assemble 响度统一（两遍式 loudnorm）

- 切镜时间戳对齐官方格式：`[Shot 2] At 00:03.500, the camera cuts to`（MM:SS.mmm），
  不再是 `At 03.50 seconds`。
- `cli/assemble-units.mjs` 每段转码前做**两遍式 loudnorm**：第一遍测量（print_format=json）、
  第二遍 linear 应用；默认 -16 LUFS / TP -2 dB / LRA 11，`AIH_ASSEMBLE_LUFS /
  AIH_ASSEMBLE_TP_DB / AIH_ASSEMBLE_LRA` 可覆盖；测量解析失败退回单遍动态模式；无音轨段跳过。
  依据：外部实证单遍 loudnorm 偏离目标 3.7 dB；逐段归一后 concat，段间响度差不再进成片。
- 行为测试：夹具两段原始响度差 24 LU，归一后段间差 ≤3 LU（assemble-review.test.mjs）；
  时间戳格式测试进 h3-prompt.test.mjs。全量 41/41 绿。video-h3.md 偏差清单同步。

## 2026-09-21 - H3 提示词修复偏差清单第 1、2 条：说话人首现音色 + 不说话者唇闭合

依据：官方原典（MiniMax-AI/MiniMax-H3 `skills/h3-prompt-writing`）与外部实证（drama-skills
RUN-LOG：口型落脸 3 次实测 2 次落错、明写闭合后 3/3 全对）。要点：

- 说话人首次出现带音色描述：`characters[].voice` 描述文本直用（TTS voice ID 跳过），
  否则 `age_group` + 性别线索推导；非人类角色不套人类声线。同一说话人只交代一次。
- 本镜有人开口时，其余画内角色追加 `（某某不出声，嘴唇保持完全闭合。）`；
  单人镜头不追加；画外音说话者台词自带闭合句，不重复点名。
- 性别线索抽出为 `orchestrate.genderOf()`，TTS 兜底与 H3 提示词共用同一套（单一事实源）。
- 新增 3 个行为测试（首现音色不重复 / voice ID 不外漏 / 唇闭合兜底），全量 41/41 绿。
  `references/video-h3.md` 偏差清单同步标记 1、2 为已修。

## 2026-09-21 - H3 方言对官方原典校准 + 剪辑音床预警（文档层，代码未动）

对比 github.com/zenstory-ai/drama-skills（同赛道全链路 skill 合集）后定位出四个真缺口，本批吸收其中
文档层部分；官方一手源首次引入：MiniMax-AI/MiniMax-H3 仓库的 `skills/h3-prompt-writing`
（base-en.txt 三段结构 / ref-en.txt 六段结构）——此前我们只靠二手与自撞。

- `references/video-h3.md`：
  - 新增「说话人与对白」官方语法节：说话人稳定 ID、`<d>` 内外分工、画外音固定短语、
    `<scenetrans>`/`<cutoff>`、**口型落在最显眼正脸**的外部实证（3 次实测）与调度优先的处置。
  - 对白容量口径修正：4–5 字/秒 → **4 字/秒**（H3 实测约 4.1 可发声字/秒且偶有赶词）。
    `story-craft.md` 台词工艺同步。
  - 新增「声音三字段」：`non_diegetic_music: N/A` 必须显式写空（留空出过模型自动补配乐）。
  - 新增 r2v full-reference 六段官方语义：Subject/Picture/Video/Audio 标签分工、
    summary 任务类型前缀、保留强度词汇、标签编号=挂图顺序契约；标注"实验路径，本地未逐项验证"。
  - 新增「合成音床与响度」：逐段独立音床 concat 接缝断层、单遍 loudnorm 偏离 3.7 dB、
    无响度统一——构造性风险预警（外部实跑教训）。
  - 新增「代码层偏差清单」：`h3-prompt.mjs` 对照官方原典的 7 项偏差（说话人缺音色描述、
    普通对白无嘴唇闭合兜底、时间戳格式、r2v summary 前缀/retention 词汇/Subject 折叠、
    中英混排开放问题），全部待用户拍板，未改代码。
- `references/assets-and-keyframes.md`：参考图职责补「槽位作用域」三段式（用途/控制/不得控制），
  每张图只负责一件事；判据是"送哪张/它负责什么/正文里叫哪个标签"三问。
- `references/qa-and-review.md`：终审清单加"戴耳机逐接缝听声音"（音床断层 + 响度差是构造性风险）。
- 无代码变更；测试不受影响（tests/ 无对这些文档的引用）。

## 2026-09-21 - 剧本工艺吸收：短剧编剧方法论进门，按生成流水线改造

对比 github.com/0xsline/short-drama（纯 Markdown 商业化微短剧编剧 skill）后确认：我们的全链路
生成能力对方为零，真实差距只在剧本创作工艺的深度。本批吸收其叙事方法论，全部按我们的哲学改造：

- 新增 `references/story-craft/` 四个专项类型学（`story-craft.md` 保持入口，按需加载）：
  - `hooks.md`：开场六式（钩子拍模板）+ 结尾钩五型。单集默认不用结尾钩（定格收束）；
    每式补"第一张关键帧画什么"，画不出来的钩子改写成画面可见的信息。
  - `payoff.md`：压抑→释放公式映射到节拍表（升级拍=蓄力、落点拍=兑现）+ 五大爽点类型。
    60–90 秒单集一个大爽点；压抑不够砍爽点不砍压抑。
  - `antagonist.md`：反派三问（并入动机最小集）+ 层级分档（单集最多 1 层对手）+ 伏笔埋设。
    只有画面伏笔算数，文字伏笔等于没埋。
  - `genres.md`：13 题材速查 + 叠加规则 + **生成成本分档**（原方法论没有、对我们生死攸关的一列）。
- 生成友好硬约束是本批的主增量，四份文件各带一节：钩子道具先立项、群演降级为 1–2 个
  具名角色反应、屏幕文字揭露改实物道具（H3 烧字不稳）、时间跳转先数资产账。
- **明确不吸收**：五维评分体系（机器审核，2026-09-19 已废，只保留人工自跑清单形态）、
  付费卡点与分阶段钩子配置（多集商业运营，转系列剧时再说）、出海格式与合规（另行立项）。
- `story-craft.md` 自检清单 8 条扩到 11 条；SKILL.md 路由表与所有权表、README 目录树同步。
- 无代码变更，无测试变更。

## 2026-09-20 - allowed_changes 写成了整句会让交接链直接崩掉

首个 `reference_previous` 单元跑到 `prepare-handoff` 时当场抛 `.join is not a function`——
导演契约要求 `continuity.allowed_changes` 是列表，但手写导演稿极自然就会写成一整句中文
（「景别从全景收到中景、机位从舱内正面移到他侧后方；服装与身份不变」）。两处消费方各以一种坏法处理：

- `cli/prepare-handoff.mjs`：`(x || []).join()` 直接崩，来不及生成交接尾帧。
- `src/continuity-handoff.mjs`：`[...str]` **不崩**，但会把凭证填成 `["景","别","从",…]`
  一串单字符，交接哈希照样算出来，错误被静默写进产物——比崩溃更糟。

修法：在 `continuity-handoff.mjs` 新增导出的 `allowedChangesList()`（数组原样返回 / 字符串按
`、`，;；` 切分去空 / 空值返回 `[]`），三处调用方（`prepare-handoff`、`createHandoffRecord`、
`cli/keyframes.mjs` 的提示词行）统一走它。测试新增 2 条：整句中文不会被拆成单字符、
凭证里的字段归一成词数组（合计 158 条）。

教训：`independent` 模式的单元永远走不到这些分支，**新模式的第一次实跑才是真正的测试**。

## 2026-09-20 - audience_knows 下发到视频提示词（不进关键帧）

单元级的「观众/角色各自知道什么」此前只活在导演稿里，出片阶段丢。`src/generation-plan.mjs`
把它透传到 `render.plan.json`，`src/h3-prompt.mjs` 在逐镜描述**之前**插一行 `audience_knows`
（它是整单元的前提，不是某一镜的属性）。关键帧不收——静帧靠 `keyframe_start` 够了，且关键帧
提示词本来就有字数压力。

动机：`pot_hit`（2026-09-20）里"观众已知、角色未知"的错位被拍丢——花盆从角色身后飞上来、
开场先说人再给飞机。两者根因都是 0 秒首帧的约束改写了叙事顺序，而这一行是唯一能把它写回生成
提示词的落点。`references/directing.md` 同批补了两条判据（建立镜头与 0 秒首帧冲突怎么办、
`end_state` 不被 `unit.mjs`/`h3-prompt.mjs` 读取所以约束必须落在 `action`/`visible_behavior`）。

## 2026-09-19 - 干跑改打印真实命令，装配层终于有行为测试

之前 `--dry-run` 在**构造参数之前**就退出了，干跑只能复述一遍变量（`PROFILE` / `ATTENTION` / `VIDEO_TIMEOUT_SECONDS`）——
那样证明不了这些值真的传到了 `gen.py` 或生图通道。配置导出的值对，和它真的被传下去，是两件事。

- `cli/unit.mjs`：把 `gen.py` 的 argv 构造提到干跑检查之前，干跑打印**将要执行的那条命令本身**
  （`--profile fast --attention vsa --width 480 --height 864 --timeout 600`）。
  顺带修一个隐藏问题：首帧缺失时 args 里是 `null`，原来的 `a.length` 会让这行打印直接崩掉
  —— 以前只在 `--show-args` 下才执行，从没暴露过。
- `cli/assets.mjs`：把传给通道的参数抽成 `providerArgsFor()`，真实调用和干跑**共用同一个函数**，
  干跑逐项打印 `ratio / n / steps / style / images`。
- 测试新增 2 条（合计 8 条）：env 的 `AIH_VIDEO_TIMEOUT_SECONDS` 真的出现在 argv 里；
  本地生图 `steps=8` 真的进了通道参数、`cartoon3d` 真的映射成 `anime`、图生图分支不带 `style`。

## 2026-09-19 - 清死代码：删 direction-shots.mjs 与两个零引用导出

全仓引用扫描（src / cli / tests / references / 根目录 md）确认后删除：

- `src/direction-shots.mjs`（181 行）：`board.mjs direct` / `apply-direction` 停用后，`applyDirection`
  再无调用方，只剩 CHANGELOG 一行提到它。旧导演入口的最后一块实现，需要时从 git 历史取。
- `src/human-gates.mjs` 的 `legacyApproval()`：读 `board.meta.approvals[stage]` 的旧票格式，
  当前闸门只认 `review.approvals.json`，零调用方。
- `src/director-batch.mjs` 的 `planningPrompt()`：已被 `compactPlanningPrompt()` 取代，
  分批路径现在只调后者。

保留不动（不是僵尸，是「还没接线的能力」或模块公共 API）：
`src/providers/bailian.mjs` 的 `speak()`（TTS 合成，流水线尚未接配音）、
`src/providers/index.mjs` 的 `keyframeProvider()` / `AVAILABLE`（通道索引对外 API）、
`src/plan-provenance.mjs` 的 `MIN_DIRECTOR_VERSION`、`src/migrate.mjs`（旧契约板子的一次性迁移工具）。

## 2026-09-19 - 剧本与导演稿默认由对话 Agent 直写，调外部模型降为可选

起因：用户再次明确「剧本及后续不需要用 qwen-max 大模型去写剧本和分析，当前对话模型做就好」。
此前只把 `register-agent` / `register-direction` 写成「可选 / 短片推荐」，主路径文档里仍写着「调 `.env` 的模型」——
结果 `cli/direct.mjs` 的 12000 token 截断被当成一个"要修的默认值问题"提了出来，**而那条路根本不该是默认**。

**剧本要的理解和判断、分镜分析要的判断力，当前对话模型就有**；再调一次 `qwen3.8-max` 只是多绕一圈，
还多一层"改一个字就要重跑入口、重新出票"的锁定成本。

- `SKILL.md` / `references/workflow.md` / `README.md` / `.env.example` / `references/preflight.md` /
  `references/troubleshooting.md` / `references/prompts/story-to-board.md`：统一改成
  「剧本和导演稿**默认由当前对话的 Agent 直写**，`register-agent` / `register-direction` 是默认路径；
  `cli/script.mjs generate` 与 `cli/direct.mjs` **只是用户明确要求调模型时才用**」。
- `src/board.mjs` 两处停用提示（旧 `story` / `direct` 入口）改为指向直写登记入口。
- `preflight.md` 预算表：剧本、导演两行由「费用随模型而定」改为 **0 元**。
- 不动默认值：`AIH_SCRIPT_MODEL` / `AIH_DIRECTOR_MODEL` 保留（可选路径仍要读），注释标明**默认用不到**；
  `cli/direct.mjs` 的 `--max-tokens 30000` 只在"万一真要调模型"的说明里出现。

## 2026-09-19 - 测试清理：源码文本断言清零，集成验证纳入回归

### 源码文本断言清零

`assert.match(源码, /…/)` 查的是「源码里有没有写这行字」：源码换个等价写法它就假红，行为真坏了它却绿 —— **它没测过任何行为**。以下三处全部改写或删除：

- `tests/keyframe-prompt.test.mjs`：改为**真的跑一遍 `cli/keyframes.mjs --dry-run`**，断言打印出来的提示词 —— 时间措辞「0秒时：」被剥掉、有构图覆盖时基础构图那两行硬约束让位、没有覆盖时硬约束必须原样在。
- `tests/generation-config.test.mjs`：视频默认档改为跑 `cli/unit.mjs --dry-run` 断言实际档位串 `fast / i2v / normal / vsa`；超时与步数改为在子进程里 `import` 配置模块，断言真实导出值与非法值被拒。删掉 `flag('steps', …)` / `args.push('--timeout', …)` 这类装配断言。
- `tests/cli-errors.test.mjs`：删掉视频档位那 8 条源码断言（已由上面的行为断言接管），只留报错与闸门行为。

### 集成验证纳入回归集

- `tests/run-all.mjs` 改为**递归**收集 `*.test.mjs`（跳过 `fixtures/`）。此前只扫顶层，`tests/integration/dsh-plugins.test.mjs`（41 项，默认验仓库 `plugins/` 源码、确定性）**一次都没被跑过**，等于没有保护。
- `VERIFY_INSTALLED=1`（验本机已安装插件副本）仍是手动档，不进回归集。

### 其他

- 删除零引用夹具 `tests/fixtures/legacy-v4-render-plan.json`（唯一的引用方 `plan-provenance.test.mjs` 已随机器审核删除）。
- `README.md`：测试章节写明判据（测行为、不测源码文本、孤儿测试连函数一起删、新能力必带测试）；目录树去掉已删的 `references/qa/`，补上 `qa-and-review.md`；导演阶段补 `cli/register-direction.mjs` 用法与 `--max-tokens 30000` 的坑。

## 2026-09-19 - 流程改造：默认走本地，剧本可 Agent 直写

### 默认通道改为本地 ComfyUI

- `.env` / `.env.example` / `src/config.mjs`：`AIH_ASSET_PROVIDER` 与 `AIH_KEYFRAME_PROVIDER` 默认值从 `bailian` 改为 `comfyui`。
- `README.md` 和 `references/workflow.md` 的资产、关键帧示例不再默认 `--provider bailian`；用户仍可用 `--provider bailian` 显式覆盖。
- `src/providers/index.mjs` 顶部说明更新：保留 A/B 实测数据，但结论改为「本地是默认，线上是显式覆盖」；列出已知代价（构图、人脸、细节可能弱于线上）。

### 剧本支持 Agent 直写登记

- `cli/script.mjs` 新增 `register-agent` 子命令：`register-agent --input <草稿> --out <项目/story.md> [--drafted-by <标识>]`。
- `src/script-provenance.mjs` 新增 `agent_draft` 来源：票据记 `drafted_by`，`model`/`response_model` 为 null；禁止冒充模型产物或用户原稿。
- 短片默认走 `register-agent`：用户就在对话里，不满意改完重新登记，不绕付费模型。

### 调试模式补齐

- `cli/prepare-handoff.mjs` 新增 `--skip-gate`，与其余入口对齐。
- `cli/assemble-units.mjs` 新增 `--skip-gate`；调试模式下没有人工票时，允许从实际产物取片完成合成（正式流程仍必须持有票）。

### 缺陷修复

- `src/generation-plan.mjs`：`reference_previous` 模式的 `continuity.previous_unit` 此前只翻译 `continue_previous`，导致 `prepare-handoff` 按导演单元 id 找不到生成单元产物；现在两种模式都完成 `u1 → g001` 的 ID 翻译。
- `src/script-generation.mjs` 残留一句 `model !== SCRIPT_MODEL` 的硬限制已删除（与「不限制模型」的改动一致）。

## 2026-09-19 - 清理失去意义的测试与遗留导演入口

起因：放开机器审核之后，一批测试守的是「已经不影响流程的东西」。**全绿不等于有保护** ——
判据不是「它还绿不绿」，而是「它守护的行为今天的流程里还在不在」。

### 遗留导演入口停用

- `src/board.mjs direct` / `apply-direction` 停用，改用 `cli/direct.mjs`。这两个子命令是 `cli/direct.mjs`
  之前的旧入口，README / workflow 早已不提，但代码一直活着，是「两套导演入口」的历史遗留。
- 连带 `src/direction-shots.mjs` 的 `applyDirection` 变为零引用；该文件已于当日清理删除（见下）。

### 删除已无调用方的校验代码

- `src/director.mjs`：`validateDirection`、`findDialogueLeak`、`checkReverseFacing`，以及只服务它们的常量
  （15 秒上限、切词表、景别 / 朝向 / 高风险动作枚举）。文件 688 → 247 行。
- `src/script-provenance.mjs` 的 `requireScriptProvenance`、`src/direction-provenance.mjs` 的
  `requireDirectionProvenance`：这两个函数此前已从所有入口摘除、零调用方，只剩测试在守。
- `tests/director.test.mjs` 68 条断言 → 7 条。保留的是**仍在生效**的两类：简报装配、台词识别。

### 补上新增能力的测试（此前的欠账）

- 手工单元切分 `--units` 之前零覆盖。新增 4 条纯函数测试（合并、直写时长、未提及单元各自成组、
  引用不存在的单元要报错）与 4 条 CLI 端到端测试（`tests/compile-units-manual.test.mjs`）。
- 顺带修一个真缺陷：手工边界引用不存在的导演单元时，`byUnit.get(unitId) || []` 会静默产生
  **空的生成单元**；现在直接报错退出。

### 测试口径

- 不再新增「正则匹配源码文本」的断言 —— 那测的是「代码里有没有写这行字」，不测行为。
- 修 `tests/generation-config.test.mjs` 一条因写法变化而误报的断言：代码一直正确，是测试没跟上。

## 2026-09-19 - 移除机器审核、放开导演模型、编译单元可手工切分

起因：用户要求「去掉 QA 机器人审核，不限制必须百炼 qwen3.8-max 出稿，编译单元」。

### 机器审核全部移除，只留人工确认

- 删除视觉质检与成片自检：`src/qa.mjs`、`src/score.mjs`、`src/review.mjs`、`cli/qa-batch.mjs`、
  `cli/qa-local-keyframes.mjs`、`references/qa/brief.md`。`cli/inspect.mjs` 保留 —— 它是送审用的抽帧工具，不是审核。
- 摘掉各入口的强制校验：导演契约 `validateDirection`（direct / revise-unit / director-batch）、计划身份证
  `assertPlanProvenance`（unit / keyframes / assemble-units）、情绪契约 `assertUnitEmotionContract`、来源票
  `requireScriptProvenance` / `requireDirectionProvenance`（init-board / direct / revise-unit / assets / design-assets /
  review-gate / board）、导演协议 v6 版本下限。
- `src/plan-provenance.mjs` 只留 `makePlanProvenance` / `sealPlan`；计划身份证降级为留痕，
  跨剧沿用、手改计划、换剧本不重编都不再被拦。
- 人工票据（`review.approvals.json`）是唯一剩下的自动化。它防的是「确认了 A、交付了 B」，不是替人判断质量。

### 放开导演与剧本模型

- `src/config.mjs` 的 `advancedModel()` 不再校验白名单，只校验非空；`.env` 可填任意模型名。
- `src/director.mjs` 删掉「导演必须使用已批准的高级模型」的硬校验，保留「响应模型必须与请求模型一致」。
- 剧本与导演来源票改为只校验自洽（请求与响应是同一个模型），不再限定 `qwen3.8-max`。

### 编译单元可手工切分

- `cli/compile-units.mjs` 新增 `--units <units.json>`：`groups` 指定哪些导演单元合并成一个生成单元，
  `generation_duration_s` 直写生成时长（不受 5.17–15 秒自动钳制）。未列出的导演单元各自单独成组，不丢镜头。
- 计划 `policy` 增加 `manual_boundaries` 标记，单元 `boundary_reason` 为 `manual` / `manual_leftover`。

### ⚠️ 本次操作造成的事故

执行删除时用 `git rm` 一次传了 8 个路径，导致 `cli/`、`src/`、`references/`、`tests/` 四个目录的**全部**文件
被从工作区删除（不止指定的那 8 个）。已用 `git checkout HEAD --` 全部恢复，但 **2026-09-18 那批未提交的改动
（剧本 `agent_draft` 来源、结尾标记解析、导演 schema 示例）永久丢失** —— 工作区改动不在 git 里，无法找回。
因此 `cli/script.mjs` 目前只有 `generate` / `register-user` 两条来源，`register-agent` 需要重新实现。
教训已写入项目记忆：**本工程禁用 `git rm` 批量删文件**。

## 2026-09-18 - 剧本允许 Agent 直写 + 导演契约两处修正

起因：短片 `wig_sneeze` 立项时，剧本强制走百炼 `qwen3.8-max` + 来源票，导致改一个字就要重跑入口、重新出票、重新送审；而短片剧本天然要反复改。用户明确指出「本身就在跟 Agent 聊，不满意直接改就行」。

- 剧本新增第三条合法来源 `agent_draft`：`cli/script.mjs register-agent --input <草稿.md> [--material <素材.txt>] --out <项目/story.md>`。
  草稿由对话里的 Agent 写成，来源票记录 `source=agent_draft`、`drafted_by=agent` 与素材哈希，**不声明模型、不代签人工确认**；
  人工确认仍走 `review-gate --stage story`。模型创作降为可选，**短片默认走直写**。
- 剧本解析：独立成行的结尾标记（`（完）`/`（全剧终）`/`（剧终）`等）识别为 `end_marker`，不再被当成动作行凑成垃圾镜头。
  此前 `（完）`（3 字）直接让板子契约校验拒收、建板失败；`tiantian_dream_20260918_v2` 的 `（全剧终）`因恰好 5 字侥幸过关，
  同样污染了分镜。新增 `tests/end-marker.test.mjs`。
- 导演契约：`references/director/schema.md` 给 `continuity.allowed_changes` 补数组写法示例。此前文档只写字段名，
  模型连续三次写成字符串被校验拒收；补示例后该错误消失。
- 台词保真、来源票互斥校验、结局标记解析均补确定性测试。

## 2026-09-18 - 导演 Responses 通道

- 导演请求改为直接读取百炼流式 Responses 的起始和完成事件；拒绝断流、未完成和模型不符，完成后从 `output[].content[].text` 提取正文。显式设置推理强度 `low`，避免模型默认 `xhigh` 耗尽输出额度。CLI 非流式 Responses 在较长输出下仍于 308 秒撞响应头超时，CLI 流式摘要又不报告模型，均不能满足来源审计。凭据优先取本地 `.env`，否则沿用 bl 本机配置。
- 剧本生成改为复用同一流式传输层，保留输入与剧本哈希、请求及响应模型的来源票；本地执行计划编译不涉及百炼请求。生图、配音和视觉检查暂不迁移。
- 真实剧目验收：导演入口在 131 秒产出 v6 导演稿及来源票，请求和响应模型均为 `qwen3.8-max`；产物进入人工审阅，未代签方向票。

## 2026-09-18 - 新项目起步、画幅与审阅契约对齐

- 剧本须有来源票并经人工确认，导演入口才可继续；新增 `cli/init-board.mjs`，从已登记的剧本和明确提供的 Brief 确定性建板，不代写剧情、不代签确认。资源入口改认导演来源及新版方向票，旧 storyboard 的 story/shots 票不再阻塞现行流程。
- 关键帧送审、签票和视频生成统一绑定计划实际使用的图片路径；连续性交接关键帧也纳入同一清单，避免通道草稿图和计划槽位同内容不同路径造成票据失效。超出参考图上限时明确报错，不再静默截断。
- `board.meta.aspect` 统一决定 9:16、16:9 或 1:1 的关键帧、视频与合成尺寸；合成后调用成片技术检查，未通过不出送审单。
- 修正导演 v6、拆单元六类理由、人工票据、命令参数和退役提示词文档；新增相关确定性测试。未改默认常规 480、高质量 768 或 VSA 配置。
- 资源阶段新增场景师与人物造型师的确定性方案层：先从导演方案编译空间/造型提示词和缺失信息，再由导演审核后进入生图；本次只生成方案，不代替人工资源确认。

## 2026-09-18 - 视频片段只保留当前产物

- 常规与高质量规格分别读取 `.env` 的 `AIH_VIDEO_NORMAL_SIZE`（当前 `480x864`）和 `AIH_VIDEO_HIGH_SIZE`（当前 `768x1344`）。默认常规；明确要求高质量时用 `--quality high`。合成同样按这两个尺寸选档。
- 生成结果统一写 `units/<id>.result.json`，片段确认统一写 `approvals.clips.<id>`；不满意则重抽并重新确认。旧项目的 `<id>.final.result.json` 与旧嵌套确认票仅保留读取兼容，不再写入。
- 移除 `--variant` 和视频 `--size` 覆盖入口，避免绕开当前票据与 `.env` 尺寸；连续性交接、串行闸门、合成和面板均改用当前片段。
- 统一剧本、导演、资产、关键帧和视频的模型与默认规格配置到根目录 `.env`；模板为 `.env.example`，本地 `.env` 不入库。旧 `board.mjs from-story` 停用，避免本地模型绕过剧本/导演来源留痕。剧本与导演的来源票由执行入口生成，后续阶段核对票据和产物哈希。
- 本地资产按 `AIH_LOCAL_IMAGE_STEPS` 指定步数；百炼关键帧尺寸独立读取 `AIH_BAILIAN_KEYFRAME_SIZE`，绘梦独立入口读取 `AIH_HUIMENG_IMAGE_MODEL`。补回归测试，清理未被引用的根目录临时探针，不删除正式测试与夹具。

## 2026-09-17 - 恢复低分辨率单轮定稿 + 生图风格链三处修正

起因：新剧目 `after_waking`（9:16 / 3D 卡通 / 4 单元）第一次完整走付费通道，暴露了 5 条工程级缺陷。

### 行为变化

- **恢复「低分辨率单轮定稿」**（用户明令；同日晚些时候的批量撤回曾把它一起撤掉）。
  `cli/unit.mjs` 的 `CLIP_VARIANT` 恒为 `final`，原先「正式档要求预览档产物 + 预览票」的前置检查删除。
  片段产物只有 `units/<id>.final.result.json` 一种；`--quality test`（`480x864`）出的那一条就是交付物，
  出片即送审、确认即定稿。`--quality final`（`768x1344`）降级为**换尺寸重抽**，不构成第二轮、不产生第二张票。
  串行闸门（上一段确认后才生成下一段）与逐段人工确认语义**不变**。

### 修正

- **`gen.py --style` 从未被传入**：通道调的是显式 `t2i`，而 `gen.py` 的 `infer_style()` 只在 `auto` 模式下跑，
  于是 `args.style` 永远停在 argparse 默认值 `realistic` —— 它的**负向词里写着「CG感，卡通，动漫」**，
  把提示词里的风格描述整个抵消。`cli/assets.mjs` 现在按 `board.meta.style` 显式传 `--style`，
  道具图固定 `realistic`（它自带写实配方）。
- **`--fast` 会让 `--style` 失效**：`--fast`（4 步 Lightning）把 cfg 拉到 1.0，**负向条件不再起作用**。
  资产阶段要风格受控时必须用显式步数。
- **身份图不再从参考图锁定发型**：`src/assets.mjs` 的 4 面板配方原写「锁定长相（脸型、五官、**发型**）」，
  但按板子契约**发型属于 `identities[]`**。结果是换发型/换性别的造型会出一张**内部矛盾**的身份图
  （Panel1 是参考图的短发男脸、Panel2-4 是造型描述的长发女装），关键帧再照 Panel1 锁脸就把错误一路带到成片。
- **`cartoon3d` 风格锚改成正向的"具体形状"**：只写「3D 卡通动画长片质感」这类**风格名**两个通道上都出写实；
  改成点名「大眼睛、圆润面部轮廓、简化夸张的五官比例、平滑卡通皮肤、饱满体型」后才出得来。
- **关键帧参考图每人只给一张，优先身份图**（`cli/keyframes.mjs`）：原先 1 人时塞 `[场景, 肖像, 身份图]`、
  2 人时只给 `[场景, 肖像A, 肖像B]`（丢掉身份图）。肖像挂在角色上而**头发画在肖像里**，
  一个角色多套发型时肖像必然与其中若干套矛盾，模型在矛盾参考图之间随机选边。
- **`keyframes` 与 `compile-units` 的导演票死锁**：前者要求 `direction` 票绑执行计划 `render.plan.json`，
  后者要求绑导演稿 `board.direction.json`，而票据只有一个 `artifact_hash` 槽位 —— **签哪个都会让另一个失败**。
  `keyframes` 已改为与 `compile-units` 对齐（绑导演稿），并用 `assertPlanProvenance`
  反证「这份计划确实派生自那份导演稿」，比单哈希更强。

### 验证

- `npm test`：20/20 个测试文件通过（36 项断言）。
- 新剧目 `after_waking` 全程走通：剧本（台词逐字保真）→ 导演 v6（零错零警告）→ 生成计划 → 资源（百炼 7 项）
  → 关键帧（本地 4 张）。花费约 1.86 元，全部在资源与探针上。

## 2026-09-17 - 中文剧名契约

- 新建故事必须生成至少包含一个汉字的 `meta.title`。
- 英文目录名继续保存在 `meta.project`，不重命名现有项目目录，避免计划身份证和产物路径失效。
- 已核对现有正式项目：`一个误会`、`胆小猫与嘴硬老鼠`、`大师兄的离谱负责`、`肩上的蚊子` 均已使用中文剧名。

## 2026-09-17 - 视频单轮上限调整

- 视频生成等待上限由 30 分钟改为 10 分钟，并显式传给底层 `gen.py`。
- 达到上限后通知 ComfyUI 中断当前任务，避免外层退出后 GPU 继续计算。
- 结果文件必须晚于本轮启动时间，防止超时后误读上一轮残留结果。
- 本次不改变 `480x864` 预览档、`768x1344` 正式档及两轮人工确认语义。

## 2026-09-17 - 流程可靠性与 FastH3 路线收敛

### 新增

- 百炼调用统一走直接 CLI 执行层，进程未启动、超时或无产出时显式失败。
- 新增开工前检查清单，覆盖环境、预算、输入规格和提示词冲突。
- 视频片段确认拆成 `preview` 与 `final` 两张独立票据；旧版单票据只按正式票兼容读取。
- FastVideo FastH3 支持单首帧 `i2v` 和通过 `--last-keyframe` 启用的单首尾帧 `fl2v`。
- 关键帧生成成功后复制到计划声明的稳定槽位，避免通道目录与下游契约漂移。

### 修正

- 无参数视频生成默认使用 FastH3、VSA、8 步和 `480x864`；正式分辨率仍默认 FastH3，不再自动切换到慢速基础 H3 `r2v`。
- 正式片段生成前必须有同单元预览票；下一单元生成前必须有上一单元正式票；合成只接受正式票。
- `avoid_symbols` 不再以负例词表原样进入提示词。已知类别编译为正向表演边界，未知类别留给 QA 和人工审阅。
- 竖幅双人中景改为条件性几何检查，不再宣称所有此类构图都不成立。
- `keyframe_start` 中的人名搜索降为启发式 warning，不再作为完整人物集合的强证明。
- `.tmp-*.mjs` 加入 Git 忽略列表。

### 兼容

- 继续读取旧的 `units/<id>.result.json` 与旧版片段确认票，但新产物写入 `<id>.preview.result.json` / `<id>.final.result.json`。
- `--steps` 仅作为旧命令兼容参数；新命令使用 `--profile` 与 `--quality` 明确表达模型路线和尺寸。

### 验证

- `npm test`：20/20 个测试文件通过。
- 本轮只做确定性工程验证，没有调用付费生图或视频生成。
