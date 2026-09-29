import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveProjectState } from '../src/project-state.mjs';

test('项目状态从可观察产物和票据推导，不会把 ready 当 approved', () => {
  const base = deriveProjectState({
    board: { story: { source: '故事' } },
    direction: { units: [{ id: 'u1' }] },
    plan: { units: [{ id: 'g001' }] },
    assets: [{ tab: 1, path: 'assets/a.png' }],
    units: [{ id: 'g001', keyframe: 'keyframes/g001.png', clip: null }],
  });
  assert.equal(base.stages.assets.status, 'ready');
  assert.equal(base.stages.assets.status === 'approved', false);
  assert.equal(base.currentStage, 'story');
});

test('片段票按单元计算，且 final 必须绑定真实成片', () => {
  const approvals = Object.fromEntries(['story', 'board', 'direction', 'assets', 'keyframes', 'final']
    .map((stage) => [stage, { by: 'test' }]));
  approvals.clips = { g001: { by: 'test' } };
  const state = deriveProjectState({
    board: {}, direction: {}, plan: {}, tickets: { approvals },
    assets: [{ tab: 1 }], units: [{ id: 'g001', keyframe: 'k.png', clip: 'c.mp4' }],
    finalArtifact: 'out/final.mp4',
  });
  assert.equal(state.currentStage, 'done');
  assert.equal(state.stages.final.status, 'approved');
});
