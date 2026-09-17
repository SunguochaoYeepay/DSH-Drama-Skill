import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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

export function readReviews(projectDir) {
  const file = reviewPath(projectDir);
  if (!fs.existsSync(file)) return { version: 1, approvals: { clips: {} } };
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.approvals ||= {};
  data.approvals.clips ||= {};
  return data;
}

function slot(data, stage, id, variant = 'final') {
  if (stage === 'clip') {
    const entry = data.approvals.clips?.[id];
    // v1 票据直接存在 clips.<id>；兼容读取时只视为 final，不伪造 preview。
    if (entry?.artifact_hash) return variant === 'final' ? entry : null;
    return entry?.[variant];
  }
  if (stage === 'handoff') return data.approvals.handoffs?.[id];
  return data.approvals[stage];
}

export function approvalStatus(projectDir, stage, files, id = null, variant = 'final') {
  const approval = slot(readReviews(projectDir), stage, id, variant);
  if (!approval) return { ok: false, reason: '尚未人工确认' };
  const current = fingerprint(files);
  if (approval.artifact_hash !== current.hash) return { ok: false, reason: '产物已变化，旧确认自动失效' };
  return { ok: true, approval };
}

export function requireApproval(projectDir, stage, files, { id = null, variant = 'final', skip = false } = {}) {
  if (skip) {
    console.error('⚠ --skip-gate：仅限调试，已跳过人工审阅闸门');
    return;
  }
  const status = approvalStatus(projectDir, stage, files, id, variant);
  if (!status.ok) {
    const labels = { direction: '导演方案', assets: '资源', keyframes: '关键帧', final: '最终成片' };
    const label = stage === 'clip' ? `视频片段 ${id}（${variant === 'preview' ? '预览档' : '正式档'}）` : stage === 'handoff' ? `连续性交接 ${id}` : labels[stage] || stage;
    throw new Error(`人工闸门未通过：${label} ${status.reason}。机器检查通过只表示可以交给人看。`);
  }
}

export function approve(projectDir, stage, files, { id = null, variant = 'final', by = '用户' } = {}) {
  const data = readReviews(projectDir);
  const artifact = fingerprint(files);
  const ticket = { at: new Date().toISOString(), by, artifact_hash: artifact.hash, artifacts: artifact.files };
  if (stage === 'clip') {
    if (!id) throw new Error('确认视频片段时必须提供 --id');
    if (!['preview', 'final'].includes(variant)) throw new Error('视频片段 --variant 只能是 preview 或 final');
    const old = data.approvals.clips[id];
    data.approvals.clips[id] = old?.artifact_hash ? { final: old } : (old || {});
    data.approvals.clips[id][variant] = ticket;
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

export function requireAllClips(projectDir, plan, { skip = false } = {}) {
  if (skip) {
    console.error('⚠ --skip-gate：仅限调试，已跳过所有片段的人工确认');
    return;
  }
  for (const unit of plan.units || []) {
    const resultFile = path.join(projectDir, 'units', `${unit.id}.final.result.json`);
    const legacyResult = path.join(projectDir, 'units', `${unit.id}.result.json`);
    const actualResult = fs.existsSync(resultFile) ? resultFile : legacyResult;
    if (!fs.existsSync(actualResult)) throw new Error(`不能合成：${unit.id} 正式档尚未生成`);
    const result = JSON.parse(fs.readFileSync(actualResult, 'utf8'));
    const files = (result.files || [])
      .map((file) => typeof file === 'string' ? file : file?.local_path || file?.localPath || file?.path)
      .filter((file) => file && fs.existsSync(file));
    if (!files.length) throw new Error(`不能合成：${unit.id} 没有可审阅的视频产物`);
    requireApproval(projectDir, 'clip', files, { id: unit.id, variant: 'final' });
  }
}
