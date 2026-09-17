#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { approve, approvalStatus, requireAllClips } from '../src/human-gates.mjs';
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
const stages = ['direction', 'assets', 'keyframes', 'handoff', 'clip', 'final'];
const project = path.resolve(value('project', '.'));
const id = value('id');
const variant = value('variant', 'final');
if (command === 'ready-assemble') {
  const planFile = path.resolve(value('plan', path.join(project, 'render.plan.json')));
  requireAllClips(project, JSON.parse(fs.readFileSync(planFile, 'utf8')));
  console.log('✓ 计划内所有视频片段均已人工确认，可以合成');
  process.exit(0);
}
let files = String(value('artifacts', '')).split(',').filter(Boolean).map((f) => path.resolve(f));
if (!files.length && stage === 'direction') files = [path.join(project, 'board.direction.json')].filter(fs.existsSync);
if (!files.length && stage === 'assets') {
  const boardFile = path.resolve(value('board', path.join(project, 'board.json')));
  if (fs.existsSync(boardFile)) {
    const board = JSON.parse(fs.readFileSync(boardFile, 'utf8'));
    files = projectAssetFiles(board, boardFile, { workspace: value('ws', null) });
  }
}
if (!files.length && stage === 'keyframes') {
  const dir = path.resolve(value('dir', path.join(project, 'keyframes_bailian')));
  if (fs.existsSync(dir)) files = fs.readdirSync(dir).filter((n) => /\.(png|jpe?g|webp)$/i.test(n)).map((n) => path.join(dir, n));
}
if (!files.length && stage === 'clip' && id) {
  const result = path.join(project, 'units', `${id}.${variant}.result.json`);
  const legacyResult = path.join(project, 'units', `${id}.result.json`);
  const actual = fs.existsSync(result) ? result : legacyResult;
  if (fs.existsSync(actual)) {
    const data = JSON.parse(fs.readFileSync(actual, 'utf8'));
    files = (data.files || []).map((file) => typeof file === 'string' ? file : file?.local_path || file?.localPath || file?.path).filter((file) => file && fs.existsSync(file));
  }
}
if (!['approve', 'status'].includes(command) || !stages.includes(stage) || !files.length) {
  console.error('用法：node cli/review-gate.mjs approve|status --project <dir> --stage direction|assets|keyframes|handoff|clip|final [--id g001] [--variant preview|final] [--artifacts a,b]\n或：node cli/review-gate.mjs ready-assemble --project <dir> --plan render.plan.json');
  process.exit(2);
}
if (command === 'approve') {
  const ticket = approve(project, stage, files, { id, variant, by: value('by', '用户') });
  console.log(`✓ 人工确认已记录：${stage}${id ? ` ${id} ${variant}` : ''}（${ticket.at}）`);
} else {
  const result = approvalStatus(project, stage, files, id, variant);
  console.log(result.ok ? '✓ 当前产物已人工确认' : `✗ ${result.reason}`);
  process.exitCode = result.ok ? 0 : 1;
}
