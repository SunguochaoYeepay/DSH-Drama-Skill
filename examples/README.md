# examples/ — 对外示例剧目

`demo-show/` 是一整条**契约链**的样板：从剧本到板子到导演稿、再到生成计划与关键帧提示词，
每一步留什么文件、票据长什么样，照着它看一遍就明白。**它只有文本文件，不含任何图片、
音频或视频** —— 仓库里不该出现二进制产物。

这条链上的每个文件都不是手写凑出来的，是工程自己的 CLI 生成的，所以契约天然合法；
`tests/example-demo.test.mjs` 把这层合法性钉住了（每次 `npm test` 都会查）。

## 目录

```text
examples/demo-show/
├─ story.md                              原剧本（台词由代码原样搬进故事板）
├─ story.provenance.json                 剧本来源票：谁写的、输入/输出哈希
├─ board-brief.json                      立项简报（人填，不许由程序代写）
├─ board.json                            故事板（确定性编译产物，含 meta.created_at）
├─ board.direction.json                  导演稿（登记后的正本）
├─ board.direction.json.provenance.json  导演稿来源票
├─ render.plan.json                      生成计划：2 个单元、时长与关键帧落点
├─ keyframe-prompts/                     关键帧提示词，g001 / g002 各一份
│                                        （LLM 直写制：cli/keyframes.mjs 逐字送模型）
└─ review.approvals.json                 人工票（story 与 direction 两道闸）
```

## 人工票是真的

这两张票不是伪造的示例数据，是用户看过产物后由 `cli/review-gate.mjs` 落笔的：

```powershell
node cli/review-gate.mjs approve --project examples/demo-show --stage story
node cli/review-gate.mjs approve --project examples/demo-show --stage direction
```

按本工程的规矩，**人工票只能这样产生** —— 谁都不能代签，示例也不例外。

## 重跑一遍

```powershell
node cli/script.mjs register-agent --input <draft.md> --out examples/demo-show/story.md
node cli/init-board.mjs --story examples/demo-show/story.md --brief examples/demo-show/board-brief.json --out examples/demo-show/board.json
node cli/register-direction.mjs examples/demo-show/board.json --input <director-draft.json> --authored-by agent
node cli/compile-units.mjs examples/demo-show/board.direction.json --out examples/demo-show/render.plan.json
```

关键帧提示词不由命令生成 —— 按 LLM 直写制，它只有唯一来源 `keyframe-prompts/<单元>.txt`，
写完后由 `auditPrompt()` 过一遍机器闸（只报告不阻断）。这两份 **0 违规、442/437 字**
（上限 500）。

## 怎么看它

```powershell
$env:AIH_PROJECTS_ROOT = 'examples'; npm run kanban
```

看板会把 `examples/` 当成剧目根，左侧列出 `demo-show`，画布上就是这条链。
深链：`http://127.0.0.1:8787/?p=demo-show`。

想继续往下（生成资产、关键帧、视频）需要本机 ComfyUI 或线上通道，
产物会落进 `examples/demo-show/` —— **那些是媒体文件，不入库**，跑完记得看一眼
`git status`，别把它们提交上来。
