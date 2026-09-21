---
name: story2video
description: 将故事或成品剧本编译为导演方案、视觉资产、关键帧、逐段视频和最终成片；适用于继续现有项目、审阅阶段产物或排查故事转视频流水线。
metadata:
  version: 3.1.0
---

# Story to Video

本文件只定义入口、状态机和路由。不要一次性读取全部参考资料；进入哪个阶段，就读取该阶段指定的 reference。

## 核心流程

```text
项目立项（风格 + 画幅 + 摄影语言 + 已有参考资产）
  -> 故事/剧本
  -> 导演方案
  -> 设计参谋（可选：场景师 / 人物造型师，见下）
  -> 资源
  -> 关键帧
  -> 逐段视频
  -> 去除错误硬字幕
  -> 合成
  -> 最终审阅
  -> 知识回流（最终确认之后必须做，不执行不算收工；**只沉淀，不改文件**）
```

**除「设计参谋」这一步外，每个箭头都是闸门**，不能因为文件已经生成或看起来差不多而跳过。**最后一个箭头同样是闸门：`final` 票记录之后，必须先完成知识回流，这一轮才算结束。**

> ⚠ **知识回流的默认产物是经验文字，不是改动。** 该写的照写（剧目 `reviews/`、`.workbuddy/memory/<日期>.md`）；
> 但工程代码（`src/` `cli/` `tests/`）、规则正本（`references/`）、项目提示词（`keyframe-prompts/*.txt`）
> **未经用户逐条同意，一个字都不改**。要改就先交提案（目标 / 改前原文 / 改后文字 / 依据），
> 同意后才落盘。见 `references/workflow.md` 的「收工与知识回流」。

设计参谋**不是闸门**：资源阶段读 `board.json`，不读 `asset-design.json`；关键帧只消费其中的人物造型条目，场景设计一条都不进提示词。整段跳过不会阻断后续任何步骤，也不需要人工票 —— 它的产出是给人和给契约的参考，不是给模型的提示词。

## 项目位置（立项前必读）

