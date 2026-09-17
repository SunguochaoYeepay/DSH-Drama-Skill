/**
 * 一次质检一批关键帧：带上"它应该是什么景别"，逐张跑。
 *
 * 为什么要这个驱动：**PowerShell 5.1 会把 UTF-8 的 .ps1 读成 GBK**，
 * 中文提示词全烂。Node 永远按 UTF-8 读文件 —— 所以编排放 Node 里。
 *
 * 用法：node cli/qa-batch.mjs <direction.json> <keyframes-dir> [--stage keyframes]
 *   关键帧的"应该是什么"从 board.direction.json 里自动取（unit 的第 1 镜）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { look, verdictOf, STAGE_FOCUS, STAGE_CONTEXT } from '../src/qa.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const DJ = argv.find((value) => /\.json$/i.test(value) && !value.startsWith('--'));
const KF = argv.find((value) => value !== DJ && !value.startsWith('--'));
const stageAt = argv.indexOf('--stage');
const stage = stageAt >= 0 ? argv[stageAt + 1] : 'keyframes';
if (!DJ || !KF) {
  console.error('用法：node cli/qa-batch.mjs <direction.json> <keyframes-dir> [--stage keyframes]');
  process.exit(2);
}
const DIRECTION = path.resolve(DJ);
const KEYFRAMES = path.resolve(KF);

/** 景别 → 硬判据（写死，免得模型自己理解）。 */
const FRAMING_RULE = {
  远景: '远景：环境占绝大部分，人物很小，看不清脸',
  全景: '全景：能看到完整的人（头顶到脚）加上周围环境',
  中景: '中景：画面下边界切在**腰部**，头顶到腰部都在画面内；**不允许出现大腿，也不允许只到胸口**',
  近景: '近景：**只取胸部以上**，不出现腰部；脸清楚但能看到肩膀',
  特写: '特写：**只有脸**，头部占满画面，不出现肩膀以下',
};

const dir = JSON.parse(fs.readFileSync(DIRECTION, 'utf8'));
const files = fs.readdirSync(KEYFRAMES).filter((f) => /\.png$/i.test(f)).sort();

console.log(`\n【质检：${stage}】共 ${files.length} 张`);
console.log(STAGE_CONTEXT[stage] || '');
console.log('─'.repeat(70));

const results = [];
for (const f of files) {
  const id = path.basename(f, '.png');
  const u = dir.units.find((x) => x.id === id);
  const shot = u && u.shots[0];
  const want = shot
    ? `它应该是【${shot.framing}】—— ${FRAMING_RULE[shot.framing] || shot.framing}。画面内容：${shot.action}。光：${shot.lighting || '（未指定）'}`
    : '';

  process.stderr.write(`  看 ${f} … `);
  const r = look(path.join(KEYFRAMES, f), { focus: STAGE_FOCUS[stage] || [], extra: want });
  if (!r.ok) { console.log('✗ 看不了'); results.push({ id, pass: false, why: r.text }); continue; }
  const v = verdictOf(r.text);
  console.log(v.pass === true ? '✓' : v.pass === false ? '✗' : '?');
  results.push({ id, pass: v.pass, why: v.why, text: r.text });
}

console.log('─'.repeat(70));
for (const x of results) {
  const m = x.pass === true ? '✓' : x.pass === false ? '✗' : '?';
  console.log(`  ${m} ${x.id}　${x.why || ''}`);
}
const bad = results.filter((x) => x.pass !== true);
console.log('');
if (bad.length) {
  console.log(`  结论：**${bad.length}/${results.length} 张有问题，不建议往下走。**\n`);
  for (const x of bad) {
    console.log(`  ── ${x.id} ──`);
    console.log(String(x.text).split('\n').map((l) => '    ' + l).join('\n'));
    console.log('');
  }
} else {
  console.log(`  结论：全部通过（${results.length} 张）。`);
  console.log('  ⚠ **通过 ≠ 可以往下走。通过 = 可以问用户了。**');
  console.log('  → 现在可以问：这批关键帧 OK 吗？');
}
