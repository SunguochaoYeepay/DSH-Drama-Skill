import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const NODE = process.execPath;
const SCRIPT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../cli/script.mjs');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

function run(args, env = {}) {
  return spawnSync(NODE, [SCRIPT, ...args], { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8' });
}

test('register-agent 登记 Agent 直写剧本并写入 agent_draft 票据', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'script-agent-'));
  try {
    const input = path.join(dir, 'draft.md');
    const out = path.join(dir, 'story.md');
    fs.writeFileSync(input, '《冒烟》\n\n第一场\n\n小蚂蚁走过。\n', 'utf8');
    const r = run(['register-agent', '--input', input, '--out', out]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(out, 'utf8'), fs.readFileSync(input, 'utf8'));
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, 'story.provenance.json'), 'utf8'));
    assert.equal(receipt.source, 'agent_draft');
    assert.equal(receipt.model, null);
    assert.equal(receipt.response_model, null);
    assert.equal(receipt.drafted_by, 'agent');
    assert.match(receipt.story_sha256, /^[a-f0-9]{64}$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('register-agent --drafted-by 可覆盖默认标识', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'script-agent-'));
  try {
    const input = path.join(dir, 'draft.md');
    const out = path.join(dir, 'story.md');
    fs.writeFileSync(input, '剧本', 'utf8');
    const r = run(['register-agent', '--input', input, '--out', out, '--drafted-by', 'codebuddy']);
    assert.equal(r.status, 0, r.stderr);
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, 'story.provenance.json'), 'utf8'));
    assert.equal(receipt.drafted_by, 'codebuddy');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('register-agent 不能冒充模型产物', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'script-agent-'));
  try {
    const input = path.join(dir, 'draft.md');
    const out = path.join(dir, 'story.md');
    fs.writeFileSync(input, '剧本', 'utf8');
    const r = run(['register-agent', '--input', input, '--out', out, '--model', 'qwen3.8-max']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Agent 直写稿不能标记模型/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('register-user 仍要求 --confirmed-by，不得代签', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'script-user-'));
  try {
    const input = path.join(dir, 'draft.md');
    const out = path.join(dir, 'story.md');
    fs.writeFileSync(input, '原稿', 'utf8');
    const r = run(['register-user', '--input', input, '--out', out]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /confirmed-by/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 剧本修订（2026-09-22 新增入口）：此前剧本改一个字就只能手删票重建，
// 于是**修订史整个丢失**，谁也答不出"这版改了什么、从哪版改来"。
test('revise 归档旧票并写第 2 版，来源属性原样继承', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'script-revise-'));
  try {
    const out = path.join(dir, 'story.md');
    const v1 = path.join(dir, 'v1.md');
    const v2 = path.join(dir, 'v2.md');
    fs.writeFileSync(v1, '第一场\n\n甲：你好。\n', 'utf8');
    assert.equal(run(['register-agent', '--input', v1, '--out', out]).status, 0);
    const r1 = JSON.parse(fs.readFileSync(path.join(dir, 'story.provenance.json'), 'utf8'));

    fs.writeFileSync(v2, '第一场\n\n甲：你好。\n乙：再见。\n', 'utf8');
    const r = run(['revise', '--input', v2, '--out', out, '--reason', '补乙的台词']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(out, 'utf8'), fs.readFileSync(v2, 'utf8'));

    // 旧票归档，不覆盖 —— 修订史可回溯。
    const archived = JSON.parse(fs.readFileSync(path.join(dir, 'story.provenance.v1.json'), 'utf8'));
    assert.equal(archived.story_sha256, r1.story_sha256, '归档的必须是修订前的那一版');

    const r2 = JSON.parse(fs.readFileSync(path.join(dir, 'story.provenance.json'), 'utf8'));
    assert.equal(r2.revision, 2);
    assert.equal(r2.revise_reason, '补乙的台词');
    assert.equal(r2.revised_from.story_sha256, r1.story_sha256, '新票要指向自己从哪版改来');
    // 修订不改来源属性：Agent 直写的稿子不会因此变成模型产物。
    assert.equal(r2.source, 'agent_draft');
    assert.equal(r2.model, null);
    assert.equal(r2.drafted_by, 'agent');
    assert.notEqual(r2.story_sha256, r1.story_sha256, '内容变了，哈希必须跟着变');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('revise 必须有票才能改，也必须写明原因', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'script-revise-'));
  try {
    const out = path.join(dir, 'story.md');
    const draft = path.join(dir, 'draft.md');
    fs.writeFileSync(draft, '剧本', 'utf8');
    // 无票 → 拒绝（没登记过的剧本该走 register-*，不是 revise）
    const noReceipt = run(['revise', '--input', draft, '--out', out, '--reason', 'x']);
    assert.notEqual(noReceipt.status, 0);
    assert.match(noReceipt.stderr, /没有来源票据|没有可修订/);

    assert.equal(run(['register-agent', '--input', draft, '--out', out]).status, 0);
    const noReason = run(['revise', '--input', draft, '--out', out]);
    assert.notEqual(noReason.status, 0);
    assert.match(noReason.stderr, /--reason/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('首次登记仍然拒绝覆盖 —— 防「确认 A 交付 B」', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'script-revise-'));
  try {
    const out = path.join(dir, 'story.md');
    const draft = path.join(dir, 'draft.md');
    fs.writeFileSync(draft, '剧本', 'utf8');
    assert.equal(run(['register-agent', '--input', draft, '--out', out]).status, 0);
    const again = run(['register-agent', '--input', draft, '--out', out]);
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /revise/, '已存在的剧本要改，提示走 revise');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log('script-register: 7/7 passed');
