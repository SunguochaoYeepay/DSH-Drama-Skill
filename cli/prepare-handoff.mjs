#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { allowedChangesList, createHandoffRecord, writeHandoff } from '../src/continuity-handoff.mjs';
import { clipResultPath, requireApproval, writeReviewNote } from '../src/human-gates.mjs';
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
const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
const clip = (result.files || []).map((x) => typeof x === 'string' ? x : x?.local_path || x?.path).find((x) => x && fs.existsSync(x));
if (!clip) throw new Error(`上一段 ${sourceUnit} 没有有效视频产物`);
requireApproval(project, 'clip', [clip], { id: sourceUnit, skip: SKIP_GATE });

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
const recordFile = writeHandoff(project, record);
const note = writeReviewNote(project, `handoff-${unitId}`, [
  `# 连续性交接 ${sourceUnit} -> ${unitId}`, '',
  `导演要求继承：${unit.continuity.handoff_state}`, `只允许变化：${allowedChangesList(unit.continuity.allowed_changes).join('、') || '无'}`, '',
  `稳定尾帧：${frame}`, `交接凭证：${recordFile}`, '',
  '请人工确认该帧能代表上一段结束的稳定状态。确认后，才生成下一关键帧。',
  `确认命令：node cli/review-gate.mjs approve --project "${project}" --stage handoff --id ${unitId} --artifacts "${frame}"`,
]);
console.log(`已提取待确认的稳定尾帧：${frame}\n等待人工审阅：${note}`);
