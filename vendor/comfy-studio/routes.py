"""Deterministic routing, parameter inference, and local-LLM prompt compilation.

This module exists so that a *weak* driving model can use comfy-studio without
supplying judgment.  Everything the SKILL.md would otherwise ask the caller to
reason about — which mode fits, what ratio and style were implied, how to turn a
casual sentence into a prompt the model actually responds to — is decided here,
by code, plus one narrowly-scoped call to the local Ollama model.

Design rule: the driver supplies a sentence and (optionally) image paths.  It
supplies no mode, no ratio, no style, and no prompt engineering.  Anything a
program can decide, a program decides.
"""
from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
PREFERRED_MODELS = ("qwen3:14b", "qwen2.5:14b", "qwen3:8b", "qwen2.5:7b", "qwen2.5:3b")

# --- routing vocabulary ----------------------------------------------------
# Substring tests, deliberately broad: a missed keyword is survivable because
# every rule has a safe default, whereas an over-narrow rule silently misfires.

MUSIC_HINTS = (
    "歌", "音乐", "配乐", "bgm", "bmg", "曲子", "旋律", "伴奏", "纯音乐",
    "说唱", "rap", "music", "song", "lofi", "lo-fi", "soundtrack",
)
VIDEO_HINTS = (
    "视频", "动起来", "动一下", "让它动", "动画", "运镜", "镜头", "短片", "影片",
    "慢动作", "animate", "video", "motion", "clip",
)
EDIT_HINTS = (
    "换成", "换上", "改成", "换个", "替换", "取代", "去掉", "移除", "删掉", "删除",
    "加上", "加个", "添加", "编辑", "修改", "变成", "调成", "修复", "扩图", "重绘",
    "remove", "replace", "change the", "edit", "swap",
)
FL2V_HINTS = (
    "首尾", "过渡", "渐变", "变形", "从", "过渡到", "transition", "morph", "between",
)
VERTICAL_HINTS = ("竖屏", "竖版", "抖音", "快手", "小红书", "手机壁纸", "vertical", "portrait mode")
WIDE_HINTS = ("横屏", "横版", "宽屏", "宽幅", "landscape", "widescreen")
SQUARE_HINTS = ("方图", "正方形", "square", "1:1")

STYLE_HINTS = (
    ("anime", ("动漫", "二次元", "漫画", "卡通", "anime", "manga")),
    ("cyberpunk", ("赛博", "朋克", "科幻", "霓虹", "cyber", "neon")),
    ("healing", ("治愈", "清新", "温暖", "柔和", "healing", "cozy")),
    ("vintage", ("复古", "胶片", "老照片", "怀旧", "vintage", "retro", "film")),
)

H3_STYLE_HINTS = (
    ("anime", ("动漫", "二次元", "anime")),
    ("cyberpunk", ("赛博", "朋克", "霓虹", "cyber", "neon")),
    ("healing", ("治愈", "清新", "温暖", "healing")),
    ("product", ("产品", "广告", "商品", "product", "commercial")),
    ("cinematic", ("电影", "大片", "cinematic", "trailer")),
)


def _has(text: str, hints) -> bool:
    low = text.lower()
    return any(h.lower() in low for h in hints)


def route(text: str, n_images: int) -> str:
    """Pick a generation mode from the user's own words plus how many images came along.

    Every branch falls back to the least destructive reading: a still image is
    cheap to redo, so ambiguous image requests become `edit` rather than a
    multi-minute video.
    """
    text = text or ""
    if _has(text, MUSIC_HINTS):
        return "music"
    if n_images >= 3:
        return "r2v"
    if n_images == 2:
        return "fl2v"
    if n_images == 1:
        if _has(text, VIDEO_HINTS):
            return "i2v"
        return "edit"
    if _has(text, VIDEO_HINTS):
        return "t2v"
    return "t2i"


