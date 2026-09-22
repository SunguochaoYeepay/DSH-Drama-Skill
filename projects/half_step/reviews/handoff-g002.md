# 连续性交接 g001 -> g002

导演要求继承：undefined
只允许变化：景别由近景拉回全景、机位由近景固定改为全景正面、画面里只保留她一个人，背景仍是同一块空地

稳定尾帧：E:\AI-Tool\DeepSeek\story2video\projects\half_step\handoffs\g002.stable-tail.png
交接凭证：E:\AI-Tool\DeepSeek\story2video\projects\half_step\handoffs\g002.handoff.json

请人工确认该帧能代表上一段结束的稳定状态。确认后，才生成下一关键帧。
确认命令：node cli/review-gate.mjs approve --project "E:\AI-Tool\DeepSeek\story2video\projects\half_step" --stage handoff --id g002 --artifacts "E:\AI-Tool\DeepSeek\story2video\projects\half_step\handoffs\g002.stable-tail.png"
