# 导演方案人工审阅

机器校验已通过，但尚不能进入关键帧阶段。请逐单元检查时长、台词完整性、切换理由和高风险动作。

| 单元 | 内容时长 | 镜头数 | 边界理由 | 高风险动作 |
|---|---:|---:|---|---|
| u1 | 7.30s | 3 | opening | 无 |
| u2 | 7.00s | 3 | scene_change | appearance_or_disappearance |
| u3 | 10.38s | 4 | scene_change | 无 |
| u4 | 4.00s | 1 | scene_change | 无 |

确认命令：node cli/review-gate.mjs approve --project "E:\AI-Tool\DeepSeek\story2video\projects\wig_sneeze" --stage direction --artifacts "E:\AI-Tool\DeepSeek\story2video\projects\wig_sneeze\board.direction.json"
返修反馈：E:\AI-Tool\DeepSeek\story2video\projects\wig_sneeze\reviews\revision.md
