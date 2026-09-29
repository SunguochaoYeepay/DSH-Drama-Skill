import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeGenerationRecord, readGenerationRecord, displayPathOf } from '../src/generation-records.mjs';

/**
 * 生成记录里的**展示路径**必须能入库（2026-09-23）。
 *
 * 起因：票的 `artifacts` 早就归一成仓库相对了，但 `generation.artifacts` / `generation.plan`
 * 没有 —— `cli/keyframes.mjs` 把绝对路径原样交给 `writeGenerationRecord()`，签票时被整块
 * 复制进票里，于是 `examples/demo-show/review.approvals.json` 里躺着本机路径，
 * `tests/example-demo.test.mjs`（入库示例不含绝对路径）一直是红的。
 */

/** 临时仓库：造一个 `.git` 让 repoRootOf 认得出根。 */
function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-gen-rec-'));
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const dir = path.join(repo, 'examples', 'demo');
  fs.mkdirSync(path.join(dir, 'keyframes_render'), { recursive: true });
  return { repo, dir };
}

test('仓库内的绝对路径 → 仓库相对；仓库外原样保留（宁留绝对也不写假相对）', () => {
  const { repo, dir } = makeRepo();
  const inside = path.join(dir, 'keyframes_render', 'g001.png');
  const outside = path.join(os.tmpdir(), '别的地方', 'x.png');
  assert.equal(displayPathOf(dir, inside), 'examples/demo/keyframes_render/g001.png');
  assert.equal(displayPathOf(dir, outside), outside, '仓库外的不许瞎改');
  assert.equal(displayPathOf(dir, 'units/rel.mp4'), 'units/rel.mp4', '本来就是相对的，一个字都不动');
  assert.equal(displayPathOf(dir, ''), '');
  void repo;
});

test('writeGenerationRecord：artifacts[] 与 plan 都归一，其余字段一字不动', () => {
  const { dir } = makeRepo();
  const file = writeGenerationRecord(dir, 'keyframes', {
    provider: 'local',
    model: 'local-comfyui/qwen21',
    artifacts: [path.join(dir, 'keyframes_render', 'g001.png'), 'C:\\别处\\x.png'],
    plan: path.join(dir, 'render.plan.json'),
    prompt_files: ['keyframe-prompts/g001.txt'],
  });
  const rec = readGenerationRecord(dir, 'keyframes');
  assert.deepEqual(rec.artifacts, ['examples/demo/keyframes_render/g001.png', 'C:\\别处\\x.png']);
  assert.equal(rec.plan, 'examples/demo/render.plan.json');
  assert.deepEqual(rec.prompt_files, ['keyframe-prompts/g001.txt'], '别的字段不动');
  assert.equal(rec.provider, 'local');
  assert.equal(rec.stage, 'keyframes');
  assert.equal(rec.version, 1);
  assert.match(rec.at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(file.endsWith(path.join('reviews', 'keyframes.generation.json')), true);
});

test('归一之后，票据里带进来的 generation 块也不再含仓库内的本机路径', () => {
  const { dir } = makeRepo();
  writeGenerationRecord(dir, 'keyframes', {
    artifacts: [path.join(dir, 'keyframes_render', 'g001.png')],
    plan: path.join(dir, 'render.plan.json'),
  });
  const raw = fs.readFileSync(path.join(dir, 'reviews', 'keyframes.generation.json'), 'utf8');
  assert.equal(/[A-Za-z]:\\\\/.test(raw.replace(/C:\\\\\\\\别处/g, '')), false, `记录里不该有盘符：${raw}`);
  assert.match(raw, /examples\/demo\/keyframes_render\/g001\.png/);
});

test('生成记录自动保存运行环境和输入/产物哈希', () => {
  const { dir } = makeRepo();
  const artifact = path.join(dir, 'keyframes_render', 'g001.png');
  const plan = path.join(dir, 'render.plan.json');
  fs.writeFileSync(artifact, 'image-bytes');
  fs.writeFileSync(plan, '{"version":1}');
  writeGenerationRecord(dir, 'keyframes', {
    provider: 'fake',
    artifacts: [artifact],
    plan,
    prompt_files: ['keyframe-prompts/g001.txt'],
  });
  const rec = readGenerationRecord(dir, 'keyframes');
  assert.equal(rec.execution.node, process.version);
  assert.equal(rec.execution.platform, process.platform);
  assert.equal(rec.execution.arch, process.arch);
  assert.match(rec.execution.run_id, /^[0-9a-f-]{36}$/);
  assert.match(rec.execution.input_fingerprint, /^[0-9a-f]{64}$/);
  assert.match(rec.execution.files['examples/demo/keyframes_render/g001.png'], /^[0-9a-f]{64}$/);
  assert.match(rec.execution.files['examples/demo/render.plan.json'], /^[0-9a-f]{64}$/);
  assert.equal(Object.keys(rec.execution.files).length, 2, '缺失的 prompt 不应伪造哈希');
});

test('输入指纹只由已存在文件决定，文件变化后会变化', () => {
  const { dir } = makeRepo();
  const artifact = path.join(dir, 'keyframes_render', 'g001.png');
  fs.writeFileSync(artifact, 'first');
  writeGenerationRecord(dir, 'keyframes', { run_id: 'run-a', artifacts: [artifact] });
  const first = readGenerationRecord(dir, 'keyframes');
  writeGenerationRecord(dir, 'keyframes', { run_id: 'run-b', artifacts: [artifact] });
  const second = readGenerationRecord(dir, 'keyframes');
  assert.notEqual(first.execution.run_id, second.execution.run_id);
  assert.equal(first.execution.input_fingerprint, second.execution.input_fingerprint);
  fs.writeFileSync(artifact, 'second');
  writeGenerationRecord(dir, 'keyframes', { run_id: 'run-c', artifacts: [artifact] });
  const third = readGenerationRecord(dir, 'keyframes');
  assert.notEqual(second.execution.input_fingerprint, third.execution.input_fingerprint);
});