def infer_ratio(text: str) -> str | None:
    """Read an aspect ratio out of the request. Returns None when unstated."""
    if _has(text, VERTICAL_HINTS):
        return "9:16"
    if _has(text, SQUARE_HINTS):
        return "1:1"
    if _has(text, WIDE_HINTS):
        return "16:9"
    return None


def infer_duration(text: str) -> float | None:
    """Read a duration in seconds out of the request."""
    match = re.search(r"(\d+(?:\.\d+)?)\s*(?:秒|s\b|sec\b)", text or "", re.IGNORECASE)
    if match:
        try:
            return float(match.group(1))
        except ValueError:
            return None
    return None


def infer_style(text: str) -> str:
    """Map a casual style word to a Qwen-Image quality preset id."""
    for style, hints in STYLE_HINTS:
        if _has(text, hints):
            return style
    return "realistic"


def infer_h3_style(text: str) -> str:
    """Map a casual style word to an H3 three-section shell preset id."""
    for style, hints in H3_STYLE_HINTS:
        if _has(text, hints):
            return style
    return "cinematic"


def infer_fast(text: str) -> bool:
    """`--fast` is opt-in only when speed is actually requested."""
    return _has(text, ("快", "尽快", "马上", "赶紧", "quick", "fast", "asap"))


def wants_instrumental(text: str) -> bool:
    return _has(text, ("纯音乐", "伴奏", "无人声", "器乐", "instrumental", "no vocal", "bgm for"))


# --- Ollama ----------------------------------------------------------------

