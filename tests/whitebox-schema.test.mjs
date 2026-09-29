import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadMenu, validateWhitebox } from '../src/whitebox-schema.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const menu = loadMenu(path.join(repoRoot, 'vendor', 'whitebox-assets'));
const fightDoc = JSON.parse(fs.readFileSync(path.join(repoRoot, 'lab', 'whitebox', 'fight.unit.json'), 'utf8'));

/** fight 范本改一笔：深拷贝后按补丁函数破坏它。 */
const broken = (fn) => { const d = JSON.parse(JSON.stringify(fightDoc)); fn(d); return d; };

test('fight 范本（含相机/shake/stills）通过校验', () => {
  assert.deepEqual(validateWhitebox(fightDoc, menu), []);
});

test('菜单来自真实 manifest：46 条动作、三档角色', () => {
  assert.equal(menu.animations.size, 46);
  assert.deepEqual(Object.keys(menu.roles).sort(), ['female', 'kid', 'male']);
});

test('拒绝菜单外动画（AI 禁止编造）', () => {
  const errors = validateWhitebox(broken((d) => { d.assets[0].clips[2].animation = 'Backflip_360'; }), menu);
  assert.ok(errors.some((e) => e.includes('Backflip_360') && e.includes('不在菜单里')));
});

test('拒绝菜单外角色档位', () => {
  const errors = validateWhitebox(broken((d) => { d.assets[0].asset_type = 'robot'; }), menu);
  assert.ok(errors.some((e) => e.includes('robot')));
});

test('facing 必填：缺了就是歪着出拳（fight.py 学费）', () => {
  const errors = validateWhitebox(broken((d) => { delete d.assets[0].clips[2].facing; }), menu);
  assert.ok(errors.some((e) => e.includes('facing 必填')));
});

test('blend_frames 0 被拒（防姿态瞬移）', () => {
  const errors = validateWhitebox(broken((d) => { d.assets[0].clips[2].blend_frames = 0; }), menu);
  assert.ok(errors.some((e) => e.includes('blend_frames')));
});

test('同一角色帧区间重叠被拒', () => {
  const errors = validateWhitebox(broken((d) => { d.assets[0].clips[1].frame_range = [40, 121]; }), menu);
  assert.ok(errors.some((e) => e.includes('重叠')));
});

test('位移类动作缺 end_pos 被拒', () => {
  const errors = validateWhitebox(broken((d) => { delete d.assets[0].clips[0].end_pos; }), menu);
  assert.ok(errors.some((e) => e.includes('end_pos')));
});

test('位置出房间边界被拒', () => {
  const errors = validateWhitebox(broken((d) => { d.assets[0].clips[0].start_pos = [-9, 0]; }), menu);
  assert.ok(errors.some((e) => e.includes('超出房间边界')));
});

test('towards 指向不存在的 asset 被拒', () => {
  const errors = validateWhitebox(broken((d) => { d.assets[0].clips[1].facing = 'towards:C'; }), menu);
  assert.ok(errors.some((e) => e.includes('towards:C')));
});

test('pan-follow 缺 track 被拒；track 指向不存在 asset 也被拒', () => {
  const noTrack = validateWhitebox(broken((d) => { delete d.camera.track; }), menu);
  assert.ok(noTrack.some((e) => e.includes('track')));
  const badTrack = validateWhitebox(broken((d) => { d.camera.track = 'Z'; }), menu);
  assert.ok(badTrack.some((e) => e.includes('Z')));
});

test('orbit 的 angle 必须单调递增', () => {
  const errors = validateWhitebox(broken((d) => { d.camera.type = 'orbit'; d.camera.keys[2].angle = 100; }), menu);
  assert.ok(errors.some((e) => e.includes('单调递增')));
});

test('stills 帧号越界被拒', () => {
  const errors = validateWhitebox(broken((d) => { d.outputs.stills = [1, 999]; }), menu);
  assert.ok(errors.some((e) => e.includes('stills')));
});

test('刚体道具：合法 jet 轨迹通过；穿地 waypoint 被拒', () => {
  const withJet = broken((d) => {
    d.assets.push({
      asset_id: 'jet1', kind: 'prop', asset_type: 'jet',
      path: { frame_range: [1, 168], waypoints: [[-3, -2, 2.5], [0, 0, 1.2], [3, 2, 2.8]], bank: true },
    });
  });
  assert.deepEqual(validateWhitebox(withJet, menu), []);

  const underground = broken((d) => {
    d.assets.push({
      asset_id: 'm1', kind: 'prop', asset_type: 'missile',
      path: { frame_range: [1, 168], waypoints: [[0, 0, 1], [1, 1, -0.5]] },
    });
  });
  assert.ok(validateWhitebox(underground, menu).some((e) => e.includes('穿地')));
});

test('platform 站台 + train 列车 + look_at + phase_offset + 角色 color：全通过', () => {
  const subwayDoc = JSON.parse(fs.readFileSync(path.join(repoRoot, 'lab', 'whitebox', 'subway.unit.json'), 'utf8'));
  assert.deepEqual(validateWhitebox(subwayDoc, menu), []);
});

test('拒绝编造的道具类型（如 spaceship）', () => {
  const errors = validateWhitebox(broken((d) => {
    d.assets.push({ asset_id: 's1', kind: 'prop', asset_type: 'spaceship', path: { frame_range: [1, 168], waypoints: [[0, 0, 1], [1, 1, 1]] } });
  }), menu);
  assert.ok(errors.some((e) => e.includes('spaceship') && e.includes('内置基本体')));
});

test('拒绝编造的 stage 预设（如 airport）与非法 look_at / phase_offset / color', () => {
  assert.ok(validateWhitebox(broken((d) => { d.stage = { preset: 'airport' }; }), menu)
    .some((e) => e.includes('airport')));
  assert.ok(validateWhitebox(broken((d) => { d.camera.look_at = ['0', 1]; }), menu)
    .some((e) => e.includes('look_at')));
  assert.ok(validateWhitebox(broken((d) => { d.assets[0].clips[0].phase_offset = 1; }), menu)
    .some((e) => e.includes('phase_offset')));
  assert.ok(validateWhitebox(broken((d) => { d.assets[0].color = 1.4; }), menu)
    .some((e) => e.includes('color')));
});
