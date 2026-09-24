#!/usr/bin/env python3
"""量一张生成图里"谁在画面哪里、谁在前" —— 与 scene.json 的声明比对。

用 ComfyUI 自带 python 里的 ultralytics 做人体检测（已确认安装）。
检测不可用时**不猜**：写 detector="unavailable"，只画目标框与网格，交人眼判读。

度量口径（诚实说明）：
  du / dv  = 检出框中心与声明 (u, v) 的归一化偏移
  du 是主指标；**dv 次之且更噪** —— 框中心取决于入画了多少身体（半身/全身不同）
  order_ok = 按框高（越大越近）推出的前后序，是否与声明的 near/mid/far 完全一致

用法：
  python measure.py --image out.png --targets targets.json --out-png ann.png --out-json m.json
  python measure.py --image x.png --targets t.json --boxes "[[10,20,110,320]]"   # 注入框，离线自检用
"""

from __future__ import annotations

import argparse
import itertools
import json
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

DEPTH_RANK = {"near": 3, "mid": 2, "far": 1}
GRID = "#3a3a3d"
T_COL = "#4aa3ff"
D_COL = "#ff4d4d"
TEXT = "#ffffff"


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


def detect_persons(image_path: Path, weights: str, conf: float):
    """返回 ([x1,y1,x2,y2]...], detector_name, error)。任何失败都降级，不抛。"""
    try:
        from ultralytics import YOLO  # type: ignore
    except Exception as exc:  # pragma: no cover - 环境相关
        return [], "unavailable", f"import ultralytics 失败: {exc}"
    try:
        model = YOLO(weights)
        res = model.predict(str(image_path), conf=conf, verbose=False)
        boxes = []
        for r in res:
            if r.boxes is None:
                continue
            for b in r.boxes:
                cls = int(b.cls.item()) if b.cls is not None else -1
                if cls != 0:  # COCO: 0 = person
                    continue
                x1, y1, x2, y2 = [float(v) for v in b.xyxy[0].tolist()]
                boxes.append([x1, y1, x2, y2])
        return boxes, f"ultralytics:{weights}", None
    except Exception as exc:
        return [], "unavailable", f"检测失败: {exc}"


def to_norm(box, w, h):
    x1, y1, x2, y2 = box
    return {
        "u": (x1 + x2) / 2 / w,
        "v": (y1 + y2) / 2 / h,
        "h": (y2 - y1) / h,
        "bottom": y2 / h,
        "box": [x1, y1, x2, y2],
    }


def assign(targets, dets):
    """在「目标子集 × 检出排列」上穷举最小化 sum|du|（主体数 ≤6，直接暴力，比贪心稳）。

    同时给出 **margin**（最优 vs 次优的代价差）。margin 小 = 这次匹配不唯一，
    意味着"谁是谁"被模型重排了 —— 此时**不该拿 per-subject du 下结论**。
    """
    n = min(len(targets), len(dets))
    if n == 0:
        return [], list(range(len(targets))), list(range(len(dets))), 0.0
    scored = []
    for tsub in itertools.combinations(range(len(targets)), n):
        for dperm in itertools.permutations(range(len(dets)), n):
            cost = sum(abs(dets[dperm[k]]["u"] - targets[tsub[k]]["u"]) for k in range(n))
            scored.append((cost, list(zip(tsub, dperm))))
    scored.sort(key=lambda x: x[0])
    best_cost, best = scored[0]
    second = scored[1][0] if len(scored) > 1 else math.inf
    margin = 1.0 if second == math.inf else (second - best_cost)
    used_t = {i for i, _ in best}
    used_d = {j for _, j in best}
    return best, [i for i in range(len(targets)) if i not in used_t], [j for j in range(len(dets)) if j not in used_d], round(margin, 4)


def set_position_error(targets, dets):
    """**不看身份**：把声明的 u 与检出的 u 各自排序后单调配对。

    回答的是"该有人的那些 x 位置上，是否真有人"——这是最不该被身份串位污染的指标，
    也是本试验箱的**主指标**（per-subject du 降为参考）。
    """
    tu = sorted(t["u"] for t in targets)
    n = min(len(tu), len(dets))
    if n == 0:
        return None
    best = math.inf
    for combo in itertools.combinations(range(len(dets)), n):
        du = sorted(dets[j]["u"] for j in combo)
        cost = sum(abs(du[k] - tu[k]) for k in range(n)) / n
        best = min(best, cost)
    return round(best, 4)


