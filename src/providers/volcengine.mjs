/** 火山方舟 Seedream 图片通道（/api/v3/images/generations）。 */
import fs from 'node:fs';
import path from 'node:path';
import { ledger } from '../cost.mjs';
import { setting } from '../config.mjs';

export const name = 'volcengine';

function dataUrl(file) {
  const ext = path.extname(file).toLowerCase().replace('.', '') || 'png';
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'jpeg' : ext === 'webp' ? 'webp' : 'png';
  return `data:image/${mime};base64,${fs.readFileSync(file).toString('base64')}`;
}

async function request({ prompt, images = [], size = '2K', model, outDir, prefix }) {
  const key = setting('AIH_VOLCENGINE_API_KEY', '');
  if (!key) throw new Error('缺少 AIH_VOLCENGINE_API_KEY，无法使用火山方舟生图通道');
  const base = setting('AIH_VOLCENGINE_BASE_URL', 'https://ark.cn-beijing.volces.com');
  const body = { model: model || setting('AIH_VOLCENGINE_IMAGE_MODEL', 'doubao-seedream-4-5-251128'), prompt, size };
  if (images.length) body.image = images.map(dataUrl);
  const res = await fetch(`${base.replace(/\/$/, '')}/api/v3/images/generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`火山方舟返回非 JSON（${res.status}）：${text.slice(0, 300)}`); }
  if (!res.ok) throw new Error(`火山方舟生图失败（${res.status}）：${json.error?.message || text.slice(0, 500)}`);
  const items = Array.isArray(json.data) ? json.data : [];
  fs.mkdirSync(outDir, { recursive: true });
  const files = [];
  for (const [i, item] of items.entries()) {
    const url = item.url || item.image_url;
    if (!url) continue;
    const image = await fetch(url);
    if (!image.ok) continue;
    const out = path.join(outDir, `${prefix}${items.length > 1 ? `_${i + 1}` : ''}.png`);
    fs.writeFileSync(out, Buffer.from(await image.arrayBuffer()));
    files.push(out);
  }
  return { files, status: 0, json };
}

export async function generate({ prompt, size = '2K', n = 1, outDir, prefix = 'img', model }) {
  const r = await request({ prompt, size, model, outDir, prefix });
  ledger.add({ provider: name, op: 'image.generate', model: model || setting('AIH_VOLCENGINE_IMAGE_MODEL', 'doubao-seedream-4-5-251128'), units: n, ok: r.files.length > 0 });
  return r;
}

export async function edit({ images, instruction, size = '2K', n = 1, outDir, prefix = 'edit', model }) {
  if ((images || []).length > 14) throw new Error('火山方舟 Seedream 参考图最多 14 张');
  const r = await request({ prompt: instruction, images, size, model, outDir, prefix });
  ledger.add({ provider: name, op: 'image.edit', model: model || setting('AIH_VOLCENGINE_IMAGE_MODEL', 'doubao-seedream-4-5-251128'), units: n, inputRefs: (images || []).length, ok: r.files.length > 0 });
  return r;
}

