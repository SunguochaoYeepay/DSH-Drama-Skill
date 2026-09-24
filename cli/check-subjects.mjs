#!/usr/bin/env node
/**
 * 主体存在性 / 人数核查（独立命令，**不自动进闸门**）。
 *
 * 为什么要有它：三种"祈祷式"空间手段——线框示意图、真实空间照+人形标记、
 * 提示词强制声明（后者实测让出人率从 83% 掉到 67%）——全部失败。
 * 所以"画里有没有人"只能事后核查。检测器在 32 张真实成片关键帧上 100% 可用。
 *
 * 用法：
 *   node cli/check-subjects.mjs <项目目录>                  # 检查计划里所有关键帧 + 落幅
 *   node cli/check-subjects.mjs <项目目录> --stage clip      # 检查成片抽帧（每段取中段一帧）
 *   node cli/check-subjects.mjs <项目目录> --weights <pt>
 *
 * 退出码：发现"画面里没人" → 1（可当闸门用）；检测器不可用 → 2。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireComfyPython } from '../src/runtime-paths.mjs';
import { installCliErrorHandler } from '../src/cli-errors.mjs';

installCliErrorHandler();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const projectArg = argv.find((x) => !x.startsWith('--'));
const value = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
if (!projectArg) {
  console.error('用法：node cli/check-subjects.mjs <项目目录> [--stage keyframes|clip] [--weights <pt>]');
  process.exit(2);
}
const project = path.resolve(projectArg);
const stage = String(value('stage', 'keyframes'));
const planFile = path.resolve(value('plan', path.join(project, 'render.plan.json')));

/** 默认权重放 .tmp 下（ultralytics 会自动下载），**绝不让它落到仓库根**。 */
const weights = path.resolve(
  value('weights', process.env.AIH_YOLO_WEIGHTS || path.join(project, '..', '..', '.tmp', 'spatial-lab', 'weights', 'yolo11n.pt')),
);
fs.mkdirSync(path.dirname(weights), { recursive: true });

const targets = [];
if (stage === 'keyframes') {
  if (!fs.existsSync(planFile)) throw new Error(`没有生成计划：${planFile}`);
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  for (const unit of plan.units || []) {
    for (const slot of [unit.keyframe, unit.last_keyframe]) {
      if (!slot) continue;
      const p = path.resolve(project, slot);
      if (fs.existsSync(p)) targets.push(p);
    }
  }
} else if (stage === 'clip') {
  const unitsDir = path.join(project, 'units');
  if (fs.existsSync(unitsDir)) {
    for (const f of fs.readdirSync(unitsDir)) {
      if (/_first\.png$/i.test(f) || /_last\.png$/i.test(f)) targets.push(path.join(unitsDir, f));
    }
  }
} else {
  throw new Error(`--stage 只能是 keyframes / clip`);
}

if (!targets.length) {
  console.log(`没有可检查的图（stage=${stage}）。先出关键帧/成片。`);
  process.exit(0);
}

const args = [path.join(HERE, 'lib', 'presence.py'), '--weights', weights, '--json'];
for (const t of targets) args.push('--image', t);
// cwd 设成权重目录：ultralytics 首次会自动下载权重，落到那里而不是仓库根
const r = spawnSync(requireComfyPython(), args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, cwd: path.dirname(weights) });
if (r.status === 2 || (!r.stdout && r.stderr)) {
  console.error(`检测器不可用：${String(r.stderr || '').slice(-400)}`);
  process.exit(2);
}
const data = JSON.parse(r.stdout);
const s = data.summary;
console.log(`检查 ${s.checked} 张（stage=${stage}）　检测器可用 ${s.detector_ok} 张　出人率 ${s.present_rate == null ? '—' : `${(s.present_rate * 100).toFixed(0)}%`}`);
for (const item of data.results) {
  const flag = item.present ? '  ✓' : item.present === false ? '  ✗' : '  ?';
  console.log(`${flag} n=${item.n_person ?? '—'} ${path.relative(project, item.image)}`);
}
if (s.missing_subject.length) {
  console.error(`\n✗ ${s.missing_subject.length} 张图里没有检出主体 —— 这是最严重的空间失败，请人工确认是不是真空场景：`);
  for (const m of s.missing_subject) console.error(`  · ${path.relative(project, m)}`);
  process.exit(1);
}
console.log('\n✓ 全部图里都检出了主体。');