每部剧一律建在**实际运行生成的那套 story2video 副本**的 `projects\<剧名>\` 目录下（根目录随副本所在磁盘而定，例如 `E:\AI-Tool\DeepSeek\story2video\projects\`）。禁止在仓库旁边、其他磁盘或临时目录自建项目根。新建立项前先列一次该 `projects\` 目录：已有同名副目录就续用并先读其状态，没有才新建。

## 立项必问

用户只给短句、故事点子或未带制作规格的剧本时，**不得直接扩写或生成**。先确认：

1. **视觉风格**：例如写实电影、精致 3D 卡通、二维赛璐璐、水墨等。
2. **画面比例**：例如 `9:16` 竖屏、`16:9` 横屏或 `1:1`。
3. **摄影语言**：焦段、景深、机位高度、主光方向与光质、色温，以及要排除的风格（见 `references/cinematography.md`）。它决定"用什么机器拍"，与美术风格是两件事，不能混为一谈。

这三条是**项目级契约**：答案落进 `board.json` 与 `cinematography.json`，定下就全片不变。

> ⚠ **故事层面的三问不在立项问** —— 立项时剧本还没写，「这个意外凭什么发生」没有对象可问，而且答完没有落点。它们属于剧本闸门，见下面「固定人工节点」第 2 项的白话预演。

如果用户已经提供核心人物图片，还必须确认：

- 图片对应哪个角色。
- 它是**身份硬参考**，还是只用于风格/灵感参考。
- 需要锁定哪些内容：脸或头部、体型、服装、发型配饰、整体美术风格。

如果用户已明确提供，就直接采用，不重复询问。目标平台、期望总时长、对白语言等只有在会影响当前决策且无法从上下文判断时再补问。

风格、画幅、摄影语言和参考资产职责必须写入项目契约，并在剧本、资源、关键帧和视频阶段保持一致；不能沿用上一个项目的设置，也不能由 Agent 静默猜默认值。摄影契约里没写的字段，一个字都不进提示词。用户原图作为只读输入保存，不覆盖、不重绘后冒充原图。

## 人工闸门

剧本有三条合法来源，**默认第 ② 条**：① `cli/script.mjs generate` 调 `.env` 的剧本模型 —— **可选，默认不走**，只有用户明确要求"用模型写一版"时才用；② `cli/script.mjs register-agent --input <草稿> --out <项目/story.md>` 登记**对话里由 Agent（当前对话模型）直写的草稿** —— **这是默认路径**：写剧本要的就是理解和判断，当前对话模型就能做，不必再绕一圈外部付费模型，用户不满意直接在对话里改、改完重新登记；③ 用户原稿经其明确确认后用 `register-user --confirmed-by <确认者>` 登记。三者都留来源票，记录输入与剧本哈希；**任何来源都不得冒充另一种**：模型产物不得标用户原稿或 Agent 直写，用户原稿和 Agent 直写都不得标模型。`--confirmed-by` 是人工声明，不是身份认证，Agent 不得代签。缺票不再阻断流程，但票据缺失时不得倒填。

剧本人工确认后即冻结。导演、场景师和人物造型师只能报告问题、提出可选建议或拒绝进入下一阶段，**不得要求 Agent 直接改写已确认剧本，也不得把审查意见写回 `story.md`**。任何剧本修改都必须由用户明确授权，重新运行剧本入口并生成新的来源票据，再重新人工确认；否则只修复下游分镜/资产映射。

导演稿有**两条合法来源，默认第 ② 条**：① `cli/direct.mjs` 调 `.env` 的 `AIH_DIRECTOR_MODEL` —— **可选，默认不走**（同剧本：分镜分析要的判断力当前对话模型就有，调外部模型只是多绕一圈）；② **对话里的 Agent 直写** —— 按 `references/director/brief.md` + `schema.md` 的契约交付后用 `cli/register-direction.mjs` 登记。**判据不是「必须由另一个模型写」，而是「必须按契约交付，且单元边界诚实」** —— 白名单与机器校验都已取消，唯一把关的是人工审阅。两条来源各自留 `.provenance.json`（模型来源记请求与响应模型，直写来源记 `authored_by`），**只作留痕，不再作为放行前提**，且不得互相冒充。统一配置见根目录 `.env`（可参照 `.env.example`）；不要在项目文件中存密钥或改动全局默认值来切换剧目。

**正式流程只有一把钥匙：人工明确确认。**

工程不做机器审核：没有视觉模型打分，没有成片自检，没有契约或来源票的强制校验。产物生成后直接送审，能不能用由人判断。

用户没有明确表达通过，就视为未通过。Agent 不得代替用户写人工确认票。

固定人工节点：

1. 立项时确认风格、画幅和已有参考资产的职责。
2. **建板子后确认场景清单**（`board.json` 人工票，`review-gate approve --stage board`）：场景、角色、造型、道具都住在板子里，而它此前**全程无票**——`no_chute` 因此把"舱门口"这个真正的叙事空间漏掉了，一路绿灯到出图才发现。**改板子会让这张票失效**，这正是要它的理由。
3. 剧本生成后，展示完整剧本和结构检查结果，**并附一段白话预演**。预演要同时回答**故事三问**：

   - **这个意外/转折凭什么发生**：任何"突然发生"的事都要有一条观众看得见的来路（谁碰的、什么松了、为什么是现在）。没有来路的事件，观众看到的是"道具自己动了"。
   - **观众和角色各自在哪一拍知道什么**：先让观众看见危险、再让角色走进危险才有悬念；两边同时知道只剩惊吓。必须明确"谁先知情、第几拍知情"。
   - **这个动作画得出来、而且物理上自洽吗**：落物有没有正上方的落点、朝向与行进方向是否自洽、被砸的那个人有没有先站到落点上。这一条最容易在文本上看不出来 —— 文字可以写"从正上方落下"而调度让角色朝反方向走，只有把空间关系画出来才暴露。
   - **故事发生在哪几个空间？每个空间要有一张图**（2026-09-20 `no_chute` 补）：按"人物站在这儿的哪个位置、能做什么动作"分空间，不按"机位在里面还是外面"分。跳伞戏的空间是**舱门口与跳板**，不是"飞机外观"和"机舱内部"——按机位二分把它漏掉了，结果 u1 的画面要求（站在门洞里）被塞进"从机外看飞机"这个场景，关键帧的基底图取到的是"门洞发暗的飞机外观"，出图就是一架**门关着的飞机**，直到上屏才发现。

     判据很硬：**只要剧本里有一个动作需要人物处在某个位置（站在门洞里、走到跳板上、趴在窗台），那个位置就是一个独立空间，必须在场景清单里有名字、并且出一张主图。** 只有一个空间没有图，后续每个单元都在各自想象它，一致性无从谈起。

   白话预演**按剧本的场面/段落讲，不是导演稿的 shot 级** —— 这时导演稿还不存在。每一段说明画面上会看到什么、观众此刻知道什么、角色此刻知道什么。**只给文本是不够的**：因果缺口和物理错误在文本上看不出来（文字甚至可能是对的），只有把"这一段会怎么拍"讲成白话才暴露。**三问（现在是四问）的答案就是这段预演本身** —— **"剧本里没写"不是默认，是缺口**（`pot_hit` 2026-09-20 实测：这几问都没问，代价是 44 分钟返工加一次重做；`no_chute` 漏的是空间这一问）。见 [`references/workflow.md`](references/workflow.md) 的故事闸门。
4. 资源生成后，展示角色肖像、身份图、场景和道具总览。
5. 关键帧生成后，展示编号总览和每张原图。
6. 每段视频出片后展示完整视频和多帧总览，确认后才生成下一段；不满意就按意见重抽并重新送审。
7. 合成后展示成片和接缝检查结果，等待最终确认。

确认记录位于项目目录的 `review.approvals.json`，票据绑定产物哈希。重新生成、覆盖或修改产物后，旧票自动失效。

`--skip-gate` 只允许无成本调试，并必须打印警告。正式生图、生视频和合成不得使用。

完整闸门协议与恢复规则见 [references/workflow.md](references/workflow.md)。开始或恢复项目时必须读取它。

## 阶段路由

| 当前任务 | 必读资料 |
|---|---|
| **新建项目或开始新一轮生成之前（开工前）** | `references/preflight.md` |
| 新建项目、判断当前进度、恢复中断任务 | `references/workflow.md` |
| **写新剧本或修改剧本** | `references/story-craft.md`（入口；钩子/落点/对抗/题材/动作戏的专项类型学按需读其 `story-craft/` 子文件） |
| 生成或修改导演方案、决定视频单元边界 | `references/directing.md` |
| 生成角色/场景/道具资产或关键帧 | `references/assets-and-keyframes.md` |
| 生成设计参谋方案（可选，产出不进提示词） | `references/scene-designer.md`、`references/character-designer.md` |
| 立项定摄影语言、改镜头 / 光 / 风格头 | `references/cinematography.md`；题材取值参考 `references/art/<style>.md`（若存在） |
| 生成 FastH3/H3 视频、选择时长和规格 | `references/video-h3.md` |
| 人工送审、合成与终审 | `references/qa-and-review.md` |
| **`final` 票已记录，准备收工** | `references/workflow.md` 的「收工与知识回流」 |
| ComfyUI、音频、字幕、尺寸或进程异常 | `references/troubleshooting.md` |

只读当前任务需要的资料。例如审阅一张关键帧不需要加载 H3 参数和历史故障记录。

## 不可违反的全局约束

- 成品剧本的台词必须由代码逐字搬运，导演模型不得改写、缩写或补写。
- 15 秒是单次生成上限，不是目标时长；不能为了凑时长，也不能为了切割而切割。
- 一个生成单元最多包含一个高风险状态转换。多个高风险转换必须简化或设置新的状态锚点。
- 关键帧描述动作起点的稳定状态，不画动作过程的模糊中间态。
- 角色身份、造型、场景和道具必须引用结构化资产，不靠临时提示词重新发明。
- 视频逐段串行生成、逐段检查、逐段人工确认，禁止并发批跑。
- 台词必须有足够时长说完。时长由台词/音频和动作需求反推，不得裁断句尾。
- H3 暂时是既定视频模型。默认使用 `.env` 的常规尺寸（当前 `480x864`）；用户明确要求“高质量”时使用 `.env` 的高质量尺寸（当前 `768x1344`）。
- 视频生成是抽卡，重复生成不可避免。不满就重抽**同一规格**；不要把重跑当异常，也不要为省一轮而跳过确认。
- 下游发现单个镜头的姿态、走位、构图或动作问题时，走 `references/workflow.md` 的“局部返修分支”：剧本继续冻结，召回导演修订受影响单元，重新编译并只重跑该单元及其依赖链。
- 局部问题先分类：执行层约束缺失、提示词翻译不完整或生成参数错误，可由当前 Agent 直接修改该单元的直写提示词（`keyframe-prompts/<unit-id>.txt`，2026-09-21 起关键帧提示词的唯一来源，见 `references/draw-specialist.md` 工程接线节）并重跑受影响产物；涉及剧情、台词、角色设定、场景语义、单元边界或连续性决策，才必须由**导演角色**决定 —— **默认就是按同一契约执行的当前 Agent**（调 `cli/direct.mjs` 时才是那个模型），不能由抽卡师或执行层顺手改。此规则适用于所有剧目和所有对话模型，不绑定某个项目。
- 缩略图和任何自动化产物都不能替代人观看原图、完整视频和实听音轨。
- 不把带过期时间的远程 URL 写进项目契约；产物必须落到本地稳定路径。
- 真实项目和生成媒体必须在仓库外；确定性测试只使用仓库内 `tests/fixtures/` 的最小夹具，不依赖某个用户项目。

## 契约所有权

同一规则只能有一个所有者，其他文件只引用，不复制：

| 内容 | 唯一所有者 |
|---|---|
| 剧本工艺 | `references/story-craft.md`（入口）+ `references/story-craft/`（hooks / payoff / antagonist / genres / action） |
| Storyboard 数据结构 | `schema/storyboard.schema.json` |
| 导演输出结构 | `references/director/schema.md` |
| 导演决策规则 | `references/director/brief.md` |
| 场景师规则（可选参谋，产出不进提示词） | `references/scene-designer.md` |
| 人物造型师规则（产出只进关键帧） | `references/character-designer.md` |
| 场景师 Skill 入口 | `skills/scene-designer/SKILL.md` |
| 人物造型师 Skill 入口 | `skills/character-designer/SKILL.md` |
| 流程与人工闸门 | `references/workflow.md` |
| 资产和关键帧规则 | `references/assets-and-keyframes.md` |
| 摄影语言契约（镜头 / 光 / 锁定风格头） | `references/cinematography.md` |
| 分题材视觉语言（契约取值参考与契约外表演/造型语言） | `references/art/<style>.md` |
| H3 执行参数 | `references/video-h3.md` |
| 抽卡师：LLM 直写关键帧提示词（`keyframe-prompts/<unit>.txt`，逐字送模型） | `references/draw-specialist.md`（岗位、工作流与工程接线）+ `references/prompt-rules.md`（禁令与正向工艺）+ `references/draw-vocabulary.md`（词汇弹药） |
| 人工送审规则 | `references/qa-and-review.md` |
| 确定性行为 | `src/`、`cli/` 和对应测试 |

修改规则时先改唯一所有者，再改代码和测试。不要在本入口追加某次项目的特例。

## 常用入口

```powershell
# 查看板子与旧四阶段票据
node src/board.mjs validate <board.json>
node src/board.mjs table <board.json>

