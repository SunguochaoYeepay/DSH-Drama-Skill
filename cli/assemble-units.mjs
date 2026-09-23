#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { clipResultPath, readReviews, requireAllClips, writeReviewNote } from '../src/human-gates.mjs';
import { resolveRecordedPath } from '../src/recorded-path.mjs';
import { installCliErrorHandler } from '../src/cli-errors.mjs';
import { VIDEO_QUALITY, VIDEO_NORMAL_SIZE, VIDEO_HIGH_SIZE } from '../src/config.mjs';
import { aspectOf, dimensionsForAspect } from '../src/aspect.mjs';

installCliErrorHandler();

const argv = process.argv.slice(2);
const planArg = argv.find((x) => /\.json$/i.test(x) && !x.startsWith('--'));
const value = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
if (!planArg) {
  console.error('用法：node cli/assemble-units.mjs <render.plan.json> [--quality normal|high] [--out final.mp4]');
  process.exit(2);
}
const planPath = path.resolve(planArg);
const projectDir = path.dirname(planPath);
const boardPath = path.resolve(value('board', path.join(projectDir, 'board.json')));
const storyPath = path.resolve(value('story', path.join(projectDir, 'story.md')));
const output = path.resolve(value('out', path.join(projectDir, 'out', 'final.mp4')));
const quality = String(value('quality', VIDEO_QUALITY)).toLowerCase();
const sizes = { normal: VIDEO_NORMAL_SIZE, high: VIDEO_HIGH_SIZE };
if (!sizes[quality]) throw new Error(`--quality 只能是 normal / high，收到 ${quality}`);
const board = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
const aspect = aspectOf(board);
const size = dimensionsForAspect(sizes[quality], aspect);
if (!/^\d+x\d+$/.test(size)) throw new Error(`AIH_VIDEO_${quality.toUpperCase()}_SIZE 必须是 WxH，收到 ${size}`);
const [width, height] = size.split('x').map(Number);
if (width <= 0 || height <= 0) throw new Error(`合成尺寸必须大于零，收到 ${size}`);
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
const SKIP_GATE = argv.includes('--skip-gate');
requireAllClips(projectDir, plan, { skip: SKIP_GATE });

const reviews = readReviews(projectDir);
const tmp = path.join(projectDir, '.tmp', 'assemble');
fs.mkdirSync(tmp, { recursive: true });
fs.mkdirSync(path.dirname(output), { recursive: true });
const normalized = [];

// 响度统一（两遍式 loudnorm）。外部实证：单遍 loudnorm 偏离目标 3.7 dB——loudnorm 的
// 设计就是两遍（第一遍测量、第二遍 linear 应用），单遍是动态模式，会漂。逐段归一到
// 同一目标后 concat，段间响度差不再原样进成片。目标值可用环境变量覆盖。
const LOUD = {
  I: String(process.env.AIH_ASSEMBLE_LUFS || '-16'),
  TP: String(process.env.AIH_ASSEMBLE_TP_DB || '-2'),
  LRA: String(process.env.AIH_ASSEMBLE_LRA || '11'),
};
for (const key of ['I', 'TP', 'LRA']) {
  if (!/^-?\d+(\.\d+)?$/.test(LOUD[key])) throw new Error(`响度参数 ${key} 必须是数字，收到 ${LOUD[key]}`);
}

function run(args, label) {
  const result = spawnSync('ffmpeg', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${label} 失败：${String(result.stderr || '').slice(-1200)}`);
}

function hasAudioStream(input) {
  const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries',
    'stream=index', '-of', 'csv=p=0', input], { encoding: 'utf8' });
  if (probe.status !== 0) return false;
  return probe.stdout.trim().length > 0;
}

/** 第一遍：只测量，不写文件。拿到的实测值喂给第二遍的 linear 模式。 */
function measureLoudness(input, label) {
  const r = spawnSync('ffmpeg', ['-v', 'info', '-i', input, '-af',
    `loudnorm=I=${LOUD.I}:TP=${LOUD.TP}:LRA=${LOUD.LRA}:print_format=json`, '-f', 'null', '-'],
  { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${label} 响度测量失败：${String(r.stderr || '').slice(-1200)}`);
  const start = r.stderr.lastIndexOf('{');
  const end = r.stderr.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(r.stderr.slice(start, end + 1)); } catch { return null; }
}

