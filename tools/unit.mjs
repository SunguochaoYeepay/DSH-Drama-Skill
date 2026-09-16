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
 *   node tools/unit.mjs <board.json> --direction <dir.json> --unit u1 [--dry-run]
 *
 * 选项：
 *   --ws <dir>       工作区根
 *   --keyframe <png> 这一单元的首帧（不给就去找最接近的现有 keyframes/）
 *   --steps <n>      采样步数（默认 4）
 *   --dry-run        只打印提示词，不生成
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

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
  console.error('用法：node tools/unit.mjs <board.json> --direction <dir.json> --unit u1 [--dry-run]');
  process.exit(2);
}

const board = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
const dir = JSON.parse(fs.readFileSync(dirPath, 'utf8'));
const WS = flag('ws', null) || path.resolve(path.dirname(boardPath), '..', '..', '..');
const DRY = Boolean(flag('dry-run', false));
const STEPS = Number(flag('steps', 4)) || 4;
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
const sizeArg = String(flag('size', '480x864'));
const [W, H] = sizeArg.split('x').map(Number);

const unit = (dir.units || []).find((u) => u.id === unitId);
if (!unit) { console.error(`找不到单元 ${unitId}`); process.exit(2); }

// ---------------------------------------------------------------- 台词原文（代码搬）

