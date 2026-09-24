#!/usr/bin/env node
/**
 * 跑一个现成的 ComfyUI utility 工作流（API prompt 格式）。
 *
 * 本机那批 utility（SeedVR2 放大 / VOID 修复 / SAM3 遮罩 / SDPose 姿态 /
 * DepthAnything3 深度 / 补帧）都归这个入口调 —— 它们不属于"生成"，是**加工与核查**。
 *
 * 用法：
 *   node cli/utility.mjs <workflow.json> --video in.mp4 --out-dir out/ \
 *     [--set 114:100.text=person] [--set 114:101.individual_masks=true] [--timeout 1800] [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  applySets,
  collectOutputs,
  comfyUrl,
  downloadOutputs,
  loadWorkflow,
  patchVideoInputs,
  runGraph,
  setInput,
  uploadVideo,
} from '../src/comfy-workflow.mjs';
import { installCliErrorHandler } from '../src/cli-errors.mjs';

installCliErrorHandler();

const argv = process.argv.slice(2);
const flagAll = (name) => argv.reduce((acc, a, i) => (a === `--${name}` && argv[i + 1] ? [...acc, argv[i + 1]] : acc), []);
const flag = (name, dflt = null) => flagAll(name)[0] ?? dflt;
const has = (name) => argv.includes(`--${name}`);

const workflowFile = argv.find((a) => !a.startsWith('--') && /\.json$/i.test(a));
if (!workflowFile) {
  console.error('用法：node cli/utility.mjs <workflow.json> --video in.mp4 --out-dir out/ [--set 节点.输入=值]');
  process.exit(2);
}

const video = flag('video');
const outDir = path.resolve(flag('out-dir', '.tmp/utility-out'));
const timeoutMs = Number(flag('timeout', 1800)) * 1000;
const DRY = has('dry-run');

const graph = loadWorkflow(path.resolve(workflowFile));
const applied = applySets(graph, flagAll('set'));

console.log(`工作流：${path.basename(workflowFile)}（${Object.keys(graph).length} 节点）`);
if (applied.length) {
  for (const a of applied) console.log(`  改参：${a.nodeId}(${a.classType}).${a.name} = ${JSON.stringify(a.value)}`);
}

if (video) {
  if (DRY) {
    // 干跑不上传，但把 file 填成文件名，好让 dump 出来的就是"将要提交的那份"
    const patched = patchVideoInputs(graph, path.basename(video));
    console.log(`  干跑：不跑；假装已上传，写入 LoadVideo 节点：${patched.join(', ')}`);
  } else {
    const uploaded = await uploadVideo(path.resolve(video));
    const patched = patchVideoInputs(graph, uploaded);
    console.log(`  视频已上传为 ${uploaded}；写入 LoadVideo 节点：${patched.join(', ')}`);
  }
}

if (DRY) {
  fs.mkdirSync(outDir, { recursive: true });
  const dump = path.join(outDir, `${path.basename(workflowFile, '.json')}.patched.json`);
  fs.writeFileSync(dump, JSON.stringify(graph, null, 2) + '\n', 'utf8');
  console.log(`  已写出将要提交的工作流：${dump}`);
  process.exit(0);
}

const { promptId, history, seconds } = await runGraph(graph, { timeoutMs });
console.log(`  跑完：${seconds} 秒（prompt_id=${promptId}）`);

const outputs = collectOutputs(history);
if (!outputs.length) {
  console.log('  ⚠ 这个工作流没有产出可下载的产物（可能只有 Preview 节点）');
  process.exit(1);
}
const saved = await downloadOutputs(outputs, outDir);
console.log(`  产物 ${saved.length} 个 → ${outDir}`);
for (const f of saved) console.log(`    · ${path.resolve(f)}  (${(fs.statSync(f).size / 1048576).toFixed(2)} MB)`);
