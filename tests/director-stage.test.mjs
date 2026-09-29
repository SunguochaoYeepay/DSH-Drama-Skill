import assert from 'node:assert/strict';
import test from 'node:test';
import { compileDirectorStage, createDirectorStage, validateDirectorStage } from '../src/director-stage.mjs';
import path from 'node:path';
import { loadMenu, validateWhitebox } from '../src/whitebox-schema.mjs';

function fixture() {
  const scene = createDirectorStage('greeting', { total_frames: 48 });
  scene.objects = [
    { id: 'a', type: 'character', name: 'A', build: 'male', color: '#4f8cff', position: { x: -1.5, y: 0, z: 0 }, facing: 90,
      action: 'Walk_Loop', motions: [{ frames: [1, 48], from: { x: -1.5, y: 0, z: 0 }, to: { x: -0.55, y: 0, z: 0 }, animation: 'Walk_Loop', facing: 90 }] },
    { id: 'b', type: 'character', name: 'B', build: 'female', color: '#ff6b6b', position: { x: 1.5, y: 0, z: 0 }, facing: 270,
      action: 'Walk_Loop', motions: [{ frames: [1, 48], from: { x: 1.5, y: 0, z: 0 }, to: { x: 0.55, y: 0, z: 0 }, animation: 'Walk_Loop', facing: 270 }] },
    { id: 'cam', type: 'camera', name: '主机位', position: { x: 0, y: 2, z: -7 }, target: { x: 0, y: 1, z: 0 }, fov: 48 },
  ];
  scene.active_camera_id = 'cam';
  return scene;
}

test('director stage validates and compiles to existing whitebox contract', () => {
  const scene = fixture();
  assert.equal(validateDirectorStage(scene), true);
  const whitebox = compileDirectorStage(scene);
  assert.equal(whitebox.schema, 'whitebox/1');
  assert.deepEqual(validateWhitebox(whitebox, loadMenu(path.resolve(import.meta.dirname, '..', 'vendor', 'whitebox-assets'))), []);
  assert.deepEqual(whitebox.assets.find((a) => a.asset_id === 'a').clips[0].start_pos, [-1.5, 0]);
  assert.deepEqual(whitebox.assets.find((a) => a.asset_id === 'a').clips[0].end_pos, [-0.55, 0]);
  assert.equal(whitebox.camera.keys[0].fov, 48);
});

test('shot snapshot overrides character motion without changing global scene', () => {
  const scene = fixture();
  scene.shots = [{ id: 'close', camera_id: 'cam', duration: 2, object_states: {
    a: { position: { x: -0.8, y: 0, z: 0 }, motions: [{ frames: [1, 48], from: { x: -0.8, y: 0, z: 0 }, to: { x: -0.8, y: 0, z: 0 }, animation: 'Idle_Loop', facing: 90 }] },
  } }];
  const whitebox = compileDirectorStage(scene, { shotId: 'close' });
  assert.equal(whitebox.scene_name, 'greeting-close');
  assert.deepEqual(whitebox.assets.find((a) => a.asset_id === 'a').clips[0].start_pos, [-0.8, 0]);
  assert.deepEqual(scene.objects.find((o) => o.id === 'a').position, { x: -1.5, y: 0, z: 0 });
});

test('invalid duplicate ids are rejected before compilation', () => {
  const scene = fixture();
  scene.objects.push({ ...scene.objects[0] });
  assert.throws(() => compileDirectorStage(scene), /id 重复/);
});
