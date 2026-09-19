import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const NODE = process.execPath;
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const CLI = path.join(root, 'cli', 'register-direction.mjs');

function run(args) {
  return spawnSync(NODE, [CLI, ...args], { cwd: root, encoding: 'utf8' });
}

/** 建一个最小项目：板子 + 剧本。本入口只做结构与留痕，不做契约校验。 */
function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'direction-agent-'));
  fs.writeFileSync(path.join(dir, 'board.json'),
    JSON.stringify({ meta: { project: 'tmp' }, characters: [], identities: [], scenes: [], props: [], shots: [] }), 'utf8');
  fs.writeFileSync(path.join(dir, 'story.md'), '第一场\n\n△ 她走过。\n', 'utf8');
  return dir;
}
const draft = (units) => JSON.stringify({ version: 6, units });

test('register-direction 登记 Agent 直写导演稿并写 agent_draft 票据', () => {
  const dir = project();
  try {
    const input = path.join(dir, 'draft.json');
    fs.writeFileSync(input, draft([{ id: 'u1' }]), 'utf8');
    const r = run([path.join(dir, 'board.json'), '--input', input]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(fs.readFileSync(path.join(dir, 'board.direction.json'), 'utf8'));
    assert.equal(out.units.length, 1);
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, 'board.direction.json.provenance.json'), 'utf8'));
    assert.equal(receipt.provider, 'agent_draft');
    assert.equal(receipt.model, null);
    assert.equal(receipt.response_model, null);
    assert.equal(receipt.authored_by, 'agent');
    assert.match(receipt.direction_sha256, /^[a-f0-9]{64}$/);
    assert.match(receipt.board_identity_sha256, /^[a-f0-9]{64}$/);
    assert.match(receipt.story_sha256, /^[a-f0-9]{64}$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--authored-by 可覆盖；--out 与 --input 相同时只补票据、不改写正文', () => {
  const dir = project();
  try {
    const same = path.join(dir, 'board.direction.json');
    fs.writeFileSync(same, draft([{ id: 'u1' }, { id: 'u2' }]), 'utf8');
    const before = fs.readFileSync(same, 'utf8');
    const r = run([path.join(dir, 'board.json'), '--input', same, '--authored-by', 'codebuddy']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(same, 'utf8'), before, '--out 与 --input 相同时不得改写导演稿');
    const receipt = JSON.parse(fs.readFileSync(`${same}.provenance.json`, 'utf8'));
    assert.equal(receipt.authored_by, 'codebuddy');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('草稿不是合法 JSON 时拒绝登记，且不留下半成品', () => {
  const dir = project();
  try {
    const input = path.join(dir, 'draft.json');
    fs.writeFileSync(input, '{ units: [', 'utf8');
    const r = run([path.join(dir, 'board.json'), '--input', input]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /不是合法 JSON/);
    assert.equal(fs.existsSync(path.join(dir, 'board.direction.json')), false);
    assert.equal(fs.existsSync(path.join(dir, 'board.direction.json.provenance.json')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('units 缺失或为空时拒绝登记', () => {
  const dir = project();
  try {
    const input = path.join(dir, 'draft.json');
    for (const body of ['{"version":6,"units":[]}', '{"version":6}']) {
      fs.writeFileSync(input, body, 'utf8');
      const r = run([path.join(dir, 'board.json'), '--input', input]);
      assert.notEqual(r.status, 0, body);
      assert.match(r.stderr, /非空的 units 数组/);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Agent 直写票据不得冒充模型产物', () => {
  const dir = project();
  try {
    const input = path.join(dir, 'draft.json');
    fs.writeFileSync(input, draft([{ id: 'u1' }]), 'utf8');
    // 即使调用方显式传 --model，票据也不得记录模型：本入口没有模型响应可核验。
    const r = run([path.join(dir, 'board.json'), '--input', input, '--model', 'qwen3.8-max']);
    assert.equal(r.status, 0, r.stderr);
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, 'board.direction.json.provenance.json'), 'utf8'));
    assert.equal(receipt.provider, 'agent_draft');
    assert.equal(receipt.model, null);
    assert.equal(receipt.response_model, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log('register-direction: 5/5 passed');
