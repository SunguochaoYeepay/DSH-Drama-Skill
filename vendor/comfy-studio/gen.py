#!/usr/bin/env python
"""comfy-studio — one stable entrypoint for local ComfyUI media generation.

Talks to ComfyUI's HTTP API directly (no webapp, no proxy), so a single
command drives image, image-edit, video and music generation and reports the
resulting files as JSON on stdout.

    python gen.py t2i   --prompt "赛博朋克猫" --ratio 16:9
    python gen.py edit  --prompt "把背景换成雪山" --image in.png
    python gen.py t2v   --prompt "雨夜霓虹街头" --duration 5
    python gen.py i2v   --prompt "镜头缓慢推近" --image first.png
    python gen.py fl2v  --prompt "从白天过渡到黄昏" --image a.png --last-image b.png
    python gen.py r2v   --prompt "让 <Picture 1> 里的人开口说话" --image a.png --image b.png
    python gen.py music --caption "Lo-fi hip-hop, 78 BPM..." --lyrics "[verse]..." --duration 60
    python gen.py check

stdout carries exactly one JSON object; all progress goes to stderr, so the
result stays machine-readable.  Exit code is 0 on success, 1 on failure.

Requires only the standard library (Python 3.8+), so it runs on either the
ComfyUI embedded interpreter or any system Python.
"""
from __future__ import annotations

import argparse
import json
import os
import random
import shutil
import string
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import graphs  # noqa: E402  (local module, needs the path insert above)
import routes  # noqa: E402  (local module)

DEFAULT_URL = os.environ.get("COMFYUI_URL", "http://127.0.0.1:8188")
# 本机才知道 ComfyUI 装在哪，这里不写死任何人的盘符。
# 只在"定位 ComfyUI 自己的产物目录"时用；缺省就是当前目录，不会让调用崩掉。
# Note for vendored snapshot: upstream had a machine-specific default here.
DEFAULT_ROOT = os.environ.get("COMFYUI_ROOT", "")

VIDEO_EXTS = {".mp4", ".webm", ".mov", ".mkv", ".gif"}
AUDIO_EXTS = {".flac", ".mp3", ".wav", ".ogg", ".opus", ".m4a"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}

MODE_KIND = {
    "t2i": "image",
    "edit": "image",
    "t2v": "video",
    "i2v": "video",
    "fl2v": "video",
    "r2v": "video",
    "music": "audio",
}


def log(msg: str) -> None:
    """Record progress without polluting stdout.

    stdout must stay a single parseable JSON object.  Progress goes to a
    rolling log file, and to stderr only under --verbose, because PowerShell
    turns any stderr write from a native command into a NativeCommandError and
    a misleading non-zero exit code.
    """
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    if _LOG_PATH is not None:
        try:
            with open(_LOG_PATH, "a", encoding="utf-8") as fh:
                fh.write(line + "\n")
        except Exception:
            pass
    if _VERBOSE:
        print(f"[comfy-studio] {msg}", file=sys.stderr, flush=True)


_LOG_PATH: str | None = None
_VERBOSE = False


def enable_logging(log_path: str | None, verbose: bool) -> None:
    """Truncate the rolling log for this run and set the verbosity switch."""
    global _LOG_PATH, _VERBOSE
    _VERBOSE = verbose
    if log_path is None:
        log_path = str(Path(tempfile.gettempdir()) / "comfy-studio.log")
    try:
        Path(log_path).write_text("", encoding="utf-8")
        _LOG_PATH = log_path
    except Exception:
        _LOG_PATH = None


def classify(filename: str) -> str:
    ext = Path(filename).suffix.lower()
    if ext in VIDEO_EXTS:
        return "video"
    if ext in AUDIO_EXTS:
        return "audio"
    if ext in IMAGE_EXTS:
        return "image"
    return "other"


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

def _request(req, timeout):
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def post_json(url, payload, timeout=60):
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/json"}, method="POST"
    )
    status, raw = _request(req, timeout)
    try:
        return status, json.loads(raw.decode("utf-8"))
    except Exception:
        return status, {"raw": raw.decode("utf-8", errors="replace")}


