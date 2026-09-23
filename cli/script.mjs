#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { generateScript } from '../src/script-generation.mjs';
import { installCliErrorHandler } from '../src/cli-errors.mjs';
import { makeScriptReceipt, receiptPath, archiveReceiptPath, SCRIPT_MODEL } from '../src/script-provenance.mjs';

installCliErrorHandler();
const args = process.argv.slice(2);
const command = args[0];
const option = (name) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? null : args[i + 1];
};
const outArg = option('out');
const COMMANDS = ['generate', 'register-agent', 'register-user', 'revise'];
if (!COMMANDS.includes(command) || !outArg) {
  console.error('用法：node cli/script.mjs generate --input <brief.txt> --out <project/story.md>'
    + '\n       | register-agent --input <草稿> --out <project/story.md>'
    + '\n       | register-user --input <用户原稿> --out <project/story.md> --confirmed-by <用户>'
    + '\n       | revise --input <修订稿> --out <project/story.md> --reason "<改了什么、为什么改>"');
  process.exit(2);
}
const output = path.resolve(outArg);
const inputFile = option('input');
if (!inputFile || !fs.existsSync(inputFile)) throw new Error('找不到输入文件');
const input = fs.readFileSync(inputFile, 'utf8');
if (!input.trim()) throw new Error('输入文本为空');

// ── 修订与首次登记的分歧 ────────────────────────────────────────────────────
//
// 首次登记：剧本与票据都不许已存在（防"确认 A 交付 B"）。
// 修订：剧本与票据**都必须已存在**，且要写明原因 —— 否则无从判断改动的来路。
// 修订不改来源属性（模型产物就是模型产物，Agent 直写就是 Agent 直写），一律继承旧票。
const revising = command === 'revise';
let previous = null;
if (revising) {
  if (!fs.existsSync(output)) throw new Error(`没有可修订的剧本：${output}`);
  const oldReceipt = receiptPath(output);
  if (!fs.existsSync(oldReceipt)) throw new Error(`没有来源票据，无法修订：${oldReceipt}（无票的剧本请用 register-* 登记）`);
  if (!option('reason')) throw new Error('修订必须写明 --reason：改了什么、为什么改');
  previous = JSON.parse(fs.readFileSync(oldReceipt, 'utf8'));
} else if (fs.existsSync(output) || fs.existsSync(receiptPath(output))) {
  throw new Error('剧本或来源票据已存在；先人工审阅现有项目，不能静默覆盖（要改请用 revise）');
}
if (command === 'register-user' && !option('confirmed-by')) {
  throw new Error('用户原稿登记必须有明确的 --confirmed-by，Agent 不得代签');
}

let story;
let source;
let model = null;
let verifiedResponseModel = null;
let draftedBy = null;
if (command === 'generate') {
  const result = await generateScript(input, option('model') ? { model: option('model') } : {});
  story = result.story;
  source = 'bailian';
  model = result.responseModel;
  verifiedResponseModel = result.responseModel;
} else if (command === 'register-agent') {
  // Agent 在对话里直写：没有模型响应可核验，票据绑定 drafted_by 留痕。
  if (option('model')) throw new Error('Agent 直写稿不能标记模型');
  story = input;
  source = 'agent_draft';
  draftedBy = option('drafted-by') || 'agent';
} else if (command === 'register-user') {
  story = input;
  source = 'user_supplied';
} else {
  // revise：来源属性原样继承，只有内容变。
  story = input;
  source = previous.source;
  model = previous.model ?? null;
  verifiedResponseModel = previous.response_model ?? null;
  draftedBy = previous.drafted_by ?? null;
}

const receipt = makeScriptReceipt({ story, input, source, model, responseModel: verifiedResponseModel || null, draftedBy });
if (source === 'user_supplied') receipt.confirmed_by = previous?.confirmed_by || option('confirmed-by');

let archive = null;
if (revising) {
  const oldRevision = previous.revision || 1;
  archive = archiveReceiptPath(output, oldRevision);
  fs.writeFileSync(archive, JSON.stringify(previous, null, 2) + '\n', 'utf8');
  receipt.revision = oldRevision + 1;
  receipt.revised_from = { story_sha256: previous.story_sha256, recorded_at: previous.recorded_at || null };
  receipt.revise_reason = option('reason');
}

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, story, 'utf8');
fs.writeFileSync(receiptPath(output), JSON.stringify(receipt, null, 2) + '\n', 'utf8');
const sourceLabel = { bailian: model, user_supplied: `用户原稿（${receipt.confirmed_by} 确认）`, agent_draft: `Agent 直写（${receipt.drafted_by}）` }[source];
console.log(`剧本：${output}\n来源：${sourceLabel}\n票据：${receiptPath(output)}`);
if (revising) {
  console.log(`\n修订：第 ${receipt.revision} 版（上一版归档于 ${path.basename(archive)}）`);
  console.log(`原因：${receipt.revise_reason}`);
  console.log('⚠ 剧本内容已变 → story 人门票自动失效，下游（board/direction 等）也需重签。');
  console.log('  重签：node cli/review-gate.mjs approve --project <项目> --stage story --artifacts <story.md>');
}
