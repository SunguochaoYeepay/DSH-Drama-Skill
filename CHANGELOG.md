# Change Log

记录工程级行为变化。具体剧目的抽卡结果、耗时和逐帧评价留在对应项目目录，不写入这里。

## 2026-09-22 - 跑通第一部真剧后的清账：四处缺陷 + 契约规则写前自检

《工位上的地震》（`projects/desk_quake`）是第一部从立项走到成片的真剧（8 张人工票全由人签、
全本地通道 0 元、13.323s）。跑的过程挖出四处工程缺陷，经用户逐条批准后落地：

- **`src/literal.mjs` 的音效词表去掉单字匹配**：`/林|树|山/` 会把场景名「**林**薇工位」
  （开放式办公区）判成林地，索引镜头拿到「树叶摩擦的沙沙声…」——而这个字段会进 H3 的
  `overall_soundscape`。改成分级词表（`林间|树林|森林|林地|…`）。测试：
  `tests/literal-ambience.test.mjs` 同时钉住"办公区不误判"与"真林地不丢功能"。
- **`src/board-data.mjs` 的关键帧要做存在性检查**：`render.plan.json` 的 `units[].keyframe`
  是编译期写死的路径，关键帧生成前必然不存在；看板不查就会给不存在的文件渲染 `<img>`
  （裂图 + alt 文本漏到页面上）。视频那一路（`clipOf`）一直是查的，这里对齐。
  测试：`tests/keyframe-slot.test.mjs`。
- **`src/providers/comfyui.mjs`：comfy 根与 ffmpeg 各归其位**。① 从 `AIH_PYTHON`
  （`<ComfyUI 根>/python/python.exe`）推出根并传 `--comfy-root` —— 不传时 gen.py 退化成
  "当前目录"，产物**生成了却拷不回来**，CLI 只报"未产出文件"（本轮排查掉一整轮）；
  ② 删掉本文件里那份写死版本号 `ffmpeg-7.1.1-full_build` 的重复探测，改用
  `runtime-paths.mjs` 的 `FFMPEG`（同一件事只该有一个所有者）。
- **重跑 `cli/prepare-handoff.mjs` 不再冲掉关键帧绑定**：`createHandoffRecord` 一律把
  `keyframe` 置 null，于是"为了更新 `allowed_changes` 再跑一次"会静默解绑，之后 `keyframes`
  票只绑得到前一个单元。新增 `carryOverKeyframeBinding()`：稳定尾帧**字节未变**且旧绑定
  仍然有效时原样带过来，变了则保持 null（那张关键帧确实该重出）。
- **契约的 `rules` 增加写前自检**：`src/cinematography.mjs` 新增 `auditContractRules()`，
  `cli/unit.mjs` 在出片前对规则文本跑否定式正则并告警（只报告、不阻断）。规则里写
  「不出现第二只杯子」等于把「第二只杯子」递进语义空间 —— 本轮 g001 视频里真的多出一只杯子，
  改正向陈述后同提示词重跑即消失。规则正本 `references/cinematography.md` 由"四条规矩"
  扩为"五条规矩"，并标 `🔁 已复发`。测试：`tests/contract-rules-audit.test.mjs`。
- **`references/director/schema.md`**：`end_state` 行补一句"它只是核对基准，不进生成提示词，
  要让单元真的停在该状态必须写进最后一镜的 `shot.action`"（本轮实测：只加时长无效）。
- **`.env.example`** 补 `COMFYUI_ROOT` 说明（不填也能跑，工程从 `AIH_PYTHON` 往上推两级）。

## 2026-09-22 - 示例剧目补齐到关键帧提示词，两张人工票是真的

`examples/demo-show/` 之前停在未登记草稿上（导演稿登记要 `story` 人工票，而票只能由人签）。
现在整条链跑通：`board.direction.json`（含来源票）→ `render.plan.json`（2 单元）→
`keyframe-prompts/g001|g002.txt`。

- **两张人工票由用户看过产物后经 `cli/review-gate.mjs` 落笔**，不是伪造的示例数据。
  票里的 `artifacts` 原本记本机绝对路径，改成仓库相对路径 —— 源码已经不猜别人的机器，
  示例里躺着自己机器的盘符同样是破绽（新增测试钉住）。
