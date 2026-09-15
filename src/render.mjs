#!/usr/bin/env node
/**
 * render.mjs — 按契约生成资产、关键帧、片段，最后拼接。
 *
 *   node src/render.mjs <board.json> --stage assets [--only a,b] [--force]
 *   node src/render.mjs <board.json> --stage keyframes [--shots s01,s03] [--force] [--no-assets]
 *   node src/render.mjs <board.json> --stage clips [--shots ...] [--force]
 *   node src/render.mjs <board.json> --stage assemble
 *   node src/render.mjs <board.json> --stage all
 *
 * **资产走线上、关键帧走本地**（判据：数量少要质量 vs 数量多要便宜）。
 * 通道可用环境变量覆盖：AIH_ASSET_PROVIDER / AIH_KEYFRAME_PROVIDER。
 *
 * 所有路径都相对**会话工作区**（board 里的路径也是），因为数据跟着项目走、代码位置固定。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assetPlan, refsOf, keyframeRefs, keyframeInstruction, shotPrompt, h3Prompt } from './assets.mjs';
import { assetProvider, keyframeProvider, provider } from './providers/index.mjs';
import { buildScorePrompt, scoreFile, pickBest, passes } from './score.mjs';
import { review } from './review.mjs';
import { ledger, summarize, formatSummary } from './cost.mjs';
import { checkGate } from './board.mjs';
import { speechSegments, durationForSpeech, emotionToProsody, estimateSpeechSeconds, flfPlan, buildTimeline, framesFor, applyTransitions } from './orchestrate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PY = process.env.AIH_PYTHON || 'E:\\AI-Image\\ComfyUI-aki-v1.4\\python\\python.exe';
const GEN = process.env.AIH_GEN || 'C:\\Users\\Administrator\\.agents\\skills\\comfy-studio\\scripts\\gen.py';
const FFMPEG = (() => {
  const base = 'C:\\Users\\Administrator\\AppData\\Local\\Microsoft\\WinGet\\Packages';
  try {
    for (const dir of fs.readdirSync(base)) {
      if (!dir.startsWith('Gyan.FFmpeg_')) continue;
      const c = path.join(base, dir, 'ffmpeg-7.1.1-full_build', 'bin', 'ffmpeg.exe');
      if (fs.existsSync(c)) return c;
    }
  } catch { /* 找不到就退回 PATH */ }
  return 'ffmpeg';
})();

/**
 * 工作区 = **数据所在的地方**（board 里的路径都相对它）。
 *
 * 代码位置固定、数据跟着项目走，所以这里**不能想当然用 cwd** ——
 * 实测踩过：从工程目录跑 render.mjs，7 张资产全生成到工程里去了。
 */
const argv = process.argv.slice(2);
const boardArg = argv.find((a) => !a.startsWith('--'));

/**
 * 工作区 = **数据所在的地方**（board 里的路径都相对它）。
 *
 * 代码位置固定、数据跟着项目走，所以这里**不能想当然用 cwd** ——
 * 实测踩过：从工程目录跑 render.mjs，7 张资产全生成到工程里去了。
 */
const WORKSPACE = (() => {
  const i = argv.indexOf('--workspace');
  const fromArg = i >= 0 ? argv[i + 1] : null;
  const ws = path.resolve(fromArg || process.env.AIH_WORKSPACE || process.cwd());
  if (!fs.existsSync(path.join(ws, 'story2video'))) {
    console.error(`✗ 工作区里没有 story2video/ 目录：${ws}`);
    console.error('  数据跟着项目走、代码位置固定 —— 用 --workspace <会话工作区> 指定，');
    console.error('  或设 AIH_WORKSPACE。**不要从工程目录里跑**，那会把资产生成到工程里去。');
    process.exit(2);
  }
  return ws;
})();
// ---- 产出目录：**一部剧一个目录，按产物类型分子目录** ----
//
// 以前所有东西平铺在 `story2video/shots/` 里：243 个文件，而且片段叫
// `i2v_20260915-112411.mp4` —— **文件名是时间戳，对不上镜号**。
// 换一部剧还会跟前一部混在一起。
//
// 现在：`story2video/projects/<剧名>/`，下面按类型分，**文件名一律用 id**：
//   assets/     portrait_<角色id>.png / sheet_<造型id>.png / scene_<场景id>.png
//   keyframes/  s01.png …
//   clips/      s01.mp4 …          ← 按镜号，不是时间戳
//   audio/      s02.mp3 …
//   pool/       s02/1.png …        候选池
//   out/        final.mp4 / final.srt / 审阅图
//   .tmp/       生成器的原始落点（时间戳命名，随即被挪走）
let PROJECT_DIR;
let RESULT_FILE;
let DIR;

/** 把生成器刚吐出来的文件挪到规范路径（按 id 命名）。返回新的绝对路径。 */
function place(file, dir, name) {
  if (!file || !fs.existsSync(file)) return null;
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, name + path.extname(file));
  try { fs.renameSync(file, dest); } catch { fs.copyFileSync(file, dest); fs.unlinkSync(file); }
  return dest;
}

const stage = (() => {
  const i = argv.indexOf('--stage');
  return i >= 0 ? argv[i + 1] : 'all';
})();
const force = argv.includes('--force');
const noAssets = argv.includes('--no-assets');
/**
 * 质量默认开。
 *
 * 复盘时发现的取舍错误：线上资产 2048-2688px 只花 1.3 元，而**观众真正看到的两层**
 * （关键帧、成片）被压到 1024×576 / 864×480，关键帧还只跑 4 步 Lightning。
 * 本地算力是免费但慢的 —— **恰恰应该在那儿换质量**。
 *
 * 默认 HQ：关键帧关掉 `--fast` 走 20 步，片段上到实测可用的 1344×768。
 * 探构图、赶时间时才加 `--fast`。
 */
const HQ = !argv.includes('--fast');
/** 反向场景图 + 俯视平面图：**默认不生成** —— 全工程没有任何东西消费它们。 */
const sceneExtras = argv.includes('--with-scene-extras');
const only = (() => {
  const i = argv.indexOf('--shots');
  return i >= 0 ? argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean) : null;
})();
const onlyAssets = (() => {
  const i = argv.indexOf('--only');
  return i >= 0 ? argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean) : null;
})();

function wanted(shot) {
  return !only || only.includes(shot.id);
}

if (!boardArg) {
  console.error('用法：render.mjs <board.json> --stage assets|keyframes|clips|assemble|all');
  process.exit(2);
}
const boardPath = path.resolve(WORKSPACE, boardArg);
const board = JSON.parse(fs.readFileSync(boardPath, 'utf8'));

// 剧名：显式 `--project` > `meta.project` > 板子文件名
const projectArg = (() => {
  const i = argv.indexOf('--project');
  return i >= 0 ? argv[i + 1] : null;
})();
const PROJECT = String(projectArg || board.meta?.project || path.basename(boardArg, '.json'))
  .replace(/[^\w\u4e00-\u9fa5.-]+/g, '-');
