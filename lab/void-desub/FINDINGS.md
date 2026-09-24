# VOID 去字幕通道：结论与依据（2026-09-24）

> 这一段实验的记录。**代码在 `cli/desub-void.mjs` + `src/void-desub.mjs` + `tools/{band_mask,band_detect}.py`
> + `src/video-diff.mjs` + `cli/band-diff.mjs`**，本文件只留"凭什么这么写"。

## 一句话结论

烧入字幕**不需要模型去找**：位置是已知的固定带，把它画成掩码交给 VOID 重画即可；
自动找带也用不上模型（SAM3 逐帧全空），用"亮 + 细 + 带描边"的经典字形特征就能定位到行。

## 路线（选 B）：绕开 SAM3，自己给 quadmask

VOID 自带工作流用 `SAM3_Detect(text=...)` 出掩码，实测**在我们的烧入中文硬字幕上完全失效**：

| 提示词 | 帧数 | 命中率 | coverage |
|---|---|---|---|
| `subtitle` | 48 | 0% | 0 |
| `caption` / `text` / `words_on_screen` / `watermark` | 48 | 0% | 0 |

（`mask-stats.json`，见 `.tmp/void-test/mask-*`；点提示则圈到了背后的毛衣。）所以改成：
**掩码由"声明的字幕带"生成**，VOID 只负责重画带内。

## 掩码极性：白 = 保留，黑 = 要修（与 ComfyUI 常规相反）

这条判定必须写下来，因为**反了不报错，只会把整帧重画**。三组对照（480×864，3s，两趟）：

| 掩码 | 带内差 | 带外差 | 裁决 | 眼睛看到的 |
|---|---|---|---|---|
| 白底 + 黑带（`tools/band_mask.py` 的产物） | **22.35** | **3.76** | ✔ `band_only` | 字幕消失，人脸/杯子/毛衣保留 |
| 全白（= 什么都不修、透传） | 4.54 | 3.90 | ✗ `band_untouched` | 字幕**还在** |
| 黑底 + 白带（反极性） | — | — | — | 只做过 384×672 的一次，几何与上面不可比，未采纳为证据 |

判读口径与阈值写在 `src/video-diff.mjs`：**底噪必须先扣掉** —— 全白透传一遍也有 ~4 的灰度差
（解码→推理→再编码），所以"带内没动"不能写成 `band < 2`（那样永远判不出来）。

**反例也是证据**：全白那一组就是本通道的负对照 —— 没有它，"带内差 22"这个数说明不了任何事。

## 自动找字幕带（`tools/band_detect.py`）

不能用模型，但字幕的图像特征很稳定：**亮 + 细 + 深色描边**。
`tophat = img − opening(img, 5) ≥ 25`（只留细亮结构）`& img ≥ 170 & 邻域有 ≤ 90 的暗像素`（描边）。

判定行用的是**"有多少帧在这一行有字形"**而不是跨帧中位数 —— 被数据纠正过：
`sub3s.mp4` 里字幕只在约 1/4 的帧出现，中位数把真实字幕行抹成 0，于是"明明有字幕"却报"没找到"。

在 5 个片段上的实测（`--samples 24`）：

| 片段 | 有字幕 | 结果 | 真值 |
|---|---|---|---|
| `.tmp/void-test/sub3s.mp4` | 有 | y 0.7141–0.7801，行 627–664，列 198–280 | 目视 行 627–662、列 199–280 ✔ |
| `projects/desk_quake/units/i2v_20260922-175923.mp4` | 有（约 20% 帧） | y 0.7141–0.7801，行 627–664 | 字幕在 0.73–0.76 ✔ |
| `projects/fl2v-lab/units/i2v_20260924-064705.mp4` | 无 | null（零散亮点，行带 1 行 < 26） | 无字幕 ✔ |
| `examples/demo-show/units/i2v_20260922-173609_nosub.mp4` | 无 | null（行带 5 行 < 26） | 无字幕 ✔ |
| `projects/desk_quake/units/i2v_20260922-174201.mp4` | 无 | null（占用帧数不够） | 无字幕 ✔ |

两个防误报的闸门（都是被上面的反例逼出来的）：**行带至少要 3% 画面高**（真字幕 38 行，误报 1–8 行）、
**至少有 12% 的抽样帧在该行有字形**。抽 12 帧时 `i2v_20260922-175923` 会漏（字幕只占 20% 的帧），
抽 24 帧才找到 —— 所以默认 `--samples 24`。

## 开销（480×864，3 秒，两趟，原生分辨率）

- VOID 两趟：**247 秒**（384×672 一趟只要 79 秒，但那是另一档尺寸，不能混着比）
- 掩码生成 + 核查抽帧：各不到 2 秒
- 全程本地，0 元

## 复现

```powershell
# 端到端（自动找带 → 生成掩码 → 上传 → 跑 → 自核查）
node cli/desub-void.mjs .tmp/void-test/sub3s.mp4 --auto-band --out .tmp/void-test/cli-autoband.mp4

# 负对照：全白掩码 = 什么都不修（应当判 band_untouched，退出码 1）
node cli/desub-void.mjs .tmp/void-test/sub3s.mp4 --mask .tmp/void-test/allwhite_mask.png --out .tmp/void-test/cli-allwhite.mp4

# 只核查，不重跑
node cli/band-diff.mjs 原片.mp4 处理后.mp4 --top 0.695 --bottom 0.805 --left 0.28 --right 0.72

# 找带
$py = "E:\AI-Image\ComfyUI-aki-v1.4\python\python.exe"
& $py tools/band_detect.py --video <片段> --ffmpeg <ffmpeg.exe> --samples 24
```

离线自检：`node tests/video-diff.test.mjs`、`node tests/band-detect.test.mjs`（合成视频做真值）