- 登记导演稿时冒出 4 条「镜头可能落错场景」warning：导演稿写到「驾驶座」，而场景描述里
  没有这个词。补的是**场景描述**（brief 是输入，重跑 `init-board` 后 shots 一字未变），
  不是删掉导演稿的措辞让检查闭嘴。
- 关键帧提示词按 LLM 直写制手写，`auditPrompt()` 零违规、442/437 字（上限 500）。
- 测试：`tests/example-demo.test.mjs` 从 6 条加到 11 条（导演稿来源票自证、计划单元上限、
  每个计划单元都有提示词且零违规、两道闸都签过、示例不含本机绝对路径）。

## 2026-09-22 - ffmpeg 兜底不再写死版本目录名

`src/runtime-paths.mjs` 的 winget 兜底把 `ffmpeg-7.1.1-full_build` 整个写死 —— winget 一升级
（`ffmpeg-8.x-full_build`）就**静默落空**，退回 PATH 上的 `ffmpeg`（本机不在 PATH），
症状是"昨天还好好的，今天 ffmpeg 找不到"。改成扫 `Gyan.FFmpeg_*` 包下的 `ffmpeg-*` 子目录，
取排序最后一份；半个安装（有版本目录但 `bin\ffmpeg.exe` 不在）不算可用。

- 测试：`tests/runtime-paths.test.mjs` 新增两条行为断言（换版本目录名仍命中；没有 exe 时退回 PATH）。
- 本机复核：`cli/doctor.mjs` 仍指向真实的 `ffmpeg-7.1.1-full_build\bin\ffmpeg.exe`。

## 2026-09-22 - 项目位置口径统一：只留「仓库内 projects/」一种说法

上一轮（「清掉源码里的本机路径」）的 CHANGELOG 声称 `SKILL.md` 的项目位置已改为「仓库根是唯一工作根」，
但只改到第 39 / 41 行的位置说明，**第 139 行的全局约束还写着「真实项目和生成媒体必须在仓库外」** ——
同一份文件里两条规则互相打脸，而执行 Agent 读的正是它。

