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

// 2026-09-21 not_awake g002：柜面近景要的就是「脸不在画面里」，提示词却带着
// 「抽卡师提示：…应改用中景或斜侧中景」——一句与我们意图相反的构图指令进了模型。
// conflicts 是给人看的诊断：CLI 拿它打终端，`prompt` 里一律不许出现。
test('约束冲突只报给人看，不下发给模型', () => {
  const result = compileDrawPlan({
    unit: { keyframe_start: '女孩沿床长边仰面躺下' },
    shot: { framing: '近景', action: '' },
  });
  assert.equal(result.conflicts.length, 1);
  assert.doesNotMatch(result.prompt, /抽卡师提示|改用中景/);
  assert.match(result.prompt, /空间几何/);
});

// 画面里一个人都没有时（柜面近景只有一只手入画），"不要把身份图中的鞋履和站立姿势
// 复制过来"是一句无对象的话，还会把「鞋」「站立」这些实体字眼塞进画面描述。
test('画面里没有人时不输出禁鞋禁站立的排除项', () => {
  const result = compileCharacterDesign({
    designs: [{ kind: 'character_design', identity_id: 'girl_home', locked: { appearance: '白裙' } }],
    unit: { cast: [], keyframe_start: '她的右手从画面右下方的被子边缘伸进来，手掌悬在杯上方' },
    shot: { on_screen: [], action: '' },
  });
  assert.doesNotMatch(result.prompt, /鞋履|站立姿态/);
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
