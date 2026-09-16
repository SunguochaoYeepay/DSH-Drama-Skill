#!/usr/bin/env node
/**
 * ## ⚠ 参考图必须是**公开 URL**
 *
 * 绘梦**不支持 base64**。DramaClaw 的做法是先把参考图传到 Cloudinary，再传 URL。
 * 用户的 DramaClaw 里已经配好 Cloudinary（cloud `tmnr3jrc`、文件夹 `dramaclaw`），
 * 凭据在它的 `.env` 里 —— 我们复用，**不写死、不落盘**。
 *
 * 用法：
 *   node tools/huimeng.mjs --prompt "..." --ratio 9:16 --resolution 2k [--out x.png]
 *   node tools/huimeng.mjs --prompt "..." --ref 肖像.png --ref 身份图.png
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const BASE = process.env.HUIMENGI_BASE_URL || 'https://api.huimengi.com';
const DRAMACLAW_ENV = 'E:\\AI-Image\\DramaClaw\\DramaClawLocalhost\\.env';
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true); };

/** 从某个 .env 读一个键（不落盘）。 */
export function readEnvKey(name, envPath = DRAMACLAW_ENV) {
  if (process.env[name]) return process.env[name].trim();
  if (fs.existsSync(envPath)) {
    const m = fs.readFileSync(envPath, 'utf8').match(new RegExp(`^${name}=(.+)$`, 'm'));
    if (m) return m[1].trim();
  }
  return null;
}

export function readKey() {
  const k = readEnvKey('HUIMENGI_API_KEY');
  if (!k) throw new Error('找不到 HUIMENGI_API_KEY（环境变量或 --env <路径>）');
  return k;
}

const H = (key) => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' });

// ---------------------------------------------------------------- Cloudinary

/**
 * 把本地图片传到 Cloudinary，返回公开 URL。
 *
 * **签名上传**：Cloudinary 要 `signature = sha1(参与签名的参数按字典序拼 + api_secret)`，
 * 参与签名的只有 `folder` 和 `timestamp`（`file` 和 `api_key` 不参与）。
 */
export async function cloudinaryUpload(file, creds) {
  const { cloudName, apiKey, apiSecret, folder } = creds;
  if (!cloudName || !apiKey || !apiSecret) throw new Error('Cloudinary 三件套不全（cloudName/apiKey/apiSecret）');

  const timestamp = Math.floor(Date.now() / 1000);
  const signParams = { timestamp };
  if (folder) signParams.folder = folder;
  const toSign = Object.keys(signParams).sort().map((k) => `${k}=${signParams[k]}`).join('&');
  const signature = crypto.createHash('sha1').update(toSign + apiSecret).digest('hex');

  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(file)]), path.basename(file));
  fd.append('api_key', apiKey);
  fd.append('timestamp', String(timestamp));
  if (folder) fd.append('folder', folder);
  fd.append('signature', signature);

  const r = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, { method: 'POST', body: fd });
  const t = await r.text();
  if (!r.ok) throw new Error(`Cloudinary 上传失败 HTTP ${r.status}：${t.slice(0, 300)}`);
  const j = JSON.parse(t);
  if (!j.secure_url) throw new Error(`Cloudinary 响应里没有 secure_url：${t.slice(0, 300)}`);
  return j.secure_url;
}

/** 读 Cloudinary 配置（从 DramaClaw 的 .env）。 */
export function cloudinaryCreds() {
  return {
    cloudName: readEnvKey('CLOUDINARY_RELAY_CLOUD_NAME'),
    apiKey: readEnvKey('CLOUDINARY_RELAY_API_KEY'),
    apiSecret: readEnvKey('CLOUDINARY_RELAY_API_SECRET'),
    folder: readEnvKey('CLOUDINARY_RELAY_FOLDER') || 'dramaclaw',
  };
}

/**
 * 提交一个生图任务。
 * @returns {Promise<string>} task_id
 */
