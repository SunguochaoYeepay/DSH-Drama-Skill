import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const HANDOFF_VERSION = 1;

export function fileSha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function handoffPath(projectDir, unitId) {
  return path.join(projectDir, 'handoffs', `${unitId}.handoff.json`);
}

function insideProject(projectDir, file) {
  const rel = path.relative(path.resolve(projectDir), path.resolve(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function createHandoffRecord({ projectDir, unit, sourceUnit, sourceClip, stableFrame, tailOffsetS }) {
  if (!['reference_previous', 'continue_previous'].includes(unit.continuity?.mode)) throw new Error(`${unit.id}: 不是需要上一段尾帧参考的单元`);
  if (unit.continuity.previous_unit !== sourceUnit) throw new Error(`${unit.id}: 导演指定承接 ${unit.continuity.previous_unit}，不能绑定 ${sourceUnit}`);
  for (const file of [sourceClip, stableFrame]) {
    if (!fs.existsSync(file)) throw new Error(`交接产物不存在：${file}`);
    if (!insideProject(projectDir, file)) throw new Error(`拒绝跨项目交接产物：${file}`);
  }
  return {
    version: HANDOFF_VERSION,
    project: path.resolve(projectDir),
    unit: unit.id,
    source_unit: sourceUnit,
    handoff_state: unit.continuity.handoff_state,
    allowed_changes: [...(unit.continuity.allowed_changes || [])],
    source_clip: path.resolve(sourceClip),
    source_clip_sha256: fileSha256(sourceClip),
    stable_frame: path.resolve(stableFrame),
    stable_frame_sha256: fileSha256(stableFrame),
    tail_offset_s: Number(tailOffsetS),
    keyframe: null,
    keyframe_sha256: null,
    created_at: new Date().toISOString(),
  };
}

export function writeHandoff(projectDir, record) {
  const file = handoffPath(projectDir, record.unit);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n', 'utf8');
  return file;
}

export function bindHandoffKeyframe(projectDir, unit, keyframe) {
  const record = requireHandoff(projectDir, unit, { requireKeyframe: false });
  if (!insideProject(projectDir, keyframe)) throw new Error(`拒绝绑定跨项目关键帧：${keyframe}`);
  record.keyframe = path.resolve(keyframe);
  record.keyframe_sha256 = fileSha256(keyframe);
  record.keyframe_bound_at = new Date().toISOString();
  writeHandoff(projectDir, record);
  return record;
}

export function requireHandoff(projectDir, unit, { requireKeyframe = true } = {}) {
  if (!['reference_previous', 'continue_previous'].includes(unit.continuity?.mode)) return null;
  const file = handoffPath(projectDir, unit.id);
  if (!fs.existsSync(file)) throw new Error(`${unit.id}: 缺少实际尾帧交接凭证，必须等 ${unit.continuity.previous_unit} 生成并人工确认后再准备关键帧`);
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (record.version !== HANDOFF_VERSION || record.project !== path.resolve(projectDir) || record.unit !== unit.id) throw new Error(`${unit.id}: 交接凭证不属于当前项目或单元`);
  if (record.source_unit !== unit.continuity.previous_unit) throw new Error(`${unit.id}: 交接来源与导演方案不符`);
  if (unit.continuity.mode === 'continue_previous' && record.handoff_state !== unit.continuity.handoff_state) throw new Error(`${unit.id}: 导演交接状态已变化，旧凭证失效`);
  for (const [label, filePath, expected] of [
    ['上一段视频', record.source_clip, record.source_clip_sha256],
    ['稳定尾帧', record.stable_frame, record.stable_frame_sha256],
  ]) {
    if (!filePath || !insideProject(projectDir, filePath) || !fs.existsSync(filePath) || fileSha256(filePath) !== expected) throw new Error(`${unit.id}: ${label} 已变化、缺失或来自其他项目，交接凭证失效`);
  }
  if (requireKeyframe) {
    if (!record.keyframe || !insideProject(projectDir, record.keyframe) || !fs.existsSync(record.keyframe) || fileSha256(record.keyframe) !== record.keyframe_sha256) throw new Error(`${unit.id}: 下一关键帧未绑定实际稳定尾帧，或文件已变化`);
  }
  return record;
}
