import assert from 'node:assert/strict';
import test from 'node:test';
import { runImageJob } from '../src/provider-executor.mjs';

test('fake provider 成功时只调用一次并保留统一结果', async () => {
  let calls = 0;
  const fake = { name: 'fake', async generate() { calls++; return { files: ['out.png'], status: 0 }; } };
  const result = await runImageJob(fake, 'generate', {}, { retries: 2 });
  assert.equal(calls, 1);
  assert.deepEqual(result.files, ['out.png']);
  assert.equal(result.attempts, 1);
  assert.deepEqual(result.retry_errors, []);
});

test('fake provider 首次失败后按配置重试并恢复', async () => {
  let calls = 0;
  const fake = { name: 'fake', async generate() {
    calls++;
    return calls === 1 ? { files: [], status: 1, stderr: 'temporary' } : { files: ['out.png'], status: 0 };
  } };
  const result = await runImageJob(fake, 'generate', {}, { retries: 1 });
  assert.equal(calls, 2);
  assert.equal(result.attempts, 2);
  assert.deepEqual(result.retry_errors, ['temporary']);
});

test('fake provider 超时后重试，耗尽时返回可读失败结果', async () => {
  let calls = 0;
  const fake = { name: 'fake', async generate() {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { files: ['late.png'], status: 0 };
  } };
  const result = await runImageJob(fake, 'generate', {}, { retries: 1, timeoutMs: 1 });
  assert.equal(calls, 2);
  assert.equal(result.status, 1);
  assert.equal(result.attempts, 2);
  assert.match(result.error, /超时/);
});
