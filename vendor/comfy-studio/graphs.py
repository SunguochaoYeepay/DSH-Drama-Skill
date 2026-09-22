"""ComfyUI API-format graph builders for the comfy-studio skill.

Rewritten from scratch: the original file was lost to a multi-layer encoding
corruption, so this version was reconstructed from the compiled bytecode of the
last working revision and verified by diffing every builder's output against it.

Everything here returns a plain dict in ComfyUI's API format:
``{"<node id>": {"class_type": ..., "inputs": {...}}, ...}``.
"""

from __future__ import annotations

import json
import random

# ===========================================================================
#  Model files
# ===========================================================================

M_QWEN_T2I = "qwen_image_2512_fp8_e4m3fn.safetensors"
M_QWEN_T2I_LORA = "Qwen-Image-2512-Lightning-4steps-V1.0-bf16.safetensors"
# t2i 走 Lightning/蒸馏档时的采样修正值：**3.1**，不是 edit 的 3
# （出处：DramaClaw qwen_text2img.json 的 ModelSamplingAuraFlow 与 .env 的
#   COMFYUI_QWEN_SHIFT=3.1。2026-09-20 与 DramaClaw 对照后补）
QWEN_T2I_SHIFT = 3.1
M_QWEN_EDIT = "qwen_image_edit_2511_fp8_e4m3fn.safetensors"
M_QWEN_EDIT_LORA = "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors"
# Qwen edit 走 Lightning/蒸馏档时必须同 DramaClaw 一起配的两个采样修正参数
# （出处：DramaClaw qwen_img2img.json 的 ModelSamplingAuraFlow shift=3 / CFGNorm strength=1，
#   其 .env 的 COMFYUI_QWEN_EDIT_SHIFT=3。2026-09-20 no_chute 对照实测）
QWEN_EDIT_SHIFT = 3.0
QWEN_EDIT_CFG_NORM = 1.0
M_QWEN_CLIP = "qwen_2.5_vl_7b_fp8_scaled.safetensors"
M_QWEN_VAE = "qwen_image_vae.safetensors"

# ===========================================================================
#  Qwen Image 2.1 — **当前默认图像家族**（2026-09-21 起）
#
# 由来：官方模板 `image_qwen_image_2_1_t2i.json` / `image_qwen_image_2_1_image_edit.json`
#  （用户提供），并在本机 ComfyUI 上逐节点核对过（`/object_info`）。
#  与旧 Qwen-Image / Qwen-Image-Edit 2511 相比，这一族不是小版本升级：
#
#  | | 旧 Qwen-Image / Edit 2511 | Qwen Image 2.1 |
#  |---|---|---|
#  | 文本编码 | 两个独立的 ...EditPlus 节点 | 单个 TextEncodeQwenImage21（同时出 positive / negative / latent） |
#  | 参考图怎么起作用 | 只进文本编码器 | 以 **VAE latent** 拼进序列 |
#  | 参考图上限 | 3 张 | **16 张**（COMFY_AUTOGROW_V3，image_1..16） |
#  | 参考图尺寸 | 工作流里 FluxKontextImageScale（~1MP） | 节点自带 `resolution`（0=按原图，N=缩到 N×N 的 32 倍数） |
#  | latent | VAEEncode ← 图1 缩放 | **由编码节点直接给**；画布由 EmptyLatentImage 指定 |
#  | 采样 | 4/8 步 Lightning + shift + CFGNorm | **25 步 cfg 1**，无蒸馏 LoRA + QwenImage21Cache |
#  | t2i / edit | 两套图、两个模型 | **同一张图**，靠 ComfySwitchNode 切 latent 来源 |
#
#  受益最大的三件事：
#   1. **edit 的画幅不再被参考图绑架** —— 旧链路的输出尺寸半刚性地跟着图1 走
#      （2026-09-20 实测：喂 16:9 身份图出 1328×800、喂 1:1 肖像出 1024×1024，
#      9:16 关键帧一张都没落位）。现在画布是 EmptyLatentImage 说了算。
#   2. 参考图从 3 张放开到 16 张 —— 角色 + 道具 + 场景可以一次全给。
#   3. negative 是同编码节点的一个字段，**必须显式填**，否则等于裸跑（UI 里手工
#      导出的模板这里就是空串，写实剧一跑就会被画成插画）。
# ===========================================================================

M_QWEN21_UNET = "qwen_image_2.1_bf16.safetensors"
M_QWEN21_CLIP = "qwen3vl_8b_bf16.safetensors"
M_QWEN21_VAE = "qwen_image_2.1_vae_bf16.safetensors"
# 官方模板的默认值。2.1 **没有**对应的 Lightning/蒸馏 LoRA，所以不存在 4 步档：
# 想快只能减 steps（画质同步下降），不能挂旧 Qwen 的 LoRA（不同骨架）。
QWEN21_STEPS = 25
QWEN21_CFG = 1.0
# 参考图统一缩到这个边长（必须是 32 的倍数）；0 = 每张保留自身尺寸。
# 1024 够编码用，再大只是白烧显存与时间。
QWEN21_RESOLUTION = 1024
# COMFY_AUTOGROW_V3 在这个节点上暴露的最大槽位数（image_1..image_16）。
QWEN21_MAX_IMAGES = 16

M_H3_UNET = "h3\\minimax_h3_fl2va_pruned_int8_convrot.safetensors"
M_H3_UNET_REF = "h3\\minimax_h3_ref2va_pruned_int8_convrot.safetensors"
# ── FastH3（FastVideo 的蒸馏版 + VSA 稀疏注意力）───────────────────────────
# 来历：官方模板 `video_fastvideo_fasth3_i2v.json`（用户 2026-09-16 指出）。
# 用户的实测：**15 秒只要 120 秒，而且尾部干净**（我们这个 fl2va 链路
# 在 768×1344 下 13.5 秒之后必崩）。
#
# `BlockSparseAttention` 的 tooltip 原文：
#   "vsa: Video Sparse Attention (FastVideo) uses 3D video-cube tiling and a learned
#    coarse attention branch; **requires FastH3 model weights**."
#   keep_percent: "**FastH3-VSA checkpoints are trained at 10**"
#   sink_conditioning=exact_kv_and_rows: "MiniMax-H3 only. … additionally runs the
#    target-audio query rows dense (**keeps generated audio intact**)"
M_H3_UNET_FAST = "h3\\fastvideo_fasth3_8step_v2_pruned_int8_convrot.safetensors"
M_H3_CLIP = "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"
M_H3_VIDEO_VAE = "h3\\minimax_h3_video_vae_fp16.safetensors"
M_H3_AUDIO_VAE = "h3\\minimax_h3_audio_vae_fp32.safetensors"
M_H3_LORA_4STEP = "minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors"
M_H3_LORA_8STEP = "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors"

