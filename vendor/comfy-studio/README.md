# vendor/comfy-studio — 第三方工具快照

## 这是什么

三个 Python 文件，来自本机的 **`comfy-studio` agent skill**（生图/出片的 ComfyUI 调用入口）：

| 文件 | 行数 | 作用 |
|---|---|---|
| `gen.py` | 775 | 唯一入口命令行：t2i / edit / t2v / i2v / fl2v / r2v / music，直接打 ComfyUI HTTP API |
| `graphs.py` | 1043 | 各种模式的工作流图构建（ComfyUI API 格式） |
| `routes.py` | 292 | 模式推断、参数推断、本地小模型把大白话编译成提示词 |

仓库里保留这份**快照**只有一个理由：别人 `git clone` 下来 `npm install` 之后，流水线在没有
`~/.agents/skills/comfy-studio/` 的机器上也合得上 —— 否则每个人都要先手工装同一个 skill 才能跑第一步。

默认读取位置见 `src/runtime-paths.mjs`：

```js
const VENDORED_GEN = path.join(PROJECT_ROOT, 'vendor', 'comfy-studio', 'gen.py');
export const COMFY_GEN = process.env.AIH_GEN || VENDORED_GEN;
```

想用自己的那份（本地 skill、或上游最新版），设环境变量覆盖即可，不必改代码：

```powershell
$env:AIH_GEN = "$env:USERPROFILE\.agents\skills\comfy-studio\gen.py"
```

## ⚠ 许可状态：未知

**这三个文件里没有任何版权声明或许可头。** 它们是本机 skill 的副本，作者与授权条款在此未能确定。

因此请注意：

- 本仓库的 MIT 许可**只覆盖本仓库自己编写的部分**，不覆盖 `vendor/` 下的第三方代码。
- 若要把这份快照公开发布，请先确认上游授权；拿不到明确授权的话，
  建议**删掉 `vendor/` 并把 `AIH_GEN` 指向自己机器上的那份**（见上文环境变量）。

## 同步策略：手工，且必须三个一起

这是快照，不是 submodule，**上游改了这里不会自动跟**。
要更新就 `gen.py` / `graphs.py` / `routes.py` **三个文件同时重拷**，拷完再跑一遍 `cli/assets.mjs`
与 `cli/keyframes.mjs` 回归——三者之间有隐式契约，替换其中一个几乎必然崩。

有需要时按下述顺序做：

1. 备份当前三份到临时目录；
2. 拷入新三份；
3. 至少各跑一次本地预览档生图与一次出片，确认产物结构未变。
