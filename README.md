# Story2Video Harness

把故事或成品剧本转换为导演方案、视觉资产、关键帧、逐段视频和最终成片的本地工程。

工程的重点不是"一键生成"，而是让每个高成本阶段都有结构化输入和人工确认，避免错误一直传到视频生成阶段。

## 当前流程

```text
立项参数 -> 故事/剧本 -> 导演方案 -> 资源 -> 关键帧 -> 逐段视频 -> 字幕过滤 -> 合成 -> 最终审阅
```

用户只提供短句或故事点子时，必须先确认视觉风格和画面比例。已经明确提供的参数不重复询问；不能沿用上一部剧的设置，也不能静默猜默认值。

正式流程只有一道闸门：**人工确认**。工程不做机器审核 —— 没有视觉模型打分、没有成片自检、没有契约或来源票的强制校验。产物生成后直接送审，能不能用由人判断。导演方案、资源、关键帧、每段视频和最终成片都需要人工确认。产物被替换后，旧确认会因文件哈希变化自动失效。

生成计划带项目身份证，绑定剧目 ID、剧本、Storyboard、导演稿和计划内容哈希，**只作留痕**：换剧、改了源文件或手改计划都不会被代码拦住，判断计划是否仍然对得上由人来做。导演协议版本也不再设下限。

完整执行规则见 [SKILL.md](SKILL.md)，工程行为变更见 [CHANGELOG.md](CHANGELOG.md)。

## 目录

```text
ai-images-harness/
├─ SKILL.md                  Skill 入口、状态机和阶段路由
├─ README.md                 工程说明
├─ CHANGELOG.md              工程行为变更记录
├─ .env.example              本机模型、通道与规格配置模板
├─ cli/                      可直接执行的命令
├─ src/                      业务逻辑和提供方适配
├─ references/               按阶段加载的规则和模型提示
│  ├─ preflight.md           开工前清单（环境体检、预算、提示词自检）
│  ├─ qa-and-review.md       人工送审规则（只有人工确认，没有机器审核）
│  ├─ director/              导演 Brief 与输出结构
│  └─ prompts/               故事与 storyboard 提示模板
├─ schema/                   Storyboard JSON Schema
├─ tests/                    确定性测试（含 tests/integration/ 活体验证）
└─ plugins/                  UI 插件
```

仓库不保存真实剧目的图片、视频、音频、缓存或运行日志。

测试输入例外：最小、稳定、无生成媒体的 JSON/文本夹具保存在 `tests/fixtures/`。需要真实 ComfyUI、云服务或已安装插件的检查放在 `tests/integration/`，不属于普通单元测试。

## 项目工作区

每部剧放在仓库外的独立目录：

```text
E:\AI-Tool\DeepSeek\story2video\projects\cat_mouse\
├─ story.md
├─ story.provenance.json
├─ board.json
├─ board.direction.json
├─ board.direction.json.provenance.json
├─ render.plan.json
├─ review.approvals.json
├─ inputs\references\          用户原始参考图，只读保存
├─ assets\
├─ keyframes\
├─ units\
├─ reviews\
├─ out\
└─ .tmp\
```

不要把项目输出写到仓库根目录，也不要创建跨剧目共用的 `comfy-out`。

## 基本用法

先参照根目录的 [`.env.example`](.env.example) 配置本机 `.env`。**剧本和导演稿默认由当前对话的 Agent 直写**，不调外部大模型 —— `AIH_SCRIPT_MODEL` / `AIH_DIRECTOR_MODEL` 只在**显式要调模型**时才用得到（不限制厂商或型号）。资源和关键帧分别读取资产/关键帧通道与模型配置。视频默认 `AIH_VIDEO_QUALITY=normal`、`AIH_VIDEO_PROFILE=fast`、`AIH_VIDEO_ATTENTION=vsa`，两档尺寸由 `AIH_VIDEO_NORMAL_SIZE` 和 `AIH_VIDEO_HIGH_SIZE` 指定。`.env` 不入库，已有进程环境变量优先。

剧本必须由正式入口登记并留下来源票；已有完整用户原稿只能在用户明确确认后登记，不能代签：

```powershell
node cli/script.mjs register-agent --input <草稿.md> [--material <素材.txt>] --out <项目/story.md>      # 默认：当前对话的 Agent 直写
node cli/script.mjs register-user --input <用户原稿> --out <项目/story.md> --confirmed-by <确认者>       # 用户原稿
node cli/script.mjs generate --input <素材.txt> --out <项目/story.md>                                  # 可选：调外部模型（不默认走）
```

