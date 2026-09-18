import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cli-errors-'));
const board = path.join(dir, 'board.json');
const story = path.join(dir, 'story.md');
const direction = path.join(dir, 'board.direction.json');
const plan = path.join(dir, 'render.plan.json');
fs.writeFileSync(board, JSON.stringify({ meta: { project: 'cli-errors' } }));
fs.writeFileSync(story, 'test');
fs.writeFileSync(direction, JSON.stringify({ version: 4, units: [] }));
fs.writeFileSync(plan, JSON.stringify({ units: [{ id: 'g001', shots: [] }] }));

function rejected(script, args, expected) {
  const result = spawnSync(process.execPath, [path.join(root, 'cli', script), ...args], { encoding: 'utf8' });
  assert.equal(result.status, 1, `${script} 应以业务失败退出`);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, expected);
  assert.doesNotMatch(result.stderr, /\n\s*at |ModuleJob\.run|node:internal/);
}

rejected('compile-units.mjs', [direction], /错误：拒绝编译历史导演稿 v4/);
rejected('unit.mjs', [board, '--direction', plan, '--unit', 'g001', '--dry-run'], /错误：生成计划没有项目身份证/);
rejected('assemble-units.mjs', [plan], /错误：生成计划没有项目身份证/);

const asset = path.join(dir, 'portrait.png');
fs.writeFileSync(asset, 'portrait');
fs.writeFileSync(board, JSON.stringify({
  meta: { project: 'cli-errors' },
  characters: [{ id: 'cat', name: '猫', portrait: asset }],
  identities: [], scenes: [], props: [],
}));
rejected('keyframes.mjs', [board, '--direction', plan, '--units', 'g001', '--dry-run'], /错误：人工闸门未通过：资源 尚未人工确认/);

const oldApprove = spawnSync(process.execPath, [path.join(root, 'src', 'board.mjs'), 'approve', board, '--stage', 'assets'], { encoding: 'utf8' });
assert.notEqual(oldApprove.status, 0);
assert.match(`${oldApprove.stdout}${oldApprove.stderr}`, /assets 已使用新版哈希票据/);

const assetApprove = spawnSync(process.execPath, [path.join(root, 'cli', 'review-gate.mjs'), 'approve', '--project', dir, '--stage', 'assets'], { encoding: 'utf8' });
assert.equal(assetApprove.status, 0, assetApprove.stderr);
assert.match(assetApprove.stdout, /人工确认已记录：assets/);

// 默认视频档必须真的是 FastVideo FastH3 单首帧，不能因内部步数默认值退化成 r2v。
const unitSource = fs.readFileSync(path.join(root, 'cli', 'unit.mjs'), 'utf8');
assert.match(unitSource, /return VIDEO_PROFILE;/);
assert.match(unitSource, /args\.push\('--attention', ATTENTION\)/);
assert.match(unitSource, /flag\('attention', VIDEO_ATTENTION\)/);
assert.doesNotMatch(unitSource, /const STEPS = Number\(flag\('steps', 4\)\)/);
assert.match(fs.readFileSync(path.join(root, 'src', 'config.mjs'), 'utf8'), /VIDEO_TIMEOUT_SECONDS < 1 \|\| VIDEO_TIMEOUT_SECONDS > 600/);
assert.match(unitSource, /'--timeout', String\(VIDEO_TIMEOUT_SECONDS\)/);
assert.doesNotMatch(unitSource, /timeout: 1800000/);

console.log('cli errors: 11/11 passed');