# 导演与生成计划
node cli/register-direction.mjs <board.json> --input <草稿.json>   # 默认：Agent 直写导演稿后登记
node cli/direct.mjs <board.json> --story <story.md> --out <board.direction.json>   # 可选：调外部模型（不默认走）
node cli/revise-unit.mjs <board.json> --unit <id> --feedback <reviews/revision.md>
node cli/compile-units.mjs <board.direction.json> --out <render.plan.json>
node cli/design-assets.mjs <board.json> --out <project/asset-design.json>   # 可选参谋：场景条目无消费者，造型条目只进关键帧

# 关键帧与单段视频
node cli/assets.mjs <board.json> --provider bailian
node cli/keyframes.mjs <board.json> --direction <render.plan.json> --provider bailian
node cli/prepare-handoff.mjs --plan <render.plan.json> --unit g002
node cli/unit.mjs <board.json> --direction <render.plan.json> --unit g001
node cli/assemble-units.mjs <render.plan.json> --out <out/final.mp4>

# 新版人工票据
node cli/review-gate.mjs approve --project <项目目录> --stage direction --artifacts <direction.json>
node cli/review-gate.mjs approve --project <项目目录> --stage assets
node cli/review-gate.mjs approve --project <项目目录> --stage keyframes --plan <render.plan.json>
node cli/review-gate.mjs approve --project <项目目录> --stage clip --id g001 --artifacts <g001.mp4>
node cli/review-gate.mjs ready-assemble --project <项目目录> --plan <render.plan.json>

