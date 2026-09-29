#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { compileSpatialPlan } from '../src/spatial-plan.mjs';
import { installCliErrorHandler } from '../src/cli-errors.mjs';

installCliErrorHandler();

const argv = process.argv.slice(2);
const input = argv.find((arg) => !arg.startsWith('--'));
const outIndex = argv.indexOf('--out');
const output = outIndex >= 0 ? argv[outIndex + 1] : null;

if (!input || (outIndex >= 0 && !output)) {
  console.error('用法：node cli/compile-spatial.mjs <spatial-plan.json> [--out whitebox.json]');
  process.exit(2);
}

const inputPath = path.resolve(input);
const plan = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const resolved = compileSpatialPlan(plan);
const outputPath = path.resolve(output || path.join(path.dirname(inputPath), `${path.basename(inputPath, path.extname(inputPath))}.whitebox.json`));
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(resolved, null, 2)}\n`, 'utf8');
console.log(`✓ 空间计划已解析：${outputPath}`);
for (const asset of resolved.assets) {
  const position = asset.position || asset.clips?.[0]?.start_pos || asset.path?.waypoints?.[0];
  console.log(`  · ${asset.id || asset.asset_id}: ${position ? `[${position.join(', ')}]` : '轨迹'}`);
}
