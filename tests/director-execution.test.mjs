import assert from 'node:assert/strict';
import { compileDirectorExecution, compileLookAt } from '../src/director-execution.mjs';

const names = { cat: '阿橘', mouse: '灰豆' };
const nameOf = (id) => names[id] || id;
const shot = { on_screen: ['cat', 'mouse'], looks_at: [{ who: 'cat', at: 'mouse' }] };
const directives = compileDirectorExecution(shot, nameOf);
assert.equal(directives.length, 1);
assert.equal(directives[0].key, 'looks_at:0');
assert.match(directives[0].text, /阿橘始终注视灰豆/);
assert.match(directives[0].text, /头部、眼睛和瞳孔/);
assert.match(directives[0].text, /不看镜头/);
assert.throws(() => compileLookAt({ on_screen: ['cat'], looks_at: [{ who: 'cat', at: 'mouse' }] }, nameOf), /画外目标/);
assert.throws(() => compileLookAt({ on_screen: ['mouse'], looks_at: [{ who: 'cat', at: 'mouse' }] }, nameOf), /who/);
const emotion = compileDirectorExecution({
  on_screen: ['mouse'],
  emotion_analysis: [{
    character: 'mouse', cause: '天敌靠近', internal_state: '恐惧',
    visible_behavior: '耳朵后压，身体后缩', gaze: '抬头紧盯橘猫', avoid_symbols: ['星星眼', '微笑'],
  }],
}, nameOf);
assert.match(emotion[0].text, /耳朵后压/);
assert.match(emotion[0].text, /视线：抬头紧盯橘猫/);
// 负例词不原样进入提示词；已知类别编译成不复述禁词的正向边界。
assert.doesNotMatch(emotion[0].text, /禁止表现为/);
assert.doesNotMatch(emotion[0].text, /星星眼/);
assert.doesNotMatch(emotion[0].text, /微笑/);
assert.match(emotion[0].text, /眼睛保持自然解剖结构/);
assert.match(emotion[0].text, /嘴角形态服从上述可见表演/);
console.log('director execution: 13/13 passed');