# ── H3 三档预设（照 DramaClaw 的 MINIMAX_H3_PROFILES）─────────────────────
# **关键：8 步配的是「8 步专用 LoRA」**（minimax_h3_fl2v_turbo_8step_v1.0），
# 不是拿 4 步的 LoRA 硬跑 8 步 —— 那是离线的，实测尾部照样崩。
H3_PROFILES = {
    "draft":    {"steps": 4,  "lora": M_H3_LORA_4STEP},
    "balanced": {"steps": 8,  "lora": M_H3_LORA_8STEP},
    "final":    {"steps": 20, "lora": None},
    # ── FastH3：**不挂 LoRA**（模型自带 8 步蒸馏），必须配 VSA ────────────
    # 官方的 Fasth3 预设就是 8 步 + VSA 稀疏注意力，不用 turbo LoRA。
    "fast":     {"steps": 8,  "lora": None, "unet": M_H3_UNET_FAST, "vsa": True,
                 "shift_video": 10.0},
}

M_MUSIC_UNET = "minimax_music3_dit_fp16.safetensors"
M_MUSIC_CLIP = "minimax_music3_text_encoder_pruned_int8_convrot.safetensors"
M_MUSIC_VAE = "minimax_music3_dav.safetensors"


# ===========================================================================
#  Sizes
# ===========================================================================

IMAGE_RATIO_MAP = {
    "1:1": (1024, 1024),
    "16:9": (1024, 576),
    "9:16": (576, 1024),
    "4:3": (1024, 768),
    "3:4": (768, 1024),
    "3:2": (1152, 768),
    "2:3": (768, 1152),
    "21:9": (1344, 576),
}
IMAGE_DEFAULT = (1024, 576)

VIDEO_RATIO_MAP = {
    "1:1": (672, 672),
    "16:9": (864, 480),
    "9:16": (480, 864),
    "4:3": (896, 672),
    "3:4": (672, 896),
    "3:2": (864, 576),
    "2:3": (576, 864),
    "21:9": (896, 384),
}
VIDEO_DEFAULT = (864, 480)


# ===========================================================================
#  Image style presets
#
#  ``positive`` is appended to the user's prompt; ``negative`` replaces the
#  negative conditioning entirely. "none" contributes nothing.
# ===========================================================================

IMAGE_STYLE_PRESETS = {
    "realistic": {
        "label": "写实摄影",
        "positive": (
            "写实摄影风格，非商业修图，保留轻微噪点，高光不过曝，阴影有细节，"
            "皮肤通透自然，表情松弛自然，眼神自然不失真，光影自然，"
            "氛围感情绪片，生活快照般随手抓拍，CCD质感，大师作品"
        ),
        "negative": (
            "塑料感，油腻感，过度磨皮，过度锐化，AI感，CG感，卡通，动漫，畸变，"
            "多余手指，肢体畸形，过度饱和，文字，水印，logo，签名"
        ),
    },
    "anime": {
        "label": "动漫",
        "positive": "2D 动漫风格，柔和赛璐璐上色，清晰线条，明亮通透配色",
        "negative": "写实照片，真人，3D渲染，粗糙线条，脏乱背景，低清晰度",
    },
    "cyberpunk": {
        "label": "赛博朋克",
        "positive": "赛博朋克风格，霓虹灯，雨夜，玻璃反射，全息投影，高对比冷暖撞色",
        "negative": "模糊，噪点过多，光线平淡，过曝，灰蒙蒙",
    },
    "healing": {
        "label": "治愈系",
        "positive": "治愈系风格，柔和温暖光线，浅景深，柔焦，干净通透，舒适氛围",
        "negative": "阴冷，脏乱，高对比，暗角，压抑，恐怖",
    },
    "vintage": {
        "label": "复古胶片",
        "positive": "复古胶片质感，颗粒感，暖黄色调，漏光，老式胶片色彩",
        "negative": "数码感，过于清晰，现代感，冷色调，塑料质感",
    },
    "none": {
        "label": "无增强（原样）",
        "positive": "",
        "negative": "",
    },
}


# ===========================================================================
#  MiniMax H3 — video with native stereo audio
# ===========================================================================

H3_FPS = 24.0
H3_MAX_SECONDS = 15.0

H3_FIELD_MARKERS = (
    "integrated_multimodal_description:",
    "overall_soundscape:",
    "non_diegetic_music:",
)

H3_TASK_LABELS = {
    "t2v": "t2v — 文生视频(Text to Video)",
    "i2v": "i2v — 图生视频(Image to Video)",
    "fl2v": "fl2v — 首尾帧生视频(First-Last Frame)",
    "r2v": "r2v — 参考主体生视频(Reference to Video)",
}

#  Each shell is the official three-part wrapper H3 was trained on. The
#  user's own words land in ``integrated_multimodal_description``; the other
#  two parts describe sound, which H3 models jointly with the picture.
STYLE_PRESETS = {
    "cinematic": {
        "label": "电影感 (Live-action, cinematic)",
        "style_tag": "Live-action, cinematic and photorealistic",
        "camera": "The camera holds a stable framing with subtle natural motion and gentle depth-of-field shifts.",
        "soundscape": "Subtle environmental ambience matching the scene. No dialogue.",
        "music": "N/A",
    },
    "anime": {
        "label": "动漫 (2D-animated, anime)",
        "style_tag": "2D-animated, anime style with soft cel shading and warm color grading",
        "camera": "The camera slowly drifts forward at a calm pace, keeping the subject centered.",
        "soundscape": "Soft ambient tone with light environmental cues. No dialogue.",
        "music": "Gentle piano with sustained strings.",
    },
    "product": {
        "label": "产品展示 (Live-action, cinematic product film)",
        "style_tag": "Live-action, cinematic product film with shallow depth of field and controlled studio lighting",
        "camera": "The camera makes a slow, small-amplitude push toward the subject while the lighting stays consistent.",
        "soundscape": "Clean studio ambience with subtle environmental detail. No dialogue.",
        "music": "Three isolated felt-piano strikes sound during the first half, then fade out.",
    },
    "healing": {
        "label": "治愈系 (warm, soft healing aesthetic)",
        "style_tag": "Warm soft lighting, Studio Ghibli-inspired healing aesthetic with delicate detail",
        "camera": "The camera holds a steady frame with slow, gentle parallax and soft focus transitions.",
        "soundscape": "Warm ambient room tone with light wind and distant natural sound. No dialogue.",
        "music": "Soft acoustic guitar with light piano arpeggios.",
    },
    "cyberpunk": {
        "label": "赛博朋克 (Live-action, neon-noir)",
        "style_tag": "Live-action, neon-noir cyberpunk aesthetic with anamorphic lens, volumetric fog, and rain-slick reflections",
        "camera": "The camera slowly dollies forward through the environment with cinematic depth-of-field shifts.",
        "soundscape": "Distant traffic hum, electric buzz, light rain on metal, footsteps on wet pavement. No dialogue.",
        "music": "Low synthetic pulse with sparse bass and sustained pads.",
    },
    "none": {
        "label": "不套壳（按官方格式原样使用）",
        "style_tag": "",
        "camera": "",
        "soundscape": "Ambient environmental sound matching the scene. No dialogue.",
        "music": "N/A",
    },
}


