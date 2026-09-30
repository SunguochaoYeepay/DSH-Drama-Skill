#!/usr/bin/env python3
"""主体存在性检查：这批图里到底有没有人、有几个人。

来历（lab/spatial 三轮实验逼出来的）：三种"祈祷式"手段全部失败——
线框示意图、真实空间照+人形标记、提示词强制声明（后者甚至让出人率从 83% 掉到 67%）。
所以"画里有没有人"只能**事后核查**，不能靠提示词祈祷。
检测器是否可用由每次运行结果决定；坏权重或缺依赖必须按不可判定处理。

用法：
  python presence.py --image a.png --image b.png [--weights ...] [--json]
  python presence.py --dir keyframes_render
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


def sharpness_for_crop(im, box):
    # 不依赖 OpenCV：灰度一阶差分的方差足以过滤明显运动模糊的远景路人。
    x1, y1, x2, y2 = [max(0, int(v)) for v in box]
    crop = im.crop((x1, y1, x2, y2)).convert("L")
    if crop.width < 3 or crop.height < 3:
        return 0.0
    px = list(crop.getdata())
    diffs = []
    w, h = crop.size
    for y in range(h):
        row = y * w
        for x in range(w - 1):
            diffs.append(px[row + x + 1] - px[row + x])
    if not diffs:
        return 0.0
    mean = sum(diffs) / len(diffs)
    return sum((d - mean) ** 2 for d in diffs) / len(diffs)


def check_one(path: Path, weights: str, conf: float, min_sharpness: float) -> dict:
    try:
        with Image.open(path) as im:
            w, h = im.size
            image = im.copy()
    except Exception as exc:
        return {"image": str(path), "n_person": None, "present": None, "error": f"打不开图: {exc}"}
    boxes, err = detect(path, weights, conf)
    if boxes is None:
        return {"image": str(path), "n_person": None, "present": None, "error": err}
    biggest = 0.0
    sharpness = []
    for x1, y1, x2, y2 in boxes:
        biggest = max(biggest, (y2 - y1) / h)
        sharpness.append(round(sharpness_for_crop(image, (x1, y1, x2, y2)), 1))
    effective = sum(v >= min_sharpness for v in sharpness) if min_sharpness > 0 else len(boxes)
    return {
        "image": str(path),
        "n_person": len(boxes),
        "n_person_effective": effective,
        "sharpness": sharpness,
        "min_sharpness": min_sharpness,
        "present": len(boxes) > 0,
        "largest_height_ratio": round(biggest, 4),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--image", action="append", default=[])
    ap.add_argument("--dir", action="append", default=[])
    ap.add_argument("--pattern", default="*.png")
    ap.add_argument("--weights", default="yolo11n.pt")
    ap.add_argument("--conf", type=float, default=0.25)
    ap.add_argument("--min-sharpness", type=float, default=0.0)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    targets: list[Path] = [Path(p) for p in args.image]
    for d in args.dir:
        targets += sorted(Path(d).rglob(args.pattern))
    if not targets:
        print(json.dumps({"error": "没有输入（--image 或 --dir）"}, ensure_ascii=False))
        return 2

    results = [check_one(p, args.weights, args.conf, args.min_sharpness) for p in targets]
    ok = [r for r in results if r.get("present") is not None]
    missing = [r["image"] for r in ok if not r["present"]]
    summary = {
        "checked": len(results),
        "detector_ok": len(ok),
        "missing_subject": missing,
        "present_rate": round(sum(1 for r in ok if r["present"]) / len(ok), 4) if ok else None,
    }
    payload = {"summary": summary, "results": results}
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        for r in results:
            flag = "OK  " if r.get("present") else ("MISS" if r.get("present") is False else "??  ")
            print(f"{flag} n={r.get('n_person')} 最大主体高占比={r.get('largest_height_ratio')} {r['image']}")
        print(json.dumps(summary, ensure_ascii=False))
    # 有图里没人 → 非零退出，方便当闸门用
    return 1 if missing else 0


if __name__ == "__main__":
    raise SystemExit(main())
