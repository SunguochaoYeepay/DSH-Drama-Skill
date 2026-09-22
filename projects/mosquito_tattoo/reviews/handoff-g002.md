# 连续性交接 g001 -> g002

导演要求继承：陈默的右掌仍停在她右肩外侧同一高度尚未收回；林小雅保持转身后的正面站姿与瞪视表情，两人距离不变
只允许变化：两人体态由侧后改为正面对峙、景别与机位

## 稳定尾帧

- **实际使用**：`handoffs/g002.stable-tail.png`　sha256 `68e6f234…`　⚠ **此帧经过编辑**
- 原始提取帧：`handoffs/g002.stable-tail.raw.png`　sha256 `413479bf…`（`-sseof -0.35s` 提取）

### 编辑记录

| 项 | 值 |
|---|---|
| 工具 | 本地 ComfyUI `qwen_image_edit_2511_fp8_e4m3fn` + Qwen-Image-Edit-2511-Lightning-4steps |
| 耗时 | 27.4 秒 |
| 指令 | Remove the insect tattoo completely from the woman's right shoulder. Restore clean natural bare skin there… Keep her face, hair, expression, clothing, pose, body shape, arm and the background exactly unchanged. |
| 原因 | 原始尾帧右肩纹身尺寸严重偏大（≈肩宽 19%），而尾帧是 g002 关键帧参考图的**第 1 张**、会被直接继承（纹身本在右肩后侧，转身后正面不呈现，无需补回） |
| 效果 | 纹身干净消失；脸/发型/表情/服装/姿态/背景一致；肩带与肩线有极轻微位移 |
| 用户确认 | 2026-09-17 15:42「图片可以了」 |

**取景说明**：该帧画面内只有林小雅一人（末镜是她的近景），陈默已出画。
因此「陈默右掌位置」这一项**无法从本帧继承**；g002 的 `allowed_changes` 本就允许「体态改为正面对峙」，
两人同框构图由 g002 关键帧重新建立。

交接凭证：`handoffs/g002.handoff.json`

请人工确认该帧能代表上一段结束的稳定状态。确认后，才生成下一关键帧。
确认命令：node cli/review-gate.mjs approve --project "E:\AI-Tool\DeepSeek\story2video\projects\mosquito_tattoo" --stage handoff --id g002 --artifacts "E:\AI-Tool\DeepSeek\story2video\projects\mosquito_tattoo\handoffs\g002.stable-tail.png"
