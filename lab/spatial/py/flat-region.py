#!/usr/bin/env python
"""flat-region.py —— "白膜替身被画进成片"的机器判据。

为什么需要它：把白膜静帧当参考图交给图生图时，模型可能把**白膜的人偶本体**当成画面内容
一起画出来（橙/蓝平涂身体）。这时"人物位置误差 du"会被自己的参考图骗过 —— 检测器检到的
"人"就是那些人偶，数字反而更好看。肉眼能看出来，但实验要求"不只凭观感"，所以这里给一条
可复现的数字判据。

原理：白膜是 EEVEE 单色材质渲染，替身身体是**大片同色、几乎无光照梯度**的平涂色块；
photoreal 成片里皮肤/衣服/背景都有梯度和纹理。于是：
  1. 从白膜静帧里抽出"高饱和 + 大占比"的平涂材质色（最多 3 个）作为调色板；
  2. 在待判图里数"颜色接近调色板 **且** 局部梯度很小"的像素占比 match_frac；
  3. 另报最大的平涂连通域占比 flat_frac（不依赖调色板的通用"渲染感"指标）。

用法：
  python flat-region.py --reference <白膜静帧> --image <待判图> --out-json <json>
输出（失败写 detector="unavailable" + error，exit 2，不猜）：
  {detector, reference, image, width, height, palette:[{rgb, frac_ref}],
   match_frac, flat_frac, verdict}
"""
import argparse
import json
import sys

try:
    import cv2
    import numpy as np
except Exception as exc:  # pragma: no cover
    print(json.dumps({"detector": "unavailable", "error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False))
    sys.exit(2)


def palette_from(reference_bgr, max_colors=3, min_share=0.004):
    """从白膜静帧里抽平涂材质色：高饱和、量化后占比够大的颜色。"""
    hsv = cv2.cvtColor(reference_bgr, cv2.COLOR_BGR2HSV)
    sat = hsv[:, :, 1].astype(np.int16)
    val = hsv[:, :, 2].astype(np.int16)
    mask = (sat > 90) & (val > 50)
    total = reference_bgr.shape[0] * reference_bgr.shape[1]
    if mask.sum() < total * 0.002:
        return []
    pixels = reference_bgr[mask].astype(np.int16)
    quant = (pixels // 16) * 16  # 16 级粗量化，把光照造成的轻微渐变并到一档
    keys, counts = np.unique(quant.reshape(-1, 3), axis=0, return_counts=True)
    order = np.argsort(-counts)
    out = []
    for i in order[: max_colors * 4]:
        rgb_key = keys[i]
        share = counts[i] / mask.sum()
        if share < min_share:
            continue
        # 合并相近颜色（同一材质被光照分成两档）
        if any(np.abs(rgb_key - np.array(o["rgb16"])).max() <= 16 for o in out):
            continue
        sel = np.all(np.abs(quant - rgb_key) <= 8, axis=1)
        mean_bgr = pixels[sel].mean(axis=0)
        out.append({"rgb16": rgb_key.tolist(), "rgb": [int(x) for x in mean_bgr[::-1]], "frac_ref": round(float(share), 4)})
        if len(out) >= max_colors:
            break
    return out


def largest_flat_component(bgr, grad_max=10.0):
    """最大的"局部梯度很小"的连通域占比 —— 通用渲染感指标。"""
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    mag = cv2.magnitude(gx, gy)
    flat = (mag < grad_max).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(flat, connectivity=8)
    if n <= 1:
        return 0.0
    areas = stats[1:, cv2.CC_STAT_AREA]
    biggest = int(areas.max())
    return round(biggest / (bgr.shape[0] * bgr.shape[1]), 4)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reference", required=True, help="白膜静帧（抽调色板用）")
    ap.add_argument("--image", required=True, help="待判的生成图")
    ap.add_argument("--tolerance", type=float, default=40.0, help="颜色距离容差（RGB 欧氏）")
    ap.add_argument("--flat-grad", type=float, default=10.0, help="判为'平'的梯度上限")
    ap.add_argument("--min-sat", type=int, default=90, help="待判图里也算数的饱和度下限（与抽色板同门槛）")
    ap.add_argument("--out-json")
    args = ap.parse_args()

    ref = cv2.imread(args.reference, cv2.IMREAD_COLOR)
    img = cv2.imread(args.image, cv2.IMREAD_COLOR)
    if ref is None:
        print(json.dumps({"detector": "unavailable", "error": f"读不到参考图 {args.reference}"}, ensure_ascii=False))
        sys.exit(2)
    if img is None:
        print(json.dumps({"detector": "unavailable", "error": f"读不到待判图 {args.image}"}, ensure_ascii=False))
        sys.exit(2)

    palette = palette_from(ref)
    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    flat = cv2.magnitude(gx, gy) < args.flat_grad
    # 只用白膜材质色本身的高饱和像素：暖色木地板/灯光反光也接近橙色，不拦会误报
    # （text-only t3 实测被木地板撑到 2.19%）。参考图抽色板时用的也是同一条饱和度门槛。
    img_hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    saturated = img_hsv[:, :, 1].astype(np.int16) > args.min_sat

    match = np.zeros((h, w), dtype=bool)
    img_rgb = img[:, :, ::-1].astype(np.float32)
    per_color = []
    for p in palette:
        color = np.array(p["rgb"], dtype=np.float32)
        dist = np.sqrt(((img_rgb - color) ** 2).sum(axis=2))
        hit = (dist < args.tolerance) & flat & saturated
        match |= hit
        per_color.append({"rgb": p["rgb"], "frac": round(float(hit.sum()) / (h * w), 4)})

    # 复刻是"一整块人偶身体"，不是散落的橙色灯光/蓝色椅子 —— 所以判据用最大连通域，
    # 而不是全部命中像素之和（后者会被画面里零散的同色调物件撑大）。
    match_u8 = match.astype(np.uint8)
    n_lab, _labels, match_stats, _c = cv2.connectedComponentsWithStats(match_u8, connectivity=8)
    match_blob = 0.0
    match_blob_xy = None
    if n_lab > 1:
        areas = match_stats[1:, cv2.CC_STAT_AREA]
        idx = int(areas.argmax())
        match_blob = round(float(areas[idx]) / (h * w), 4)
        if areas[idx] > 0:
            match_blob_xy = [int(match_stats[idx + 1, cv2.CC_STAT_LEFT]), int(match_stats[idx + 1, cv2.CC_STAT_TOP])]

    match_frac = round(float(match.sum()) / (h * w), 4)
    flat_frac = largest_flat_component(img, args.flat_grad)
    # 判据用"高饱和 + 平涂 + 贴白膜材质色"的像素占比：连通域判据实测更差（成片里人偶被
    # 打上光照后自身就有梯度，连通域会碎成小块），故只把 blob 当参考数字一起报出来。
    verdict = "白膜替身被复刻" if match_frac >= 0.006 else ("可疑" if match_frac >= 0.002 else "没有明显复刻")
    out = {
        "detector": "cv2",
        "reference": args.reference,
        "image": args.image,
        "width": int(w), "height": int(h),
        "palette": palette,
        "per_color": per_color,
        "match_frac": match_frac,
        "match_blob_frac": match_blob,
        "match_blob_xy": match_blob_xy,
        "flat_frac": flat_frac,
        "verdict": verdict,
    }
    text = json.dumps(out, ensure_ascii=False, indent=2)
    if args.out_json:
        with open(args.out_json, "w", encoding="utf-8") as fh:
            fh.write(text)
    print(text)


if __name__ == "__main__":
    main()
