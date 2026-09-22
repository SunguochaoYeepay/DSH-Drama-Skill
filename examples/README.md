# examples/ — 对外示例剧目

`demo-show/` 是一整条**契约链**的样板：从剧本到板子到导演稿，每一步留什么文件、票据长什么样，
照着它看一遍就明白。**它只有文本文件，不含任何图片、音频或视频** —— 仓库里不该出现二进制产物。

捎带一句：这个示例里**没有人工票**（`review.approvals.json`）。按本工程的规矩，人工票只能由
`cli/review-gate.mjs` 在**用户真的看过产物并说通过**之后落笔，谁都不能代签 —— 示例也不例外。
所以它会停在「剧本待确认」这道闸上，导演稿只能以**未登记草稿**的形态放在这儿。

## 目录

```text
examples/demo-show/
├─ story.md                           原剧本（台词由代码原样搬进故事板）
├─ story.provenance.json              剧本来源票：谁写的、输入/输出哈希
├─ board-brief.json                   立项简报（人填，不许由程序代写）
├─ board.json                         故事板（确定性编译产物，含 meta.created_at）
└─ board.direction.draft.json         导演稿草稿（尚未登记，等剧本人工票）
```

每份文件不是手写凑出来的，是工程自己的 CLI 生成的：

```powershell
node cli/script.mjs register-agent --input <draft.md> --out examples/demo-show/story.md
node cli/init-board.mjs --story examples/demo-show/story.md --brief examples/demo-show/board-brief.json --out examples/demo-show/board.json
```

所以它们的契约天然合法 —— 而且 `tests/example-demo.test.mjs` 把这层合法性钉住了：板子过不过校验、
来源票的哈希对不对得上、导演稿的单元与台词有没有漏，都是每次 `npm test` 会查的行为。

**沿着它往下跑**（需要真的人工票，这里跑不了全）：

```powershell
node cli/review-gate.mjs approve --project examples/demo-show --stage story
node cli/register-direction.mjs examples/demo-show/board.json --input examples/demo-show/board.direction.draft.json --authored-by agent
node cli/compile-units.mjs examples/demo-show/board.direction.json --out examples/demo-show/render.plan.json
```

## 怎么看它

```powershell
$env:AIH_PROJECTS_ROOT = 'examples'; npm run kanban
```

看板会把 `examples/` 当成剧目根，左侧列出 `demo-show`，画布上就是这条链。
深链：`http://127.0.0.1:8787/?p=demo-show`。
