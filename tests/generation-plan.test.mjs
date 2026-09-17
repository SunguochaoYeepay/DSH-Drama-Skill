#!/usr/bin/env node

import assert from 'node:assert/strict';
import test from 'node:test';
import { compileGenerationPlan } from '../src/generation-plan.mjs';

const shot = (n, at, duration, cast, extra = {}) => ({
  n, at, duration_s: duration, framing: '近景', camera: '固定',
  on_screen: cast, action: `shot ${n}`, lines: [], ...extra,
});

test('人物集合变化时重新开启生成单元', () => {
  const direction = { units: [{ id: 'u1', shots: [
    shot(1, 0, 3, ['a', 'b']),
    shot(2, 3, 4, ['b'], { cut: 'the camera cuts to' }),
    shot(3, 7, 3, ['a'], { cut: 'the camera cuts to' }),
  ] }] };
  const plan = compileGenerationPlan(direction);
  assert.equal(plan.units.length, 3);
  assert.deepEqual(plan.units.map((u) => u.cast), [['a', 'b'], ['b'], ['a']]);
  assert.ok(plan.units.every((u) => u.shots[0].at === 0));
});

test('同一人物的连续镜头可在十秒窗口内合并', () => {
  const direction = { units: [{ id: 'u1', shots: [
    shot(1, 0, 4, ['a']),
    shot(2, 4, 5, ['a'], { cut: 'the camera cuts to' }),
  ] }] };
  const plan = compileGenerationPlan(direction);
  assert.equal(plan.units.length, 1);
  assert.equal(plan.units[0].content_duration_s, 9);
  assert.equal(plan.units[0].shots.length, 2);
});

test('短镜头只补生成预算，不改导演内容时长', () => {
  const direction = { units: [{ id: 'u1', shots: [shot(1, 0, 2.4, ['a'])] }] };
  const plan = compileGenerationPlan(direction);
  assert.equal(plan.units[0].content_duration_s, 2.4);
  assert.equal(plan.units[0].generation_duration_s, 5.17);
  assert.equal(plan.units[0].shots[0].duration_s, 2.4);
  assert.deepEqual(plan.totals, {
    content_duration_s: 2.4,
    projected_delivery_duration_s: 5.17,
    keyframe_count: 1,
  });
});

test('导演原单元边界始终保留', () => {
  const direction = { units: [
    { id: 'u1', shots: [shot(1, 0, 3, ['a'])] },
    { id: 'u2', shots: [shot(1, 0, 3, ['a'])] },
  ] };
  assert.equal(compileGenerationPlan(direction).units.length, 2);
});

test('只重排执行边界，不改导演镜头内容', () => {
  const original = [
    shot(1, 0, 3, ['a', 'b'], { cut: 'the camera cuts to', lines: [7], lighting: '晨光' }),
    shot(2, 3, 2, ['b'], { camera: '推镜', lines: [9] }),
  ];
  const plan = compileGenerationPlan({ units: [{ id: 'u1', shots: structuredClone(original) }] });
  const restored = plan.units.flatMap((u) => u.shots).map((s) => {
    const copy = structuredClone(s);
    copy.n = copy.source.shot;
    copy.at += original[copy.n - 1].at;
    delete copy.source;
    if (copy.director_cut) copy.cut = copy.director_cut;
    delete copy.director_cut;
    return copy;
  });
  assert.deepEqual(restored, original);
});

test('v2 单元边界由导演决定，编译器不再按人物或十秒窗口二次拆分', () => {
  const direction = { version: 2, units: [{
    id: 'u1', why: '导演决定连续生成', duration_reason: '完整表演需要十二秒', keyframe_start: '两人静止对视',
    keyframe_cast: ['a', 'b'],
    shots: [
      shot(1, 0, 6, ['a', 'b']),
      shot(2, 6, 6, ['b'], { cut: 'the camera cuts to' }),
    ],
  }] };
  const plan = compileGenerationPlan(direction);
  assert.equal(plan.units.length, 1);
  assert.equal(plan.units[0].content_duration_s, 12);
  assert.equal(plan.units[0].keyframe_start, '两人静止对视');
  assert.deepEqual(plan.units[0].keyframe_cast, ['a', 'b']);
  assert.equal(plan.policy.director_owns_unit_boundaries, true);
});

test('场景与道具引用保留到生成单元', () => {
  const direction = { version: 2, units: [{
    id: 'u1', why: '同场连续动作', duration_reason: '动作需要五秒', keyframe_start: '人物静止',
    shots: [shot(1, 0, 5, ['hero_day'], { scene: 'market', props: ['red_umbrella'] })],
  }] };
  const unit = compileGenerationPlan(direction).units[0];
  assert.equal(unit.scene, 'market');
  assert.deepEqual(unit.props, ['red_umbrella']);
});

test('动作复杂度分析保留到生成单元', () => {
  const actionComplexity = {
    level: 'medium', strategy: 'single_transition',
    high_risk_events: [{ at_s: 2, type: 'multi_actor_contact', description: '人物抓住目标' }],
  };
  const direction = { version: 4, units: [{
    id: 'u1', why: '同场动作', duration_reason: '动作需要五秒', keyframe_start: '尚未接触',
    keyframe_cast: ['hero'], action_complexity: actionComplexity,
    shots: [shot(1, 0, 5, ['hero'])],
  }] };
  const unit = compileGenerationPlan(direction).units[0];
  assert.deepEqual(unit.action_complexity, actionComplexity);
  assert.notEqual(unit.action_complexity, actionComplexity);
});

test('连续性状态契约保留到生成单元', () => {
  const continuity = { mode: 'continue_previous', previous_unit: 'u1', handoff_state: '人物仍趴在地面', deferred_keyframe: true, allowed_changes: ['framing'] };
  const direction = { version: 6, units: [
    { id: 'u1', end_state: '人物闭眼保持不动', continuity: { mode: 'independent', reason: '开场' }, shots: [shot(1, 0, 5, ['a'])] },
    { id: 'u2', end_state: '人物继续趴地', continuity, shots: [shot(1, 0, 5, ['a'])] },
  ] };
  const unit = compileGenerationPlan(direction).units[1];
  assert.deepEqual(unit.continuity, { ...continuity, previous_unit: 'g001', previous_source_unit: 'u1' });
  assert.equal(unit.end_state, '人物继续趴地');
  assert.notEqual(unit.continuity, continuity);
});