- `SKILL.md` 全局约束改为：「剧目的产物只在本机 `projects\` 下（该目录整体不入 git）；确定性测试只使用
  仓库内 `tests/fixtures/` 的最小夹具，不依赖某个用户项目。」—— 保留原句"测试自带输入"的本意。
- 同类表述扫干净（**只改注释与说明，不动行为**）：`plugins/dsh-storyboard/lib/client.js` 5 处、
  `tests/integration/dsh-plugins.test.mjs` 2 处、`tests/fixtures/README.md` 表格 1 处。
  插件机制（用户用 directoryPicker 选剧目根、走绝对路径）本来就跟项目在不在库内无关，错的是
  「按 README 规定在仓库外」这句 —— clone 者手上没有别的盘。
- 全量 `npm test` 52/52 通过。

## 2026-09-22 - 看板分隔条拖动修复；工程更名「逐格」

- **修 bug**：`web/src/Splitter.jsx` 的 props 解构少写 `onStart`，而第 43 行写着 `onStart?.(side)`
  —— 裸标识符不是"防 undefined"，是全局引用。真浏览器实测（无头 Chrome + CDP）：每次按下分隔条
  抛 `Uncaught ReferenceError: onStart is not defined`；父组件的 `onStartResize` 永不执行，
  `dragBase.current` 停在挂载时的宽度 → 第二次拖动被拉回初始值再算。
  实测位移 160 → 260 → **210**（本应 310）；修复后 236 → 336 → 386，未捕获异常 0 条。
- 前端没有 lint / 类型检查，构建也不拦未声明标识符 —— 这类错只能靠"真点一次"发现。
- **更名**：工程代号「逐格」（一格一格地拍，逐段生成、逐段确认）。落在 `README.md` 标题、
  `SKILL.md` 标题、看板页面标题（`web/index.html`、`App.jsx` 顶栏默认标题）。skill 名 / npm 包名 /
  目录名未动 —— 那是 id 级改动，会牵连 DSH 工作区路径，另案处理。

## 2026-09-22 - 清掉源码里的本机路径：工程不再猜你的机器在哪

起因：上一轮把仓库收拾干净后复查代码，发现 `.env.example`、`src/runtime-paths.mjs`、
`plugins/dsh-storyboard/lib/client.js` 等七处仍写死了本机用户名与盘符路径
（`C:\Users\…`、`E:\AI-Image\…`、`E:\AI-Tool\…`）。这些会随代码一起公开，而且对 clone 者毫无意义。

**改法**：一律改成「环境变量优先、不猜、缺就是缺」。

| 位置 | 改前 | 改后 |
|---|---|---|
| `src/runtime-paths.mjs` | 三处本机路径兜底 | 只有 env；新增 `requireComfyPython()`，没配就抛**人话**（点名 `AIH_PYTHON`、指出配在哪、建议跑 doctor） |
| `.env.example` | 直接写着本机 python.exe 路径 | 拆出「必填 / 逃生口 / 线上凭据」三段，示例全是 `<你的 …>` 占位 |
| `cli/huimeng.mjs` | 默认读某台机器的 DramaClaw `.env` | 默认不猜，报错时给出两条路 |
| `plugins/…/client.js` | 默认指向某块盘的 projects | 默认空，面板提示用 directoryPicker 选一次 |
| `vendor/comfy-studio/gen.py` | `COMFYUI_ROOT` 默认值是本机路径 | 空串（唯一一处偏离上游，已在 `vendor/comfy-studio/README.md` 备案） |
| `SKILL.md` 项目位置 | 「建在仓库外那套副本的 projects 下」 | 「仓库根是唯一工作根」 |

**没崩，因为本机 `.env` 早就写好了 `AIH_PYTHON`** —— 源码那几个兜底一直是冗余的。
验证过两条路径：本机 `cli/doctor.mjs` 全绿；`AIH_PYTHON=` 时明确报「(空) + 怎么配」，exit 1。

> 顺带修了一条会随机红的测试：`tests/kanban-actions.test.mjs` 的夹具不给 `board.json` 写
> `created_at`，排序只好退回文件 mtime —— 那等于让断言去赌文件系统时间戳粒度，负载一变顺序就翻。
> 夹具改成显式写同一时刻的 `created_at`，顺序由「同刻按名升序」这条真规则决定。

## 2026-09-22 - 仓库瘦身与门面整理：工具进 GitHub，剧留在本地

起因：要把仓库公开出去。之前它是「能跑但谁也看不懂」的状态 —— 根目录躺着 2.1GB 剧目产物、41MB 的
`comfy-out/` 与一堆备份，`.gitignore` 用九条裸目录名做全仓通配，README 里还写着已被推翻的
「剧目契约链随仓库入库」。这些别人 clone 下来第一眼就会看到。

**删除（全部进系统回收站，可还原）**：18 个历史剧目（2146MB）、`projects/_archive/`（99MB）、
`comfy-out/`（41MB）、`.tmp/` 三处备份。回收站条目 4155 → 6328。剧目早在本次改动前已整体退库，
所以 git 历史不受影响，要翻某个剧目的旧版本用 `git log --oneline -- projects/<名>`。

> 删除时的坑：PowerShell 的 `DeleteDirectory(..., SendToRecycleBin)` 第一次调用会把**文件**挪进回收站
> 却没能摘掉已经空掉的目录壳，抛一个「系统不支持该功能」。再调一次就成功 —— 成功判据永远只看
> **目录还在不在**（不管是目录还是文件都要先判 `statSync().isDirectory()`，递归 du 时对文件会抛 ENOTDIR）。

**`.gitignore` 重做**。原来第 16–24 行是九条裸目录名（`assets/ out/ clips/ audio/ pool/ keyframes/ shots/`…），
gitignore 的语义是「任意层级同名目录」—— 实测把 `web/src/out/x.js`、`tests/fixtures/assets/x.json`、
`cli/keyframes/x.mjs` 全部静默吞掉，不报错不提示。现在一律改成 `/` 前缀锚到仓库根。
另一处：`.gitignore` **不支持行尾注释**，`#` 必须独占一行；重写时三行规则因为带尾注而静默失效，
靠 `git check-ignore -v` 才抓出来。20 条用例（该挡 / 该入库）全部核对通过。

