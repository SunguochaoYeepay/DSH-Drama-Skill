# tests/fixtures — 测试输入

这里的文件是**测试输入**，随代码保存。它们不是运行项目的媒体产物。

## 为什么放在仓库里

两类东西的生命周期不一样：

| | 存放位置 | 会怎么变 |
|---|---|---|
| 运行产物（图/视频/音频/板子） | 仓库外的剧目目录，见 README「项目工作区」 | 随工作区迁移、改名、归档而失效 |
| 测试输入 | **本目录** | 跟着代码走，改动要走 review |

来历：`literal` / `assets` / `orchestrate` / `review` 四个测试原先默认读
`E:/AI-Tool/DeepSeek/story2video/examples/…`，工作区改成 `projects/<剧目>/` 之后集体 ENOENT。

要强调的一点：**把默认路径换成"另一个现存的绝对路径"不算修好** ——
那只是把测试重新绑定到另一套会继续变化的外部目录。
测试输入必须进仓库，这样换机器、换工作区都不失效。

## 内容

| 文件 | 是什么 | 喂给谁 |
|---|---|---|
| `dashixiong-source.json` | 带剧本原文的板子：`story.source` 里有行号、台词、`△` 动作行 | `tests/literal.test.mjs`、`tests/director.test.mjs` |
| `dashixiong-board.json` | 逐行编译后的板子：2 角色 / 2 造型 / 1 场景 / 14 镜 / 12 句台词（含 2 句 OS） | `tests/assets.test.mjs`、`tests/contract.test.mjs`、`tests/orchestrate.test.mjs` |
| `index.mjs` | 夹具入口。**路径规则只有这一个所有者**，测试不要自己拼路径 | 由上述测试 import |

> `legacy-v4-render-plan.json`（v4 迁移样本）已于 2026-09-19 删除：它的唯一引用方
> `tests/plan-provenance.test.mjs` 随「去掉机器审核」一起删了，之后再无任何测试读它。
> 需要时从 git 历史取回。

原件来自 `E:\AI-Tool\DeepSeek\story2video\_archive\examples\`（`dashixiong.v2.json` 与
`dashixiong.literal.json`），**内容未改**，以便需要时能跟原件对上。

### 夹具里那些指向旧布局的惰性路径

两个 JSON 里还留着 `story2video/shots/t2i_*.png`、`story2video/shots/audio/*.mp3`、
`clip`、`first_frame` 这类值 —— 它们是**旧平铺目录时代的相对路径**，现在都不存在。

**测试不读这些文件**（路径解析类断言一律用下面说的合成路径），所以不影响结果。
保留原样是为了让夹具能跟归档原件逐字对上；**不要拿它们当"当前工作区长什么样"的参考**。

如果以后要清掉，请连着改 `fixtures/README.md` 并确认 `literal` / `assets` / `orchestrate`
三个测试仍然全绿。

## 两条约定

**1. 断言是内容写死的，所以夹具不能随便换。**

`literal.test.mjs` 断言的是"这台戏的剧本结构"：10 句开口台词 + 2 句 OS、12 行动作、
2 条人物设定。把夹具换成另一部剧，文件虽然存在，**测试照样会红** —— 这是设计如此，不是 bug。

要换夹具，就得同步改断言。

**2. 资产槽位是空的，需要路径的断言要自己灌。**

夹具处于"配方层"：`characters[].portrait`、`identities[].sheet`、`scenes[].master`、
`props[].ref_image` 全是 `null`（真实流程在资产生成后回填）。

凡是断言"参考图从哪来"的用例，必须显式灌入确定性的合成路径，
否则参考图解析会返回空集，断言就退化成空转。

`tests/assets.test.mjs` 里有一段 `refBoard` 专门做这件事，并去掉了
`refs.length === 0 || …` 这类逃生口 —— 那种写法会让整条规则**从来没被验过**。

## 命令行覆盖

默认走本目录的夹具；显式传板子可以覆盖（用来拿真实剧目调试同一个测试）：

```powershell
node tests/assets.test.mjs <board.json>
node tests/contract.test.mjs <board.json>
node tests/director.test.mjs <board.json> [story.md]
node tests/orchestrate.test.mjs <board.json>
node tests/literal.test.mjs <带剧本原文的板子.json>
```

`tests/h3-prompt.test.mjs` 使用代码内最小输入，直接覆盖正式 H3 提示词编译器，不读取板子夹具。

`tests/assemble-review.test.mjs` 不需要夹具 —— 它的输入都在临时目录里用 FFmpeg 现造。
