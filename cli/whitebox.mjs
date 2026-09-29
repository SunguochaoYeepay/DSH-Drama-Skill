#!/usr/bin/env node
/**
 * whitebox.mjs — 白膜预演入口：校验 → 静帧预检 → 全量渲染 三段式。
 *
 * 白膜管线的定位（2026-09-28 起，分支 whitebox-pipeline）：
 * 剧本里「运动能表示为刚体轨迹」的复杂时空关系（多人走位/机位同步/时序因果），
 * 由 AI 填一份 whitebox/1 规划 JSON（规范：references/whitebox-json.md），
 * 本入口交给 Blender 渲成白膜视频 + 静帧 + 期望屏幕坐标表，喂给 H3 当 control_video。
 * AI 只填表：资产与动作只能从 vendor/whitebox-assets/manifest.json 的菜单里选，
 * 菜单外一律拒（禁止编造）。
 *
 * 用法：
 *   node cli/whitebox.mjs validate <plan.json>                          # 只校验，不渲染
 *   node cli/whitebox.mjs stills  <plan.json> [--out <dir>] [--diag]    # 静帧预检（先确认构图再渲全片）
 *   node cli/whitebox.mjs render  <plan.json> [--out <dir>] [--timeout 1800] [--diag] [--dry-run]
 *                                 [--no-framing-check]
 *
 * 退出码：0 通过；1 校验失败 / 渲染失败 / 取景预检未通过；2 用法错误。
 * 依赖：渲染需要 .env 里配 AIH_BLENDER（doctor 的可选项）；validate 不需要 Blender。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PROJECT_ROOT } from '../src/config.mjs';
import { BLENDER, FFMPEG, requireBlender } from '../src/runtime-paths.mjs';
import { loadMenu, validateWhitebox } from '../src/whitebox-schema.mjs';
import { analyzeFraming, formatFraming } from '../src/whitebox-framing.mjs';
import { installCliErrorHandler } from '../src/cli-errors.mjs';

installCliErrorHandler();

const argv = process.argv.slice(2);
const flagAll = (name) => argv.reduce((acc, a, i) => (a === `--${name}` && argv[i + 1] ? [...acc, argv[i + 1]] : acc), []);
const flag = (name, dflt = null) => flagAll(name)[0] ?? dflt;
const has = (name) => argv.includes(`--${name}`);

const USAGE = `用法：
  node cli/whitebox.mjs validate <plan.json>
  node cli/whitebox.mjs stills  <plan.json> [--out <dir>] [--diag]
  node cli/whitebox.mjs render  <plan.json> [--out <dir>] [--timeout 1800] [--diag] [--dry-run] [--no-framing-check]

渲染/静帧结束后会自动读取景预检（角色出框 / 贴边 / 该动的没动），未通过则按失败处理。
只在刻意为之（例如主角就是要跑出画面）时用 --no-framing-check 跳过。`;

const command = argv[0];
const planFile = argv.find((a, i) => i > 0 && !a.startsWith('--') && /\.json$/i.test(a));
if (!['validate', 'stills', 'render'].includes(command) || !planFile) {
  console.error(USAGE);
  process.exit(2);
}

const DRY = has('dry-run');
const DIAG = has('diag');
const timeoutMs = Number(flag('timeout', 1800)) * 1000;
const RENDER_SCRIPT = path.join(PROJECT_ROOT, 'lab', 'whitebox', 'whitebox_render.py');
const ASSETS_DIR = process.env.AIH_WHITEBOX_ASSETS
  || path.join(PROJECT_ROOT, 'vendor', 'whitebox-assets');

// ---------- 第 1 段：校验（三个子命令共享，校验不过绝不渲染） ----------
const planPath = path.resolve(planFile);
const doc = JSON.parse(fs.readFileSync(planPath, 'utf8'));
const menu = loadMenu(ASSETS_DIR);
const errors = validateWhitebox(doc, menu);

if (errors.length) {
  console.error(`✗ 白膜规划校验未通过（${errors.length} 处）：${path.basename(planPath)}`);
  for (const e of errors) console.error(`  · ${e}`);
  process.exit(1);
}
const scene = doc.scene_name;
const chars = doc.assets.filter((a) => a.kind === 'character').length;
const props = doc.assets.filter((a) => a.kind === 'prop').length;
console.log(`✓ 校验通过：${scene}（${doc.total_frames} 帧 @${doc.fps}fps，角色 ${chars}、道具 ${props}、相机 ${doc.camera.type}）`);
if (command === 'validate') process.exit(0);

// ---------- 输出目录：默认 <plan 所在目录>/out/whitebox/<scene>（lab/**/out/ 与 projects/ 均已 gitignore） ----------
const outDir = path.resolve(flag('out', path.join(path.dirname(planPath), 'out', 'whitebox', scene)));

