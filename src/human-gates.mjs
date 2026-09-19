import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { handoffPath, requireHandoff } from './continuity-handoff.mjs';
import { readGenerationRecord } from './generation-records.mjs';

export const REVIEW_FILE = 'review.approvals.json';

function sha256(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

export function fingerprint(files) {
  const normalized = [...new Set(files.map((f) => path.resolve(f)))].sort();
  if (!normalized.length) throw new Error('审阅票据至少需要一个产物');
  for (const file of normalized) if (!fs.existsSync(file)) throw new Error(`审阅产物不存在：${file}`);
  const h = crypto.createHash('sha256');
  for (const file of normalized) h.update(`${file}\0${sha256(file)}\0`);
  return { hash: h.digest('hex'), files: normalized };
}

export function reviewPath(projectDir) { return path.join(projectDir, REVIEW_FILE); }

export function planKeyframeFiles(projectDir, plan) {
  return (plan.units || []).map((unit) => {
    const handoff = fs.existsSync(handoffPath(projectDir, unit.id)) ? requireHandoff(projectDir, unit) : null;
    const file = handoff?.keyframe || (unit.keyframe && path.resolve(projectDir, unit.keyframe));
    return file && fs.existsSync(file) ? file : null;
  }).filter(Boolean);
}

export function readReviews(projectDir) {
  const file = reviewPath(projectDir);
  if (!fs.existsSync(file)) return { version: 1, approvals: { clips: {} } };
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.approvals ||= {};
  data.approvals.clips ||= {};
  return data;
}

function slot(data, stage, id) {
  if (stage === 'clip') {
    const entry = data.approvals.clips?.[id];
    return entry?.artifact_hash ? entry : entry?.final;
  }
  if (stage === 'handoff') return data.approvals.handoffs?.[id];
  return data.approvals[stage];
}

export function approvalStatus(projectDir, stage, files, id = null) {
  const approval = slot(readReviews(projectDir), stage, id);
  if (!approval) return { ok: false, reason: '尚未人工确认' };
  const current = fingerprint(files);
  if (approval.artifact_hash !== current.hash) return { ok: false, reason: '产物已变化，旧确认自动失效' };
  return { ok: true, approval };
}

export function requireApproval(projectDir, stage, files, { id = null, skip = false } = {}) {
  if (skip) {
    console.error('⚠ --skip-gate：仅限调试，已跳过人工审阅闸门');
    return;
  }
  const status = approvalStatus(projectDir, stage, files, id);
  if (!status.ok) {
    const labels = { story: '剧本', direction: '导演方案', assets: '资源', keyframes: '关键帧', final: '最终成片' };
    const label = stage === 'clip' ? `视频片段 ${id}` : stage === 'handoff' ? `连续性交接 ${id}` : labels[stage] || stage;
    throw new Error(`人工闸门未通过：${label} ${status.reason}。`);
  }
}

export function approve(projectDir, stage, files, { id = null, by = '用户' } = {}) {
  const data = readReviews(projectDir);
  const artifact = fingerprint(files);
  const ticket = { at: new Date().toISOString(), by, artifact_hash: artifact.hash, artifacts: artifact.files };
  const generation = readGenerationRecord(projectDir, stage);
  if (generation) ticket.generation = generation;
  if (stage === 'clip') {
    if (!id) throw new Error('确认视频片段时必须提供 --id');
    data.approvals.clips[id] = ticket;
  } else if (stage === 'handoff') {
    if (!id) throw new Error('确认连续性交接时必须提供 --id');
    data.approvals.handoffs ||= {};
    data.approvals.handoffs[id] = ticket;
  } else data.approvals[stage] = ticket;
  fs.writeFileSync(reviewPath(projectDir), JSON.stringify(data, null, 2) + '\n', 'utf8');
  return ticket;
}

export function legacyApproval(board, stage) {
  if (!board.meta?.approvals?.[stage]) throw new Error(`人工闸门未通过：${stage} 尚未确认`);
}

export function writeReviewNote(projectDir, stage, lines) {
  const dir = path.join(projectDir, 'reviews');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${stage}.md`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}

export function clipResultPath(projectDir, id) {
  const current = path.join(projectDir, 'units', `${id}.result.json`);
  const old = path.join(projectDir, 'units', `${id}.final.result.json`);
  if (!fs.existsSync(current)) return fs.existsSync(old) ? old : null;
  if (!fs.existsSync(old)) return current;
  return fs.statSync(old).mtimeMs > fs.statSync(current).mtimeMs ? old : current;
}

export function requireAllClips(projectDir, plan, { skip = false } = {}) {
  if (skip) {
    console.error('⚠ --skip-gate：仅限调试，已跳过所有片段的人工确认');
    return;
  }
  for (const unit of plan.units || []) {
    const actualResult = clipResultPath(projectDir, unit.id);
    if (!actualResult) throw new Error(`不能合成：${unit.id} 尚未生成`);
    const result = JSON.parse(fs.readFileSync(actualResult, 'utf8'));
    const files = (result.files || [])
      .map((file) => typeof file === 'string' ? file : file?.local_path || file?.localPath || file?.path)
      .filter((file) => file && fs.existsSync(file));
    if (!files.length) throw new Error(`不能合成：${unit.id} 没有可审阅的视频产物`);
    requireApproval(projectDir, 'clip', files, { id: unit.id });
  }
}
