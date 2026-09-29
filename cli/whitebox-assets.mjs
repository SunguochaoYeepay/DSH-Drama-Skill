#!/usr/bin/env node
/** Register and inspect reusable whitebox prop assets. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../src/config.mjs';
import { installCliErrorHandler } from '../src/cli-errors.mjs';

installCliErrorHandler();

const argv = process.argv.slice(2);
const command = argv[0];
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name) => argv.includes(`--${name}`);
const usage = '用法：node cli/whitebox-assets.mjs list | validate | register --id ID --type TYPE --file MODEL --license LICENSE --source-url URL [--author NAME] [--size X,Y,Z]';
if (!['list', 'validate', 'register'].includes(command)) {
  console.error(usage);
  process.exit(2);
}

const root = path.join(PROJECT_ROOT, 'vendor', 'whitebox-assets', 'props');
const manifestPath = path.join(root, 'manifest.json');
fs.mkdirSync(root, { recursive: true });
const readManifest = () => JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const writeManifest = (manifest) => fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

if (command === 'list') {
  for (const asset of readManifest().assets || []) console.log(`${asset.asset_id}\t${asset.asset_type}\t${asset.model}`);
  process.exit(0);
}

if (command === 'validate') {
  const manifest = readManifest();
  const errors = [];
  const ids = new Set();
  for (const asset of manifest.assets || []) {
    if (!asset.asset_id || ids.has(asset.asset_id)) errors.push(`asset_id 重复或缺失：${asset.asset_id || '?'}`);
    ids.add(asset.asset_id);
    if (!asset.asset_type) errors.push(`${asset.asset_id}: 缺少 asset_type`);
    if (!asset.model || !fs.existsSync(path.join(root, asset.model))) errors.push(`${asset.asset_id}: 模型文件不存在`);
    for (const field of ['license', 'source_url', 'content_sha256']) if (!asset[field]) errors.push(`${asset.asset_id}: 缺少 ${field}`);
  }
  if (errors.length) {
    console.error(errors.map((e) => `· ${e}`).join('\n'));
    process.exit(1);
  }
  console.log(`✓ 道具资源清单通过（${(manifest.assets || []).length} 个）`);
  process.exit(0);
}

const id = flag('id');
const type = flag('type');
const source = flag('file');
const license = flag('license');
const sourceUrl = flag('source-url');
const author = flag('author') || null;
if (!id || !/^[A-Za-z][\w-]*$/.test(id) || !type || !source || !license || !sourceUrl) {
  console.error(usage);
  process.exit(2);
}
const sourcePath = path.resolve(source);
if (!fs.existsSync(sourcePath)) throw new Error(`模型文件不存在：${sourcePath}`);
const ext = path.extname(sourcePath).toLowerCase();
if (!['.glb', '.gltf', '.blend', '.fbx', '.obj'].includes(ext)) throw new Error(`不支持的模型格式：${ext}`);
const manifest = readManifest();
if ((manifest.assets || []).some((asset) => asset.asset_id === id)) throw new Error(`asset_id 已存在：${id}`);
const filename = `${id}${ext}`;
const target = path.join(root, filename);
fs.copyFileSync(sourcePath, target);
const hash = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
const size = flag('size')?.split(',').map(Number);
if (size && (size.length !== 3 || size.some((n) => !Number.isFinite(n) || n <= 0))) throw new Error('--size 必须是正数 X,Y,Z');
manifest.assets.push({
  asset_id: id,
  asset_type: type,
  model: filename,
  size_m: size || null,
  forward_axis: '+Y',
  ground_z: 0,
  license,
  source_url: sourceUrl,
  author,
  retrieved_at: new Date().toISOString(),
  content_sha256: hash,
});
writeManifest(manifest);
console.log(`✓ 道具已入库：${id}`);