# 排查与体检（不产出资产，只回答"实际发生了什么"）
node cli/dump-payload.mjs --project <项目目录> --unit <单元 id>   # 摊开这次生图真正提交给 ComfyUI 的原文
node cli/dump-payload.mjs <result.json 路径>                      # 同上，直接给 result.json
node cli/audit-audio.mjs --project <项目目录> --units g001,g002   # 按时域切片量音轨（响不响、什么时候响）
node cli/audit-audio.mjs <视频...>
```

排查工具只在怀疑"送进去的和想的不一样"时才跑，不是每阶段的必经步骤。
`dump-payload` 的数据来自 ComfyUI 自己的 `/history/<prompt_id>`（或 `--history <文件>`），
不是本地复现 —— 本仓 `--prompt` 不是最终稿，上游还会追加正向句、替换负向条件。

资产和关键帧开始生成前，必须先向用户确认本次通道（本地预览或线上生成）；不得把环境默认值当作用户选择。生成完成后先展示整组结果，并把每个产物的绝对路径交给用户（对话中用可打开的本地文件链接）；只有用户人工确认并登记对应闸门票据，才能进入下一阶段。每次生成会在项目 `reviews/<stage>.generation.json` 留下实际 provider、模型和产物清单。

具体参数属于对应阶段 reference，不在这里维护完整清单。

具体项目的实验结论不进入主 Skill；只有可复现、会改变通用决策的规则，才写入对应 reference。