# ===========================================================================
#  Shared helpers
# ===========================================================================

def _seed(seed) -> int:
    """Resolve a caller seed.

    ``None`` and any negative value mean "pick one" (the CLI passes ``-1`` when
    the caller did not choose); ComfyUI rejects a negative seed outright.
    """
    if seed is None:
        return random.randint(0, 2147483647)
    value = int(seed)
    if value < 0:
        return random.randint(0, 2147483647)
    return value


def snap_multiple(value: int, multiple: int) -> int:
    """Round ``value`` down to the nearest multiple of ``multiple``."""
    return (int(value) // int(multiple)) * int(multiple)


def snap_frames(seconds: float, fps: float = H3_FPS) -> tuple[int, float]:
    """Snap a duration onto H3's frame grid.

    H3 only renders lengths of the form ``17k + 5`` frames, so ask for the
    nearest grid point rather than the next one up — a 5-second request lands
    on 124 frames (5.17s), which is the expected result, not drift.
    """
    seconds = max(0.0, min(float(seconds), H3_MAX_SECONDS))
    k = round((seconds * fps - 5) / 17)
    frames = 17 * max(0, k) + 5
    return frames, frames / fps


def resolve_size(ratio: str | None, mode: str, width=None, height=None):
    """Resolve an output size: explicit pixels win, then the mode's ratio table.

    An unknown or missing ratio falls back to the mode's default size.
    """
    if width and height:
        return int(width), int(height)
    video = mode in H3_TASK_LABELS
    table = VIDEO_RATIO_MAP if video else IMAGE_RATIO_MAP
    fallback = VIDEO_DEFAULT if video else IMAGE_DEFAULT
    pair = table.get(ratio, fallback)
    return int(pair[0]), int(pair[1])


def looks_like_h3_format(text: str) -> bool:
    """True when the caller already wrote the official three-part shell."""
    return any(marker in text for marker in H3_FIELD_MARKERS)


# ── H3 官方提示词结构（照 MiniMax 官方 h3-prompt-writing skill）─────────────
# 出处：DramaClaw 的 src/novelvideo/generators/h3_prompt_composer.py
#      再往上溯源 https://github.com/MiniMax-AI/MiniMax-H3/tree/main/skills/h3-prompt-writing
#
# 上一版我只会套个"三段式外壳"，缺了四样官方规范里明明有的东西：
#   ① i2va/fl2va/l2va 的**对齐句**（写明 <Picture 1> 对应 0.00 秒）
#   ② 每种模式的**锚点句**（"Begin from <Picture 1>, preserving its subject identity, face, …"）
#   ③ `[Shot 1] … lasting {duration} seconds.` 里的**时长**（官方硬夹 4–15 秒）
#   ④ r2v 的 **6 字段**结构（subject_definitions / summary / retention_analysis / …）

H3_MIN_SECONDS = 4.0
H3_MAX_CLIP_SECONDS = 15.0

H3_PROMPT_MODE = {"t2v": "t2va", "i2v": "i2va", "fl2v": "fl2va", "r2v": "ref2va"}

H3_ALIGNMENT = {
    "i2va": (
        "For the target video, at 0.00 seconds into the target video, "
        "<Picture 1> (from [Shot 1]) is fully referenced."
    ),
    "fl2va": (
        "How the reference pictures align with the target video — Picture 1 "
        "(from Shot 1) aligns with the 0.00-second mark of the target video; "
        "Picture 2 (from Shot 1) aligns with the {duration}-second mark of the target video."
    ),
    "l2va": (
        "How the reference pictures align with the target video — <Picture 1> "
        "(from [Shot 1]) aligns with the {duration}-second mark of the target video."
    ),
}

H3_ANCHOR = {
    "t2va": "Build the complete audiovisual timeline from the description.",
    "i2va": (
        "Begin from <Picture 1>, preserving its subject identity, face, clothing, "
        "composition, lighting, and scene."
    ),
    "fl2va": (
        "Begin exactly from Picture 1 and describe observable continuous motion "
        "that reaches Picture 2 at the final moment."
    ),
    "l2va": (
        "Infer a plausible earlier state and converge continuously to the exact "
        "composition of <Picture 1> at the final moment."
    ),
}

H3_SOUNDSCAPE = (
    "Natural ambience and physical action sounds remain synchronized with the visible events."
)
H3_MUSIC = (
    "Emotion-matched cinematic instrumental music supports the scene and evolves naturally "
    "with the action and camera movement. Use no lyrics, singing, spoken words, or voiceover, "
    "and mix the music below the natural ambience and any dialogue the user adds later."
)
H3_CAMERA_LINE = (
    "The camera movement uses a concrete motion type, amplitude, and speed, "
    "and the shot resolves within the requested duration."
)
H3_RETENTION = (
    "Preserve the primary subject identity, face, clothing, scene geometry, and reference "
    "hierarchy. Transfer only the declared role of each auxiliary reference; do not merge "
    "subjects or create a slideshow."
)


def h3_clamp_duration(seconds: float) -> float:
    """官方时长区间：**4–15 秒**（照 DramaClaw 的 ``_duration_text``）。"""
    return min(H3_MAX_CLIP_SECONDS, max(H3_MIN_SECONDS, float(seconds)))


def format_to_h3_prompt(
    user_input: str,
    style: str = "cinematic",
    *,
    task_key: str = "t2v",
    duration: float = 5.0,
    n_pictures: int = 0,
    n_videos: int = 0,
    n_audios: int = 0,
) -> str:
    """把大白话包进 H3 的**官方**提示词结构。

    已经手写成官方格式的输入原样放行 —— 调用方想自己写也完全可以。
    ``style="none"`` 时也原样返回。
    """
    if looks_like_h3_format(user_input):
        return user_input

    preset = STYLE_PRESETS.get(style) or STYLE_PRESETS["cinematic"]
    if not preset["style_tag"]:
        # "none" —— 调用方要自己的原话
        return user_input

    mode = H3_PROMPT_MODE.get(task_key, "t2va")
    duration_text = f"{h3_clamp_duration(duration):.2f}"
    action = user_input.strip()

    shot = (
        f"[Shot 1] {preset['style_tag']}, a continuous shot lasting "
        f"{duration_text} seconds. {action}"
    )
    shot += " " + (preset["camera"] or H3_CAMERA_LINE)

    # ── ref2va：官方 6 字段 ────────────────────────────────────────────────
    if mode == "ref2va":
        labels = (
            [f"<Picture {i}>" for i in range(1, n_pictures + 1)]
            + [f"<Video {i}>" for i in range(1, n_videos + 1)]
            + [f"<Audio {i}>" for i in range(1, n_audios + 1)]
        )
        definitions = (
            "; ".join(f"{label} is used only for auxiliary reference" for label in labels)
            if labels
            else "No external reference labels were supplied."
        )
        summary = (
            "The designated speaker says the exact words with the exact timing of <Audio 1>; "
            f"all other people remain silent and react naturally. {action}"
            if n_audios == 1
            else action
        )
        return "\n".join(
            (
                f"subject_definitions: {definitions}",
                f"summary: {summary}",
                f"retention_analysis: {H3_RETENTION}",
                f"detailed_description: {shot}",
                f"overall_soundscape: {H3_SOUNDSCAPE}",
                f"non_diegetic_music: {H3_MUSIC}",
            )
        )

    # ── t2va / i2va / fl2va / l2va：对齐句 + 三段字段 ──────────────────────
    body = f"{shot} {H3_ANCHOR.get(mode, '')}".strip()
    fields = "\n".join(
        (
            f"integrated_multimodal_description: {body}",
            f"overall_soundscape: {H3_SOUNDSCAPE}",
            f"non_diegetic_music: {H3_MUSIC}",
        )
    )
    alignment = H3_ALIGNMENT.get(mode)
    if alignment:
        return f"{alignment.format(duration=duration_text)}\n\n{fields}"
    return fields


# ===========================================================================
#  Image graphs
# ===========================================================================

def build_t2i(
    prompt: str,
    *,
    width: int,
    height: int,
    seed=None,
    steps: int = 20,
    cfg: float = 4.0,
    style: str = "realistic",
    batch: int = 1,
    lora: str | None = None,
    lora_strength: float = 1.0,
    unet: str = M_QWEN_T2I,
    shift: float | None = None,
) -> dict:
    """Text-to-image with Qwen-Image."""
    preset = IMAGE_STYLE_PRESETS.get(style, {"positive": "", "negative": ""})
    positive = prompt if not preset["positive"] else f"{prompt}，{preset['positive']}"
    negative = preset["negative"]

    graph = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": unet, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": M_QWEN_CLIP, "type": "qwen_image", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": M_QWEN_VAE}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"text": positive, "clip": ["2", 0]}},
        "5": {"class_type": "CLIPTextEncode", "inputs": {"text": negative, "clip": ["2", 0]}},
        "6": {"class_type": "EmptyLatentImage", "inputs": {"width": int(width), "height": int(height), "batch_size": int(batch)}},
        "7": {"class_type": "KSampler", "inputs": {
            "model": ["1", 0], "seed": _seed(seed), "steps": int(steps), "cfg": float(cfg),
            "sampler_name": "euler", "scheduler": "normal",
            "positive": ["4", 0], "negative": ["5", 0], "latent_image": ["6", 0], "denoise": 1.0,
        }},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["3", 0]}},
        "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0], "filename_prefix": "img/Qwen_t2i"}},
    }
    # 模型链按 UNET → LoRA → ModelSamplingAuraFlow 串起来。
    # t2i 的采样修正值是 3.1（DramaClaw qwen_text2img.json / .env 同源），与 edit 的 3 不同；
    # 两个通道各配各的，别串。
    model_ref = ["1", 0]
    if lora:
        graph["10"] = {"class_type": "LoraLoaderModelOnly", "inputs": {
            "model": model_ref, "lora_name": lora, "strength_model": float(lora_strength),
        }}
        model_ref = ["10", 0]
    if shift is not None:
        graph["11"] = {"class_type": "ModelSamplingAuraFlow", "inputs": {
            "model": model_ref, "shift": float(shift),
        }}
        model_ref = ["11", 0]
    graph["7"]["inputs"]["model"] = model_ref
    return graph