PROJECT_DIR = path.join(WORKSPACE, 'story2video', 'projects', PROJECT);
DIR = {
  assets: path.join(PROJECT_DIR, 'assets'),
  keyframes: path.join(PROJECT_DIR, 'keyframes'),
  clips: path.join(PROJECT_DIR, 'clips'),
  audio: path.join(PROJECT_DIR, 'audio'),
  pool: path.join(PROJECT_DIR, 'pool'),
  out: path.join(PROJECT_DIR, 'out'),
  tmp: path.join(PROJECT_DIR, '.tmp'),
};
RESULT_FILE = path.join(DIR.tmp, '.gen-result.json');
for (const d of Object.values(DIR)) fs.mkdirSync(d, { recursive: true });

// 账本：每次线上调用当场记，跑完打一张表。
// `--force` 的重出单独标一轮 —— **重出花掉的钱正是最该被看见的那部分**
// （上一部片子 3.88 元的线上开销里，有 1.44 元是我自己的 bug 造成的重出）。
const COST_FILE = path.join(WORKSPACE, 'story2video', 'costs.json');
ledger.attach(COST_FILE, {
  board: boardArg,
  run: argv.includes('--force') ? '重出' : ((only || onlyAssets) ? '局部' : '首轮'),
});
const costMark = ledger.mark();

/**
 * 产出路径 → 板子里的相对路径。
 * **只接受真的存在落的本地文件**：曾经把 OSS 签名 URL 写进过板子，
 * `path.resolve` 把 `https://…` 当成相对路径绞成了 `https:/…`，第二天全是死链。
 */
function toRelative(absolute) {
  const p = String(absolute);
  if (/^https?:\/\//i.test(p)) {
    throw new Error(`拒绝把 URL 写进契约（签名链接会过期）：${p.slice(0, 80)}`);
  }
  if (!fs.existsSync(p)) {
    throw new Error(`产出文件不存在：${p}`);
  }
  return path.relative(WORKSPACE, path.resolve(p)).split(path.sep).join('/');
}
function toAbsolute(relative) {
  return path.isAbsolute(relative) ? relative : path.resolve(WORKSPACE, relative);
}
/** 参考图解析：board 里存的是相对路径，生成时要绝对路径，而且得真的存在。 */
function resolveRef(rel) {
  if (!rel) return null;
  const abs = toAbsolute(rel);
  return fs.existsSync(abs) ? abs : null;
}
/**
 * 存板子，**同时写一个「当前板子」指针**。
 *
 * 为什么需要它：右侧的 `dsh-storyboard` 面板要在工作区里找分镜文件，
 * 但 `workspaceFiles.list` 的条目**只有 `{name, type, size}` —— 没有修改时间**
 * （而且返回顺序是"稳定的名称顺序"）。所以面板既排不了时间，
 * 也没法用"谁产物多就是谁"（板子刚被清空时反而是最旧的那个产物多）。
 *
 * 于是让**流水线自己说**在用哪个板子：`story2video/current.json`。
 * 面板先读指针，读不到才退回目录扫描。
 */
function save() {
  fs.writeFileSync(boardPath, JSON.stringify(board, null, 2) + '\n');
  try {
    const dir = path.join(WORKSPACE, 'story2video');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({
      board: toRelative(boardPath),
      at: new Date().toISOString(),
      aspect: board.meta?.aspect,
      stage: board.meta?.stage,
      title: board.meta?.title,
    }, null, 2) + '\n');
  } catch { /* 指针写不成不该弄崩渲染 */ }
}
function runGen(args) {
  try { fs.unlinkSync(RESULT_FILE); } catch { /* 首次运行没有也无所谓 */ }
  const r = spawnSync(PY, [GEN, ...args, '--out-dir', DIR.tmp, '--result-file', RESULT_FILE], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) return null;
  try { return JSON.parse(fs.readFileSync(RESULT_FILE, 'utf8')); } catch { return null; }
}
function firstFile(result) {
  if (!result) return null;
  const f = (result.local_files || [])[0] || (result.files || [])[0];
  return typeof f === 'string' ? f : (f && f.local_path) || null;
}
function runFfmpeg(args) {
  const r = spawnSync(FFMPEG, args, { stdio: 'ignore', cwd: WORKSPACE });
  return r.status === 0;
}

// ------------------------------------------------------------------- assets

/** 资产类型 → 打分用的判据种类。 */
const SCORE_KIND = {
  portrait: 'portrait', sheet: 'identity',
  master: 'scene', reverse_master: 'scene', spatial_layout: 'scene', prop_3view: 'scene',
};

/** 打分时告诉模型"应该是什么样"，否则它只能凭感觉给分。 */
function expectOf(job) {
  const kind = SCORE_KIND[job.kind] || 'scene';
  if (kind === 'portrait') {
    const c = board.characters.find((x) => x.id === job.id);
    return { face: c ? `${c.name}：${c.face_prompt}` : '' };
  }
  if (kind === 'identity') {
    const x = board.identities.find((v) => v.id === job.id);
    const c = x ? board.characters.find((v) => v.id === x.character) : null;
    return { face: c ? `${c.name}：${c.face_prompt}` : '', costume: x ? x.appearance_details : '' };
  }
  if (job.slot === 'ref_image') {
    const p = (board.props || []).find((v) => v.id === job.id);
    return { environment: p ? `道具：${p.description}` : '' };
  }
  const s = board.scenes.find((v) => v.id === job.id);
  return { environment: s ? s.environment : '' };
}

/**
 * 走一遍资产计划：肖像 → 身份图 → 场景三件套 → 道具。
 *
 * **顺序即依赖**：身份图要用肖像当 anchor，反向场景图要用主图当 anchor。
 * 编辑器做不到的（缺参考图）就退回文生图，并说清楚为什么退 —— 不静默降级。
 *
 * `--n N` 时每项抽 N 个候选，用**本地视觉模型**逐维打分择优
 * （判据：脸 ≥ 7 且 服装 ≥ 7 且无 critical）。候选池留在 `shots/pool/` 里可人工复核。
 */
