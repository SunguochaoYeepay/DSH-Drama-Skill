#!/usr/bin/env python3
"""用白膜声明的 RGB 身份色，测量生成视频里的刚体主体轨迹。"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np


def rgb_to_hsv(rgb):
    values = [x * 255 if 0 <= x <= 1 else x for x in rgb]
    pixel = np.uint8([[values]])
    return cv2.cvtColor(pixel, cv2.COLOR_RGB2HSV)[0, 0]


def color_mask(hsv, rgb):
    target = rgb_to_hsv(rgb)
    hue, sat, val = [int(x) for x in target]
    # 白膜身份色是高饱和色；H3 可能改变亮度和色相，因此给色相留出余量。
    sat_floor = max(55, sat // 3)
    val_floor = 35
    if hue < 15 or hue > 165:
        hue_mask = (hsv[:, :, 0] >= max(0, hue - 18)) | (hsv[:, :, 0] <= min(179, hue + 18))
    else:
        hue_mask = np.abs(hsv[:, :, 0].astype(np.int16) - hue) <= 18
    return (hue_mask & (hsv[:, :, 1] >= sat_floor) & (hsv[:, :, 2] >= val_floor)).astype(np.uint8) * 255


def candidates(mask):
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    n, labels, stats, cents = cv2.connectedComponentsWithStats(mask, 8)
    out = []
    for i in range(1, n):
        area = int(stats[i, cv2.CC_STAT_AREA])
        if area < 3:
            continue
        x, y, w, h = [int(stats[i, k]) for k in range(4)]
        out.append({"area": area, "u": float(cents[i][0]), "v": float(cents[i][1]), "box": [x, y, x + w, y + h]})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--coords", required=True)
    ap.add_argument("--plan", required=True, help="spatial-plan/1 JSON，提供主体 RGB 身份色")
    ap.add_argument("--out-json", required=True)
    ap.add_argument("--sample", type=int, default=5)
    args = ap.parse_args()

    coords = json.loads(Path(args.coords).read_text(encoding="utf-8"))
    plan = json.loads(Path(args.plan).read_text(encoding="utf-8"))
    frame_map = coords["frames"]
    first = frame_map[next(iter(frame_map))]
    colors = {e["id"]: e["color"] for e in plan.get("entities", []) if e.get("color")}
    subjects = {k: {**v, "color": colors[k]} for k, v in first.items() if v.get("world_position") and k in colors}
    if not subjects:
        raise SystemExit("coords.json 没有带 color 的刚体主体")

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        raise SystemExit(f"打不开视频: {args.video}")
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 0)
    wb_total = max(int(k) for k in frame_map)
    traces = {sid: [] for sid in subjects}
    idx = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if idx % max(1, args.sample) == 0:
            h, w = frame.shape[:2]
            hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
            wb_frame = str(round(1 + idx * (wb_total - 1) / max(1, total - 1)))
            expected = frame_map[wb_frame]
            for sid, item in subjects.items():
                target = expected[sid]["root"]
                target_px = np.array([target[0] * w, target[1] * h])
                comps = candidates(color_mask(hsv, item["color"]))
                if comps:
                    chosen = min(comps, key=lambda c: float(np.linalg.norm(np.array([c["u"], c["v"]]) - target_px)))
                    traces[sid].append({"frame": idx + 1, "whitebox_frame": int(wb_frame), "u": round(chosen["u"] / w, 4), "v": round(chosen["v"] / h, 4), "target_u": target[0], "target_v": target[1], "area": chosen["area"]})
        idx += 1
    cap.release()

    summary = {}
    for sid, rows in traces.items():
        if not rows:
            summary[sid] = {"presence_rate": 0, "samples": 0}
            continue
        du = [abs(r["u"] - r["target_u"]) for r in rows]
        summary[sid] = {
            "presence_rate": round(len(rows) / max(1, (total + args.sample - 1) // args.sample), 4),
            "samples": len(rows),
            "u_first": rows[0]["u"], "u_last": rows[-1]["u"],
            "v_first": rows[0]["v"], "v_last": rows[-1]["v"],
            "screen_du": round(rows[-1]["u"] - rows[0]["u"], 4),
            "screen_dv": round(rows[-1]["v"] - rows[0]["v"], 4),
            "mean_abs_du": round(float(np.mean(du)), 4),
            "max_abs_du": round(float(np.max(du)), 4),
        }

    result = {"video": str(args.video), "fps": fps, "frames": total, "sample": args.sample, "subjects": summary, "trace": traces}
    Path(args.out_json).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out_json).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"video": args.video, "fps": fps, "frames": total, "subjects": summary}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
