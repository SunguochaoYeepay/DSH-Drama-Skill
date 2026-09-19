#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'cli', 'compile-units.mjs');

const shot = (n, at, duration) => ({
  n, at, duration_s: duration, framing: '近景', camera: '固定',
  on_screen: ['a'], action: `shot ${n}`, lines: [],
});

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-units-manual-'));
  fs.writeFileSync(path.join(dir, 'board.json'),
    JSON.stringify({ meta: { project: 'manual-test', aspect: '9:16' } }));
  fs.writeFileSync(path.join(dir, 'story.md'), '测试剧本\n');
  fs.writeFileSync(path.join(dir, 'board.direction.json'), JSON.stringify({
    version: 6,
    logline: '手工边界冒烟',
    units: [
      { id: 'u1', shots: [shot(1, 0, 3)] },
      { id: 'u2', shots: [shot(1, 3, 3)] },
      { id: 'u3', shots: [shot(1, 6, 4)] },
    ],
  }));
  return dir;
}

function run(dir, units) {
  const out = path.join(dir, 'render.plan.json');
  const args = [cli, path.join(dir, 'board.direction.json'), '--out', out, '--skip-gate'];
  if (units !== undefined) {
    const unitsFile = path.join(dir, 'units.json');
    fs.writeFileSync(unitsFile, JSON.stringify(units));
    args.push('--units', unitsFile);
  }
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: root });
  return { ...result, plan: fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null, out };
}

test('默认切分：三个导演单元各成一段', () => {
  const dir = makeProject();
  try {
    const { status, plan, stderr } = run(dir);
    assert.equal(status, 0, stderr);
    assert.equal(plan.units.length, 3);
    assert.equal(plan.policy.manual_boundaries, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('--units 合并指定单元并直写生成时长', () => {
  const dir = makeProject();
  try {
    const { status, plan, stderr } = run(dir, {
      target_seconds: 12,
      groups: [{ source_units: ['u1', 'u2'] }, { source_units: ['u3'], generation_duration_s: 9.5 }],
    });
    assert.equal(status, 0, stderr);
    assert.equal(plan.units.length, 2);
    assert.deepEqual(plan.units[0].source_units, ['u1', 'u2']);
    assert.equal(plan.units[0].content_duration_s, 6);
    assert.equal(plan.units[1].generation_duration_s, 9.5);
    assert.equal(plan.policy.manual_boundaries, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('--units 引用不存在的导演单元时报错退出，不产出计划', () => {
  const dir = makeProject();
  try {
    const { status, plan, stderr } = run(dir, { groups: [{ source_units: ['u1', 'nope'] }] });
    assert.notEqual(status, 0);
    assert.match(stderr, /不存在的单元/);
    assert.equal(plan, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('--units 文件缺少 groups 时报错退出', () => {
  const dir = makeProject();
  try {
    const { status, stderr } = run(dir, { target_seconds: 12 });
    assert.notEqual(status, 0);
    assert.match(stderr, /groups/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
