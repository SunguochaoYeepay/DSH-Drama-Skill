import assert from 'node:assert/strict';
import test from 'node:test';
import { compileDrawPlan } from '../src/draw-specialist.mjs';

test('抽卡师 removes timeline wording and expands spatial geometry', () => {
  const result = compileDrawPlan({
    unit: { keyframe_start: '0秒时女孩仰面躺在床上，双手放在被面上' },
    shot: { framing: '中景', action: '' },
  });
  assert.equal(result.source, '女孩仰面躺在床上，双手放在被面上');
  assert.match(result.prompt, /空间几何/);
  assert.equal(result.conflicts.length, 0);
});

test('抽卡师 reports when a close shot cannot prove full spatial relation', () => {
  const result = compileDrawPlan({
    unit: { keyframe_start: '女孩沿床长边仰面躺下' },
    shot: { framing: '近景', action: '' },
  });
  assert.equal(result.conflicts.length, 1);
  assert.match(result.conflicts[0], /景别/);
});