**新增**

- `examples/demo-show/` —— 对外示例剧目，一整条契约链但**只有文本文件**（无图无音视频）。
  剧本与板子由工程自己的 `cli/script.mjs` / `cli/init-board.mjs` 生成，不是手写凑的。
  ⚠ 它停在 `board.direction.draft.json`（未登记草稿）：导演稿要登记得先有 `story` 人工票，
  而**人工票只能由人特许**（`cli/review-gate.mjs`），示例也不例外 —— 宁可不完整也不伪造签名。
- `tests/example-demo.test.mjs` —— 钉住示例不腐烂：板子零 error 零 warning、来源票哈希与 story.md 一致、
  导演稿的台词行号与剧本逐句对应且不多不少、单元 ≤15 秒、示例目录里不许混进媒体文件。
- `CONTRIBUTING.md` —— 改动规程：沉淀层 / 禁区两层边界、`references/` 规则的四要素提案、
  人工票谁都不许代签、测试判据（禁止源码文本断言）、gitignore 前缀纪律。
- `.github/workflows/ci.yml` —— Node 20 / 22 矩阵跑 `npm test`。
- `vendor/comfy-studio/README.md` —— 出处、为何快照入库、手工同步策略，以及**许可状态未知**的提示。

**删除**：`src/keyframe-overrides.mjs`（LLM 直写提示词制落地后全仓零引用、无连带，已备份到系统临时目录）。
`src/board.mjs` 的 `ideaToStory` / `fromStory` 虽同样零调用（CLI 入口已被 `die()` 挡死），
但删它会连带出 `carryMeta` / `withNoThink` / `ollamaChat` 三个孤儿，属代码手术，留待单独处置。

**README 修订**：去掉「剧目契约链入库」这段自相矛盾的表述（昨天的退库已推翻它）；补充仓库分层说明、
按阶段而非按通道命名剧目目录的理由（19 种 `keyframes_*` 的历史教训）、CI / Node / MIT 徽章。

## 2026-09-22 - 项目创建时间显式化：meta.created_at 成为排序的正主

起因：剧目清单按时间倒序时，只能用 `board.json` 的 mtime 推断 —— 那只是「板子最后写入」，改板会让剧目前移，且剧目目录迁进仓库时目录时间已被文件系统抹平（22 个目录同一时刻）。推断终究不是事实。

- `schema/storyboard.schema.json` 的 `meta` 新增可选字段 `created_at`（ISO 8601，带 pattern）。schema 是 `additionalProperties:false`，不加就写不进去
- `cli/init-board.mjs` 立项时写入 `created_at = 此刻`，**只写一次**；它是唯一写 board.json 的入口，不会被后续阶段冲掉
- `src/board-data.mjs` 的创建时间改成三级取值：显式字段 → board.json mtime → 目录 mtime。显式字段写歪（非法时间）也往下退，绝不静默当成 0
- 存量 20 个剧目已回填（取值 = board.json mtime，写回后把 mtime 复原，免得回填污染推断信号）。回填后 `checkBoard` 逐个复核，契约零破损
- 看板排序与显示不变，但依据从「推断」变成「事实」
- 测试：init-board 端到端断言 created_at 是刚立项的时刻；数据层钉住「显式字段优先于 mtime」与「写歪时退回 mtime」两条

## 2026-09-22 - 看板新增管理动作：归档 / 恢复 / 删除（回收站）与到期自动清理

用户拍板：项目可归档可删除；删除必须回填中文项目名；归档满一周自动删；归档可恢复。

- **数据层 `src/archive.mjs`**：归档（`projects/<name>` → `projects/_archive/<name>`，
  落 `.archived.json` 记时间与标题；标记缺失退回目录 mtime —— 手工挪进去的目录
  也管得到）、恢复（主线已有同名**绝不覆盖**）、到期判定（正好 7 天即到期）。
  `listProjects` 排除 `_archive`；剧目名校验收成 `board-data.isValidProjectName`
  单一所有者。归档区整体退出 git 跟踪（`.gitignore` 在白名单后压住）。
