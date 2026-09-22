# 本轮一次性事实（不进仓库）

> 按 `references/workflow.md`「收工与知识回流」第一节：本次项目的耗时、文件名、一次性实验只留在本剧目。

## 版本链（每一步的实际产物）

| 阶段 | 产物 | 说明 |
|---|---|---|
| 素材 | `inputs/story-brief.md` | 含我补的**行型格式契约**（见下） |
| 剧本 | `story.md` + `story.provenance.json` | qwen3.8-max，逐字保真 1 句台词 |
| 板子 | `board-brief.json` → `board.json` | 角色 `shiba`（`species: dog`, `voice: longtian_v3`） |
| 导演 | `board.direction.json` + `.provenance.json` | v6，1 单元 / 4 镜 / 14.00s |
| 资源方案 | `asset-design.json` | 场景 1 + 人物造型 1，`questions` 均为空 |
| 资源 | `assets/` 4 张 | portrait / sheet / master / bone_ref_image |
| 计划 | `render.plan.json` | 单元 `g001`，14.00s |
| 关键帧 | `keyframes_render/g001.png` | 第 2 版（v1 备份在 `.tmp/keyframe-g001-v1.png`） |
| 片段 | `units/i2v_20260919-194942.mp4` | 480×864@24fps，14.375s，0 解码报错 |
| 成片 | `out/final.mp4` | 3.21 MB，14.42s，h264+aac |

## 耗时与花费

| 项 | 时长 | 花费 |
|---|---|---|
| 剧本生成 | ~22 秒 | 计入文本接口，量级可忽略 |
| 建板 / 资源方案 / 干跑 / 探针 | 秒级 | **0 元** |
| 导演（失败，撞 12000 token） | **307 秒** | **≈ 0.5 元（零产物）** |
| 导演 `--batched` v1 | 29 秒 | ≈ 0.2 元 |
| 导演 `--batched` v2（修方位） | 25 秒 | ≈ 0.2 元 |
| 导演 `--batched` v3（带返修重跑） | 25 秒 | ≈ 0.2 元 |
| 资产 4 张（本地 ComfyUI） | 35+112+22+24 = 193 秒 | **0 元** |
| 关键帧 v1 | 83 秒 | **0 元** |
| 关键帧 v2（重抽） | 78 秒 | **0 元** |
| 出片 g001（本地 H3 fast/vsa） | 121.6 秒 | **0 元** |
| 合成 | 秒级 | **0 元** |

**合计约 1.1–1.2 元**。精确值无法给出：导演/剧本入口不写账本，项目里没有 `costs.json`。

## 一次性的坑（只与本案相关）

1. **第一版剧本不可解析**：模型写「第一集 留给咪咪的骨头」+「场景一 老式客厅·地面 傍晚转夜」——前者被当成场次头，后者掉成动作行。处置：在素材里**显式写入行型格式契约**后重跑。备份 `.tmp/backup-v1-unparseable/`。
   根因：`cli/script.mjs generate` 的 system prompt 没有行型契约（旧 `references/prompts/idea-to-story.md` 已退役），**剧本可解析性靠运气**。这条**没有**写进规则文件 —— 它是"系统提示词缺少契约"的工程缺口，需要的是改代码而不是写文档。
2. **导演 shot 2 方位自相矛盾**（视线向左 + 摄影机右移 + 把东西带进画面左侧）。处置：写 `reviews/revision.md`，用 `--batched --feedback` 返修。备份 `.tmp/backup-direction-v1-batched/`。
3. **`species` 漏填导致返工**：改 `characters[]` 会改 `board_identity_sha256`，在旧契约下会作废导演票 —— 我实测确认过。**新契约已删除该闸门**，这条代价不复存在。
