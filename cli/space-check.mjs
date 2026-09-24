#!/usr/bin/env node
/**
 * 空间核查单：把 `space.json` 里的空间声明与画面实际情况对照，输出一张可签署前阅读的清单。
 *
 * 用法：
 *   node cli/space-check.mjs <项目目录>            # 打印 + 写 reviews/space-check.md
 *   node cli/space-check.mjs <项目目录> --dry      # 只打印，不写文件
 *
 * 自动只判两件：**画里有没有人、人数对不对**（本地检测器，32 张真实成片关键帧上 100% 可用）。
 * 「两人是否相向 / 桌子是否在两人之间」这类**列成待人工确认** —— 不假装机器能判。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireComfyPython } from '../src/runtime-paths.mjs';
import { installCliErrorHandler } from '../src/cli-errors.mjs';
import { axisWarnings, facingWarnings, gazeConsistencyWarnings, renderSpaceReport, unitChecklist } from '../src/space-check.mjs';

installCliErrorHandler();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const projectArg = argv.find((x) => !x.startsWith('--'));
const value = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
if (!projectArg) {
  console.error('用法：node cli/space-check.mjs <项目目录> [--space space.json] [--dry]');
  process.exit(2);
}
const project = path.resolve(projectArg);
const spaceFile = path.resolve(value('space', path.join(project, 'space.json')));
const planFile = path.resolve(value('plan', path.join(project, 'render.plan.json')));
const DRY = argv.includes('--dry');

const plan = fs.existsSync(planFile) ? JSON.parse(fs.readFileSync(planFile, 'utf8')) : { units: [] };
const space = fs.existsSync(spaceFile) ? JSON.parse(fs.readFileSync(spaceFile, 'utf8')) : { scenes: {}, units: {} };
if (!fs.existsSync(spaceFile)) {
  console.log(`ℹ 没有 ${path.relative(process.cwd(), spaceFile)}：所有镜头都会显示"未声明"。`);
}
const units = plan.units || [];

/** 每个单元的**首帧**做人体检测（人数/存在性）。 */
const images = [];
for (const unit of units) {
  const p = unit.keyframe ? path.resolve(project, unit.keyframe) : null;
  if (p && fs.existsSync(p)) images.push({ unit, path: p });
}

let probes = new Map();
if (images.length) {
  const weights = path.resolve(
    value('weights', process.env.AIH_YOLO_WEIGHTS || path.join(project, '..', '..', '.tmp', 'spatial-lab', 'weights', 'yolo11n.pt')),
  );
  fs.mkdirSync(path.dirname(weights), { recursive: true });
  const args = [path.join(HERE, 'lib', 'presence.py'), '--weights', weights, '--json'];
  for (const i of images) args.push('--image', i.path);
  const r = spawnSync(requireComfyPython(), args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, cwd: path.dirname(weights) });
  if (r.stdout) {
    const data = JSON.parse(r.stdout);
    const byPath = new Map(data.results.map((x) => [path.resolve(x.image), x]));
    for (const i of images) probes.set(i.unit.id, byPath.get(path.resolve(i.path)) || null);
  } else {
    console.error(`⚠ 检测器没跑起来，自动判定一栏会是空：${String(r.stderr || '').slice(-200)}`);
  }
}

const warnings = [...axisWarnings(units, space)];
for (const unit of units) {
  warnings.push(...facingWarnings(unit, space));
  warnings.push(...gazeConsistencyWarnings(unit, space));
}
const checklists = units.map((unit) => {
  const c = unitChecklist(unit, space, probes.get(unit.id) || null);
  const v = space.units?.[unit.id]?.verified;
  return v ? { ...c, verified: v } : c;
});

const report = renderSpaceReport({ project: path.relative(path.resolve(HERE, '..'), project), checklists, warnings });
console.log(report);

if (!DRY) {
  const out = path.join(project, 'reviews', 'space-check.md');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, report, 'utf8');
  console.log(`\n核查单已写入：${path.relative(process.cwd(), out)}`);
}
