import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { provider } from '../src/providers/index.mjs';

const enabled = process.env.AIH_RUN_SMOKE === '1';
const comfyPython = process.env.AIH_PYTHON;

test('ComfyUI provider smoke：真实调用并回收图片产物', { skip: !enabled || !comfyPython }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-provider-smoke-'));
  try {
    const p = provider('comfyui');
    const result = await p.generate({
      prompt: 'a single red square on a neutral gray background, minimal test image',
      width: 256,
      height: 256,
      n: 1,
      steps: 1,
      cfg: 1,
      imageModel: 'qwen21',
      outDir: dir,
      prefix: 'smoke',
      timeoutMs: 180000,
    });
    assert.equal(result.status, 0, result.stderr || 'ComfyUI smoke failed');
    assert.equal(result.files.length, 1);
    assert.ok(fs.existsSync(result.files[0]));
    assert.ok(fs.statSync(result.files[0]).size > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
