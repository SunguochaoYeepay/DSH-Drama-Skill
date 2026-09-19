#!/usr/bin/env node
/**
 * unit.mjs — 把导演的**一个生成单元**编译成 H3 的多镜提示词，并出片。
 *
 * ## 为什么要多镜
 *
 * 官方指南 4.2 节：
 *
 *   [Shot 2] At 00:03.500, the camera cuts to...
 *
 * **一次生成里可以切很多刀**，而且人物长相、光线、声音**自动连续** ——
 * 因为它们本来就是同一段视频。
 *
 * 这比「尾帧接首帧（fl2v）」好：fl2v 要求两镜共享一个构图（景别被锁死），
 * 而多镜里怎么切都行。
 *
 * 所以：**同一段连续时空里的戏，合并成一次生成。**
 *
 * 用法：
 *   node cli/unit.mjs <board.json> --direction <render.plan.json> --unit g001 [--dry-run]
 *
 * 选项：
 *   --ws <dir>       工作区根
 *   --keyframe <png> 这一单元的首帧（不给就去找最接近的现有 keyframes/）
 *   --last-keyframe <png> 可选尾帧；FastH3 收到后走 fl2v，否则走 i2v
 *   --steps <n>      旧兼容参数；4/8/其他映射 draft/balanced/final，优先使用 --profile
 *   --quality <档位> normal=常规（默认）/ high=高质量；尺寸取自 .env
 *   --dry-run        只打印提示词，不生成
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { unitAssets } from '../src/asset-resolver.mjs';
import { clipResultPath, planKeyframeFiles, requireApproval, writeReviewNote } from '../src/human-gates.mjs';
import { buildUnitPrompt } from '../src/h3-prompt.mjs';
import { COMFY_GEN, COMFY_PYTHON } from '../src/runtime-paths.mjs';
import { installCliErrorHandler } from '../src/cli-errors.mjs';
import { requireHandoff } from '../src/continuity-handoff.mjs';
import { VIDEO_QUALITY, VIDEO_PROFILE, VIDEO_ATTENTION, VIDEO_NORMAL_SIZE, VIDEO_HIGH_SIZE, VIDEO_TIMEOUT_SECONDS } from '../src/config.mjs';
import { aspectOf, dimensionsForAspect } from '../src/aspect.mjs';

installCliErrorHandler();

const argv = process.argv.slice(2);
function flag(name, def) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) return true;
  return v;
}
const boardPath = argv.find((a) => /board.*\.json$/i.test(a) && !a.startsWith('--'));
const dirPath = flag('direction', null);
const unitId = flag('unit', null);
if (!boardPath || !dirPath || !unitId) {
  console.error('用法：node cli/unit.mjs <board.json> --direction <dir.json> --unit u1 [--dry-run]');
  process.exit(2);
}

const board = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
const dir = JSON.parse(fs.readFileSync(dirPath, 'utf8'));
const WS = flag('ws', null) || path.resolve(path.dirname(boardPath), '..', '..', '..');
const DRY = Boolean(flag('dry-run', false));
const EXPLICIT_STEPS = argv.includes('--steps') ? Number(flag('steps', 0)) : null;
/**
 * **尺寸跟着官方文档走，不要自己扫。**
 *
 * `comfy-studio/references/capabilities.md` 写得很清楚：H3 实测输出 **864×480**，
 * 而且每种模式的实测耗时都列好了（`--fast` 5 秒片：i2v 40.2s / fl2v 39.8s）。
 *
 * 9:16 的对应值是 **480×864**（0.41MP）。
 *
 * 我曾经绕开文档自己扫尺寸，挑了 1088×1920（2.09MP，5.2 倍像素）—— 结果是又慢又崩，
 * 还把"崩"归因到长度上。**"它接受"不等于"它该这么用"。**
 *
 * `--size 768x1344` 可以换到那个 LoRA 的原生 768p（验证通过之后再说）。
 */
