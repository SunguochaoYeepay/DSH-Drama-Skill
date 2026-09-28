#!/usr/bin/env node
/**
 * 把参考图上传进 ComfyUI 的 input 目录。
 *
 * 复用 src/comfy-workflow.mjs 的 uploadVideo —— 它打的是通用 /upload/image 端点，
 * 名字叫 video 但吃任意文件（同一个通道，不另造一套）。
 */
import path from 'node:path';
import { uploadVideo } from '../../src/comfy-workflow.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const ASSETS = path.join(ROOT, 'projects', 'divorce_standoff_v2', 'assets');
const REFS = [
  'chen_mo_portrait.png',
  'chen_mo_default.png',
  'lin_xiao_portrait.png',
  'lin_xiao_default.png',
];

for (const f of REFS) {
  const name = await uploadVideo(path.join(ASSETS, f));
  console.log(`  ${f}  →  ComfyUI input: ${name}`);
}
console.log('完成。');
