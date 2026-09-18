import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function credentials() {
  const configFile = path.join(os.homedir(), '.bailian', 'config.json');
  const config = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {};
  const apiKey = process.env.AIH_BAILIAN_API_KEY || process.env.DASHSCOPE_API_KEY || config.api_key;
  const baseUrl = process.env.AIH_BAILIAN_BASE_URL || process.env.DASHSCOPE_BASE_URL || config.base_url;
  if (!apiKey || !baseUrl) throw new Error('百炼流式通道缺少 API Key 或 Base URL；请在 .env 配置 AIH_BAILIAN_API_KEY / AIH_BAILIAN_BASE_URL');
  return { apiKey, baseUrl };
}

export async function runVerifiedTextResponse({ messages, model, maxTokens, reasoningEffort = 'low', timeoutMs = 600000, fetchImpl = fetch }) {
  const { apiKey, baseUrl } = credentials();
  const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/compatible-mode/v1/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, input: messages, max_output_tokens: maxTokens, reasoning: { effort: reasoningEffort }, stream: true }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`百炼响应 HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  if (!response.body) throw new Error('百炼响应没有事件流');

  let buffer = '';
  let createdModel;
  let completed;
  let incomplete;
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, '');
      const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') continue;
      const event = JSON.parse(data);
      if (event.type === 'response.created') createdModel = event.response?.model;
      if (event.type === 'response.completed') completed = event.response;
      if (event.type === 'response.incomplete' || event.type === 'response.failed') incomplete = event.response;
    }
  }
  if (incomplete) throw new Error(`百炼响应未完成：${incomplete.incomplete_details?.reason || incomplete.error?.message || incomplete.status}`);
  if (!completed || completed.status !== 'completed') throw new Error('百炼响应流中断：没有完整结束事件');
  if (createdModel !== model || completed.model !== model) throw new Error(`百炼响应模型不匹配：${completed.model || '未报告'}，要求 ${model}`);
  return completed;
}