def build_edit(
    prompt: str,
    images: list[str],
    *,
    seed=None,
    steps: int = 20,
    cfg: float = 4.0,
    style: str = "realistic",
    lora: str | None = None,
    lora_strength: float = 1.0,
    unet: str = M_QWEN_EDIT,
    size: tuple[int, int] | None = None,
    shift: float | None = None,
    cfgnorm: float | None = None,
) -> dict:
    """Instruction edit of one or more images with Qwen-Image-Edit.

    The first image is scaled through FluxKontextImageScale and encoded; every
    image also enters the text encoder as a reference, which is how the edit
    prompt can refer to "image 1", "image 2".

    ## `size`（2026-09-20 no_chute 实测踩坑）

    默认 None：图1 过 FluxKontextImageScale（~1MP 预算），输出尺寸跟随图1 ——
    这会把 edit 输出焊死在约 576×1024。低分辨率 latent 上"高反差"被执行成
    整块黑、"面部清楚可辨"等精细指令没有容量执行（同提示词同参考图在 2K
    工作流下全部正常，DramaClaw 对照实测）。显式传 ``(width, height)`` 时
    改用 ImageScale 绝对缩放，输出尺寸由调用方决定。

    ## `--style` 必须在这里生效（2026-09-20 no_chute 实测踩坑）

    此前 edit 分支的 negative 是**硬编码空串**，画质预设完全不参与：
    写实剧的身份图与关键帧被系统性画成插画/动漫风，而同一通道的 t2i
    （肖像、场景主图）因为有 `realistic` 预设的负向词「CG感，卡通，动漫」
    一直正常。当时误判为"模型能力问题"和"多面板版面分辨率不足"，
    真因是**负向条件根本没送进采样器**。

    后果不止风格：edit 是身份图与**全部关键帧**走的通道，等于成片每一帧
    都没有画质防线。这里与 `build_t2i` 对齐：positive 追加、negative 取预设。
    `style="none"` 时两者皆空，行为与改动前完全一致（向后兼容的逃生口）。
    """
    if not images:
        raise ValueError("edit 模式至少需要一张图片")
    if len(images) > 3:
        raise ValueError("edit 模式最多支持 3 张图片")

    preset = IMAGE_STYLE_PRESETS.get(style, {"positive": "", "negative": ""})
    positive = prompt if not preset["positive"] else f"{prompt}，{preset['positive']}"
    negative = preset["negative"]

    if size:
        base_image = (
            {"class_type": "ImageScale",
             "inputs": {"image": ["20", 0], "upscale_method": "lanczos",
                        "width": int(size[0]), "height": int(size[1]), "crop": "disabled"}}
        )
    else:
        base_image = {"class_type": "FluxKontextImageScale", "inputs": {"image": ["20", 0]}}

    graph = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": unet, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": M_QWEN_CLIP, "type": "qwen_image", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": M_QWEN_VAE}},
        "5": base_image,
        "6": {"class_type": "VAEEncode", "inputs": {"pixels": ["5", 0], "vae": ["3", 0]}},
        "9": {"class_type": "KSampler", "inputs": {
            "model": ["1", 0], "seed": _seed(seed), "steps": int(steps), "cfg": float(cfg),
            "sampler_name": "euler", "scheduler": "simple",
            "positive": ["7", 0], "negative": ["8", 0], "latent_image": ["6", 0], "denoise": 1.0,
        }},
        "11": {"class_type": "VAEDecode", "inputs": {"samples": ["9", 0], "vae": ["3", 0]}},
        "12": {"class_type": "SaveImage", "inputs": {"images": ["11", 0], "filename_prefix": "img/Qwen_edit"}},
    }

    reference_inputs = {"clip": ["2", 0], "vae": ["3", 0], "image1": ["5", 0]}
    for offset, image in enumerate(images):
        node_id = str(20 + offset)
        graph[node_id] = {"class_type": "LoadImage", "inputs": {"image": image}}
        if offset:
            reference_inputs[f"image{offset + 1}"] = [node_id, 0]

    graph["7"] = {"class_type": "TextEncodeQwenImageEditPlus", "inputs": {"prompt": positive, **reference_inputs}}
    graph["8"] = {"class_type": "TextEncodeQwenImageEditPlus", "inputs": {"prompt": negative, **reference_inputs}}

    if lora:
        graph["10"] = {"class_type": "LoraLoaderModelOnly", "inputs": {
            "model": ["1", 0], "lora_name": lora, "strength_model": float(lora_strength),
        }}
        model_tail = "10"
        # 蒸馏/Lightning 档必须配这两个节点，否则 4 步 LoRA 出图发灰、指令遵循差。
        # 对齐 DramaClaw 的 qwen_img2img.json（2026-09-20 实测对照）：
        #   ModelSamplingAuraFlow(shift) → CFGNorm(strength) → KSampler
        # 默认 None = 不插入，行为与改动前完全一致（向后兼容）。
        if shift is not None:
            graph["13"] = {"class_type": "ModelSamplingAuraFlow", "inputs": {
                "model": [model_tail, 0], "shift": float(shift),
            }}
            model_tail = "13"
        if cfgnorm is not None:
            graph["14"] = {"class_type": "CFGNorm", "inputs": {
                "model": [model_tail, 0], "strength": float(cfgnorm), "pre_cfg": False,
            }}
            model_tail = "14"
        graph["9"]["inputs"]["model"] = [model_tail, 0]
    return graph


