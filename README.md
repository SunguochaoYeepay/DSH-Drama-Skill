# 逐格 · Story2Video Harness

> 工程代号「逐格」：一格一格地拍 —— 逐段生成、逐段确认，每格都要有人签字。
> 名字说的是态度，不是速度。

![CI](https://github.com/SunguochaoYeepay/DSH-Drama-Skill/actions/workflows/ci.yml/badge.svg)
![Node](https://img.shields.io/badge/node-20%20%7C%2022-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)

把故事或成品剧本转换为导演方案、视觉资产、关键帧、逐段视频和最终成片的本地工程。

工程的重点不是"一键生成"，而是让每个高成本阶段都有结构化输入和人工确认，避免错误一直传到视频生成阶段。

> 改动规程（人工票纪律、测试判据、`references/` 规则的四要素提案）见 [CONTRIBUTING.md](CONTRIBUTING.md)。


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
├─ README.md                 工程说明
├─ CHANGELOG.md              工程行为变更记录
├─ CONTRIBUTING.md           改动规程：人工票、测试判据、规则提案
├─ SKILL.md                  Skill 入口、状态机和阶段路由
├─ .github/workflows/ci.yml  CI：Node 20 / 22 跑 npm test
├─ .env.example              本机模型、通道与规格配置模板
├─ cli/                      可直接执行的命令
├─ src/                      业务逻辑和提供方适配
├─ schema/                   Storyboard JSON Schema
├─ tests/                    确定性测试（含 tests/integration/ 活体验证）
├─ references/               按阶段加载的规则和模型提示
│  ├─ preflight.md           开工前清单（环境体检、预算、提示词自检）
│  ├─ story-craft.md         剧本工艺入口（节拍/动机/台词/自检）
│  ├─ story-craft/           剧本专项类型学（钩子/爽感/对抗/题材/动作戏）
│  ├─ cinematography.md      摄影语言契约（镜头/光/风格头，立项定、全片共用）
│  ├─ qa-and-review.md       人工送审规则（只有人工确认，没有机器审核）
│  ├─ director/              导演 Brief 与输出结构
│  ├─ art/                   分题材视觉语言库（realistic / cartoon3d / …）
│  ├─ draw-specialist.md     抽卡师岗位规范（LLM 直写制，2026-09-21 起）
│  ├─ prompt-rules.md        生图提示词禁令与正向工艺（双闸执行）
│  └─ draw-vocabulary.md     生图正向词汇库（光照/镜头/材质/姿态）
├─ examples/demo-show/       示例剧目：一整条契约链，只有文本没有媒体
├─ plugins/                  UI 插件
├─ vendor/comfy-studio/      外部工具快照（见该目录 README 的许可提示）
├─ web/                      独立看板（server.mjs 零依赖服务 + src/ 前端源码，不依赖 DSH）
└─ projects/                 你的剧放这儿（**整体不入库**，只有说明用的 README 例外）
```

**仓库里放的是工具，不是剧。** clone 下来拿到的是能跑的流水线：

- `projects/` 整体不进 git —— 你的剧本、板子、剧照、成片都在本地磁盘上，不会出现在 `git status` 里，
  也不会被推到远端。历史提交里若仍有旧版本，用 `git log --oneline -- projects/<名>` 翻阅。
- 图片 / 视频 / 音频连传记都不入库（`.gitignore` 按扩展名挡住），凭据也是。
- 想给别人看这套契约长什么样，用 [`examples/demo-show/`](examples/README.md) —— 它只有文本文件。
- 测试输入例外：最小、稳定、无生成媒体的 JSON/文本夹具保存在 `tests/fixtures/`。需要真实 ComfyUI、云服务或已安装插件的检查放在 `tests/integration/`，不属于普通单元测试。

## 项目工作区

每部剧放在**仓库内** `projects\` 下的独立目录。**项目根是硬规则**：一律建在这儿，新建立项前先列一次
`projects\`，已有同名副目录就续用，没有才新建。不要在仓库外、其他磁盘或临时目录自建项目目录。

### 目录按阶段命名，不按"这次怎么跑"命名

这一条是被数据打出来的教训：18 部历史剧里出现过 **19 种** `keyframes_*` 目录名
（`keyframes_local_v2` / `_8step` / `_20step` / `_retry` / `_bailian_v4` / `_testfix2` / `_volcengine` …），
因为每换一次通道、每重试一次就新开一层。结果是没人知道哪一层是准的，看板也得靠猜目录名去凑数据。

**阶段是一回事，跑法是另一回事** —— 通道、步数、分辨率属于这一次的执行参数，写进 manifest，
不写进目录名。要留不同跑法的快照，用 `--out_dir` 指到别处，不要在剧目里并列兄弟目录。

```text
projects/<剧名>\
├─ story.md                  原剧本
├─ story.provenance.json     剧本来源票（谁写的、基于什么素材）
├─ board.json                故事板（含 meta.created_at = 立项时刻）
├─ board.direction.json      导演方案
├─ board.direction.json.provenance.json
├─ render.plan.json          生成计划（可执行的单元划分）
├─ review.approvals.json     人工票，**只由 review-gate 在人说「通过」后写**
├─ keyframe-prompts\         关键帧提示词，逐字送模型
├─ assets\                   角色 / 场景图与其请求档案
├─ units\                    每段视频与它的 result
├─ reviews\                  人工审阅记录（← 经验沉淀也落这儿）
└─ out\                      成片
```

最小可跑的样子直接看 [`examples/demo-show/`](examples/README.md) —— 同样结构，只有文本没有媒体。
想让看板直接读示例，把 `AIH_PROJECTS_ROOT` 指过去：`AIH_PROJECTS_ROOT=examples npm run kanban`。

## 从零跑起来

1. **装 Node ≥ 22** 与 **Git**，clone 本仓库。
2. `npm install` —— 装百炼 CLI 等仓内依赖（生图入口 `gen.py` 已随仓库放在 `vendor/comfy-studio/`，不用另装）。
3. 机器侧前置（体量大、不入仓）：
   - **ComfyUI 引擎**（含 H3 视频模型与 Qwen 生图模型），装好后设 `AIH_PYTHON` 指向其 `python.exe`；
   - **ffmpeg**：`winget install Gyan.FFmpeg`（或设 `AIH_FFMPEG` 指向 ffmpeg.exe）；
   - **Docker**（可选）：只有 `cli/desub.mjs` 去字幕用得上，不跑它可以不装。
4. 参照 [`.env.example`](.env.example) 配置本机 `.env`（模型、通道与规格；`.env` 不入库）。
5. 自检：`npm run doctor` —— 逐项报有/缺，必需项全绿即可跑。

看板（链路画布：阶段与单元连成节点图、关键帧缩略图直接上节点、闸门票挂在节点上、点节点看实际产物；独立服务，不需要 DSH）：

```powershell
npm run web:setup       # 首次：安装前端依赖并构建（React + Vite + React Flow，装在 web/ 子包）
npm run kanban          # http://127.0.0.1:8787
```

- 不跑 `web:setup` 服务也能起，但页面只会给构建引导；`npm run doctor` 会把这一项标成可选缺失。
- 开发前端：`npm run web:dev`（5173 端口，/api 与 /media 自动反代到 8787，改前端不用重启服务）。
- 深链：`http://127.0.0.1:8787/?p=<剧目名>&node=unit:g003` 直接落到某剧目的某个节点。
- 可选参数：`node web/server.mjs --root <剧目根> --port <端口>`（环境变量 `AIH_PROJECTS_ROOT` / `AIH_KANBAN_PORT` / `AIH_WEB_DIST` 同名覆盖）。

**读写边界**：人工票仍然只读 —— `review.approvals.json` 只由 `cli/review-gate.mjs`
在用户明确说「通过」之后落笔，看板不代签。看板另有**管理动作**（2026-09-22 起）：

- **归档**：剧目 → `projects/_archive/`（退出 git 跟踪），随时可恢复；归档满 7 天由看板服务自动清进**系统回收站**（服务启动时 + 每 6 小时扫一次，流水账在 `projects/_archive/_purged.log`）。
- **删除**：必须**逐字手打剧目中文标题**才执行；整目录移入 Windows 系统回收站（可还原），绝不直接销毁。删除成功不看退出码，看状态验证（目录消失 + 回收站条目增加——`DeleteDirectory` 走回收站时会抛一个假异常，实测过）。
- 写接口带两道跨源防护：自定义头 `X-Kanban-Action` + `Origin` 同源校验 —— 本地服务也不能让浏览器里随便一个页面删你的项目。
- 中文标题可能重名（`no_chute` 与 `no_chute_v2` 都叫《没说完的那句》），确认弹窗会同时回显目录名；定位靠「点的是哪一个」，确认串只是「你知道自己在删什么」的凭证。

## 基本用法

先参照根目录的 [`.env.example`](.env.example) 配置本机 `.env`。**剧本和导演稿默认由当前对话的 Agent 直写**，不调外部大模型 —— `AIH_SCRIPT_MODEL` / `AIH_DIRECTOR_MODEL` 只在**显式要调模型**时才用得到（不限制厂商或型号）。资源和关键帧分别读取资产/关键帧通道与模型配置。视频默认 `AIH_VIDEO_QUALITY=normal`、`AIH_VIDEO_PROFILE=fast`、`AIH_VIDEO_ATTENTION=vsa`，两档尺寸由 `AIH_VIDEO_NORMAL_SIZE` 和 `AIH_VIDEO_HIGH_SIZE` 指定。`.env` 不入库，已有进程环境变量优先。

剧本必须由正式入口登记并留下来源票；已有完整用户原稿只能在用户明确确认后登记，不能代签：

```powershell
node cli/script.mjs register-agent --input <草稿.md> --out <项目/story.md>                             # 默认：当前对话的 Agent 直写
node cli/script.mjs register-user --input <用户原稿> --out <项目/story.md> --confirmed-by <确认者>       # 用户原稿
node cli/script.mjs generate --input <素材.txt> --out <项目/story.md>                                  # 可选：调外部模型（不默认走）
```

**默认 `register-agent`**：剧本要的就是理解和判断，当前对话模型就能写，改一个字重新登记即可，不必绕付费模型。「剧本必须用外部大模型写」这条旧约束已作废。人工确认仍走 `review-gate --stage story`，登记不等于确认。

先给用户展示完整剧本，取得明确确认后记录 `story` 人工票；按已确认的剧名、风格、画幅、故事概述和人物资料填写 [Brief 最小模板](references/board-brief.example.json)，再由代码建立 `board.json`。初始化只搬运原文台词并建立索引镜头，**导演方案默认由当前对话的 Agent 按 `references/director/` 的契约直写**，不是"必须交给外部模型设计"。

```powershell
node cli/review-gate.mjs approve --project <项目目录> --stage story
node cli/init-board.mjs --story <项目/story.md> --brief <项目/board-brief.json> --out <项目/board.json>
```

立项这一步会往 `board.json` 的 `meta.created_at` **写死项目创建时间**（ISO 8601）。之后任何阶段都不许改它 —— 看板按它把剧目倒序排列。老剧目没有这个字段时，看板退回 `board.json` 的 mtime 推断（剧目目录迁进仓库时目录时间会被文件系统抹平，只有文件 mtime 活着）。

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

旁支入口（不在主流程里，按需单独调用）：`cli/look-local.mjs` 用本地 ollama 视觉模型看图（0 成本）。

`cli/huimeng.mjs` **不是旁支入口** —— 它是 `--provider huimeng` 的执行后端，由 `cli/keyframes.mjs` 调用；绘梦只接公开 URL，参考图会自动经 Cloudinary 转链接。它也可以单独调来出单张图。

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
- FFmpeg / FFprobe（少数测试会用它现造素材；GitHub Actions 的 runner 自带）
- 本地 ComfyUI 与 `comfy-studio`
- 百炼 CLI（使用百炼图片模型时）

> ⚠ `vendor/comfy-studio/` 下三个 Python 文件是**第三方快照**，没有任何许可头，
> **不在本仓库 MIT 许可范围内**。详情见 [vendor/comfy-studio/README.md](vendor/comfy-studio/README.md)；
> 想换成自己机器上的那份，设 `AIH_GEN` 环境变量即可。

模型凭据、项目媒体和运行缓存不得提交到仓库。

运行配置集中在仓库根目录 `.env`（按 `.env.example` 填写，已被 Git 忽略）。包含生图通道及模型、H3 档位/尺寸和本机工具路径；生图通道可选 `comfyui`、`bailian`、`volcengine`（火山方舟 Seedream）。使用火山通道时填写 `AIH_VOLCENGINE_API_KEY`，模型由 `AIH_VOLCENGINE_IMAGE_MODEL` 配置。命令行显式参数仍可覆盖非剧本/导演模型的运行档位。`AIH_SCRIPT_MODEL` / `AIH_DIRECTOR_MODEL` 接受任意非空模型名、不再设白名单，但**默认用不到** —— 剧本和导演稿默认由当前对话的 Agent 直写，只有显式调 `generate` / `cli/direct.mjs` 时才读这两项。剧本和导演稿可生成哈希绑定的来源票作为留痕，但票据不是放行前提。

## License

MIT
