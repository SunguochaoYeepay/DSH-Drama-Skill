#!/usr/bin/env node
/**
 * record-clip.mjs — 把**一个单元的主产物**记成指定文件。
 *
 * ## 为什么需要它（2026-09-24 实测的缺口）
 *
 * 去字幕产出的是**另一个文件**（`units/g001_vsr.mp4`），而 `units/<id>.result.json` 里
 * 记的还是带字幕的原片。消费方的取法各不相同，于是同一份记录有两个答案：
 *   · `cli/assemble-units.mjs` 取**票里的 `artifacts[0]`** —— 换了产物就必须重签票；
 *   · `cli/prepare-handoff.mjs` 取 `files[]` 里**第一条存在的** —— 不换顺序就拿原片去截尾帧，
 *     而**尾帧会被当作下一张关键帧的参考图**，字幕文字会跟着烤进去。
 * 所以"去字幕"这一步之后必须显式做两件配套动作：**把干净版挪到 `files[]` 最前** +
 * **用它重签 clip 票**。第二步仍归 `cli/review-gate.mjs`（票只能由它落笔），
 * 这一步只管记录。
 *
 * 用法：
 *   node cli/record-clip.mjs <项目目录> --unit g001 --clip units/g001_vsr.mp4 [--append] [--note "去字幕（VSR）"]
 *
 * 默认**前插**（这条现在是主产物）；`--append` 追加到末尾。
 * 已记过的同一文件只挪位置，不重复记账。路径统一写成**仓库相对**（`src/recorded-path.mjs` 的规矩）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { recordedPathFor, resolveRecordedPath } from '../src/recorded-path.mjs';
import { installCliErrorHandler } from '../src/cli-errors.mjs';

installCliErrorHandler();

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true); };
const projectArg = argv.find((a) => !a.startsWith('--') && fs.existsSync(a) && fs.statSync(a).isDirectory());
const unitId = flag('unit');
const clipArg = flag('clip');
if (!projectArg || !unitId || !clipArg) {
  console.error(`用法：node cli/record-clip.mjs <项目目录> --unit g001 --clip units/g001_vsr.mp4 [--append] [--note "去字幕（VSR）"]

  把这条片段记成该单元的主产物（默认前插到 files[] 最前）。记录之后还要
  **用它重签 clip 票**：node cli/review-gate.mjs approve --project <项目> --stage clip --id <单元> --artifacts <这条片段>`);
  process.exit(2);
}

const projectDir = path.resolve(projectArg);
const resultFile = path.join(projectDir, 'units', `${unitId}.result.json`);
if (!fs.existsSync(resultFile)) throw new Error(`没有这个单元的产物记录：${resultFile}`);

// 先解析成真身（相对剧目/仓库/末级目录兜底三种历史写法都由 recorded-path 认），
// 解析不出来就报错 —— 记一条不存在的路径等于给下游埋雷。
const abs = resolveRecordedPath(projectDir, String(clipArg)) || (fs.existsSync(path.resolve(clipArg)) ? path.resolve(clipArg) : null);
if (!abs) throw new Error(`找不到要记录的片段：${clipArg}`);
const shown = recordedPathFor(projectDir, abs);

const data = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
const files = Array.isArray(data.files) ? data.files : [];
const pathOf = (x) => (typeof x === 'string' ? x : (x?.local_path || x?.path || ''));
const keep = files.filter((x) => {
  const p = pathOf(x);
  if (!p) return true;
  const resolved = resolveRecordedPath(projectDir, p);
  return !(resolved && path.resolve(resolved) === path.resolve(abs));
});

const entry = {
  kind: 'video',
  local_path: shown,
  note: typeof flag('note') === 'string' ? flag('note') : '主产物',
  recorded_at: new Date().toISOString(),
};
data.files = flag('append') ? [...keep, entry] : [entry, ...keep];
fs.writeFileSync(resultFile, `${JSON.stringify(data, null, 2)}\n`, 'utf8');

console.log(`✓ ${path.relative(process.cwd(), resultFile)}`);
console.log(`  主产物 ${shown}${flag('append') ? '（追加到末尾）' : '（已前插到最前）'}`);
for (const [i, x] of data.files.entries()) {
  const p = pathOf(x);
  console.log(`   ${i === 0 ? '→' : ' '} [${i}] ${p}${resolveRecordedPath(projectDir, p) ? '' : '  ⚠ 文件不存在'}`);
}
console.log('\n下一步（票只能由 review-gate 落笔）：');
console.log(`  node cli/review-gate.mjs approve --project "${projectDir}" --stage clip --id ${unitId} --artifacts "${shown}"`);
