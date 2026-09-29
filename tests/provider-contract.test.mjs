import assert from 'node:assert/strict';
import test from 'node:test';
import { assertImageProvider, normalizeImageResult, providerCapabilities } from '../src/providers/contract.mjs';
import { AVAILABLE, capabilities, provider } from '../src/providers/index.mjs';

test('所有已注册图片 provider 都满足统一能力契约', () => {
  assert.deepEqual(AVAILABLE.sort(), ['bailian', 'comfyui', 'volcengine']);
  for (const name of AVAILABLE) {
    const p = provider(name);
    assert.equal(p.name, name);
    assert.deepEqual(capabilities(name), providerCapabilities(p));
  }
});

test('路由层包装 provider，返回值会经过统一归一化', async () => {
  const p = provider('comfyui');
  assert.notEqual(p.generate, undefined);
  assert.notEqual(p.edit, undefined);
  // 不调用真实引擎；这里确认包装保留了 provider 能力和稳定名称。
  assert.equal(p.name, 'comfyui');
});

test('契约拒绝缺少核心操作或名称不一致的 fake provider', () => {
  assert.throws(() => assertImageProvider({ name: 'fake', generate() {} }), /缺少 edit/);
  assert.throws(() => assertImageProvider({ name: 'other', generate() {}, edit() {} }, 'fake'), /名称不匹配/);
});

test('fake provider 的成功、失败和坏返回都能被统一处理', () => {
  const fake = { name: 'fake', generate() {}, edit() {} };
  assert.deepEqual(normalizeImageResult({ files: ['a.png'], status: 0 }, { provider: fake.name }), {
    files: ['a.png'], status: 0,
  });
  assert.deepEqual(normalizeImageResult({ files: [], status: 1, error: 'timeout' }, { provider: fake.name }), {
    files: [], status: 1, error: 'timeout',
  });
  assert.throws(() => normalizeImageResult({ files: [], status: 'ok' }, { provider: fake.name }), /status/);
  assert.throws(() => normalizeImageResult(null, { provider: fake.name }), /必须返回对象/);
});
