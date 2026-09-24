#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { approve, approvalStatus, clipResultPath, planKeyframeFiles, planLastKeyframeFiles, requireAllClips } from '../src/human-gates.mjs';
import { resolveRecordedPath } from '../src/recorded-path.mjs';
import { projectAssetFiles } from '../src/asset-resolver.mjs';
import { installCliErrorHandler } from '../src/cli-errors.mjs';

installCliErrorHandler();

const argv = process.argv.slice(2);
const command = argv[0];
const value = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const stage = value('stage');
const stages = ['story', 'board', 'direction', 'assets', 'keyframes', 'handoff', 'clip', 'final'];
const project = path.resolve(value('project', '.'));
const id = value('id');
if (argv.includes('--variant')) throw new Error('片段不再区分轮次；请去掉 --variant，每段视频只确认当前产物');
if (command === 'ready-assemble') {
  const planFile = path.resolve(value('plan', path.join(project, 'render.plan.json')));
  requireAllClips(project, JSON.parse(fs.readFileSync(planFile, 'utf8')));
  console.log('✓ 计划内所有视频片段均已人工确认，可以合成');
  process.exit(0);
}
let files = String(value('artifacts', '')).split(',').filter(Boolean).map((f) => path.resolve(f));
if (!files.length && stage === 'story') files = [path.join(project, 'story.md')].filter(fs.existsSync);
if (stage === 'story') {
  const story = path.join(project, 'story.md');
  if (files.length !== 1 || files[0] !== story) throw new Error('剧本确认必须绑定本项目的 story.md');
}
if (!files.length && stage === 'board') files = [path.join(project, 'board.json')].filter(fs.existsSync);
if (!files.length && stage === 'direction') files = [path.join(project, 'board.direction.json')].filter(fs.existsSync);
if (!files.length && stage === 'assets') {
  const boardFile = path.resolve(value('board', path.join(project, 'board.json')));
  if (fs.existsSync(boardFile)) {
    const board = JSON.parse(fs.readFileSync(boardFile, 'utf8'));
    files = projectAssetFiles(board, boardFile, { workspace: value('ws', null) });
  }
}
if (stage === 'keyframes') {
  const planPath = path.resolve(value('plan', path.join(project, 'render.plan.json')));
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  // 首帧 + 落幅一起签：落幅决定"这一镜停在哪"，只在出片时才发现画错了等于白出一遍视频。
  const expected = [...planKeyframeFiles(project, plan), ...planLastKeyframeFiles(project, plan)];
  if (!expected.length) throw new Error('计划槽位里没有可审阅的关键帧');
  if (files.length && (files.length !== expected.length || files.some((file) => !expected.includes(file)))) {
    throw new Error('关键帧确认必须绑定计划实际使用的图片；请省略 --artifacts 使用计划槽位');
  }
  files = expected;
}
if (!files.length && stage === 'clip' && id) {
  const actual = clipResultPath(project, id);
  if (actual) {
    const data = JSON.parse(fs.readFileSync(actual, 'utf8'));
    // 记录里的路径三种写法（仓库相对 / 剧目相对 / 本机绝对）统一由 recorded-path 解析。
    // **保持记录里的顺序** —— 它会一路传进票的 artifacts，而 assemble-units 取的正是
    // `artifacts[0]`；顺序在这里丢掉，就等于"想用哪条产物"这件事在票上无从表达。
    files = (data.files || [])
      .map((file) => (typeof file === 'string' ? file : file?.local_path || file?.localPath || file?.path))
      .map((p) => (p ? resolveRecordedPath(project, p) : null))
      .filter(Boolean);
  }
}
if (!['approve', 'status'].includes(command) || !stages.includes(stage) || !files.length) {
  console.error('用法：node cli/review-gate.mjs approve|status --project <dir> --stage story|direction|assets|keyframes|handoff|clip|final [--id g001] [--artifacts a,b]\n或：node cli/review-gate.mjs ready-assemble --project <dir> --plan render.plan.json');
  process.exit(2);
}
if (command === 'approve') {
  const ticket = approve(project, stage, files, { id, by: value('by', '用户') });
  console.log(`✓ 人工确认已记录：${stage}${id ? ` ${id}` : ''}（${ticket.at}）`);
} else {
  const result = approvalStatus(project, stage, files, id);
  console.log(result.ok ? '✓ 当前产物已人工确认' : `✗ ${result.reason}`);
  process.exitCode = result.ok ? 0 : 1;
}