# ===========================================================================
#  Qwen Image 2.1 — one builder for both t2i and edit
# ===========================================================================

def build_image21(
    mode: str,
    prompt: str,
    images: list[str] | None = None,
    *,
    width: int,
    height: int,
    seed=None,
    steps: int = QWEN21_STEPS,
    cfg: float = QWEN21_CFG,
    style: str = "realistic",
    negative: str = "",
    resolution: int = QWEN21_RESOLUTION,
    batch: int = 1,
    cache_device: str = "auto",
    cache_dtype: str = "default",
    append_positive: bool = False,
    unet: str = M_QWEN21_UNET,
    clip: str = M_QWEN21_CLIP,
    vae: str = M_QWEN21_VAE,
) -> dict:
    """Qwen Image 2.1：t2i 与 edit 共用一张图。

    `mode` 只决定一件事：**噪声 latent 从哪来**。
      · ``t2i``  → EmptyLatentImage（凭空起稿）
      · ``edit`` → TextEncodeQwenImage21 的第三个输出（参考图被拼进 latent 序列）

    官方模板就是这么切的（`ComfySwitchNode` 的 ``switch`` 位）。

    ## 为什么这里**不追加** style 的正向句（与旧 build_* 不同，是刻意的）

    旧的 `build_t2i`/`build_edit` 把 `preset["positive"]` 拼到用户提示词后面成一长串。
    代价是：中国的句号 + 英文逗号混出「。，」（2026-09-21 在 not_awake 上查到），
    而且调用方的字数自检**永远看不到这段**（它在交给模型之前才追加，
    明明进了编码器却不占账面字数）。
    2.1 的指令遵循足够强，负向条件已经挡住了「CG感，卡通，动漫」这些真正的风险，
    所以默认只取 negative。真要拿风格句、**显式**开 `append_positive=True`。

    ## `negative` 绝不许为空

    这是这一族最容易踩的坑：UI 里手工导出的模板 `negative_prompt` 就是空串，
    写实剧一跑就被画成插画（和 2026-09-20「edit 分支 negative 硬编码为空」是同一个坑的翻版）。
    `style="none"` 时才允许空 —— 因为那时调用方自己声明了不要任何增强。
    """
    images = list(images or [])
    if mode not in ("t2i", "edit"):
        raise ValueError(f"build_image21 只支持 t2i / edit，收到 {mode!r}")
    if mode == "edit" and not images:
        raise ValueError("edit 模式至少需要一张参考图")
    if len(images) > QWEN21_MAX_IMAGES:
        raise ValueError(f"2.1 最多 {QWEN21_MAX_IMAGES} 张参考图，收到 {len(images)} 张")

    preset = IMAGE_STYLE_PRESETS.get(style, {"positive": "", "negative": ""})
    if append_positive and preset["positive"]:
        positive = f"{prompt}，{preset['positive']}"
    else:
        positive = prompt
    # 调用方自带的负向词排在预设后面，不去重 —— 重复在负向侧几乎无代价，
    # 而漏掉一条（比如某个画面里不该出现的元素）代价很大。
    negative_text = "，".join([p for p in (preset["negative"], negative) if p])
    if mode != "t2i" and style != "none" and not negative_text:
        raise ValueError("2.1 的 edit 必须给出负向条件（style 或 --negative 至少给一个）")

    is_edit = mode == "edit"

    graph = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": unet, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": clip, "type": "qwen_image", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": vae}},
        "6": {"class_type": "EmptyLatentImage", "inputs": {
            "width": int(width), "height": int(height), "batch_size": int(batch),
        }},
        "8": {"class_type": "KSampler", "inputs": {
            "model": ["10", 0], "seed": _seed(seed), "steps": int(steps), "cfg": float(cfg),
            "sampler_name": "euler", "scheduler": "simple",
            "positive": ["7", 0], "negative": ["7", 1], "latent_image": ["11", 0], "denoise": 1.0,
        }},
        "9": {"class_type": "VAEDecode", "inputs": {"samples": ["8", 0], "vae": ["3", 0]}},
        # 前缀对齐官方模板，输出文件名落在 img/ 下，`gen.py` 的收集逻辑不用改。
        "12": {"class_type": "SaveImage", "inputs": {"images": ["9", 0], "filename_prefix": "img/Qwen_image_2.1"}},
    }

    # ── 文本编码（单节点同时出 positive / negative / latent）────────────────
    encoder_inputs = {
        "clip": ["2", 0],
        "prompt": positive,
        "negative_prompt": negative_text,
        "resolution": int(resolution),
    }
    if is_edit:
        # 有图才能拼 latent：这需要 vae，并且 pixel 连到 LoadImage。
        encoder_inputs["vae"] = ["3", 0]
        for offset, image in enumerate(images):
            node_id = str(20 + offset)
            graph[node_id] = {"class_type": "LoadImage", "inputs": {"image": image}}
            encoder_inputs[f"images.image_{offset + 1}"] = [node_id, 0]
    graph["7"] = {"class_type": "TextEncodeQwenImage21", "inputs": encoder_inputs}

    # ── latent 来源 ────────────────────────────────────────────────────────
    # switch=True → 取 EmptyLatentImage（t2i）；False → 取编码节点给出的 latent（edit）。
    graph["11"] = {"class_type": "ComfySwitchNode", "inputs": {
        "switch": not is_edit,
        "on_true": ["6", 0],
        "on_false": ["7", 2],
    }}

    # ── 模型缓存 ───────────────────────────────────────────────────────────
    # 官方模板自带。device="cpu" 时几乎不损失速度却能省一大块显存（tooltip 原文），
    # 4090 跑 bf16 的 8B 文本编码器时这是最先该拧的那个旋钮。
    graph["10"] = {"class_type": "QwenImage21Cache", "inputs": {
        "model": ["1", 0], "device": cache_device, "dtype": cache_dtype,
    }}
    return graph