/** 第二遍：linear 模式应用。测量失败（如静音段打出 -inf）时退回单遍动态模式，好过不做。 */
function loudnessFilterArgs(measured) {
  const base = `I=${LOUD.I}:TP=${LOUD.TP}:LRA=${LOUD.LRA}`;
  if (!measured) return ['-af', `loudnorm=${base}`];
  const { input_i, input_tp, input_lra, input_thresh, target_offset } = measured;
  return ['-af', `loudnorm=${base}:measured_I=${input_i}:measured_TP=${input_tp}`
    + `:measured_LRA=${input_lra}:measured_thresh=${input_thresh}`
    + `:offset=${target_offset}:linear=true:print_format=summary`];
}

for (const [index, unit] of plan.units.entries()) {
  const entry = reviews.approvals.clips[unit.id];
  const ticket = entry?.artifact_hash ? entry : entry?.final;
  // 票里的 artifacts 是**展示路径**（多为仓库相对），三种历史写法都由
  // `src/recorded-path.mjs` 统一解析 —— 过去这里直接 `fs.existsSync(input)`，
  // 按 cwd 解析，于是"票上写着、实际找不到"时只能走下面的调试兜底（2026-09-23 实测）。
  // 另：`artifacts` 现在**按签票时给的顺序**记（不再排序），所以 `[0]` 就是当时那条主产物。
  let input = resolveRecordedPath(projectDir, ticket?.artifacts?.[0]);
  if (!input) {
    // 调试模式下没有人工票，回退到该单元的实际产物；正式流程仍必须持有票。
    if (!SKIP_GATE) throw new Error(`${unit.id}: 人工确认票没有可用视频`);
    const resultFile = clipResultPath(projectDir, unit.id);
    const result = resultFile ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : null;
    for (const x of result?.files || []) {
      const p = typeof x === 'string' ? x : (x?.local_path || x?.path);
      input = p ? resolveRecordedPath(projectDir, p) : null;
      if (input) break;
    }
    if (!input) throw new Error(`${unit.id}: 既没有人工确认票，也没有可用视频产物`);
  }
  const out = path.join(tmp, `${String(index + 1).padStart(3, '0')}_${unit.id}.mp4`);
  // H3 的真实口播速度不可由导演估算精确预测。含台词单元保留完整生成片，
  // 否则按 content_duration_s 裁切会把一句话的尾字物理截断。
  const hasDialogue = (unit.shots || []).some((shot) => (shot.lines || []).length > 0);
  const trimArgs = hasDialogue ? [] : ['-t', Number(unit.content_duration_s).toFixed(3)];
  // 响度统一只对有音轨的段生效；无音轨段照常转码（loudnorm 会把无音频段直接弄失败）。
  const loudArgs = hasAudioStream(input) ? loudnessFilterArgs(measureLoudness(input, unit.id)) : [];
  run(['-y', '-v', 'error', '-i', input, ...trimArgs,
    '-vf', `scale=${width}:${height}:flags=lanczos,fps=24,format=yuv420p`,
    ...loudArgs,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
    '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '192k', '-movflags', '+faststart', out], unit.id);
  console.log(`  ${unit.id}: ${hasDialogue ? '含台词，保留完整生成时长' : `无台词，裁到 ${unit.content_duration_s.toFixed(2)}s`}${loudArgs.length ? `，响度归一 ${LOUD.I} LUFS` : '（无音轨，跳过响度归一）'}`);
  normalized.push(out);
}

const listFile = path.join(tmp, 'concat.txt');
fs.writeFileSync(listFile, normalized.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join('\n') + '\n', 'utf8');
run(['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', output], '合成');

const note = writeReviewNote(projectDir, 'final', [
  '# 最终成片人工审阅', '', `成片：${output}`, '',
  '没有机器检查代替你观看。请完整观看台词、节奏、接缝、人物一致性和声音。', '',
  `确认命令：node cli/review-gate.mjs approve --project "${projectDir}" --stage final --artifacts "${output}"`,
]);
console.log(`✓ 合成完成：${output}`);
console.log(`等待最终人工审阅：${note}`);
