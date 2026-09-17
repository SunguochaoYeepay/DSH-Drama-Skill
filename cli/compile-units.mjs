#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { compileGenerationPlan } from '../src/generation-plan.mjs';
import { requireApproval } from '../src/human-gates.mjs';
import { makePlanProvenance, MIN_DIRECTOR_VERSION, sealPlan } from '../src/plan-provenance.mjs';
import { installCliErrorHandler } from '../src/cli-errors.mjs';

installCliErrorHandler();

const argv = process.argv.slice(2);
const input = argv.find((x) => !x.startsWith('--'));
const value = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};

if (!input) {
  console.error('用法：node cli/compile-units.mjs <board.direction.json> [--out render.plan.json] [--target 10]');
  process.exit(2);
}

const source = path.resolve(input);
const output = path.resolve(value('out', path.join(path.dirname(source), 'render.plan.json')));
const direction = JSON.parse(fs.readFileSync(source, 'utf8'));
if (Number(direction.version || 0) < MIN_DIRECTOR_VERSION) throw new Error(`拒绝编译历史导演稿 v${direction.version || 0}；当前最低协议是 v${MIN_DIRECTOR_VERSION}`);
requireApproval(path.dirname(source), 'direction', [source], { skip: argv.includes('--skip-gate') });
const plan = compileGenerationPlan(direction, { targetSeconds: Number(value('target', 10)) });
const boardPath = path.resolve(value('board', path.join(path.dirname(source), 'board.json')));
const storyPath = path.resolve(value('story', path.join(path.dirname(source), 'story.md')));
plan.provenance = makePlanProvenance({ boardPath, storyPath, directionPath: source });
sealPlan(plan);
fs.writeFileSync(output, JSON.stringify(plan, null, 2) + '\n', 'utf8');

console.log(`生成计划：${plan.units.length} 个单元 -> ${output}`);
for (const unit of plan.units) {
  console.log(`  ${unit.id}  内容 ${unit.content_duration_s.toFixed(2)}s  生成 ${unit.generation_duration_s.toFixed(2)}s  ${unit.cast.join(',')}  ${unit.keyframe}`);
}