const QUALITY = String(flag('quality', VIDEO_QUALITY)).toLowerCase();
if (argv.includes('--size')) throw new Error('视频尺寸由 .env 的 AIH_VIDEO_NORMAL_SIZE / AIH_VIDEO_HIGH_SIZE 配置；请用 --quality normal|high 选择');
const QUALITY_SIZES = { normal: VIDEO_NORMAL_SIZE, high: VIDEO_HIGH_SIZE };
if (!QUALITY_SIZES[QUALITY]) {
  throw new Error(`--quality 只能是 ${Object.keys(QUALITY_SIZES).join(' / ')}，收到 ${QUALITY}`);
}
const sizeArg = dimensionsForAspect(QUALITY_SIZES[QUALITY], aspectOf(board));
const [W, H] = sizeArg.split('x').map(Number);
if (!Number.isFinite(W) || !Number.isFinite(H) || W <= 0 || H <= 0) {
  throw new Error(`--size 必须是 WxH，收到 ${sizeArg}`);
}

const unit = (dir.units || []).find((u) => u.id === unitId);
if (!unit) { console.error(`找不到单元 ${unitId}`); process.exit(2); }
const projectDir = path.dirname(path.resolve(boardPath));
const continuityHandoff = requireHandoff(projectDir, unit);
const skipGate = argv.includes('--skip-gate');
const keyframes = planKeyframeFiles(projectDir, dir);
requireApproval(projectDir, 'keyframes', keyframes, { skip: skipGate });
const unitIndex = (dir.units || []).findIndex((u) => u.id === unitId);
if (unitIndex > 0) {
  const previous = dir.units[unitIndex - 1];
  const previousResult = clipResultPath(projectDir, previous.id);
  if (!previousResult) throw new Error(`上一段 ${previous.id} 尚未生成并确认`);
  const previousData = JSON.parse(fs.readFileSync(previousResult, 'utf8'));
  const previousFiles = (previousData.files || [])
    .map((file) => typeof file === 'string' ? file : file?.local_path || file?.localPath || file?.path)
    .filter((file) => file && fs.existsSync(file));
  requireApproval(projectDir, 'clip', previousFiles, { id: previous.id, skip: skipGate });
}

// ---------------------------------------------------------------- 台词原文（代码搬）

const scriptPath = path.join(path.dirname(boardPath), 'story.md');
const scriptLines = fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, 'utf8').split(/\r?\n/) : [];
/** 行号 → 台词原文 + 说话人（**从板子和剧本拿，不经过导演**）。 */
const lineText = new Map();
for (const s of board.shots || []) {
  for (const ln of s.source_lines || []) {
    for (const d of s.dialogue || []) {
      if (scriptLines[ln - 1] && scriptLines[ln - 1].includes(d.text)) {
        lineText.set(ln, { text: d.text, who: d.character, emotion: d.emotion, kind: d.kind });
      }
    }
  }
}

/** 造型 id → 中文名（写提示词时用名字，模型才认）。 */
const nameOf = (id) => {
  const it = (board.identities || []).find((x) => x.id === id);
  const ch = it && (board.characters || []).find((c) => c.id === it.character);
  return (ch && ch.name) || id;
};

// H3 提示词由 src/h3-prompt.mjs 唯一维护。

// ---------------------------------------------------------------- 首帧

