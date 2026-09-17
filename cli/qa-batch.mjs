/**
 * 一次质检一批关键帧：带上"它应该是什么"，逐张跑。
 *
 * 为什么要这个驱动（两条，都不是顺带的）：
 *
 * 1. **PowerShell 5.1 会把 UTF-8 的 .ps1 读成 GBK**，中文提示词全烂。
 *    Node 永远按 UTF-8 读文件 —— 所以编排放 Node 里。
 * 2. **判据必须从"生成它的那个字段"来。** 关键帧是照 `unit.keyframe_start`
 *    生成的（见 `cli/keyframes.mjs`），拿 `shots[0].action` 当"应该是什么"
 *    会造出**假失败**（实测：质检报「女性未按指令搭栏杆」，而 `keyframe_start`
 *    里根本没这句）。
 *
 * ## 身份判据要能成立
 *
 * 「这张脸是定妆照里那个人吗」——只发一张图，模型**必然**答"拿不准"，
 * 于是结构上永远 ✗。所以这里把**定妆照和待检画面拼成一张并排图**再发：
 * 左边是基准，右边是待检。没有定妆照可比时，判据降级成"如实描述脸的特征"，
 * 而不是留一个必然失败的问法。
 *
 * 用法：node cli/qa-batch.mjs <direction.json> <keyframes-dir> [--stage keyframes]
 *   `keyframes-dir` 可以是计划槽位目录（`keyframes_render/`），也可以是通道草稿区。
 *   `board.json` 若与 direction 同目录则自动读取，用来取定妆照。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { look, verdictOf, STAGE_FOCUS, STAGE_CONTEXT } from '../src/qa.mjs';
import { FFMPEG } from '../src/runtime-paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const DJ = argv.find((value) => /\.json$/i.test(value) && !value.startsWith('--'));
const KF = argv.find((value) => value !== DJ && !value.startsWith('--'));
const stageAt = argv.indexOf('--stage');
const stage = stageAt >= 0 ? argv[stageAt + 1] : 'keyframes';
if (!DJ || !KF) {
  console.error('用法：node cli/qa-batch.mjs <direction.json> <keyframes-dir> [--stage keyframes]');
  process.exit(2);
}
const DIRECTION = path.resolve(DJ);
const KEYFRAMES = path.resolve(KF);
const PROJ = path.dirname(DIRECTION);

/** 定妆照作基准需要 board；没有就降级判据，不要硬问一个答不了的问题。 */
const boardPath = path.join(PROJ, 'board.json');
const board = fs.existsSync(boardPath) ? JSON.parse(fs.readFileSync(boardPath, 'utf8')) : null;

/** 景别 → 硬判据（写死，免得模型自己理解）。 */
const FRAMING_RULE = {
  远景: '远景：环境占绝大部分，人物很小，看不清脸',
  全景: '全景：能看到完整的人（头顶到脚）加上周围环境',
  中景: '中景：画面下边界切在**腰部**，头顶到腰部都在画面内；**不允许出现大腿，也不允许只到胸口**',
  近景: '近景：**只取胸部以上**，不出现腰部；脸清楚但能看到肩膀',
  特写: '特写：**只有脸**，头部占满画面，不出现肩膀以下',
};

const dir = JSON.parse(fs.readFileSync(DIRECTION, 'utf8'));
const files = fs.readdirSync(KEYFRAMES).filter((f) => /\.png$/i.test(f)).sort();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-kf-'));

// ------------------------------------------------------------ 并排对照图

/**
 * 该单元首帧里出现的人 → 比对基准图。
 *
 * **两类基准不能混**（混过，造出假失败）：
 * - 脸 → **肖像**（`characters[].portrait`）。配方故意让它"只穿素色上衣、不出现任何服装细节"，
 *   所以它**只有脸的信息**，拿它比服装必然判"不一致"。
 * - 服装 → **造型设定图**（`identities[].sheet`）。那才是这套造型的唯一定义。
 *
 * 返回 [{file, label}]，顺序即拼图顺序。
 */
function referenceImages(unit) {
  const cast = (unit.keyframe_cast && unit.keyframe_cast.length ? unit.keyframe_cast : null)
    || (unit.shots[0] && unit.shots[0].on_screen)
    || [];
  const people = [];
  for (const id of cast) {
    const identity = (board.identities || []).find((x) => x.id === id);
    const character = identity
      ? (board.characters || []).find((c) => c.id === identity.character)
      : (board.characters || []).find((c) => c.id === id);
    if (!character) continue;
    people.push({ name: character.name || id, portrait: character.portrait, sheet: identity && identity.sheet });
    if (people.length >= 2) break;
  }
  const out = [];
  const push = (rel, label) => {
    if (!rel) return;
    const file = path.resolve(PROJ, rel);
    if (fs.existsSync(file)) out.push({ file, label });
  };
  for (const p of people) push(p.portrait, `定妆照·只用来对脸（${p.name}）`);
  const withSheet = people.find((p) => p.sheet);
  if (withSheet) push(withSheet.sheet, `造型设定图·只用来对服装（${withSheet.name}）`);
  return out;
}

