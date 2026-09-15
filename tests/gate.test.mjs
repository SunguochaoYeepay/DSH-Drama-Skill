#!/usr/bin/env node
/**
 * gate.test.mjs — 闸门语义的验收。
 *
 * 闸门只有一条规则：**用户没点头的东西不许往下走**。
 * 这里钉死两件事：
 *   1. 没确认故事 → from-story 放行不了
 *   2. 故事确认了 → from-story **能**跑（不许拿 stage 拦它自己）
 *
 *   node tests/gate.test.mjs
 */

import { checkGate } from '../src/board.mjs';

let passed = 0;
const failures = [];
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`FAIL   ${label}${detail ? '  → ' + detail : ''}`); }
}

/** 造一份指定阶段的板子。 */
function board(stage, approvals) {
  return { meta: { stage, approvals: { story: null, shots: null, assets: null, keyframes: null, ...approvals } } };
}

console.log('\n闸门语义');

// ① 故事没确认 → 不许编译分镜
const g1 = checkGate(board('story', {}), 'shots');
check('故事没确认时 from-story 被拦', g1.length > 0 && g1[0].includes('story'), JSON.stringify(g1));

// ② 故事确认了，但 stage 还停在 story —— 这正是 from-story 该跑的时候
const g2 = checkGate(board('story', { story: { at: 'x', by: '用户' } }), 'shots');
check('故事确认后 from-story 放行（stage 仍是 story）', g2.length === 0, JSON.stringify(g2));

// ③ 出片需要四个闸门全确认
const g3 = checkGate(board('rendering', { story: { at: 'x', by: 'u' }, shots: { at: 'x', by: 'u' } }), 'rendering');
check('出片前四道闸门缺两道就被拦', g3.length === 2, JSON.stringify(g3));

const g4 = checkGate(board('rendering', {
  story: { at: 'x', by: 'u' }, shots: { at: 'x', by: 'u' },
  assets: { at: 'x', by: 'u' }, keyframes: { at: 'x', by: 'u' },
}), 'rendering');
check('四道闸门齐了才放行出片', g4.length === 0, JSON.stringify(g4));

// ④ 确认顺序不能跳：批了 assets 没批 shots，仍然拦住
const g5 = checkGate(board('assets', {
  story: { at: 'x', by: 'u' }, shots: null, assets: { at: 'x', by: 'u' },
}), 'rendering');
check('跳着批的票据拦得住出片', g5.some((e) => e.includes('shots')), JSON.stringify(g5));

console.log('\n' + '─'.repeat(56));
if (failures.length) {
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项：`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log(`全部通过（${passed} 项）—— 闸门只看用户的票，不看自己推进到哪`);
}