def _post_json(url: str, payload: dict, timeout: float):
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def list_models(timeout: float = 5.0) -> list[str]:
    """Installed Ollama model names, newest-preferred order left to the caller."""
    try:
        with urllib.request.urlopen(f"{OLLAMA_URL}/api/tags", timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return [m.get("name", "") for m in data.get("models", [])]
    except Exception:
        return []


def pick_model(explicit: str | None = None) -> str | None:
    """Prefer an explicitly requested model, else the best installed one.

    Returns None when Ollama is unreachable, which callers treat as "skip
    prompt compilation and pass the user's words through unchanged".
    """
    if explicit:
        return explicit
    installed = list_models()
    if not installed:
        return None
    for wanted in PREFERRED_MODELS:
        if wanted in installed:
            return wanted
    for name in installed:
        if "qwen" in name.lower():
            return name
    return installed[0]


_THINK = re.compile(r"<think(?:ing)?>.*?</think(?:ing)?>", re.DOTALL | re.IGNORECASE)


def _clean(text: str) -> str:
    """Strip reasoning traces and code fences that local models like to add."""
    text = _THINK.sub("", text or "").strip()
    text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    return text.strip().strip('"').strip()


IMAGE_SYSTEM = """你是图像生成提示词的编译者。把用户的大白话改写成一段可直接送进 \
Qwen-Image 的中文画面描述。

硬性要求：
- 只输出提示词本身，不要解释、不要引号、不要 Markdown、不要编号。
- 长度 60-150 个汉字。
- 必须原样保留用户指定的主体（人物/物体/动物）与其关键属性，不得替换。
- 补齐：场景环境、光线方向与质感、镜头的景别与景深、以及画面氛围。
- 不要出现"masterpiece""8k""best quality""高清""杰作"这类空泛质量词——画质由预设参数负责。
- 不要出现文字、水印、logo 相关描述。
- 中文输出。"""

VIDEO_SYSTEM = """你是 MiniMax H3 视频提示词的编译者。H3 联合建模画面与音频，必须按官方三段式输出。

严格按此格式输出，字段名必须原样，不要加任何额外说明或 Markdown 代码块：

integrated_multimodal_description:
[Shot 1] <英文风格标签>. <画面描述，写清主体外观、环境、光线>
<镜头运动，用"缓慢前推/低角度环绕/轻微手持晃动"这类具体运动，不要用形容词>

overall_soundscape: <环境音 + 音效 + 对白；有台词就把台词原样写出来。不要写 "No dialogue" 除非用户明确要无声>

non_diegetic_music: <画外配乐，或 N/A>

英文风格标签从这些里选一个：Live-action / Cinematic / 2D-animated / 3D CG / Claymation / Watercolor / Vintage film。
画面描述与镜头运动用中文，风格标签与字段名保持英文。分镜超过一个时继续写 [Shot 2]、[Shot 3]。"""

MUSIC_SYSTEM = """你是 MiniMax Music 3 的音乐提示词编译者。它需要两个独立输入。

只输出一个 JSON 对象，不要 Markdown 代码块，不要任何解释：
{"caption": "...", "lyrics": "..."}

caption 必须写成三段，段首标签原样保留。直接写内容，**禁止使用尖括号占位符**：
Global Metadata: 流派、BPM、调性、整体情绪走向、用途场景
Vocal Details: 人声性别/音色/唱法/混音位置；纯音乐写 instrumental, no vocals
Arrangement: 乐器编制，以及 intro/verse/chorus/bridge/outro 各段分别做什么

caption 示例——照这个密度写，但内容要换成用户实际要的风格：
Global Metadata: City pop, 108 BPM, F major, warm and nostalgic throughout, for a summer travel vlog.
Vocal Details: Female lead, airy breathy tone, doubled harmonies on the chorus, centered in the mix.
Arrangement: Clean electric guitar arpeggios and warm analog synth pads over a soft gated-reverb drum machine. Intro: filtered pad swell. Verse: sparse drums and bass. Chorus: full band with layered vocals. Outro: elements drop out to a solo guitar line.

lyrics 是歌词正文，必须用 [Intro] [Verse] [Chorus] [Bridge] [Outro] [Instrumental] 标签分段。
用户要求纯音乐/伴奏时 lyrics 留空字符串。
歌词要真的写出来（中文或英文皆可），不要写占位符。"""


def _strip_placeholders(text: str) -> str:
    """Remove angle-bracket placeholders a model echoed from instruction text.

    Local models often copy the `<...>` shape of a template into their answer.
    Those characters carry no meaning in a caption and only add noise to the
    text encoder, so unwrap them rather than shipping them.
    """
    return re.sub(r"<([^<>\n]{1,400})>", r"\1", text or "").strip()


def compile_prompt(mode: str, text: str, model: str, timeout: float = 180.0):
    """Turn a casual request into engine-ready prompt material.

    Returns `(prompt, caption, lyrics)`.  Raises on transport failure so the
    caller can decide whether to fall back to the raw text.
    """
    if mode == "music":
        raw = _post_json(
            f"{OLLAMA_URL}/api/chat",
            {
                "model": model,
                "messages": [
                    {"role": "system", "content": MUSIC_SYSTEM},
                    {"role": "user", "content": text},
                ],
                "stream": False,
                "options": {"temperature": 0.8, "top_p": 0.9, "num_predict": 1200},
            },
            timeout,
        )
        content = _clean(raw.get("message", {}).get("content", ""))
        match = re.search(r"\{.*\}", content, re.DOTALL)
        if not match:
            raise ValueError(f"音乐提示词编译返回的不是 JSON: {content[:200]}")
        data = json.loads(match.group(0))
        caption = _strip_placeholders(data.get("caption") or "")
        lyrics = (data.get("lyrics") or "").strip()
        return "", caption, lyrics

    system = VIDEO_SYSTEM if mode in ("t2v", "i2v", "fl2v", "r2v") else IMAGE_SYSTEM
    raw = _post_json(
        f"{OLLAMA_URL}/api/chat",
        {
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": text},
            ],
            "stream": False,
            "options": {"temperature": 0.7, "top_p": 0.9, "num_predict": 900},
        },
        timeout,
    )
    return _clean(raw.get("message", {}).get("content", "")), "", ""
