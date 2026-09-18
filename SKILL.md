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
项目立项（风格 + 画幅 + 已有参考资产）
  -> 故事/剧本
  -> 导演方案
  -> 资源
  -> 关键帧
  -> 逐段视频
  -> 去除错误硬字幕
  -> 合成
  -> 最终审阅
  -> 知识回流（最终确认之后必须做，不执行不算收工）
```

每个箭头都是闸门，不能因为文件已经生成或机器 QA 通过而跳过。**最后一个箭头同样是闸门：`final` 票记录之后，必须先完成知识回流，这一轮才算结束。**

## 立项必问

用户只给短句、故事点子或未带制作规格的剧本时，**不得直接扩写或生成**。先确认：

1. **视觉风格**：例如写实电影、精致 3D 卡通、二维赛璐璐、水墨等。
2. **画面比例**：例如 `9:16` 竖屏、`16:9` 横屏或 `1:1`。

如果用户已经提供核心人物图片，还必须确认：

- 图片对应哪个角色。
- 它是**身份硬参考**，还是只用于风格/灵感参考。
- 需要锁定哪些内容：脸或头部、体型、服装、发型配饰、整体美术风格。

如果用户已明确提供，就直接采用，不重复询问。目标平台、期望总时长、对白语言等只有在会影响当前决策且无法从上下文判断时再补问。

风格、画幅和参考资产职责必须写入项目契约，并在剧本、资源、关键帧和视频阶段保持一致；不能沿用上一个项目的设置，也不能由 Agent 静默猜默认值。用户原图作为只读输入保存，不覆盖、不重绘后冒充原图。

## 双钥匙闸门

剧本写作只能通过 `node cli/script.mjs generate --input <素材> --out <项目/story.md>` 调用百炼 `qwen3.8-max`。不得由执行任务的 Agent 自写，也不得用本地 Qwen 代写。CLI 留存输入、剧本哈希和模型响应来源；缺票或剧本被改动时，导演与计划编译拒绝继续。用户明确提供的完整原稿可用 `register-user` 登记，不能冒充模型产物；`--confirmed-by` 是人工声明，不是身份认证，Agent 不得代签。旧项目来源无法核实时停止并请用户确认，不能倒填模型票。

导演同样只能走百炼 `qwen3.8-max`；导演稿旁必须有绑定板子、剧本、导演稿哈希及响应模型的 `.provenance.json`，计划编译和后续执行验票。旧导演稿缺票不能倒填，须重新生成并重新送审。剧本/导演模型、生图通道和模型、H3 档位/尺寸及运行路径统一在仓库根 `.env` 配置（模板 `.env.example`）；不要在项目文件中存密钥或改动全局默认值来切换剧目。

正式流程始终需要两把钥匙：

1. 机器 QA 通过：产物才有资格交给人看。
2. 人工明确确认：才允许进入下一阶段。

用户没有明确表达通过，就视为未通过。Agent 不得代替用户写人工确认票。

固定人工节点：

1. 立项时确认风格、画幅和已有参考资产的职责。
2. 剧本生成后，展示完整剧本和结构检查结果。
3. 资源生成后，展示角色肖像、身份图、场景和道具总览。
4. 关键帧生成后，展示编号总览和每张原图。
5. 每段视频出片后展示完整视频和多帧总览，确认后才生成下一段；不满意就按意见重抽并重新送审。
6. 合成后展示成片和接缝检查结果，等待最终确认。

确认记录位于项目目录的 `review.approvals.json`，票据绑定产物哈希。重新生成、覆盖或修改产物后，旧票自动失效。

`--skip-gate` 只允许无成本调试，并必须打印警告。正式生图、生视频和合成不得使用。

完整闸门协议与恢复规则见 [references/workflow.md](references/workflow.md)。开始或恢复项目时必须读取它。

## 阶段路由

| 当前任务 | 必读资料 |
|---|---|
| **新建项目或开始新一轮生成之前（开工前）** | `references/preflight.md` |
| 新建项目、判断当前进度、恢复中断任务 | `references/workflow.md` |
| 生成或修改导演方案、决定视频单元边界 | `references/directing.md` |
| 生成角色/场景/道具资产或关键帧 | `references/assets-and-keyframes.md` |
| 生成 FastH3/H3 视频、选择时长和规格 | `references/video-h3.md` |
| 机器检查、人工送审、合成与终审 | `references/qa-and-review.md` |
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
- 机器报告、缩略图和评分不能替代人观看原图、完整视频和实听音轨。
- 不把带过期时间的远程 URL 写进项目契约；产物必须落到本地稳定路径。
- 真实项目和生成媒体必须在仓库外；确定性测试只使用仓库内 `tests/fixtures/` 的最小夹具，不依赖某个用户项目。

## 契约所有权

同一规则只能有一个所有者，其他文件只引用，不复制：

| 内容 | 唯一所有者 |
|---|---|
| Storyboard 数据结构 | `schema/storyboard.schema.json` |
| 导演输出结构 | `references/director/schema.md` |
| 导演决策规则 | `references/director/brief.md` |
| 流程与人工闸门 | `references/workflow.md` |
| 资产和关键帧规则 | `references/assets-and-keyframes.md` |
| H3 执行参数 | `references/video-h3.md` |
| QA 和送审规则 | `references/qa-and-review.md` |
| 确定性行为 | `src/`、`cli/` 和对应测试 |

修改规则时先改唯一所有者，再改代码和测试。不要在本入口追加某次项目的特例。

## 常用入口

```powershell
# 查看板子与旧四阶段票据
node src/board.mjs validate <board.json>
node src/board.mjs table <board.json>

# 导演与生成计划
node cli/direct.mjs <board.json> --story <story.md> --out <board.direction.json>
node cli/compile-units.mjs <board.direction.json> --out <render.plan.json>

# 关键帧与单段视频
node cli/assets.mjs <board.json> --provider bailian
node cli/keyframes.mjs <board.json> --direction <render.plan.json> --provider bailian
node cli/prepare-handoff.mjs --plan <render.plan.json> --unit g002
node cli/unit.mjs <board.json> --direction <render.plan.json> --unit g001
node cli/assemble-units.mjs <render.plan.json> --out <out/final.mp4>

# 新版人工票据
node cli/review-gate.mjs approve --project <项目目录> --stage direction --artifacts <direction.json>
node cli/review-gate.mjs approve --project <项目目录> --stage assets
node cli/review-gate.mjs approve --project <项目目录> --stage keyframes --artifacts <图片列表，逗号分隔>
node cli/review-gate.mjs approve --project <项目目录> --stage clip --id g001 --artifacts <g001.mp4>
node cli/review-gate.mjs ready-assemble --project <项目目录> --plan <render.plan.json>
```

具体参数属于对应阶段 reference，不在这里维护完整清单。

具体项目的实验结论不进入主 Skill；只有可复现、会改变通用决策的规则，才写入对应 reference。