async function doAssets() {
  // **先要人确认过分镜表**，才允许花钱出资产。
  requireGate('assets', '要出资产，得先确认过故事和分镜表 —— 分镜表就是资产清单的来源');
  const plan = assetPlan(board, { sceneExtras });
  const p = assetProvider();
  const poolN = Math.max(1, Number(argv.includes('--n') ? argv[argv.indexOf('--n') + 1] : 1) || 1);
  const doScore = poolN > 1 && !argv.includes('--no-score');
  let done = 0, skipped = 0, failed = 0, scored = 0;

  for (const [i, job] of plan.entries()) {
    const label = `${job.kind} ${job.id}`;
    if (onlyAssets && !onlyAssets.includes(job.id)) continue;
    if (job.target[job.slot] && !force) { skipped++; continue; }

    // 候选池留在 pool/ 里（可人工复核），选中那张才复制成规范槽位名
    const poolDir = poolN > 1 ? path.join(DIR.pool, job.id + '_' + job.slot) : DIR.tmp;
    fs.mkdirSync(poolDir, { recursive: true });
    const prefix = poolN > 1 ? 'c' : `${job.id}_${job.slot}`;

    let result;
    if (job.mode === 'edit') {
      // **执行时**才解析参考图：依赖产物是在这一趟里被写回 board 的
      const refs = refsOf(job).map(resolveRef).filter(Boolean);
      if (refs.length) {
        console.log(`[${i + 1}/${plan.length}] ${label} 出图…（图生图 ${refs.length} 张参考 ×${poolN}，${p.name}）`);
        result = await p.edit({ images: refs, instruction: job.instruction, size: job.size, n: poolN, outDir: poolDir, prefix });
      } else {
        console.log(`[${i + 1}/${plan.length}] ${label} 出图…（缺参考图，退回文生图 ×${poolN}，${p.name}）`);
        result = await p.generate({ prompt: job.instruction, size: job.size, n: poolN, outDir: poolDir, prefix });
      }
    } else {
      console.log(`[${i + 1}/${plan.length}] ${label} 出图…（文生图 ×${poolN}，${p.name}）`);
      result = await p.generate({ prompt: job.prompt, size: job.size, n: poolN, outDir: poolDir, prefix });
    }

    const files = (result && result.files) || [];
    if (!files.length) {
      failed++;
      console.error(`    ✗ 失败：${(result && (result.stderr || result.error)) || '没有产出'}`.slice(0, 400));
      continue;
    }

    let winner = files[0];
    if (doScore && files.length > 1) {
      const kind = SCORE_KIND[job.kind] || 'scene';
      const rubric = buildScorePrompt(kind, expectOf(job));
      const pool = [];
      for (const f of files) {
        const r = await scoreFile(f, rubric);
        pool.push({ path: f, score: r.score });
        scored++;
        const s = r.score || {};
        console.log(`      打分 ${path.basename(f)}：${r.ok ? `${s.face_score ?? s.match_score ?? '?'} 脸 / ${s.clothing_score ?? '-'} 衣 / ${s.framing_score ?? '-'} 构图` : `失败 ${r.error || ''}`}${s.critical ? `  ⚠ ${s.critical}` : ''}  ${r.seconds.toFixed(0)}s`);
      }
      const best = pickBest(pool, kind);
      if (best) {
        winner = best.path;
        console.log(`    → 选中 ${path.basename(winner)}${best.provisional ? '（**全部不过线，勉强采用**）' : ''}`);
      }
      fs.writeFileSync(path.join(poolDir, 'score.json'), JSON.stringify(pool.map((c) => ({ file: path.basename(c.path), score: c.score })), null, 2) + '\n');
    }

    // 选中那张挪到规范路径：`assets/<kind>_<id>.png`（**按 id 命名，不是时间戳**）
    const canonical = place(winner, DIR.assets, `${job.kind}_${job.id}_${job.slot}`);
    if (!canonical) { failed++; console.error(`    ✗ ${job.id} 挪不进 ${path.basename(DIR.assets)}/`); continue; }
    try {
      job.target[job.slot] = toRelative(canonical);
    } catch (e) {
      failed++;
      console.error(`    ✗ 产出不可用：${e.message}`);
      continue;
    }
    done++;
    save();
    console.log(`    -> ${job.target[job.slot]}`);
  }
  console.log(`资产 ${plan.filter((j) => j.target[j.slot]).length}/${plan.length}（新出 ${done}，跳过 ${skipped}，失败 ${failed}${scored ? `，打分 ${scored} 张` : ''}）`);

  // **出完就摆到人面前。** 资产不对的话，后面 14 个关键帧 + 14 个片段全是白烧。
  presentForReview('资产（人物肖像 / 身份图 / 场景 / 道具）',
    plan.filter((j) => j.target[j.slot]).map((j) => ({
      path: j.target[j.slot],
      label: `${j.kind.padEnd(14)} ${j.id}`,
    })), 'assets_review.jpg', 'assets', 4);
}

// --------------------------------------------------------------- keyframes

/**
 * 输出画幅。**必须跟着 `meta.aspect` 走，不能写死横屏。**
 *
 * 短剧是竖屏（9:16），而我一开始沿用了迁移过来的 16:9，从头到尾没跟用户确认过。
 * 更糟的是归一化目标 9:16 只给了 `480:864`（0.41 MP）。
 *
 * H3 实测支持的竖屏：480×864 / 576×1024 / 640×1152 / 768×1344 / **1080×1920**；
 * **720×1280 被 patchify 拒绝**。横屏：1024×576 / 1152×648 / 1344×768，**1280×720 同样被拒**。
 *
 * 两层通道要的参数**不一样**，别混：
 *   - 本地 comfyui：认 `ratio`（或 `width`/`height`）
 *   - 线上 bailian：**只认 `size`**（`1:1` / `16:9` / `9:16`…）
 * 曾经只传了 `ratio` 给线上，`size` 走了默认值 `'16:9'` ——
 * **14 张关键帧全按 16:9 生成、再被裁成竖屏，每张扔掉约 44% 画面。**
 */
const ASPECT = board.meta.aspect || '9:16';
const OUT_SIZE = {
  '9:16': { w: 1080, h: 1920, ff: '1080:1920', online: '9:16', tile: [304, 540] },
  '16:9': { w: 1344, h: 768, ff: '1344:768', online: '16:9', tile: [480, 270] },
  '1:1': { w: 1024, h: 1024, ff: '1024:1024', online: '1:1', tile: [400, 400] },
}[ASPECT] || { w: 1080, h: 1920, ff: '1080:1920', online: '9:16', tile: [304, 540] };

/** 把线上产出缩回 board 声明的画幅，免得十几镜十几个尺寸。 */
function normalizeSize(file) {
  const out = file.replace(/\.png$/i, '_fit.png');
  const ok = runFfmpeg(['-y', '-i', file, '-vf',
    `scale=${OUT_SIZE.ff}:force_original_aspect_ratio=increase,crop=${OUT_SIZE.ff}`,
    '-frames:v', '1', out]);
  if (!ok) console.error(`      尺寸归一化失败，保留原尺寸：${path.basename(file)}`);
  return ok ? out : file;
}

/**
 * 关键帧。本地跑（便宜、量大），失败模式多 —— 构图不听话、动作对不上、多出人来，
 * 所以这里**候选池的价值比资产上大得多**：资产的候选往往长得差不多，关键帧的一眼能分出好坏。
 */
