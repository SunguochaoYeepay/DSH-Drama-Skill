import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { callDirector } from '../src/director.mjs';
import { DIRECTOR_MODEL } from '../src/config.mjs';
import { requireDirectionProvenance, writeDirectionReceipt } from '../src/direction-provenance.mjs';

test('导演只接受批准模型且响应必须报告同一模型', async () => {
  const run = (model) => (request) => {
    assert.equal(request.model, DIRECTOR_MODEL);
    return { model, status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"version":6,"units":[]}' }] }] };
  };
  assert.equal((await callDirector('brief', { run: run(DIRECTOR_MODEL) })).responseModel, DIRECTOR_MODEL);
  assert.equal((await callDirector('brief', { run: run(undefined) })).ok, false);
  assert.equal((await callDirector('brief', { run: run('local') })).ok, false);
  await assert.rejects(callDirector('brief', { model: 'qwen3.5:27b', run: run(DIRECTOR_MODEL) }), /高级模型/);
});

test('Responses 完成信封保留模型核验并抽取完整正文', async () => {
  const envelope = (status = 'completed', model = DIRECTOR_MODEL) => ({
    model, status, incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
    output: [
      { type: 'reasoning', content: [{ type: 'reasoning_text', text: '不应作为导演稿' }] },
      { type: 'message', content: [{ type: 'output_text', text: '{"version":6,"units":[]}' }] },
    ],
  });
  const run = (body) => (request) => {
    assert.equal(request.maxTokens, 12000);
    assert.equal(request.reasoningEffort, 'low');
    return body;
  };
  assert.deepEqual((await callDirector('brief', { run: run(envelope()) })).direction, { version: 6, units: [] });
  assert.match((await callDirector('brief', { run: run(envelope('incomplete')) })).error, /max_output_tokens/);
  assert.match((await callDirector('brief', { run: run(envelope('completed', 'other')) })).error, /模型不匹配/);
  assert.equal((await callDirector('brief', { run: run({ ...envelope(), output: [] }) })).ok, false);
});

test('导演来源绑定板子、剧本与导演稿', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'direction-proof-'));
  try {
    const boardPath = path.join(dir, 'board.json');
    const storyPath = path.join(dir, 'story.md');
    const directionPath = path.join(dir, 'board.direction.json');
    fs.writeFileSync(boardPath, '{}');
    fs.writeFileSync(storyPath, '剧本');
    fs.writeFileSync(directionPath, '{}');
    assert.throws(() => requireDirectionProvenance({ directionPath, boardPath, storyPath }), /未登记/);
    writeDirectionReceipt({ directionPath, boardPath, storyPath, model: DIRECTOR_MODEL, responseModel: DIRECTOR_MODEL });
    assert.equal(requireDirectionProvenance({ directionPath, boardPath, storyPath }).model, DIRECTOR_MODEL);
    fs.writeFileSync(directionPath, '{"changed":true}');
    assert.throws(() => requireDirectionProvenance({ directionPath, boardPath, storyPath }), /已变化/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
