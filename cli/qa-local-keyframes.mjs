/**
 * QA 一批关键帧 —— **用本地 ollama 视觉模型（0 成本）**。
 *
 * 「它应该是什么景别」从 board.direction.json 自动取，
 * 景别硬约束从 cli/keyframes.mjs 的 FRAMING 取 —— **判据和出图用的是同一份**，
 * 否则"出图按一套、检查按另一套"，检查就没意义了。
 *
 * 用法：node cli/qa-local-keyframes.mjs <direction.json> <keyframes-dir> [u1,u2,...]
 */

import fs from 'node:fs';
import path from 'node:path';
import { lookLocal, ollamaUp } from './look-local.mjs';
import { FRAMING } from './keyframes.mjs';

const MODEL = process.env.QA_LOCAL_MODEL || 'qwen3.5:27b';
const [, , directionArg, keyframesArg, onlyArg = ''] = process.argv;
if (!directionArg || !keyframesArg) {
  console.error('用法：node cli/qa-local-keyframes.mjs <direction.json> <keyframes-dir> [u1,u2,...]');
  process.exit(2);
}
const DIRECTION = path.resolve(directionArg);
const KF = path.resolve(keyframesArg);
const only = onlyArg.split(',').map((s) => s.trim()).filter(Boolean);
const dir = JSON.parse(fs.readFileSync(DIRECTION, 'utf8'));

if (!(await ollamaUp())) { console.error('✗ ollama 没跑。启动：ollama serve'); process.exit(2); }

const ids = dir.units.map((u) => u.id).filter((id) => (!only.length || only.includes(id)) && fs.existsSync(path.join(KF, `${id}.png`)));
console.log(`\n【质检：关键帧】${ids.length} 张　模型 ${MODEL}（本地，0 成本）`);
console.log('─'.repeat(70));

const results = [];
for (const id of ids) {
  const u = dir.units.find((x) => x.id === id);
  const shot = u.shots[0];
  const rule = (FRAMING[shot.framing] || {}).rule || `【景别｜${shot.framing}】`;

  const focus = [
    '【景别 ⭐ 最重要】这张实际是什么景别？请**先看画面下边界切在人物身体哪个位置**，再下判断。',
    '  ' + rule,
    '  → 请明确回答：**符合还是不符合**上面这条要求？如果不符合，说出画面下边界实际切在哪。',
    '【文字】画面里有没有任何文字、水印、字幕、logo？',
    '【崩坏】手、脸、边缘、配饰有没有明显坏掉或糊掉的地方（指出位置）？',
  ];

  process.stderr.write(`  看 ${id} … `);
  const r = await lookLocal(path.join(KF, `${id}.png`), { focus, model: MODEL });
  const m = r.text.match(/结论[：:]\s*(.+)/);
  const why = m ? m[1].trim() : '（没给结论）';
  const pass = /^通过/.test(why);
  console.log(pass ? '✓' : '✗');
  results.push({ id, pass, why, text: r.text, secs: r.seconds });
}

console.log('─'.repeat(70));
for (const x of results) console.log(`  ${x.pass ? '✓' : '✗'} ${x.id}　${x.why}`);
const bad = results.filter((x) => !x.pass);
console.log('');
if (bad.length) {
  console.log(`  结论：**${bad.length}/${results.length} 张有问题，不建议往下走。**\n`);
  for (const x of bad) console.log(`  ── ${x.id} ──\n${x.text.split('\n').map((l) => '    ' + l).join('\n')}\n`);
  process.exitCode = 1;
} else {
  console.log(`  结论：全部通过（${results.length} 张）。`);
  console.log('  ⚠ **通过 ≠ 可以往下走。通过 = 可以问用户了。**');
  console.log('  → 现在可以问：这批关键帧 OK 吗？');
}