async function doKeyframes() {
  // **资产确认过才允许出关键帧** —— 资产不对，14 张关键帧全是白烧。
  requireGate('keyframes', '要出关键帧，得先确认过资产（肖像/身份图/场景）—— 关键帧就是拿它们当参考画的');
  const p = keyframeProvider();
  const style = board.meta.style || 'realistic';
  const jobs = board.shots.filter(wanted);
  const poolN = Math.max(1, Number(argv.includes('--n') ? argv[argv.indexOf('--n') + 1] : 1) || 1);
  const doScore = poolN > 1 && !argv.includes('--no-score');
  let scored = 0;

  for (const [i, shot] of jobs.entries()) {
    if (shot.first_frame && !force) {
      console.log(`[${i + 1}/${jobs.length}] ${shot.id} 已有首帧，跳过`);
      continue;
    }
    const useRefs = !noAssets;
    const { refs: rawRefs, series } = useRefs ? keyframeRefs(board, shot) : { refs: [], series: [] };
    const refs = rawRefs.map(resolveRef).filter(Boolean);
    const poolDir = poolN > 1 ? path.join(DIR.pool, 'kf_' + shot.id) : DIR.tmp;
    fs.mkdirSync(poolDir, { recursive: true });
    const prefix = poolN > 1 ? 'c' : `kf_${shot.id}`;
    console.log(`[${i + 1}/${jobs.length}] ${shot.id} 出首帧…（${refs.length ? `图生图 ${refs.length} 张参考` : '文生图'} ×${poolN}，${p.name}）`);

    const started = Date.now();
    let files = [];
    // **两层通道的参数名不一样，必须都传：**
    //   线上 bailian 只认 `size`（'9:16' 这类字符串）
    //   本地 comfyui 只认 `ratio` / `width`·`height`
    // 只传后者的话线上会走 `size` 的默认值 `'16:9'` —— 竖屏关键帧会被生成成横的再裁掉 44%（踩过）。
    const sizeArgs = { size: OUT_SIZE.online, ratio: ASPECT, ...(HQ ? { width: OUT_SIZE.w, height: OUT_SIZE.h } : {}) };
    if (refs.length) {
      const r = await p.edit({ images: refs, instruction: keyframeInstruction(board, shot, series), n: poolN, outDir: poolDir, prefix, fast: !HQ, ...sizeArgs });
      files = r.files || [];
      if (!files.length) console.error(`    ✗ 失败：${(r.stderr || '').slice(0, 300)}`);
    } else {
      const r = await p.generate({ prompt: shotPrompt(board, shot), style, n: poolN, outDir: poolDir, prefix, fast: !HQ, ...sizeArgs });
      files = r.files || [];
      if (!files.length) console.error(`    ✗ 失败：${(r.stderr || '').slice(0, 300)}`);
    }
    if (!files.length) continue;

    let winner = files[0];
    if (doScore && files.length > 1) {
      const castNames = (shot.cast || []).map((id) => {
        const x = (board.identities || []).find((v) => v.id === id);
        const c = x ? (board.characters || []).find((v) => v.id === x.character) : null;
        return c ? `${c.name}（${x.appearance_details}）` : id;
      }).join('；');
      const rubric = buildScorePrompt('keyframe', {
        action: shot.action, shot_size: shot.shot_size, camera: shot.camera, cast: castNames,
      });
      const pool = [];
      for (const f of files) {
        const r = await scoreFile(f, rubric);
        pool.push({ path: f, score: r.score });
        scored++;
        const s = r.score || {};
        console.log(`      打分 ${path.basename(f)}：${r.ok ? `${s.face_score} 脸 / ${s.clothing_score} 衣 / ${s.framing_score} 构图 / 动作${s.action_match ? '对' : '**不对**'}` : `失败 ${r.error || ''}`}${s.critical ? `  ⚠ ${s.critical}` : ''}  ${r.seconds.toFixed(0)}s`);
      }
      const best = pickBest(pool, 'keyframe');
      if (best) {
        winner = best.path;
        console.log(`    → 选中 ${path.basename(winner)}${best.provisional ? '（**全部不过线，勉强采用**）' : ''}`);
      }
      fs.writeFileSync(path.join(poolDir, 'score.json'), JSON.stringify(pool.map((c) => ({ file: path.basename(c.path), score: c.score })), null, 2) + '\n');
    }

    // 先归一化再落位，**最终名字就是 `s01.png`**
    // （顺序反了会出现 `s01_fit.png` —— normalizeSize 会加 `_fit` 后缀，等于双层命名）
    const staged = place(winner, DIR.tmp, `${shot.id}_raw`) || winner;
    const fitted = place(normalizeSize(staged), DIR.keyframes, shot.id) || normalizeSize(staged);
    shot.first_frame = toRelative(fitted);
    save();
    console.log(`    -> ${shot.first_frame}  (${Math.round((Date.now() - started) / 1000)}s)`);
  }
  const n = board.shots.filter((s) => s.first_frame).length;
  console.log(`关键帧 ${n}/${board.shots.length}${scored ? `（打分 ${scored} 张）` : ''}`);

  presentForReview('关键帧（逐镜首帧）',
    board.shots.filter((s) => s.first_frame).map((s) => ({
      path: s.first_frame,
      label: `${s.id}  ${s.shot_size}  ${s.duration_s}s  ${(s.dialogue || [])[0] ? '「' + (s.dialogue[0].text || '').slice(0, 14) + '」' : '（无台词）'}`,
    })), 'keyframes_review.jpg', 'keyframes', 4);
}

// -------------------------------------------------------------------- tts

// ------------------------------------------------------------------ 闸门

/**
 * **花钱和出图之前，必须先让人看过。**
 *
 * 这条是补的：之前 `render.mjs` 从头到尾**一次都没查过闸门** ——
 * 一口气把资产、关键帧、片段、成片全跑完，中间没在任何地方停下来。
 * 结果就是"上游生成了一坨，下游全是垃圾"，而人直到最后才看见。
 *
 * 闸门不是仪式，是**止损点**：资产不对，后面 14 个关键帧 + 14 个片段全是白烧。
 *
 * @param {string} need 'assets' 要求 story+shots 已确认；'keyframes' 再要求 assets；
 *                      'rendering' 要求四道全确认
 * @param {string} why 人话说明为什么拦
 */
function requireGate(need, why) {
  if (argv.includes('--skip-gate')) {
    console.error(`⚠ --skip-gate：跳过闸门检查（${why}）—— 别在正式跑的时候用它`);
    return;
  }
  const errs = checkGate(board, need);
  if (!errs.length) return;
  console.error(`\n✗ 拦住：${why}\n`);
  for (const e of errs) console.error(`   · ${e}`);
  console.error('\n  确认之后再来（把 <你的名字> 换掉）：');
  for (const g of ['story', 'shots', 'assets', 'keyframes']) {
    if (!board.meta?.approvals?.[g]) {
      console.error(`     node src/board.mjs approve ${boardArg} --stage ${g} --by <你的名字>`);
    }
  }
  console.error('\n  先看东西再点头。审阅图在各阶段的 --stage 跑完后会生成。');
  process.exit(3);
}

