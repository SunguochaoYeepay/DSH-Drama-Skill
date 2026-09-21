/**
 * 关键帧提示词的 LLM 直写制行为测试（2026-09-21 工程拼装退役后）。
 *
 * ## 现在守什么
 *
 * 工程拼装（buildLocalPrompt / refinePrompt / 构图覆盖）已删，提示词来源只有一个：
 * `<项目>/keyframe-prompts/<unit-id>.txt`，LLM 按 references/draw-specialist.md 直写。
 * 本文件用**真的跑 `cli/keyframes.mjs --dry-run`** 断言以下行为：
 *   1. 直写文件**逐字**送模型（含会被工程版"修掉"的措辞也原样保留——不再有删减）；
 *   2. 缺文件硬报错，报错里列出参考图编号表（写提示词的人照着就能写）；
 *   3. 机器审计（auditPrompt）跑在直写文件上：违规要报告，但不阻断（只报告不拦截）；
 *   4. 参考图表与真正挂载的图同源：本地通道图1=场景主图在前、身份图在后。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');

const PROMPT_TEXT = [
  '9:16 竖幅全景：女孩从头顶到脚底完整入画，坐在床边。',
  '图1是场景参考，只参考环境、光线和色调；图2是女孩的身份参考，严格保持此人的脸、发型和服装。',
  '画面中不要出现文字、字幕、水印。',
].join('\n');

/** 造一个能跑通干跑的最小项目：板子 + 编译计划（可选：直写提示词文件）。 */
function makeProject({ withPrompt = true, promptText = PROMPT_TEXT } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-keyframe-llm-'));
  const master = path.join(dir, 'room_master.png');
  const sheet = path.join(dir, 'girl_sheet.png');
  fs.writeFileSync(master, 'stub');
  fs.writeFileSync(sheet, 'stub');
  fs.writeFileSync(path.join(dir, 'board.json'), JSON.stringify({
    meta: { project: 'keyframe-llm', aspect: '9:16', style_prompt: '暖色调绘本风格' },
    characters: [{ id: 'c_girl', name: '女孩', face_prompt: '圆脸', portrait: sheet }],
    identities: [{ id: 'i_girl', character: 'c_girl', appearance_details: '白裙', sheet }],
    scenes: [{ id: 's_room', name: '卧室', master }],
    props: [],
  }));
  fs.writeFileSync(path.join(dir, 'render.plan.json'), JSON.stringify({
    units: [{
      id: 'g001',
      keyframe_start: '0秒时：女孩坐在床边',
      shots: [{ framing: '中景', action: '女孩坐在床边', scene: 's_room', on_screen: ['i_girl'] }],
    }],
  }));
  if (withPrompt) {
    fs.mkdirSync(path.join(dir, 'keyframe-prompts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'keyframe-prompts', 'g001.txt'), promptText, 'utf8');
  }
  return dir;
}

function runCli(dir) {
  return spawnSync(process.execPath, [
    path.join(root, 'cli', 'keyframes.mjs'),
    path.join(dir, 'board.json'),
    '--direction', path.join(dir, 'render.plan.json'),
    '--units', 'g001',
    '--dry-run',
    '--skip-gate',
  ], { encoding: 'utf8' });
}

test('直写文件逐字送模型：不做任何拼装、删减或改写', () => {
  const out = runCli(makeProject());
  assert.equal(out.status, 0, `干跑应成功：${out.stderr}`);
  for (const line of PROMPT_TEXT.split('\n')) {
    assert.ok(out.stdout.includes(line), `直写行应原样出现在输出里：${line}`);
  }
});

test('直写制下没有"工程版/删减留档"的痕迹', () => {
  const out = runCli(makeProject());
  // 这些是工程拼装链的输出标记，退役后一个都不该再出现
  assert.doesNotMatch(out.stdout, /工程版（审计用/);
  assert.doesNotMatch(out.stdout, /抽卡师删掉/);
  assert.doesNotMatch(out.stdout, /【抽卡师｜执行层执行编译】/);
  assert.doesNotMatch(out.stdout, /构图要求：/);
});

test('缺直写文件硬报错：报错里带参考图编号表，够照着写提示词', () => {
  const out = runCli(makeProject({ withPrompt: false }));
  assert.notEqual(out.status, 0, '缺文件必须失败，不能静默回退工程拼装');
  const err = String(out.stderr) + String(out.stdout);
  assert.match(err, /keyframe-prompts\/g001\.txt/);
  assert.match(err, /draw-specialist\.md/);
  // 参考图编号表：本地通道图1=场景主图、图2=身份图
  assert.match(err, /图1=场景参考/);
  assert.match(err, /图2=人物身份参考/);
});

test('机器审计跑在直写文件上：违规要报告，但不阻断', () => {
  // 「不要出现」是第八类之前的否定句式（负例词），auditPrompt 应报出来；
  // 但按废机器审核的边界，它只报告，干跑仍应成功。
  const dirty = '女孩坐在床边，不要出现窗户。图1是场景参考；图2是女孩的身份参考。';
  const out = runCli(makeProject({ promptText: dirty }));
  assert.equal(out.status, 0, '审计只报告不阻断，干跑应仍成功');
  assert.match(out.stdout, /提示词自检/);
});

test('参考图表与挂载图片同源：场景主图在前当图1（本地通道）', () => {
  const out = runCli(makeProject());
  assert.match(out.stdout, /参考图 2 张：图1=场景参考（环境、光线、色调） room_master\.png；图2=人物身份参考（脸、发型、服装） girl_sheet\.png/);
  // argv 里的 --image 顺序必须与编号一致（图1=场景基底）
  const argvLine = out.stdout.split('\n').find((l) => l.includes('gen.py argv'));
  assert.ok(argvLine, '应打印实际下发的 argv');
  const images = [...argvLine.matchAll(/--image (\S+)/g)].map((m) => m[1]);
  assert.equal(images.length, 2);
  assert.ok(images[0].endsWith('room_master.png'), '图1 应是场景主图');
  assert.ok(images[1].endsWith('girl_sheet.png'), '图2 应是身份图');
});
