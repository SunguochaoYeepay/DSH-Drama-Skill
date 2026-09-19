#!/usr/bin/env node
/**
 * director.test.mjs — 「导演」这一步的验收。
 *
 * 2026-09-19：机器校验器 `validateDirection` 已随「去掉 QA 机器人审核」移除
 * （连带 `findDialogueLeak` / `checkReverseFacing` 及其 60 余条断言）。
 * 导演稿能不能用，由人工审阅决定，代码不再拦。
 *
 * 所以这里只留**仍在生效**的两类行为：
 *   ① 简报装配：职业简报与输出 schema 必须进 prompt；schema 缺失要立即报错
 *   ② 台词识别：从剧本里认出台词行（行号 → 原文）
 *
 *   node tests/director.test.mjs <board.json> [story.md]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectDialogueLines, buildBrief, readBrief, MIN_DIRECTION_VERSION,
} from '../src/director.mjs';
import { FIXTURE, fixtureOrArg } from './fixtures/index.mjs';

let passed = 0;
const failures = [];
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`FAIL   ${label}${detail ? '  → ' + detail : ''}`); }
}

const boardPath = fixtureOrArg(process.argv, 2, FIXTURE.script);
const storyPath = process.argv[3] || null;
if (!fs.existsSync(boardPath)) { console.error('用法：node tests/director.test.mjs [board.json] [story.md]'); process.exit(2); }

const board = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
const script = storyPath && fs.existsSync(storyPath)
  ? fs.readFileSync(storyPath, 'utf8')
  : (board.story?.source || '');
const scriptLines = script ? script.split(/\r?\n/) : [];

console.log('\n导演简报');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const brief = readBrief(repoRoot);
check('同时装入职业简报', brief.includes('# 你是这部剧的导演'));
check('同时装入输出 schema', brief.includes('# 导演交什么 —— 格式与含义'));
check('schema 当前版本进入 prompt', brief.includes(`"version": ${MIN_DIRECTION_VERSION}`));
const prompt = buildBrief({ briefText: brief, board, script, projectRoot: repoRoot });
check('交付提示不再硬编码旧 v4', !prompt.includes('v4 格式'));

const missingSchemaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'story2video-brief-'));
try {
  const briefDir = path.join(missingSchemaRoot, 'references', 'director');
  fs.mkdirSync(briefDir, { recursive: true });
  fs.writeFileSync(path.join(briefDir, 'brief.md'), '# test brief\n');
  let missingSchemaError = null;
  try { readBrief(missingSchemaRoot); } catch (error) { missingSchemaError = error; }
  check('schema 缺失时立即报错', /找不到导演输出格式/.test(String(missingSchemaError?.message || '')));
} finally {
  fs.rmSync(missingSchemaRoot, { recursive: true, force: true });
}

console.log('\n台词识别');
const dlg = collectDialogueLines(board, scriptLines);
check('认出了台词行', dlg.size > 0, String(dlg.size));
check('每句都有原文', [...dlg.values()].every((t) => t && t.length > 1));
console.log(`       共 ${dlg.size} 句，行号 ${[...dlg.keys()].join(',')}`);

console.log('\n' + '─'.repeat(56));
if (failures.length) {
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项：`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log(`全部通过（${passed} 项）—— 简报与台词识别正常；导演稿质量由人工审阅把关`);
}
