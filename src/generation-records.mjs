import fs from 'node:fs';
import path from 'node:path';

export function generationRecordPath(projectDir, stage) {
  return path.join(projectDir, 'reviews', `${stage}.generation.json`);
}

/**
 * 仓库根：往上找 `.git` 或 `package.json`。
 *
 * ⚠ `src/human-gates.mjs` 里有一份**同名同规则的私有实现**（票的 `artifacts` 也做这件事）。
 * 这是一次有意的暂时重复：那个文件当时正被另一路工作改着，硬合会撞车。
 * 两边都稳定后应该提成一个公共所有者 —— 记在这里，免得下一个人以为是"忘了"。
 */
function repoRootOf(startDir) {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 10; i += 1) {
    if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * 记录里的**展示路径**：能写成仓库相对就写相对，写不了原样保留。
 *
 * 起因（2026-09-23）：票的 `artifacts` 早就归一了，但**生成记录**这一路没有 ——
 * `cli/keyframes.mjs` 把 `planKeyframeFiles()` 的绝对路径原样交给 `writeGenerationRecord()`，
 * 签票时被整块复制进票里，于是入库示例的 `review.approvals.json` 里躺着
 * `D:\DeepSeek\ai-images-harness\…`，`tests/example-demo.test.mjs`（"入库示例不含本机绝对路径"）
 * 一直是红的。一道规则管一半，等于没管。
 *
 * ⚠ 只改**展示形式**：没有任何地方拿记录里的路径去读文件（消费者只有 `approve()` 把它
 * 复制进票里），所以动的不是判据 —— `artifact_hash` 仍按 `approve()` 收到的绝对路径算，
 * 老票不会集体失效。
 *
 * 找不到仓库根时**原样返回**，绝不猜 —— 宁可留绝对路径，也不写一个假的相对路径。
 */
export function displayPathOf(projectDir, p) {
  const s = String(p || '');
  if (!s) return s;
  // 本来就是相对路径 → 一个字都不动。**不要拿 cwd 去 resolve** ——
  // 那会按"当前在哪跑的"猜出一个路径，比原样留着更糟。
  if (!path.isAbsolute(s)) return s;
  const repo = repoRootOf(projectDir);
  if (!repo) return s;
  const abs = path.resolve(s);
  if (!abs.startsWith(repo + path.sep)) return s;
  return path.relative(repo, abs).split(path.sep).join('/');
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
