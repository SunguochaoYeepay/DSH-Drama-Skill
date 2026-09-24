#!/usr/bin/env python3
"""把 scene.json 的站位声明画成一张「空间示意图」（控制图）。

这是正式方案里「声明 → 白模/构图控制图」渲染器的最小种子：**零模型、确定性、可复现**。

诚实边界：它按声明的 (u, v) 直接画框，**不做几何投影**（还没有相机模型）。
所以它验证的是「把构图当图给模型看，比只用文字描述有没有用」，不是 3D 一致性。

用法：
  python render_blockout.py --scene scene.json --shot g1 --out blockout_g1.png
  python render_blockout.py --scene scene.json --list
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# 标记色：每人一色（借 DramaClaw 的 COLOR LAW 思路——颜色只是定位符，绝不进成图）
MARKER_COLORS = ["#4aa3ff", "#ff9f40", "#7ed957", "#ff6b9d"]
ANON_COLOR = "#b8b8b8"  # 没有身份图 / 群演：灰

DEPTH_SCALE = {"near": 1.0, "mid": 0.7, "far": 0.45}
DEPTH_RANK = {"near": 3, "mid": 2, "far": 1}
BG = "#1c1c1e"
GRID = "#3a3a3d"
TEXT = "#e8e8ea"


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


def color_for(scene: dict, subject_id: str, cache: dict) -> str:
    ident = next((x for x in scene.get("identities", []) if x["id"] == subject_id), None)
    if not ident or not ident.get("sheet"):
        return ANON_COLOR
    if subject_id not in cache:
        used = len(cache)
        cache[subject_id] = MARKER_COLORS[used % len(MARKER_COLORS)]
    return cache[subject_id]


def render(scene: dict, shot: dict, width: int, height: int) -> Image.Image:
    img = Image.new("RGB", (width, height), BG)
    d = ImageDraw.Draw(img)
    f_title = _font(max(16, width // 34))
    f_label = _font(max(13, width // 46))

    # 三分网格
    for i in (1, 2):
        x = int(width * i / 3)
        y = int(height * i / 3)
        d.line([(x, 0), (x, height)], fill=GRID, width=1)
        d.line([(0, y), (width, y)], fill=GRID, width=1)

    cache: dict[str, str] = {}
    base_w, base_h = width * 0.17, height * 0.34

    for s in shot["subjects"]:
        u, v = float(s["u"]), float(s["v"])
        scale = DEPTH_SCALE.get(s.get("depth", "mid"), 0.7)
        bw, bh = base_w * scale, base_h * scale
        cx, cy = u * width, v * height
        x0, y0, x1, y1 = cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2
        col = color_for(scene, s["id"], cache)

        d.rectangle([x0, y0, x1, y1], outline=col, width=max(2, width // 260))
        d.line([(cx - bw * 0.18, cy), (cx + bw * 0.18, cy)], fill=col, width=1)  # 中心十字
        d.line([(cx, cy - bh * 0.1), (cx, cy + bh * 0.1)], fill=col, width=1)

        label = f"{s['id']}  x={u:.2f}  {s.get('depth','mid').upper()}"
        d.text((x0, max(0, y0 - f_label.size - 4)), label, fill=col, font=f_label)

    order = sorted(shot["subjects"], key=lambda s: -DEPTH_RANK.get(s.get("depth", "mid"), 2))
    order_line = "  >  ".join(f"{s['id']}({s.get('depth')})" for s in order)

    d.text((8, 6), f"BLOCKOUT / layout only   shot={shot['id']}   side={shot.get('camera_side','?')}", fill=TEXT, font=f_title)
    d.text((8, 6 + f_title.size + 4), f"depth order (near->far): {order_line}", fill=TEXT, font=f_label)
    d.text((8, height - f_label.size - 10), "positions only / appearance comes from reference images", fill="#8a8a8e", font=f_label)
    return img


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--scene", required=True)
    ap.add_argument("--shot")
    ap.add_argument("--out")
    ap.add_argument("--width", type=int, default=864)
    ap.add_argument("--height", type=int, default=1536)
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()

    scene = json.loads(Path(args.scene).read_text(encoding="utf-8"))

    if args.list:
        print(json.dumps([s["id"] for s in scene["shots"]], ensure_ascii=False))
        return 0

    shot = next((s for s in scene["shots"] if s["id"] == args.shot), None)
    if shot is None:
        print(f"没有这一镜：{args.shot}", file=sys.stderr)
        return 2

    img = render(scene, shot, args.width, args.height)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out, "PNG", optimize=True)
    print(json.dumps({"out": str(out), "shot": shot["id"], "size": [args.width, args.height]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
