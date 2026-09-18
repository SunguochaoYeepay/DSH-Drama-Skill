import { SCRIPT_MODEL, SCRIPT_MAX_OUTPUT_TOKENS, BAILIAN_TEXT_TIMEOUT_SECONDS } from './config.mjs';
import { extractText } from './director.mjs';
import { runVerifiedTextResponse } from './providers/bailian-responses.mjs';

export async function generateScript(input, { run = runVerifiedTextResponse, model = SCRIPT_MODEL } = {}) {
  if (model !== SCRIPT_MODEL) throw new Error(`剧本模型必须是 ${SCRIPT_MODEL}`);
  const response = await run({
    model, maxTokens: SCRIPT_MAX_OUTPUT_TOKENS, reasoningEffort: 'low', timeoutMs: BAILIAN_TEXT_TIMEOUT_SECONDS * 1000,
    messages: [
      { role: 'system', content: '你是中文短剧编剧。根据用户素材写完整可拍摄的中文短剧剧本，包含场次、动作和完整台词。保留素材中已有台词的原文与顺序，不要输出解释或 Markdown 围栏。' },
      { role: 'user', content: input },
    ],
  });
  if (response.model !== model || response.status !== 'completed') throw new Error(`百炼响应未确认模型为 ${model} 或尚未完成`);
  const story = extractText(JSON.stringify(response));
  if (!story) throw new Error('模型没有返回剧本');
  return { story, responseModel: response.model };
}
