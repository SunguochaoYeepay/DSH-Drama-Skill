import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assetPromptsOf, keyframePromptOf, loadProject, videoPromptOf } from '../src/board-data.mjs';

/**
 * 看板的「提示词可复制」：数据层把三类提示词读成纯文本 ——
 * 关键帧（keyframe-prompts/）、视频（units/.<id>.prompt.txt）、
 * 场景图/角色图（asset-design.json）。
 *
 * 判据是**读出来什么**，不是源码里有没有写这几个路径：前端复制的东西必须
 * 与 `cli/keyframes.mjs` / `cli/unit.mjs` 送进模型的那份逐字一致。
 */

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-prompts-'));
}

function put(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

test('关键帧提示词取 keyframe-prompts/<unit>.txt，且按"送模型"那样去首尾空白', () => {
  const dir = tmpdir();
  put(path.join(dir, 'keyframe-prompts', 'g001.txt'), '  竖幅全景，三个人走出窄口。\n\n');
  assert.equal(keyframePromptOf(dir, 'g001'), '竖幅全景，三个人走出窄口。');
  assert.equal(keyframePromptOf(dir, 'g002'), null);
});

test('工程通道老剧目：keyframe-prompts 缺时退回 keyframes_*/raw/<unit>/_request/prompt.txt', () => {
  const dir = tmpdir();
  put(path.join(dir, 'keyframes_bailian_v6', 'raw', 'g004', '_request', 'prompt.txt'), '老通道提示词\n');
  assert.equal(keyframePromptOf(dir, 'g004'), '老通道提示词');
  assert.equal(keyframePromptOf(dir, 'g001'), null);
});

test('视频提示词取 units/.<unit>.prompt.txt；不带点的同名文件兜底', () => {
  const dir = tmpdir();
  put(path.join(dir, 'units', '.g001.prompt.txt'), '视频提示词 g001\n');
  put(path.join(dir, 'units', 'g002.prompt.txt'), '视频提示词 g002\n');
  assert.equal(videoPromptOf(dir, 'g001'), '视频提示词 g001');
  assert.equal(videoPromptOf(dir, 'g002'), '视频提示词 g002');
  assert.equal(videoPromptOf(dir, 'g003'), null);
});

test('场景图/角色图提示词来自 asset-design.json，标签用中文名、空提示词不占位', () => {
  const dir = tmpdir();
  const board = {
    scenes: [{ id: 'living_room_dusk', name: '老式客厅地面（傍晚转夜）' }],
    characters: [{ id: 'shiba', name: '柴犬' }],
  };
  fs.writeFileSync(path.join(dir, 'asset-design.json'), JSON.stringify({
    designs: [
      { kind: 'scene_design', scene_id: 'living_room_dusk', prompt: '场景图提示词\n' },
      { kind: 'character_design', character_id: 'shiba', prompt: '角色图提示词\n' },
      { kind: 'scene_design', scene_id: 'nowhere', prompt: '   ' },   // 空 → 不算
    ],
  }), 'utf8');

  const out = assetPromptsOf(dir, board);
  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((p) => [p.kind, p.label, p.text]),
    [
      ['scene_design', '老式客厅地面（傍晚转夜）', '场景图提示词'],
      ['character_design', '柴犬', '角色图提示词'],
    ],
  );
  assert.equal(assetPromptsOf(tmpdir(), board).length, 0, '没有 asset-design.json → 空数组');
});

test('快照把三类提示词带上（前端复制的就是这里读到的原文）', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'board.json'), JSON.stringify({
    meta: { title: '测试剧' },
    shots: [], characters: [], identities: [], scenes: [], props: [],
  }), 'utf8');
  put(path.join(dir, 'keyframe-prompts', 'g001.txt'), '关键帧提示词');
  put(path.join(dir, 'units', '.g001.prompt.txt'), '视频提示词');
  put(path.join(dir, 'asset-design.json'), JSON.stringify({
    designs: [{ kind: 'scene_design', scene_id: 's1', prompt: '场景提示词' }],
  }));
  fs.writeFileSync(path.join(dir, 'render.plan.json'), JSON.stringify({ units: [{ id: 'g001' }] }), 'utf8');

  const snap = loadProject(path.dirname(dir), path.basename(dir));
  assert.equal(snap.units[0].keyframePrompt, '关键帧提示词');
  assert.equal(snap.units[0].videoPrompt, '视频提示词');
  assert.deepEqual(snap.assetPrompts.map((p) => p.text), ['场景提示词']);
});
