# Change Log

记录工程级行为变化。具体剧目的抽卡结果、耗时和逐帧评价留在对应项目目录，不写入这里。

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