export async function submit({ key, prompt, model = 'image-2', ratio = '9:16', resolution = '2k', quality, image }) {
  const params = { prompt, ratio };
  if (resolution) params.resolution = resolution;
  if (quality && model === 'image-2-official') params.quality = quality;
  // 参考图：**只接 URL**（绘梦不支持 base64）
  if (image) params.image = Array.isArray(image) ? image.slice(0, 9) : image;

  const r = await fetch(`${BASE}/api/v1/tasks`, {
    method: 'POST', headers: H(key), body: JSON.stringify({ model, params }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`提交失败 HTTP ${r.status}：${t.slice(0, 400)}`);
  const j = JSON.parse(t);
  if (!j.task_id) throw new Error(`响应里没有 task_id：${t.slice(0, 300)}`);
  return j.task_id;
}

/** 轮询到完成。 */
export async function wait(key, taskId, { pollMs = 3000, maxPolls = 200, onTick } = {}) {
  for (let i = 0; i < maxPolls; i++) {
    await new Promise((r) => setTimeout(r, pollMs));
    const r = await fetch(`${BASE}/api/v1/tasks/${taskId}`, { headers: H(key) });
    if (!r.ok) throw new Error(`查询失败 HTTP ${r.status}`);
    const j = await r.json();
    const st = String(j.status || '').toLowerCase();
    if (onTick) onTick(i, st);
    if (['completed', 'succeeded', 'success', 'done'].includes(st)) return j;
    if (['failed', 'error', 'canceled', 'cancelled'].includes(st)) {
      throw new Error(`任务失败：${st} ${JSON.stringify(j).slice(0, 300)}`);
    }
  }
  throw new Error('轮询超时');
}

/** 从结果里抠出图片 URL。 */
export function pickUrl(task) {
  const seen = new Set();
  const walk = (v) => {
    if (typeof v === 'string' && /^https?:\/\//.test(v) && !seen.has(v)) { seen.add(v); return v; }
    if (Array.isArray(v)) { for (const x of v) { const u = walk(x); if (u) return u; } }
    if (v && typeof v === 'object') { for (const x of Object.values(v)) { const u = walk(x); if (u) return u; } }
    return null;
  };
  return walk(task.result || task.output || task);
}

// ---------------------------------------------------------------- CLI

async function main() {
  const prompt = flag('prompt', null);
  if (!prompt) {
    console.error(`用法: node tools/huimeng.mjs --prompt "..." [选项]

  --prompt       提示词（必需）
  --ratio        画幅 9:16 / 16:9 / 1:1（默认 9:16）
  --resolution   1k / 2k / 4k（默认 2k）
  --model        image-2（默认）或 image-2-official
  --quality      low/medium/high（**只在 image-2-official 时有效**）
  --ref <文件>   参考图（可重复，最多 9 张）—— **先自动传 Cloudinary 换公开 URL**
  --out          输出路径（默认 ./huimeng-<时间戳>.png）`);
    process.exit(2);
  }

  const key = readKey();
  const model = String(flag('model', 'image-2'));
  const ratio = String(flag('ratio', '9:16'));
  const resolution = String(flag('resolution', '2k'));
  const quality = flag('quality', null);
  const refs = argv.reduce((a, v, i) => (v === '--ref' && argv[i + 1] ? [...a, argv[i + 1]] : a), []);
  const out = path.resolve(String(flag('out', `huimeng-${Date.now()}.png`)));

  console.log(`\n绘梦 GPT-Image-2`);
  console.log(`  model=${model}  ratio=${ratio}  resolution=${resolution}${quality ? `  quality=${quality}` : ''}`);

  // 参考图：本地文件 → Cloudinary → 公开 URL
  let urls;
  if (refs.length) {
    if (refs.length > 9) { console.error('参考图最多 9 张'); process.exit(2); }
    const creds = cloudinaryCreds();
    console.log(`  参考图 ${refs.length} 张 → 传 Cloudinary（cloud=${creds.cloudName} folder=${creds.folder}）`);
    urls = [];
    for (const f of refs) {
      if (!fs.existsSync(f)) { console.error(`  ✗ 找不到 ${f}`); process.exit(2); }
      const u = await cloudinaryUpload(f, creds);
      console.log(`    ${path.basename(f)} → ${u.slice(0, 70)}…`);
      urls.push(u);
    }
  }

  console.log(`  prompt: ${prompt.slice(0, 80)}${prompt.length > 80 ? '…' : ''}`);

  const t0 = Date.now();
  const taskId = await submit({ key, prompt, model, ratio, resolution, quality, image: urls });
  console.log(`  已提交 task_id=${taskId}`);
  const task = await wait(key, taskId, { onTick: (i, st) => process.stderr.write(`\r  轮询 ${i + 1}：${st}     `) });
  process.stderr.write('\n');
  const url = pickUrl(task);
  if (!url) { console.error('✗ 结果里没有图片 URL：' + JSON.stringify(task).slice(0, 400)); process.exit(1); }

  const img = await fetch(url);
  if (!img.ok) { console.error(`✗ 下载失败 HTTP ${img.status}`); process.exit(1); }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(await img.arrayBuffer()));
  console.log(`\n✓ ${out}`);
  console.log(`  ${(fs.statSync(out).size / 1048576).toFixed(2)} MB   用时 ${Math.round((Date.now() - t0) / 1000)} 秒`);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((e) => { console.error('\n✗ ' + e.message); process.exit(1); });
}