function pickKeyframe() {
  const explicit = flag('keyframe', null);
  if (explicit) return path.resolve(WS, explicit);
  if (continuityHandoff?.keyframe) return continuityHandoff.keyframe;
  if (unit.keyframe) {
    const planned = path.resolve(path.dirname(boardPath), unit.keyframe);
    if (fs.existsSync(planned)) return planned;
  }
  const unitKeyframe = path.join(path.dirname(boardPath), 'keyframes_v2', `${unit.id}.png`);
  if (fs.existsSync(unitKeyframe)) return unitKeyframe;
  const kd = path.join(path.dirname(boardPath), 'keyframes');
  if (!fs.existsSync(kd)) return null;
  // 单元的第 1 镜景别最接近的那张现有关键帧
  const want = unit.shots[0].framing;
  const src = (board.shots || []).find((s) => s.shot_size === want && s.first_frame);
  if (src) {
    const p = path.resolve(WS, src.first_frame);
    if (fs.existsSync(p)) return p;
  }
  // 兜底：第一张
  const first = (board.shots || []).find((s) => s.first_frame);
  return first ? path.resolve(WS, first.first_frame) : null;
}
const keyframe = pickKeyframe();
const lastKeyframeArg = flag('last-keyframe', null);
const lastKeyframe = lastKeyframeArg ? path.resolve(WS, String(lastKeyframeArg)) : null;
if (lastKeyframe && !fs.existsSync(lastKeyframe)) throw new Error(`尾帧不存在：${lastKeyframe}`);
if (continuityHandoff && path.resolve(keyframe || '') !== path.resolve(continuityHandoff.keyframe)) {
  throw new Error(`${unit.id}: 实际使用的关键帧与连续性交接凭证不一致`);
}
const resolvedUnitAssets = unitAssets(board, boardPath, unit, { workspace: WS });

/**
 * ## 参考图清单（用户 2026-09-16 定的规矩）
 *
 * > **第一张图是关键帧，第二张图~N 张图是关键帧里的人物或物品资产（人物优先）。**
 *
 * 为什么必须这么做：`MiniMaxH3ImageToVideo`（**图生视频**）只有 `first_frame`
 * 一个身份入口 —— 它管"从哪开始"，**不管"14 秒之后还得是同一个人"**。
 * 镜头一推到近景、或者切到首帧里没出现的人，模型没有依据就自己编
 * （实测：u2 镜1→镜2 双螺髻变成单高髻；u3 切到大师兄直接换了个人）。
 *
 * 身份参考要走近 `MiniMaxH3ReferenceToVideo`（**多图参考**）的
 * `ref_image_1..9`，提示词里用 `<Picture N>` 指向它们。
 *
 * 顺序：
 * ```
 *   ref_image_1         关键帧（构图 + 光 + 机位）
 *   ref_image_2,3,…     出镜人物的资产，**人物优先**：
 *                       按 on_screen 出现顺序，每个人 肖像(脸) → 身份图(服装)
 * ```
 * 上限 9 张（节点的 autogrow 上限）。
 */
function pickRefs() {
  const list = [];
  if (keyframe) list.push({ file: keyframe, role: 'keyframe', who: null });
  for (const person of resolvedUnitAssets.people) {
    list.push({ file: person.portrait, role: 'face', who: person.name });
    list.push({ file: person.sheet, role: 'costume', who: person.name });
  }
  for (const prop of resolvedUnitAssets.props) list.push({ file: prop.file, role: 'prop', who: prop.name });
  if (list.length > 9) {
    throw new Error(`${unit.id}: 关键帧、人物与道具共需 ${list.length} 张参考图，超过 H3 上限 9；请让导演拆分单元或精简资产`);
  }
  return list;
}

const refs = pickRefs();
// 出镜人物名字（给提示词的 subject_definitions 用）
const castNames = (() => {
  const cast = [];
  for (const s of unit.shots) for (const id of s.on_screen || []) if (!cast.includes(id)) cast.push(id);
  return cast.map((id) => nameOf(id));
})();

const scene = resolvedUnitAssets.scene;
const hasFirstFrame = Boolean(keyframe);

/**
 * FastVideo FastH3 支持单首帧 i2v 和单首尾帧 fl2v，不支持 Ref2VA。
 * 因此 fast 档按是否提供 --last-keyframe 选择 i2v/fl2v；其余档位才使用多参考图 r2v。
 */