- **删除只进系统回收站，绝不直接销毁**。⚠ 实测：`FileSystem.DeleteDirectory(...,
  SendToRecycleBin)` 把目录移进回收站后会抛 `FileNotFoundException`（内部再访问
  一次已不在的路径），**退出码不可信** —— 成功判据只有状态验证：原目录消失 +
  回收站同名条目数增加；只消失不进回收站按失败处理并叫人查。
- **删除确认**：服务端强制 `confirm` 与剧目中文标题逐字相等（仅忽略首尾空白），
  不匹配回 400 并回显期望标题。中文标题会重名（no_chute/no_chute_v2 同名），
  界面同时回显目录名；定位靠「点的是哪一个」。
- **跨源防护**：写接口必须带 `X-Kanban-Action` 头 + `Origin` 同源校验，OPTIONS
  显式 405 且不回任何 CORS 头 —— 本地服务也不能让浏览器里随便一个页面删项目。
- **自动清理**：服务启动 + 每 6 小时扫一次归档区，到期剧目进回收站；流水账
  `_archive/_purged.log`（`*.log` 已被 gitignore 挡住）。`doctor` 增归档区检查。
- **前端**：剧目行悬停出归档/删除按钮；删除弹窗回显中文名+目录名、逐字手打
  中文标题才解锁；归档区可展开看剩余天数、一键恢复。无头 Chrome + CDP 真点击
  验证 20/20 断言通过（含"填错名不解锁、填对名解锁、取消不删、归档往返"）；
  端到端真删验证：回收站同名条目 0 → 1。
- **测试 49 个文件全绿**（新增 `archive` 17 条 + `kanban-actions` 15 条；回收站
  与 GC 全部走注入的假实现，测试绝不污染用户回收站）。

## 2026-09-22 - 看板改版：链路画布（React + React Flow）

起因：用户嫌原生 HTML 版丑，问能不能参考 DramaClaw 的无限画布做展示。
**边界先钉死**：DramaClaw 前端是 Elastic-2.0（© ClaymoreLab，非开源），其代码不可
抄入本仓；可抄的是"选型"——它的画布引擎就是 MIT 的 `@xyflow/react`（React Flow）。

- **架构**：`web/` 成为独立前端子包（Vite 8 + React 19 + Tailwind 4 + React Flow 12 +
  lucide-react，全部 MIT），根仓库依赖不变；`web/dist` 构建产物不入库，
  `npm run web:setup`（安装 + 构建）本地生成，`npm run kanban` 照旧起服务。
  缺构建时服务给引导页（不再是白页），`doctor` 把"前端已构建"列为可选项。
- **画布**：`web/src/graph.js` 纯函数把快照转成节点/边（13 条测试钉住）。
  图层 = 剧本→板子→导演稿→生成计划→扇出单元（带关键帧缩略图）→汇聚成片；
  闸门票作徽标挂节点；**卡点 = 已推进到的最远处之后第一个"产物在、票没签"的阶段**
  （"最早未签"会把缺早期票的老剧目误报成卡在剧本票，实测 cat_mouse 形态）。
- **数据层**：`loadProject` 增 `gates`（各阶段票状态 + clips 按单元计）与
  `directionUnits`（shot 的 lines 行号**就地解成台词正文**，解行号唯一所有者）。
- **深链**：`/?p=<剧目>&node=unit:g003` 直接落到某剧目某节点。
- 旧的原生 HTML 页面删除；其五页功能（剧本/导演与计划/资源/关键帧与视频/成片）
  全部并入画布节点的详情抽屉，角色名高亮、大图查看器保留。
- 真浏览器验证：无头 Chrome 实测 gopher_toll 渲染（节点/边/详情抽屉/零 JS 错误）。

## 2026-09-22 - 工程化收编：工具进仓 + 剧目进仓 + 独立看板 + 依赖自检

起因：用户指出工程"分裂"——运行时和工具链在 C 盘、代码在 D 盘、剧目产物在 E 盘，
别人拿仓库跑不起来；看个剧目还得先起 DSH。三项拍板（收编工具 / 看板独立 /
二期数据库），本日落地前两项。

