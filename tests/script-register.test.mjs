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

console.log('script-register: 4/4 passed');