const PROFILE = (() => {
  const i = argv.indexOf('--profile');
  if (i >= 0) return argv[i + 1];
  // 正式默认就是 FastVideo FastH3。`--steps` 只保留旧命令兼容：明确传入时
  // 才映射基础 H3 档位，不能让内部的默认步数把模式静默降成 r2v。
  if (EXPLICIT_STEPS !== null) {
    return EXPLICIT_STEPS === 4 ? 'draft' : EXPLICIT_STEPS === 8 ? 'balanced' : 'final';
  }
  return VIDEO_PROFILE;
})();
const ATTENTION = String(flag('attention', VIDEO_ATTENTION)).toLowerCase();
if (!['sage', 'vsa'].includes(ATTENTION)) {
  throw new Error(`--attention 只能是 sage / vsa，收到 ${ATTENTION}`);
}
const KNOWN_PROFILES = ['draft', 'balanced', 'final', 'fast'];
if (!KNOWN_PROFILES.includes(PROFILE)) {
  throw new Error(`--profile 只能是 ${KNOWN_PROFILES.join(' / ')}，收到 ${PROFILE}`);
}
const MODE = PROFILE === 'fast' ? (lastKeyframe ? 'fl2v' : 'i2v') : 'r2v';
const promptRefs = MODE === 'r2v' ? refs : [];

/**
 * **先把时间线缩好，再构造提示词。**
 *
 * ⚠ 这里踩过一次：第一版把缩放放在构造提示词**之后**，
 * 结果提示词里写的切点是 **1.80s / 10.40s**（原始值），而总时长已经是 13.6s（缩放后）。
 * **切点和实际时间线对不上** —— u2 因此连崩两次，我一度以为是帧数或首帧的问题。
 *
 * 以后再改这个文件：**任何会改 `unit.shots[].at / duration_s` 的东西，
 * 都必须排在 `buildUnitPrompt` 之前。** 否则提示词和时长会各说各话。
 */
const natural = unit.shots[unit.shots.length - 1].at + unit.shots[unit.shots.length - 1].duration_s;
const fitTo = Number(flag('fit', 0)) || 0;
if (fitTo > 0 && natural > fitTo) {
  const scale = fitTo / natural;
  for (const s of unit.shots) {
    s.at = Number((s.at * scale).toFixed(3));
    s.duration_s = Number((s.duration_s * scale).toFixed(3));
  }
  // 收尾对齐：最后一镜的结束时间严格等于 fitTo
  const l2 = unit.shots[unit.shots.length - 1];
  l2.duration_s = Number((fitTo - l2.at).toFixed(3));
  console.log(`  ⚠ 超长，等比缩到 ${fitTo}s（系数 ${scale.toFixed(3)}）—— 内部节奏不变，整体紧一点`);
  console.log(`  缩后的切点: ${unit.shots.map((s) => s.at.toFixed(2) + 's').join(' / ')}`);
}

const prompt = buildUnitPrompt(unit, { nameOf, lineText, board, scene, hasFirstFrame, refs: promptRefs });

// `generation_duration_s` 是执行预算；导演内容时长不变，后期按
// `content_duration_s` 裁回。`--seconds` 只用于显式对照实验。
const requestedSeconds = Number(flag('seconds', 0))
  || Number(unit.generation_duration_s)
  || (unit.shots[unit.shots.length - 1].at + unit.shots[unit.shots.length - 1].duration_s);
// H3 只接受 17k+5 帧。必须向上取合法档，不能就近取整后短于导演内容。
const requestedFrames = Math.ceil(requestedSeconds * 24);
const legalFrames = 5 + 17 * Math.max(0, Math.ceil((requestedFrames - 5) / 17));
const seconds = legalFrames / 24;

// ---------------------------------------------------------------- 输出

const GEN = COMFY_GEN;
const PY = COMFY_PYTHON;

console.log(`\n单元 ${unit.id}　${unit.shots.length} 镜　${seconds.toFixed(1)}s　${PROFILE} / ${MODE} / ${QUALITY} / ${ATTENTION}`);
if (unit.why) console.log(`  导演的理由：${unit.why}`);
console.log(`  首帧：${keyframe || '（没有！要用 t2v）'}`);
console.log('─'.repeat(70));
console.log(prompt);
console.log('─'.repeat(70));

