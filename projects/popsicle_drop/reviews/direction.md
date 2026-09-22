# 导演方案人工审阅

机器校验已通过，但尚不能进入关键帧阶段。请逐单元检查时长、台词完整性、切换理由和高风险动作。

| 单元 | 内容时长 | 镜头数 | 边界理由 | 高风险动作 |
|---|---:|---:|---|---|
| u1 | 8.00s | 2 | opening | possession_change |

确认命令：node cli/review-gate.mjs approve --project "E:\AI-Tool\DeepSeek\story2video\projects\popsicle_drop" --stage direction --artifacts "E:\AI-Tool\DeepSeek\story2video\projects\popsicle_drop\board.direction.json"
