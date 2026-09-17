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
  assert.match(prompt, /禁止表现为：微笑、星星眼/);
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
