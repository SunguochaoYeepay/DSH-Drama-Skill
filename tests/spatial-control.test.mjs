import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeSpatialControl, buildSpatialPlanForUnit } from '../src/spatial-control.mjs';
import { compileSpatialPlan } from '../src/spatial-plan.mjs';
import { loadMenu, validateWhitebox } from '../src/whitebox-schema.mjs';
import path from 'node:path';

const menu = loadMenu(path.resolve('vendor/whitebox-assets'));

test('两人面对面打招呼自动进入白膜通道', () => {
  const unit = {
    id: 'u_greeting',
    keyframe_cast: ['i_a', 'i_b'],
    keyframe_start: '两个人面对面站立，准备互相打招呼',
    shots: [{ framing: '全景', duration_s: 4, on_screen: ['i_a', 'i_b'], action: '两个人面对面站立，互相打招呼' }],
  };
  const decision = analyzeSpatialControl({ unit, shot: unit.shots[0] });
  assert.equal(decision.required, true);
  assert.ok(decision.reasons.includes('spatial_relation'));
  const plan = buildSpatialPlanForUnit({ unit, shot: unit.shots[0] });
  assert.deepEqual(plan.spatial_control.assumptions, ['distance_m=2']);
  assert.deepEqual(plan.entities.map((item) => item.position), [[-1, 0], [1, 0]]);
  assert.deepEqual(plan.entities.map((item) => item.facing), [90, 270]);
  const whitebox = compileSpatialPlan(plan);
  assert.deepEqual(validateWhitebox(whitebox, menu), []);
});

test('单人普通静态镜头不强制生成白膜', () => {
  const unit = { keyframe_cast: ['i_a'], shots: [{ on_screen: ['i_a'], action: '人物站在窗边说话' }] };
  const decision = analyzeSpatialControl({ unit, shot: unit.shots[0] });
  assert.equal(decision.required, false);
  assert.equal(decision.mode, 'prompt_only');
});

test('导演显式关闭白膜时优先服从导演决定', () => {
  const unit = { spatial_control: { required: false }, keyframe_cast: ['i_a', 'i_b'], shots: [{ on_screen: ['i_a', 'i_b'], action: '两个人面对面站立' }] };
  assert.equal(analyzeSpatialControl({ unit, shot: unit.shots[0] }).required, false);
});

test('两人中间的小狗作为第三个白膜实体并进入必显主体', () => {
  const unit = {
    id: 'u_dog_greeting',
    keyframe_cast: ['i_a', 'i_b'],
    props: ['p_dog'],
    keyframe_start: '两个人面对面站立，中间是一只小狗，小狗看着两个人握手',
    shots: [{ framing: '全景', duration_s: 4, on_screen: ['i_a', 'i_b'], props: ['p_dog'], action: '两个人面对面站立，中间是一只小狗，小狗看着两个人握手' }],
  };
  const board = { props: [{ id: 'p_dog', name: '小狗', asset_type: 'dog' }] };
  const plan = buildSpatialPlanForUnit({ unit, shot: unit.shots[0], board });
  assert.equal(plan.entities.length, 3);
  assert.deepEqual(plan.entities[2].position, [0, 0]);
  assert.equal(plan.entities[2].asset_type, 'dog');
  assert.equal(plan.entities[0].motions[0].animation, 'Interact');
  assert.equal(plan.entities[1].motions[0].animation, 'Interact');
  assert.ok(plan.camera.must_show.includes('p_dog'));
  assert.equal(plan.camera.keys[0].angle, 270);
  const whitebox = compileSpatialPlan(plan);
  assert.deepEqual(validateWhitebox(whitebox, menu), []);
});
