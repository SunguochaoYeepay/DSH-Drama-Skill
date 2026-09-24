# 已删除：本地 VOID 去字幕通道（2026-09-24 做，同日删）

> **这条通道已经被删掉了**（`cli/desub-void.mjs` / `src/void-desub.mjs` /
> `tools/band_mask.py` / `tests/void-desub.test.mjs`）。本文件留档，只为**别再重建一遍**。
> 去字幕现在只有一条通道：`cli/desub.mjs`（VSR，走 Docker）。

## 为什么删：同片段实测对照

同一条片段（11.5 秒 / 480×864 / 277 帧），两条通道各跑一遍：

| | **VSR（Docker）** | **VOID（本地 ComfyUI）** |
|---|---|---|
| 耗时 | **37 秒**（含 mpeg4→h264 重编码） | 跑 10 分钟没跑完；按 3 秒片段 247 秒推算 **≈950 秒** |
| 折算 | ≈3.2× 实时 | ≈80× 实时 |
| 带内差 / 带外差 | 16.16 / **2.50**（倍数 6.47） | 早先小片段：22.35 / 3.76 |

用户当场拍板：**删掉**。差距不是参数没调好，是模型类别 —— VOID 是扩散式视频修复
（每帧每趟完整采样，还开了两趟），VSR 默认的 `sttn-det` 是传播式（光流 + 时域传播，不逐帧采样）。

**这条弯路值得记下来**：仓库里本来就有 VSR 的实测耗时（13.6 秒片段 21 秒），
我却只盯着"免 Docker"去做第二条，没先拿同一条片段跟它比一次。
**"能不能做对"不等于"该不该用它做"。**

## 留下来的是哪两件（已接到 VSR 通道上）

| 留下的 | 现在在哪 |
|---|---|
| **自动找字幕带** | `tools/band_detect.py` + `cli/desub.mjs --auto-band` |
| **带内差 / 带外差核查** | `src/video-diff.mjs`、`cli/band-diff.mjs`、`cli/desub.mjs` 跑完自动报 |

这两件与用哪个修复算法无关，是这次真正的产出。

## 原通道的结论（如果将来真的要在没有 Docker 的机器上重做）

- **不要用模型找字幕**：`SAM3_Detect(text=subtitle/caption/text)` 在烧入中文硬字幕上
  48 帧命中率 **0%**；点提示会圈到背后的衣服。
- **自动找带用经典字形特征就够**：亮 + 细（白顶帽 `img − opening(img,5) ≥ 25`）+ 邻域有深色描边
  （烧入字幕的描边）。在 5 个片段上：两个有字幕的都定位到行 627–664、列 ~199–280（与目视一致），
  三个无字幕的全部返回 null。
  - 判行要用**"有多少帧在这一行有字形"**，不是跨帧中位数 —— 字幕可能只在一部分帧出现
    （`sub3s.mp4` 只有约 1/4 帧有字，中位数会把真实字幕行抹成 0）。
  - 两道防误报闸门：行带 ≥3% 画面高（真字幕 38 行，误报 1–8 行）、≥12% 抽样帧在该行有字形。
  - 默认 `--samples 24`：抽 12 帧会漏掉"字幕只占 20% 帧"的片段。
- **VOID 的 quadmask 极性是「白=保留，黑=要修」**（与 ComfyUI 常规相反）。判法：
  全白掩码 → 输出与原片一致（透传）；白带黑底 → 只保留那条带、其余全被重画。

## 复现（现在只剩 VSR 这条）

```powershell
# 去字幕：自动找带 + 跑完自带核查（11.5 秒片段约 37 秒）
node cli/desub.mjs <片段.mp4> --auto-band --out <干净版.mp4>

# 只核查，不重跑
node cli/band-diff.mjs 原片.mp4 处理后.mp4 --top 0.699 --bottom 0.764 --left 0.185 --right 0.802

# 找带
$py = "E:\AI-Image\ComfyUI-aki-v1.4\python\python.exe"
& $py tools/band_detect.py --video <片段> --ffmpeg <ffmpeg.exe> --samples 24
```

离线自检：`node tests/video-diff.test.mjs`、`node tests/band-detect.test.mjs`、`node tests/desub-vsr.test.mjs`
