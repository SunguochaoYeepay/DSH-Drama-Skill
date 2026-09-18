import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function credentials() {
  const file = path.join(os.homedir(), '.bailian', 'config.json');
  const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const apiKey = process.env.AIH_BAILIAN_API_KEY || process.env.DASHSCOPE_API_KEY || cfg.api_key;
  const baseUrl = process.env.AIH_BAILIAN_BASE_URL || process.env.DASHSCOPE_BASE_URL || cfg.base_url;
  if (!apiKey || !baseUrl) throw new Error('百炼通道缺少 API Key 或 Base URL');
  return { apiKey, baseUrl };
}

export async function runStructuredChat({ messages, model, maxTokens, schema, timeoutMs = 600000, fetchImpl = fetch }) {
  const { apiKey, baseUrl } = credentials();
  const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/compatible-mode/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model, messages, enable_thinking: false, max_tokens: maxTokens,
      response_format: { type: 'json_schema', json_schema: { name: schema.name, description: schema.description || '', strict: true, schema: schema.schema } },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`百炼 Chat HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const json = await response.json();
  const choice = json.choices?.[0];
  if (!choice?.message?.content) throw new Error('百炼 Chat 没有返回结构化正文');
  if (choice.finish_reason === 'length') throw new Error('百炼 Chat 响应因 max_tokens 截断');
  let parsed;
  try { parsed = JSON.parse(choice.message.content); } catch { throw new Error('百炼 Chat 返回内容不是合法 JSON'); }
  return { model: json.model, responseModel: json.model, status: 'completed', parsed, raw: json };
}
