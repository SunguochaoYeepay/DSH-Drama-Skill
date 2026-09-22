# 连续性交接 g002 -> g003

导演要求继承：猫四肢摊开趴在棚顶，披风盖在背上，棚布已停止晃动
只允许变化：机位移到棚顶斜下方、景别保持全景

稳定尾帧：E:\AI-Tool\DeepSeek\story2video\projects\fat_cat\handoffs\g003.stable-tail.png
交接凭证：E:\AI-Tool\DeepSeek\story2video\projects\fat_cat\handoffs\g003.handoff.json

请人工确认该帧能代表上一段结束的稳定状态。确认后，才生成下一关键帧。
确认命令：node cli/review-gate.mjs approve --project "E:\AI-Tool\DeepSeek\story2video\projects\fat_cat" --stage handoff --id g003 --artifacts "E:\AI-Tool\DeepSeek\story2video\projects\fat_cat\handoffs\g003.stable-tail.png"
