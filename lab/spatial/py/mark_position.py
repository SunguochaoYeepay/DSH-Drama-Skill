#!/usr/bin/env python3
"""在一张真实空间照上叠加"站位人形标记" —— 只用图形标位置，不提供任何外观信息。

与 render_blockout.py 的区别：底座是**真实空间**（场景主图/全景截图），不是线框图。
用来隔离检验一个机制：**"把位置以图形标出来" 是否比 "只用文字说位置" 更有效**。

用法：
  python mark_position.py --base master.png --silhouette 0.74,0.62,0.40 --label "cabinet" --out marked.png
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pano_crop import draw_silhouette  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--base", required=True)
    ap.add_argument("--silhouette", required=True, help="u,v,相对高度")
    ap.add_argument("--label", default="")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    parts = [float(x) for x in str(args.silhouette).split(",")]
    if len(parts) != 3:
        print(json.dumps({"error": "--silhouette 需要 u,v,h"}, ensure_ascii=False))
        return 2

    with Image.open(args.base) as im:
        base = im.convert("RGB")

    marked = draw_silhouette(base, parts[0], parts[1], parts[2], args.label)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    marked.save(out, "PNG", optimize=True)
    print(json.dumps({"out": str(out), "u": parts[0], "v": parts[1], "h": parts[2]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
