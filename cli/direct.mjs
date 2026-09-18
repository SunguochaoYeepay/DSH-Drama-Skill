#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { buildBrief, callDirector, readBrief, validateDirection } from '../src/director.mjs';
import { requireApproval, writeReviewNote } from '../src/human-gates.mjs';
import { installCliErrorHandler } from '../src/cli-errors.mjs';
import { requireScriptProvenance } from '../src/script-provenance.mjs';
import { writeDirectionReceipt } from '../src/direction-provenance.mjs';
import { DIRECTOR_MODEL, DIRECTOR_MAX_OUTPUT_TOKENS } from '../src/config.mjs';
import { generateBatchedDirection } from '../src/director-batch.mjs';

installCliErrorHandler();

const argv = process.argv.slice(2);
const boardArg = argv.find((value) => /\.json$/i.test(value) && !value.startsWith('--'));
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};
if (!boardArg) {
  console.error('用法：node cli/direct.mjs <board.json> [--story story.md] [--out board.direction.json] [--batched] [--model qwen3.8-max] [--thinking] [--max-tokens 12000]');
  process.exit(2);
}

const boardPath = path.resolve(boardArg);
if (flag('model', DIRECTOR_MODEL) !== DIRECTOR_MODEL) throw new Error(`导演模型只能是 ${DIRECTOR_MODEL}`);
const projectDir = path.dirname(boardPath);
const storyPath = path.resolve(flag('story', path.join(projectDir, 'story.md')));
const output = path.resolve(flag('out', path.join(projectDir, 'board.direction.json')));
if (!fs.existsSync(storyPath)) throw new Error(`找不到剧本：${storyPath}`);
requireScriptProvenance(storyPath);

const board = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
if (!argv.includes('--skip-gate')) requireApproval(projectDir, 'story', [storyPath]);
else console.error('⚠ --skip-gate：仅限调试，已跳过剧本人工确认');
const script = fs.readFileSync(storyPath, 'utf8');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (m) => m.slice(1))), '..');
const prompt = buildBrief({ briefText: readBrief(root), board, script, projectRoot: root });
const result = argv.includes('--batched')
  ? await generateBatchedDirection({
    basePrompt: prompt, board, script, model: flag('model', DIRECTOR_MODEL),
    maxTokens: Number(flag('max-tokens', DIRECTOR_MAX_OUTPUT_TOKENS)),
    thinking: argv.includes('--thinking'), timeoutMs: undefined,
  })
  : await callDirector(prompt, {
  model: flag('model', undefined),
  thinking: argv.includes('--thinking'),
  maxTokens: Number(flag('max-tokens', DIRECTOR_MAX_OUTPUT_TOKENS)),
  });
if (!result.ok) {
  console.error(`导演失败（${result.seconds}s）：${result.error}`);
  process.exit(1);
}
const checked = validateDirection(result.direction, { board, script });
if (!checked.ok) {
  console.error(`导演输出未通过校验（${result.seconds}s）：`);
  for (const error of checked.errors) console.error(`  - ${error}`);
  process.exit(1);
}
fs.writeFileSync(output, JSON.stringify(result.direction, null, 2) + '\n', 'utf8');
writeDirectionReceipt({ directionPath: output, boardPath, storyPath, model: result.model, responseModel: result.responseModel });
const note = writeReviewNote(projectDir, 'direction', [
  '# 导演方案人工审阅', '',
  '机器校验已通过，但尚不能进入关键帧阶段。请逐单元检查时长、台词完整性、切换理由和高风险动作。', '',
  '| 单元 | 内容时长 | 镜头数 | 边界理由 | 高风险动作 |', '|---|---:|---:|---|---|',
  ...result.direction.units.map((u) => `| ${u.id} | ${Math.max(...u.shots.map((s) => Number(s.at) + Number(s.duration_s))).toFixed(2)}s | ${u.shots.length} | ${u.boundary_trigger || ''} | ${(u.action_complexity?.high_risk_events || []).map((e) => e.type || e.event || '').join('、') || '无'} |`),
  '', `确认命令：node cli/review-gate.mjs approve --project "${projectDir}" --stage direction --artifacts "${output}"`,
]);
console.log(`导演完成：${result.direction.units.length} 个单元，${result.seconds}s -> ${output}`);
console.log(`等待人工审阅：${note}`);
for (const warning of checked.warnings) console.log(`  warning: ${warning}`);
