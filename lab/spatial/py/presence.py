#!/usr/bin/env python3
"""主体存在性检查：一张图里到底有没有人（不看位置、不看身份）。

这是三轮实验逼出来的那个真正有用的东西：**三种"祈祷式"手段（线框示意图 / 人形标记 / 强制声明）
都在"漏人"上失败甚至更糟**，所以处置要挪到核查侧——生成后判"画里有没有主体"，没有就挡回重抽。

用法：
  python presence.py --image x.png [--weights ...] [--json]
  python presence.py --dir some/dir --pattern *.png
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from PIL import Image


def detect(image_path: Path, weights: str, conf: float):
    try:
        from ultralytics import YOLO  # type: ignore
    except Exception as exc:
        return None, f"import ultralytics 失败: {exc}"
    try:
        model = YOLO(weights)
        res = model.predict(str(image_path), conf=conf, verbose=False)
        boxes = []
        for r in res:
            if r.boxes is None:
                continue
            for b in r.boxes:
                if int(b.cls.item()) != 0:  # COCO 0 = person
                    continue
                x1, y1, x2, y2 = [float(v) for v in b.xyxy[0].tolist()]
                boxes.append([round(v, 1) for v in (x1, y1, x2, y2)])
        return boxes, None
    except Exception as exc:
        return None, f"检测失败: {exc}"


def check_one(path: Path, weights: str, conf: float) -> dict:
    with Image.open(path) as im:
        w, h = im.size
    boxes, err = detect(path, weights, conf)
    if boxes is None:
        return {"image": str(path), "detector": "unavailable", "error": err, "n_person": None, "present": None}
    best = None
    for x1, y1, x2, y2 in boxes:
        area = (x2 - x1) * (y2 - y1) / (w * h)
        if best is None or area > best["area_ratio"]:
            best = {
                "box": [x1, y1, x2, y2],
                "area_ratio": round(area, 4),
                "height_ratio": round((y2 - y1) / h, 4),
            }
    return {
        "image": str(path),
        "size": [w, h],
        "detector": "ultralytics",
        "n_person": len(boxes),
        "present": len(boxes) > 0,
        "largest": best,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--image", action="append", default=[])
    ap.add_argument("--dir", action="append", default=[])
    ap.add_argument("--pattern", default="*.png")
    ap.add_argument("--weights", default="yolo11n.pt")
    ap.add_argument("--conf", type=float, default=0.25)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    targets: list[Path] = [Path(p) for p in args.image]
    for d in args.dir:
        targets += sorted(Path(d).rglob(args.pattern))
    if not targets:
        print(json.dumps({"error": "没有输入（--image 或 --dir）"}, ensure_ascii=False))
        return 2

    results = [check_one(p, args.weights, args.conf) for p in targets]
    ok = [r for r in results if r.get("present") is not None]
    summary = {
        "checked": len(results),
        "detector_ok": len(ok),
        "missing_subject": [r["image"] for r in ok if not r["present"]],
        "present_rate": round(sum(1 for r in ok if r["present"]) / len(ok), 4) if ok else None,
    }
    payload = {"summary": summary, "results": results}
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        for r in results:
            flag = "OK  " if r.get("present") else ("MISS" if r.get("present") is False else "??  ")
            n = r.get("n_person")
            big = (r.get("largest") or {}).get("height_ratio")
            print(f"{flag} n={n} h={big} {r['image']}")
        print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
