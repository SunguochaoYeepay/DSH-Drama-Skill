#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { compileLiteral } from '../src/literal.mjs';
import { checkBoard } from '../src/board.mjs';
import { installCliErrorHandler } from '../src/cli-errors.mjs';

installCliErrorHandler();
const argv = process.argv.slice(2);
const value = (name) => {
  const at = argv.indexOf(`--${name}`);
  return at < 0 ? null : argv[at + 1];
};
if (!value('story') || !value('brief') || !value('out')) {
  console.error('用法：node cli/init-board.mjs --story <story.md> --brief <board-brief.json> --out <项目/board.json>');
  process.exit(2);
}
const storyPath = path.resolve(value('story'));
const briefPath = path.resolve(value('brief'));
const output = path.resolve(value('out'));
if (path.basename(output) !== 'board.json' || path.dirname(storyPath) !== path.dirname(output)) {
  throw new Error('story.md 和 board.json 必须位于同一项目目录');
}
if (fs.existsSync(output)) throw new Error(`板子已存在，拒绝覆盖：${output}`);
const source = fs.readFileSync(storyPath, 'utf8');
const brief = JSON.parse(fs.readFileSync(briefPath, 'utf8'));
const meta = brief.meta || {};
if (!meta.title || !meta.project || !meta.logline || !meta.style || !meta.aspect) {
  throw new Error('Brief 必须明确提供中文剧名、英文项目 id、故事简介、视觉风格和画幅');
}
if (!brief.story?.synopsis || !Array.isArray(brief.story.beats) || brief.story.beats.length < 2) {
  throw new Error('Brief 必须提供故事概述及至少两条有 purpose 的节拍；不能由程序代写');
}
const seed = {
  meta: {
    title: meta.title, project: meta.project, logline: meta.logline,
    genre: meta.genre || '', language: meta.language || 'zh-CN',
    aspect: meta.aspect, style: meta.style, style_prompt: meta.style_prompt || null,
    total_duration_s: 0, stage: 'story',
    // 项目创建时间 = 立项那一刻。**只在这里写一次** —— 后续改板、出片都不许改它，
    // 看板按它倒序排剧目。老剧目没有这个字段（本 CLI 之前不写），由看板退回
    // board.json 的 mtime 推断；迁移剧目时可以用 mtime 回填。
    created_at: new Date().toISOString(),
    approvals: { story: null, shots: null, assets: null, keyframes: null },
    music: meta.music || null, final_video: null,
  },
  story: { ...brief.story, source },
  characters: brief.characters || [], identities: brief.identities || [],
  scenes: brief.scenes || [], scene_cast: brief.scene_cast || [], props: brief.props || [], shots: [],
};
const { board, report } = await compileLiteral(seed);
if (!report.parsed.scenes.length || !report.shots || !report.verbatim) {
  throw new Error('剧本无法确定性解析场次、镜头或台词；请检查剧本格式，不要猜测补全');
}
board.meta.stage = 'story';
const checked = checkBoard(board);
if (checked.errors.length) throw new Error(`板子不符合契约：\n${checked.errors.join('\n')}`);
fs.writeFileSync(output, JSON.stringify(board, null, 2) + '\n', 'utf8');
console.log(`板子：${output}\n源剧本 ${report.source_lines} 行，${report.shots} 个索引镜头，台词 ${report.dialogue} 句逐字保真`);
for (const warning of checked.warnings) console.warn(`警告：${warning}`);
