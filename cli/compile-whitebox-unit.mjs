#!/usr/bin/env node
/** Compile one director unit's spatial_control into a validated whitebox plan. */
import fs from 'node:fs';
import path from 'node:path';
import { buildSpatialPlanForUnit } from '../src/spatial-control.mjs';
import { compileSpatialPlan } from '../src/spatial-plan.mjs';
import { loadMenu, validateWhitebox } from '../src/whitebox-schema.mjs';
import { installCliErrorHandler } from '../src/cli-errors.mjs';
import { makeArgs } from './lib/argv.mjs';

installCliErrorHandler();
const argv = process.argv.slice(2);
const { opt } = makeArgs();
const boardPath = path.resolve(argv.find((arg) => !arg.startsWith('--')) || '');
const directionPath = path.resolve(String(opt('direction', path.join(path.dirname(boardPath), 'board.direction.json'))));
const unitId = String(opt('unit', ''));
const outArg = opt('out', null);
if (!unitId || !fs.existsSync(boardPath) || !fs.existsSync(directionPath)) {
  console.error('用法：node cli/compile-whitebox-unit.mjs <board.json> --direction <board.direction.json> --unit u1 [--out units/u1.whitebox.json]');
  process.exit(2);
}

const board = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
const direction = JSON.parse(fs.readFileSync(directionPath, 'utf8'));
const unit = (direction.units || []).find((item) => item.id === unitId);
if (!unit) throw new Error(`导演单元不存在：${unitId}`);
const shot = unit.shots?.[0];
if (!shot) throw new Error(`${unitId} 没有镜头，无法生成白膜`);
const spatial = buildSpatialPlanForUnit({ unit, shot, board });
const whitebox = compileSpatialPlan(spatial);
const menu = loadMenu(path.resolve('vendor/whitebox-assets'));
const errors = validateWhitebox(whitebox, menu);
if (errors.length) throw new Error(`白膜计划校验失败：${errors.join('；')}`);
const outputPath = path.resolve(outArg || path.join(path.dirname(boardPath), 'units', `${unitId}.whitebox.json`));
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(whitebox, null, 2)}\n`, 'utf8');
console.log(`✓ 白膜计划已生成：${outputPath}`);
console.log(`  · assets=${whitebox.assets.length}, frames=${whitebox.total_frames}, fps=${whitebox.fps}`);
console.log(`  · 原因：${spatial.spatial_control.reasons.join('、') || '显式白膜要求'}`);
