#!/usr/bin/env node
/**
 * dump-payload.mjs — **摊开某次生图真正提交给 ComfyUI 的内容**。
 *
 * 为什么要有它：本仓 `--prompt` 不是最终稿。上游 `gen.py` 的 `build_*` 还会
 *   · 追加 `--style` 预设的正向句（旧的 Qwen-Image-Edit 链路），
 *   · 把负向条件**整个替换**成预设。
 * 所以排查画面问题时，看本仓提示词会看漏一段、看错一段。
 *
 * 数据来源是 ComfyUI 自己的 `/history/<prompt_id>` —— **那一次提交的原文**，
 * 不是本地复现。prompt_id 从本仓的 result.json 里取。
 *
 * 用法：
 *   node cli/dump-payload.mjs --project <项目目录> --unit <单元 id>
 *   node cli/dump-payload.mjs <result.json 路径>
 *
 * 选项：
 *   --comfy <url>   ComfyUI 地址（默认 http://127.0.0.1:8188）
 *   --history <f>   直接读一份 `/history/<id>` 的 JSON 文件，不连 ComfyUI
 *                   （ComfyUI 已关、或要把提交原文存档时用）
 *   --out <path>    报告写入路径（默认 <项目>/reviews/comfyui-payload-<id>.md）
 *   --no-out        只打终端，不写文件
 *
 * 退出码：0 = 拿到了提交原文；1 = 取不到（result.json 缺 prompt_id / ComfyUI 连不上 / history 里没有这次）。
 */

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------- 参数

const argv = process.argv.slice(2);
const flag = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? '') : dflt;
};
const has = (name) => argv.includes(`--${name}`);
const positional = argv.filter((a) => !a.startsWith('--')
  && !['--project', '--unit', '--comfy', '--out'].includes(argv[argv.indexOf(a) - 1]));

const COMFY = (flag('comfy', 'http://127.0.0.1:8188') || 'http://127.0.0.1:8188').replace(/\/+$/, '');
const PROJECT = flag('project');
const UNIT = flag('unit');
const NO_OUT = has('no-out');

/** result.json 的位置：关键帧在 keyframes_local_v2/，视频在 units/，都是隐藏文件 `.<id>.result.json`。 */
function findResult() {
  if (positional[0]) return positional[0];
  if (!PROJECT || !UNIT) {
    console.error('用法：node cli/dump-payload.mjs --project <项目目录> --unit <id>');
    console.error('  或：node cli/dump-payload.mjs <result.json 路径>');
    process.exit(1);
  }
  // 命名不统一：关键帧是 `.<id>.result.json`，视频是 `<id>.result.json`，两种都试。
  const candidates = ['keyframes_local_v2', 'keyframes_render', 'units']
    .flatMap((d) => [path.join(PROJECT, d, `.${UNIT}.result.json`), path.join(PROJECT, d, `${UNIT}.result.json`)]);
  const hit = candidates.find((p) => fs.existsSync(p));
  if (!hit) {
    console.error(`在 ${PROJECT} 下找不到 ${UNIT} 的 result.json（找过 keyframes_local_v2 / keyframes_render / units）`);
    process.exit(1);
  }
  return hit;
}

const resultPath = findResult();
const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
const pid = result.prompt_id;
if (!pid) {
  console.error(`${resultPath} 里没有 prompt_id —— 这次生成没走 ComfyUI，或记录版本太旧。`);
  process.exit(1);
}

// ---------------------------------------------------------------- 取提交原文

let entry;
const historyFile = flag('history');
if (historyFile) {
  if (!fs.existsSync(historyFile)) {
    console.error(`找不到 history 文件：${historyFile}`);
    process.exit(1);
  }
  entry = JSON.parse(fs.readFileSync(historyFile, 'utf8'))?.[pid];
} else {
  const res = await fetch(`${COMFY}/history/${pid}`).catch((e) => {
    console.error(`连不上 ComfyUI（${COMFY}）：${e.message}`);
    process.exit(1);
  });
  entry = (await res.json())?.[pid];
}
if (!entry) {
  console.error(`history 里没有 ${pid}（可能已被清空，或这次提交没成功）。`);
  process.exit(1);
}

/** `entry.prompt` 是 [0, prompt_id, graph, extra, outputs]；不同版本索引可能不同，直接找 graph。 */
const promptArr = Array.isArray(entry.prompt) ? entry.prompt : [];
const graph = promptArr.find((x) => x && typeof x === 'object' && !Array.isArray(x)
  && Object.values(x).some((n) => n && typeof n === 'object' && n.class_type));
if (!graph) {
  console.error('history 里取不到 graph —— ComfyUI 返回结构变了，需要改这个工具。');
  process.exit(1);
}

// ---------------------------------------------------------------- 解析

const nodes = Object.entries(graph).map(([id, n]) => ({ id, ...n }));
const byType = (re) => nodes.filter((n) => re.test(n.class_type));