- **工具收编**：`vendor/comfy-studio/` 收 `gen.py / graphs.py / routes.py` 快照
  （⚠ 上游改了不会自动跟，要跟就三个一起重拷并回归）；`bailian-cli@1.26.0` 钉版本
  进 `package.json`（与全局装的旧版本一致，防行为漂移）。`src/runtime-paths.mjs` 的
  `COMFY_GEN` 默认指向仓内 vendor、`BAILIAN_ENTRY` 默认指向 `node_modules`（全局装为回退），
  环境变量覆盖照旧。
- **剧目进仓**：22 个剧目从 `E:\AI-Tool\...\projects\` 复制进仓库 `projects/`
  （源目录原样保留作快照，不再往那里写）。`.gitignore` 改为分层：`projects/**/*`
  全忽略 + 放行目录与 `.json/.md/.txt`（690 个契约文件入库），媒体/二进制照旧挡住
  （含 fat_cat 里误放的 85MB ffmpeg.exe）；`costs.json/current.json/.gen-result.json`
  等运行态在放行后重新压回忽略。**项目根硬规则随之改：一律建在本仓库 `projects\` 下。**
- **独立看板 `web/`**：`npm run kanban` 起 `http://127.0.0.1:8787`，零第三方依赖
  （node:http + 原生 JS 页面），不需要 DSH。数据层 `src/board-data.mjs` 与
  `tests/kanban.test.mjs` 共用同一份读取契约。**只读红线**：人工票仍由
  `cli/review-gate.mjs` 在用户明确说「通过」后落笔，看板不代签。
  两个实测坑已修：① 导演单元（u1…）与计划单元（g001…）**不是一套编号**，
  可执行视图必须以 `render.plan.json` 为权威；② 老项目 `result.json` 里的
  `local_path` 是当时所在盘的绝对路径，项目搬迁后落项目外 —— 退回
  「末级目录名/文件名」在项目内找同名拷贝。
- **新增 `cli/doctor.mjs`（`npm run doctor`）**：依赖自检逐项报有/缺（gen.py /
  ComfyUI Python / ffmpeg / 百炼 CLI 必需；Docker 可选；`--json` 供测试断言）。
  这是"干净机器能跑起来"的验收仪器。
