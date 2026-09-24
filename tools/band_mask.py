#!/usr/bin/env python3
"""生成"字幕带去字幕"用的掩码 PNG（**带子黑、其余白**）。

为什么极性是这样：VOID 的 quadmask 是「白=保留，黑=要修」，与 ComfyUI 常规相反。
判定依据（实测）：全白掩码 → 输出与原片一模一样（全部保留=透传）；
白带黑底 → 输出变成无关画面（只保留那条带=整帧被重画）。

为什么写成脚本而不是在图里画：ComfyUI 原生的 `MaskRectArea` 四个参数都是 0–100 的
百分比、且没有画布尺寸输入，语义不明确；而掩码文件这条路**已经端到端验证过**
（480×864、两趟、字幕消失、带外差 11.02）。PIL 由 ComfyUI 的 python 保证存在。

用法：
  python tools/band_mask.py --size 480x864 --top 0.695 --bottom 0.805 \
      --left 0.28 --right 0.72 --out mask.png [--blur 0]
输出：一行 JSON（几何 + 黑白占比），便于调用方与被测试断言。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--size", required=True, help="视频尺寸 WxH")
    ap.add_argument("--top", type=float, required=True)
    ap.add_argument("--bottom", type=float, required=True)
    ap.add_argument("--left", type=float, default=0.0)
    ap.add_argument("--right", type=float, default=1.0)
    ap.add_argument("--blur", type=float, default=0.0, help="边缘羽化像素（0 = 硬边）")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    try:
        w, h = (int(x) for x in str(args.size).lower().split("x"))
    except ValueError:
        print(json.dumps({"error": f"--size 应为 WxH，收到 {args.size}"}, ensure_ascii=False))
        return 2
    if not (w > 0 and h > 0):
        print(json.dumps({"error": f"尺寸非法：{args.size}"}, ensure_ascii=False))
        return 2
    for name, v in (("top", args.top), ("bottom", args.bottom), ("left", args.left), ("right", args.right)):
        if not (0.0 <= v <= 1.0):
            print(json.dumps({"error": f"{name}={v} 必须在 0~1"}, ensure_ascii=False))
            return 2
    if not (args.bottom > args.top and args.right > args.left):
        print(json.dumps({"error": "bottom 必须大于 top、right 必须大于 left"}, ensure_ascii=False))
        return 2

    x0, y0 = int(round(args.left * w)), int(round(args.top * h))
    x1, y1 = int(round(args.right * w)), int(round(args.bottom * h))
    x1, y1 = min(w, max(x1, x0 + 1)), min(h, max(y1, y0 + 1))

    img = Image.new("L", (w, h), 255)          # 白 = 保留
    ImageDraw.Draw(img).rectangle([x0, y0, x1 - 1, y1 - 1], fill=0)   # 黑 = 要修
    if args.blur and args.blur > 0:
        img = img.filter(ImageFilter.GaussianBlur(float(args.blur)))

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out)

    dark = float((1 - sum(img.getdata()) / (255 * w * h)))
    print(json.dumps({
        "out": str(out),
        "size": [w, h],
        "band_px": {"x": x0, "y": y0, "width": x1 - x0, "height": y1 - y0},
        "band_frac": {"top": args.top, "bottom": args.bottom, "left": args.left, "right": args.right},
        "black_ratio": round(dark, 5),
        "polarity": "black=repair, white=keep",
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
