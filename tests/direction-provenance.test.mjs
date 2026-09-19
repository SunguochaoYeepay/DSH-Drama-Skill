import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { callDirector } from '../src/director.mjs';
import { DIRECTOR_MODEL } from '../src/config.mjs';
import { writeDirectionReceipt, directionReceiptPath } from '../src/direction-provenance.mjs';
import { sha256 } from '../src/script-provenance.mjs';

test('导演不再限定厂商与型号，但响应必须报告与请求相同的模型', async () => {
  const envelope = (model) => ({ model, status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"version":6,"units":[]}' }] }] });
  const run = (body) => () => body;
  assert.equal((await callDirector('brief', { run: run(envelope(DIRECTOR_MODEL)) })).responseModel, DIRECTOR_MODEL);
  // 响应不报模型或报了别的模型 → 拒绝。这是票据自洽，不是厂商限制。
  assert.equal((await callDirector('brief', { run: run(envelope(undefined)) })).ok, false);
  assert.equal((await callDirector('brief', { run: run(envelope('local')) })).ok, false);
  // 换厂商或型号不再被拒：出稿用什么模型由 .env 或 --model 决定。
  assert.equal((await callDirector('brief', { model: 'qwen3.5:27b', run: run(envelope('qwen3.5:27b')) })).responseModel, 'qwen3.5:27b');
  assert.equal((await callDirector('brief', { model: 'glm-5.2', run: run(envelope('glm-5.2')) })).responseModel, 'glm-5.2');
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

test('导演来源票留痕：记录板子、剧本与导演稿当时的哈希', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'direction-proof-'));
  try {
    const boardPath = path.join(dir, 'board.json');
    const storyPath = path.join(dir, 'story.md');
    const directionPath = path.join(dir, 'board.direction.json');
    fs.writeFileSync(boardPath, '{}');
    fs.writeFileSync(storyPath, '剧本');
    fs.writeFileSync(directionPath, '{"a":1}');
    const receipt = writeDirectionReceipt({ directionPath, boardPath, storyPath, model: DIRECTOR_MODEL, responseModel: DIRECTOR_MODEL });
    assert.equal(receipt.model, DIRECTOR_MODEL);
    assert.equal(receipt.direction_sha256, sha256('{"a":1}'));
    assert.equal(receipt.story_sha256, sha256('剧本'));

    // 票据落盘且能读回 —— 留痕的价值在于事后可查，不在于拦住谁
    const onDisk = JSON.parse(fs.readFileSync(directionReceiptPath(directionPath), 'utf8'));
    assert.equal(onDisk.direction_sha256, receipt.direction_sha256);

    // 改了导演稿不会有人拦（机器不再审核），但票据记的仍是写入那一刻的内容
    fs.writeFileSync(directionPath, '{"changed":true}');
    assert.notEqual(receipt.direction_sha256, sha256('{"changed":true}'));
    assert.equal(JSON.parse(fs.readFileSync(directionReceiptPath(directionPath), 'utf8')).direction_sha256, sha256('{"a":1}'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
