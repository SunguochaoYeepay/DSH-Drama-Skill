# 关键帧人工审阅

机器检查只能判定是否可送审。请逐张查看人物身份、体型比例、构图、动作起点和场景连续性。

- g001.png: E:\AI-Tool\DeepSeek\story2video\projects\gopher_toll\keyframes_render\g001.png
- g002.png: E:\AI-Tool\DeepSeek\story2video\projects\gopher_toll\keyframes_local_v2\g002.png
- g003.png: E:\AI-Tool\DeepSeek\story2video\projects\gopher_toll\keyframes_local_v2\g003.png
- g004.png: E:\AI-Tool\DeepSeek\story2video\projects\gopher_toll\keyframes_local_v2\g004.png

## 送模型的提示词（LLM 直写文件，逐字送模型）

- **g002**：keyframe-prompts\g002.txt，送模型 495 字，自检通过

生成记录：E:\AI-Tool\DeepSeek\story2video\projects\gopher_toll\reviews\keyframes.generation.json
确认命令：node cli/review-gate.mjs approve --project "E:\AI-Tool\DeepSeek\story2video\projects\gopher_toll" --stage keyframes --plan "E:\AI-Tool\DeepSeek\story2video\projects\gopher_toll\render.plan.json"
