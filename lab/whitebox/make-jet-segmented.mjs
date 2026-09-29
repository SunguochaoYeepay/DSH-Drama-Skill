#!/usr/bin/env node
/** 生成 E4 动态分段机位计划：中段收紧，前后保持广角安全边界。 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const source = path.join(ROOT, 'lab', 'whitebox', 'jet.spatial.json');
const output = path.join(ROOT, 'lab', 'whitebox', 'jet-segmented.spatial.json');
const plan = JSON.parse(fs.readFileSync(source, 'utf8'));
plan.scene_name = 'jet_valley_segmented';
plan.camera.type = 'dolly-in';
plan.camera.framing = '发射段收紧、编队段广角';
plan.camera.keys = [
  { frame: 1, angle: 90, dist: 24, height: 10, fov: 65 },
  { frame: 70, angle: 90, dist: 18, height: 9, fov: 58 },
  { frame: 100, angle: 90, dist: 18, height: 9, fov: 58 },
  { frame: 168, angle: 90, dist: 24, height: 10, fov: 65 },
];
plan.notes = 'E4 分段机位对照：发射时短暂收紧，中后段回到广角，避免全程近景出框。';
fs.writeFileSync(output, JSON.stringify(plan, null, 2) + '\n', 'utf8');
console.log(`已生成 ${path.relative(ROOT, output)}`);
