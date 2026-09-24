# 空间试验箱（lab/spatial）

**这是一个隔离的验证模块。它不改动、也不被 `src/` `cli/` `web/` `tests/` 依赖。**
产物全部落在 `.tmp/spatial-lab/`（已被 gitignore）；图片后缀本来就被全局忽略，不会入库。

## 它要回答的三个问题

| 问 | 实验 | 判定（含"杀死方案"的标准） |
|---|---|---|
| **Q1 提示词通道够不够？** | E2：三人同框 + 反打的压力场景，**只用提示词**抽到"可签" | 若平均 \|Δu\| 已经很小、抽卡 ≤2 次 → **方案缩水成"字段 + lint"，不建控制通道** |
| **Q2 控制图有没有用？** | E3：同场景同提示词，`prompt-only` vs `prompt+control`（控制图当参考图；软控制） | 若 \|Δu\| 下降 < 30% → **控制通道砍掉，第 3 步整体不做** |
| **Q3 试验箱本身可信吗？** | `selftest.mjs`：纯离线、确定性、不调模型 | 全绿才允许跑真实验 |

## 为什么场景要"压力"

`projects/desk_quake/reviews/retro.md` 的复盘显示：**单人、单场、2 个单元**的片子里，空间缺陷（前景遮挡/物体重复/落点未达）**全部用提示词修好了**。
也就是说：**在提示词还没被压垮之前，任何渲染器都是提前投资。** 所以试验箱刻意造一个提示词表达能力的边界场景：
三人同框、精确左右与前后的关系、以及一组反打（机位跨轴）。

## 怎么跑

```powershell
# 0) 离线自检（不调模型，几秒钟）
node lab/spatial/selftest.mjs

# 1) 冒烟：不生成，用"控制图"假装生成图，验证编排/度量/报告链路
node lab/spatial/run.mjs --dry --trials 1

# 2) 真实验：两臂 × 每镜 3 次（本地通道，0 元；12 张 ≈ 8–12 分钟 GPU）
node lab/spatial/run.mjs --arm prompt-only   --shots g1,g2 --trials 3
node lab/spatial/run.mjs --arm prompt+control --shots g1,g2 --trials 3

# 3) 汇总
node lab/spatial/report.mjs
```

## 度量怎么算（`py/measure.py`）

用 ComfyUI 自带 python 里的 **ultralytics**（已确认安装）检出画面里的人 →
每个检出框换算成归一化 `u,v`（画面坐标，左上为 0）→ 与 `scene.json` 里声明的目标位比对：

- `du` / `dv`：匹配上的主体的中心偏移（越小越好）
- `order_ok`：按框高/底边推出来的"谁在前"是否与声明的 `depth` 顺序一致
- 检出不可用时**不猜**：写 `detector: "unavailable"`，图上只留目标框与网格，改由人眼判读

> 诚实边界：这里的"控制图"是**目标框渲染**，不是几何投影（还没有相机模型）。
> 它验证的是"把构图当图给模型看，比只用文字描述有没有用"，不是"3D 一致性"。

## 与主线的关系

- 复用（只读）：`src/runtime-paths.mjs`（拿 `AIH_PYTHON` / `COMFY_GEN`）、`examples/demo-show/assets/*`（现成场景主图与身份图）
- **不**出票、**不**写 `review.approvals.json`、**不**进 `tests/run-all.mjs`
- 结论落 `lab/spatial/FINDINGS.md`，可复核的对照图留在 `.tmp/spatial-lab/`
