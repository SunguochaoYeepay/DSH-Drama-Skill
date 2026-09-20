#!/usr/bin/env node
/**
 * 导演稿的 **Agent 直写登记入口** —— 与 `cli/script.mjs register-agent` 对称。
 *
 * 草稿由对话里的 Agent 按 `references/director/brief.md` + `references/director/schema.md`
 * 的契约写出；这里只做三件事：**校验是合法 JSON → 落到项目 → 留来源票**，不调任何模型。
 *
 * 为什么需要它：纯本地跑时没有可调的高级导演模型，而来源留痕不能因此丢。
 * 票据记 `provider: agent_draft` / `model: null` / `authored_by`，**不得冒充模型产物**。
 *
 * 用法：
 *   node cli/register-direction.mjs <board.json> --input <导演稿草稿.json>
 *        [--out board.direction.json] [--story story.md] [--authored-by <标识>]
 *        [--skip-gate]（**仅限调试**，跳过剧本人工确认）
 *   `--out` 与 `--input` 相同时只补票据，不搬文件。
 *
 * 与 `cli/direct.mjs` 一样**先查剧本人工票**：导演稿基于剧本，剧本没确认就写导演稿等于白干。
 */
import fs from 'node:fs';
import path from 'node:path';
import { installCliErrorHandler } from '../src/cli-errors.mjs';
import { requireApproval } from '../src/human-gates.mjs';
import { writeAgentDirectionReceipt } from '../src/direction-provenance.mjs';

installCliErrorHandler();

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? null : argv[i + 1];
};
const boardArg = argv.find((x) => /board\.json$/i.test(x) && !x.startsWith('--'));
const inputArg = flag('input');
if (!boardArg || !inputArg) {
  console.error('用法：node cli/register-direction.mjs <board.json> --input <导演稿草稿.json> [--out board.direction.json] [--story story.md] [--authored-by <标识>]');
  process.exit(2);
}

const boardPath = path.resolve(boardArg);
const projectDir = path.dirname(boardPath);
const storyPath = path.resolve(flag('story') || path.join(projectDir, 'story.md'));
const output = path.resolve(flag('out') || path.join(projectDir, 'board.direction.json'));
const inputPath = path.resolve(inputArg);

if (!fs.existsSync(boardPath)) throw new Error(`找不到板子：${boardPath}`);
if (!fs.existsSync(storyPath)) throw new Error(`找不到剧本：${storyPath}`);
if (!fs.existsSync(inputPath)) throw new Error(`找不到导演稿草稿：${inputPath}`);

// 与 cli/direct.mjs 对齐：剧本未经人工确认，不得进入导演阶段。
requireApproval(projectDir, 'story', [storyPath], { skip: argv.includes('--skip-gate') });

const raw = fs.readFileSync(inputPath, 'utf8');
let direction;
try {
  direction = JSON.parse(raw);
} catch (error) {
  throw new Error(`导演稿草稿不是合法 JSON：${error.message}`);
}
if (!direction || typeof direction !== 'object' || Array.isArray(direction)) {
  throw new Error('导演稿草稿必须是 JSON 对象');
}
if (!Array.isArray(direction.units) || !direction.units.length) {
  throw new Error('导演稿草稿必须含非空的 units 数组');
}

fs.mkdirSync(path.dirname(output), { recursive: true });
if (path.resolve(output) !== inputPath) {
  fs.writeFileSync(output, JSON.stringify(direction, null, 2) + '\n', 'utf8');
}
const receipt = writeAgentDirectionReceipt({
  directionPath: output, boardPath, storyPath, authoredBy: flag('authored-by') || 'agent',
});
console.log(`导演稿：${output}\n单元素数：${direction.units.length}\n来源：Agent 直写（${receipt.authored_by}）\n票据：${output}.provenance.json\n提示：登记不等于确认，进入下一阶段仍需 review-gate --stage direction 的人工票`);
