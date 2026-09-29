# vendor/whitebox-assets — 白膜资产库快照

## 这是什么

短剧白膜预演（剧本 → Blender 白膜视频 → H3 按白膜渲成片）用的**基础资产**：

| 条目 | 内容 |
|---|---|
| `ual/` | Quaternius **Universal Animation Library**（免费标准版，glTF）：1 个无脸 Mannequin 人形（1.83m、53 骨、Rigify 风 `DEF-*` 命名）+ **46 条预制动作**（走/跑/出拳三段/受击/坐四件套/倒地/跳/对话站姿等） |
| `manifest.json` | 资产清单 —— 动作全表、骨骼约定、角色档位（男 1.0×/女 0.95×/儿童 0.7× + 灰度）。**从 glTF 数据机器生成**，是给 LLM 看的"可选项菜单"，不是手抄的 |
| `ext/` | **扩展包投放点**（gitignored）：家具包、Universal Base Characters、UAL 完整版等大件放这里，不进 git |

## 来源与许可

- 来源：https://github.com/J-Ponzo/gltf-universal-animation-library （quaternius.itch.io/universal-animation-library 的 glTF 镜像）
- 许可：**CC0-1.0**（`ual/LICENSE`），商用无需署名
- 入库日期：2026-09-28

## 为什么入库

这份只有 ~4 MB，是白膜管线的**最小可运行集**：没有它，clone 下来的仓库跑不了任何
白膜脚本（每个使用者都得自己去外网找同一个库再摆对位置）。与 `vendor/comfy-studio`
同一逻辑 —— 基础件入库，扩展件（体积大、按需）走 `ext/`。

## 路径解析

脚本默认读仓库内这份（相对项目根 `vendor/whitebox-assets/`），环境变量可覆盖：

```
AIH_WHITEBOX_ASSETS=<自定义路径>   # 不设 = 用仓库内快照
```

使用处：`lab/whitebox/whitebox_render.py`（渲染器）、`cli/whitebox.mjs`（入口，自动拼出这份路径）。
一次性探查脚本（探 glTF 结构、试导入三角色）2026-09-29 已清理，不再列在这里。

## 动作命名约定（LLM 选动作时照此）

- `_Loop` 后缀：可无缝循环（如 `Walk_Loop`）
- `_RM` 后缀：带根位移（root motion，如 `Walk_RM`），位移类动作用它防滑冰
- 动画帧率 30fps

## 改动备案

2026-09-28 首次入库（自 `E:\AI-Image\whitebox-assets` 迁入，仅载荷文件；原 E 盘目录已删）。
后续任何改动在此追加一行：日期 + 内容 + 原因。
