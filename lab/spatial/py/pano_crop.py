#!/usr/bin/env python3
"""2:1 等距全景 → 任意机位的透视截图（可选：叠加"站位人形"）。

这是正式方案里"构造性空间"的最小件：**一个空间，任意机位取景**。
算法与 DramaClaw 的 pano_views.equirectangular_to_perspective 同源（针孔投影 + 双线性采样）。

用法：
  # 只看某个方向
  python pano_crop.py --pano pano.png --yaw -90 --pitch 0 --fov 70 --out view.png
  # 叠加站位人形（u/v/相对高度按声明；浅灰 = 只标位置，不提供外观）
  python pano_crop.py --pano pano.png --yaw 0 --fov 70 --out marked.png \
      --silhouette 0.50,0.72,0.34 --label "here"
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

FILL = (176, 176, 176)
OUTLINE = (235, 235, 235)


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


def _sample_bilinear(image: np.ndarray, u: np.ndarray, v: np.ndarray) -> np.ndarray:
    h, w = image.shape[:2]
    u = np.mod(u, w)
    v = np.clip(v, 0, h - 1)
    u0 = np.floor(u).astype(np.int64)
    v0 = np.floor(v).astype(np.int64)
    u1 = (u0 + 1) % w
    v1 = np.clip(v0 + 1, 0, h - 1)
    du = (u - u0)[..., None]
    dv = (v - v0)[..., None]
    top = image[v0, u0] * (1.0 - du) + image[v0, u1] * du
    bottom = image[v1, u0] * (1.0 - du) + image[v1, u1] * du
    return top * (1.0 - dv) + bottom * dv


def equirectangular_to_perspective(
    pano: Image.Image, *, yaw_deg: float, pitch_deg: float, fov_deg: float, width: int, height: int
) -> Image.Image:
    src = np.asarray(pano.convert("RGB"), dtype=np.float32)
    src_h, src_w = src.shape[:2]

    aspect = width / height
    fov_y = math.radians(float(fov_deg))
    fov_x = 2.0 * math.atan(math.tan(fov_y / 2.0) * aspect)

    xs = (np.arange(width, dtype=np.float32) + 0.5) / width * 2.0 - 1.0
    ys = 1.0 - (np.arange(height, dtype=np.float32) + 0.5) / height * 2.0
    xx, yy = np.meshgrid(xs, ys)

    x = xx * math.tan(fov_x / 2.0)
    y = yy * math.tan(fov_y / 2.0)
    z = np.ones_like(x)
    norm = np.sqrt(x * x + y * y + z * z)
    x, y, z = x / norm, y / norm, z / norm

    pitch = math.radians(float(pitch_deg))
    cp, sp = math.cos(pitch), math.sin(pitch)
    y_pitch = y * cp - z * sp
    z_pitch = y * sp + z * cp

    yaw = math.radians(float(yaw_deg))
    cy, sy = math.cos(yaw), math.sin(yaw)
    x_world = x * cy + z_pitch * sy
    y_world = y_pitch
    z_world = -x * sy + z_pitch * cy

    lon = np.arctan2(x_world, z_world)
    lat = np.arcsin(np.clip(y_world, -1.0, 1.0))
    u = (lon / (2.0 * math.pi) + 0.5) * src_w
    v = (0.5 - lat / math.pi) * src_h

    sampled = _sample_bilinear(src, u, v)
    return Image.fromarray(np.clip(sampled, 0, 255).astype(np.uint8), mode="RGB")


def draw_silhouette(img: Image.Image, u: float, v: float, h_rel: float, label: str = "") -> Image.Image:
    """浅灰人形 + 目标框：只标"该站在画面哪里、多大"，不提供任何外观信息。"""
    W, H = img.size
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    bh = h_rel * H
    bw = bh * 0.38
    cx, cy = u * W, v * H
    x0, y0, x1, y1 = cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2

    # 目标框（细）
    d.rectangle([x0, y0, x1, y1], outline=OUTLINE + (150,), width=2)
    # 人形：头 + 躯干梯形 + 腿
    head_r = bw * 0.34
    d.ellipse([cx - head_r, y0, cx + head_r, y0 + head_r * 2], fill=FILL + (205,))
    torso_top = y0 + head_r * 2.1
    torso_bot = y0 + bh * 0.62
    d.polygon(
        [
            (cx - bw * 0.46, torso_bot),
            (cx - bw * 0.36, torso_top),
            (cx + bw * 0.36, torso_top),
            (cx + bw * 0.46, torso_bot),
        ],
        fill=FILL + (205,),
    )
    d.rectangle([cx - bw * 0.34, torso_bot, cx + bw * 0.34, y1], fill=FILL + (185,))

    if label:
        f = _font(max(14, W // 46))
        d.text((x0, max(0, y0 - f.size - 4)), label, fill=OUTLINE + (230,), font=f)

    return Image.alpha_composite(img.convert("RGBA"), layer).convert("RGB")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pano", required=True)
    ap.add_argument("--yaw", type=float, default=0.0)
    ap.add_argument("--pitch", type=float, default=0.0)
    ap.add_argument("--fov", type=float, default=70.0)
    ap.add_argument("--width", type=int, default=864)
    ap.add_argument("--height", type=int, default=1536)
    ap.add_argument("--silhouette", help="u,v,相对高度 例如 0.50,0.72,0.34")
    ap.add_argument("--label", default="")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    with Image.open(args.pano) as pano:
        rgb = pano.convert("RGB")
        if rgb.width < rgb.height * 1.8:
            print(json.dumps({"error": f"需要 2:1 全景，实际 {rgb.width}x{rgb.height}"}, ensure_ascii=False))
            return 2
        view = equirectangular_to_perspective(
            rgb,
            yaw_deg=args.yaw,
            pitch_deg=args.pitch,
            fov_deg=args.fov,
            width=args.width,
            height=args.height,
        )

    if args.silhouette:
        parts = [float(x) for x in str(args.silhouette).split(",")]
        if len(parts) != 3:
            print(json.dumps({"error": "--silhouette 需要 u,v,h 三个数"}, ensure_ascii=False))
            return 2
        view = draw_silhouette(view, parts[0], parts[1], parts[2], args.label)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    view.save(out, "PNG", optimize=True)
    print(json.dumps({"out": str(out), "yaw": args.yaw, "pitch": args.pitch, "fov": args.fov}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