**默认 `register-agent`**：剧本要的就是理解和判断，当前对话模型就能写，改一个字重新登记即可，不必绕付费模型。「剧本必须用外部大模型写」这条旧约束已作废。人工确认仍走 `review-gate --stage story`，登记不等于确认。

先给用户展示完整剧本，取得明确确认后记录 `story` 人工票；按已确认的剧名、风格、画幅、故事概述和人物资料填写 [Brief 最小模板](references/board-brief.example.json)，再由代码建立 `board.json`。初始化只搬运原文台词并建立索引镜头，**导演方案默认由当前对话的 Agent 按 `references/director/` 的契约直写**，不是"必须交给外部模型设计"。

```powershell
node cli/review-gate.mjs approve --project <项目目录> --stage story
node cli/init-board.mjs --story <项目/story.md> --brief <项目/board-brief.json> --out <项目/board.json>
```

Brief 不可由执行 Agent 擅自补写；角色脸部和服装若仍是“待补”，必须在付费生图前补齐并送审。画幅可为 `9:16`、`16:9` 或 `1:1`，关键帧、视频和合成均按 `board.meta.aspect` 使用对应形状。

检查 Storyboard：

```powershell
node src/board.mjs validate <board.json>
node src/board.mjs table <board.json>
```

生成并确认导演方案。**默认由当前对话的 Agent 直写**，调外部模型只是可选项 —— 两条来源都不再设机器校验，唯一把关的是人工审阅：

```powershell
node cli/register-direction.mjs <board.json> --input <草稿.json> [--authored-by agent]     # 默认：Agent 直写导演稿后登记
node cli/direct.mjs <board.json> --story <story.md> --out <board.direction.json>          # 可选：调外部模型（不默认走）
node cli/review-gate.mjs approve --project <项目目录> --stage direction
node cli/compile-units.mjs <board.direction.json> --out <render.plan.json>
```

草稿按 `references/director/` 里的契约写出，`register-direction` 只做「校验 JSON → 落盘 → 留来源票」，不调任何模型；票据记 `agent_draft` / `model: null`，**不得冒充模型产物**。（万一真要用 `cli/direct.mjs`：完整导演稿较长，需 `--max-tokens 30000`，默认 12000 会中途截断。）

单元边界默认由导演方案决定。要手工切分（哪些导演单元合并成一个生成单元、每个单元生成多少秒），传 `--units`：

```powershell
node cli/compile-units.mjs <board.direction.json> --out <render.plan.json> --units units.json
```

```json
{
  "target_seconds": 12,
  "groups": [
    { "source_units": ["u1", "u2"] },
    { "source_units": ["u3"], "generation_duration_s": 9.5 }
  ]
}
```

`generation_duration_s` 直写生效，不受 5.17–15 秒的自动钳制；没写就按内容时长钳到该区间。没被 `groups` 列出的导演单元各自单独成组，不会丢镜头。

生成并确认视觉资源：

```powershell
node cli/assets.mjs <board.json>
node cli/review-gate.mjs approve --project <项目目录> --stage assets
```

必须逐张查看资源原图后再执行确认命令；资源文件被替换后票据自动失效。
资源入口会从 `<项目目录>/board.json` 解析实际引用文件；使用外部工作区时，生成和确认两边都传同一个 `--ws`。

生成关键帧：

```powershell
node cli/keyframes.mjs <board.json> --direction <render.plan.json>
node cli/review-gate.mjs approve --project <项目目录> --stage keyframes --plan <render.plan.json>
```

逐段生成视频（默认常规尺寸，每段人工确认）：

```powershell
node cli/unit.mjs <board.json> --direction <render.plan.json> --unit g001
```

明确要求高质量时，在该命令加 `--quality high`。生成结果为 `units/<id>.result.json`；每段只保留当前视频的确认票，不满意重抽后须重新确认。

默认尺寸由 `.env` 的 `AIH_VIDEO_NORMAL_SIZE` 指定（当前 `480x864`）；明确要求高质量时用 `--quality high`，尺寸取 `AIH_VIDEO_HIGH_SIZE`（当前 `768x1344`）。不满意就重抽并重新确认。
15 秒是单次生成上限，不是目标时长；视频必须串行生成并逐段人工确认。

合成所有已确认片段：

```powershell
node cli/assemble-units.mjs <render.plan.json> --out <out/final.mp4>
```