# ===========================================================================
#  MiniMax H3 video graphs
# ===========================================================================

def _h3_timeline(task_key: str, prompt: str, *, frames: int, width: int, height: int, fps: float = H3_FPS) -> dict:
    """The editor state H3's director node expects, in its own format.

    ``t2v``/``i2v``/``r2v`` use ``segments``; ``fl2v`` uses ``shots`` with an
    explicit start and end image. The node reads this as a JSON string.
    """
    label = H3_TASK_LABELS[task_key]
    # The director treats ``width`` as the reference long edge, portrait or not.
    long_edge = width
    duration = frames / fps

    output = {
        "mode": "fixed", "longEdge": long_edge, "width": width, "height": height,
        "maxExportFrames": 0, "exportMode": "all",
        "continuityEnabled": False, "continuityOverlapFrames": 9, "audioMode": "generate",
    }
    video = {"fileName": "", "videoFile": "", "subfolder": "", "type": "input", "frames": [], "frameMap": []}
    gen = {"defaultFrameCount": frames}

    if task_key == "fl2v":
        return {
            "version": 4,
            "timelineMode": task_key,
            "totalFrames": frames, "frameRate": fps, "width": width, "height": height,
            "refMaxSize": long_edge,
            "output": output,
            "video": video,
            "global": {
                "taskType": label, "prompt": prompt, "refs": [], "referenceVideo": {},
            },
            "gen": gen,
            "shots": [],
        }

    segment = {
        "id": "s0", "start": 0, "length": frames, "frameCount": frames, "durationSec": duration,
        "prompt": "", "taskType": "", "refs": [], "referenceVideo": {},
        "genImage": {"imageFile": ""}, "negativePrompt": "",
    }
    return {
        "version": 4,
        "editMode": "segment" if task_key == "r2v" else "global",
        "timelineMode": task_key,
        "totalFrames": frames, "frameRate": fps, "width": width, "height": height,
        "refMaxSize": long_edge,
        "output": output,
        "videoClips": [],
        "video": video,
        "global": {
            "taskType": label, "prompt": prompt, "refs": [], "referenceVideo": {},
            "continuousReference": False, "genImage": {"imageFile": ""},
        },
        "segments": [segment],
        "gen": gen,
        "runSelectEnabled": False,
        "runSelection": [],
    }


