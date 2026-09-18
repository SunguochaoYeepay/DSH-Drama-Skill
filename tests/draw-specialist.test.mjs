import assert from 'node:assert/strict';
import test from 'node:test';
import { compileCharacterDesign, compileDrawPlan } from '../src/draw-specialist.mjs';

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

test('抽卡师 imports character designer constraints and excludes footwear in bed pose', () => {
  const result = compileCharacterDesign({
    designs: [{ kind: 'character_design', identity_id: 'girl_home', locked: { face: '黑发少女', appearance: '黑色长发，不合身男式T恤' } }],
    unit: { keyframe_cast: ['girl_home'], keyframe_start: '女孩仰面躺在床上' },
    shot: { on_screen: ['girl_home'], action: '' },
  });
  assert.match(result.prompt, /人物造型师锁定/);
  assert.match(result.prompt, /不要把身份图中的鞋履/);
});
