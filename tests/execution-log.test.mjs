import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executionLogPath, readExecutionEvents, writeExecutionEvent } from '../src/execution-log.mjs';

test('执行日志以 JSONL 保存安全的尝试摘要', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-exec-log-'));
  writeExecutionEvent(project, { run_id: 'run-1', provider: 'fake', operation: 'generate', attempt: 1, status: 1, error: 'temporary', duration_ms: 12 });
  writeExecutionEvent(project, { run_id: 'run-1', provider: 'fake', operation: 'generate', attempt: 2, status: 0, ok: true, duration_ms: 8, prompt: 'must not be logged' });
  const rows = readExecutionEvents(project);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].run_id, 'run-1');
  assert.equal(rows[1].ok, true);
  assert.equal(Object.hasOwn(rows[1], 'prompt'), false);
  assert.equal(fs.existsSync(executionLogPath(project)), true);
  fs.rmSync(project, { recursive: true, force: true });
});
