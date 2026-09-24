#!/usr/bin/env python3
"""视频层探针：逐帧检人 → 主体轨迹 + 背景稳定性 + 抽帧长条。

**补的正是试验箱此前缺的那一层**：前面所有实验量的都是"静态关键帧里人在哪"，
而业界点名的翻车（"走着走着背景突然变异"、落点不到、运动方向不连续）都发生在**运动过程**里。

指标：
  presence_rate  有多少采样帧里能检出人（漏人 → 空间失败）
  u_first/u_last/drift  主体横向位置的首末与净位移（该走动却没动 = 没走动）
  u_span         轨迹跨度（摆动过大 = 站不稳/乱飘）
  bg_change      **背景变化指数**：把主体框挖掉后，与首帧的灰度差中位数
                 （镜头固定时它应当很小；镜头没动而它很大 = 背景变异 ✗）
  strip          6 帧均匀抽样的长条图，供人眼判读

用法：
  python video_probe.py --video clip.mp4 --out-json m.json --out-strip strip.png [--weights ...]
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

GRID_W, GRID_H = 64, 36


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


def load_model(weights: str):
    try:
        from ultralytics import YOLO  # type: ignore
        return YOLO(weights)
    except Exception:
        return None


def detect_person_boxes(frame, model, conf=0.25):
    if model is None:
        return []
    res = model.predict(frame, conf=conf, verbose=False)
    boxes = []
    for r in res:
        if r.boxes is None:
            continue
        for b in r.boxes:
            if int(b.cls.item()) != 0:
                continue
            boxes.append([float(v) for v in b.xyxy[0].tolist()])
    return boxes


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--video", required=True)
    ap.add_argument("--weights", default="yolo11n.pt")
    ap.add_argument("--sample", type=int, default=5, help="每隔多少帧取一帧")
    ap.add_argument("--out-json")
    ap.add_argument("--out-strip")
    args = ap.parse_args()

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        print(json.dumps({"error": f"打不开视频 {args.video}"}, ensure_ascii=False))
        return 2
    fps = cap.get(cv2.CAP_PROP_FPS) or 0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)

    model = load_model(args.weights)
    samples = []
    idx = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if idx % max(1, args.sample) == 0:
            h, w = frame.shape[:2]
            boxes = detect_person_boxes(frame, model)
            best = None
            for x1, y1, x2, y2 in boxes:
                area = (x2 - x1) * (y2 - y1)
                if best is None or area > best["area"]:
                    best = {"box": [x1, y1, x2, y2], "area": area}
            gray = cv2.cvtColor(cv2.resize(frame, (GRID_W, GRID_H)), cv2.COLOR_BGR2GRAY).astype(np.float32)
            mask = np.zeros((GRID_H, GRID_W), dtype=bool)
            for x1, y1, x2, y2 in boxes:
                gx1 = max(0, int(x1 / w * GRID_W) - 1)
                gx2 = min(GRID_W, int(x2 / w * GRID_W) + 2)
                gy1 = max(0, int(y1 / h * GRID_H) - 1)
                gy2 = min(GRID_H, int(y2 / h * GRID_H) + 2)
                mask[gy1:gy2, gx1:gx2] = True
            samples.append(
                {
                    "frame": idx,
                    "t": round(idx / fps, 3) if fps else None,
                    "n_person": len(boxes),
                    "u": round(((best["box"][0] + best["box"][2]) / 2) / w, 4) if best else None,
                    "v": round(((best["box"][1] + best["box"][3]) / 2) / h, 4) if best else None,
                    "h": round((best["box"][3] - best["box"][1]) / h, 4) if best else None,
                    "gray": gray,
                    "mask": mask,
                    "boxes": boxes,
                }
            )
        idx += 1
    cap.release()

    n = len(samples)
    with_person = [s for s in samples if s["u"] is not None]
    us = [s["u"] for s in with_person]

    # 时间连续性：**相邻帧**差（不是与首帧比）—— 有镜头运动时，首帧差天然很大，
    # 只有相邻帧的**尖峰**才代表"跳变/变异"（模型把画面重画了）。
    jump_series = []
    for a, b in zip(samples, samples[1:]):
        jump_series.append(float(np.mean(np.abs(a["gray"] - b["gray"]))))
    # 主体屏幕位置跳变
    du_series = []
    for a, b in zip(samples, samples[1:]):
        if a["u"] is not None and b["u"] is not None:
            du_series.append(abs(b["u"] - a["u"]))
    pickj = lambda xs, q=None: (
        None if not xs else (round(float(np.percentile(xs, q)), 3) if q is not None else round(float(np.median(xs)), 3))
    )

    # 背景变化指数：挖掉所有主体框后，与首帧的灰度差
    # ⚠ 只用中位数会漏掉"取景漂移"（局部几何位移只影响少数像素）→ 同时报 p90 与均值
    bg_med, bg_p90, bg_mean = [], [], []
    ref = samples[0]["gray"] if n else None
    for s in samples[1:]:
        diff = np.abs(s["gray"] - ref)
        keep = ~(s["mask"] | samples[0]["mask"])
        if keep.sum() > 0:
            vals = diff[keep]
            bg_med.append(float(np.median(vals)))
            bg_p90.append(float(np.percentile(vals, 90)))
            bg_mean.append(float(vals.mean()))
    pick = lambda xs: round(float(np.median(xs)), 3) if xs else None

    result = {
        "video": str(args.video),
        "fps": round(fps, 2) if fps else None,
        "frames_total": total,
        "frames_sampled": n,
        "detector": "ultralytics" if model is not None else "unavailable",
        "presence_rate": round(len(with_person) / n, 4) if n else None,
        "u_first": us[0] if us else None,
        "u_last": us[-1] if us else None,
        "u_min": round(min(us), 4) if us else None,
        "u_max": round(max(us), 4) if us else None,
        "drift": round(us[-1] - us[0], 4) if len(us) >= 2 else None,
        "span": round(max(us) - min(us), 4) if us else None,
        "bg_change": pick(bg_med),
        "bg_change_p90": pick(bg_p90),
        "bg_change_mean": pick(bg_mean),
        "jump_median": pickj(jump_series),
        "jump_p90": pickj(jump_series, 90),
        "jump_max": round(max(jump_series), 3) if jump_series else None,
        "du_max": round(max(du_series), 4) if du_series else None,
        "jump_trace": [round(j, 2) for j in jump_series],
        "trace": [{"t": s["t"], "u": s["u"], "n": s["n_person"]} for s in samples],
    }

    # 抽帧长条（6 帧）
    if args.out_strip and n:
        picks = [samples[int(round(i * (n - 1) / 5))] for i in range(6)]
        cap = cv2.VideoCapture(args.video)
        tiles = []
        for p in picks:
            cap.set(cv2.CAP_PROP_POS_FRAMES, p["frame"])
            ok, frame = cap.read()
            if not ok:
                continue
            img = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
            d = ImageDraw.Draw(img)
            for x1, y1, x2, y2 in p["boxes"]:
                d.rectangle([x1, y1, x2, y2], outline="#ff4d4d", width=3)
            d.text((8, 8), f"t={p['t']}s n={p['n_person']} u={p['u']}", fill="#ffffff", font=_font(22))
            tiles.append(img)
        cap.release()
        if tiles:
            w, h = tiles[0].size
            scale = 520 / w
            tw, th = int(w * scale), int(h * scale)
            canvas = Image.new("RGB", (tw * 3 + 8, th * 2 + 6), "#101012")
            for i, t in enumerate(tiles[:6]):
                canvas.paste(t.resize((tw, th)), ((i % 3) * (tw + 4) + 2, (i // 3) * (th + 3) + 2))
            Path(args.out_strip).parent.mkdir(parents=True, exist_ok=True)
            canvas.save(args.out_strip, "PNG", optimize=True)

    for s in samples:
        s.pop("gray", None)
        s.pop("mask", None)

    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out_json:
        Path(args.out_json).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out_json).write_text(text + "\n", encoding="utf-8")
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