/** 文本编码节点：Qwen 家族一个节点同时给 positive 和 negative，老家族是正负各一个节点。 */
const encoders = byType(/TextEncode|CLIPTextEncode/);
const textFields = ['prompt', 'text', 'positive', 'negative_prompt', 'negative'];

const positives = [];
const negatives = [];
for (const n of encoders) {
  for (const [k, v] of Object.entries(n.inputs || {})) {
    if (typeof v !== 'string' || !textFields.includes(k)) continue;
    if (/negative/i.test(k)) negatives.push({ id: n.id, type: n.class_type, text: v });
    else positives.push({ id: n.id, type: n.class_type, text: v });
  }
}

/** 采样链路的关键入参。认 class_type，不认节点号 —— 换模型族时布局会变。 */
const keyParams = [];
const describe = {
  UNETLoader: (i) => `unet=${i.unet_name} / ${i.weight_dtype || ''}`.trim(),
  CLIPLoader: (i) => `clip=${i.clip_name} / ${i.type || ''}`.trim(),
  VAELoader: (i) => `vae=${i.vae_name}`,
  LoadImage: (i) => `参考图 ${i.image}`,
  KSampler: (i) => `steps=${i.steps} cfg=${i.cfg} ${i.sampler_name}/${i.scheduler} denoise=${i.denoise}`,
  LoraLoaderModelOnly: (i) => `lora=${i.lora_name} strength=${i.strength_model}`,
  ModelSamplingAuraFlow: (i) => `shift=${i.shift}`,
  CFGNorm: (i) => `cfgnorm=${i.strength}`,
  EmptyLatentImage: (i) => `画布 ${i.width}×${i.height}`,
};
for (const n of nodes) {
  const d = describe[n.class_type];
  if (d) keyParams.push({ id: n.id, type: n.class_type, value: d(n.inputs || {}) });
}

// ---------------------------------------------------------------- 报告

const positiveText = positives.map((p) => p.text).join('\n');
const negativeText = negatives.map((n) => n.text).join('\n');
const out = [];
const id = UNIT || path.basename(resultPath).replace(/^\./, '').replace(/\.result\.json$/, '');

out.push(`# ${id}　真正提交给 ComfyUI 的内容`);
out.push('');
const source = historyFile
  ? `history 文件 \`${historyFile}\``
  : `ComfyUI \`${COMFY}/history/${pid}\``;
out.push(`数据来源：${source} —— **那一次提交的原文**，不是本地复现。`);
out.push(`本仓记录：\`${resultPath}\``);
out.push('');

out.push('## 这次提交');
out.push('');
out.push('| 项 | 值 |');
out.push('|---|---|');
if (result.params?.mode) out.push(`| 模式 | ${result.params.mode} |`);
if (result.params?.width) out.push(`| 输出画幅 | ${result.params.width}×${result.params.height} |`);
if (result.seed_used != null) out.push(`| seed | ${result.seed_used} |`);
if (result.elapsed_s != null) out.push(`| 耗时 | ${result.elapsed_s} 秒 |`);
out.push(`| 参考图 | ${byType(/^LoadImage$/).length} 张 |`);
if (result.params?.image_model) out.push(`| 图像模型族 | ${result.params.image_model} |`);
out.push('');

out.push('## positive（真正进采样器的正向条件）');
out.push('');
for (const p of positives) out.push(`> 节点 ${p.id} \`${p.type}\``);
out.push('');
out.push('```');
out.push(positiveText || '（这次提交里没有正向文本节点）');
out.push('```');
out.push('');

out.push('## negative（负向条件）');
out.push('');
for (const n of negatives) out.push(`> 节点 ${n.id} \`${n.type}\``);
out.push('');
out.push('```');
out.push(negativeText || '（空 —— 写实类剧目负向为空等于没有画质防线）');
out.push('```');
out.push('');

out.push('## 采样链路');
out.push('');
out.push('| 节点 | class_type | 入参 |');
out.push('|---|---|---|');
for (const k of keyParams) out.push(`| ${k.id} | ${k.type} | \`${k.value}\` |`);
out.push('');

out.push('## 字数账');
out.push('');
const mine = (result.prompt_used || '').length;
out.push(`- 本仓下发的提示词：${mine} 字符`);
out.push(`- 进 ComfyUI 的 positive：${positiveText.length} 字符`);
out.push(`- 中间层改动：${positiveText.length - mine > 0 ? '+' : ''}${positiveText.length - mine} 字符`);
out.push(`- negative：${negativeText.length} 字符`);
out.push('');
out.push('> 本仓的字数自检只管「本仓下发的提示词」。进模型的是 positive 这一栏。');
out.push('');

const target = NO_OUT ? null : (flag('out') || (PROJECT ? path.join(PROJECT, 'reviews', `comfyui-payload-${id}.md`) : null));
if (target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, out.join('\n'), 'utf8');
  console.log(`报告：${target}`);
}
console.log(`positive ${positiveText.length} 字符 / negative ${negativeText.length} 字符 / 采样节点 ${keyParams.length} 个`);
if (!negatives.length || !negativeText.trim()) {
  console.log('⚠ 这次提交的负向条件为空');
}
