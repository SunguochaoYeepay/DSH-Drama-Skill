# 关键帧人工审阅

机器检查只能判定是否可送审。请逐张查看人物身份、体型比例、构图、动作起点和场景连续性。

- g001.png: E:\AI-Tool\DeepSeek\story2video\projects\half_step\keyframes_render\g001.png
- g002.png: E:\AI-Tool\DeepSeek\story2video\projects\half_step\keyframes_local_v2\g002.png
- g003.png: E:\AI-Tool\DeepSeek\story2video\projects\half_step\keyframes_local_v2\g003.png

## 送模型的提示词（LLM 直写文件，逐字送模型）

- **g003**：keyframe-prompts\g003.txt，送模型 469 字，自检通过

生成记录：E:\AI-Tool\DeepSeek\story2video\projects\half_step\reviews\keyframes.generation.json
确认命令：node cli/review-gate.mjs approve --project "E:\AI-Tool\DeepSeek\story2video\projects\half_step" --stage keyframes --plan "E:\AI-Tool\DeepSeek\story2video\projects\half_step\render.plan.json"
