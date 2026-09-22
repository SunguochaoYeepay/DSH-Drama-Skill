# 连续性交接 g003 -> g004

导演要求继承：灰豆保持趴地、眼皮半闭和身体松软；阿橘保持低头注视，前爪仍压住灰豆或只允许从该状态开始松开。禁止灰豆重新坐起，禁止星星眼。
只允许变化：framing、camera

稳定尾帧：E:\AI-Tool\DeepSeek\story2video\projects\cat_mouse\handoffs\g004.stable-tail.png
交接凭证：E:\AI-Tool\DeepSeek\story2video\projects\cat_mouse\handoffs\g004.handoff.json

请人工确认该帧能代表上一段结束的稳定状态。确认后，才生成下一关键帧。
确认命令：node cli/review-gate.mjs approve --project "E:\AI-Tool\DeepSeek\story2video\projects\cat_mouse" --stage handoff --id g004 --artifacts "E:\AI-Tool\DeepSeek\story2video\projects\cat_mouse\handoffs\g004.stable-tail.png"
