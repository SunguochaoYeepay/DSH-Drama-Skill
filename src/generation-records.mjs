import fs from 'node:fs';
import path from 'node:path';
import { recordedPathFor } from './recorded-path.mjs';

export function generationRecordPath(projectDir, stage) {
  return path.join(projectDir, 'reviews', `${stage}.generation.json`);
}

/**
 * 记录里的**展示路径**：能写成仓库相对就写相对，写不了原样保留。
 *
 * 起因（2026-09-23）：票的 `artifacts` 早就归一了，但**生成记录**这一路没有 ——
 * `cli/keyframes.mjs` 把 `planKeyframeFiles()` 的绝对路径原样交给 `writeGenerationRecord()`，
 * 签票时被整块复制进票里，于是入库示例的 `review.approvals.json` 里躺着
 * `D:\DeepSeek\ai-images-harness\…`，`tests/example-demo.test.mjs` 一直是红的。
 *
 * 规则本体已经收敛到 `src/recorded-path.mjs`（**一个所有者**）——
 * 这里只是把"记录里要归一的字段"挑出来交给它。
 */
export function displayPathOf(projectDir, p) {
  return recordedPathFor(projectDir, p);
}

/** 记录里需要归一的字段：产物的展示路径与计划的展示路径。 */
function normalizeDetails(projectDir, details) {
  const out = { ...details };
  if (Array.isArray(out.artifacts)) out.artifacts = out.artifacts.map((a) => displayPathOf(projectDir, a));
  if (typeof out.plan === 'string') out.plan = displayPathOf(projectDir, out.plan);
  return out;
}

export function writeGenerationRecord(projectDir, stage, details) {
  const file = generationRecordPath(projectDir, stage);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const record = { version: 1, stage, at: new Date().toISOString(), ...normalizeDetails(projectDir, details) };
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return file;
}

export function readGenerationRecord(projectDir, stage) {
  const file = generationRecordPath(projectDir, stage);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}
