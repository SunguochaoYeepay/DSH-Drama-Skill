import assert from 'node:assert/strict';
import test from 'node:test';
import { makeScriptReceipt, SCRIPT_MODEL } from '../src/script-provenance.mjs';

test('模型来源票必须自洽：请求与响应是同一个模型', () => {
  assert.ok(SCRIPT_MODEL);
  assert.throws(() => makeScriptReceipt({ story: '剧本', input: '素材', source: 'ollama', model: 'qwen3.5:27b' }));
  assert.throws(() => makeScriptReceipt({ story: '剧本', input: '素材', source: 'bailian', model: SCRIPT_MODEL }));
  assert.throws(() => makeScriptReceipt({ story: '剧本', input: '素材', source: 'bailian', model: SCRIPT_MODEL, responseModel: 'other' }));
  // 换型号不再被拒：任何非空的请求/响应同型号组合都收。
  assert.equal(makeScriptReceipt({ story: '剧本', input: '素材', source: 'bailian', model: 'glm-5.2', responseModel: 'glm-5.2' }).model, 'glm-5.2');
});

test('用户原稿保留用户来源，不冒充模型', () => {
  const receipt = makeScriptReceipt({ story: '原稿', input: '原稿', source: 'user_supplied' });
  assert.equal(receipt.model, null);
  assert.throws(() => makeScriptReceipt({ story: '原稿', input: '原稿', source: 'user_supplied', model: SCRIPT_MODEL }));
});

test('Agent 直写稿绑定对话留痕，不能冒充模型', () => {
  const receipt = makeScriptReceipt({ story: '草稿', input: '用户一句话梗', source: 'agent_draft', draftedBy: 'agent' });
  assert.equal(receipt.source, 'agent_draft');
  assert.equal(receipt.model, null);
  assert.equal(receipt.response_model, null);
  assert.equal(receipt.drafted_by, 'agent');
  // 任何带 model 的 agent_draft 都被拒：直写稿不得标模型。
  assert.throws(() => makeScriptReceipt({ story: '草稿', input: '梗', source: 'agent_draft', draftedBy: 'agent', model: SCRIPT_MODEL }));
  assert.throws(() => makeScriptReceipt({ story: '草稿', input: '梗', source: 'agent_draft', draftedBy: 'agent', responseModel: SCRIPT_MODEL }));
  // 必须声明 drafted_by，否则无法留痕。
  assert.throws(() => makeScriptReceipt({ story: '草稿', input: '梗', source: 'agent_draft' }));
});
test('来源票记录输入与剧本哈希，供事后追溯', () => {
const receipt = makeScriptReceipt({ story: '剧本正文', input: '素材原文', source: 'bailian', model: 'm', responseModel: 'm' });
  assert.match(receipt.story_sha256, /^[a-f0-9]{64}$/);
  assert.match(receipt.input_sha256, /^[a-f0-9]{64}$/);
  assert.notEqual(receipt.story_sha256, receipt.input_sha256);
  // 同一内容 → 同一哈希；内容一变哈希就变（这是留痕能起作用的前提）
  const again = makeScriptReceipt({ story: '剧本正文', input: '素材原文', source: 'bailian', model: 'm', responseModel: 'm' });
  assert.equal(again.story_sha256, receipt.story_sha256);
  assert.notEqual(makeScriptReceipt({ story: '改了一个字', input: '素材原文', source: 'bailian', model: 'm', responseModel: 'm' }).story_sha256, receipt.story_sha256);
});