/** 把参考图拼在待检画面左边 —— 视觉模型只有看到两张，才比得了"是不是同一个人"。 */
function stackForVision(refs, target, outFile) {
  const chain = [
    ...refs.map((_, i) => `[${i}:v]scale=-1:720[r${i}]`),
    `[${refs.length}:v]scale=-1:720[t]`,
  ].join(';');
  const stackIn = [...refs.map((_, i) => `[r${i}]`), '[t]'].join('');
  const args = ['-y', '-loglevel', 'error'];
  for (const ref of [...refs, target]) args.push('-i', ref);
  args.push(
    '-filter_complex', `${chain};${stackIn}hstack=inputs=${refs.length + 1}[out]`,
    '-map', '[out]', outFile,
  );
  const r = spawnSync(FFMPEG, args, { encoding: 'utf8', timeout: 60000, windowsHide: true });
  return r.status === 0 && fs.existsSync(outFile);
}

// ------------------------------------------------------------ 逐张

console.log(`\n【质检：${stage}】共 ${files.length} 张`);
console.log(STAGE_CONTEXT[stage] || '');
console.log('─'.repeat(70));

const results = [];
for (const f of files) {
  const id = path.basename(f, '.png');
  const u = dir.units.find((x) => x.id === id);
  const shot = u && u.shots[0];
  // ⭐ 取"生成它的那个字段"（keyframes.mjs 用的是 keyframe_start），不是 shots[0].action
  const want = shot
    ? `它应该是【${shot.framing}】—— ${FRAMING_RULE[shot.framing] || shot.framing}。`
      + `动作起点：${u.keyframe_start || shot.action}。`
      + `光：${shot.lighting || '（未指定）'}`
    : '';

  const refs = u && board ? referenceImages(u) : [];
  let focus = [...(STAGE_FOCUS[stage] || [])];
  let usedStack = false;
  let subject = path.join(KEYFRAMES, f);
  let stackNote = '';

  if (refs.length) {
    const stacked = path.join(tmpDir, `${id}_vs_ref.png`);
    if (stackForVision(refs.map((r) => r.file), subject, stacked)) {
      subject = stacked;
      usedStack = true;
      stackNote = `**这张图是并排拼接的**：从左到右依次是 ${refs.map((r, i) => `第${i + 1}格=${r.label}`).join('、')}、`
        + `**最后一格=待检画面**。请只在最后一格里判景别、构图、文字和崩坏。`;
      const face = focus.findIndex((line) => line.includes('【人物】'));
      if (face >= 0) {
        focus[face] = '【人物 ⭐】把**最后一格**的脸和「定妆照·对脸」那几格逐项对：脸型、五官、发型、年龄段'
          + '是不是**同一个人**（不是"像"，是"是"）？**明确说同/不同，不要答"拿不准"。**';
      }
      const cloth = focus.findIndex((line) => line.includes('【服装】'));
      if (cloth >= 0) {
        focus[cloth] = '【服装】把**最后一格**的服装和「造型设定图·对服装」那一格比：颜色、层数、款式一致吗？'
          + '**不要拿定妆照比服装** —— 定妆照故意不带服装信息，比出来的"不一致"是假的。';
      }
    }
  }
  if (!usedStack) {
    const face = focus.findIndex((line) => line.includes('【人物】'));
    if (face >= 0) {
      focus[face] = '【人物】如实描述这张脸的特征：年龄段、脸型、发型、五官特点。'
        + '**不要回答"无法与定妆照比对"** —— 这里没有基准图，只描述你实际看到的。';
    }
  }

  process.stderr.write(`  看 ${f} … `);
  const extra = [want, stackNote].filter(Boolean).join('\n');
  const r = look(subject, { focus, extra });
  if (!r.ok) { console.log('✗ 看不了'); results.push({ id, pass: false, why: r.text }); continue; }
  const v = verdictOf(r.text);
  console.log(v.pass === true ? '✓' : v.pass === false ? '✗' : '?');
  results.push({ id, pass: v.pass, why: v.why, text: r.text, stacked: usedStack, refs: refs.length });
}

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 无所谓 */ }

console.log('─'.repeat(70));
for (const x of results) {
  const m = x.pass === true ? '✓' : x.pass === false ? '✗' : '?';
  const tag = x.refs ? `（含 ${x.refs} 张定妆照对照）` : '（无基准图，身份只作描述）';
  console.log(`  ${m} ${x.id}　${x.why || ''}${x.pass === true ? '' : ''}　${tag}`);
}
const bad = results.filter((x) => x.pass !== true);
console.log('');
if (bad.length) {
  console.log(`  结论：**${bad.length}/${results.length} 张有问题，不建议往下走。**\n`);
  for (const x of bad) {
    console.log(`  ── ${x.id} ──`);
    console.log(String(x.text).split('\n').map((l) => '    ' + l).join('\n'));
    console.log('');
  }
} else {
  console.log(`  结论：全部通过（${results.length} 张）。`);
  console.log('  ⚠ **通过 ≠ 可以往下走。通过 = 可以问用户了。**');
  console.log('  → 现在可以问：这批关键帧 OK 吗？');
}
