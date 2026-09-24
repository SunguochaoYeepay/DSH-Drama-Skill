/**
 * `src/loudness-policy.mjs` —— 合成时的"这一段有没有内容"判据。
 *
 * 守的是 2026-09-24 `divorce_standoff` 踩的那个坑：无台词的静音反应镜（源片 mean −51.3 dB）
 * 被逐段 loudnorm **放大约 37 dB** 拉到 −16 LUFS，成片里那一段比周围有台词的段落还响。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { isSilentSegment, SILENT_LUFS } from '../src/loudness-policy.mjs';

test('静音段（底噪级）判真 —— 它不该被归一化放大', () => {
  assert.equal(isSilentSegment({ input_i: '-53.0' }), true, 'divorce_standoff g003 实测值');
  assert.equal(isSilentSegment({ input_i: '-51.3' }), true);
  assert.equal(isSilentSegment({ input_i: String(SILENT_LUFS) }), true, '正好在阈值上也算静音');
});

test('"很轻但有内容"不能误判 —— 那条线是实测夹出来的', () => {
  // tests/assemble-review.test.mjs 的 0.06 幅度夹具实测 −46.2 LUFS：
  // 它必须照旧归一，否则合成里"段间响度差 ≤3 LU"这条行为断言会被我自己破掉。
  assert.equal(isSilentSegment({ input_i: '-46.2' }), false);
  for (const i of ['-16.0', '-23.4', '-30', '-45']) {
    assert.equal(isSilentSegment({ input_i: i }), false, `${i} LUFS 应照常归一`);
  }
});

test('明确测出全静音（-inf）判真', () => {
  assert.equal(isSilentSegment({ input_i: '-inf' }), true);
  assert.equal(isSilentSegment({ input_i: '-Infinity' }), true);
});

test('读不到值 / 读不懂的值判假：不改变既有行为（宁可照旧归一）', () => {
  assert.equal(isSilentSegment(null), false);
  assert.equal(isSilentSegment(undefined), false);
  assert.equal(isSilentSegment({}), false);
  assert.equal(isSilentSegment({ input_i: '' }), false);
  assert.equal(isSilentSegment({ input_i: 'nan' }), false);
});

test('阈值可覆盖，非法阈值报错', () => {
  assert.equal(isSilentSegment({ input_i: '-53' }, -60), false);
  assert.equal(isSilentSegment({ input_i: '-45' }, -40), true);
  assert.throws(() => isSilentSegment({ input_i: '-50' }, 'x'), /阈值必须是数字/);
});