/**
 * **下面这段在干跑时也要真的走一遍。**
 *
 * 以前 `--dry-run` 在构造 argv **之前**就退出了，干跑只能复述一遍变量
 * （`PROFILE` / `ATTENTION` / `VIDEO_TIMEOUT_SECONDS`）—— 那证明不了这些值
 * 真的进了 `gen.py` 的命令行。现在把构造提前，干跑打印的就是**将要执行的
 * 那条命令本身**，测试可以直接断言 `--timeout 600`、`--attention vsa` 在 argv 里。
 */
const outDir = path.join(path.dirname(boardPath), 'units');
const resultFile = path.join(outDir, `${unit.id}.result.json`);

/**
 * **步数不再自己拼 `--steps` + `--fast`，改走 `gen.py` 的三档预设。**
 *
 * `gen.py` 的 `--profile` 会连带选对 LoRA / UNET / 稀疏注意力：
 * ```
 * draft     4 步 + minimax_h3_fl2v_turbo_4step_v1.0_768p
 * balanced  8 步 + minimax_h3_fl2v_turbo_8step_v1.0      ← 8 步有专用 LoRA
 * final    20 步 + 不挂 LoRA
 * fast      8 步 + FastH3 模型（不挂 LoRA）；注意力由 --attention 单独选择
 * ```
 *
 * ⚠ 之前我拿 **4 步的 LoRA 硬跑 8 步**（`--steps 8 --fast`），那是离线的 ——
 * 实测尾部照样崩。**8 步必须换 8 步的 LoRA。**
 *
 * ⚠ 尾部崩坏（768×1344 下 13.5 秒之后）在 draft/balanced 上都复现，
 * 换成 FastH3 才有可能解决 —— 所以有了 `fast` 这一档。
 *
 * 可用档位由 `gen.py` 的 `H3_PROFILES` 决定，这里不再写死白名单（写死过一次，
 * 加 `fast` 时就被卡住了）。
 */
const args = [GEN, MODE,
  '--prompt', prompt,
  '--duration', seconds.toFixed(3),
  '--width', String(W), '--height', String(H),
  '--out-dir', outDir, '--result-file', resultFile, '--no-shell',
  '--timeout', String(VIDEO_TIMEOUT_SECONDS)];
if (MODE === 'i2v') {
  args.push('--image', keyframe);
} else if (MODE === 'fl2v') {
  args.push('--image', keyframe, '--last-image', lastKeyframe);
} else {
  for (const ref of refs) args.push('--image', ref.file);
  if (!refs.length) args.push('--image', keyframe);
}
args.push('--profile', PROFILE);
args.push('--attention', ATTENTION);
console.log(`  尺寸 ${W}×${H}${W === 1088 ? '  ⚠ 这是 2.09MP，官方参考是 0.41MP' : ''}`);
// 首帧缺失时 args 里会有 `null`（i2v/fl2v 分支照样 push，交给下面的闸门去报错）。
// 打印时必须先兜住，否则 `a.length` 会在这里炸 —— 干跑就看不到任何东西了。
const showArg = (a) => { const s = String(a ?? '∅'); return s.length > 40 ? s.slice(0, 37) + '…' : s; };
console.log('  最终 argv: ' + args.map(showArg).join(' '));

if (DRY) { console.log('\n--dry-run：没生成。上面那行 argv 就是将要交给 gen.py 的完整命令。'); process.exit(0); }
if (!keyframe) { console.error('没有首帧，这个单元的连续性没保证 —— 先出关键帧。'); process.exit(1); }
fs.mkdirSync(outDir, { recursive: true });

// **提示词写文件再传路径** —— 这台机器 PS 5.1 会吃命令行里的引号
const pf = path.join(outDir, `.${unit.id}.prompt.txt`);
fs.writeFileSync(pf, prompt, 'utf8');

