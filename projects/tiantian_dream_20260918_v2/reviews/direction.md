# 导演方案人工审阅

机器校验已通过，但尚不能进入关键帧阶段。请逐单元检查时长、台词完整性、切换理由和高风险动作。

| 单元 | 内容时长 | 镜头数 | 边界理由 | 高风险动作 |
|---|---:|---:|---|---|
| u1 | 11.00s | 4 | opening | 无 |
| u2 | 12.29s | 3 | scene_change | 无 |
| u3 | 14.50s | 6 | state_transition_anchor | 无 |
| u4 | 15.00s | 3 | time_jump | 无 |

确认命令：node cli/review-gate.mjs approve --project "E:\AI-Tool\DeepSeek\story2video\projects\tiantian_dream_20260918_v2" --stage direction --artifacts "E:\AI-Tool\DeepSeek\story2video\projects\tiantian_dream_20260918_v2\board.direction.json"
