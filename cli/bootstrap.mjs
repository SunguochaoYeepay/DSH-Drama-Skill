#!/usr/bin/env node
/**
 * bootstrap.mjs — 一台机器上「这套东西能不能跑」的一键验收。
 *
 * ## 为什么要有它
 *
 * 之前"新机器能不能跑"要人自己拼：`npm run doctor` 看依赖、翻 README 找示例剧目、
 * 再想起来跑一遍 `npm test` 才知道契约链对不对得上。三步里漏任何一步，都会在
 * 真正出图那天才暴露 —— 而那天已经烧了时间和卡。
 *
 * 所以收成一个命令，按"从下往上"的顺序验三层，**全程不烧卡、不联网、不产出媒体**：
 *
 * 1. **依赖**：直接复用 `cli/doctor.mjs`（同一个所有者，不抄一份检查清单）；
 * 2. **示例剧目契约链**：`examples/demo-show/` 的文本链是否齐备且自洽（板子要过 `checkBoard`）；
 * 3. **确定性测试**：`tests/run-all.mjs`（这一步要 spawn，可选 —— 默认跑，`--no-tests` 跳过）。
 *
 * 用法：
 *   node cli/bootstrap.mjs           三层全验
 *   node cli/bootstrap.mjs --no-tests  只验依赖与示例链（几秒钟）
 *
 * 退出码：三层全过 = 0；任何一层不过 = 1。**失败信息留给 doctor / npm test 自己打印**，
 * 本文件不转述、不美化 —— 同一件事只该有一个所有者。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PROJECT_ROOT } from '../src/config.mjs';
import { checkBoard } from '../src/board.mjs';

const NO_TESTS = process.argv.includes('--no-tests');
const DEMO = path.join(PROJECT_ROOT, 'examples', 'demo-show');
const CLI_DIR = path.join(PROJECT_ROOT, 'cli');

function step(title) {
  console.log(`\n=== ${title} ===`);
}

/** 子进程输出直接透传给人看（不截获 —— 让它自己说人话）。 */
function run(script, args = []) {
  const target = path.isAbsolute(script) ? script : path.join(CLI_DIR, script);
  return spawnSync(process.execPath, [target, ...args], { stdio: 'inherit' });
}

const failures = [];

step('1/3 依赖自检（cli/doctor.mjs）');
const depsOk = run('doctor.mjs').status === 0;
if (!depsOk) failures.push('依赖：有必需项缺失（细节见上面 doctor 的输出）');

step('2/3 示例剧目契约链（examples/demo-show）');
const required = [
  'story.md',
  'story.provenance.json',
  'board.json',
  'board.direction.json',
  'render.plan.json',
  'keyframe-prompts',
];
const missing = required.filter((name) => !fs.existsSync(path.join(DEMO, name)));
if (missing.length) {
  console.log(`✗ 缺 ${missing.join('、')}`);
  failures.push(`示例剧目缺文件：${missing.join('、')}`);
} else {
  console.log('✓ 契约链文件齐备');
  const board = JSON.parse(fs.readFileSync(path.join(DEMO, 'board.json'), 'utf8'));
  const errors = checkBoard(board).errors;
  if (errors.length) {
    console.log(`✗ 板子有 ${errors.length} 处错误：\n  ${errors.join('\n  ')}`);
    failures.push('示例板子校验不过');
  } else {
    console.log('✓ 板子过校验');
  }
  const prompts = fs.readdirSync(path.join(DEMO, 'keyframe-prompts')).filter((f) => f.endsWith('.txt'));
  if (!prompts.length) {
    console.log('✗ 关键帧提示词目录是空的');
    failures.push('示例剧目没有关键帧提示词');
  } else {
    console.log(`✓ 关键帧提示词 ${prompts.length} 份：${prompts.join('、')}`);
  }
}

if (!NO_TESTS) {
  step('3/3 确定性测试（tests/run-all.mjs）');
  if (run(path.join(PROJECT_ROOT, 'tests', 'run-all.mjs')).status !== 0) {
    // 有些受限终端/沙箱连子进程管道都建不起来，测试会集体报"拿不到输出" ——
    // 那不是代码问题。结论里明说怎么复验，但不把这层记成"能开工"的否决项。
    failures.push(
      '确定性测试没过（细节见上面）：照输出修；若报错清一色是「拿不到子进程输出 / EBUSY」，' +
        '换普通终端单独跑 npm test 复验 —— 那是终端限制，不是代码',
    );
  }
} else {
  console.log('\n（--no-tests：跳过确定性测试）');
}

step('结论');
if (failures.length === 0) {
  console.log('三层全过 —— 这台机器可以开工。下一步：node cli/kanban.mjs 开看板，或照 SKILL.md 立项。');
  process.exit(0);
}
console.log(`有 ${failures.length} 处没过：`);
for (const f of failures) console.log(`  · ${f}`);
process.exit(1);
