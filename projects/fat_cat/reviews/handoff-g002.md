# 连续性交接 g001 -> g002

导演要求继承：猫在空中保持双爪前伸的超人飞行姿势，披风在身后展开，背景楼立面开始下移
只允许变化：景别由全景收为中景、背景楼层持续下移、机位移至猫侧前方同高

稳定尾帧：E:\AI-Tool\DeepSeek\story2video\projects\fat_cat\handoffs\g002.stable-tail.png
交接凭证：E:\AI-Tool\DeepSeek\story2video\projects\fat_cat\handoffs\g002.handoff.json

请人工确认该帧能代表上一段结束的稳定状态。确认后，才生成下一关键帧。
确认命令：node cli/review-gate.mjs approve --project "E:\AI-Tool\DeepSeek\story2video\projects\fat_cat" --stage handoff --id g002 --artifacts "E:\AI-Tool\DeepSeek\story2video\projects\fat_cat\handoffs\g002.stable-tail.png"
