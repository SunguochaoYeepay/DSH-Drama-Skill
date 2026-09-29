import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runNode } from './helpers/spawn.mjs';
import { loadProject } from '../src/board-data.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const ASSETS = path.join(ROOT, 'cli', 'assets.mjs');
const GATE = path.join(ROOT, 'cli', 'review-gate.mjs');

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-asset-e2e-'));
  fs.writeFileSync(path.join(dir, 'board.json'), `${JSON.stringify({
    meta: { project: 'fake-e2e', title: 'Fake E2E', aspect: '9:16', style: 'realistic' },
    characters: [{ id: 'c1', name: '角色一', age_group: 'youth', face_prompt: '东亚人物', portrait: null, identities: ['i1'] }],
    identities: [{ id: 'i1', character: 'c1', name: '默认造型', appearance_details: '白色长袍', sheet: null }],
    scenes: [{ id: 's1', name: '房间', environment: '安静房间', time_of_day: '白天', master: null }],
    props: [],
  }, null, 2)}\n`);
  return dir;
}

test('资产 CLI E2E：fake provider → board 回填 → generation record → 人工票 → 看板状态', () => {
  const project = makeProject();
  const env = { ...process.env, AIH_ENABLE_FAKE_PROVIDER: '1', AIH_PROVIDER_RETRIES: '1' };
  const run = (script, args) => runNode([script, ...args], { cwd: ROOT, env, encoding: 'utf8' });

  const generated = run(ASSETS, [path.join(project, 'board.json'), '--provider', 'fake', '--skip-gate']);
  assert.equal(generated.status, 0, generated.stderr || generated.stdout);
  assert.match(generated.stdout, /已回填 3 个资产槽位/);

  const board = JSON.parse(fs.readFileSync(path.join(project, 'board.json'), 'utf8'));
  assert.ok(board.characters[0].portrait);
  assert.ok(board.identities[0].sheet);
  assert.ok(board.scenes[0].master);
  for (const rel of [board.characters[0].portrait, board.identities[0].sheet, board.scenes[0].master]) {
    assert.ok(fs.existsSync(path.join(project, rel)), rel);
  }

  const recordPath = path.join(project, 'reviews', 'assets.generation.json');
  const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  assert.equal(record.provider, 'fake');
  assert.equal(record.attempts.length, 3);
  assert.ok(record.attempts.every((entry) => entry.attempts === 1));
  const events = fs.readFileSync(path.join(project, 'reviews', 'execution.jsonl'), 'utf8')
    .trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(events.length, 3);
  assert.ok(events.every((event) => event.run_id === record.execution.run_id));
  assert.equal(record.execution.files[record.artifacts[0]]?.length, 64);
  assert.match(record.execution.run_id, /^[0-9a-f-]{36}$/);

  const approved = run(GATE, ['approve', '--project', project, '--stage', 'assets', '--by', 'E2E']);
  assert.equal(approved.status, 0, approved.stderr || approved.stdout);
  const tickets = JSON.parse(fs.readFileSync(path.join(project, 'review.approvals.json'), 'utf8'));
  assert.equal(tickets.approvals.assets.by, 'E2E');
  assert.equal(tickets.approvals.assets.generation.provider, 'fake');

  const snapshot = loadProject(ROOT, path.basename(project));
  // 项目在临时目录，不属于仓库根；用直接路径加载验证同一 board-data 读取契约。
  const direct = loadProject(path.dirname(project), path.basename(project));
  assert.ok(snapshot.error, '错误根读取不到临时项目应明确报错');
  assert.equal(direct.name, path.basename(project));
  assert.equal(direct.gates.assets.signed, true);
  assert.equal(direct.state.currentStage, 'story');
  assert.equal(direct.state.stages.assets.status, 'approved');
  fs.rmSync(project, { recursive: true, force: true });
});
