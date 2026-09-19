#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { generateScript } from '../src/script-generation.mjs';
import { installCliErrorHandler } from '../src/cli-errors.mjs';
import { makeScriptReceipt, receiptPath, SCRIPT_MODEL } from '../src/script-provenance.mjs';

installCliErrorHandler();
const args = process.argv.slice(2);
const command = args[0];
const option = (name) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? null : args[i + 1];
};
const outArg = option('out');
if (!['generate', 'register-agent', 'register-user'].includes(command) || !outArg) {
  console.error('用法：node cli/script.mjs generate --input <brief.txt> --out <project/story.md>'
    + ' | register-agent --input <草稿> --out <project/story.md>'
    + ' | register-user --input <用户原稿> --out <project/story.md> --confirmed-by <用户>');
  process.exit(2);
}
const output = path.resolve(outArg);
const inputFile = option('input');
if (!inputFile || !fs.existsSync(inputFile)) throw new Error('找不到输入文件');
const input = fs.readFileSync(inputFile, 'utf8');
if (!input.trim()) throw new Error('输入文本为空');
if (fs.existsSync(output) || fs.existsSync(receiptPath(output))) {
  throw new Error('剧本或来源票据已存在；先人工审阅现有项目，不能静默覆盖');
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
} else {
  story = input;
  source = 'user_supplied';
}

const receipt = makeScriptReceipt({ story, input, source, model, responseModel: verifiedResponseModel || null, draftedBy });
if (source === 'user_supplied') receipt.confirmed_by = option('confirmed-by');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, story, 'utf8');
fs.writeFileSync(receiptPath(output), JSON.stringify(receipt, null, 2) + '\n', 'utf8');
const sourceLabel = { bailian: model, user_supplied: `用户原稿（${receipt.confirmed_by} 确认）`, agent_draft: `Agent 直写（${receipt.drafted_by}）` }[source];
console.log(`剧本：${output}\n来源：${sourceLabel}\n票据：${receiptPath(output)}`);
