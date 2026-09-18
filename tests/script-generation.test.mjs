import assert from 'node:assert/strict';
import test from 'node:test';
import { generateScript } from '../src/script-generation.mjs';
import { SCRIPT_MODEL } from '../src/config.mjs';

const envelope = (model = SCRIPT_MODEL, status = 'completed', text = '第一场\n甲：你好。') => ({
  model, status, output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
});

test('剧本流式响应必须完成、报告批准模型并有正文', async () => {
  const input = '一个短剧点子';
  const run = (response) => (request) => {
    assert.equal(request.model, SCRIPT_MODEL);
    assert.equal(request.reasoningEffort, 'low');
    assert.equal(request.messages[1].content, input);
    return response;
  };
  assert.deepEqual(await generateScript(input, { run: run(envelope()) }), {
    story: '第一场\n甲：你好。', responseModel: SCRIPT_MODEL,
  });
  await assert.rejects(generateScript(input, { run: run(envelope('other')) }), /响应未确认模型/);
  await assert.rejects(generateScript(input, { run: run(envelope(SCRIPT_MODEL, 'incomplete')) }), /尚未完成/);
  await assert.rejects(generateScript(input, { run: run(envelope(SCRIPT_MODEL, 'completed', '')) }), /没有返回剧本/);
  await assert.rejects(generateScript(input, { run: () => Promise.reject(new Error('流中断')) }), /流中断/);
  await assert.rejects(generateScript(input, { model: 'local', run: run(envelope()) }), /模型必须/);
});
