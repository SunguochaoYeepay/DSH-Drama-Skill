# 连续性交接 g002 -> g003

导演要求继承：undefined
只允许变化：景别从全景收到中景、机位从舱内正面移到他侧后方、教练的服装、身份、门框结构与舱内明暗关系不变。

稳定尾帧：E:\AI-Tool\DeepSeek\story2video\projects\no_chute_v2\handoffs\g003.stable-tail.png
交接凭证：E:\AI-Tool\DeepSeek\story2video\projects\no_chute_v2\handoffs\g003.handoff.json

请人工确认该帧能代表上一段结束的稳定状态。确认后，才生成下一关键帧。
确认命令：node cli/review-gate.mjs approve --project "E:\AI-Tool\DeepSeek\story2video\projects\no_chute_v2" --stage handoff --id g003 --artifacts "E:\AI-Tool\DeepSeek\story2video\projects\no_chute_v2\handoffs\g003.stable-tail.png"
