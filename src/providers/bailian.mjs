/**
 * bailian.mjs — 线上生图：阿里百炼 `bl image`（Qwen-Image / Wan）。
 *
 * 为什么走它而不是绘梦：
 *   - **吃本地文件路径**，绘梦只吃公开 URL（要额外挂个图床）
 *   - 已经认证好了，多图合成 `--image` 可重复，`--n` 最多 6 张（正好当候选池）
 *
 * 两个必须处理的坑（都实测过）：
 *   1. `bl` 是 **PowerShell 脚本**，而且这台机器上的 "pwsh" 其实是 **Windows PowerShell 5.1**
 *      （`powershell.exe`）—— PS 7 没装。所以必须用 powershell.exe 全路径去调。
 *   2. **PS 5.1 会把参数里的 `"` 吃掉**。所以提示词一律**写进临时文件**、由脚本读进来，
 *      并且过一道净化把 `"` 换成全角 —— 绝不把提示词拼进命令行。
 *   3. `watermark` 默认 **true**，必须显式关掉，否则资产图上带水印。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ledger } from '../cost.mjs';
import { BAILIAN_CLI, POWERSHELL } from '../runtime-paths.mjs';

const PS = POWERSHELL;
const BL = BAILIAN_CLI;

/** 命令行的第一守则：**永远不要把提示词拼进命令行**。 */
export function sanitize(text) {
  return String(text || '')
    .replace(/"/g, '”')          // PS 5.1 会吃掉双引号
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

function psRun(scriptBody, timeoutMs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-'));
  const script = path.join(dir, 'run.ps1');
  fs.writeFileSync(script, ['$ErrorActionPreference = "Stop"', scriptBody].join('\n'), 'utf8');
  try {
    const r = spawnSync(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
      encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024,
    });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 记录目录快照，跑完比对，靠"新出现的文件"认出产物 —— 不依赖 CLI 的 JSON 形状。 */
function snapshot(dir) {
  if (!fs.existsSync(dir)) return new Set();
  return new Set(fs.readdirSync(dir));
}

function newFiles(dir, before, prefix) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => !before.has(f))
    .filter((f) => !prefix || f.startsWith(prefix))
    .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
    .map((f) => path.join(dir, f));
}

async function runBl({ verb, args, prompt, promptFlag, outDir, prefix, timeoutMs }) {
  fs.mkdirSync(outDir, { recursive: true });
  const before = snapshot(outDir);
  const lines = [];
  let promptFile = null;

  if (prompt !== undefined) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-p-'));
    promptFile = path.join(dir, 'prompt.txt');
    fs.writeFileSync(promptFile, sanitize(prompt), 'utf8');
    lines.push(`$p = (Get-Content -Raw -Encoding UTF8 '${promptFile}').TrimEnd("\`r","\`n")`);
  }
  const argList = args.map((a) => `'${String(a).replace(/'/g, "''")}'`).join(' ');
  const pf = promptFile ? ` --${promptFlag} $p` : '';
  // `bl` 自己的默认超时很短（实测第二张图就 "Request timed out"），必须显式给足。
  const seconds = Math.max(60, Math.round((timeoutMs || 600000) / 1000) - 30);
  lines.push(`& '${BL}' image ${verb}${argList ? ' ' + argList : ''}${pf} --out-dir '${outDir}' --out-prefix '${prefix}' --watermark false --timeout ${seconds} --output json`);

  const r = psRun(lines.join('\n'), timeoutMs);

  // 产出认领，按可靠性依次退：
  //   1. stdout 里的 JSON `saved` —— **权威**。靠"新出现的文件"检测会在**覆盖已有文件**时失灵
  //      （实测踩过：--force 重出时目录里名字没变，被判成"没有产出"，然后错误地退回了 URL）。
  //   2. 比目录快照
  //   3. stdout 里的 URL —— 那些 URL 带 `Expires`，**会过期**，绝不能存进板子，只用来下载。
  let files = [];
  let urls = [];
  try {
    const j = JSON.parse((r.stdout || '').trim());
    if (Array.isArray(j.saved)) files = j.saved.filter(Boolean);
    if (Array.isArray(j.urls)) urls = j.urls.filter(Boolean);
  } catch { /* 非 JSON 输出就往下退 */ }
  if (!urls.length) {
    urls = [...(r.stdout || '').matchAll(/https?:\/\/[^\s"']+?\.(?:png|jpe?g|webp)(?:\?[^\s"']*)?/gi)].map((m) => m[0]);
  }
  files = files.filter((f) => fs.existsSync(f));
  if (!files.length) files = newFiles(outDir, before, prefix);

  // 没落盘的，从 URL 下回来 —— 宁可多一步下载，也不把会过期的链接写进契约
  if (!files.length && urls.length) {
    files = await downloadAll(urls, outDir, prefix);
  }

  return { files, urls, status: r.status, stdout: r.stdout, stderr: r.stderr, error: r.error };
}

/** 下载到本地。存 URL 是错的：签名链接会过期，明天这板子就全是死链。 */
async function downloadAll(urls, outDir, prefix) {
  const got = [];
  for (const [i, url] of urls.entries()) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const ext = (url.match(/\.(png|jpe?g|webp)/i) || [, 'png'])[1].toLowerCase();
      const out = path.join(outDir, `${prefix}${urls.length > 1 ? `_${i + 1}` : ''}.${ext}`);
      fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
      got.push(out);
    } catch { /* 单个失败不影响其它 */ }
  }
  return got;
}

/** 文生图。 */
export async function generate({ prompt, size = '16:9', n = 1, outDir, prefix = 'img', model, seed, negative, timeoutMs = 600000 }) {
  const args = [];
  if (model) args.push('--model', model);
  args.push('--size', size, '--n', String(n));
  if (seed !== undefined && seed !== null) args.push('--seed', String(seed));
  if (negative) {
    // negative 同样走文件太啰嗦，这里只做净化
    args.push('--negative-prompt', sanitize(negative));
  }
  const r = await runBl({ verb: 'generate', args, prompt, promptFlag: 'prompt', outDir, prefix, timeoutMs });
  // **不管成没成都要记** —— 失败的调用也可能计费，而且"失败了多少次"本身就是该看见的信息
  ledger.add({ provider: 'bailian', op: 'image.generate', model: model || 'qwen-image-3.0', units: n, ok: r.files.length > 0 });
  return r;
}

/** 图生图 / 多图合成。`images` 是本地路径数组，顺序即「图1、图2…」。 */
export async function edit({ images, instruction, size = '16:9', n = 1, outDir, prefix = 'edit', model, seed, timeoutMs = 600000 }) {
  const args = [];
  for (const img of images || []) args.push('--image', path.resolve(img));
  if (model) args.push('--model', model);
  args.push('--size', size, '--n', String(n));
  if (seed !== undefined && seed !== null) args.push('--seed', String(seed));
  const r = await runBl({ verb: 'edit', args, prompt: instruction, promptFlag: 'prompt', outDir, prefix, timeoutMs });
  ledger.add({
    provider: 'bailian', op: 'image.edit', model: model || 'qwen-image-3.0',
    units: n, inputRefs: (images || []).length, ok: r.files.length > 0,
  });
  return r;
}

/** 只解析请求、不真发（用来验证参数拼得对不对，零成本）。 */
export async function dryRun({ prompt, size = '16:9', n = 1, outDir, prefix = 'dry' }) {
  return runBl({ verb: 'generate', args: ['--size', size, '--n', String(n), '--dry-run'], prompt, promptFlag: 'prompt', outDir, prefix, timeoutMs: 120000 });
}

/**
 * 配音。用 `bl speech synthesize`（cosyvoice-v3-flash）。
 *
 * 台词同样**写临时文件**再读进来 —— 理由和生图一样：PS 5.1 会吃掉参数里的引号，
 * 而台词里可能什么标点都有。
 */
export async function speak({ text, out, voice, rate, pitch, instruction, format = 'mp3', timeoutMs = 300000 }) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-t-'));
  const textFile = path.join(dir, 'text.txt');
  fs.writeFileSync(textFile, String(text || '').trim(), 'utf8');

  const preamble = [`$t = (Get-Content -Raw -Encoding UTF8 '${textFile}').TrimEnd("\`r","\`n")`];
  // 注意是 `--text $t`（内容）不是 `--text-file`（路径）——
  // 读进变量再传，就绕开了 PS 5.1 吃引号的问题，和生图那边 `--prompt $p` 一个路子。
  const args = ['--text $t', `--out '${out}'`, `--format ${format}`];
  if (voice) args.push(`--voice '${String(voice).replace(/'/g, "''")}'`);
  if (rate) args.push(`--rate ${Number(rate)}`);
  if (pitch) args.push(`--pitch ${Number(pitch)}`);
  // 刻意**不传 `--instruction`**：实测 cosyvoice-v3-flash 不支持它（引擎报 428 InvalidParameter，
  // 那是 v3.5-flash 配克隆音色才有的功能）。情绪改由 rate/pitch 表达，见 orchestrate.emotionToProsody。
  if (instruction) process.stderr.write('（提示：当前音色模型不支持 --instruction，情绪已由 rate/pitch 表达）\n');
  const seconds = Math.max(60, Math.round((timeoutMs || 300000) / 1000) - 20);
  const script = [...preamble, `& '${BL}' speech synthesize ${args.join(' ')} --timeout ${seconds} --output json`].join('\n');
  const r = psRun(script, timeoutMs);
  const ok = fs.existsSync(out) && fs.statSync(out).size > 0;
  ledger.add({
    provider: 'bailian', op: 'speech.synthesize', model: 'cosyvoice-v3-flash',
    chars: String(text || '').length, ok,
  });
  return { ok, file: ok ? out : null, status: r.status, stdout: r.stdout, stderr: r.stderr };
}

export const name = 'bailian';