- `README.md`：新增「从零跑起来」章节；「项目工作区」从"仓库外 E 盘"改为"仓库内
  `projects\`"。
- 测试：新增 `tests/kanban.test.mjs`（5 条，数据层纯函数 + 真起服务的 HTTP 行为 +
  目录穿越防护）、`tests/doctor.test.mjs`（2 条，`loadEnvFile` 不覆盖已注入环境变量，
  用 `AIH_*` 钉住每项依赖的位置）。全量 46→48 个测试文件通过。

## 2026-09-21 - 两个排查工具转正 + 临时脚本落点约定（治"脚手架堆成垃圾场"）

起因：仓库根目录堆了 11 个 `.tmp-*.mjs`（昨天另一条工作线留下），`.tmp/` 里另有 120 项，
其中 `step1…step16` 把整条流水线在外头重抄了一遍、`memory-write` 写了 8 版、`run-tests` 写了 3 个。
**同一件事被写 N 遍 = 工程没给入口**，不是懒。`.gitignore` 的 `.tmp-*` 只挡住 git，没挡住堆积。

- **新增 `cli/dump-payload.mjs`**：摊开某次生图**真正提交给 ComfyUI** 的内容。
  本仓 `--prompt` 不是最终稿（上游 `build_*` 还会追加/替换），排查画面问题必须看提交原文。
  从 result.json 取 `prompt_id` → `/history/<id>`；文本编码节点按 **class_type** 认，
  兼容 Qwen 2.1 的单节点同时给正负向；采样参数按 class_type 不按节点号。
  新增 `--history <文件>`：ComfyUI 已关也能查，测试也走这条路。
- **新增 `cli/audit-audio.mjs`**：按时域切片量音轨（全频/低频<300Hz/高频>2.5kHz + 每 0.25s 一格）。
  **判据是"开场窗口 vs 全段峰值的差值"（默认 12 dB），不是绝对音量** —— 上一部剧开场有 -51 dB 底噪，
  按"数字静音"判是通过的，但它比峰值低 24 dB，"闹钟正在响"这个动机前两秒就是悬空的。
  无音轨 = 退出码 1；内容静音只是发现，不算失败。
- **`src/runtime-paths.mjs`**：`FFMPEG` 从写死的 `'ffmpeg'` 改为扫 winget 目录找真身（+ `FFPROBE`）。
  本机 ffmpeg 不在 PATH，写死只在少数终端里碰巧能用。（`cli/inspect.mjs` 与 `animatic.mjs` 里
  各有一份同样的 IIFE，本次未动 —— 收拢它们要动两个在用 CLI，待用户点名。）
- `references/workflow.md`：新增**一·六、临时脚本：落点、转正、清理**（一次性落 `.tmp/` 用完即删；
  同一件事写过两次以上 = 工程缺入口，提案转正）；收工检查表加两条。
- 清理：根目录 12 个 `.tmp-*` 与 `.tmp/` 里已转正的 5 个脚本共 **17 个**已删（备份在系统临时目录）。
- 测试：新增 `tests/dump-payload.test.mjs`（5 条）、`tests/audit-audio.test.mjs`（3 条）。
- `SKILL.md` 常用入口新增「排查与体检」一节：两个工具的调用方式 + "排查工具不是每阶段必经步骤"。
  工具转正了但入口没登记 = 下次还是想不起来有它。

## 2026-09-21 - 知识回流加硬边界：经验照沉淀，改工程/规则/提示词必须先提案经用户同意

用户拍板："经验要沉淀，但是不能改工程和提示词，即使要改也必须经过我同意。"

- `references/workflow.md`「收工与知识回流」新增**零、硬边界**：禁区三类 —— 工程代码
  （`src/` `cli/` `tests/` `schema/` `skills/` `plugins/`）、规则正本（`references/` 全部 `.md`）、
  提示词（项目侧 `keyframe-prompts/*.txt` 及任何逐字送模型的文件）。未经逐条同意，一个字不许动。
- 新增**一·五、改东西之前，先交提案**：四要素（目标文件小节 / 改前原文 / 改后文字 /
  依据的具体事件 + 是否复发）。未答复 = 不改；被否决 = 不改且同轮不再提交同一条；
  同一规则已在别处存在时，提案是「删掉重复那份」而不是再加一份；涉及人设、剧情、画幅、
  风格、花钱的，除提案外还要单独停下来问。
- 明确两条推论：`keyframe-prompts/*.txt` **永不回溯改写**（要变就重跑该单元，重跑过闸门）；
  改 `references/` 规则 = 间接改下一部剧的提示词，所以规则改动同样要过这道闸。
- 收工检查表加两条：**未经用户同意的改动 = 0**；每条拟改都交过提案、未获答复的不落盘。
- `SKILL.md` 流程图第 25 行标注「只沉淀，不改文件」，第 28 行后新增硬边界警示块。
- 沉淀层不受影响：剧目 `reviews/` 与 `.workbuddy/memory/<日期>.md` 照写，不需要同意。

## 2026-09-21 - 关键帧提示词改制：LLM 直写为唯一正路，工程拼装退役

用户拍板（g001 A/B 出图对照 + 文字层对照后）：LLM 能迭代进化，工程拼装只能覆盖已知场景。

- **提示词来源**：`<项目>/keyframe-prompts/<unit-id>.txt`，LLM 抽卡师按 `references/draw-specialist.md`
  直写，`cli/keyframes.mjs` **逐字**送模型——不再拼装、删减、改写。
- **删除**：`buildLocalPrompt` / `buildPrompt`（huimeng 旧通道拼装）/ `refinePrompt` 调用链 /
  `executionShotSpec` / `FRAMING` 景别映射 / 构图覆盖机制（`keyframe-overrides.json` 读取）。
  `src/draw-specialist.mjs` 的 `refinePrompt`/`compileDrawPlan` 等模块 API 保留（零引用 ≠ 僵尸）。
- **保留**：`auditPrompt` 机器审计跑在直写文件上（只报告不阻断）；闸门、参考图挂载、argv 全不变；
  "干跑=实跑"承诺延续（直写文件就是送模型的东西）。
- **缺直写文件是硬错误**：报错里列出本次挂载的参考图编号表（写提示词的人照着就能写）。
- 已知代价（用户知情）：同板同计划不再保证同提示词——提示词质量责任从代码转移到写稿的 LLM；
  旧剧目的 keyframe-overrides.json 不再生效，重跑关键帧需按新制补写直写文件。
- 测试：`keyframe-prompt.test.mjs` 重写为直写制行为测试（逐字送模型/缺文件报错/审计报告/参考图
  编号同源）；`keyframe-local-args.test.mjs` 夹具补直写文件。全量 41/41 绿。

## 2026-09-21 - 抽卡师改制：LLM 直写为主线，工程编译器退为审计与保底

用户拍板：LLM 能随教训进化、能综合导演信息，硬编码编译器只能锁场景。三份文档重整：
- `draw-specialist.md` 全文重写为 LLM 抽卡师岗位规范：输入合同（导演传递什么）、
  五步工作流（读全→综合转译→组装→双闸自检→留痕送审）、正向工艺、红线（物种感知/
  多主体归属/无人物不派主语从事故日志提炼为原则）、抽卡闭环（判断/停止/记录归 LLM）。
- `prompt-rules.md` 从纯禁令目录扩为三层：机制（保留）/ 八类禁令（保留，条条实测）/
  新增正向工艺节（只写画得出的、转译表、结构模板）与盲区清单（正则拦不住的隐性否定/
  速度词/语义重复，LLM 精神闸负责）、双闸执行（机器闸 auditPrompt 不可关 + 精神闸留痕）。
- 新建 `draw-vocabulary.md`：光照/镜头/材质/姿态四类正向词库（吸收 awesome-gpt-image-2
  语料，CC BY 4.0），含通道警示（负面词不进正向、中文直写、字数预算约束）。
- 机器层不退场：`auditPrompt()` 改跑在 LLM 产出上；实测三件套（参考图职责/身份锚/禁字行）
  为必含骨架行；`cli/keyframes.mjs` 编译器保留为保底与 A/B 基线。代码零变更。

## 2026-09-21 - AIComicBuilder 吸收：禁比喻 / 战斗编舞 / 覆盖自检 / 场景判定（文档层）

来源 `github.com/LingyiChen-AI/AIComicBuilder`（Apache 2.0，Next.js 漫剧生成器，Seedance/即梦
通道）。五项吸收全部文档层落地，代码零变更；其「每镜头必须有台词」「LLM 机器质检」
「默认多拆」三项因哲学冲突判不收（详见当日 memory 日志）。

1. **`prompt-rules.md` 禁止七类 → 八类**：新增第 8 类「比喻与修辞」——喻体（如/仿佛/宛如）
   会被编码器按字面画出来，附动作/外观/气质三类改写法；同节补写实场景反物理铁律
   （脚必须触地、禁"突然出现"）与线上通道附加规则（禁真实人名/品牌/IP，bailian 会 400）。
   `draw-specialist.md` 摘要同步。第 8 类机器判不稳，归人工。
2. **`story-craft/action.md` 新增第四节「一场交锋怎么拆成镜头序列（编舞）」**：
   一招 ≥4–6 镜头（蓄力→格挡→碰撞→反击→受创→全景）、攻守交替、精神空间 ≤30%、
   拆不完就拆单元不压镜头数；原四至七节顺延为五至八节，自检清单加第 6 条。
3. **`directing.md` 加覆盖度核对**：直写自检清单新增第 6 条——剧本每个动作动词/台词/
   具名道具/情绪转折都要有视觉落点，动作动词数 K → 镜头数 ≥ K，逐行回核；
   人工审阅重点同步加一条。漏拍不会被任何下游拦住，只会静默消失。
4. **`assets-and-keyframes.md` 加场景图判定**：「能说出这是一个地方吗」——说不出的
   是特效/道具不占场景槽；构图留角色入画空间但不画人。

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
