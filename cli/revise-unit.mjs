#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { buildBrief, callDirector, readBrief } from '../src/director.mjs';
import { installCliErrorHandler } from '../src/cli-errors.mjs';
import { requireApproval } from '../src/human-gates.mjs';
import { writeDirectionReceipt } from '../src/direction-provenance.mjs';
import { DIRECTOR_MAX_OUTPUT_TOKENS, DIRECTOR_MODEL } from '../src/config.mjs';

installCliErrorHandler();
const argv = process.argv.slice(2);
const value = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const boardArg = argv.find((x) => /board\.json$/i.test(x) && !x.startsWith('--'));
const unitId = value('unit');
const feedbackPath = value('feedback');
if (!boardArg || !unitId || !feedbackPath) {
  console.error('用法：node cli/revise-unit.mjs <board.json> --unit <id> --feedback <revision.md> [--story story.md] [--out board.direction.json]');
  process.exit(2);
}
const boardPath = path.resolve(boardArg);
const projectDir = path.dirname(boardPath);
const storyPath = path.resolve(value('story', path.join(projectDir, 'story.md')));
const directionPath = path.resolve(value('direction', path.join(projectDir, 'board.direction.json')));
const output = path.resolve(value('out', directionPath));
const board = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
const direction = JSON.parse(fs.readFileSync(directionPath, 'utf8'));
const current = direction.units?.find((unit) => unit.id === unitId);
if (!current) throw new Error(`导演稿中找不到单元：${unitId}`);
requireApproval(projectDir, 'story', [storyPath]);
const feedback = fs.readFileSync(path.resolve(feedbackPath), 'utf8');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (m) => m.slice(1))), '..');
const system = [
  buildBrief({ briefText: readBrief(root), board, script: fs.readFileSync(storyPath, 'utf8'), projectRoot: root }),
  `\n\n【单元级返修】只修订单元 ${unitId}。现有单元：\n${JSON.stringify(current, null, 2)}`,
  `\n返修反馈：\n${feedback}`,
  '\n只输出 JSON：{"unit": {...}}。不得输出顶层 units，不得改写台词原文或其他单元。保留该单元全部 v6 字段，并让 shots 的 n/at/duration_s 连续合法。',
].join('');
const result = await callDirector(system, {
  model: DIRECTOR_MODEL,
  maxTokens: Number(value('max-tokens', Math.min(DIRECTOR_MAX_OUTPUT_TOKENS, 7000))),
});
if (!result.ok) throw new Error(`单元导演返修失败（${result.seconds}s）：${result.error}`);
const revisedUnit = result.direction.unit || result.direction;
if (!revisedUnit || revisedUnit.id !== unitId) throw new Error(`返修结果没有交出单元 ${unitId}`);
const merged = structuredClone(direction);
merged.units = merged.units.map((unit) => unit.id === unitId ? revisedUnit : unit);
fs.writeFileSync(output, JSON.stringify(merged, null, 2) + '\n', 'utf8');
writeDirectionReceipt({ directionPath: output, boardPath, storyPath, model: result.model, responseModel: result.responseModel });
console.log(`单元返修完成：${unitId}，导演稿已更新：${output}`);
