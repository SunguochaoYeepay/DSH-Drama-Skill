#!/usr/bin/env python
"""按采样帧跟踪"画面里最大的那个人"，输出归一化 u/v/h 轨迹（CPU 推理）。

存在的理由：`py/video_probe.py` 只记 u，不记 v/h 和各帧人数，所以"推镜（人变大）"这类
镜头运动没法用它的数看出来。这个脚本不替代它，只补 h/v 这一列，口径同样是 COCO cls==0。

用法：
    python trace-person.py --video <mp4> --out-json <json> [--sample 6] [--weights yolo11n.pt]
失败即 detector="unavailable" + error，不猜坐标。
"""
import argparse
import json
import sys

import cv2


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--video', required=True)
    ap.add_argument('--out-json', required=True)
    ap.add_argument('--sample', type=int, default=6, help='采样帧数')
    ap.add_argument('--weights', default='yolo11n.pt')
    ap.add_argument('--conf', type=float, default=0.25)
    ap.add_argument('--device', default='cpu')
    args = ap.parse_args()

    out = {
        'video': args.video,
        'detector': 'unavailable',
        'error': None,
        'samples': [],
    }

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        out['error'] = 'cannot open video'
        json.dump(out, open(args.out_json, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
        return 2
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 0)
    out['frames_total'] = total
    out['fps'] = round(fps, 3)

    try:
        from ultralytics import YOLO

        model = YOLO(args.weights)
    except Exception as exc:  # 权重损坏 / 没装 ultralytics —— 都不算通过
        out['error'] = f'{type(exc).__name__}: {exc}'
        json.dump(out, open(args.out_json, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
        return 2

    n = max(1, args.sample)
    idxs = [int(round(i * (total - 1) / (n - 1))) for i in range(n)] if total > 1 else [0]
    for i in idxs:
        cap.set(cv2.CAP_PROP_POS_FRAMES, i)
        ok, frame = cap.read()
        if not ok:
            continue
        h_px, w_px = frame.shape[:2]
        res = model.predict(frame, conf=args.conf, device=args.device, verbose=False)[0]
        boxes = []
        for b in res.boxes:
            if int(b.cls) != 0:  # person
                continue
            x1, y1, x2, y2 = [float(v) for v in b.xyxy[0]]
            boxes.append(((x2 - x1) * (y2 - y1) / (w_px * h_px), x1, y1, x2, y2, float(b.conf)))
        # boxes 元素：(area_ratio, x1, y1, x2, y2, conf)
        boxes.sort(key=lambda b: -b[0])
        top = boxes[0] if boxes else None
        out['samples'].append({
            'frame': i,
            't': round(i / fps, 3) if fps else None,
            'n_person': len(boxes),
            'present': top is not None,
            'u': round(((top[1] + top[3]) / 2) / w_px, 4) if top else None,
            'v': round(((top[2] + top[4]) / 2) / h_px, 4) if top else None,
            'h': round((top[4] - top[2]) / h_px, 4) if top else None,
            'area': round(top[0], 4) if top else None,
            'conf': round(top[5], 3) if top else None,
        })
    cap.release()

    out['detector'] = 'ultralytics'
    with open(args.out_json, 'w', encoding='utf-8') as fh:
        json.dump(out, fh, ensure_ascii=False, indent=2)
    first = next((s for s in out['samples'] if s['present']), None)
    last = next((s for s in reversed(out['samples']) if s['present']), None)
    if first and last:
        print(f"  {args.video}: u {first['u']}→{last['u']}  h {first['h']}→{last['h']}  "
              f"n={[s['n_person'] for s in out['samples']]}")
    else:
        print(f"  {args.video}: 没有检出人（samples={len(out['samples'])}）")
    return 0


if __name__ == '__main__':
    sys.exit(main())