def get_json(url, timeout=30):
    req = urllib.request.Request(url, method="GET")
    status, raw = _request(req, timeout)
    try:
        return status, json.loads(raw.decode("utf-8"))
    except Exception:
        return status, {"raw": raw.decode("utf-8", errors="replace")}


def upload_image(base_url, path: Path, timeout=120) -> str:
    """Push a local image into ComfyUI's input dir; returns its ComfyUI name.

    The name is forced to ASCII because it travels inside an HTTP header,
    where non-ASCII filenames are not reliably encoded.
    """
    if not path.is_file():
        raise FileNotFoundError(f"找不到图片: {path}")
    ext = path.suffix.lower() or ".png"
    tag = "".join(random.choices(string.ascii_lowercase + string.digits, k=8))
    safe_name = f"cs_{int(time.time())}_{tag}{ext}"

    boundary = "----comfystudio" + "".join(random.choices(string.hexdigits, k=16))
    data = path.read_bytes()
    parts = [
        (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="image"; filename="{safe_name}"\r\n'
            "Content-Type: application/octet-stream\r\n\r\n"
        ).encode("utf-8"),
        data,
        (
            f"\r\n--{boundary}\r\n"
            'Content-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n'
            f"--{boundary}--\r\n"
        ).encode("utf-8"),
    ]
    body = b"".join(parts)
    req = urllib.request.Request(
        f"{base_url}/upload/image",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    status, raw = _request(req, timeout)
    if status != 200:
        raise RuntimeError(f"上传失败 HTTP {status}: {raw[:300].decode('utf-8', 'replace')}")
    info = json.loads(raw.decode("utf-8"))
    sub = (info.get("subfolder") or "").strip()
    name = info["name"]
    log(f"图片已送入 ComfyUI input: {sub + '/' if sub else ''}{name}")
    return f"{sub}/{name}" if sub else name


# ---------------------------------------------------------------------------
# Generation
# ---------------------------------------------------------------------------

def submit(base_url, graph, timeout=120):
    """POST /prompt.  Returns (prompt_id, node_errors) or raises with detail.

    ComfyUI reports graph problems here (unknown node, bad input name, missing
    model) as `node_errors`; surfacing that verbatim is what makes a failed
    run diagnosable instead of a generic 400.
    """
    status, body = post_json(f"{base_url}/prompt", {"prompt": graph}, timeout=timeout)
    if status != 200:
        detail = body.get("error") if isinstance(body, dict) else body
        node_errors = body.get("node_errors") if isinstance(body, dict) else None
        err = RuntimeError(f"ComfyUI 拒绝了工作流 (HTTP {status}): {json.dumps(detail, ensure_ascii=True)}")
        err.node_errors = node_errors  # type: ignore[attr-defined]
        raise err
    node_errors = body.get("node_errors") or {}
    if node_errors:
        log(f"警告: ComfyUI 报告 node_errors: {json.dumps(node_errors, ensure_ascii=True)}")
    return body["prompt_id"], node_errors


def wait_for(base_url, prompt_id, timeout, poll=1.5):
    """Poll /history until the prompt completes, errors, or the deadline passes.

    Unlike the reference webapp this is bounded: an unbounded poll turns a
    wedged job into a client that hangs forever.
    """
    start = time.time()
    last_log = 0.0
    while True:
        elapsed = time.time() - start
        if elapsed > timeout:
            queued = None
            try:
                _, q = get_json(f"{base_url}/queue", timeout=10)
                running = q.get("queue_running") or []
                pending = q.get("queue_pending") or []
                queued = f"running={len(running)} pending={len(pending)}"
            except Exception:
                pass
            raise TimeoutError(
                f"等待超时 ({timeout}s)。ComfyUI 可能仍在计算；队列状态: {queued or '未知'}"
            )

        status, hist = get_json(f"{base_url}/history/{prompt_id}", timeout=30)
        entry = hist.get(prompt_id) if isinstance(hist, dict) else None
        if entry:
            st = entry.get("status") or {}
            if st.get("completed"):
                log(f"完成，耗时 {elapsed:.1f}s")
                return entry
            if st.get("status_str") == "error":
                msgs = []
                for m in st.get("messages") or []:
                    if isinstance(m, list) and len(m) > 1:
                        payload = m[1]
                        if isinstance(payload, dict):
                            msgs.append(str(payload.get("message") or payload))
                        else:
                            msgs.append(str(payload))
                detail = " | ".join(msgs) or st.get("message") or "未知错误"
                raise RuntimeError(f"ComfyUI 执行报错: {detail}")

        if elapsed - last_log > 10:
            log(f"已等待 {elapsed:.0f}s ...")
            last_log = elapsed
        time.sleep(poll)


def collect_outputs(entry, root: Path):
    """Map a history entry's outputs to absolute paths on disk.

    Classification is by file extension rather than by the JSON key, because
    ComfyUI reports SaveVideo results under `images` on some versions and
    `videos` on others.
    """
    base_for = {
        "output": root / "output",
        "temp": root / "temp",
        "input": root / "input",
    }
    found, seen = [], set()
    for _node_id, node_out in (entry.get("outputs") or {}).items():
        if not isinstance(node_out, dict):
            continue
        for _key, items in node_out.items():
            if not isinstance(items, list):
                continue
            for item in items:
                if not isinstance(item, dict):
                    continue
                filename = item.get("filename")
                if not filename:
                    continue
                subfolder = item.get("subfolder") or ""
                type_ = item.get("type") or "output"
                base = base_for.get(type_, root / "output")
                path = (base / subfolder / filename) if subfolder else (base / filename)
                key = str(path)
                if key in seen:
                    continue
                seen.add(key)
                query = urllib.parse.urlencode(
                    {"filename": filename, "subfolder": subfolder, "type": type_}
                )
                found.append(
                    {
                        "path": str(path),
                        "filename": filename,
                        "subfolder": subfolder,
                        "type": type_,
                        "kind": classify(filename),
                        "exists": path.is_file(),
                        "bytes": path.stat().st_size if path.is_file() else 0,
                        "url": f"{DEFAULT_URL}/view?{query}",
                    }
                )
    order = {"video": 0, "image": 1, "audio": 2}
    found.sort(key=lambda f: order.get(f["kind"], 9))
    return found


def mirror_to_out_dir(files, out_dir: str, mode: str):
    """Copy produced media into a caller-chosen directory and return the copies.

    ComfyUI writes into its own `output/` tree, which normally sits outside the
    session workspace.  The DSH sidebar's file tree is rooted at the session
    working directory and refuses to read anything outside it, so a file left in
    ComfyUI's output is unreachable from the UI.  Copying into the workspace is
    what makes a generated image actually visible and openable in the sidebar.
    """
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    copied: list[str] = []

    for index, item in enumerate(files):
        src = Path(item["path"])
        if not src.is_file():
            continue
        suffix = f"_{index + 1}" if len(files) > 1 else ""
        dst = out / f"{mode}_{stamp}{suffix}{src.suffix}"
        bump = 1
        while dst.exists():
            bump += 1
            dst = out / f"{mode}_{stamp}{suffix}_v{bump}{src.suffix}"
        shutil.copy2(src, dst)
        item["local_path"] = str(dst)
        copied.append(str(dst))
    return copied


# ---------------------------------------------------------------------------
# check
# ---------------------------------------------------------------------------

# 默认图像家族从 Qwen-Image(-Edit) 2511 切到 **Qwen Image 2.1**（2026-09-21）。
# `--image-model qwen` 仍可退回旧链路（那时该验的是下面 "legacy" 那一组）。
REQUIRED_MODELS = {
    "t2i": [
        ("diffusion_models", graphs.M_QWEN21_UNET),
        ("text_encoders", graphs.M_QWEN21_CLIP),
        ("vae", graphs.M_QWEN21_VAE),
    ],
    "edit": [
        ("diffusion_models", graphs.M_QWEN21_UNET),
        ("text_encoders", graphs.M_QWEN21_CLIP),
        ("vae", graphs.M_QWEN21_VAE),
    ],
    "t2v": [
        ("diffusion_models", graphs.M_H3_UNET),
        ("text_encoders", graphs.M_H3_CLIP),
        ("vae", graphs.M_H3_VIDEO_VAE),
        ("vae", graphs.M_H3_AUDIO_VAE),
    ],
    "music": [
        ("diffusion_models", graphs.M_MUSIC_UNET),
        ("text_encoders", graphs.M_MUSIC_CLIP),
        ("vae", graphs.M_MUSIC_VAE),
    ],
}


def run_check(base_url, root: Path):
    report: dict = {"ok": True, "comfy_url": base_url, "comfy_root": str(root)}

    status, stats = get_json(f"{base_url}/system_stats", timeout=15)
    if status != 200:
        return {"ok": False, "error": f"ComfyUI 不可达 ({base_url}, HTTP {status})"}
    system = stats.get("system", {})
    report["comfyui_version"] = system.get("comfyui_version")
    report["devices"] = [
        {
            "name": d.get("name"),
            "vram_total_gb": round((d.get("vram_total") or 0) / 1024**3, 1),
            "vram_free_gb": round((d.get("vram_free") or 0) / 1024**3, 1),
        }
        for d in stats.get("devices", [])
    ]

    _, q = get_json(f"{base_url}/queue", timeout=15)
    report["queue"] = {
        "running": len(q.get("queue_running") or []),
        "pending": len(q.get("queue_pending") or []),
    }

    missing = []
    for mode, items in REQUIRED_MODELS.items():
        for folder, name in items:
            rel = name.replace("\\", "/")
            path = root / "models" / folder / rel
            if not path.is_file():
                missing.append({"mode": mode, "expected": str(path)})
    report["missing_models"] = missing
    report["ok"] = not missing
    return report


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_parser():
    p = argparse.ArgumentParser(
        prog="gen.py",
        description="comfy-studio: local ComfyUI image / image-edit / video / music generation",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument(
        "mode",
        choices=["auto", "t2i", "edit", "t2v", "i2v", "fl2v", "r2v", "music", "check"],
        help="auto = 只给 --text，由程序判断模式与参数（推荐给能力较弱的驱动方）",
    )
    p.add_argument("--text", help="auto 模式：用户原话，不做任何加工")
    p.add_argument("--no-expand", action="store_true", help="auto 模式：不调用本地 Ollama 编译提示词")
    p.add_argument("--ollama-model", help="auto 模式：编译提示词用的 Ollama 模型（默认自动挑选）")
    p.add_argument("--prompt", help="生成提示词 / 编辑指令")
    p.add_argument("--caption", help="music: 音乐描述（风格、编制、氛围）")
    p.add_argument("--lyrics", default="", help="music: 歌词，可含 [verse]/[chorus] 等结构标签；留空为纯音乐")
    p.add_argument("--image", action="append", default=[], help="输入图片路径，可重复")
    p.add_argument("--last-image", help="fl2v 的尾帧图片路径")
    p.add_argument("--ratio", help="画幅比例，如 16:9 / 9:16 / 1:1 / 4:3 / 21:9")
    p.add_argument("--width", type=int, help="显式宽度（覆盖 ratio，自动对齐到 16/32 倍数）")
    p.add_argument("--height", type=int)
    p.add_argument("--duration", type=float, default=5.0, help="视频秒数（默认 5，H3 上限约 15）")
    p.add_argument("--seed", type=int, default=-1, help="-1 表示随机")
    p.add_argument("--steps", type=int, help="采样步数（不传则用该模式默认值）")
    p.add_argument("--cfg", type=float, help="CFG（不传则用该模式默认值）")
    p.add_argument("--style", default="realistic", help="画质预设（t2i 与 edit 都生效）: realistic/anime/cyberpunk/healing/vintage/none")
    # ── Qwen Image 2.1专属旋钮（对旧家族无效）──────────────────────────────
    p.add_argument("--image-model", choices=("qwen21", "qwen"), default="qwen21",
                   help="图像模型家族：qwen21 = Qwen Image 2.1（默认，25 步，参考图最多 16 张）；"
                        "qwen = 旧的 Qwen-Image / Qwen-Image-Edit 2511 链路")
    p.add_argument("--negative", default="", help="追加的负向词，与 --style 预设的负向词合并")
    p.add_argument("--ref-resolution", type=int, default=graphs.QWEN21_RESOLUTION,
                   help="参考图统一缩放边长（32 的倍数，0 = 保留每张原尺寸）")
    p.add_argument("--cache-device", choices=("auto", "gpu", "cpu", "off"), default="auto",
                   help="2.1 模型缓存放哪：显存吃紧时用 cpu（几乎不损失速度）")
    p.add_argument("--append-style-positive", action="store_true",
                   help="把 --style 的正向句也追加到提示词后面（默认不追加，见 graphs.build_image21）")
    p.add_argument("--h3-style", default="cinematic", help="视频提示词套壳风格: cinematic/anime/product/healing/cyberpunk/none")
    p.add_argument("--no-shell", action="store_true", help="视频模式不套 H3 三段式外壳，原样使用 prompt")
    p.add_argument("--profile", default=None, help="H3 预设：draft(4步+4stepLoRA) / balanced(8步+8stepLoRA) / final(20步无LoRA)")
    p.add_argument("--attention", choices=("auto", "vsa", "sage"), default="auto",
                   help="视频注意力后端；auto 保持预设行为，其他选项仅供同模型对照测试")
    p.add_argument("--lora", default=None, help="直接指定 LoRA 文件名；默认由 --profile 决定")
    p.add_argument("--fast", action="store_true", help="启用加速 LoRA（图像 4 步 / 视频 4 步），显著提速")
    p.add_argument("--batch", type=int, default=1, help="t2i/music 批量数量")
    p.add_argument("--url", default=DEFAULT_URL, help=f"ComfyUI 地址（默认 {DEFAULT_URL}）")
    p.add_argument("--comfy-root", default=DEFAULT_ROOT, help="ComfyUI 安装根目录，用于定位产物")
    p.add_argument("--timeout", type=float, default=1800.0, help="等待上限秒数（默认 1800）")
    p.add_argument("--dry-run", action="store_true", help="只打印将提交的工作流，不执行")
    p.add_argument("--result-file", help="额外把结果 JSON 写入该文件")
    p.add_argument(
        "--out-dir",
        help="把产物另存一份到该目录（传会话工作区内的路径，侧边栏才看得到）",
    )
    p.add_argument("--log-file", help="进度日志路径（默认 %%TEMP%%\\comfy-studio.log）")
    p.add_argument("--verbose", action="store_true", help="把进度也打到 stderr（默认只写日志文件）")
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    enable_logging(args.log_file, args.verbose)
    root = Path(args.comfy_root)
    started = time.time()
    mode = args.mode

    # Default the delivery copy into the current directory: a caller that
    # forgets --out-dir still lands files somewhere the sidebar can read.
    if not args.out_dir:
        args.out_dir = str(Path.cwd() / "comfy-out")

    def emit(payload: dict, code: int = 0) -> int:
        payload.setdefault("elapsed_s", round(time.time() - started, 1))
        text = json.dumps(payload, ensure_ascii=True, indent=2)
        if args.result_file:
            try:
                Path(args.result_file).write_text(
                    json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
                )
            except Exception as e:
                log(f"写 result-file 失败: {e}")
        print(text)
        return code

    if args.mode == "check":
        rep = run_check(args.url, root)
        return emit(rep, 0 if rep.get("ok") else 1)

    try:
        # --- resolve mode and inputs ----------------------------------------
        auto_notes: dict = {}

        if mode == "auto":
            text = (args.text or args.prompt or "").strip()
            if not text:
                raise ValueError("auto 模式需要 --text（把用户原话传进来即可）")

            mode = routes.route(text, len(args.image))
            auto_notes["auto_text"] = text

            # Deterministic inference: the caller states nothing it need not.
            if not args.ratio:
                args.ratio = routes.infer_ratio(text)
            if args.duration == 5.0:
                inferred = routes.infer_duration(text)
                if inferred is not None:
                    args.duration = inferred
            if mode == "t2i" and args.style == "realistic":
                args.style = routes.infer_style(text)
            if mode in ("t2v", "i2v", "fl2v", "r2v") and args.h3_style == "cinematic":
                args.h3_style = routes.infer_h3_style(text)
            if routes.infer_fast(text):
                args.fast = True
            if mode == "music" and routes.wants_instrumental(text):
                args.no_lyrics = True

            # One narrowly-scoped local LLM call replaces the caller's
            # prompt-engineering judgment.  If Ollama is down we degrade to the
            # user's own words rather than failing the run.
            auto_notes["expanded"] = False
            if not args.no_expand:
                chosen = routes.pick_model(args.ollama_model)
                if not chosen:
                    log("Ollama 不可用，跳过提示词编译，直接使用原话")
                else:
                    try:
                        compiled, cap, lyr = routes.compile_prompt(mode, text, chosen)
                        if mode == "music":
                            args.caption = cap or text
                            if lyr and not getattr(args, "no_lyrics", False):
                                args.lyrics = lyr
                        elif compiled:
                            args.prompt = compiled
                        auto_notes["expanded"] = True
                        auto_notes["prompt_model"] = chosen
                        log(f"提示词已由 {chosen} 编译")
                    except Exception as exc:  # noqa: BLE001
                        log(f"提示词编译失败，改用原话：{type(exc).__name__}: {exc}")

            auto_notes["auto_mode"] = mode
            log(f"auto 判定：{mode}（依据 {len(args.image)} 张图 + 文本）")

        prompt = args.prompt or ""
        video_mode = mode in ("t2v", "i2v", "fl2v", "r2v")
        if mode == "music":
            caption = args.caption or args.prompt or ""
            if not caption.strip():
                raise ValueError("music 模式需要 --caption 描述音乐")
        else:
            if not prompt.strip():
                raise ValueError(f"{mode} 模式需要 --prompt")
            if video_mode:
                if args.no_shell:
                    prompt = prompt.strip()
                else:
                    # 官方结构要三样东西：模式（决定对齐句和锚点句）、
                    # 时长（写进 [Shot 1] … lasting N seconds）、参考图数量（r2v 的 <Picture N>）
                    prompt = graphs.format_to_h3_prompt(
                        prompt, args.h3_style,
                        task_key=mode,
                        duration=float(args.duration or 5.0),
                        n_pictures=len(args.image or []) + (1 if args.last_image else 0),
                    )

        width, height = graphs.resolve_size(args.ratio, mode, args.width, args.height)

        # Echo back exactly what was sent, so a caller can verify it, reuse it,
        # or tweak it — and so an expanded auto run stays reproducible.
        effective_prompt = caption if mode == "music" else prompt

        uploaded: list[str] = []
        for p in args.image:
            uploaded.append(upload_image(args.url, Path(p)))
        last_uploaded = upload_image(args.url, Path(args.last_image)) if args.last_image else None

        # --- build graph ----------------------------------------------------
        params: dict = {"mode": mode, "width": width, "height": height, **auto_notes}

        image21 = args.image_model == "qwen21" and mode in ("t2i", "edit")
        if mode in ("t2i", "edit"):
            params["image_model"] = args.image_model

        if image21:
            # 2.1 没有蒸馏/加速 LoRA 这一档：官方就是 25 步 cfg 1 跑满。
            # 想快只能减 steps（画质同步下降），挂旧 Qwen 的 LoRA 是骨架错配，直接拒绝。
            if args.lora:
                raise ValueError(
                    "Qwen Image 2.1 没有可用的 Lightning/蒸馏 LoRA（骨架与旧 Qwen 不同）。"
                    "要更快请减小 --steps，或退回 --image-model qwen"
                )
            steps = args.steps if args.steps is not None else graphs.QWEN21_STEPS
            cfg = args.cfg if args.cfg is not None else graphs.QWEN21_CFG
            if args.fast:
                log(f"--fast 对 2.1 无效（无蒸馏档），仍按 {steps} 步跑")
            params.update({"steps": steps, "cfg": cfg, "ref_resolution": args.ref_resolution})
            graph = graphs.build_image21(
                mode, prompt, uploaded,
                width=width, height=height, seed=args.seed, steps=steps, cfg=cfg,
                style=args.style, negative=args.negative,
                resolution=args.ref_resolution, batch=args.batch,
                cache_device=args.cache_device,
                append_positive=args.append_style_positive,
            )

        elif mode == "t2i":
            steps = args.steps if args.steps is not None else (4 if args.fast else 20)
            cfg = args.cfg if args.cfg is not None else (1.0 if args.fast else 4.0)
            # `--lora` 优先，用于试非默认档；未指定时 `--fast` 走默认 t2i Lightning。
            t2i_lora = args.lora or (graphs.M_QWEN_T2I_LORA if args.fast else None)
            graph = graphs.build_t2i(
                prompt, width=width, height=height, seed=args.seed, steps=steps, cfg=cfg,
                style=args.style, batch=args.batch, lora=t2i_lora,
                # 挂了 Lightning/蒸馏 LoRA 就必须给 t2i 的 shift=3.1（对齐 DramaClaw 的
                # qwen_text2img.json）—— 裸挂 LoRA 会发灰、指令遵循变差。
                shift=graphs.QWEN_T2I_SHIFT if t2i_lora else None,
            )

        elif mode == "edit":
            steps = args.steps if args.steps is not None else (4 if args.fast else 20)
            cfg = args.cfg if args.cfg is not None else (1.0 if args.fast else 4.0)
            # 仅在显式给出 --width/--height 时才指定输出尺寸；默认仍跟随图1
            # （FluxKontextImageScale ~1MP），保持向后兼容（2026-09-20 no_chute）。
            edit_size = (int(args.width), int(args.height)) if args.width and args.height else None
            # `--lora` 优先，用于试非默认档（如 8 步版）；未指定时 `--fast` 走默认 4 步 Lightning。
            edit_lora = args.lora or (graphs.M_QWEN_EDIT_LORA if args.fast else None)
            # Lightning/蒸馏档必须同 DramaClaw 一样补 ModelSamplingAuraFlow + CFGNorm：
            # 4 步 LoRA 裸跑会发灰、指令遵循差（2026-09-20 DramaClaw 对照实测）。
            graph = graphs.build_edit(
                prompt, uploaded, seed=args.seed, steps=steps, cfg=cfg,
                style=args.style, size=edit_size, lora=edit_lora,
                shift=graphs.QWEN_EDIT_SHIFT if edit_lora else None,
                cfgnorm=graphs.QWEN_EDIT_CFG_NORM if edit_lora else None,
            )

        elif video_mode:
            frames, seconds = graphs.snap_frames(args.duration)
            params.update({"frames": frames, "seconds": round(seconds, 2)})
            # ── 三档预设（照 DramaClaw 的 MINIMAX_H3_PROFILES）────────────
            # **8 步必须配 8 步的 LoRA** —— 拿 4 步的 LoRA 跑 8 步是离线的。
            #   draft     4 步 + turbo_4step_v1.0_768p
            #   balanced  8 步 + turbo_8step_v1.0
            #   final    20 步 + 不挂 LoRA
            profile = str(getattr(args, "profile", None) or "").strip().lower()
            if not profile:
                profile = "draft" if args.fast else "final"
            if profile not in graphs.H3_PROFILES:
                raise ValueError(f"未知的 H3 预设：{profile}（可选 {', '.join(graphs.H3_PROFILES)}）")
            preset = graphs.H3_PROFILES[profile]
            steps = args.steps if args.steps is not None else preset["steps"]
            lora = preset["lora"] if args.lora is None else (args.lora or None)
            params["profile"] = profile
            cfg = args.cfg if args.cfg is not None else 1.0
            # FastH3 预设会带自己的 UNET / VSA 开关 / shift（官方模板的配置）
            unet = preset.get("unet")
            vsa = bool(preset.get("vsa", False))
            sage = not vsa
            if args.attention != "auto":
                vsa = args.attention == "vsa"
                sage = args.attention == "sage"
            params["attention"] = "vsa" if vsa else "sage"
            shift_video = preset.get("shift_video", 12.0)
            if unet:
                params["unet"] = unet
            if vsa:
                params["vsa"] = True
            graph = graphs.build_h3(
                mode, prompt,
                frames=frames, width=width, height=height,
                seed=args.seed, steps=steps, cfg=cfg,
                lora=lora,
                unet=unet or graphs.M_H3_UNET,
                vsa=vsa,
                sage=sage,
                shift_video=shift_video,
                image=uploaded[0] if uploaded else None,
                last_image=last_uploaded,
                refs=uploaded,
            )

        else:  # music
            steps = args.steps if args.steps is not None else 30
            cfg = args.cfg if args.cfg is not None else 1.7
            graph = graphs.build_music(
                caption, lyrics=args.lyrics, duration=args.duration,
                seed=args.seed, steps=steps, cfg=cfg, batch=args.batch,
            )

        if args.dry_run:
            return emit(
                {
                    "ok": True,
                    "dry_run": True,
                    "params": params,
                    "prompt_used": effective_prompt,
                    "lyrics_used": args.lyrics if mode == "music" else None,
                    "graph": graph,
                }
            )

        # --- run ------------------------------------------------------------
        log(f"{mode} · {width}x{height}" + (f" · {params.get('frames')}帧/{params['seconds']}s" if video_mode else ""))
        prompt_id, node_errors = submit(args.url, graph)
        log(f"prompt_id = {prompt_id}")
        entry = wait_for(args.url, prompt_id, args.timeout)

        files = collect_outputs(entry, root)
        media = [f for f in files if f["kind"] != "other"]
        if not media:
            return emit(
                {
                    "ok": False,
                    "mode": mode,
                    "error": "ComfyUI 执行完成但没有产出可识别的媒体文件",
                    "prompt_id": prompt_id,
                    "params": params,
                    "raw_outputs": files,
                },
                1,
            )

        local_files: list[str] = []
        if args.out_dir:
            local_files = mirror_to_out_dir(media, args.out_dir, mode)
            log(f"已另存 {len(local_files)} 个文件到 {args.out_dir}")

        return emit(
            {
                "ok": True,
                "mode": mode,
                "kind": MODE_KIND.get(mode),
                "prompt_id": prompt_id,
                "params": params,
                "seed_used": _seed_of(graph),
                "files": media,
                "local_files": local_files,
                "out_dir": args.out_dir,
                "prompt_used": effective_prompt,
                "lyrics_used": args.lyrics if mode == "music" else None,
                "node_errors": node_errors,
            }
        )

    except Exception as e:  # noqa: BLE001 — the CLI's whole job is to report failure as JSON
        payload = {"ok": False, "mode": args.mode, "error": f"{type(e).__name__}: {e}"}
        node_errors = getattr(e, "node_errors", None)
        if node_errors:
            payload["node_errors"] = node_errors
        return emit(payload, 1)


def _seed_of(graph) -> int | None:
    for node in graph.values():
        if not isinstance(node, dict):
            continue
        seed = (node.get("inputs") or {}).get("seed")
        if isinstance(seed, int):
            return seed
    return None


if __name__ == "__main__":
    raise SystemExit(main())
