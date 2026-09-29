#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { compileDeepBlendScene } from '../src/deepblend-scene.mjs';
import { installCliErrorHandler } from '../src/cli-errors.mjs';

installCliErrorHandler();
const argv = process.argv.slice(2);
const input = argv.find((arg) => !arg.startsWith('--'));
const outIndex = argv.indexOf('--out');
const output = outIndex >= 0 ? argv[outIndex + 1] : null;
if (!input || (outIndex >= 0 && !output)) {
  console.error('用法：node cli/compile-deepblend.mjs <spatial-plan.json> [--out scene-spec.json]');
  process.exit(2);
}
const plan = JSON.parse(fs.readFileSync(path.resolve(input), 'utf8'));
const scene = compileDeepBlendScene(plan);
const outputPath = path.resolve(output || path.join(path.dirname(input), `${path.basename(input, path.extname(input))}.deepblend.json`));
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(scene, null, 2)}\n`, 'utf8');
console.log(`✓ DeepBlend SceneSpec 已生成：${outputPath}`);
console.log(`  · entities=${scene.entities.length}, tracks=${scene.animationTracks.length}, frames=${scene.project.frameEnd}`);