// ---------- 组装真正要执行的两条命令（dry-run 打印的就是它们） ----------
const blenderArgs = ['-b', '--python', RENDER_SCRIPT, '--', planPath, '--out', outDir];
if (command === 'stills') blenderArgs.push('--stills-only');
const mp4 = path.join(outDir, `${scene}.mp4`);
const ffmpegArgs = ['-y', '-framerate', String(doc.fps), '-i', path.join(outDir, 'frames', 'f_%04d.png'),
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', mp4];

if (DRY) {
  console.log('干跑：不执行，真正会跑的是下面两条 ——');
  console.log(`  [1/2] ${BLENDER || '(AIH_BLENDER 未配)'}`);
  for (const a of blenderArgs) console.log(`        ${a}`);
  if (command === 'render') {
    console.log(`  [2/2] ${FFMPEG}`);
    for (const a of ffmpegArgs) console.log(`        ${a}`);
  }
  process.exit(0);
}

// ---------- 第 2 段：Blender 渲染 ----------
// stdio 用 inherit：本机沙箱拦管道型 stdio（EBUSY），且 Blender 自己的进度条要直接让人看见。
const blender = requireBlender();
console.log(`[1/${command === 'render' ? 2 : 1}] Blender 渲染${command === 'stills' ? '（仅静帧预检）' : ''} → ${outDir}`);
const t0 = Date.now();
const r1 = spawnSync(blender, blenderArgs, {
  stdio: 'inherit',
  timeout: timeoutMs,
  windowsHide: true,
  env: DIAG ? { ...process.env, WB_DIAG: '1' } : process.env,
});
if (r1.error || r1.status !== 0) {
  console.error(`✗ Blender 渲染失败（${r1.error ? r1.error.code || r1.error.message : `退出码 ${r1.status}`}）。`);
  if (r1.error && r1.error.code === 'ETIMEDOUT') console.error(`  已超 --timeout ${timeoutMs / 1000}s 上限被中断；大场景请加大 --timeout。`);
  process.exit(1);
}
console.log(`  渲染完成（${((Date.now() - t0) / 1000).toFixed(0)} 秒）`);

if (command === 'render') {
  // ---------- 第 3 段：ffmpeg 封装 mp4（Blender 5.2 本机编译版无 FFMPEG 输出格式，走外部封装） ----------
  console.log(`[2/2] ffmpeg 封装 → ${mp4}`);
  const r2 = spawnSync(FFMPEG, ffmpegArgs, { stdio: 'inherit', timeout: timeoutMs, windowsHide: true });
  if (r2.error || r2.status !== 0) {
    console.error('✗ ffmpeg 封装失败；PNG 序列已渲好，可手工封装：');
    console.error(`  ${FFMPEG} ${ffmpegArgs.join(' ')}`);
    process.exit(1);
  }
}

// ---------- 交付清单 ----------
const deliverables = [];
if (command === 'render' && fs.existsSync(mp4)) deliverables.push(mp4);
for (const f of fs.readdirSync(outDir)) {
  if (/^still_f\d+\.png$/.test(f)) deliverables.push(path.join(outDir, f));
}
const coords = path.join(outDir, 'coords.json');
if (fs.existsSync(coords)) deliverables.push(coords);
console.log(`✓ 白膜产物 ${deliverables.length} 个：`);
for (const f of deliverables) console.log(`  · ${f}`);

// ---------- 取景预检：coords.json 从「给人查的表」升级成「机器闸门」 ----------
// 2026-09-29 的教训：subway 渲完才发现主角全程贴左缘、中途出画，核心动作读不出来，
// 而坐标表现成写着这件事。现在渲染完自动断言，不过就拒掉，不许往下喂 H3。
if (fs.existsSync(coords)) {
  if (has('no-framing-check')) {
    console.log('· 取景预检：被 --no-framing-check 跳过（明知某资产要出画时才用它）。');
  } else {
    const report = analyzeFraming(doc, JSON.parse(fs.readFileSync(coords, 'utf8')));
    for (const line of formatFraming(report)) console.log(line);
    if (!report.ok) {
      console.error(`✗ 白膜取景预检未通过（${report.findings.length} 处）；改动颁发不合格，请先改规划 JSON 再渲。`);
      console.error(`  确认这些点都是刻意的，用 --no-framing-check 重跑跳过。`);
      process.exit(1);
    }
  }
}

// 规划文件名符合 `<剧目>/units/<单元 id>.whitebox.json` 约定时，顺手把确认命令打出来
// （闸门按单元认白膜，票绑的就是这份 JSON）。lab 里的试验文件不打，免得给错提示。
const match = /^(.+)\.whitebox\.json$/.exec(path.basename(planPath));
const unitsDir = path.dirname(planPath);
if (match && path.basename(unitsDir) === 'units') {
  const projectDir = path.dirname(unitsDir);
  const unitId = match[1];
  console.log(`\n人工确认（看完静帧/视频后）：`);
  console.log(`  node cli/review-gate.mjs approve --project "${projectDir}" --stage whitebox --id ${unitId}`);
}
