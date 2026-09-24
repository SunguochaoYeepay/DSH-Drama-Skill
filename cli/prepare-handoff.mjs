#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { allowedChangesList, carryOverKeyframeBinding, createHandoffRecord, handoffPath, writeHandoff } from '../src/continuity-handoff.mjs';
import { clipArtifactFiles, clipResultPath, primaryClipFile, requireApproval, writeReviewNote } from '../src/human-gates.mjs';
import { installCliErrorHandler } from '../src/cli-errors.mjs';

installCliErrorHandler();
import { WINGET_PACKAGES } from '../src/runtime-paths.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
const planFile = path.resolve(flag('plan', 'render.plan.json'));
const project = path.dirname(planFile);
const unitId = flag('unit');
const offset = Number(flag('tail-offset', '0.35'));
const SKIP_GATE = argv.includes('--skip-gate');
if (!unitId || !Number.isFinite(offset) || offset <= 0) throw new Error('用法：node cli/prepare-handoff.mjs --plan <render.plan.json> --unit <下一单元> [--tail-offset 0.35] [--skip-gate]');
const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
const unit = (plan.units || []).find((x) => x.id === unitId);
if (!unit || !['reference_previous', 'continue_previous'].includes(unit.continuity?.mode)) throw new Error(`${unitId}: 不是导演标记的前段尾帧参考单元`);
const sourceUnit = unit.continuity.previous_unit;
const resultFile = clipResultPath(project, sourceUnit);
if (!resultFile) throw new Error(`上一段 ${sourceUnit} 尚未生成`);
// 尾帧从**主产物**截（第一条），但票要绑**这一段当前的全部产物** —— 两者的所有者
// 都在 `src/human-gates.mjs`。这里过去只绑第一条，于是同一张 clip 票在
// `cli/unit.mjs`（绑全部）通过、到这里却被判"产物已变化"（2026-09-24 实测）。
const clip = primaryClipFile(project, sourceUnit);
if (!clip) throw new Error(`上一段 ${sourceUnit} 没有有效视频产物`);
requireApproval(project, 'clip', clipArtifactFiles(project, sourceUnit), { id: sourceUnit, skip: SKIP_GATE });

let ffmpeg = 'ffmpeg';
try {
  for (const dir of fs.readdirSync(WINGET_PACKAGES)) if (dir.startsWith('Gyan.FFmpeg_')) {
    const candidate = path.join(WINGET_PACKAGES, dir, 'ffmpeg-7.1.1-full_build', 'bin', 'ffmpeg.exe');
    if (fs.existsSync(candidate)) { ffmpeg = candidate; break; }
  }
} catch { /* PATH fallback */ }
const frame = path.join(project, 'handoffs', `${unitId}.stable-tail.png`);
fs.mkdirSync(path.dirname(frame), { recursive: true });
const extracted = spawnSync(ffmpeg, ['-y', '-v', 'error', '-sseof', `-${offset}`, '-i', clip, '-frames:v', '1', frame], { encoding: 'utf8' });
if (extracted.status !== 0 || !fs.existsSync(frame)) throw new Error(`稳定尾帧提取失败：${String(extracted.stderr || '').slice(0, 300)}`);
const record = createHandoffRecord({ projectDir: project, unit, sourceUnit, sourceClip: clip, stableFrame: frame, tailOffsetS: offset });

// **重跑不冲掉已有绑定**：`createHandoffRecord` 一律把 keyframe 置 null，于是"为了更新
// allowed_changes 再跑一次"会静默解绑 —— 之后 `keyframes` 票只绑得到前一个单元，
// 本单元报「下一关键帧未绑定实际稳定尾帧」（desk_quake 2026-09-22 实测）。
const prevFile = handoffPath(project, unitId);
const prev = fs.existsSync(prevFile) ? JSON.parse(fs.readFileSync(prevFile, 'utf8')) : null;
carryOverKeyframeBinding(prev, record);
if (record.keyframe) console.log(`稳定尾帧未变，沿用上次绑定的关键帧：${record.keyframe}`);
const recordFile = writeHandoff(project, record);
const note = writeReviewNote(project, `handoff-${unitId}`, [
  `# 连续性交接 ${sourceUnit} -> ${unitId}`, '',
  `导演要求继承：${unit.continuity.handoff_state}`, `只允许变化：${allowedChangesList(unit.continuity.allowed_changes).join('、') || '无'}`, '',
  `稳定尾帧：${frame}`, `交接凭证：${recordFile}`, '',
  '请人工确认该帧能代表上一段结束的稳定状态。确认后，才生成下一关键帧。',
  `确认命令：node cli/review-gate.mjs approve --project "${project}" --stage handoff --id ${unitId} --artifacts "${frame}"`,
]);
console.log(`已提取待确认的稳定尾帧：${frame}\n等待人工审阅：${note}`);
