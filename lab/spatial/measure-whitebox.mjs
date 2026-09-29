#!/usr/bin/env node
/** Compare a generated keyframe against a whitebox coords.json frame. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const arg = (name, fallback = undefined) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const required = (name) => {
  const value = arg(name);
  if (!value) throw new Error(`缺少 --${name}`);
  return value;
};

const coordsPath = path.resolve(required('coords'));
const imagePath = path.resolve(required('image'));
const frame = String(arg('frame', '1'));
const outJson = arg('out-json');
const outPng = arg('out-png');
const subjectArg = arg('subjects');
const coords = JSON.parse(fs.readFileSync(coordsPath, 'utf8'));
const entries = coords.frames?.[frame];
if (!entries) throw new Error(`coords.json 没有第 ${frame} 帧`);

const ids = subjectArg
  ? subjectArg.split(',').map((id) => id.trim()).filter(Boolean)
  : Object.keys(entries).filter((id) => !/^SEAT_|^TABLE$|^TRAIN$|^P$/.test(id));
const subjects = ids.map((id) => {
  const item = entries[id];
  if (!item || !item.root) throw new Error(`第 ${frame} 帧缺少主体 ${id} 的 root 坐标`);
  return { id, u: item.root[0], v: item.root[1] };
});
if (!subjects.length) throw new Error('没有可测量的人物主体');

const tempDir = fs.mkdtempSync(path.join(ROOT, '.tmp', 'whitebox-measure-'));
const targetsPath = path.join(tempDir, 'targets.json');
const generatedJson = outJson ? path.resolve(outJson) : path.join(tempDir, 'measurement.json');
const generatedPng = outPng ? path.resolve(outPng) : path.join(tempDir, 'annotated.png');
fs.mkdirSync(path.dirname(targetsPath), { recursive: true });
fs.writeFileSync(targetsPath, JSON.stringify({ shot: path.basename(imagePath), frame, subjects }, null, 2));

const python = process.env.AIH_PYTHON || process.env.COMFY_GEN || 'python';
const measure = path.join(ROOT, 'lab', 'spatial', 'py', 'measure.py');
const result = spawnSync(python, [measure, '--image', imagePath, '--targets', targetsPath, '--out-json', generatedJson, '--out-png', generatedPng], { encoding: 'utf8' });
if (result.error) throw result.error;
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
if (result.status !== 0) process.exit(result.status);
if (!outJson) console.log(`测量结果：${generatedJson}`);
if (!outPng) console.log(`标注图：${generatedPng}`);
