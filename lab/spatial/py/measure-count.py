#!/usr/bin/env python
"""实验一/实验四的轻量度量：数人、数桌、取归一化位置。

与 lab 其它度量脚本同一条纪律：**检测器不可用时不猜**，写 detector="unavailable"。

只用 COCO 类别：0 = person，60 = dining table。
输出：image / width / height / detector / error / n_person / n_table / persons[] / tables[]
其中 u 是归一化横坐标（0=画面左），v 是归一化纵坐标（0=画面顶），h 是框高占比。

用法：
  python lab/spatial/py/measure-count.py --image x.png --weights .tmp/spatial-lab/weights/yolo11n.pt --out-json x.json
"""

import argparse
import json
import sys
from pathlib import Path

PERSON = 0
DINING_TABLE = 60


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", required=True)
    ap.add_argument("--weights", default="yolo11n.pt")
    ap.add_argument("--conf", type=float, default=0.25)
    ap.add_argument("--device", default="cpu", help="推理设备；默认 cpu，避免与 ComfyUI 抢 GPU")
    ap.add_argument("--sharpness", action="store_true", help="给每个框加 lap 清晰度（Laplacian 方差），用于区分主体与运动模糊的路人")
    ap.add_argument("--out-json")
    args = ap.parse_args()

    out = {
        "image": str(args.image),
        "detector": "unavailable",
        "error": None,
        "width": None,
        "height": None,
        "n_person": None,
        "n_table": None,
        "persons": [],
        "tables": [],
    }

    try:
        from ultralytics import YOLO

        model = YOLO(args.weights)
        res = model(str(args.image), conf=args.conf, device=args.device, verbose=False)[0]
        h, w = res.orig_shape
        gray = None
        if args.sharpness:
            import cv2

            gray = cv2.cvtColor(
                cv2.imread(str(args.image)), cv2.COLOR_BGR2GRAY
            )
        persons, tables = [], []
        for box in res.boxes:
            cls = int(box.cls.item())
            if cls not in (PERSON, DINING_TABLE):
                continue
            x0, y0, x1, y1 = [float(v) for v in box.xyxy[0].tolist()]
            item = {
                "u": round(((x0 + x1) / 2.0) / w, 4),
                "v": round(((y0 + y1) / 2.0) / h, 4),
                "h": round((y1 - y0) / h, 4),
                "conf": round(float(box.conf.item()), 3),
                "box": [round(x0), round(y0), round(x1), round(y1)],
            }
            if gray is not None:
                import cv2

                crop = gray[
                    max(0, int(y0)) : max(1, int(y1)), max(0, int(x0)) : max(1, int(x1))
                ]
                item["lap"] = round(float(cv2.Laplacian(crop, cv2.CV_64F).var()), 1) if crop.size else None
            (persons if cls == PERSON else tables).append(item)

        # YOLO 会在同一个人身上吐出互相重叠的框（站姿/半身+全身），若直接数 len(persons)
        # 会把一个人算成两三个，把"多余主体数量"这条指标撑大。这里按 IoU≥0.5 合并同类框，
        # 保留 conf 最高的那个，并同时保留原始框数 n_person_raw 以便对照。
        def _iou(a, b):
            ax0, ay0, ax1, ay1 = a["box"]
            bx0, by0, bx1, by1 = b["box"]
            ix0, iy0 = max(ax0, bx0), max(ay0, by0)
            ix1, iy1 = min(ax1, bx1), min(ay1, by1)
            if ix1 <= ix0 or iy1 <= iy0:
                return 0.0
            inter = (ix1 - ix0) * (iy1 - iy0)
            area_a = (ax1 - ax0) * (ay1 - ay0)
            area_b = (bx1 - bx0) * (by1 - by0)
            union = area_a + area_b - inter
            return inter / union if union > 0 else 0.0

        def _dedup(items, iou_max=0.5):
            kept = []
            for it in sorted(items, key=lambda x: -x["conf"]):
                if any(_iou(it, k) >= iou_max for k in kept):
                    continue
                kept.append(it)
            return kept

        n_person_raw = len(persons)
        n_table_raw = len(tables)
        persons = _dedup(persons)
        tables = _dedup(tables, 0.3)
        persons.sort(key=lambda p: p["u"])
        tables.sort(key=lambda t: t["u"])
        out.update(
            detector="ultralytics",
            width=w,
            height=h,
            n_person=len(persons),
            n_person_raw=n_person_raw,
            n_table=len(tables),
            n_table_raw=n_table_raw,
            persons=persons,
            tables=tables,
        )
    except Exception as exc:  # noqa: BLE001 - 检测器不可用是结论，不是崩溃
        out["error"] = f"{type(exc).__name__}: {exc}"

    if args.out_json:
        Path(args.out_json).write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")

    print(
        json.dumps(
            {
                "image": Path(args.image).name,
                "detector": out["detector"],
                "n_person": out["n_person"],
                "n_table": out["n_table"],
                "persons_u": [p["u"] for p in out["persons"]],
                "tables_u": [t["u"] for t in out["tables"]],
                "error": out["error"],
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
