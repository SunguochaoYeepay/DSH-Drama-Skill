# Story2Video Harness

把故事或成品剧本转换为导演方案、视觉资产、关键帧、逐段视频和最终成片的本地工程。

工程的重点不是“一键生成”，而是让每个高成本阶段都有结构化输入、机器检查和人工确认，避免错误一直传到视频生成阶段。

## 当前流程

```text
立项参数 -> 故事/剧本 -> 导演方案 -> 资源 -> 关键帧 -> 逐段视频 -> 字幕过滤 -> 合成 -> 最终审阅
```

用户只提供短句或故事点子时，必须先确认视觉风格和画面比例。已经明确提供的参数不重复询问；不能沿用上一部剧的设置，也不能静默猜默认值。

正式流程使用双钥匙闸门：机器 QA 通过只表示可以交给人看；用户明确确认后，才允许进入下一阶段。导演方案、资源、关键帧、每段视频和最终成片都需要人工确认。产物被替换后，旧确认会因文件哈希变化自动失效。

生成计划带项目身份证，绑定剧目 ID、剧本、Storyboard、导演稿和计划内容哈希。换剧、修改源文件或拿历史计划直接运行都会被拒绝；新计划最低使用导演 v5 协议。

完整执行规则见 [SKILL.md](SKILL.md)，工程行为变更见 [CHANGELOG.md](CHANGELOG.md)。

## 目录

```text
ai-images-harness/
├─ SKILL.md                  Skill 入口、状态机和阶段路由
├─ README.md                 工程说明
├─ CHANGELOG.md              工程行为变更记录
├─ cli/                      可直接执行的命令
├─ src/                      业务逻辑和提供方适配
├─ references/               按阶段加载的规则和模型提示
│  ├─ preflight.md           开工前清单（环境体检、预算、提示词自检）
│  ├─ director/              导演 Brief 与输出结构
│  ├─ prompts/               故事与 storyboard 提示模板
│  └─ qa/                    视觉 QA Brief
├─ schema/                   Storyboard JSON Schema
├─ tests/                    确定性测试
└─ plugins/                  UI 插件
```

仓库不保存真实剧目的图片、视频、音频、缓存或运行日志。

测试输入例外：最小、稳定、无生成媒体的 JSON/文本夹具保存在 `tests/fixtures/`。需要真实 ComfyUI、云服务或已安装插件的检查放在 `tests/integration/`，不属于普通单元测试。

## 项目工作区

每部剧放在仓库外的独立目录：

```text
E:\AI-Tool\DeepSeek\story2video\projects\cat_mouse\
├─ story.md
├─ board.json
├─ board.direction.json
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

检查 Storyboard：

```powershell
node src/board.mjs validate <board.json>
node src/board.mjs table <board.json>
```

生成并确认导演方案：

```powershell
node cli/direct.mjs <board.json> --story <story.md> --out <board.direction.json>
node cli/review-gate.mjs approve --project <项目目录> --stage direction --artifacts <board.direction.json>
node cli/compile-units.mjs <board.direction.json> --out <render.plan.json>
```

生成并确认视觉资源：

```powershell
node cli/assets.mjs <board.json> --provider bailian
node cli/review-gate.mjs approve --project <项目目录> --stage assets
```

必须逐张查看资源原图后再执行确认命令；资源文件被替换后票据自动失效。
资源入口会从 `<项目目录>/board.json` 解析实际引用文件；使用外部工作区时，生成和确认两边都传同一个 `--ws`。

生成关键帧：

```powershell
node cli/keyframes.mjs <board.json> --direction <render.plan.json> --provider bailian --model qwen-image-3.0-pro
```

逐段生成测试视频：

```powershell
node cli/unit.mjs <board.json> --direction <render.plan.json> --unit g001 --quality test --profile fast
```

正式规格使用 `--quality final`。15 秒是单次生成上限，不是目标时长；视频必须串行生成并逐段人工确认。

合成所有已确认片段：

```powershell
node cli/assemble-units.mjs <render.plan.json> --out <out/final.mp4>
```

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

其他专项入口：`cli/huimeng.mjs` 调用绘梦生图，`cli/look-local.mjs` 检查本地造型，`cli/qa-batch.mjs` 批量质检，`cli/qa-local-keyframes.mjs` 质检本地关键帧。它们不是主流程入口。

发生模型、音频、字幕或 ComfyUI 问题时，读取 [references/troubleshooting.md](references/troubleshooting.md)。

## 测试

### 确定性测试（不联网、不烧卡）

```powershell
npm test
```

该命令会运行 `tests/` 根目录下全部 `*.test.mjs`；新增测试无需再手工维护清单。

全部确定性测试都自带输入，**不依赖任何外部工作区**：

- `review.test.mjs` 的正例和负例都在临时目录里用 FFmpeg 现造。想看真实成片过不过，显式传 `--film <成片.mp4>`。
- 需要板子的测试默认读仓库内的 `tests/fixtures/`，也可以显式传入板子覆盖：

```powershell
node tests/director.test.mjs <board.json> <story.md>
node tests/contract.test.mjs [board.json]
node tests/assets.test.mjs <board.json>
node tests/orchestrate.test.mjs <board.json>
```

夹具是**测试输入**，随代码保存；约定见 [tests/fixtures/README.md](tests/fixtures/README.md)。
不要把这些测试的默认路径改回指向外部工作区的绝对路径 —— 那会随工作区迁移再次失效。

### 集成测试

需要本机环境（DSH profile / 插件），不属于上面的回归集：

```powershell
node tests/integration/dsh-plugins.test.mjs              # 默认验仓库 plugins/ 源码
$env:VERIFY_INSTALLED=1; node tests/integration/dsh-plugins.test.mjs   # 验已安装副本
```

## 规则所有权

| 内容 | 唯一所有者 |
|---|---|
| 开工前清单（环境体检、付费预算、提示词自检） | `references/preflight.md` |
| 流程和人工闸门 | `references/workflow.md` |
| 导演判断 | `references/director/brief.md` |
| 导演输出格式 | `references/director/schema.md` |
| Storyboard 格式 | `schema/storyboard.schema.json` |
| 资产和关键帧 | `references/assets-and-keyframes.md` |
| H3 执行约束 | `references/video-h3.md` |
| QA 与人工送审 | `references/qa-and-review.md` |
| 故障排查 | `references/troubleshooting.md` |
| 确定性实现 | `src/`、`cli/` 和 `tests/` |

同一规则不要复制到多个文件。具体项目的临时实验结果不进入源码仓库，也不能追加到主 Skill。

## 依赖

- Node.js 20+
- FFmpeg / FFprobe
- 本地 ComfyUI 与 `comfy-studio`
- 百炼 CLI（使用百炼图片模型时）

模型凭据、项目媒体和运行缓存不得提交到仓库。

本机工具路径可用环境变量覆盖：`AIH_PYTHON`、`AIH_GEN`、`AIH_NODE`、`AIH_BAILIAN_ENTRY`、`AIH_WINGET_PACKAGES` 和 `DRAMACLAW_ENV`。

## License

MIT
