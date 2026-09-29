import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { compileDeepBlendScene } from '../src/deepblend-scene.mjs';

const root = path.resolve(import.meta.dirname, '..');
const plan = JSON.parse(fs.readFileSync(path.join(root, 'lab/whitebox/table-move.spatial.json'), 'utf8'));

test('spatial plan compiles to a DeepBlend SceneSpec with deterministic tracks', () => {
  const scene = compileDeepBlendScene(plan);
  assert.equal(scene.schemaVersion, 'deepblend.scene/v1');
  assert.equal(scene.project.frameEnd, 144);
  assert.equal(scene.entities.length, 4);
  assert.ok(scene.animationTracks.some((track) => track.id === 'A_loc_x_1'));
  const finalFacing = scene.animationTracks.find((track) => track.id === 'A_rot_z_2').keyframes.at(-1).value;
  assert.ok(Math.abs(finalFacing - (Math.PI / 2)) < 1e-9);
  assert.equal(scene.cameras[0].role, 'active-camera');
});

test('camera segments survive DeepBlend compilation as shot constraints', () => {
  const segmented = JSON.parse(JSON.stringify(plan));
  segmented.camera.segments = [
    { frame_range: [1, 72], framing: '发射近景', must_show: ['A'] },
    { frame_range: [73, 144], framing: '编队广角', must_show: ['A', 'B'] },
  ];
  const scene = compileDeepBlendScene(segmented);
  assert.match(scene.shots[0].description, /帧1-72 发射近景/);
  assert.match(scene.shots[0].description, /必须可见：A,B/);
});
