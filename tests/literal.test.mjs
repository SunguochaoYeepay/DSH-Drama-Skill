#!/usr/bin/env node
/**
 * literal.test.mjs — 阶段②「逐行模式」的验收。
 *
 * 验收标准只有一条，而且是**硬的**：
 *   **产出的台词与剧本原文逐字 diff = 0，一句不多、一句不少、顺序不变。**
 *
 * 之所以能做到"硬"，是因为台词由 parse-script 原样抠出来、由代码搬进 dialogue[]，
 * **从头到尾没有经过模型**。这个测试就是守住这条构造性质。
 *
 *   node tests/literal.test.mjs
 */

import fs from 'node:fs';
import { parseScript, spokenLines } from '../src/parse-script.mjs';
import { compileLiteral } from '../src/literal.mjs';
import { checkBoard } from '../src/board.mjs';

let passed = 0;
const failures = [];
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`FAIL   ${label}${detail ? '  → ' + detail : ''}`); }
}

const SCRIPT_PATH = process.argv[2] || 'E:/AI-Tool/DeepSeek/story2video/examples/dashixiong.v2.json';
const board = JSON.parse(fs.readFileSync(SCRIPT_PATH, 'utf8'));
const source = board.story.source;

console.log('\n逐行模式');

// ---------- 一、行解析 ----------
const parsed = parseScript(source);
console.log(`  行型：${JSON.stringify(parsed.stats)}`);
check('台词 12 句（10 开口 + 2 OS）',
  parsed.stats.dialogue === 10 && parsed.stats.voiceover === 2,
  `dialogue=${parsed.stats.dialogue} voiceover=${parsed.stats.voiceover}`);
check('人物设定没被当成台词', parsed.lines.filter((l) => l.kind === 'character_setting').length === 2,
  String(parsed.lines.filter((l) => l.kind === 'character_setting').length));
check('片尾字幕单独成类', parsed.lines.filter((l) => l.kind === 'card').length === 1);
check('动作行以 △ 识别', parsed.stats.action === 12, String(parsed.stats.action));

// ---------- 二、逐行编译 ----------
const { board: out, report } = await compileLiteral(board);

check('编译产物通过契约校验', (() => { const r = checkBoard(out); globalThis.__errs = r.errors; return r.errors.length === 0; })(),
  (globalThis.__errs || []).slice(0, 3).join(' | '));

check('report 自报逐字保真', report.verbatim === true,
  `源 ${report.source_spoken} 句 vs 产物 ${report.dialogue} 句`);

// ---------- 三、逐字 diff（核心验收）----------
const srcLines = spokenLines(parsed).map((l) => l.text);
const gotLines = out.shots.flatMap((s) => (s.dialogue || []).map((d) => d.text));

check('句数一致', srcLines.length === gotLines.length, `源 ${srcLines.length} vs 产物 ${gotLines.length}`);

let firstDiff = -1;
for (let i = 0; i < Math.max(srcLines.length, gotLines.length); i++) {
  if (srcLines[i] !== gotLines[i]) { firstDiff = i; break; }
}
check('逐字 diff = 0（顺序也一样）', firstDiff < 0,
  firstDiff >= 0 ? `第 ${firstDiff + 1} 句不同：源「${srcLines[firstDiff]}」 vs 产物「${gotLines[firstDiff]}」` : '');

// 反向：产物里的每一句都必须能在原文里原样找到
const notInSource = gotLines.filter((t) => !source.includes(t));
check('产物里没有一句是模型编的', notInSource.length === 0, notInSource.slice(0, 2).join(' | '));

// 顺序：产物台词在 shots[] 里出现的顺序，必须与原文行号单调递增
const order = out.shots.flatMap((s) => (s.dialogue || []).map(() => Math.min(...(s.source_lines || [0]))));
check('台词顺序与原文行号单调递增', order.every((v, i) => i === 0 || v >= order[i - 1]), order.join(','));

// ---------- 四、溯源 ----------
const covered = new Set();
for (const s of out.shots) for (const n of s.source_lines || []) covered.add(n);
const spokenLineNos = spokenLines(parsed).map((l) => l.no);
check('每一句台词的行号都被某一镜认领', spokenLineNos.every((n) => covered.has(n)),
  spokenLineNos.filter((n) => !covered.has(n)).join(','));

// ---------- 五、OS 标注 ----------
const os = out.shots.flatMap((s) => s.dialogue || []).filter((d) => d.kind === 'voiceover');
check('两句 OS 被标成 voiceover', os.length === 2, String(os.length));

// ---------- 六、出场造型 ----------
const identIds = new Set(out.identities.map((x) => x.id));
check('所有 cast 都引用存在的造型', out.shots.every((s) => (s.cast || []).every((c) => identIds.has(c))));
check('两句 OS 的说话人挂上了造型',
  os.every((d) => identIds.has(d.character)), os.map((d) => d.character).join(','));

// ---------- 七、结构观感 ----------
console.log('\n  产出：');
console.log(`    ${out.characters.length} 角色 / ${out.identities.length} 造型 / ${out.scenes.length} 场景 / ${out.shots.length} 镜 / ${out.meta.total_duration_s}s`);
for (const s of out.shots) {
  const d = (s.dialogue || []).map((x) => `${x.kind === 'voiceover' ? 'OS ' : ''}「${x.text.slice(0, 22)}${x.text.length > 22 ? '…' : ''}」`).join('');
  console.log(`    ${s.id} ${String(s.duration_s).padStart(2)}s ${s.shot_size} cast=[${(s.cast || []).join(',')}] ${d || '(无台词)'}`);
}

console.log('\n' + '─'.repeat(56));
if (failures.length) {
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项：`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log(`全部通过（${passed} 项）—— 台词由代码搬运，模型碰不到，逐字保真是构造保证`);
}
