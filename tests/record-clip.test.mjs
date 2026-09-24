/**
 * `cli/record-clip.mjs` —— 把某个单元的主产物换成另一个文件（去字幕版就是常见场景）。
 *
 * 守的是那个**已经咬过人的缺口**：产物记录里还指着带字幕的原片，而下游
 * 取的是 `files[]` 里第一条存在的 —— 拿原片去截交接尾帧，字幕文字会被烤进下一张关键帧。
 * 所以"换了主产物"这件事必须是**显式的一次记录**，而且顺序要对。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'cli', 'record-clip.mjs');
// 放在仓库内（.tmp 已 gitignore）——这样才验证得到"写仓库相对路径"这条规矩
const BASE = path.join(ROOT, '.tmp', `record-clip-${process.pid}`);
const PROJ = path.join(BASE, 'proj');
test.after(() => fs.rmSync(BASE, { recursive: true, force: true }));

fs.mkdirSync(path.join(PROJ, 'units'), { recursive: true });
const RAW = path.join(PROJ, 'units', 'i2v_raw.mp4');
const CLEAN = path.join(PROJ, 'units', 'g001_vsr.mp4');
fs.writeFileSync(RAW, 'raw');
fs.writeFileSync(CLEAN, 'clean');
const RESULT = path.join(PROJ, 'units', 'g001.result.json');
const writeResult = (files) => fs.writeFileSync(RESULT, JSON.stringify({ unit: 'g001', files }, null, 2));

const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
const filesOf = () => JSON.parse(fs.readFileSync(RESULT, 'utf8')).files.map((x) => (typeof x === 'string' ? x : (x.local_path || x.path)));

test('默认前插：干净版成为第一条（下游"取第一条存在的"才拿到它）', () => {
  writeResult([{ kind: 'video', local_path: 'projects/../projects/no.mp4' }, { kind: 'video', local_path: path.relative(ROOT, RAW).replace(/\\/g, '/') }]);
  const r = run(PROJ, '--unit', 'g001', '--clip', path.relative(PROJ, CLEAN), '--note', '去字幕（VSR）');
  assert.equal(r.status, 0, r.stderr);
  const files = filesOf();
  assert.equal(files[0], path.relative(ROOT, CLEAN).replace(/\\/g, '/'), '干净版必须在最前');
  assert.ok(files.includes(path.relative(ROOT, RAW).replace(/\\/g, '/')), '原片仍留在记录里（重跑/审计要用）');
  assert.match(r.stdout, /已前插到最前/);
});

test('已记过的同一文件只挪位置，不重复记账', () => {
  const before = filesOf().length;
  const r = run(PROJ, '--unit', 'g001', '--clip', path.relative(PROJ, CLEAN));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(filesOf().length, before, '重复记录不该让 files[] 变长');
  assert.equal(filesOf()[0], path.relative(ROOT, CLEAN).replace(/\\/g, '/'));
});

test('--append：追加到末尾（需要保留原片为主产物时）', () => {
  writeResult([{ kind: 'video', local_path: path.relative(ROOT, RAW).replace(/\\/g, '/') }]);
  const r = run(PROJ, '--unit', 'g001', '--clip', path.relative(PROJ, CLEAN), '--append');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(filesOf()[1], path.relative(ROOT, CLEAN).replace(/\\/g, '/'));
  assert.match(r.stdout, /追加到末尾/);
});

test('写出来的是仓库相对路径，不是本机绝对路径', () => {
  writeResult([]);
  run(PROJ, '--unit', 'g001', '--clip', path.relative(PROJ, CLEAN));
  const p = filesOf()[0];
  assert.ok(!/^[A-Za-z]:/.test(p), `记录里不该出现盘符：${p}`);
  assert.ok(p.startsWith('.tmp/'), `应是仓库相对：${p}`);
});

test('片段不存在 / 单元记录不存在：报错而不是记一条坏路径', () => {
  writeResult([]);
  assert.notEqual(run(PROJ, '--unit', 'g001', '--clip', 'units/nope.mp4').status, 0);
  assert.notEqual(run(PROJ, '--unit', 'g999', '--clip', path.relative(PROJ, CLEAN)).status, 0);
});

test('输出里给出下一步的重签命令（票只能由 review-gate 落笔）', () => {
  writeResult([]);
  const r = run(PROJ, '--unit', 'g001', '--clip', path.relative(PROJ, CLEAN));
  assert.match(r.stdout, /review-gate\.mjs approve/);
  assert.match(r.stdout, /--stage clip --id g001/);
});
