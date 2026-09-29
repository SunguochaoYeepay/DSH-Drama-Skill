#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { compileDirectorStage } from '../src/director-stage.mjs';
import { installCliErrorHandler } from '../src/cli-errors.mjs';

installCliErrorHandler();
const argv = process.argv.slice(2);
const input = argv.find((arg) => !arg.startsWith('--'));
const outIndex = argv.indexOf('--out');
const shotIndex = argv.indexOf('--shot');
if (!input || (outIndex >= 0 && !argv[outIndex + 1])) {
  console.error('用法：node cli/compile-director-stage.mjs <director-stage.json> [--shot shot_id] [--out spatial-plan.whitebox.json]');
  process.exit(2);
}
const inputPath = path.resolve(input);
const scene = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const compiled = compileDirectorStage(scene, { shotId: shotIndex >= 0 ? argv[shotIndex + 1] : null });
const outputPath = path.resolve(outIndex >= 0
  ? argv[outIndex + 1]
  : path.join(path.dirname(inputPath), `${path.basename(inputPath, path.extname(inputPath))}.whitebox.json`));
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(compiled, null, 2)}\n`, 'utf8');
console.log(`✓ 导演台场景已编译：${outputPath}`);
console.log(`  · 对象：${compiled.assets.length} 个`);
console.log(`  · 时长：${compiled.total_frames} 帧 @ ${compiled.fps}fps`);
