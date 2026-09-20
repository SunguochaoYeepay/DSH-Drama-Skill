#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildUnitPrompt } from '../src/h3-prompt.mjs';

const board = {
  meta: { music: null },
  characters: [{ id: 'c1', name: '阿宁', face_prompt: '圆脸，黑色长发' }],
  identities: [{ id: 'c1_home', character: 'c1', appearance_details: '蓝色家居服' }],
};
const unit = {
  shots: [{
    at: 0,
    framing: '近景',
    camera: '固定',
    on_screen: ['c1_home'],
    facing: { c1_home: 'toward' },
    action: '阿宁听见响声，双眼微微睁大',
    lighting: '柔光',
    audio: '室内环境音',
    lines: [3],
    emotion_analysis: [{
      character: 'c1_home',
      visible_behavior: '肩背收紧，停止动作',
      gaze: '看向门口',
      avoid_symbols: ['微笑', '星星眼'],
    }],
  }],
};
const ctx = {
  board,
  scene: { environment: '安静客厅' },
  hasFirstFrame: true,
  nameOf: (id) => id === 'c1_home' ? '阿宁' : id,
  lineText: new Map([[3, { who: 'c1_home', text: '谁在外面？', emotion: '警觉', kind: 'dialogue' }]]),
};

test('纯 I2V 使用 integrated 字段并保留首帧、台词和声音契约', () => {
  const prompt = buildUnitPrompt(unit, { ...ctx, refs: [] });
  assert.match(prompt, /^For the target video, at 0\.00 seconds/m);
  assert.match(prompt, /integrated_multimodal_description:/);
  assert.doesNotMatch(prompt, /detailed_description:/);
  assert.match(prompt, /<d>\[Chinese\] 谁在外面？<\/d>/);
  assert.match(prompt, /\(S1\)/);
  // 负例词不能原样进入提示词；已知类别应转换成正向表演边界。
  assert.doesNotMatch(prompt, /禁止表现为/);
  assert.doesNotMatch(prompt, /微笑/);
  assert.doesNotMatch(prompt, /星星眼/);
  assert.match(prompt, /眼睛保持自然解剖结构/);
  assert.match(prompt, /嘴角形态服从上述可见表演/);
  const soundscape = prompt.split('overall_soundscape:')[1].split('\n')[0];
  assert.doesNotMatch(soundscape, /谁在外面/);
});

test('多图参考使用 ref2va detailed 字段且不混入 I2VA 对齐行', () => {
  const prompt = buildUnitPrompt(unit, {
    ...ctx,
    refs: [
      { role: 'keyframe', file: 'keyframe.png' },
      { role: 'face', who: 'c1_home', file: 'face.png' },
    ],
  });
  assert.match(prompt, /^subject_definitions:/);
  assert.match(prompt, /detailed_description:/);
  assert.doesNotMatch(prompt, /integrated_multimodal_description:/);
  assert.doesNotMatch(prompt, /For the target video, at 0\.00 seconds/);
  assert.match(prompt, /retention_analysis:/);
});

test('画外音使用固定短语并要求嘴唇闭合', () => {
  const voiceover = structuredClone(unit);
  const lineText = new Map([[3, { who: 'c1_home', text: '我得看看。', kind: 'voiceover' }]]);
  const prompt = buildUnitPrompt(voiceover, { ...ctx, lineText, refs: [] });
  assert.match(prompt, /says in an off-screen voiceover:/);
  assert.match(prompt, /嘴唇始终完全闭合/);
});

// 知情状态是**单元级**前提：它进提示词（作为表演依据），缺字段时不得留下空标签。
// 依据：pot_hit 2026-09-20 —— 没人写这一句时，"观众已知、角色未知"的错位会被调度拍丢。
test('audience_knows 作为单元级前提进入提示词，缺字段时不出现空标签', () => {
  const withKnows = structuredClone(unit);
  withKnows.audience_knows = '观众已经看见猫踩翻了花盆；她还低着头什么都不知道。';
  const prompt = buildUnitPrompt(withKnows, { ...ctx, refs: [] });
  assert.match(prompt, /audience_knows/);
  assert.match(prompt, /观众已经看见猫踩翻了花盆/);
  assert.match(prompt, /不是画面文字/);

  const without = buildUnitPrompt(unit, { ...ctx, refs: [] });
  assert.doesNotMatch(without, /audience_knows/);
});

// 实测来自 mosquito_tattoo/g001：action 里写「脸颊涨红」、导演约束里写「脸颊泛红」，
// 两处都没被去夸张词表拦住，模型把末镜画成了两块腮红 + 亮红唇。
test('「脸颊+红」必须换成不带颜色词的表演描述，且 action 与导演约束两条路径都要过', () => {
  const flushed = structuredClone(unit);
  flushed.shots[0].action = '阿宁猛地转身，眼睛瞪圆，脸颊涨红，张嘴说话';
  flushed.shots[0].emotion_analysis[0].visible_behavior = '肩膀往内收，眼睛睁大，脸颊泛红，嘴张开';

  const i2v = buildUnitPrompt(flushed, { ...ctx, refs: [] });
  assert.doesNotMatch(i2v, /涨红|泛红/);
  assert.match(i2v, /眼睛瞪圆，脸颊绷紧，张嘴说话/);
  assert.match(i2v, /眼睛睁大，脸颊绷紧，嘴张开/);

  const ref2v = buildUnitPrompt(flushed, { ...ctx, refs: [{ role: 'keyframe', file: 'k.png' }] });
  assert.doesNotMatch(ref2v, /涨红|泛红/);
  // 实验 B：retention 那段不得再出现任何「妆」词汇，否则等于给模型递词表。
  assert.doesNotMatch(ref2v, /blush|rouge|lipstick|makeup|flush on the cheeks|redden the lips/i);
  assert.match(ref2v, /Skin and lips must stay exactly as they are in the reference pictures/);
});
