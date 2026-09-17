#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { identityContext, projectAssetFiles, resolveAssetPath, sceneIdForUnit, unitAssets } from '../src/asset-resolver.mjs';
import { approve, requireApproval } from '../src/human-gates.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'story2video-assets-'));
  const project = path.join(root, 'story2video', 'projects', 'other_show');
  const assets = path.join(project, 'assets');
  fs.mkdirSync(assets, { recursive: true });
  for (const name of ['aria-face.png', 'aria-winter.png', 'bo-face.png', 'bo-guard.png', 'hall.png', 'garden.png', 'key.png']) {
    fs.writeFileSync(path.join(assets, name), name);
  }
  const rel = (name) => `projects/other_show/assets/${name}`;
  const board = {
    characters: [
      { id: 'aria', name: 'Aria', portrait: rel('aria-face.png') },
      { id: 'bo', name: 'Bo', portrait: rel('bo-face.png') },
    ],
    identities: [
      { id: 'aria_winter', character: 'aria', name: 'Winter', sheet: rel('aria-winter.png') },
      { id: 'bo_guard', character: 'bo', name: 'Guard', sheet: rel('bo-guard.png') },
    ],
    scenes: [
      { id: 'hall', name: 'Hall', master: rel('hall.png') },
      { id: 'garden', name: 'Garden', master: rel('garden.png') },
    ],
    props: [{ id: 'brass_key', name: 'Brass key', ref_image: rel('key.png') }],
    shots: [
      { id: 's1', scene: 'hall', props: ['brass_key'], source_lines: [10] },
      { id: 's2', scene: 'garden', props: [], source_lines: [20] },
    ],
  };
  const boardPath = path.join(project, 'board.json');
  fs.writeFileSync(boardPath, JSON.stringify(board));
  return { root, board, boardPath };
}

test('从契约解析任意项目、角色、造型、场景和道具资产', () => {
  const { root, board, boardPath } = fixture();
  try {
    const unit = { id: 'g001', cast: ['aria_winter', 'bo_guard'], scene: 'hall', props: ['brass_key'], shots: [] };
    const assets = unitAssets(board, boardPath, unit);
    assert.deepEqual(assets.people.map((p) => p.name), ['Aria', 'Bo']);
    assert.equal(path.basename(assets.sceneMaster), 'hall.png');
    assert.equal(path.basename(assets.props[0].file), 'key.png');
    assert.equal(path.basename(resolveAssetPath(boardPath, board.characters[0].portrait)), 'aria-face.png');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('旧计划可以通过源台词行确定性回溯场景和道具', () => {
  const { root, board, boardPath } = fixture();
  try {
    const unit = { id: 'g002', cast: ['aria_winter'], shots: [{ lines: [10] }] };
    assert.equal(sceneIdForUnit(board, unit), 'hall');
    assert.equal(unitAssets(board, boardPath, unit).props[0].id, 'brass_key');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('多场景无法推断时拒绝默认取第一个场景', () => {
  const { root, board } = fixture();
  try {
    assert.throws(() => sceneIdForUnit(board, { id: 'g003', shots: [] }), /无法确定场景/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('不存在的造型引用立即报错', () => {
  const { root, board } = fixture();
  try {
    assert.throws(() => identityContext(board, 'missing_costume'), /不在 board.identities/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('资源确认绑定板子引用的完整文件集合且替换后失效', () => {
  const { root, board, boardPath } = fixture();
  try {
    const project = path.dirname(boardPath);
    const files = projectAssetFiles(board, boardPath);
    assert.equal(files.length, 7);
    approve(project, 'assets', files);
    assert.doesNotThrow(() => requireApproval(project, 'assets', files));
    fs.writeFileSync(files[0], 'replaced');
    assert.throws(() => requireApproval(project, 'assets', projectAssetFiles(board, boardPath)), /旧确认自动失效/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