def evaluate(targets, dets, w, h):
    norm = [to_norm(b, w, h) for b in dets]
    pairs, unmatched_t, unmatched_d, margin = assign(targets["subjects"], norm)

    matched = []
    for ti, di in pairs:
        t, dt = targets["subjects"][ti], norm[di]
        matched.append(
            {
                "id": t["id"],
                "target_u": t["u"],
                "target_v": t["v"],
                "depth": t.get("depth"),
                "u": round(dt["u"], 4),
                "v": round(dt["v"], 4),
                "h": round(dt["h"], 4),
                "du": round(dt["u"] - t["u"], 4),
                "dv": round(dt["v"] - t["v"], 4),
                "box_px": [round(float(v), 1) for v in dt["box"]],
            }
        )

    # 前后序：按框高降序 = 由近到远
    violations = []
    by_h = sorted(matched, key=lambda m: -m["h"])
    for a, b in itertools.combinations(by_h, 2):
        if DEPTH_RANK.get(a["depth"], 2) < DEPTH_RANK.get(b["depth"], 2):
            violations.append(f"{a['id']}({a['depth']}) 比 {b['id']}({b['depth']}) 更靠前")

    dus = [abs(m["du"]) for m in matched]
    return {
        "matched": matched,
        "unmatched_targets": [targets["subjects"][i]["id"] for i in unmatched_t],
        "unmatched_detections": unmatched_d,
        "n_extra": len(unmatched_d),
        # 主指标：不看身份的位置集合误差
        "set_mean_abs_du": set_position_error(targets["subjects"], norm),
        # 参考指标：per-subject du（身份串位时会误导，看 ambiguous）
        "mean_abs_du": round(sum(dus) / len(dus), 4) if dus else None,
        "max_abs_du": round(max(dus), 4) if dus else None,
        "match_margin": margin,
        "ambiguous": margin < 0.02,
        "order_ok": (len(violations) == 0) if len(matched) >= 2 else None,
        "order_violations": violations,
    }


def annotate(image_path: Path, targets, result, out_png: Path, detector: str):
    img = Image.open(image_path).convert("RGB")
    w, h = img.size
    d = ImageDraw.Draw(img)
    f = _font(max(14, w // 52))

    for i in (1, 2):
        d.line([(w * i / 3, 0), (w * i / 3, h)], fill=GRID, width=1)
        d.line([(0, h * i / 3), (w, h * i / 3)], fill=GRID, width=1)

    for s in targets["subjects"]:
        cx, cy = s["u"] * w, s["v"] * h
        arm = w * 0.05
        d.line([(cx - arm, cy), (cx + arm, cy)], fill=T_COL, width=2)
        d.line([(cx, cy - arm), (cx, cy + arm)], fill=T_COL, width=2)
        d.text((cx + 6, cy - f.size - 6), f"{s['id']} target", fill=T_COL, font=f)

    for m in result["matched"]:
        x1, y1, x2, y2 = m["box_px"]
        d.rectangle([x1, y1, x2, y2], outline=D_COL, width=3)
        d.text((x1, max(0, y1 - f.size - 4)), f"{m['id']} du={m['du']:+.2f}", fill=D_COL, font=f)

    if result["mean_abs_du"] is None:
        d.text((8, 8), f"NO MATCH  detector={detector}", fill=D_COL, font=f)
    else:
        d.text(
            (8, 8),
            f"set|du|={result['set_mean_abs_du']}  mean|du|={result['mean_abs_du']:.3f}"
            f"  order_ok={result['order_ok']}  amb={result['ambiguous']}  extra={result['n_extra']}",
            fill=TEXT,
            font=f,
        )
    out_png.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_png, "PNG", optimize=True)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--image", required=True)
    ap.add_argument("--targets", required=True)
    ap.add_argument("--out-png")
    ap.add_argument("--out-json")
    ap.add_argument("--boxes", help="注入检出框（像素坐标）JSON，跳过检测；离线自检用")
    ap.add_argument("--no-detect", action="store_true")
    ap.add_argument("--weights", default="yolo11n.pt")
    ap.add_argument("--conf", type=float, default=0.25)
    args = ap.parse_args()

    image_path = Path(args.image)
    targets = json.loads(Path(args.targets).read_text(encoding="utf-8"))
    img = Image.open(image_path)
    w, h = img.size
    img.close()

    if args.boxes:
        dets, detector, err = json.loads(args.boxes), "injected", None
    elif args.no_detect:
        dets, detector, err = [], "disabled", None
    else:
        dets, detector, err = detect_persons(image_path, args.weights, args.conf)

    result = evaluate(targets, dets, w, h)
    result["detector"] = detector
    result["detector_error"] = err
    result["n_detected"] = len(dets)
    result["image"] = str(image_path)
    result["shot"] = targets.get("shot")

    # 标注用的框就在 matched[].box_px 里，不再另存一份
    if args.out_png:
        annotate(image_path, targets, result, Path(args.out_png), detector)

    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out_json:
        Path(args.out_json).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out_json).write_text(text + "\n", encoding="utf-8")
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
