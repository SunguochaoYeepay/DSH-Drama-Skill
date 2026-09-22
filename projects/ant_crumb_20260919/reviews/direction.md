# 导演方案人工审阅

没有机器校验代替你判断。请逐单元检查时长、台词完整性、切换理由和高风险动作。

| 单元 | 内容时长 | 镜头数 | 边界理由 | 高风险动作 |
|---|---:|---:|---|---|
| u1 | 6.00s | 2 | opening | 无 |
| u2 | 6.50s | 2 | scene_change | 无 |
| u3 | 7.00s | 2 | scene_change | large_displacement |
| u4 | 7.00s | 2 | scene_change | large_displacement |
| u5 | 6.50s | 2 | scene_change | 无 |

确认命令：node cli/review-gate.mjs approve --project "E:\AI-Tool\DeepSeek\story2video\projects\ant_crumb_20260919" --stage direction --artifacts "E:\AI-Tool\DeepSeek\story2video\projects\ant_crumb_20260919\board.direction.json"
