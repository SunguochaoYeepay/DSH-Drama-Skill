# FastH3 attention A/B, 2026-09-18

Standalone technical benchmark only. These videos are not approved production clips.

- Source: `keyframes_render/g001.png`
- FastH3 8-step checkpoint, I2V, 480x864, 124 frames / 5.17 s
- Seed: 424242 (confirmed in ComfyUI history node `RandomNoise`)
- Prompt: `固定机位，清晨的卧室，人物在床上慢慢睁眼并抬头，柔和晨光；轻微环境音，无台词。`
- Same sampler and schedule for all variants. ComfyUI was already running with global `--use-sage-attention`; true dense explicitly patches `ModelAttentionBackend` to `pytorch attention`.

| Variant | Total elapsed | ComfyUI execution | Output | Contact sheet |
|---|---:|---:|---|---|
| VSA first (cold) | 55.8 s | 54.2 s | `i2v_20260918-100733.mp4` | `vsa.contact.png` |
| Global Sage, no per-model patch | 38.2 s | 37.0 s | `i2v_20260918-100917.mp4` | - |
| Explicit PyTorch dense | 50.0 s | 48.9 s | `i2v_20260918-101042.mp4` | `dense.contact.png` |
| Explicit Sage node | 38.2 s | 37.0 s | `i2v_20260918-101135.mp4` | `sage.contact.png` |
| VSA warm | 37.0 s | 35.9 s | `i2v_20260918-101234.mp4` | - |

All clips decode fully and contain video and audio streams. The warm runs cached model loading and preprocessing nodes, not the sampler. VSA uses `BlockSparseAttention(selection=vsa)` plus `comfy kitchen attention`; Sage uses `PathchSageAttentionKJ`. Runtime kernel-call/fallback telemetry was not captured, so the evidence proves successful patched-graph execution, not a measured sparse-kernel call count.

This is one five-second test, not a robust speed or quality estimate for 10-15 second production units. VSA changes the visible motion/expression relative to Sage and dense even at the same seed. No caching plugin was installed or tested.
