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
fs.writeFileSync(board, JSON.stringify({ meta: { project: 'cli-errors', aspect: '9:16' } }));
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

// 机器检查已全部移除：旧导演稿、缺身份证的计划都不再由代码拒绝。
// 人工闸门仍在（见下面 keyframes 的断言）。
function noLongerRejected(script, args, forbidden) {
  const result = spawnSync(process.execPath, [path.join(root, 'cli', script), ...args], { encoding: 'utf8' });
  assert.doesNotMatch(result.stderr, forbidden, `${script} 不应再因机器检查拒绝`);
}

noLongerRejected('compile-units.mjs', [direction], /拒绝编译历史导演稿/);
noLongerRejected('unit.mjs', [board, '--direction', plan, '--unit', 'g001', '--dry-run'], /项目身份证|机器检查/);
noLongerRejected('assemble-units.mjs', [plan], /项目身份证|机器检查/);

const asset = path.join(dir, 'portrait.png');
fs.writeFileSync(asset, 'portrait');
fs.writeFileSync(board, JSON.stringify({
  meta: { project: 'cli-errors', aspect: '9:16' },
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

// 视频档位/超时那部分断言已移走：那属于「生成配置」，且已改成跑 dry-run 验实际档位
// （见 tests/generation-config.test.mjs），不再靠正则查源码里写没写那行参数。

console.log('cli errors: 5/5 passed');
