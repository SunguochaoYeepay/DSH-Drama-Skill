#!/usr/bin/env node
/**
 * contract.test.mjs — 阶段①的可编程验收。
 *
 * 验收标准不是"我觉得契约写得对"，而是：
 *   1. 迁移后的真实板子必须**通过**
 *   2. 每一类错误都必须被**拒掉**，而且报错要指对地方
 *
 *   node tests/contract.test.mjs <一份合法的 board.json>
 */

import fs from 'node:fs';
import path from 'node:path';
import { checkBoard } from '../src/board.mjs';
import { FIXTURE, fixtureOrArg } from './fixtures/index.mjs';

const file = fixtureOrArg(process.argv, 2, FIXTURE.board);
if (!file || !fs.existsSync(file)) {
  console.error('用法：node tests/contract.test.mjs [board.json]');
  process.exit(2);
}
const baseline = JSON.parse(fs.readFileSync(file, 'utf8'));

let passed = 0;
const failures = [];

function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`FAIL   ${label}${detail ? '  → ' + detail : ''}`); }
}

/** 复制一份、改一处、看它会不会被拒。 */
function expectRejected(label, mutate, needle) {
  const broken = structuredClone(baseline);
  mutate(broken);
  const { errors } = checkBoard(broken);
  const hit = errors.find((e) => e.includes(needle));
  check(label, errors.length > 0 && Boolean(hit), hit ? '' : `错误：${errors.slice(0, 2).join(' | ') || '（一个都没报）'}`);
}

console.log(`\n基线：${path.basename(file)}`);
const base = checkBoard(baseline);
check('迁移后的真实板子通过校验', base.errors.length === 0, base.errors.slice(0, 3).join(' | '));
console.log('');

console.log('负例（每一类都必须被拒）：');

expectRejected(
  'cast 引用了不存在的造型',
  (b) => { b.shots[0].cast.push('nobody_ghost'); },
  '不在 identities 里',
);

expectRejected(
  'prompt 里的标记不在 cast 里',
  (b) => { b.shots[0].prompt += '，{{phantom_identity}}'; },
  '不在本镜 cast 里',
);

expectRejected(
  'prompt 出现含糊的备选表达',
  (b) => { b.shots[0].prompt += '，或者站在门边'; },
  '备选表达',
);

expectRejected(
  '角色与造型不是双向一致',
  (b) => { b.characters[0].identities = []; },
  'identities 列表里缺',
);

expectRejected(
  '造型挂了不存在的角色',
  (b) => { b.identities[0].character = 'nobody'; },
  '不在 characters 里',
);

expectRejected(
  '台词来自不在场的造型',
  (b) => {
    const spoken = b.shots.find((s) => (s.dialogue || []).length);
    if (spoken) spoken.cast = [];
    else { b.shots[0].dialogue = [{ character: 'ghost_x', text: '喂' }]; }
  },
  '',
);

expectRejected(
  '年龄用了自由文本而不是枚举',
  (b) => { b.characters[0].age_group = '少女'; },
  'age_group',
);

expectRejected(
  '剧名只写英文项目代号',
  (b) => { b.meta.title = 'cat_mouse'; },
  '中文剧名',
);

expectRejected(
  '闸门顺序被跳着批',
  (b) => {
    b.meta.approvals = { story: { at: 'x', by: 'u' }, shots: null, assets: { at: 'x', by: 'u' }, keyframes: null };
  },
  '顺序不对',
);

console.log('\n' + '─'.repeat(56));
if (failures.length) {
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项：`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log(`全部通过（${passed} 项）—— 契约能拒掉每一类错误`);
}
