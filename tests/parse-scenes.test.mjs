import assert from 'node:assert/strict';
import test from 'node:test';
import { parseScenes } from '../src/parse-scenes.mjs';
import { parseScript } from '../src/parse-script.mjs';

test('场次头支持中文数字', () => {
  const result = parseScenes([
    '场次一 内景 陌生卧室 日 人物：天天',
    '天天：这什么？',
    '场次二 内景 天天卧室 日 人物：天天、妈妈',
    '妈妈：天天，起来了。',
  ].join('\n'));
  assert.equal(result.scenes.length, 2);
  assert.deepEqual(result.scenes.map((scene) => scene.scene_no), [1, 2]);
});

test('场内无三角动作与分行台词保持可编译', () => {
  const result = parseScript([
    '场次一 内景 陌生卧室 日（梦境）',
    '天天从床上坐起来。',
    '天天（声音发颤）',
    '这什么？',
  ].join('\n'));
  assert.equal(result.lines.find((line) => line.raw === '天天从床上坐起来。').kind, 'action');
  const dialogue = result.lines.find((line) => line.kind === 'dialogue');
  assert.deepEqual({ speaker: dialogue.speaker, text: dialogue.text, parenthetical: dialogue.parenthetical },
    { speaker: '天天', text: '这什么？', parenthetical: '声音发颤' });
  assert.equal(dialogue.no, 4);
  assert.equal(dialogue.cue_no, 3);
});