def build_h3(
    task_key: str,
    prompt: str,
    *,
    frames: int,
    width: int,
    height: int,
    seed=None,
    steps: int = 4,
    cfg: float = 1.0,
    sampler: str = "res_multistep",
    scheduler: str = "simple",
    denoise: float = 1.0,
    shift_video: float = 12.0,
    shift_audio: float = 3.0,
    lora: str | None = None,
    lora_strength: float = 1.0,
    image: str | None = None,
    last_image: str | None = None,
    refs: list[str] | None = None,
    unet: str = M_H3_UNET,
    megapixels: float = 0.92,
    sage: bool = True,
    vsa: bool = False,
) -> dict:
    """MiniMax H3 —— **官方节点链路**。

    ## 为什么重写（2026-09-16）

    上一版把这个图收缩成一个第三方节点 ``MiniMaxH3Director``，靠我手抄的
    ``timeline_data`` JSON 去驱动它。那条路带来一串问题：尾部崩坏、参数不可控、
    步数想换也没法换、还要跟着第三方插件升级。

    **现在照 DramaClaw 里那套拍平的官方链路重建**
    （``E:\\AI-Image\\DramaClaw\\DramaClawLocalhost\\src\\novelvideo\\generators\\minimax-h3-base-v2_sage.json``）：

    ```
    UNETLoader ─┬─> [LoRA] ─> MiniMaxH3SigmaShift ─┬─> BasicScheduler   (未打 Sage)
                │                                   └─> [Sage] ─> BasicGuider
    CLIPLoader ─┴─> MiniMaxH3ImageToVideo ──(cond, latent)──> SamplerCustomAdvanced
                                                                      │
                                            VAEDecode / VAEDecodeAudio┴─> CreateVideo -> SaveVideo
    ```

    **三条容易接错的线**（照抄 DramaClaw）：
    1. ``BasicScheduler.model`` 接**没打 Sage** 的模型 —— sigmas 由它出
    2. ``BasicGuider.model`` 接**打了 Sage** 的模型
    3. ``SamplerCustomAdvanced.latent_image`` 接条件节点的**第 1 个**输出（latent），
       ``BasicGuider.conditioning`` 接**第 0 个**（conditioning）

    ## 帧数与时长

    官方 ``MiniMaxH3ImageToVideo.length`` 的提示原文：
    *"trained range is ~124-362, longer is untested"* —— **124~362 帧
    （5.2~15.1 秒）是训练区间，再长没测过。** 帧数按 ``17k+5`` 网格吸附。
    """
    if task_key not in H3_TASK_LABELS:
        raise ValueError(f"未知的 H3 任务类型：{task_key}")
    refs = list(refs or [])

    if task_key == "i2v" and not image:
        raise ValueError("i2v 需要一张首帧图片")
    if task_key == "r2v" and not refs:
        raise ValueError("r2v 至少需要一张参考图")
    if task_key == "fl2v" and (not image or not last_image):
        raise ValueError("fl2v 需要首帧和尾帧两张图片")

    # 帧数吸附到 17k+5 网格 —— 官方节点自己也会吸，但显式算一遍便于核对
    snapped = max(5, int(round(frames)))
    snapped = 17 * round((snapped - 5) / 17) + 5

    graph: dict = {
        # ── 加载 ──────────────────────────────────────────────────────────
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": unet, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": M_H3_CLIP, "type": "minimax", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": M_H3_VIDEO_VAE}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": M_H3_AUDIO_VAE}},
        # ── 条件 ──────────────────────────────────────────────────────────
        "10": {"class_type": "MiniMaxH3ReferenceToVideo" if task_key == "r2v" else "MiniMaxH3ImageToVideo",
               "inputs": {"prompt": prompt, "width": int(width), "height": int(height),
                          "length": snapped, "clip": ["2", 0], "vae": ["3", 0]}},
        # ── 采样 ──────────────────────────────────────────────────────────
        "5": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": sampler}},
        "6": {"class_type": "BasicScheduler", "inputs": {
            "scheduler": scheduler, "steps": int(steps), "denoise": float(denoise), "model": ["1", 0]}},
        "7": {"class_type": "RandomNoise", "inputs": {"noise_seed": _seed(seed)}},
        "8": {"class_type": "BasicGuider", "inputs": {"model": ["1", 0], "conditioning": ["10", 0]}},
        "9": {"class_type": "SamplerCustomAdvanced", "inputs": {
            "noise": ["7", 0], "guider": ["8", 0], "sampler": ["5", 0],
            "sigmas": ["6", 0], "latent_image": ["10", 1]}},
        # ── 解码 / 输出 ───────────────────────────────────────────────────
        "30": {"class_type": "VAEDecode", "inputs": {"samples": ["9", 0], "vae": ["3", 0]}},
        "31": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["9", 0], "vae": ["4", 0]}},
        "32": {"class_type": "CreateVideo", "inputs": {
            "images": ["30", 0], "audio": ["31", 0], "fps": H3_FPS, "bit_depth": 8}},
        "33": {"class_type": "SaveVideo", "inputs": {
            "video": ["32", 0], "filename_prefix": f"video/H3_{task_key}", "format": "auto", "codec": "auto"}},
    }

    # r2v 走 ref2va 权重，并且参考图是 autogrow 输入 ref_image_1..9
    if task_key == "r2v":
        graph["1"]["inputs"]["unet_name"] = M_H3_UNET_REF
        graph["10"]["inputs"]["audio_vae"] = ["4", 0]
        graph["10"]["inputs"]["ref_image_size"] = "match"

    # ── 图片输入：先缩放再进条件节点 ─────────────────────────────────────
    # 官方模板用 ImageScaleToTotalPixels(megapixels≈0.9, resolution_steps=32)。
    # 注意多个输入图共用一个缩放节点是不行的，所以每张一个。
    #
    # ⚠ **节点 ID 不能和别的段撞。** 第一版 ref 图用 `"4"+index` → "41"/"42"/"43"，
    # 而 VSA 的 `BlockSparseAttention` 也占 "41" —— 那段在后面执行，把 LoadImage
    # **覆盖**了，于是 "41b" 拿到的是 MODEL 而不是图片，报
    # `'ModelPatcherDynamic' object has no attribute 'movedim'`。
    # 现在统一用业务前缀：`img_*`（首尾帧）/ `ref_*`（参考图）。
    def _add_image(slot: str, filename: str, tag: str) -> list:
        nid = f"img_{tag}"
        graph[nid] = {"class_type": "LoadImage", "inputs": {"image": filename}}
        graph[f"{nid}_scale"] = {"class_type": "ImageScaleToTotalPixels", "inputs": {
            "image": [nid, 0], "upscale_method": "nearest-exact",
            "megapixels": float(megapixels), "resolution_steps": 32}}
        return [f"{nid}_scale", 0]

    # ⚠ `MiniMaxH3ReferenceToVideo`（r2v）**没有 first_frame / last_frame 输入** ——
    # 它的参考一律走 `ref_image_N`。第一版没分开，r2v 时也塞了 first_frame，
    # 报 `execute() got an unexpected keyword argument 'first_frame'`。
    # 所以首尾帧**只在 i2v 分支接**；r2v 的关键帧由调用方放进 `refs[0]`。
    if task_key != "r2v":
        if image:
            graph["10"]["inputs"]["first_frame"] = _add_image("first_frame", image, "first")
        if last_image:
            graph["10"]["inputs"]["last_frame"] = _add_image("last_frame", last_image, "last")
    if task_key == "r2v":
        # ⚠ **autogrow 的输入名是点号 + 0 起**：`ref_images.ref_image_0` … `ref_image_8`。
        #
        # 下标从 **0** 开始（`TemplatePrefix`: `names = [f"{prefix}{i}" for i in range(max)]`），
        # 而且要带上父名 `ref_images.`（`finalize_prefix(["ref_images"], "ref_image_0")`）。
        # 只写 `ref_image_1` 会报 `execute() got an unexpected keyword argument 'ref_image_1'`；
        # 写成 1 起又会漏掉第 0 个槽。**跟 DynamicCombo 的 `selection.keep_percent` 是同一个规矩。**
        for index, ref in enumerate(refs[:9]):
            graph["10"]["inputs"][f"ref_images.ref_image_{index}"] = _add_image("ref", ref, f"r{index + 1}")

    # ── 模型链：LoRA → SigmaShift →（Sage 只给 guider）──────────────────
    model_ref: list = ["1", 0]
    if lora:
        graph["20"] = {"class_type": "LoraLoaderModelOnly", "inputs": {
            "model": model_ref, "lora_name": lora, "strength_model": float(lora_strength)}}
        model_ref = ["20", 0]

    # SigmaShift 同时决定采样器的 sigma 曲线（ModelSamplingAV），必须接在 scheduler 前
    graph["21"] = {"class_type": "MiniMaxH3SigmaShift", "inputs": {
        "model": model_ref, "shift_video": float(shift_video), "shift_audio": float(shift_audio)}}
    model_ref = ["21", 0]

    # 实测（DramaClaw）：Sage 只接到 BasicGuider，BasicScheduler 用没打的
    graph["6"]["inputs"]["model"] = model_ref
    # **VSA 开着的时候不要 Sage** —— 官方 FastH3 模板里没有 Sage，而
    # `ModelAttentionBackend` 会把注意力后端换成 "comfy kitchen attention"，
    # 两个补丁叠在一起可能互相打架。严格照官方来。
    if sage and not vsa:
        graph["22"] = {"class_type": "PathchSageAttentionKJ", "inputs": {
            "model": model_ref, "sage_attention": "auto", "allow_compile": False}}
        graph["8"]["inputs"]["model"] = ["22", 0]
    else:
        graph["8"]["inputs"]["model"] = model_ref

    # ── VSA 稀疏注意力（FastH3 专用）────────────────────────────────────
    # 照官方模板 `video_fastvideo_fasth3_i2v.json` 的子图拓扑：
    #   UNETLoader → SigmaShift → ModelAttentionBackend → BlockSparseAttention
    #                                        ┌──────────────┴──────────────┐
    #                                  BasicScheduler                  BasicGuider
    # **两个都接稀疏后的 model**（和 Sage 那条不一样，Sage 只给 guider）。
    #
    # 参数照抄官方模板：vsa / keep_percent=10（tooltip 说 FastH3-VSA 就是在 10 训练的）/
    # start_percent=0.2（前 20% 步保持 dense）/ min_tokens=12288 /
    # sink_conditioning=exact_kv_and_rows（保住生成音频）。
    if vsa:
        graph["40"] = {"class_type": "ModelAttentionBackend", "inputs": {
            "model": model_ref, "attention": "comfy kitchen attention"}}
        # ⚠ `selection` 是 **DynamicCombo**，它的子参数在 API 格式里是**点号名**：
        #    `selection.keep_percent`（不是裸的 `keep_percent`）。
        #    第一次写错时 ComfyUI 报的是 "required_input_missing / keep_percent /
        #    input_name=selection.keep_percent"，照它改的。
        graph["41"] = {"class_type": "BlockSparseAttention", "inputs": {
            "model": ["40", 0],
            "selection": "vsa",
            "selection.keep_percent": 10.0,
            "start_percent": 0.2,
            "end_percent": 1.0,
            "dense_blocks": "",
            "min_tokens": 12288,
            "extra_tokens": 256,
            "sink_conditioning": "exact_kv_and_rows",
            "verbose": False,
        }}
        graph["6"]["inputs"]["model"] = ["41", 0]
        graph["8"]["inputs"]["model"] = ["41", 0]

    return graph


