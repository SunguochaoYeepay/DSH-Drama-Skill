#!/usr/bin/env node
/**
 * director.test.mjs — 「导演」这一步的验收。
 *
 * 校验器挡的是**技术错误**，不是创作。但有一条是死线：
 * **导演不许写台词原文** —— 台词要一字不差，而"生成文字"天生做不到一字不差。
 *
 * 所以这里的断言分两类：
 *   ① 结构/技术约束（≤15s、行号、人物引用、切词）
 *   ② **死线**：台词必须用行号指，原文一个字都不许出现在输出里
 *
 *   node tests/director.test.mjs <board.json> [story.md]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateDirection, collectDialogueLines, findDialogueLeak, buildBrief, readBrief,
  checkReverseFacing, CUT_PHRASES, FRAMINGS, MAX_UNIT_SECONDS, MIN_DIRECTION_VERSION,
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

// 造一份最小可用的"导演产出"脚手架
const IDS = (board.identities || []).map((x) => x.id);
const A = IDS[0] || 'a';
const B = IDS[1] || 'b';
const allLines = [...dlg.keys()];
function mkUnit(over = {}) {
  return {
    id: 'u1',
    shots: [{
      n: 1, at: 0, duration_s: 4, framing: '全景', camera: '固定',
      on_screen: [A].filter(Boolean), action: '两人走着', lines: allLines,
    }],
    ...over,
  };
}
function asCurrent(dir, { preserveLines = false } = {}) {
  if (!dir || typeof dir !== 'object') return dir;
  const current = structuredClone(dir);
  current.version = MIN_DIRECTION_VERSION;
  for (const [ui, unit] of (current.units || []).entries()) {
    unit.why ??= '测试所需的连续表演单元';
    unit.duration_reason ??= '按动作与停顿确定时长';
    unit.keyframe_start ??= '人物处于稳定起始状态';
    unit.boundary_trigger ??= ui === 0 ? 'opening' : 'identity_anchor';
    unit.keyframe_cast ??= [...new Set((unit.shots || []).flatMap((shot) => shot.on_screen || []))].slice(0, 2);
    unit.action_complexity ??= { level: 'low', strategy: 'none', high_risk_events: [] };
    unit.end_state ??= '角色停在稳定、可观察的结束状态';
    unit.continuity ??= ui === 0
      ? { mode: 'independent', reason: '开场' }
      : { mode: 'independent', reason: '测试单元独立开始' };
    for (const shot of unit.shots || []) {
      if (!preserveLines) shot.lines = [];
      shot.emotion_analysis ??= (shot.on_screen || []).map((character) => ({
        character,
        cause: '当前剧情事件',
        internal_state: '专注',
        visible_behavior: '身体保持稳定，注意前方',
        gaze: '看向当前目标',
        avoid_symbols: ['与剧情相反的夸张表情'],
      }));
    }
  }
  return current;
}
const coreBoard = { ...board, shots: [] };
const ok = (dir) => validateDirection(asCurrent(dir), { board: coreBoard, script: '' });
const dialogueOk = (dir) => validateDirection(asCurrent(dir, { preserveLines: true }), { board, script });

console.log('\n结构约束');
{
  const r = ok({ units: [mkUnit()] });
  check('一份齐全的设计通过', r.ok, r.errors.join(' | '));
}
check('空 units 被拒', !ok({ units: [] }).ok);
check('不是对象被拒', !ok(null).ok);
check('shots 为空被拒', !ok({ units: [{ id: 'u1', shots: [] }] }).ok);
check('缺 version 被拒', !validateDirection({ units: [mkUnit()] }, { board, script }).ok);
check('过低 version 被拒', !validateDirection({ version: MIN_DIRECTION_VERSION - 1, units: [mkUnit()] }, { board, script }).ok);

console.log('\nv2 导演分析契约');
{
  const v2ctx = {
    board: {
      identities: [{ id: A, character: 'c1' }],
      characters: [{ id: 'c1' }],
      shots: [{ source_lines: [1], dialogue: [{ text: '这是一句需要时间说完的测试台词。' }] }],
    },
    script: '这是一句需要时间说完的测试台词。',
  };
  const base = asCurrent({
    units: [{
      id: 'u1', why: '同一主体与构图', duration_reason: '按口播时间安排',
      boundary_trigger: 'opening',
      keyframe_cast: [A],
      keyframe_start: '人物闭口，准备说话',
      shots: [{ n: 1, at: 0, duration_s: 8, framing: '近景', camera: '固定', on_screen: [A], action: '人物准备说话', lines: [1] }],
    }],
  }, { preserveLines: true });
  check('v2 分析字段齐全且台词时间充足 → 通过', validateDirection(base, v2ctx).ok,
    validateDirection(base, v2ctx).errors.join(' | '));
  const missingAnalysis = structuredClone(base);
  delete missingAnalysis.units[0].duration_reason;
  check('v2 缺时长分析 → 拒绝', !validateDirection(missingAnalysis, v2ctx).ok);
  const tooShort = structuredClone(base);
  tooShort.units[0].shots[0].duration_s = 1;
  const shortResult = validateDirection(tooShort, v2ctx);
  check('v2 台词说不完 → 拒绝', !shortResult.ok && shortResult.errors.some((e) => /最低需要/.test(e)), shortResult.errors.join(' | '));
  const fakeBoundary = structuredClone(base);
  fakeBoundary.units.push({ ...structuredClone(base.units[0]), id: 'u2', boundary_trigger: '节奏需要' });
  fakeBoundary.units[1].shots[0].lines = [];
  check('v3 不接受“节奏需要”作为新关键帧理由', !validateDirection(fakeBoundary, v2ctx).ok);
}

console.log('\n交付时长预算');
{
  const durationCtx = {
    board: { identities: [{ id: A, character: 'c1' }], characters: [{ id: 'c1' }], shots: [], meta: { total_duration_s: 10 } },
    script: '',
  };
  const bloated = asCurrent({
    units: Array.from({ length: 3 }, (_, i) => ({
      id: `u${i + 1}`,
      why: '测试', duration_reason: '两秒动作', keyframe_start: '人物静止',
      boundary_trigger: i === 0 ? 'opening' : 'identity_anchor',
      keyframe_cast: [A],
      shots: [{ n: 1, at: 0, duration_s: 2, framing: '近景', camera: '固定', on_screen: [A], action: '短动作', lines: [] }],
    })),
  });
  const result = validateDirection(bloated, durationCtx);
  check('多个短单元导致预计交付时长膨胀 → 拒绝', !result.ok && result.errors.some((e) => /预计交付时长/.test(e)), result.errors.join(' | '));
}

console.log('\nv4 H3 动作复杂度');
{
  const ctx = {
    board: { identities: [{ id: A, character: 'c1' }], characters: [{ id: 'c1' }], shots: [], meta: { total_duration_s: 12 } },
    script: '',
  };
  const base = asCurrent({
    units: [{
      id: 'u1', why: '同一空间连续表演', duration_reason: '动作需要六秒', keyframe_start: '人物尚未接触',
      boundary_trigger: 'opening', keyframe_cast: [A],
      action_complexity: { level: 'medium', strategy: 'single_transition', high_risk_events: [
        { at_s: 3, type: 'multi_actor_contact', description: '人物抓住目标' },
      ] },
      shots: [{ n: 1, at: 0, duration_s: 6, framing: '中景', camera: '固定', on_screen: [A], action: '人物抓住目标', lines: [] }],
    }],
  });
  check('v4 单个高风险状态转换 → 通过', validateDirection(base, ctx).ok,
    validateDirection(base, ctx).errors.join(' | '));
  const missing = structuredClone(base);
  delete missing.units[0].action_complexity;
  check('v4 缺动作复杂度分析 → 拒绝', !validateDirection(missing, ctx).ok);
  const overloaded = structuredClone(base);
  overloaded.units[0].action_complexity.high_risk_events.push({
    at_s: 5, type: 'appearance_or_disappearance', description: '目标消失',
  });
  check('同一单元两个高风险状态转换 → 拒绝',
    !validateDirection(overloaded, ctx).ok
      && validateDirection(overloaded, ctx).errors.some((e) => /只允许一个/.test(e)));
  const outOfRange = structuredClone(base);
  outOfRange.units[0].action_complexity.high_risk_events[0].at_s = 9;
  check('状态转换时间超过单元时长 → 拒绝', !validateDirection(outOfRange, ctx).ok);
  const noRisk = structuredClone(base);
  noRisk.units[0].action_complexity = { level: 'low', strategy: 'none', high_risk_events: [] };
  check('无高风险转换使用 none → 通过', validateDirection(noRisk, ctx).ok,
    validateDirection(noRisk, ctx).errors.join(' | '));
}

console.log('\nv6 客观情绪与连续性分析');
{
  const ctx = {
    board: { identities: [{ id: A, character: 'c1' }], characters: [{ id: 'c1' }], shots: [], meta: { total_duration_s: 6 } },
    script: '',
  };
  const emotion = {
    version: MIN_DIRECTION_VERSION,
    units: [{
      id: 'u1', why: '同一表演', duration_reason: '动作六秒', keyframe_start: '人物站定',
      boundary_trigger: 'opening', keyframe_cast: [A],
      action_complexity: { level: 'low', strategy: 'none', high_risk_events: [] },
      end_state: '人物保持站立并看向声源', continuity: { mode: 'independent', reason: '开场' },
      shots: [{
        n: 1, at: 0, duration_s: 6, framing: '中景', camera: '固定', on_screen: [A], action: '人物观察前方', lines: [],
        emotion_analysis: [{ character: A, cause: '听见异响', internal_state: '警觉', visible_behavior: '肩背收紧，眼睛睁大', gaze: '看向声源', avoid_symbols: ['微笑'] }],
      }],
    }],
  };
  check('v5 完整情绪因果链通过', validateDirection(emotion, ctx).ok, validateDirection(emotion, ctx).errors.join(' | '));
  const missing = structuredClone(emotion); delete missing.units[0].shots[0].emotion_analysis;
  check('v5 缺 emotion_analysis 被拒', !validateDirection(missing, ctx).ok);
  const emptyAvoid = structuredClone(emotion); emptyAvoid.units[0].shots[0].emotion_analysis[0].avoid_symbols = [];
  check('v5 缺禁止误读符号被拒', !validateDirection(emptyAvoid, ctx).ok);
  const continuation = structuredClone(emotion);
  continuation.units.push({ ...structuredClone(continuation.units[0]), id: 'u2', boundary_trigger: 'state_transition_anchor',
    continuity: { mode: 'continue_previous', previous_unit: 'u1', handoff_state: '继承站立姿态', deferred_keyframe: true, allowed_changes: ['framing'] } });
  check('v6 连续单元声明完整可通过', validateDirection(continuation, { ...ctx, board: { ...ctx.board, meta: { total_duration_s: 12 } } }).ok,
    validateDirection(continuation, { ...ctx, board: { ...ctx.board, meta: { total_duration_s: 12 } } }).errors.join(' | '));
  const premature = structuredClone(continuation); premature.units[1].continuity.deferred_keyframe = false;
  check('v6 连续单元禁止提前锁死关键帧', !validateDirection(premature, { ...ctx, board: { ...ctx.board, meta: { total_duration_s: 12 } } }).ok);
}

console.log(`\n${MAX_UNIT_SECONDS}s 上限`);
check('单镜 18s 被拒', !ok({ units: [{ id: 'u1', shots: [{ n: 1, at: 0, duration_s: 18, framing: '全景', camera: '固定', on_screen: [A], action: 'x', lines: allLines }] }] }).ok);
check('单镜刚好 15s 通过', ok({ units: [{ id: 'u1', shots: [{ n: 1, at: 0, duration_s: 15, framing: '全景', camera: '固定', on_screen: [A], action: 'x', lines: allLines }] }] }).ok);
check('贴上限会给警告', ok({ units: [{ id: 'u1', shots: [{ n: 1, at: 0, duration_s: 14.9, framing: '全景', camera: '固定', on_screen: [A], action: 'x', lines: allLines }] }] }).warnings.some((w) => /15s/.test(w)));
check('多镜累计超 15s 被拒', !ok({ units: [{ id: 'u1', shots: [
  { n: 1, at: 0, duration_s: 9, framing: '全景', camera: '固定', on_screen: [A], action: 'a' },
  { n: 2, at: 9, duration_s: 8, cut: CUT_PHRASES[0], framing: '近景', camera: '固定', on_screen: [A], action: 'b', lines: allLines },
] }] }).ok);

console.log('\nat / n 的顺序');
check('第 1 镜 at 不是 0 被拒', !ok({ units: [{ id: 'u1', shots: [{ n: 1, at: 1, duration_s: 4, framing: '全景', camera: '固定', on_screen: [A], action: 'x', lines: allLines }] }] }).ok);
check('at 不递增被拒', !ok({ units: [{ id: 'u1', shots: [
  { n: 1, at: 5, duration_s: 5, framing: '全景', camera: '固定', on_screen: [A], action: 'a' },
  { n: 2, at: 3, duration_s: 3, cut: CUT_PHRASES[0], framing: '近景', camera: '固定', on_screen: [A], action: 'b', lines: allLines },
] }] }).ok);
check('n 跳号被拒', !ok({ units: [{ id: 'u1', shots: [{ n: 3, at: 0, duration_s: 4, framing: '全景', camera: '固定', on_screen: [A], action: 'x', lines: allLines }] }] }).ok);

console.log('\n枚举与引用');
check('景别不在枚举里被拒', !ok({ units: [{ id: 'u1', shots: [{ n: 1, at: 0, duration_s: 4, framing: '大特写', camera: '固定', on_screen: [A], action: 'x', lines: allLines }] }] }).ok);
check(`景别枚举是 ${FRAMINGS.join('/')}`, FRAMINGS.length === 5);
check('on_screen 引用不存在的人被拒', !ok({ units: [{ id: 'u1', shots: [{ n: 1, at: 0, duration_s: 4, framing: '全景', camera: '固定', on_screen: ['c_does_not_exist'], action: 'x', lines: allLines }] }] }).ok);
check('缺 camera（运镜）被拒', !ok({ units: [{ id: 'u1', shots: [{ n: 1, at: 0, duration_s: 4, framing: '全景', on_screen: [A], action: 'x', lines: allLines }] }] }).ok);
check('缺 action 被拒', !ok({ units: [{ id: 'u1', shots: [{ n: 1, at: 0, duration_s: 4, framing: '全景', camera: '固定', on_screen: [A], lines: allLines }] }] }).ok);
check('不正的切词被拒', !ok({ units: [{ id: 'u1', shots: [
  { n: 1, at: 0, duration_s: 5, framing: '全景', camera: '固定', on_screen: [A], action: 'a' },
  { n: 2, at: 5, duration_s: 3, cut: 'then it jumps', framing: '近景', camera: '固定', on_screen: [A], action: 'b', lines: allLines },
] }] }).ok);
check('合法切词都通过', CUT_PHRASES.every((c) => ok({ units: [{ id: 'u1', shots: [
  { n: 1, at: 0, duration_s: 5, framing: '全景', camera: '固定', on_screen: [A], action: 'a' },
  { n: 2, at: 5, duration_s: 3, cut: c, framing: '近景', camera: '固定', on_screen: [A], action: 'b', lines: allLines },
] }] }).ok));

console.log('\n台词：一条不漏、一条不重');
{
  const only1 = { units: [{ id: 'u1', shots: [{ n: 1, at: 0, duration_s: 5, framing: '全景', camera: '固定', on_screen: [A], action: 'x', lines: [allLines[0]] }] }] };
  const r = dialogueOk(only1);
  check('漏台词被拒', !r.ok && r.errors.some((e) => /漏了/.test(e)), r.errors.join(' | '));
}
{
  const dup = { units: [{ id: 'u1', shots: [
    { n: 1, at: 0, duration_s: 5, framing: '全景', camera: '固定', on_screen: [A], action: 'a', lines: [allLines[0]] },
    { n: 2, at: 5, duration_s: 3, cut: CUT_PHRASES[0], framing: '近景', camera: '固定', on_screen: [A], action: 'b', lines: allLines },
  ] }] };
  const r = dialogueOk(dup);
  check('台词重复放被拒', !r.ok && r.errors.some((e) => /放了多次/.test(e)), r.errors.join(' | '));
}
const nonDialogueLine = Array.from({ length: Math.max(scriptLines.length, 1) + 1 }, (_, i) => i + 1)
  .find((line) => !dlg.has(line));
check('引用非台词行被拒', dialogueOk({ units: [{ id: 'u1', shots: [{ n: 1, at: 0, duration_s: 4, framing: '全景', camera: '固定', on_screen: [A], action: 'x', lines: [nonDialogueLine] }] }] }).errors.some((e) => /不是台词行/.test(e)));

console.log('\n⛔ 死线：导演不许写台词原文');
{
  const sample = [...dlg.entries()].find(([, t]) => t.length >= 6);
  if (sample) {
    const [ln, text] = sample;
    const leak = { units: [{ id: 'u1', shots: [{
      n: 1, at: 0, duration_s: 4, framing: '近景', camera: '固定', on_screen: [A],
      action: `她说：${text}`, lines: [ln],
    }] }] };
    const r = dialogueOk(leak);
    check('**台词原文出现在 action 里 → 报错**', !r.ok && r.errors.some((e) => /死线/.test(e)), r.errors.join(' | '));
    check('  报错里点明了是第几行', r.errors.some((e) => e.includes(String(ln))));
  } else {
    check('（剧本里没有够长的台词可测）', true);
  }
  // 藏在字段名里也不行
  const hidden = { units: [{ id: 'u1', note: '这一镜是高潮', shots: [{
    n: 1, at: 0, duration_s: 4, framing: '近景', camera: '固定', on_screen: [A], action: '她看着他', lines: allLines,
  }] }] };
  const hiddenResult = dialogueOk(hidden);
  check('自己写的注释不算台词泄漏', !hiddenResult.errors.some((e) => /死线/.test(e)), hiddenResult.errors.join(' | '));
}
{
  const fake = new Map([[1, '这是一句够长的假台词用来测试']]);
  check('findDialogueLeak 能定位', findDialogueLeak({ a: '她说：这是一句够长的假台词用来测试' }, fake).length === 1);
  check('findDialogueLeak 对短台词不误报', findDialogueLeak({ a: '好。' }, new Map([[1, '好。']])).length === 0);
}

console.log('\n正反打朝向（180 度线，只警告）');
// **这里曾经写反过**：第一版警告「同一个人连续两镜朝同一边」，
// 结果拿导演的真实产出跑，报了 5 次错 —— 而导演是对的，校验器是错的。
// 对话戏的正反打就是「她永远朝右、他永远朝左」，那正是 180 度线正确的形态。
{
  // 正反打正确形态：**每镜一个人**，她朝右、他朝左 —— 不该警告
  const good = checkReverseFacing({ units: [{ id: 'u1', shots: [
    { n: 1, facing: { [A]: 'right' } },
    { n: 2, facing: { [B]: 'left' } },
  ] }] });
  check('她朝右 / 他朝左（各一镜）→ 不警告（这是对的）', good.length === 0, JSON.stringify(good));

  // 两人同框却互相朝对方，下一镜两人同框却调换了方向 = 机位翻轴
  const axisFlip = checkReverseFacing({ units: [{ id: 'u1', shots: [
    { n: 1, facing: { [A]: 'right', [B]: 'left' } },
    { n: 2, facing: { [A]: 'left', [B]: 'right' } },
  ] }] });
  check('两人同框却整体翻轴 → 警告', axisFlip.length > 0, JSON.stringify(axisFlip));

  // 同一个人的同一朝向跨镜（正反打里必然发生）—— **也不该警告**
  const samePerson = checkReverseFacing({ units: [{ id: 'u1', shots: [
    { n: 1, facing: { [A]: 'right' } },
    { n: 2, facing: { [A]: 'right' } },
  ] }] });
  check('同一个人连续两镜同向 → 不警告（正反打就是这样）', samePerson.length === 0, JSON.stringify(samePerson));

  // 真正的问题：**两个人**都朝同一边
  const bad = checkReverseFacing({ units: [{ id: 'u1', shots: [
    { n: 1, facing: { [A]: 'right' } },
    { n: 2, facing: { [B]: 'right' } },
  ] }] });
  check('**两个人**都朝同一边 → 警告', bad.length === 1, JSON.stringify(bad));
  check('  警告里点出两个人', bad.length === 1 && bad[0].includes(A) && bad[0].includes(B), bad[0]);

  // toward / away 不参与左右判断
  const towardAway = checkReverseFacing({ units: [{ id: 'u1', shots: [
    { n: 1, facing: { [A]: 'toward' } },
    { n: 2, facing: { [B]: 'toward' } },
  ] }] });
  check('两人都 toward → 不警告（不是左右问题）', towardAway.length === 0, JSON.stringify(towardAway));

  check('朝向检查不阻断（只是警告）', (() => {
    const r2 = ok({ units: [{ id: 'u1', shots: [
      { n: 1, at: 0, duration_s: 5, framing: '近景', camera: '固定', on_screen: [A, B].filter(Boolean), action: 'a', facing: { [A]: 'right' } },
      { n: 2, at: 5, duration_s: 3, cut: CUT_PHRASES[0], framing: '近景', camera: '固定', on_screen: [A, B].filter(Boolean), action: 'b', lines: allLines, facing: { [B]: 'right' } },
    ] }] }, {});
    return r2.ok && r2.warnings.some((w) => /朝 right/.test(w));
  })());
}

console.log('\n场景与道具引用');
{
  const ctx = {
    board: {
      identities: [{ id: A, character: 'c1' }], characters: [{ id: 'c1' }],
      scenes: [{ id: 'hall' }, { id: 'garden' }], props: [{ id: 'key' }], shots: [],
    },
    script: '',
  };
  const make = (extra = {}) => asCurrent({ units: [{ id: 'u1', shots: [{
    n: 1, at: 0, duration_s: 4, framing: '中景', camera: '固定',
    on_screen: [A], action: '人物站定', lines: [], ...extra,
  }] }] });
  check('多场景项目不写 scene → 拒绝', !validateDirection(make(), ctx).ok);
  check('不存在的 scene → 拒绝', !validateDirection(make({ scene: 'missing', props: [] }), ctx).ok);
  check('不存在的 prop → 拒绝', !validateDirection(make({ scene: 'hall', props: ['missing'] }), ctx).ok);
  check('合法 scene / props → 通过', validateDirection(make({ scene: 'hall', props: ['key'] }), ctx).ok,
    validateDirection(make({ scene: 'hall', props: ['key'] }), ctx).errors.join(' | '));
}

console.log('\n' + '─'.repeat(56));
if (failures.length) {
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项：`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log(`全部通过（${passed} 项）—— 导演可以自由创作，但越界会被拦下，台词碰不得`);
}
