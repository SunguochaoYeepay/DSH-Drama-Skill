#!/usr/bin/env node
/**
 * end-marker.test.mjs — 剧本结尾标记（（完）/（全剧终）等）不得变成动作镜。
 *
 * 背景：wig_sneeze 立项时「（完）」被当成动作行凑成垃圾镜头 s13，
 * 板子契约校验（action ≥4 字、prompt ≥12 字）拒绝写盘；tiantian_v2 的
 * 「（全剧终）」5 字符侥幸过关，同样污染了分镜。本测试守住：
 *   1. 解析层：结尾标记识别为 end_marker，不进 action；
 *   2. 端到端：带（完）的剧本 + Brief 能通过 init-board 建板并过契约校验，
 *      且产物里没有任何「（完）」镜头。
 *
 *   node tests/end-marker.test.mjs
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseScript } from '../src/parse-script.mjs';
import { makeScriptReceipt, receiptPath } from '../src/script-provenance.mjs';
import { checkBoard } from '../src/board.mjs';

const ENDERS = ['（完）', '（全剧终）', '（剧终）', '（完剧）', '全剧终', '完', 'THE END'];

test('结尾标记识别为 end_marker，不算动作行', () => {
  const script = [
    '测试剧',
    '',
    '场次一 外景 测试街道 黄昏',
    '',
    '△ 女主甩了甩短发，大步离开。',
    '女主：行吧。',
    '',
    'END_MARK_PLACEHOLDER',
  ].join('\n');
  for (const ender of ENDERS) {
    const parsed = parseScript(script.replace('END_MARK_PLACEHOLDER', ender));
    const kinds = parsed.lines.map((l) => l.kind);
    assert.ok(kinds.includes('end_marker'), `「${ender}」应识别为 end_marker`);
    assert.ok(!parsed.lines.some((l) => l.kind === 'action' && l.text === ender),
      `「${ender}」不得成为动作行`);
  }
});

test('正文里的「完」字不受影响，只有整行匹配才算结尾标记', () => {
  const parsed = parseScript([
    '测试剧',
    '',
    '场次一 外景 测试街道 黄昏',
    '',
    '△ 她一拳把墙打穿了，真可谓完蛋了。',
    '女主：完了完了完了——',
  ].join('\n'));
  assert.equal(parsed.lines.filter((l) => l.kind === 'end_marker').length, 0);
  assert.equal(parsed.lines.filter((l) => l.kind === 'action').length, 1);
  assert.equal(parsed.lines.filter((l) => l.kind === 'dialogue').length, 1);
});

test('带（完）的剧本走 init-board 能建板、过契约、无垃圾镜头', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-end-marker-'));
  const story = [
    '假发喷嚏',
    '',
    '场次一 外景 测试街道 黄昏',
    '',
    '△ 女主高冷登场，风起，纸屑飘飞。',
    '女主：完了完了完了——',
    '',
    '场次二 外景 测试街道 黄昏（紧接）',
    '',
    '△ 她甩了甩短发，立起风衣领，大步离开，头也不回。',
    '女主：行吧。',
    '',
    '（完）',
  ].join('\n');
  const storyPath = path.join(project, 'story.md');
  const briefPath = path.join(project, 'brief.json');
  const boardPath = path.join(project, 'board.json');
  fs.writeFileSync(storyPath, story);
  const receipt = makeScriptReceipt({ story, input: story, source: 'user_supplied' });
  receipt.confirmed_by = 'fixture';
  fs.writeFileSync(receiptPath(storyPath), JSON.stringify(receipt));
  fs.writeFileSync(briefPath, JSON.stringify({
    meta: {
      title: '假发喷嚏', project: 'end_marker_fixture', logline: '测试结尾标记不成镜。',
      aspect: '9:16', style: 'cartoon3d', style_prompt: '精致 3D 卡通测试。',
    },
    story: {
      synopsis: '女主打喷嚏打飞假发后自信化解的测试故事概述，用于结尾标记回归。',
      beats: [
        { text: '喷嚏打飞假发', purpose: '制造核心反差' },
        { text: '自嘲一笑自信离场', purpose: '完成化解结局' },
      ],
    },
  }));

  const root = path.resolve(import.meta.dirname, '..');
  const command = [path.join(root, 'cli/init-board.mjs'), '--story', storyPath, '--brief', briefPath, '--out', boardPath];
  const result = spawnSync(process.execPath, command, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const board = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
  assert.equal(checkBoard(board).errors.length, 0, '契约校验必须通过');
  assert.ok(board.shots.length >= 2, '正常镜头必须还在');
  assert.ok(!board.shots.some((s) => (s.action || '').trim() === '（完）'),
    '不得出现「（完）」垃圾镜头');
});
