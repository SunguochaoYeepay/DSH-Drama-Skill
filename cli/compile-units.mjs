#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { compileGenerationPlan } from '../src/generation-plan.mjs';
import { requireApproval } from '../src/human-gates.mjs';
import { makePlanProvenance, sealPlan } from '../src/plan-provenance.mjs';
import { installCliErrorHandler } from '../src/cli-errors.mjs';

installCliErrorHandler();

const argv = process.argv.slice(2);
const input = argv.find((x) => !x.startsWith('--'));
const value = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};

if (!input) {
  console.error('用法：node cli/compile-units.mjs <board.direction.json> [--out render.plan.json] [--target 10] [--units units.json]');
  process.exit(2);
}

const source = path.resolve(input);
const output = path.resolve(value('out', path.join(path.dirname(source), 'render.plan.json')));
const direction = JSON.parse(fs.readFileSync(source, 'utf8'));
requireApproval(path.dirname(source), 'direction', [source], { skip: argv.includes('--skip-gate') });

// 手工边界：--units 直接指定哪些导演单元合并成一个生成单元，并可直写生成时长。
// 格式：{"target_seconds": 12, "groups": [{"source_units": ["u1","u2"]}, {"source_units": ["u3"], "generation_duration_s": 9.5}]}
const unitsFile = value('units', null);
let manual = null;
if (unitsFile) {
  const spec = JSON.parse(fs.readFileSync(path.resolve(unitsFile), 'utf8'));
  if (!Array.isArray(spec.groups) || !spec.groups.length) throw new Error(`${unitsFile} 必须提供非空 groups`);
  manual = spec;
}

const boardPath = path.resolve(value('board', path.join(path.dirname(source), 'board.json')));
const storyPath = path.resolve(value('story', path.join(path.dirname(source), 'story.md')));
const plan = compileGenerationPlan(direction, {
  targetSeconds: Number(manual?.target_seconds ?? value('target', 10)),
  groups: manual?.groups,
});
plan.provenance = makePlanProvenance({ boardPath, storyPath, directionPath: source });
sealPlan(plan);
fs.writeFileSync(output, JSON.stringify(plan, null, 2) + '\n', 'utf8');

console.log(`生成计划：${plan.units.length} 个单元 -> ${output}`);
for (const unit of plan.units) {
  console.log(`  ${unit.id}  内容 ${unit.content_duration_s.toFixed(2)}s  生成 ${unit.generation_duration_s.toFixed(2)}s  ${unit.cast.join(',')}  ${unit.keyframe}  [${unit.boundary_reason}]`);
}