// ------------------------------------------------------------------ 审阅图

/**
 * 把一批图拼成一张审阅图。**这是给人看的东西，不是给机器看的。**
 * 排布固定为从左到右、从上到下，顺序会打到终端 —— 不写字（ffmpeg 没 fontconfig，drawtext 用不了）。
 */
/**
 * 拼审阅图。**瓦片固定 16:9，不跟片子画幅走。**
 *
 * 试过两种更"聪明"的做法，都不行：
 *   1. 用片子的画幅当瓦片（9:16 的 304×540）→ 16:9 的身份图被塞进竖瓦片，四周全黑、图小得看不清
 *   2. 按高度对齐、宽度自适应 → **每行宽度不同，`vstack` 直接拼不起来**
 *
 * 审阅图是**给人读的**，跟成片构图无关，所以用最宽的那个比例（16:9）当统一瓦片，
 * 剩下的 pillarbox / letterbox 留黑边。
 */
function buildContactSheet(items, outPath, cols = 4, rowH = 300) {
  const rows = Math.ceil(items.length / cols);
  const n = items.length;
  const blanksNeeded = rows * cols - n;
  const TILE_W = Math.round(rowH * 16 / 9 / 2) * 2;   // **必须偶数**，奇数会让 yuv420p 直接失败
  const args = [];
  for (const it of items) args.push('-i', toAbsolute(it.path));
  // **空位要补够一整行**（不是只补一个）—— 14 张排 4 列需要 2 个空位，
  // 只补一个的话 `[v15]` 会指向不存在的流，整张图就出不来（踩过）。
  for (let b = 0; b < blanksNeeded; b++) {
    args.push('-f', 'lavfi', '-i', `color=c=0x141414:s=${TILE_W}x${rowH}`);
  }
  const L = [];
  for (let k = 0; k < n; k++) {
    L.push(`[${k}:v]scale=${TILE_W}:${rowH}:force_original_aspect_ratio=decrease,`
      + `pad=${TILE_W}:${rowH}:(ow-iw)/2:(oh-ih)/2:color=0x141414,setsar=1[v${k}]`);
  }
  for (let b = 0; b < blanksNeeded; b++) L.push(`[${n + b}:v]setsar=1[v${n + b}]`);
  for (let r = 0; r < rows; r++) {
    const tags = [];
    for (let c = 0; c < cols; c++) tags.push(`[v${r * cols + c}]`);
    L.push(`${tags.join('')}hstack=${cols}[r${r}]`);
  }
  L.push(`${Array.from({ length: rows }, (_, r) => `[r${r}]`).join('')}vstack=${rows}[out]`);
  const script = outPath.replace(/\.jpg$/i, '.filter.txt');
  fs.writeFileSync(script, L.join(';'), 'ascii');
  const ok = runFfmpeg([...args, '-filter_complex_script', script, '-map', '[out]', '-frames:v', '1', outPath]);
  try { fs.unlinkSync(script); } catch { /* 清不掉也无所谓 */ }
  if (!ok) console.error(`      审阅图生成失败：${path.basename(outPath)}`);
  return ok && fs.existsSync(outPath);
}

/** 给一批条目生成审阅图 + 打印阅读顺序 + 打印确认命令。 */
function presentForReview(title, items, outName, gate, cols = 4, rowH) {
  if (!items.length) return;
  const outPath = path.join(DIR.out, outName);
  const ok = buildContactSheet(items, outPath, cols, rowH);
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`【${title}】审阅`);
  if (ok) console.log(`  审阅图 -> ${toRelative(outPath)}`);
  console.log(`  阅读顺序（左→右、上→下，每行 ${cols} 个）：`);
  items.forEach((it, i) => console.log(`    ${String(i + 1).padStart(2)}. ${it.label}`));
  console.log(`\n  看没问题就点头：`);
  console.log(`    node src/board.mjs approve ${boardArg} --stage ${gate} --by <你的名字>`);
  console.log(`  不满意就改板子上的字段，然后 --force 单点重出。`);
  console.log(`${'─'.repeat(60)}\n`);
}

/** ffprobe 量音频秒数 —— 时长要由它反推，不能拍脑袋。 */function probeDuration(file) {
  const ffprobe = FFMPEG.replace(/ffmpeg\.exe$/i, 'ffprobe.exe');
  const r = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  const d = parseFloat((r.stdout || '').trim());
  return Number.isFinite(d) ? d : 0;
}

