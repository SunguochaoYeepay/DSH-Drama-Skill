import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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

function sha256(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

function absolutePath(projectDir, value) {
  if (typeof value !== 'string' || !value) return null;
  return path.isAbsolute(value) ? value : path.resolve(projectDir, value);
}

/**
 * 生成记录的运行快照。
 *
 * 记录本身是审计数据，不应要求每个 CLI 都重复实现哈希和环境采集。
 * 只记录现有文件；缺失文件保留在 details 里，由对应阶段决定是否报错。
 */
function executionSnapshot(projectDir, details) {
  const candidates = [
    ...(Array.isArray(details.artifacts) ? details.artifacts : []),
    ...(typeof details.plan === 'string' ? [details.plan] : []),
    ...(Array.isArray(details.prompt_files) ? details.prompt_files : []),
  ];
  const files = {};
  for (const value of candidates) {
    const absolute = absolutePath(projectDir, value);
    if (!absolute || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
    const display = displayPathOf(projectDir, absolute);
    const digest = sha256(absolute);
    if (digest) files[display] = digest;
  }
  const inputFingerprint = Object.entries(files)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, digest]) => `${file}\0${digest}`)
    .join('\n');
  return {
    run_id: details.run_id || crypto.randomUUID(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    files,
    input_fingerprint: crypto.createHash('sha256').update(inputFingerprint).digest('hex'),
  };
}

export function writeGenerationRecord(projectDir, stage, details) {
  const file = generationRecordPath(projectDir, stage);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const normalized = normalizeDetails(projectDir, details);
  const record = {
    version: 1,
    stage,
    at: new Date().toISOString(),
    ...normalized,
    execution: executionSnapshot(projectDir, details),
  };
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return file;
}

export function readGenerationRecord(projectDir, stage) {
  const file = generationRecordPath(projectDir, stage);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}