console.log(`\n出片（${PROFILE} / ${MODE} / ${QUALITY} / ${ATTENTION}，${seconds.toFixed(2)}s → ${Math.round(seconds * 24)} 帧）…`);
// **提示词直接进 argv** —— spawnSync 使用参数数组且不经过 shell，
// 所以换行、引号、中文都不会被 shell 吃掉。
// fast 档严格照 FastVideo FastH3 模板走单首帧 i2v 或单首尾帧 fl2v；不支持 Ref2VA。
// 其他档位使用基础 H3 Ref2VA，以人物资产换取更强的身份约束。
//
// 用户 2026-09-16 定的：
// > 第一张图是关键帧，第二张图~N 张是关键帧里的人物或物品资产（人物优先）。
//
// 之前用的是 `i2v`（图生视频），身份只有一个入口 = `first_frame` ——
// 它管"从哪开始"，不管"14 秒之后还得是同一个人"。实测后果：
// u2 镜1→镜2 双螺髻变单高髻；u3 切到大师兄直接换了个人。
//
// `r2v` 会把 `ref_image_1..9` 交给 `MiniMaxH3ReferenceToVideo`，
// 提示词里用 `<Picture N>` 指着它们 —— 那才是"锁人"的入口。
// （`args` 已在上面「输出」段构造并打印过，这里直接用。）

const startedAt = Date.now();
// gen.py 负责在 10 分钟时写出可读的超时结果；外层多留 30 秒做异常兜底。
const r = spawnSync(PY, args, {
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
  timeout: (VIDEO_TIMEOUT_SECONDS + 30) * 1000,
});
if (r.stdout) process.stdout.write(r.stdout);
if (r.stderr && r.status !== 0) process.stderr.write(String(r.stderr).slice(0, 800));

async function interruptComfy() {
  const base = (process.env.COMFYUI_URL || 'http://127.0.0.1:8188').replace(/\/+$/, '');
  try {
    await fetch(`${base}/interrupt`, { method: 'POST', signal: AbortSignal.timeout(5000) });
  } catch (error) {
    console.error(`\n⚠ 超时后未能通知 ComfyUI 中断：${error.message}`);
  }
}

if (r.error?.code === 'ETIMEDOUT') {
  await interruptComfy();
  console.error('\n✗ 视频生成超过 10 分钟，已中断。');
  process.exit(1);
}

let ok = false;
try {
  if (fs.statSync(resultFile).mtimeMs < startedAt) {
    throw new Error('结果文件来自本轮启动之前');
  }
  const res = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  ok = Boolean(res.ok);
  const rawFile = res.files && res.files[0];
  const f = typeof rawFile === 'string' ? rawFile : rawFile?.local_path || rawFile?.localPath || rawFile?.path;
  console.log(`\n${ok ? '✓' : '✗'} ${ok ? f : res.error}`);
  if (!ok && /TimeoutError|等待超时/.test(String(res.error || ''))) {
    await interruptComfy();
    console.error('视频生成达到 10 分钟上限，已通知 ComfyUI 中断。');
  }
  if (ok && f) {
    const sheet = path.join(outDir, `${unit.id}_review_frames.png`);
    const inspected = spawnSync(process.execPath, [path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (m) => m.slice(1))), 'inspect.mjs'), f,
      '--frames', '8', '--aspect', aspectOf(board), '--first-last', '--out', sheet], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (inspected.stdout) process.stdout.write(inspected.stdout);
    if (inspected.status !== 0) {
      if (inspected.stderr) process.stderr.write(inspected.stderr);
      console.error('机器检查未通过：本段不进入人工审阅，不能生成下一段。');
      ok = false;
    }
  }
  if (ok && f) {
    const sheet = path.join(outDir, `${unit.id}_review_frames.png`);
    const note = writeReviewNote(projectDir, `clip-${unit.id}`, [
      `# 视频片段 ${unit.id} 人工审阅`, '',
      '机器技术检查通过后，请完整观看并检查：人物一致性、动作是否飞掉、台词是否说完、切镜是否自然、画面是否出现错误文字。', '',
      `视频：${f}`, `八帧总览：${sheet}`, '',
      `确认命令：node cli/review-gate.mjs approve --project "${projectDir}" --stage clip --id ${unit.id} --artifacts "${f}"`,
    ]);
    console.log(`等待人工审阅：${note}`);
  }
} catch (error) { console.log(`\n✗ 没拿到本轮结果文件（退出码 ${r.status}）：${error.message}`); }
process.exit(ok ? 0 : 1);
