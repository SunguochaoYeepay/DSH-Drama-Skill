#!/usr/bin/env node
/**
 * director.test.mjs — 「导演」这一步的验收。
 *
 * 校验器挡的是**技术错误**，不是创作。但有一条是死线：
 * **导演不许写台词原文** —— 台词要一字不差，而"生成文字"天生做不到一字不差。
 *
 * 所以这里的断言分两类：
 *   ① 结构/技术约束（≤15s、行号、人物引用、切词）
 *   ② **死线**：台词必须用行号指，原文一个字都不许出现在输出里
 *
 *   node tests/director.test.mjs <board.json> [story.md]
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  validateDirection, collectDialogueLines, findDialogueLeak,
  checkReverseFacing, CUT_PHRASES, FRAMINGS, MAX_UNIT_SECONDS,
} from '../src/director.mjs';

let passed = 0;
const failures = [];
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`FAIL   ${label}${detail ? '  → ' + detail : ''}`); }
}

const boardPath = process.argv[2];
const storyPath = process.argv[3] || (boardPath ? path.join(path.dirname(boardPath), 'story.md') : null);
if (!boardPath || !fs.existsSync(boardPath)) { console.error('用法：node tests/director.test.mjs <board.json> [story.md]'); process.exit(2); }

const board = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
const script = storyPath && fs.existsSync(storyPath) ? fs.readFileSync(storyPath, 'utf8') : '';
const scriptLines = script ? script.split(/\r?\n/) : [];

console.log('\n台词识别');
const dlg = collectDialogueLines(board, scriptLines);
check('认出了台词行', dlg.size > 0, String(dlg.size));
check('每句都有原文', [...dlg.values()].every((t) => t && t.length > 1));
console.log(`       共 ${dlg.size} 句，行号 ${[...dlg.keys()].join(',')}`);

// 造一份最小可用的"导演产出"脚手架
const IDS = (board.identities || []).map((x) => x.id);
const A = IDS[0] || 'a';
const B = IDS[1] || 'b';
const allLines = [...dlg.keys()];
function mkUnit(over = {}) {
  return {
    id: 'u1',
    shots: [{
      n: 1, at: 0, duration_s: 4, framing: '全景', camera: '固定',
      on_screen: [A].filter(Boolean), action: '两人走着', lines: allLines,
    }],
    ...over,
  };
}
const ok = (dir) => validateDirection(dir, { board, script });

console.log('\n结构约束');
{
  const r = ok({ units: [mkUnit()] });
  check('一份齐全的设计通过', r.ok, r.errors.join(' | '));
}
check('空 units 被拒', !ok({ units: [] }).ok);
check('不是对象被拒', !ok(null).ok);
check('shots 为空被拒', !ok({ units: [{ id: 'u1', shots: [] }] }).ok);

console.log(`\n${MAX_UNIT_SECONDS}s 上限`);
check('单镜 18s 被拒', !ok({ units: [{ id: 'u1', shots: [{ n: 1, at: 0, duration_s: 18, framing: '全景', camera: '固定', on_screen: [A], action: 'x', lines: allLines }] }] }).ok);
check('单镜刚好 15s 通过', ok({ units: [{ id: 'u1', shots: [{ n: 1, at: 0, duration_s: 15, framing: '全景', camera: '固定', on_screen: [A], action: 'x', lines: allLines }] }] }).ok);
check('贴上限会给警告', ok({ units: [{ id: 'u1', shots: [{ n: 1, at: 0, duration_s: 14.9, framing: '全景', camera: '固定', on_screen: [A], action: 'x', lines: allLines }] }] }).warnings.some((w) => /15s/.test(w)));
check('多镜累计超 15s 被拒', !ok({ units: [{ id: 'u1', shots: [
  { n: 1, at: 0, duration_s: 9, framing: '全景', camera: '固定', on_screen: [A], action: 'a' },
  { n: 2, at: 9, duration_s: 8, cut: CUT_PHRASES[0], framing: '近景', camera: '固定', on_screen: [A], action: 'b', lines: allLines },
] }] }).ok);

console.log('\nat / n 的顺序');
check('第 1 镜 at 不是 0 被拒', !ok({ units: [{ id: 'u1', shots: [{ n: 1, at: 1, duration_s: 4, framing: '全景', camera: '固定', on_screen: [A], action: 'x', lines: allLines }] }] }).ok);
check('at 不递增被拒', !ok({ units: [{ id: 'u1', shots: [
  { n: 1, at: 5, duration_s: 5, framing: '全景', camera: '固定', on_screen: [A], action: 'a' },
  { n: 2, at: 3, duration_s: 3, cut: CUT_PHRASES[0], framing: '近景', camera: '固定', on_screen: [A], action: 'b', lines: allLines },
] }] }).ok);
check('n 跳号被拒', !ok({ units: [{ id: 'u1', shots: [{ n: 3, at: 0, duration_s: 4, framing: '全景', camera: '固定', on_screen: [A], action: 'x', lines: allLines }] }] }).ok);

console.log('\n枚举与引用');
check('景别不在枚举里被拒', !ok({ units: [{ id: 'u1', shots: [{ n: 1, at: 0, duration_s: 4, framing: '大特写', camera: '固定', on_screen: [A], action: 'x', lines: allLines }] }] }).ok);
check(`景别枚举是 ${FRAMINGS.join('/')}`, FRAMINGS.length === 5);
check('on_screen 引用不存在的人被拒', !ok({ units: [{ id: 'u1', shots: [{ n: 1, at: 0, duration_s: 4, framing: '全景', camera: '固定', on_screen: ['c_does_not_exist'], action: 'x', lines: allLines }] }] }).ok);
check('缺 camera（运镜）被拒', !ok({ units: [{ id: 'u1', shots: [{ n: 1, at: 0, duration_s: 4, framing: '全景', on_screen: [A], action: 'x', lines: allLines }] }] }).ok);
check('缺 action 被拒', !ok({ units: [{ id: 'u1', shots: [{ n: 1, at: 0, duration_s: 4, framing: '全景', camera: '固定', on_screen: [A], lines: allLines }] }] }).ok);
check('不正的切词被拒', !ok({ units: [{ id: 'u1', shots: [
  { n: 1, at: 0, duration_s: 5, framing: '全景', camera: '固定', on_screen: [A], action: 'a' },
  { n: 2, at: 5, duration_s: 3, cut: 'then it jumps', framing: '近景', camera: '固定', on_screen: [A], action: 'b', lines: allLines },
] }] }).ok);
check('合法切词都通过', CUT_PHRASES.every((c) => ok({ units: [{ id: 'u1', shots: [
  { n: 1, at: 0, duration_s: 5, framing: '全景', camera: '固定', on_screen: [A], action: 'a' },
  { n: 2, at: 5, duration_s: 3, cut: c, framing: '近景', camera: '固定', on_screen: [A], action: 'b', lines: allLines },
] }] }).ok));

console.log('\n台词：一条不漏、一条不重');
{
  const only1 = { units: [{ id: 'u1', shots: [{ n: 1, at: 0, duration_s: 5, framing: '全景', camera: '固定', on_screen: [A], action: 'x', lines: [allLines[0]] }] }] };
  const r = ok(only1);
  check('漏台词被拒', !r.ok && r.errors.some((e) => /漏了/.test(e)), r.errors.join(' | '));
}
{
  const dup = { units: [{ id: 'u1', shots: [
    { n: 1, at: 0, duration_s: 5, framing: '全景', camera: '固定', on_screen: [A], action: 'a', lines: [allLines[0]] },
    { n: 2, at: 5, duration_s: 3, cut: CUT_PHRASES[0], framing: '近景', camera: '固定', on_screen: [A], action: 'b', lines: allLines },
  ] }] };
  const r = ok(dup);
  check('台词重复放被拒', !r.ok && r.errors.some((e) => /放了多次/.test(e)), r.errors.join(' | '));
}
check('引用非台词行被拒', ok({ units: [{ id: 'u1', shots: [{ n: 1, at: 0, duration_s: 4, framing: '全景', camera: '固定', on_screen: [A], action: 'x', lines: [1] }] }] }).errors.some((e) => /不是台词行/.test(e)));

console.log('\n⛔ 死线：导演不许写台词原文');
{
  const sample = [...dlg.entries()].find(([, t]) => t.length >= 6);
  if (sample) {
    const [ln, text] = sample;
    const leak = { units: [{ id: 'u1', shots: [{
      n: 1, at: 0, duration_s: 4, framing: '近景', camera: '固定', on_screen: [A],
      action: `她说：${text}`, lines: [ln],
    }] }] };
    const r = ok(leak);
    check('**台词原文出现在 action 里 → 报错**', !r.ok && r.errors.some((e) => /死线/.test(e)), r.errors.join(' | '));
    check('  报错里点明了是第几行', r.errors.some((e) => e.includes(String(ln))));
  } else {
    check('（剧本里没有够长的台词可测）', true);
  }
  // 藏在字段名里也不行
  const hidden = { units: [{ id: 'u1', note: '这一镜是高潮', shots: [{
    n: 1, at: 0, duration_s: 4, framing: '近景', camera: '固定', on_screen: [A], action: '她看着他', lines: allLines,
  }] }] };
  check('自己写的注释不算台词泄漏', ok(hidden).ok, ok(hidden).errors.join(' | '));
}
{
  const fake = new Map([[1, '这是一句够长的假台词用来测试']]);
  check('findDialogueLeak 能定位', findDialogueLeak({ a: '她说：这是一句够长的假台词用来测试' }, fake).length === 1);
  check('findDialogueLeak 对短台词不误报', findDialogueLeak({ a: '好。' }, new Map([[1, '好。']])).length === 0);
}

console.log('\n正反打朝向（180 度线，只警告）');
// **这里曾经写反过**：第一版警告「同一个人连续两镜朝同一边」，
// 结果拿导演的真实产出跑，报了 5 次错 —— 而导演是对的，校验器是错的。
// 对话戏的正反打就是「她永远朝右、他永远朝左」，那正是 180 度线正确的形态。
{
  // 正反打正确形态：**每镜一个人**，她朝右、他朝左 —— 不该警告
  const good = checkReverseFacing({ units: [{ id: 'u1', shots: [
    { n: 1, facing: { [A]: 'right' } },
    { n: 2, facing: { [B]: 'left' } },
  ] }] });
  check('她朝右 / 他朝左（各一镜）→ 不警告（这是对的）', good.length === 0, JSON.stringify(good));

  // 两人同框却互相朝对方，下一镜两人同框却调换了方向 = 机位翻轴
  const axisFlip = checkReverseFacing({ units: [{ id: 'u1', shots: [
    { n: 1, facing: { [A]: 'right', [B]: 'left' } },
    { n: 2, facing: { [A]: 'left', [B]: 'right' } },
  ] }] });
  check('两人同框却整体翻轴 → 警告', axisFlip.length > 0, JSON.stringify(axisFlip));

  // 同一个人的同一朝向跨镜（正反打里必然发生）—— **也不该警告**
  const samePerson = checkReverseFacing({ units: [{ id: 'u1', shots: [
    { n: 1, facing: { [A]: 'right' } },
    { n: 2, facing: { [A]: 'right' } },
  ] }] });
  check('同一个人连续两镜同向 → 不警告（正反打就是这样）', samePerson.length === 0, JSON.stringify(samePerson));

  // 真正的问题：**两个人**都朝同一边
  const bad = checkReverseFacing({ units: [{ id: 'u1', shots: [
    { n: 1, facing: { [A]: 'right' } },
    { n: 2, facing: { [B]: 'right' } },
  ] }] });
  check('**两个人**都朝同一边 → 警告', bad.length === 1, JSON.stringify(bad));
  check('  警告里点出两个人', bad.length === 1 && bad[0].includes(A) && bad[0].includes(B), bad[0]);

  // toward / away 不参与左右判断
  const towardAway = checkReverseFacing({ units: [{ id: 'u1', shots: [
    { n: 1, facing: { [A]: 'toward' } },
    { n: 2, facing: { [B]: 'toward' } },
  ] }] });
  check('两人都 toward → 不警告（不是左右问题）', towardAway.length === 0, JSON.stringify(towardAway));

  check('朝向检查不阻断（只是警告）', (() => {
    const r2 = ok({ units: [{ id: 'u1', shots: [
      { n: 1, at: 0, duration_s: 5, framing: '近景', camera: '固定', on_screen: [A, B].filter(Boolean), action: 'a', facing: { [A]: 'right' } },
      { n: 2, at: 5, duration_s: 3, cut: CUT_PHRASES[0], framing: '近景', camera: '固定', on_screen: [A, B].filter(Boolean), action: 'b', lines: allLines, facing: { [B]: 'right' } },
    ] }] }, {});
    return r2.ok && r2.warnings.some((w) => /朝 right/.test(w));
  })());
}

console.log('\n' + '─'.repeat(56));
if (failures.length) {
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项：`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log(`全部通过（${passed} 项）—— 导演可以自由创作，但越界会被拦下，台词碰不得`);
}
