import assert from 'node:assert/strict';
import test from 'node:test';
import { runVerifiedTextResponse } from '../src/providers/bailian-responses.mjs';

const previousKey = process.env.AIH_BAILIAN_API_KEY;
const previousUrl = process.env.AIH_BAILIAN_BASE_URL;
process.env.AIH_BAILIAN_API_KEY = 'test-key';
process.env.AIH_BAILIAN_BASE_URL = 'https://example.invalid';
test.after(() => {
  if (previousKey === undefined) delete process.env.AIH_BAILIAN_API_KEY;
  else process.env.AIH_BAILIAN_API_KEY = previousKey;
  if (previousUrl === undefined) delete process.env.AIH_BAILIAN_BASE_URL;
  else process.env.AIH_BAILIAN_BASE_URL = previousUrl;
});

const event = (type, response) => `id:1\nevent:${type}\ndata:${JSON.stringify({ type, response })}\n\n`;
function fakeFetch(payload) {
  return async (url, options) => {
    assert.equal(url, 'https://example.invalid/compatible-mode/v1/responses');
    assert.equal(JSON.parse(options.body).stream, true);
    assert.equal(JSON.parse(options.body).reasoning.effort, 'low');
    assert.equal(options.headers.authorization, 'Bearer test-key');
    const bytes = new TextEncoder().encode(payload);
    return { ok: true, body: new ReadableStream({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 13) controller.enqueue(bytes.slice(offset, offset + 13));
        controller.close();
      },
    }) };
  };
}

test('流式导演只接受完整事件，且起始与结束模型一致', async () => {
  const model = 'qwen3.8-max';
  const body = { model, status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{}' }] }] };
  const prefix = event('response.created', { model });
  const result = await runVerifiedTextResponse({ model, messages: [], maxTokens: 12000, fetchImpl: fakeFetch(prefix + event('response.completed', body)) });
  assert.deepEqual(result, body);
  await assert.rejects(runVerifiedTextResponse({ model, messages: [], maxTokens: 12000, fetchImpl: fakeFetch(prefix) }), /流中断/);
  await assert.rejects(runVerifiedTextResponse({ model, messages: [], maxTokens: 12000, fetchImpl: fakeFetch(prefix + event('response.incomplete', { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } })) }), /max_output_tokens/);
  await assert.rejects(runVerifiedTextResponse({ model, messages: [], maxTokens: 12000, fetchImpl: fakeFetch(prefix + event('response.completed', { ...body, model: 'other' })) }), /模型不匹配/);
});