const scriptPath = path.join(path.dirname(boardPath), 'story.md');
const scriptLines = fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, 'utf8').split(/\r?\n/) : [];
/** 行号 → 台词原文 + 说话人（**从板子和剧本拿，不经过导演**）。 */
const lineText = new Map();
for (const s of board.shots || []) {
  for (const ln of s.source_lines || []) {
    for (const d of s.dialogue || []) {
      if (scriptLines[ln - 1] && scriptLines[ln - 1].includes(d.text)) {
        lineText.set(ln, { text: d.text, who: d.character, emotion: d.emotion });
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

// ---------------------------------------------------------------- 朝向 → 画面位置

/** H3 认的框位表达。 */
const FACING_PHRASE = {
  left: 'facing the left side of the frame',
  right: 'facing the right side of the frame',
  toward: 'facing the camera',
  away: 'facing away from the camera',
};
const FRAMING_EN = {
  远景: 'extreme long shot',
  全景: 'wide shot',
  中景: 'medium shot',
  近景: 'medium close-up shot',
  特写: 'close-up shot',
};

// ---------------------------------------------------------------- 拼多镜描述

/**
 * 一个单元 → H3 的完整提示词（三段式，官方格式）。
 *
 * **不能自己发明格式。** 已经跑通的 `src/assets.mjs:h3Prompt()` 是正本，这里照抄它的规矩：
 *
 *   ① v2va 对齐行（固定句式，必须原样）
 *   ② `integrated_multimodal_description:` —— 看得见 + 听得见的时间线
 *      · **第 1 镜不带时间戳**；后面每镜以严格递增的切点开头（官方 4.2）
 *      · 台词包进 `<d>[Chinese] …</d>`，说话人带 `(S1)` 编号
 *   ③ `overall_soundscape:` —— **只写环境音，禁止重复台词**
 *   ④ `non_diegetic_music:`
 *
 * ## 拼串的坑（第一版踩了）
 *
 * 第一版拿中文字段和英文结构硬拼，出来是 `。，…。，固定镜头 ，…。。
 * `—— 标点乱、名字重复、`facing` 和动作描述撞车。
 * 所以这里**显式分段拼**，每段自己带干净的分隔符。
 */
export function buildUnitPrompt(unit, ctx) {
  const { nameOf: nm, lineText: lt, board, scene } = ctx;
  const parts = [];

  // ---- ① I2VA 对齐行（官方固定句式） ----
  if (ctx.hasFirstFrame) {
    parts.push('For the target video, at 0.00 seconds into the target video, '
      + '<Picture 1> (from [Shot 1]) is fully referenced.');
  }

  // 说话人编号（跟 assets.mjs 一致）
  const speakerIds = new Map();
  let sid = 0;
  for (const s of unit.shots) {
    for (const ln of s.lines || []) {
      const d = lt.get(ln);
      if (d && !speakerIds.has(d.who)) speakerIds.set(d.who, `S${++sid}`);
    }
  }

  // ---- ② 多镜正文 ----
  const clean = (s) => String(s || '').replace(/[。．.]+$/, '').trim();
  const body = [];
  for (const [i, s] of unit.shots.entries()) {
    const framing = FRAMING_EN[s.framing] || s.framing;
    const people = (s.on_screen || []).map(nm).join('与');

    // 朝向：写成画面语言，但**动作里已经说了方向就不重复**（第一版这里撞过车）
    const actionText = clean(s.action);
    const faces = Object.entries(s.facing || {})
      .filter(([, f]) => f !== 'away' || !/前行|走|背影/.test(actionText))
      .filter(([, f]) => !(f === 'right' && /右侧/.test(actionText)))
      .filter(([, f]) => !(f === 'left' && /左侧/.test(actionText)))
      // 只有一个在画面里时不必再点名字（前面 `of X` 已经说了）
      .map(([id, f]) => {
        const who = (s.on_screen || []).length === 1 ? '' : `${nm(id)} `;
        return `${who}${FACING_PHRASE[f] || ''}`.trim();
      })
      .filter(Boolean)
      .join('，');

    const cam = s.camera && !/^固定/.test(s.camera) ? `，摄影机${clean(s.camera)}` : '';
    const seg = [];
    if (i > 0) seg.push(`[Shot ${i + 1}] At ${s.at.toFixed(2).padStart(5, '0')} seconds, the camera cuts to`);
    else seg.push('[Shot 1]');
    seg.push(`a ${framing}`);
    if (people) seg.push(`of ${people}`);
    const mid = [faces, actionText + cam, clean(s.lighting)].filter(Boolean).join('，');
    if (mid) seg.push(`—— ${mid}`);
    let one = seg.join(' ') + '。';

    // **台词接在同一行后面，不单独占行。**
    //
    // 第一版把台词放在新的一行，结果 480×864 那次**画面上烧出了字幕**
    // （同提示词在 1088×1920 两次都没有）。节点里没有任何 ffmpeg 烧字代码，
    // 所以是模型画的 —— 而**台词单独一行，看起来就像一条字幕**。
    // 已经跑通的 `src/assets.mjs:h3Prompt()` 是空格连接、全部一行，照它来。
    for (const ln of s.lines || []) {
      const d = lt.get(ln);
      if (!d) { one += `（警告：第 ${ln} 行没有台词原文）`; continue; }
      const id = speakerIds.get(d.who);
      const delivery = d.emotion ? `，${d.emotion}` : '';
      one += ' ' + (d.kind === 'voiceover'
        ? `${nm(d.who)}${id ? ` (${id})` : ''} says in an off-screen voiceover: <d>[Chinese] ${d.text}</d>，嘴唇始终完全闭合。`
        : `${nm(d.who)}${id ? ` (${id})` : ''}${delivery}，说道：<d>[Chinese] ${d.text}</d>。`);
    }
    body.push(one);
  }
  parts.push('integrated_multimodal_description: ' + body.join('\n'));

  // ---- ③ 环境音（只环境音） ----
  const amb = unit.shots.map((s) => s.audio).filter(Boolean);
  parts.push('overall_soundscape: ' + (amb.length
    ? [...new Set(amb)].join(' ')
    : (scene?.environment ? `${scene.environment}的环境音` : 'Ambient environmental sound matching the scene.')));

  // ---- ④ 配乐 ----
  parts.push('non_diegetic_music: ' + (board.meta?.music || 'N/A'));

  // ---- ⑤ 显式排除画面文字 ----
  //
  // **不是因为官方要求，是因为不加它就会烧字幕。**
  //
  // 官方指南 4.5 节只说"画面上真实可见的文字要写成英文双引号"，
  // **没说"不写就不会出现"** —— 我一度是这么推断的，然后被实测打脸：
  //
  //   480×864    两次 → 有字幕
  //   768×1344   u1 第一次 → 无；u1 第二次、u2、u3 → 有
  //   1088×1920  两次 → 无
  //
  // **同一个尺寸、同样的提示词结构，结果不一致 —— 所以它不是分辨率决定的，
  // 是采样随机性。** 大概因为中文短剧在训练数据里几乎都带字幕，模型有时候自己就加上了。
  //
  // 我拿单个文件下过"768 不烧字幕"的结论，那是错的。**这已经是今晚第七次
  // 拿单样本外推了。**
  if (unit.shots.some((s) => (s.lines || []).length)) {
    parts.push('on_screen_text: none. No subtitles, no captions, no text overlays of any kind.');
  }

  return parts.join('\n\n');
}

// ---------------------------------------------------------------- 首帧

function pickKeyframe() {
  const explicit = flag('keyframe', null);
  if (explicit) return path.resolve(WS, explicit);
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

const scene = (board.scenes || []).find((s) => s.id === (board.shots[0] || {}).scene);
const hasFirstFrame = Boolean(keyframe);

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

const prompt = buildUnitPrompt(unit, { nameOf, lineText, board, scene, hasFirstFrame });

// `--seconds` 可以强改时长 —— 用来做"同一内容、不同帧数"的对照实验
const seconds = Number(flag('seconds', 0)) || (unit.shots[unit.shots.length - 1].at + unit.shots[unit.shots.length - 1].duration_s);

// ---------------------------------------------------------------- 输出

const GEN = 'C:\\Users\\Administrator\\.agents\\skills\\comfy-studio\\scripts\\gen.py';
const PY = 'E:\\AI-Image\\ComfyUI-aki-v1.4\\python\\python.exe';

console.log(`\n单元 ${unit.id}　${unit.shots.length} 镜　${seconds.toFixed(1)}s`);
if (unit.why) console.log(`  导演的理由：${unit.why}`);
console.log(`  首帧：${keyframe || '（没有！要用 t2v）'}`);
console.log('─'.repeat(70));
console.log(prompt);
console.log('─'.repeat(70));

if (DRY) { console.log('\n--dry-run：没生成。'); process.exit(0); }
if (!keyframe) { console.error('没有首帧，这个单元的连续性没保证 —— 先出关键帧。'); process.exit(1); }

const outDir = path.join(path.dirname(boardPath), 'units');
fs.mkdirSync(outDir, { recursive: true });
const resultFile = path.join(outDir, `${unit.id}.result.json`);

// **提示词写文件再传路径** —— 这台机器 PS 5.1 会吃命令行里的引号
const pf = path.join(outDir, `.${unit.id}.prompt.txt`);
fs.writeFileSync(pf, prompt, 'utf8');
const tf = path.join(outDir, `.${unit.id}.prompt.txt`);
fs.writeFileSync(tf, prompt, 'utf8');
void tf;   // 留一份到磁盘方便排查（gen.py 没有 --prompt-file）

console.log(`\n出片（${STEPS} 步，${seconds.toFixed(2)}s → ${Math.round(seconds * 24)} 帧）…`);
// **提示词直接进 argv** —— 跟 `render.mjs:runGen()` 一样用 spawnSync 的数组形式（无 shell），
// 所以换行、引号、中文都不会被 shell 吃掉。
const args = [GEN, 'i2v', '--image', keyframe,
  '--prompt', prompt,
  '--duration', seconds.toFixed(3),
  '--width', String(W), '--height', String(H),
  '--out-dir', outDir, '--result-file', resultFile, '--no-shell'];
if (STEPS === 4) args.push('--fast');
if (DRY || flag('show-args', false)) console.log('  最终 argv: ' + args.map((a) => a.length > 40 ? a.slice(0, 37) + '…' : a).join(' '));
console.log(`  尺寸 ${W}×${H}${W === 1088 ? '  ⚠ 这是 2.09MP，官方参考是 0.41MP' : ''}`);

const r = spawnSync(PY, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 1800000 });
if (r.stdout) process.stdout.write(r.stdout);
if (r.stderr && r.status !== 0) process.stderr.write(String(r.stderr).slice(0, 800));

let ok = false;
try {
  const res = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  ok = Boolean(res.ok);
  const f = res.files && res.files[0];
  console.log(`\n${ok ? '✓' : '✗'} ${ok ? f : res.error}`);
} catch { console.log(`\n✗ 没拿到结果文件（退出码 ${r.status}）`); }
process.exit(ok ? 0 : 1);
