#!/usr/bin/env node
/**
 * cost.test.mjs — 成本账本的验收（**纯离线**）。
 *
 * 算钱的代码最该被钉死，因为它错了没人看得出来。要验的：
 *   - 图片按张算（生成 + 参考图输入分别计价）
 *   - 语音按万字符算
 *   - 不认识的模型**标记出来**，不能悄悄按 0 算然后给一个看着很美的合计
 *   - 汇总的合计 = 各条之和（不能漏项）
 *   - 环境变量能覆盖单价
 *
 *   node tests/cost.test.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { costOf, summarize, formatSummary, ledger, PRICES } from '../src/cost.mjs';

let passed = 0;
const failures = [];
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`FAIL   ${label}${detail ? '  → ' + detail : ''}`); }
}

const NOENV = {};

console.log('\n单价与算式');
check('文生图 3 张 = 0.54 元',
  costOf({ op: 'image.generate', model: 'qwen-image-3.0', units: 3 }, NOENV).cny === 0.54,
  String(costOf({ op: 'image.generate', model: 'qwen-image-3.0', units: 3 }, NOENV).cny));
check('图生图 1 张 + 2 张参考 = 0.18 + 0.04',
  costOf({ op: 'image.edit', model: 'qwen-image-3.0', units: 1, inputRefs: 2 }, NOENV).cny === 0.22,
  String(costOf({ op: 'image.edit', model: 'qwen-image-3.0', units: 1, inputRefs: 2 }, NOENV).cny));
check('配音 278 字符 = 0.0278 元',
  Math.abs(costOf({ op: 'speech.synthesize', model: 'cosyvoice-v3-flash', chars: 278 }, NOENV).cny - 0.0278) < 1e-9,
  String(costOf({ op: 'speech.synthesize', model: 'cosyvoice-v3-flash', chars: 278 }, NOENV).cny));
check('配音 10000 字符 = 1 元',
  costOf({ op: 'speech.synthesize', model: 'cosyvoice-v3-flash', chars: 10000 }, NOENV).cny === 1);
check('零字符 = 0 元', costOf({ op: 'speech.synthesize', model: 'cosyvoice-v3-flash', chars: 0 }, NOENV).cny === 0);

console.log('\n不认识的模型不许悄悄按 0 算');
const unk = costOf({ op: 'image.generate', model: 'some-unknown-model', units: 5 }, NOENV);
check('标记为 unknown', unk.unknown === true);
check('金额 0 但说得清为什么', unk.cny === 0 && /没有 .* 的单价/.test(unk.why), unk.why);
const su = summarize([{ model: 'some-unknown-model', cny: 0, price_unknown: true, units: 5, op: 'image.generate' }]);
check('汇总里也会点名', su.unknown_prices === 1, String(su.unknown_prices));
check('合计旁边会加警告', /别信这个合计/.test(formatSummary(su)));

console.log('\n环境变量覆盖单价');
check('AIH_PRICE_ 能改单价',
  costOf({ op: 'image.generate', model: 'qwen-image-3.0', units: 1 }, { AIH_PRICE_QWEN_IMAGE_3_0: '0.5' }).cny === 0.5,
  String(costOf({ op: 'image.generate', model: 'qwen-image-3.0', units: 1 }, { AIH_PRICE_QWEN_IMAGE_3_0: '0.5' }).cny));

console.log('\n汇总');
const rows = [
  { model: 'qwen-image-3.0', op: 'image.generate', units: 7, input_refs: 0, chars: 0, cny: 1.26, run: '首轮' },
  { model: 'qwen-image-3.0', op: 'image.edit', units: 2, input_refs: 2, chars: 0, cny: 0.4, run: '首轮' },
  { model: 'cosyvoice-v3-flash', op: 'speech.synthesize', units: 1, input_refs: 0, chars: 270, cny: 0.027, run: '首轮' },
  { model: 'qwen-image-3.0', op: 'image.generate', units: 1, input_refs: 0, chars: 0, cny: 0.18, run: '重出' },
];
const s = summarize(rows);
check('合计 = 各条之和', Math.abs(s.total - (1.26 + 0.4 + 0.027 + 0.18)) < 1e-9, String(s.total));
check('调用笔数对', s.calls === 4, String(s.calls));
check('按模型分组', s.by_model.length === 2, String(s.by_model.length));
check('按轮次分组，重出单独一档', s.by_run.find((r) => r.run === '重出')?.cny === 0.18, JSON.stringify(s.by_run));
const table = formatSummary(s);
check('表里能看见重出那一档', /重出/.test(table));
check('表里说清这不是账单', /不是账单/.test(table), table.slice(0, 80));

console.log('\n账本落盘');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cost-'));
const file = path.join(dir, 'costs.json');
ledger.attach(file, { board: 'x.json', run: '首轮' });
const mark = ledger.mark();
ledger.add({ provider: 'bailian', op: 'image.generate', model: 'qwen-image-3.0', units: 2 });
ledger.add({ provider: 'bailian', op: 'speech.synthesize', model: 'cosyvoice-v3-flash', chars: 100 });
check('写盘了', fs.existsSync(file));
const back = JSON.parse(fs.readFileSync(file, 'utf8'));
check('两条都在', back.length === 2, String(back.length));
check('金额算对了', back[0].cny === 0.36, String(back[0].cny));
check('记了板子名和轮次', back[0].board === 'x.json' && back[0].run === '首轮', JSON.stringify(back[0]));
check('since(mark) 只返回本次新增', ledger.since(mark).length === 2, String(ledger.since(mark).length));
ledger.attach(file, {});   // 重挂一次，验证会读回历史
check('重挂能读回历史', ledger.entries.length === 2, String(ledger.entries.length));
fs.rmSync(dir, { recursive: true, force: true });

check('价格表里 qwen-image-3.0 是 0.18/张', PRICES['qwen-image-3.0'].out === 0.18);

console.log('\n' + '─'.repeat(56));
if (failures.length) {
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项：`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log(`全部通过（${passed} 项）—— 算钱的代码钉死了：按张、按字符、不认识的模型会喊出来`);
}
