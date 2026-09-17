#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { assertUnitEmotionContract, makePlanProvenance, sealPlan } from '../src/plan-provenance.mjs';
import { installCliErrorHandler } from '../src/cli-errors.mjs';

installCliErrorHandler();

const argv = process.argv.slice(2);
const planPath = path.resolve(argv.find((x) => /\.json$/i.test(x) && !x.startsWith('--')) || '');
const value = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
if (!planPath || !argv.includes('--acknowledge-reviewed-migration')) {
  console.error('用法：node cli/migrate-plan.mjs <render.plan.json> --direction <direction.json> --units g005 [--board board.json] [--story story.md] --acknowledge-reviewed-migration');
  process.exit(2);
}
const projectDir = path.dirname(planPath);
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
const units = String(value('units', '')).split(',').filter(Boolean);
if (!units.length) throw new Error('显式迁移必须用 --units 列出已经人工复核并补齐 v5 情绪的目标单元');
for (const id of units) {
  const unit = plan.units.find((item) => item.id === id);
  if (!unit) throw new Error(`计划里没有 ${id}`);
  assertUnitEmotionContract(unit);
}
plan.provenance = makePlanProvenance({
  boardPath: path.resolve(value('board', path.join(projectDir, 'board.json'))),
  storyPath: path.resolve(value('story', path.join(projectDir, 'story.md'))),
  directionPath: path.resolve(value('direction', path.join(projectDir, 'board.direction.json'))),
  legacyMigration: true,
});
plan.provenance.reviewed_units = units;
sealPlan(plan);
fs.writeFileSync(planPath, JSON.stringify(plan, null, 2) + '\n', 'utf8');
console.log(`✓ 已把历史计划绑定到当前项目，仅迁移单元：${units.join(', ')}`);
