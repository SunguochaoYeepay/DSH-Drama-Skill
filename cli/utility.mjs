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
  addNode,
  applySets,
  collectOutputs,
  comfyUrl,
  downloadOutputs,
  linkInput,
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

// 先加节点（有些输入是 forceInput，必须先有源节点才能接）
for (const spec of flagAll('add-node')) {
  const m = /^([^=]+)=(.+)$/.exec(spec);
  if (!m) throw new Error(`--add-node 格式应为 <id>=<ClassType>，收到：${spec}`);
  const node = addNode(graph, m[1], m[2]);
  console.log(`  加节点：${m[1]} = ${m[2]}`);
  void node;
}
const applied = applySets(graph, flagAll('set'));
for (const spec of flagAll('link')) {
  const m = /^([^.]+)\.([^=]+)=([^:]+)(?::(\d+))?$/.exec(spec);
  if (!m) throw new Error(`--link 格式应为 <节点>.<输入>=<源节点>[:slot]，收到：${spec}`);
  const l = linkInput(graph, m[1], m[2], m[3], m[4] ?? 0);
  console.log(`  接线：${l.nodeId}.${l.inputName} ← ${l.from}[${l.slot}]`);
}

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

// **排除"原片回声"**：图里常有节点把上传的输入原样再吐出来（LoadVideo 的预览、
// 或某个 SaveVideo 写的是输入）。这类"产物"与源片逐字节相同，下载它等于"成功地把原片
// 复制了一遍"——2026-09-24 实测：SeedVR2 放大 OOM 失败后，正是这个回声让 CLI 报出
// "产物 1 个 ✓"。所以先按文件名排掉输入，再判断有没有真产物。
const echo = video ? path.basename(video).toLowerCase() : null;
const all = collectOutputs(history);
const outputs = all.filter((o) => String(o.filename || '').toLowerCase() !== echo);
if (!outputs.length) {
  const seen = all.map((o) => `${o.kind}:${o.filename}`).join('、') || '(无)';
  console.error(`  ✗ 这一轮没有真正的产物。图里报出来的：${seen}`);
  if (echo && all.length) console.error(`    （其中 ${echo} 是**上传的原片回声**，不算产物）`);
  console.error('    常见原因：显存不足 / 工作流里的输出节点没执行。上面若已打印失败原因，按它处理。');
  process.exit(1);
}
const saved = await downloadOutputs(outputs, outDir);
console.log(`  产物 ${saved.length} 个 → ${outDir}`);
for (const f of saved) console.log(`    · ${path.resolve(f)}  (${(fs.statSync(f).size / 1048576).toFixed(2)} MB)`);
