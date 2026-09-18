import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { makeScriptReceipt, receiptPath, requireScriptProvenance, SCRIPT_MODEL } from '../src/script-provenance.mjs';

test('高级模型来源票必须核对请求和响应模型', () => {
  assert.equal(SCRIPT_MODEL, 'qwen3.8-max');
  assert.throws(() => makeScriptReceipt({ story: '剧本', input: '素材', source: 'ollama', model: 'qwen3.5:27b' }));
  assert.throws(() => makeScriptReceipt({ story: '剧本', input: '素材', source: 'bailian', model: SCRIPT_MODEL }));
  assert.throws(() => makeScriptReceipt({ story: '剧本', input: '素材', source: 'bailian', model: SCRIPT_MODEL, responseModel: 'other' }));
});

test('缺票、剧本修改及伪造模型来源均拒绝推进', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'script-proof-'));
  try {
    const storyPath = path.join(dir, 'story.md');
    fs.writeFileSync(storyPath, '原稿');
    assert.throws(() => requireScriptProvenance(storyPath), /来源未登记/);
    const receipt = makeScriptReceipt({ story: '原稿', input: '素材', source: 'bailian', model: SCRIPT_MODEL, responseModel: SCRIPT_MODEL });
    fs.writeFileSync(receiptPath(storyPath), JSON.stringify(receipt));
    assert.equal(requireScriptProvenance(storyPath).model, SCRIPT_MODEL);
    fs.writeFileSync(storyPath, '修改稿');
    assert.throws(() => requireScriptProvenance(storyPath), /已变化/);
    fs.writeFileSync(storyPath, '原稿');
    receipt.response_model = 'local';
    fs.writeFileSync(receiptPath(storyPath), JSON.stringify(receipt));
    assert.throws(() => requireScriptProvenance(storyPath), /来源模型/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('用户原稿保留用户来源，不冒充模型', () => {
  const receipt = makeScriptReceipt({ story: '原稿', input: '原稿', source: 'user_supplied' });
  assert.equal(receipt.model, null);
  assert.throws(() => makeScriptReceipt({ story: '原稿', input: '原稿', source: 'user_supplied', model: SCRIPT_MODEL }));
});
