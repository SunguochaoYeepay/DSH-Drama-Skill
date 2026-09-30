import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePresenceJson, summarizePresence } from '../src/presence-check.mjs';

test('检测器不可用时不通过', () => {
  const result = summarizePresence([
    { present: null, n_person: null, error: '坏权重' },
  ], 1);
  assert.equal(result.ok, false);
  assert.equal(result.detector_ok, 0);
  assert.equal(result.detector_unavailable.length, 1);
});

test('缺少主体时不通过', () => {
  const result = summarizePresence([{ present: false, n_person: 0 }], 1);
  assert.equal(result.ok, false);
  assert.equal(result.missing_subject.length, 1);
});

test('主体数量不一致只产生核查告警，不改变主体存在性通过', () => {
  const result = summarizePresence([{ present: true, n_person: 5 }], 3);
  assert.equal(result.ok, true);
  assert.equal(result.count_mismatches.length, 1);
});

test('清晰度过滤后的主体数用于人数核对', () => {
  const result = summarizePresence([{ present: true, n_person: 7, n_person_effective: 3 }], 3);
  assert.equal(result.count_mismatches.length, 0);
  assert.equal(result.ok, true);
});

test('第三方 WARNING 污染 stdout 时仍能取出末尾 JSON', () => {
  const payload = parsePresenceJson('WARNING Ultralytics\n{"summary":{"checked":1},"results":[]}');
  assert.deepEqual(payload.results, []);
});