# ===========================================================================
#  Music
# ===========================================================================

def build_music(
    caption: str,
    *,
    lyrics: str = "",
    duration: float = 60.0,
    seed=None,
    steps: int = 30,
    cfg: float = 1.7,
    top_k: int = 50,
    batch: int = 1,
) -> dict:
    """MiniMax Music 3 — a caption describes the music, lyrics carry structure."""
    resolved = _seed(seed)
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": M_MUSIC_UNET, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": M_MUSIC_CLIP, "type": "minimax", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": M_MUSIC_VAE}},
        "4": {"class_type": "MiniMaxMusic3TextEncode", "inputs": {
            "clip": ["2", 0], "caption": caption, "lyrics": lyrics, "seed": resolved,
            "max_duration": float(duration), "cfg_scale": float(cfg), "top_k": int(top_k),
        }},
        "5": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["4", 0]}},
        "6": {"class_type": "EmptyMiniMaxMusic3LatentAudio", "inputs": {"seconds": ["4", 1], "batch_size": int(batch)}},
        "7": {"class_type": "KSampler", "inputs": {
            "model": ["1", 0], "seed": resolved, "steps": int(steps), "cfg": float(cfg),
            "sampler_name": "euler", "scheduler": "simple",
            "positive": ["4", 0], "negative": ["5", 0], "latent_image": ["6", 0], "denoise": 1.0,
        }},
        "8": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["7", 0], "vae": ["3", 0]}},
        "9": {"class_type": "SaveAudio", "inputs": {"audio": ["8", 0], "filename_prefix": "audio/Music3"}},
    }
