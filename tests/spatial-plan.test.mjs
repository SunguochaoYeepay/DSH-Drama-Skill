import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { compileSpatialPlan, relationError } from '../src/spatial-plan.mjs';
import { loadMenu, validateWhitebox } from '../src/whitebox-schema.mjs';

const root = path.resolve(import.meta.dirname, '..');
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'lab/whitebox/table-move.spatial.json'), 'utf8'));
const menu = loadMenu(path.join(root, 'vendor/whitebox-assets'));

test('table scene resolves behind relation and compiles valid non-overlapping clips', () => {
  const result = compileSpatialPlan(fixture);
  assert.deepEqual(validateWhitebox(result, menu), []);
  const a = result.assets.find((asset) => asset.asset_id === 'A');
  assert.deepEqual(a.clips[0].start_pos, [0, -3.4]);
  assert.deepEqual(a.clips.at(-1).end_pos, [3, 0]);
  assert.equal(a.clips.at(-1).facing, 'towards:C');
  assert.equal(relationError(fixture, result, fixture.relations[0]).ok, true);
});

test('unknown targets and duplicate entities fail instead of guessing coordinates', () => {
  const unknown = structuredClone(fixture);
  unknown.relations[0].target = 'missing';
  assert.throws(() => compileSpatialPlan(unknown), /不存在/);
  const duplicate = structuredClone(fixture);
  duplicate.entities.push(duplicate.entities[0]);
  assert.throws(() => compileSpatialPlan(duplicate), /重复/);
});

test('relations respect target heading instead of camera orientation', () => {
  const plan = structuredClone(fixture);
  plan.entities.find((entity) => entity.id === 'B').facing = 270;
  plan.entities.find((entity) => entity.id === 'A').motions[0].from = [0, -3.4];
  plan.entities.find((entity) => entity.id === 'A').motions[0].to = [0, -3.4];
  assert.throws(() => compileSpatialPlan(plan), /冲突/);
});

test('chained relations resolve in dependency order and cycles fail clearly', () => {
  const chained = structuredClone(fixture);
  chained.entities = [
    { id: 'C', kind: 'character', type: 'male', position: [2, 0], motions: [{ frames: [1, 144], animation: 'Idle_Loop', facing: 0 }] },
    { id: 'B', kind: 'character', type: 'female', facing: 0, motions: [{ frames: [1, 144], animation: 'Idle_Loop', facing: 0 }] },
    { id: 'A', kind: 'character', type: 'kid', motions: [{ frames: [1, 144], animation: 'Idle_Loop', facing: 0 }] },
  ];
  chained.relations = [
    { type: 'left_of', subject: 'B', target: 'C', distance: 1 },
    { type: 'behind', subject: 'A', target: 'B', distance: 1 },
  ];
  const resolved = compileSpatialPlan(chained);
  assert.deepEqual(resolved.assets.find((a) => a.asset_id === 'B').clips[0].start_pos, [1, 0]);
  assert.deepEqual(resolved.assets.find((a) => a.asset_id === 'A').clips[0].start_pos, [1, -1]);

  const cycle = structuredClone(chained);
  cycle.entities.find((e) => e.id === 'C').position = null;
  cycle.relations = [
    { type: 'left_of', subject: 'A', target: 'B', distance: 1 },
    { type: 'left_of', subject: 'B', target: 'A', distance: 1 },
  ];
  assert.throws(() => compileSpatialPlan(cycle), /循环/);
});
