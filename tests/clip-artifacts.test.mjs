/**
 * 「这一段当前有哪些产物 / 哪个是主产物」—— **只有一份实现**。
 *
 * 2026-09-24 `divorce_standoff` 实测的坑：三个消费者各写各的 ——
 *   · `cli/unit.mjs` 校验上一段时绑 `files[]` 里**全部**存在的产物；
 *   · `cli/prepare-handoff.mjs` 只绑**第一条**；
 *   · 合成（`requireAllClips`）绑**全部**。
 * 于是刚签好的 clip 票，换一个 CLI 就被判"产物已变化"，来回重签了三次。
 * 现在统一到 `clipArtifactFiles()`（票绑全部、顺序即记录顺序）与
 * `primaryClipFile()`（主产物 = 第一条，抽尾帧/合成取源用它）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { clipArtifactFiles, primaryClipFile } from '../src/human-gates.mjs';

const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-clips-'));
test.after(() => fs.rmSync(PROJ, { recursive: true, force: true }));
fs.mkdirSync(path.join(PROJ, 'units'), { recursive: true });

const writeResult = (id, files) => fs.writeFileSync(
  path.join(PROJ, 'units', `${id}.result.json`),
  JSON.stringify({ unit: id, files }, null, 2),
);
const touch = (rel) => {
  const abs = path.join(PROJ, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, 'x');
  return abs;
};

test('票绑全部存在的产物，顺序 = 记录顺序（去字幕版在前 = 主产物）', () => {
  const clean = touch('units/g001_vsr.mp4');
  const raw = touch('units/i2v_raw.mp4');
  writeResult('g001', [
    { kind: 'video', local_path: 'units/g001_vsr.mp4', note: '去字幕（VSR）' },
    { kind: 'video', local_path: 'units/i2v_raw.mp4' },
  ]);
  assert.deepEqual(clipArtifactFiles(PROJ, 'g001'), [clean, raw]);
  assert.equal(primaryClipFile(PROJ, 'g001'), clean, '主产物必须是第一条');
});

test('记录里已经不存在的文件不进票（否则票永远对不上）', () => {
  const clean = touch('units/g002_vsr.mp4');
  writeResult('g002', [
    { local_path: 'units/g002_gone.mp4' },
    { local_path: 'units/g002_vsr.mp4' },
  ]);
  assert.deepEqual(clipArtifactFiles(PROJ, 'g002'), [clean]);
  assert.equal(primaryClipFile(PROJ, 'g002'), clean, '第一条不存在时应落到下一条存在的');
});

test('字符串形式的记录也认（老项目两种写法都在）', () => {
  const a = touch('units/g003_a.mp4');
  writeResult('g003', ['units/g003_a.mp4']);
  assert.deepEqual(clipArtifactFiles(PROJ, 'g003'), [a]);
});

test('没有产物记录 / 记录为空：给空数组与 null，不抛', () => {
  writeResult('g004', []);
  assert.deepEqual(clipArtifactFiles(PROJ, 'g004'), []);
  assert.equal(primaryClipFile(PROJ, 'g004'), null);
  assert.deepEqual(clipArtifactFiles(PROJ, 'nope'), []);
  assert.equal(primaryClipFile(PROJ, 'nope'), null);
});
