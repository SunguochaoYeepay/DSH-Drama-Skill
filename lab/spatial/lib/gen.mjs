/**
 * 试验箱的生成后端：薄封装，只 spawn `vendor/comfy-studio/gen.py`。
 *
 * 硬约束：**不修改也不复制主线的生成代码**，只调用同一个入口
 * （`src/runtime-paths.mjs` 的 COMFY_GEN / requireComfyPython，只读复用）。
 *
 * 产物定位不依赖 gen.py 的结果结构：跑完按 mtime 挑出这次新生成的图片。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LAB_DIR = path.resolve(HERE, '..');
export const REPO_ROOT = path.resolve(LAB_DIR, '..', '..');

/** 读仓库根的 .env 进 process.env（不覆盖已有值）。必须在 import runtime-paths 之前跑。 */
export function loadDotEnv(root = REPO_ROOT) {
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

let cached = null;
export async function runtimePaths() {
  if (!cached) {
    loadDotEnv();
    cached = await import(pathToFileURL(path.join(REPO_ROOT, 'src', 'runtime-paths.mjs')).href);
  }
  return cached;
}

const IMG = /\.(png|jpe?g|webp)$/i;

function newImagesIn(dir, sinceMs) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => IMG.test(f))
    .map((f) => ({ file: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .filter((x) => x.mtime >= sinceMs - 1500)
    .sort((a, b) => b.mtime - a.mtime)
    .map((x) => x.file);
}

/** 真实后端：调本地 ComfyUI */
export async function generateComfy({ mode, prompt, refs = [], outDir, ratio, style, fast = true, seed = -1, timeoutMs = 15 * 60 * 1000 }) {
  const { COMFY_GEN, requireComfyPython } = await runtimePaths();
  const py = requireComfyPython();
  fs.mkdirSync(outDir, { recursive: true });

  const resultFile = path.join(outDir, `_result_${Date.now()}.json`);
  const args = [COMFY_GEN, mode, '--prompt', prompt, '--out-dir', outDir, '--result-file', resultFile];
  if (ratio) args.push('--ratio', ratio);
  if (style) args.push('--style', style);
  if (fast) args.push('--fast');
  if (Number.isFinite(seed) && seed >= 0) args.push('--seed', String(seed));
  for (const r of refs) args.push('--image', r);

  const started = Date.now();
  const out = await new Promise((resolve, reject) => {
    const child = spawn(py, args, { cwd: REPO_ROOT, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`生成超时（${Math.round(timeoutMs / 1000)}s）：${mode}`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`gen.py 退出码 ${code}\n${stderr.slice(-800)}`));
      resolve({ stdout, stderr });
    });
  });

  const produced = newImagesIn(outDir, started).filter((f) => !path.basename(f).startsWith('_'));
  return { produced, stdout: out.stdout, stderr: out.stderr, args: args.slice(0, 6) };
}

/**
 * dry 后端：把已存在的图复制进 outDir，冒充"生成结果"。
 * 用途：不占用 GPU 就验证编排 / 度量 / 报告整条链路。
 */
export function makeDryBackend({ sourceImage }) {
  return async ({ outDir, tag }) => {
    fs.mkdirSync(outDir, { recursive: true });
    const dst = path.join(outDir, `dry_${tag}.png`);
    fs.copyFileSync(sourceImage, dst);
    return { produced: [dst], stdout: '(dry)', stderr: '', args: [] };
  };
}
