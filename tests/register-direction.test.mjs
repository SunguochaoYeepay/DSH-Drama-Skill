import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const NODE = process.execPath;
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const CLI = path.join(root, 'cli', 'register-direction.mjs');
const GATE = path.join(root, 'cli', 'review-gate.mjs');

function run(args) {
  return spawnSync(NODE, [CLI, ...args], { cwd: root, encoding: 'utf8' });
}

/** 预置一张人工票。登记入口现在与 cli/direct.mjs 一样查剧本闸门，测试必须先过这一关。 */
function approve(dir, stage, artifacts = []) {
  const args = [GATE, 'approve', '--project', dir, '--stage', stage];
  if (artifacts.length) args.push('--artifacts', ...artifacts);
  const r = spawnSync(NODE, args, { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`预置 ${stage} 票失败：${r.stderr || r.stdout}`);
}

/** 建一个最小项目：板子 + 剧本（默认已批票）。本入口只做结构与留痕，不做契约校验。 */
function project({ approveStory = true, scenes = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'direction-agent-'));
  fs.writeFileSync(path.join(dir, 'board.json'),
    JSON.stringify({ meta: { project: 'tmp' }, characters: [], identities: [], scenes, props: [], shots: [] }), 'utf8');
  const story = path.join(dir, 'story.md');
  fs.writeFileSync(story, '第一场\n\n△ 她走过。\n', 'utf8');
  if (approveStory) approve(dir, 'story', [story]);
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

test('剧本没有人工票时拒绝登记（与 cli/direct.mjs 对齐）', () => {
  const dir = project({ approveStory: false });
  try {
    const input = path.join(dir, 'draft.json');
    fs.writeFileSync(input, draft([{ id: 'u1' }]), 'utf8');
    const r = run([path.join(dir, 'board.json'), '--input', input]);
    assert.notEqual(r.status, 0, '剧本未确认时不得登记导演稿');
    assert.match(r.stderr, /人工闸门未通过：剧本/);
    assert.equal(fs.existsSync(path.join(dir, 'board.direction.json')), false);
    assert.equal(fs.existsSync(`${path.join(dir, 'board.direction.json')}.provenance.json`), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--skip-gate 仅在调试时绕过剧本闸门', () => {
  const dir = project({ approveStory: false });
  try {
    const input = path.join(dir, 'draft.json');
    fs.writeFileSync(input, draft([{ id: 'u1' }]), 'utf8');
    const r = run([path.join(dir, 'board.json'), '--input', input, '--skip-gate']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /--skip-gate/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('单元缺 audience_knows 时登记成功、但把缺项提示出来（机器不阻断，报给人工看）', () => {
  const dir = project();
  try {
    const input = path.join(dir, 'draft.json');
    fs.writeFileSync(input, draft([
      { id: 'u1' },
      { id: 'u2', audience_knows: '观众已看见猫踩翻花盆，她还在低头看手机' },
    ]), 'utf8');
    const r = run([path.join(dir, 'board.json'), '--input', input]);
    assert.equal(r.status, 0, '缺字段不得阻断登记 —— 本工程的口径是「机器不阻断，唯一把关的是人工审阅」');
    assert.match(r.stderr, /audience_knows/);
    assert.match(r.stderr, /u1/);
    assert.doesNotMatch(r.stderr, /u2/, '写了 audience_knows 的单元不该被点名');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('镜头写到的空间实体不在该场景描述里 → 提示可能落错场景（不阻断）', () => {
  const scenes = [
    { id: 'ext', name: '高空外景', environment: '高空，螺旋桨飞机外部，白天。机身朝画面左侧飞行，机身后方是白色云层。' },
    { id: 'door', name: '舱门口', environment: '机舱内部朝敞开的门洞看：门洞是画面最亮的区域，门框与门板朝外翻开，脚下是防滑花纹铁皮地板。' },
  ];
  const dir = project({ scenes });
  try {
    const input = path.join(dir, 'draft.json');
    fs.writeFileSync(input, draft([
      // 复刻 no_chute 的事故：镜头站在门口，却把场景写成了"从机外看飞机"
      { id: 'u1', audience_knows: '观众还不知道她没背伞', shots: [{ scene: 'ext', framing: '中景', action: '敞开的机舱门洞内两人并排站着' }] },
      { id: 'u2', audience_knows: '观众和她都以为话说完了', shots: [{ scene: 'door', framing: '中景', action: '两人在门洞内对话，脚下是防滑铁皮地板' }] },
    ]), 'utf8');
    const r = run([path.join(dir, 'board.json'), '--input', input]);
    assert.equal(r.status, 0, '只提示不阻断');
    assert.match(r.stderr, /可能落错场景/);
    assert.match(r.stderr, /u1/, '落错的那个必须被点名');
    assert.doesNotMatch(r.stderr, /u2/, '场景与内容相符的不该被点名');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log('register-direction: 9/9 passed');
