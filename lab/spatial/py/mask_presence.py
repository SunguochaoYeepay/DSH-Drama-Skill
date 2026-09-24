#!/usr/bin/env python3
"""逐帧掩码 → 主体存在性核查（SAM3 的产出直接可用）。

为什么它是我们要的那个核查项：
    三轮实验证明"漏人"是最严重的空间失败（pilot-02/03 里 p3 结构性漏人 0/6，
    主线 g001 的 i2v 那一版也把镜头拍丢了）。而 YOLO 那类检测器只能给"有没有人"，
    分不清**是不是该出现的那个人**；SAM3 是文字提示的分割，能指名道姓。

指标：
    presence_rate  有主体的帧占比（漏人 = 空间失败）
    coverage       主体掩码占画面面积的中位/最小/最大（突然变小 = 人快出画/被挡）
    frames_off     没有主体的帧号区间（便于直接定位到"第几秒丢了人"）

用法：
    python mask_presence.py --dir <掩码目录> [--pattern *.png] [--strip out.png] [--json out.json]
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont


def _font(size: int):
    for cand in ("C:/Windows/Fonts/consola.ttf", "C:/Windows/Fonts/arial.ttf"):
        try:
            return ImageFont.truetype(cand, size=size)
        except OSError:
            continue
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dir", required=True)
    ap.add_argument("--pattern", default="*.png")
    ap.add_argument("--threshold", type=int, default=16, help="掩码亮于该灰度算作主体")
    ap.add_argument("--strip")
    ap.add_argument("--json")
    args = ap.parse_args()

    files = sorted(Path(args.dir).glob(args.pattern))
    if not files:
        print(json.dumps({"error": f"{args.dir} 下没有 {args.pattern}"}, ensure_ascii=False))
        return 2

    rows = []
    boxes = []
    for f in files:
        with Image.open(f) as im:
            arr = np.asarray(im.convert("L"))
        ih, iw = arr.shape[:2]
        mask = arr > args.threshold
        cover = float(mask.mean())
        ys, xs = np.where(mask)
        boxes.append(
            {
                "y0": round(ys.min() / ih, 4),
                "y1": round(ys.max() / ih, 4),
                "x0": round(xs.min() / iw, 4),
                "x1": round(xs.max() / iw, 4),
            }
            if len(ys)
            else None
        )
        rows.append({"file": str(f), "coverage": round(cover, 5), "has_subject": cover > 1e-5})

    covs = [r["coverage"] for r in rows]
    off = [i for i, r in enumerate(rows) if not r["has_subject"]]
    # 连续区间，方便直接说"第几秒到第几秒丢了人"
    runs = []
    for i in off:
        if runs and i == runs[-1][1] + 1:
            runs[-1][1] = i
        else:
            runs.append([i, i])

    result = {
        "frames": len(rows),
        "presence_rate": round(1 - len(off) / len(rows), 4),
        "missing_frames": [i + 1 for i in off],
        "missing_runs_1based": [[a + 1, b + 1] for a, b in runs],
        "coverage_median": round(float(np.median(covs)), 5),
        "coverage_min": round(float(np.min(covs)), 5),
        "coverage_max": round(float(np.max(covs)), 5),
        # 包围盒（取有掩码帧的中位）—— 看"圈出来的是不是一条横向的窄带"就能认出字幕
        "bbox_median": (
            {
                k: round(float(np.median([b[k] for b in boxes if b])), 4)
                for k in ("y0", "y1", "x0", "x1")
            }
            if any(boxes)
            else None
        ),
        "per_frame": rows,
    }

    if args.strip:
        picks = [rows[int(round(i * (len(rows) - 1) / 5))] for i in range(6)]
        tiles = []
        for p in picks:
            img = Image.open(p["file"]).convert("RGB")
            d = ImageDraw.Draw(img)
            d.text((6, 6), f"cov={p['coverage']:.3f}", fill="#ff4d4d", font=_font(18))
            tiles.append(img)
        w, h = tiles[0].size
        scale = 320 / w
        tw, th = int(w * scale), int(h * scale)
        canvas = Image.new("RGB", (tw * 3 + 8, th * 2 + 6), "#101012")
        for i, t in enumerate(tiles):
            canvas.paste(t.resize((tw, th)), ((i % 3) * (tw + 4) + 2, (i // 3) * (th + 3) + 2))
        Path(args.strip).parent.mkdir(parents=True, exist_ok=True)
        canvas.save(args.strip, "PNG", optimize=True)

    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.json:
        Path(args.json).write_text(text + "\n", encoding="utf-8")
    print(json.dumps({k: v for k, v in result.items() if k != "per_frame"}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
