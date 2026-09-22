import assert from 'node:assert/strict';
import test from 'node:test';
import { auditContractRules, rulesBlock } from '../src/cinematography.mjs';

/**
 * 契约的 `rules` 会**逐字**进 H3 提示词（`rulesBlock()`），所以规则文本里的否定式名词
 * 等于把那个名词递进语义空间 —— 与 `video-h3.md` 的妆面污染同源。
 *
 * 依据（desk_quake 2026-09-22 实测）：`prop_identity` 原文含「不出现第二只杯子」，
 * g001 视频画面里真的多出一只杯子；改正向陈述后同提示词重跑即消失。
 */
test('契约规则里的否定式名词会被审出来', () => {
  const contract = {
    rules: [
      { id: 'prop_identity', text: '全片只有一只马克杯：素白无图案，不出现第二只杯子' },
      { id: 'quake_wave', text: '地震横波自画面左侧传来：松散物件一律向画面右侧移动' },
    ],
  };
  const r = auditContractRules(contract);
  assert.equal(r.checked, 2);
  assert.equal(r.violations.length, 1, `只应命中否定式那一条，实际 ${JSON.stringify(r.violations)}`);
  assert.equal(r.violations[0].id, 'prop_identity');
});

test('正向陈述零违规，且规则照旧逐字进提示词', () => {
  const contract = { rules: [{ id: 'prop_identity', text: '全片只有一只马克杯：素白无图案、带 C 形把手' }] };
  assert.equal(auditContractRules(contract).violations.length, 0);
  assert.match(String(rulesBlock(contract, {})), /全片只有一只马克杯/);
});

test('没有 rules 的契约不报违规（老剧目契约可选）', () => {
  assert.deepEqual(auditContractRules(null), { violations: [], checked: 0 });
  assert.deepEqual(auditContractRules({}), { violations: [], checked: 0 });
});
