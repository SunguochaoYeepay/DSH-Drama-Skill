/**
 * cli/lib/argv.mjs 的行为测试。
 *
 * 守三种语义在缺值边界上的区别——同名不同义正是这次收编要消掉的病根，
 * 三种边界各钉一条：缺失 / 值在最后 / 下一个是另一个 flag。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { makeArgs } from '../cli/lib/argv.mjs';

test('value：裸取——flag 缺给 fallback，值缺给 undefined', () => {
  const a = makeArgs(['--out', 'x.mp4']);
  assert.equal(a.value('out'), 'x.mp4');
  assert.equal(a.value('missing', 'fb'), 'fb');
  // flag 在最后、没有值：裸取给 undefined（不吞 fallback）
  assert.equal(makeArgs(['--out']).value('out', 'fb'), undefined);
  assert.equal(makeArgs(['--out', '--dry']).value('out', 'fb'), '--dry');
});

test('flag：严格——值缺或为空都回退 fallback', () => {
  const a = makeArgs(['--quality', 'high']);
  assert.equal(a.flag('quality', 'normal'), 'high');
  assert.equal(a.flag('missing', 'normal'), 'normal');
  assert.equal(makeArgs(['--quality']).flag('quality', 'normal'), 'normal');
  assert.equal(makeArgs(['--quality', '--skip']).flag('quality', 'normal'), 'normal');
});

test('opt：宽松——值缺或下一个是 flag 时给 true（布尔开关）', () => {
  const a = makeArgs(['--dry']);
  assert.equal(a.opt('dry', false), true);
  assert.equal(makeArgs(['--stage', 'clip']).opt('stage'), 'clip');
  assert.equal(makeArgs(['--stage']).opt('stage'), true);
  assert.equal(makeArgs(['--stage', '--dry']).opt('stage'), true);
  assert.equal(makeArgs([]).opt('stage', 'story'), 'story');
});

test('has：只判存在', () => {
  const a = makeArgs(['--skip-gate', '--out', 'x']);
  assert.equal(a.has('skip-gate'), true);
  assert.equal(a.has('out'), true);
  assert.equal(a.has('missing'), false);
});