/** 这个文件有没有音轨 —— H3 的片段自带音频，混音时要把它算进去。 */
function probeHasAudio(file) {
  const ffprobe = FFMPEG.replace(/ffmpeg\.exe$/i, 'ffprobe.exe');
  const r = spawnSync(ffprobe, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return (r.stdout || '').includes('audio');
}

/** 视频流自己的时长 —— 混音时用它当 `-t`，比 `-shortest` 可靠。 */
function probeVideoDuration(file) {
  const ffprobe = FFMPEG.replace(/ffmpeg\.exe$/i, 'ffprobe.exe');
  const r = spawnSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  const d = parseFloat((r.stdout || '').trim());
  return Number.isFinite(d) && d > 0 ? d : probeDuration(file);
}

/**
 * 本地估算每镜时长 —— **不调线上 TTS**。
 *
 * 原先这条链是：调线上 cosyvoice 合成音频 → ffprobe 量秒数 → 写 `duration_s`
 * → **音频文件丢掉**（默认音轨用 H3 自己生成的人声）。
 * 等于花钱买了一次"量时长"服务。现在改成纯本地估算（0 元、0 网络）。
 *
 * `--stage tts` 仍在 —— 只在「H3 念得听不清、想改用 TTS 配音」时才需要跑。
 */
function doDurations() {
  let changed = 0;
  for (const shot of board.shots) {
    const lines = shot.dialogue || [];
    if (!lines.length) continue;
    const speech = lines.reduce((a, d) => a + estimateSpeechSeconds(d.text), 0);
    const next = Number(Math.min(15, speech + 0.8).toFixed(2));   // +0.8 呼吸余量（只加这一次）
    if (Math.abs(next - shot.duration_s) > 0.01) changed++;
    shot.duration_s = next;
  }
  board.meta.total_duration_s = Number(board.shots.reduce((a, s) => a + (Number(s.duration_s) || 0), 0).toFixed(2));
  save();
  const tts = board.shots.flatMap((s) => s.dialogue || []).filter((d) => d.audio).length;
  console.log(`本地估时长：${changed} 镜调整，总长 ${board.meta.total_duration_s}s　**0 元、0 网络**`);
  if (tts) console.log(`  （板子上还有 ${tts} 条 TTS 音频，是以前跑 --stage tts 留的；默认音轨不用它）`);
}

/**
 * 配音。**只在你想用 TTS 替掉 H3 人声时才跑。**
 * 默认音轨是 H3 自己生成的（人声+环境音联合建模），所以这一步默认不在流水线上。
 */
async function doTts() {
  const p = provider(process.env.AIH_TTS_PROVIDER || 'bailian');
  if (typeof p.speak !== 'function') {
    console.error(`通道 ${p.name} 不支持配音`);
    process.exitCode = 1;
    return;
  }
  const segs = speechSegments(board);
  if (!segs.length) { console.log('没有台词，不需要配音'); return; }
  const audioDir = DIR.audio;
  fs.mkdirSync(audioDir, { recursive: true });

  // 一个镜头可能有几句台词，音频名字要能区分
  const perShot = new Map();
  for (const s of segs) perShot.set(s.shot_id, (perShot.get(s.shot_id) || 0) + 1);

  let done = 0, failed = 0;
  const spokenSeconds = new Map();
  for (const [i, seg] of segs.entries()) {
    const name = perShot.get(seg.shot_id) > 1 ? `${seg.shot_id}_${seg.index}.mp3` : `${seg.shot_id}.mp3`;
    const out = path.join(audioDir, name);
    // 情绪 → 语速/音高（当前音色模型不支持 --instruction，详见 orchestrate.emotionToProsody）
    const prosody = emotionToProsody(seg.emotion, seg.kind);
    console.log(`[${i + 1}/${segs.length}] ${seg.shot_id} 配音…（${seg.name}，${seg.voice}，语速 ${prosody.rate}）`);
    const r = await p.speak({ text: seg.text, out, voice: seg.voice, rate: prosody.rate, pitch: prosody.pitch });
    if (!r.ok) {
      failed++;
      console.error(`    ✗ 失败：${(r.stderr || '').slice(0, 240)}`);
      continue;
    }
    const seconds = probeDuration(out);
    // 回填到那句台词上 —— 并挪到 `audio/<镜号>.mp3`（按镜号，不是时间戳）
    const shot = board.shots.find((s) => s.id === seg.shot_id);
    if (shot && shot.dialogue && shot.dialogue[seg.index]) {
      const placed = place(out, DIR.audio, seg.shot_id);
      shot.dialogue[seg.index].audio = toRelative(placed || out);
    }
    spokenSeconds.set(seg.shot_id, (spokenSeconds.get(seg.shot_id) || 0) + seconds);
    done++;
    save();
    console.log(`    -> ${toRelative(out)}  ${seconds.toFixed(2)}s`);
  }

  // **时长由音频反推**
  for (const shot of board.shots) {
    const sec = spokenSeconds.get(shot.id);
    if (sec === undefined) continue;
    const before = shot.duration_s;
    shot.duration_s = Number(durationForSpeech(sec).toFixed(2));
    if (Math.abs(before - shot.duration_s) > 0.01) {
      console.log(`    ${shot.id} 时长 ${before}s → ${shot.duration_s}s（配音 ${sec.toFixed(2)}s + 呼吸）`);
    }
  }
  const total = board.shots.reduce((a, s) => a + (Number(s.duration_s) || 0), 0);
  board.meta.total_duration_s = Number(total.toFixed(2));
  save();
  console.log(`配音 ${done}/${segs.length}（失败 ${failed}）　新总时长 ${board.meta.total_duration_s}s`);
}

// ------------------------------------------------------------------- clips

/** 图片风格 → H3 官方风格标签（英文，放画面描述最前面）。 */
const H3_STYLE_TAG = {
  realistic: 'Live-action, cinematic and photorealistic',
  anime: '2D-animated, anime style with soft cel shading and warm color grading',
  cyberpunk: 'Live-action, neon-noir cyberpunk aesthetic',
  healing: 'Warm soft lighting, healing aesthetic with delicate detail',
  vintage: 'Vintage film, grainy warm-toned',
};

/**
 * 按 H3 官方三段式自己拼提示词。
 *
 * 必须配 `--no-shell`：内置预设会把 camera 和 soundscape 两段写死
 * （cinematic 的 camera 是"固定机位"，soundscape 是"轻环境音、无对白"），
 * 那正好盖掉分镜里最值钱的两样东西 —— 运镜和音效。
 * 官方规范：镜头运动写"运动"不写形容词；音效不显式写就只有 -50 dB 的一层轻环境音。
 */
function buildClipPrompt(board, shot) {
  // 提示词按 **H3 官方格式**组装（台词进 <d>、环境音不重复台词、带 I2VA 对齐指令）。
  // 全部逻辑在 assets.mjs 的 h3Prompt() 里，那样才能写纯函数验收。
  return h3Prompt(board, shot);
}

function doClips() {
  // **关键帧确认过才允许出片** —— 关键帧不对，14 个片段（约 11 分钟算力）全是白烧。
  requireGate('rendering', '要出片段，得先确认过关键帧 —— 片段就是从关键帧动起来的');
  const style = board.meta.style || 'realistic';
  // 逐行编译器给所有镜头都写了 cut —— 整片 14 个硬切不叫"没做转场"，叫**没做剪辑**。
  // 除非显式要保留手工设置，否则按规则重算一遍。
  if (!argv.includes('--keep-transitions')) {
    const { changed } = applyTransitions(board);
    if (changed) {
      save();
      console.log(`转场重算：${changed} 处需要调整`);
      for (const s of board.shots) console.log(`  ${s.id} ${s.transition.type}　${s.transition.note}`);
    }
  }
  const plan = flfPlan(board);
  const byId = new Map(plan.map((p) => [p.shot_id, p]));

  board.shots.forEach((shot, index) => {
    if (!wanted(shot)) return;
    if (shot.clip && !force) {
      console.log(`[${index + 1}/${board.shots.length}] ${shot.id} 已有片段，跳过`);
      return;
    }
    const item = byId.get(shot.id);
    const prompt = buildClipPrompt(board, shot);
    // 时长由配音反推过就用它；落到 17k+5 网格上，免得引擎拒
    const seconds = framesFor(Number(shot.duration_s) || 5) / 24;
    // HQ：分辨率 2.5 倍、不省步数。成品该用这个；探构图时用默认的更省时间。
    const sz = HQ ? ['--width', String(OUT_SIZE.w), '--height', String(OUT_SIZE.h)] : [];
    const qf = HQ ? [] : ['--fast'];

    console.log(`[${index + 1}/${board.shots.length}] ${shot.id} 出片…（${item.mode}，${seconds.toFixed(2)}s）`);
    const started = Date.now();
    let args;
    if (item.mode === 'fl2v' && item.first && item.last) {
      // **下一镜的首帧当本镜尾帧** —— 画面真的"走到"下一镜的起点，衔接比链式传递自然
      args = ['fl2v', '--image', toAbsolute(item.first), '--last-image', toAbsolute(item.last),
        '--prompt', prompt, '--duration', String(seconds), ...sz, ...qf, '--no-shell'];
    } else if (item.first) {
      args = ['i2v', '--image', toAbsolute(item.first), '--prompt', prompt,
        '--duration', String(seconds), ...sz, ...qf, '--no-shell'];
    } else {
      args = ['t2v', '--prompt', prompt, '--duration', String(seconds), ...sz, ...qf,
        '--ratio', ASPECT, '--style', style, '--no-shell'];
    }
    const result = runGen(args);
    const produced = firstFile(result);
    if (!produced) {
      console.error(`    ✗ ${item.why}｜出片失败`);
      return;
    }
    // **挪到 `clips/<镜号>.mp4`** —— 生成器给的是 `i2v_20260915-112411.mp4` 这种时间戳名，
    // 光看文件名对不上镜号，只能翻板子。
    // 注意用 `shot.id`：片段任务对象（`flfPlan` 的产出）里字段叫 `shot_id`，**没有 `id`** ——
    // 写 `item.id` 会静默生成 `undefined.mp4`，然后每个镜头互相覆盖（踩过）。
    const placed = place(produced, DIR.clips, shot.id);
    shot.clip = toRelative(placed || produced);
    save();
    console.log(`    -> ${shot.clip}  (${Math.round((Date.now() - started) / 1000)}s)`);
  });
}

// ---------------------------------------------------------------- assemble

function doAssemble() {
  requireGate('rendering', '要拼成片，得先确认过关键帧');
  const missing = board.shots.filter((s) => !s.clip);
  if (missing.length) {
    console.error(`还差 ${missing.length} 个片段：${missing.map((s) => s.id).join('、')}`);
    process.exitCode = 1;
    return;
  }
  // 时间轴与字幕都由**实际时长**推出来，不是另算一遍
  const durations = Object.fromEntries(board.shots.map((s) => [s.id, s.duration_s]));
  const tl = buildTimeline(board, durations);
  const srtPath = path.join(DIR.out, 'final.srt');
  if (tl.srt.trim()) {
    fs.writeFileSync(srtPath, tl.srt, 'utf8');
    console.log(`字幕 -> ${toRelative(srtPath)}（${tl.srt.trim().split('\n\n').length} 条）`);
  }

  const listFile = path.join(DIR.tmp, '_concat.txt');
  fs.writeFileSync(listFile, board.shots.map((s) => `file '${toAbsolute(s.clip).replace(/'/g, "'\\''")}'`).join('\n') + '\n');
  const output = path.join(DIR.out, 'final.mp4');
  // 逐镜 mux 配音后再拼：直接 concat 会把音频甩掉
  const withAudio = path.join(DIR.tmp, '_withaudio');
  fs.mkdirSync(withAudio, { recursive: true });
  // ---- 字幕带裁切：**默认关掉** ----
  //
  // 这里曾经默认裁掉底部 13%，理由是「H3 会把对白烧成字幕、压不住」。
  // **那个结论复现不出来。** 复盘时把工作区所有旧片段都扫了一遍：
  //   8 个片段各抽 1 帧看中部  → 无字幕
  //   最早那批看底部 28%（放大）→ 无字幕
  //   s05 最长镜（12.7 秒）全时段 12 帧 → 无字幕
  //
  // 而且按官方格式修好提示词之后，字幕更没有出现的理由：官方规范是**显式声明制**
  // （屏上文字必须用引号写出来才会出现），而台词走的是 `<d>` 结构标记。
  //
  // **一个没被证实的 13% 裁切，比一个假想的字幕更糟** —— 它每镜都切掉画面再拉伸。
  // 所以默认不裁；真要裁时显式加 `--crop-caption`。
  const cropCaption = argv.includes('--crop-caption');
  const CAPTION_BAND = 0.13;
  const parts = [];
  // ---- 音轨从哪来 ----
  // H3 是**音视频联合建模**的：对白写进 `overall_soundscape` 之后，它自己就会把人声生成出来。
  // 实测一个带台词的片段，包络 P10 −81 dB / P90 −10 dB / 波动 27 dB —— 这是语音的签名
  // （音节之间的停顿），不是环境底噪。
  //
  // 所以再叠一层 TTS，就变成**两个人在说同一句话**。
  // 默认只留 H3（人声和环境音本来就是一起建模出来的，天然同步）；
  // 只有 H3 念得听不清时，才用 `--tts` 换成 TTS。
  const audioMode = argv.includes('--tts') ? 'tts' : (argv.includes('--mix') ? 'mix' : 'h3');
  console.log(`音轨：${audioMode === 'h3' ? 'H3 自己的（人声+环境音联合生成）' : audioMode === 'tts' ? 'TTS 配音' : 'H3 + TTS 两层（会听到两个声音）'}`);

  for (const shot of board.shots) {
    const tts = (shot.dialogue || []).map((d) => d.audio).filter(Boolean)[0];
    const part = path.join(withAudio, `${shot.id}.mp4`);
    const args = ['-y', '-i', toAbsolute(shot.clip)];
    const clipHasAudio = probeHasAudio(toAbsolute(shot.clip));
    const LOUD = 'loudnorm=I=-16:TP=-1.5:LRA=11';

    if (audioMode === 'h3' || !tts) {
      if (clipHasAudio) {
        args.push('-filter_complex', `[0:a]${LOUD},apad[a]`, '-map', '0:v:0', '-map', '[a]');
      } else {
        args.push('-map', '0:v:0');
      }
    } else {
      args.push('-i', toAbsolute(tts));
      if (audioMode === 'mix' && clipHasAudio) {
        // **amix 默认把每路除以路数**（两路就减半），所以显式 normalize=0。
        // 注意：H3 已经在念台词了，这一档会听到两个声音说同一句 —— 只在排查时用。
        args.push('-filter_complex',
          `[0:a]volume=0.35[h3];[1:a]volume=1.0[tts];[h3][tts]amix=inputs=2:duration=longest:normalize=0,${LOUD},apad[a]`,
          '-map', '0:v:0', '-map', '[a]');
      } else {
        args.push('-filter_complex', `[1:a]${LOUD},apad[a]`, '-map', '0:v:0', '-map', '[a]');
      }
    }

    args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-pix_fmt', 'yuv420p');
    // **音频参数必须逐段统一**：采样率不一致时用 `-c copy` 拼出来的 AAC 比特流是**坏的**
    // （播放器读得出时长，解码器满屏报错，听上去就是没声音）。这个 bug 是靠人耳发现的。
    args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2');
    // **用显式 `-t` 收尾，不用 `-shortest`**：`apad` 是无限音频流，配 `-shortest` 会死锁。
    args.push('-t', probeVideoDuration(toAbsolute(shot.clip)).toFixed(3));
    if (cropCaption) {
      // **H3 会把对白当字幕烧进画面**（实测：否定句"不出现字幕"没用，肯定句"画面干净"也没用，
      // 而且字会写错——「你果然是个木头」糊成「你然是个头」）。
      // 这是模型行为，压不住，只能在后期裁掉那一条。
      // 裁掉底部再拉回原尺寸 —— 短剧在手机上看，这点纵向拉伸看不出来。
      args.push('-vf', `crop=iw:ih*${(1 - CAPTION_BAND).toFixed(3)}:0:0,scale=${OUT_SIZE.w}:${OUT_SIZE.h}:flags=lanczos`);
    }
    args.push(part);
    if (!runFfmpeg(args)) {
      console.error(`  ${shot.id} 混音失败，退回无声画面`);
      if (!runFfmpeg(['-y', '-i', toAbsolute(shot.clip), '-c', 'copy', part])) continue;
    }
    parts.push(part);
  }
  fs.writeFileSync(listFile, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
  const ok = runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', output]);
  if (!ok) { console.error('拼接失败'); process.exitCode = 1; return; }
  board.meta.final_video = toRelative(output);
  board.meta.stage = 'done';
  save();
  console.log(`成片 -> ${board.meta.final_video}　时长 ${tl.total_seconds.toFixed(2)}s`);
  console.log(`  时间轴：${tl.total_frames} 帧（各镜之和，逐镜对齐到 17k+5 网格）`);

  // **自检不过，不算成功。** "文件存在"不等于"成片能看" ——
  // 曾经这里报"成功"，而音轨是坏的，是用户用耳朵发现的。
  const rv = review(toAbsolute(board.meta.final_video), {
    expectSeconds: tl.total_seconds,
    toleranceFrames: 3,
    srt: tl.srt.trim() ? srtPath : null,
    expectSubtitles: tl.srt.trim() ? tl.srt.trim().split('\n\n').length : 0,
  });
  console.log(`\n成片自检：${rv.pass ? '✓ 通过' : '✗ 不通过'}`);
  console.log(`  ${rv.info.size_mb} MB　${rv.info.duration?.format?.toFixed(2)}s　${rv.info.duration?.frames} 帧　解码报错 ${rv.info.decode_errors}`);
  if (rv.info.loudness) console.log(`  音频 mean ${rv.info.loudness.mean} dB / max ${rv.info.loudness.max} dB　(${rv.info.audio?.sample_rate}Hz ${rv.info.audio?.channels}ch)`);
  console.log(`  抽帧亮度 ${(rv.info.frame_luma || []).join(' / ')}${rv.info.subtitle_count !== undefined ? `　字幕 ${rv.info.subtitle_count} 条` : ''}`);
  for (const w of rv.warns) console.log(`  warning: ${w}`);
  for (const f of rv.fails) console.log(`  ERROR: ${f}`);
  if (!rv.pass) {
    console.error('\n**自检不过，这部片子不算交付。**');
    process.exitCode = 1;
  }
}

// -------------------------------------------------------------------- main

const assetSlots = [
  ...(board.characters || []).map((c) => [c, 'portrait']),
  ...(board.identities || []).map((x) => [x, 'sheet']),
  ...(board.scenes || []).flatMap((s) => [[s, 'master'], [s, 'reverse_master'], [s, 'spatial_layout']]),
  ...(board.props || []).map((p) => [p, 'ref_image']),
];

if (stage === 'assets' || stage === 'all') {
  if (argv.includes('--plan')) {
    const plan = assetPlan(board, { sceneExtras });
    const p = assetProvider();
    console.log(`资产计划（通道 ${p.name}）：`);
    for (const [i, j] of plan.entries()) {
      const state = j.target[j.slot] ? '已有' : '待出';
      const refs = refsOf(j).map(resolveRef).filter(Boolean).length;
      console.log(`  ${String(i + 1).padStart(2)}. ${j.kind.padEnd(14)} ${j.id.padEnd(30)} ${j.mode.padEnd(8)} ${j.size.padEnd(5)} refs=${refs}  ${state}`);
    }
    console.log(`\n共 ${plan.length} 项，已有 ${plan.filter((j) => j.target[j.slot]).length} 项`);
  } else if (argv.includes('--adopt')) {
    // 认领磁盘上已有的产物 —— 崩过、或从别处搬回来的情况，别重新烧钱
    const plan = assetPlan(board, { sceneExtras });
    let n = 0;
    for (const j of plan) {
      if (j.target[j.slot]) continue;
      const guess = path.join(DIR.assets, j.id + '_' + j.slot + '.png');
      if (fs.existsSync(guess)) {
        j.target[j.slot] = toRelative(guess);
        n++;
        console.log(`  认领 ${j.kind.padEnd(14)} ${j.id} -> ${j.target[j.slot]}`);
      }
    }
    save();
    console.log(`认领 ${n} 项，共 ${plan.filter((j) => j.target[j.slot]).length}/${plan.length} 项已有`);
  } else {
    await doAssets();
  }
}
if (stage === 'durations' || stage === 'all') doDurations();
if (stage === 'keyframes' || stage === 'all') await doKeyframes();
if (stage === 'contact') {
  // 只看图、不生成：把已经有的资产和关键帧摆到人面前。
  // 已经跑过的阶段也能重摆一次，方便反复审阅。
  const plan = assetPlan(board, { sceneExtras });
  presentForReview('资产（人物肖像 / 身份图 / 场景 / 道具）',
    plan.filter((j) => j.target[j.slot]).map((j) => ({ path: j.target[j.slot], label: `${j.kind.padEnd(14)} ${j.id}` })),
    'assets_review.jpg', 'assets', 4);
  presentForReview('关键帧（逐镜首帧）',
    board.shots.filter((s) => s.first_frame).map((s) => ({
      path: s.first_frame,
      label: `${s.id}  ${s.shot_size}  ${s.duration_s}s  ${(s.dialogue || [])[0] ? '「' + (s.dialogue[0].text || '').slice(0, 14) + '」' : '（无台词）'}`,
    })), 'keyframes_review.jpg', 'keyframes', 4);
}
// **tts 不在 all 里了** —— 默认音轨用 H3 自己生成的，配音只在 --stage tts 时跑
if (stage === 'tts') await doTts();
if (stage === 'clips' || stage === 'all') doClips();
if (stage === 'assemble' || stage === 'all') doAssemble();

const assetDone = assetSlots.filter(([o, k]) => o[k]).length;
const frameDone = board.shots.filter((s) => s.first_frame).length;
const clipDone = board.shots.filter((s) => s.clip).length;
console.log(`\n资产 ${assetDone}/${assetSlots.length}　关键帧 ${frameDone}/${board.shots.length}　片段 ${clipDone}/${board.shots.length}`);
if (board.meta.final_video) console.log(`成片 ${board.meta.final_video}`);

// ---- 这一趟花了多少 ----
const thisRun = ledger.since(costMark);
if (thisRun.length) {
  console.log('\n' + formatSummary(summarize(thisRun)));
  console.log(`\n  账本累计 ${ledger.entries.length} 笔，共 ${summarize(ledger.entries).total.toFixed(3)} 元`);
} else {
  console.log('\n这一趟没有线上调用，花了 0 元（全是本地）。');
}