高质量成片同样加 `--quality high`；合成尺寸取 `.env` 的高质量尺寸。

历史计划需要显式迁移到当前契约时使用 `cli/migrate-plan.mjs`；它要求列出已人工复核的单元并传入 `--acknowledge-reviewed-migration`，不属于普通新项目流程。

合成前检查全部片段票据：

```powershell
node cli/review-gate.mjs ready-assemble --project <项目目录> --plan <render.plan.json>
```

## 诊断工具

```powershell
node cli/inspect.mjs <媒体文件> --aspect 9:16 --first-last
node cli/wait-ready.mjs
node cli/animatic.mjs <board.json> --direction <board.direction.json>
node cli/desub.mjs <视频>
```

其他专项入口：`cli/huimeng.mjs` 调用绘梦生图，`cli/look-local.mjs` 检查本地造型。它们不是主流程入口。

发生模型、音频、字幕或 ComfyUI 问题时，读取 [references/troubleshooting.md](references/troubleshooting.md)。

## 测试

### 确定性测试（不联网、不烧卡）

```powershell
npm test
```

递归运行 `tests/` 下全部 `*.test.mjs`（含 `tests/integration/`；`fixtures/` 是测试输入不是测试，跳过），新增文件无需维护清单。

**判据是「它守护的行为今天还在不在」，不是「它还绿不绿」。** 所以这里只收行为断言：

- **纯函数**直接 import 调用；**CLI** 实际跑一遍再断言它的输出（多数用 `--dry-run`，既确定性又不调通道）；产物落盘后读回来比对的算产物行为。
- **不测源码文本**：不用正则去查「源码里有没有写这行字」—— 源码换个等价写法它就假红，行为真坏了它却绿。这类断言已清零，不再新增。
- 被守的函数删了，守它的测试一起删，不留孤儿测试；**新增能力必须带测试**。

全部确定性测试都自带输入，**不依赖任何外部工作区**：

- `assemble-review.test.mjs` 的输入都在临时目录里用 FFmpeg 现造（需要本机有 `ffmpeg`）。
- 需要板子的测试默认读仓库内的 `tests/fixtures/`，也可以显式传入板子覆盖：

```powershell
node tests/director.test.mjs <board.json> <story.md>
node tests/contract.test.mjs [board.json]
node tests/assets.test.mjs <board.json>
node tests/orchestrate.test.mjs <board.json>
```

夹具是**测试输入**，随代码保存；约定见 [tests/fixtures/README.md](tests/fixtures/README.md)。
不要把这些测试的默认路径改回指向外部工作区的绝对路径 —— 那会随工作区迁移再次失效。

### 集成验证

`tests/integration/` 的活体验证**默认已包含在 `npm test` 里** —— 它默认验的是仓库 `plugins/` 源码，不碰本机环境，是确定性的。

只有「验本机已安装的插件副本」这一档需要手动跑，它依赖 DSH profile，**红了通常是提示你重装插件，不是测试坏了**：

```powershell
$env:VERIFY_INSTALLED=1; node tests/integration/dsh-plugins.test.mjs
```

## 规则所有权

唯一所有权表见 [SKILL.md](SKILL.md)；不要在 README 再维护一份。具体项目的临时实验结果不进入源码仓库。

## 依赖

- Node.js 20+
- FFmpeg / FFprobe
- 本地 ComfyUI 与 `comfy-studio`
- 百炼 CLI（使用百炼图片模型时）

模型凭据、项目媒体和运行缓存不得提交到仓库。

运行配置集中在仓库根目录 `.env`（按 `.env.example` 填写，已被 Git 忽略）。包含生图通道及模型、H3 档位/尺寸和本机工具路径；生图通道可选 `comfyui`、`bailian`、`volcengine`（火山方舟 Seedream）。使用火山通道时填写 `AIH_VOLCENGINE_API_KEY`，模型由 `AIH_VOLCENGINE_IMAGE_MODEL` 配置。命令行显式参数仍可覆盖非剧本/导演模型的运行档位。`AIH_SCRIPT_MODEL` / `AIH_DIRECTOR_MODEL` 接受任意非空模型名、不再设白名单，但**默认用不到** —— 剧本和导演稿默认由当前对话的 Agent 直写，只有显式调 `generate` / `cli/direct.mjs` 时才读这两项。剧本和导演稿可生成哈希绑定的来源票作为留痕，但票据不是放行前提。

## License

MIT
