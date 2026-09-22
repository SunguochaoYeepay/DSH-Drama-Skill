# 连续性交接 g003 -> g004

导演要求继承：undefined
只允许变化：承接上单元尾帧蚂蚁坐地姿态、机位从正面转为侧面、蚂蚁从坐地到站起再到侧面弓身推的变化、碎屑从静止到开始移动

稳定尾帧：E:\AI-Tool\DeepSeek\story2video\projects\ant_crumb_20260919\handoffs\g004.stable-tail.png
交接凭证：E:\AI-Tool\DeepSeek\story2video\projects\ant_crumb_20260919\handoffs\g004.handoff.json

请人工确认该帧能代表上一段结束的稳定状态。确认后，才生成下一关键帧。
确认命令：node cli/review-gate.mjs approve --project "E:\AI-Tool\DeepSeek\story2video\projects\ant_crumb_20260919" --stage handoff --id g004 --artifacts "E:\AI-Tool\DeepSeek\story2video\projects\ant_crumb_20260919\handoffs\g004.stable-tail.png"
