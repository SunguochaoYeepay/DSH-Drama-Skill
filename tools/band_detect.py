#!/usr/bin/env python3
"""找"烧入字幕"在画面里的带（画面比例），供去字幕通道当掩码用。

为什么不再用模型找：`SAM3_Detect(text="subtitle"/"caption"/"text")` 在我们这段
烧入中文硬字幕上**逐帧全空**（实测 48 帧 coverage 全 0，见 .tmp/void-test/mask-stats.json），
点提示又会圈到背后衣服。但字幕本身有很稳定的**图像特征**，不必用模型：

  1. 近白（烧入字幕通常是白字 + 深色描边）
  2. 局部梯度高（字形笔画是锐边，白墙/白衣服没有这个）
  3. 横向居中（我们的字幕一直是居中/居中的下三分之一）
  4. 落在画面下半部（本项目的口径：约 70%–81% 高度）

这个脚本只做 1–4 的**候选定位**，输出一个带；它**不判断"有没有字幕"** ——
字幕存不存在要人看 `cli/subcheck.mjs` 抽出来的那张图。判错位置的代价是
"把画面中间重画一遍"，所以调用方应当把这个输出当**建议**，可被人覆写。

用法：
  python tools/band_detect.py --video in.mp4 --ffmpeg <ffmpeg.exe> [--samples 12] [--json]

输出一行 JSON：{video,size,frames,band:{top,bottom,left,right},band_px,evidence:{...}}
找不出候选时仍输出 JSON，但 band=null 且 evidence.reason 说明原因（不猜一个位置给你）。
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

# 判定用的固定阈值（灰度 0–255；本项目实测 480×864 的字幕是纯白字 + 深色描边）
CENTRAL = (0.12, 0.88)   # 只在画面横向中部找，避开台标/水印
LOWER = (0.45, 0.98)     # 只在画面下半部找（本项目字幕带约 70%–81%）


def read_gray(video: str, ffmpeg: str, samples: int):
    """抽 samples 帧灰度图，返回 (frames, w, h)。抽不出来就抛，不猜。"""
    probe = subprocess.run(
        [ffmpeg.replace("ffmpeg.exe", "ffprobe.exe") if ffmpeg.endswith("ffmpeg.exe") else "ffprobe",
         "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,nb_frames", "-of", "json", video],
        capture_output=True, text=True,
    )
    info = json.loads(probe.stdout)["streams"][0]
    w, h = int(info["width"]), int(info["height"])
    total = int(info.get("nb_frames") or 0) or samples
    step = max(1, total // samples)

    with tempfile.TemporaryDirectory() as td:
        raw = Path(td) / "g.raw"
        r = subprocess.run(
            [ffmpeg, "-v", "error", "-y", "-i", video,
             "-vf", f"select='not(mod(n\\,{step}))',format=gray", "-fps_mode", "passthrough",
             "-f", "rawvideo", str(raw)],
            capture_output=True, text=True,
        )
        if r.returncode != 0:
            raise RuntimeError(f"ffmpeg 抽帧失败: {r.stderr[:200]}")
        buf = np.fromfile(raw, dtype=np.uint8)
    n = buf.size // (w * h)
    if n <= 0:
        raise RuntimeError("抽帧后没有完整帧")
    return buf[: n * w * h].reshape(n, h, w), w, h


def glyph_pixels(frames: np.ndarray) -> np.ndarray:
    """返回 (n,h,w) 布尔：**亮 + 细 + 带深色描边**的像素 = 字形。

    三个判据缺一不可，这是被数据逼出来的（`.tmp/void-test/try-tophat.py` 的对照）：
      · 白顶帽 `tophat = img - opening(img, 5) >= 25`：只留**细**的亮结构。
        白毛衣、白墙这类大片亮区被开运算抹掉 —— 只用"亮 + 有梯度"会把毛衣上的
        高对比边缘全当成字，实测把字幕左边界从 199 拉到 0。
      · `img >= 170`：确实是亮的（描边本身是暗的，不能算）。
      · 3×3 邻域里有 `<= 90` 的暗像素：烧入字幕的**描边**。
    三个一起用，落在真实字幕行/列上（行 627–662、列 199–280，与本片目视一致）。
    """
    out = np.zeros(frames.shape, dtype=bool)
    for i, a in enumerate(frames):
        im = Image.fromarray(a)
        opened = np.asarray(
            im.filter(ImageFilter.MinFilter(5)).filter(ImageFilter.MaxFilter(5)),
            dtype=np.int16,
        )
        tophat = a.astype(np.int16) - opened
        local_min = np.asarray(im.filter(ImageFilter.MinFilter(3)), dtype=np.int16)
        out[i] = (tophat >= 25) & (a >= 170) & (local_min <= 90)
    return out


def detect(frames: np.ndarray, w: int, h: int):
    """行带 = "有多少帧在这一行有字形"，而不是"平均每行有多少字形"。

    这一点是被数据纠正的：这段 3 秒片段里字幕**只在部分帧出现**（12 个抽样帧里约 4 帧），
    用跨帧中位数会把真实字幕行抹成 0 —— 于是明明有字幕却报"下半部没有字形密度"。
    换成占用帧数后，间歇出现的字幕照样能被找出来。
    """
    mask = glyph_pixels(frames)
    n = int(frames.shape[0])
    x0, x1 = int(CENTRAL[0] * w), int(CENTRAL[1] * w)

    per_frame_rows = mask[:, :, x0:x1].sum(axis=2)          # (n, h) 每帧每行的字形像素数
    min_per_row = 3                                          # 单帧里一行至少有这么多才算"这行有字"
    occupancy = (per_frame_rows >= min_per_row).sum(axis=0)  # (h,) 有多少帧这一行有字
    need = max(3, int(np.ceil(0.12 * n)))                    # 至少这么多帧才算候选行
    # 行带还必须**够高**：真字幕是一整行字，十几到几十像素；画面里的偶发亮点只有几行。
    # 这两个下限是被下面这些反例逼出来的（都是"无字幕片段"上的误报）：
    #   i2v_20260924-064705 6 行 / 2 帧、i2v_20260922-173609_nosub 8 行 / 3 帧，
    #   而真字幕（sub3s.mp4）是 38 行 / 4 帧。只按帧数筛不掉它们。
    min_run = max(6, int(round(0.03 * h)))

    ys = slice(int(LOWER[0] * h), int(LOWER[1] * h))
    cand = occupancy[ys]
    peak = int(cand.max()) if cand.size else 0
    ev = {
        "n_frames": n,
        "row_peak_occupancy": peak,
        "row_need": need,
        "min_run_rows": min_run,
        "window": {"x": [x0, x1], "y": [ys.start, ys.stop]},
    }
    if peak < need:
        ev["reason"] = f"下半部没有哪一行在 ≥{need} 帧里出现字形（最多 {peak} 帧）"
        return None, ev

    rows = np.where(cand >= need)[0]
    if rows.size == 0:
        ev["reason"] = "没有行达到占用阈值"
        return None, ev
    # 取最长的连续段（断行说明是两块不同的东西，比如水印 + 字幕）
    best = (rows[0], rows[0])
    start = prev = rows[0]
    for y in rows[1:]:
        if y == prev + 1:
            prev = y
            continue
        if prev - start > best[1] - best[0]:
            best = (start, prev)
        start = prev = y
    if prev - start > best[1] - best[0]:
        best = (start, prev)

    run = int(best[1] - best[0] + 1)   # numpy 整数不能直接 json.dumps，转成 python int
    if run < min_run:
        ev["reason"] = (f"最长连续行带只有 {run} 行（< {min_run}）—— 像是零散亮点而不是一整行字；"
                        f"行 {best[0] + ys.start}–{best[1] + ys.start}")
        ev["row_run"] = run
        return None, ev

    # 行带上下各留一点余量（笔画抗锯齿与描边会被阈值切掉），但别吃掉半张脸
    pad = max(2, int(round(0.012 * h)))
    top = max(ys.start, best[0] + ys.start - pad)
    bottom = min(ys.stop, best[1] + ys.start + pad)

    # 横向范围：只看**真的有字**的那几帧（其余帧这里本来就没东西）
    with_text = np.where((per_frame_rows[:, top:bottom] >= min_per_row).any(axis=1))[0]
    band_mask = mask[with_text][:, top:bottom, :] if with_text.size else mask[:, top:bottom, :]
    # 列也要**在足够多帧里**出现字形才算数（偶发的高梯度噪点会骗过单帧判断，
    # 实测就把左边缘背景噪点当成了字幕，把 left 拉到 0.12）。
    col_per_frame = band_mask.sum(axis=1)                    # (nf, h_band, w)
    col_frames = (col_per_frame >= 1).sum(axis=0)            # (w,) 有多少帧这一列有字形
    cols = np.where(col_frames >= max(2, need // 2))[0]
    if cols.size == 0:
        cols = np.where(col_frames >= 1)[0]
    if cols.size == 0:
        ev["reason"] = "行带内没有字形像素（阈值与行选择不一致）"
        return None, ev
    lo, hi = np.percentile(cols, [1, 99])
    padx = max(2, int(round(0.02 * w)))
    left = max(0, int(lo) - padx)
    right = min(w, int(hi) + padx)

    ev.update({
        "frames_with_text": int(with_text.size),
        "row_run": run,
        "row_span": [int(best[0] + ys.start), int(best[1] + ys.start)],
        "col_span": [int(cols.min()), int(cols.max())],
    })
    band = {
        "top": round(top / h, 4), "bottom": round(bottom / h, 4),
        "left": round(left / w, 4), "right": round(right / w, 4),
    }
    return band, ev


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--video", required=True)
    ap.add_argument("--ffmpeg", default="ffmpeg", help="ffmpeg 可执行文件（本机不在 PATH 上）")
    ap.add_argument("--samples", type=int, default=24,
                    help="抽多少帧找候选（默认 24；字幕只在一部分帧出现时，抽少了会漏 —— "
                         "实测 desk_quake 那段字幕只占约 20%% 的帧，12 帧时漏掉、24 帧时找到）")
    ap.add_argument("--json", action="store_true", help="只输出 JSON（默认也是 JSON，这个开关是给调用方看的）")
    args = ap.parse_args()

    if not Path(args.video).exists():
        print(json.dumps({"error": f"视频不存在：{args.video}"}, ensure_ascii=False))
        return 2
    try:
        frames, w, h = read_gray(args.video, args.ffmpeg, max(2, args.samples))
    except Exception as exc:  # 抽帧失败就说清楚，别给个假带
        print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        return 2

    band, ev = detect(frames, w, h)
    out = {
        "video": args.video,
        "size": [w, h],
        "frames": int(frames.shape[0]),
        "band": band,
        "band_px": None if band is None else {
            "x": int(round(band["left"] * w)), "y": int(round(band["top"] * h)),
            "width": int(round(band["right"] * w)) - int(round(band["left"] * w)),
            "height": int(round(band["bottom"] * h)) - int(round(band["top"] * h)),
        },
        "evidence": ev,
        "note": "这是**候选**位置，不判断字幕是否存在；带错会重画错的地方，请用 cli/subcheck.mjs 抽帧确认",
    }
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
