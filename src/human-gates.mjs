import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { handoffPath, requireHandoff } from './continuity-handoff.mjs';
import { readGenerationRecord } from './generation-records.mjs';
import { recordedPathFor } from './recorded-path.mjs';

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

/**
 * 板子票绑的是**语义**，不是字节。
 *
 * 起因（F4，2026-09-21 第 2 次记录）：`cli/assets.mjs` 在开头查板子票、结尾把资产生成结果
 * **回填**进 `board.json`。票原先绑整文件 SHA-256，于是**同一张票被自己的下游冲掉**：
 * 分批 `--only` 出资产做不到（第一次回填就冲掉票，第二次立刻被拒），关键帧入口也被拒。
 * 参照剧目 `one_step_late` 的票据时间戳显示实际做法是「板子票排到最后连批」—— 官方文本里没有这一步。
 *
 * 板子票要防的是「确认了 A、交付了 B」—— 那是**场景清单 / 角色 / 造型 / 道具**被改，
 * 不是资源槽位里多出一个文件名。所以这里按语义字段算指纹。
 *
 * 不进指纹的两类（都在这张票的语义之外）：
 *   · 资源槽位：portrait / sheet / master / reverse_master / spatial_layout /
 *     ref_image / costume_image / reference_images / voice_ref —— 由资源阶段回填；
 *   · 运行期字段：stage / approvals / final_video / total_duration_s —— 由流程推进改写。
 *
 * **改板子的语义字段，票照旧失效** —— 这一条没有松（断言见 tests/human-gates.test.mjs）。
 */
const BOARD_VOLATILE_KEYS = new Set([
  'portrait', 'sheet', 'master', 'reverse_master', 'spatial_layout',
  'ref_image', 'costume_image', 'reference_images', 'voice_ref',
  'stage', 'approvals', 'final_video', 'total_duration_s',
]);

function boardSemanticHash(file) {
  const board = JSON.parse(fs.readFileSync(file, 'utf8'));
  const strip = (value) => {
    if (Array.isArray(value)) return value.map(strip);
    if (!value || typeof value !== 'object') return value;
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (BOARD_VOLATILE_KEYS.has(key)) continue;
      out[key] = strip(value[key]);
    }
    return out;
  };
  return crypto.createHash('sha256').update(JSON.stringify(strip(board))).digest('hex');
}

/** 按阶段取指纹：`board.json` 走语义，其余一律走字节。 */
function stageFingerprint(stage, files) {
  const normalized = [...new Set(files.map((f) => path.resolve(f)))].sort();
  if (stage === 'board' && normalized.length === 1 && path.basename(normalized[0]) === 'board.json') {
    if (!fs.existsSync(normalized[0])) throw new Error(`审阅产物不存在：${normalized[0]}`);
    return { hash: boardSemanticHash(normalized[0]), files: normalized };
  }
  return fingerprint(files);
}

export function planKeyframeFiles(projectDir, plan) {
  return (plan.units || []).map((unit) => {
    const handoff = fs.existsSync(handoffPath(projectDir, unit.id)) ? requireHandoff(projectDir, unit) : null;
    const file = handoff?.keyframe || (unit.keyframe && path.resolve(projectDir, unit.keyframe));
    return file && fs.existsSync(file) ? file : null;
  }).filter(Boolean);
}

/**
 * 落幅文件（计划槽位里已存在、且有 LLM 直写提示词的那些单元）。
 *
 * 为什么要它进**关键帧票**：落幅决定"这一镜停在哪"，它和首帧一样是导演该看的产物；
 * 只在出片时才发现落幅画错了，等于白出一遍视频。所以它随首帧一起签署。
 * 没写 `keyframe-prompts/<unit>.last.txt` 的单元不进这张票 —— 老项目零影响。
 */
export function planLastKeyframeFiles(projectDir, plan) {
  return (plan.units || []).map((unit) => {
    if (!unit.last_keyframe) return null;
    if (!fs.existsSync(path.join(projectDir, 'keyframe-prompts', `${unit.id}.last.txt`))) return null;
    const file = path.resolve(projectDir, unit.last_keyframe);
    return fs.existsSync(file) ? file : null;
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
  const current = stageFingerprint(stage, files);
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
    const labels = { story: '剧本', board: '板子（场景清单/角色/道具）', direction: '导演方案', assets: '资源', keyframes: '关键帧', final: '最终成片' };
    const label = stage === 'clip' ? `视频片段 ${id}` : stage === 'handoff' ? `连续性交接 ${id}` : labels[stage] || stage;
    throw new Error(`人工闸门未通过：${label} ${status.reason}。`);
  }
}

// 票据里 `artifacts` 记的**展示路径**（能写仓库相对就写相对）现在归
// `src/recorded-path.mjs` 一处所有 —— 这里过去那份私有实现已经删掉，
// 免得同一个规则有两个所有者、两边慢慢长歪。

export function approve(projectDir, stage, files, { id = null, by = '用户' } = {}) {
  const data = readReviews(projectDir);
  const artifact = stageFingerprint(stage, files);
  // **按调用方给的顺序**记录 artifacts（去重、保留首次出现），而不是排序后的顺序。
  // 为什么重要：`fingerprint()` 为了"同一批文件换个顺序也算同一票"会把路径**排序**，
  // 于是 `artifacts[0]` 变成了字母序最小的那个；而 `cli/assemble-units.mjs` 恰恰取
  // `artifacts[0]` 当输入片段 —— 结果"在旁边放一条更好的版本（如去字幕版）再签票"
  // 天然不成立（`…104821.mp4` 永远排在 `…104821_nosub2.mp4` 前面）。2026-09-23 实测。
  // 哈希仍按那份**排序去重**的集合算（顺序无关），所以老票不会因为这条改动失效。
  const ordered = [];
  for (const f of artifact.files) {
    const abs = path.resolve(f);
    if (!ordered.includes(abs)) ordered.push(abs);
  }
  const callerOrder = [];
  for (const f of files) {
    const abs = path.resolve(f);
    if (ordered.includes(abs) && !callerOrder.includes(abs)) callerOrder.push(abs);
  }
  for (const abs of ordered) if (!callerOrder.includes(abs)) callerOrder.push(abs);
  const ticket = { at: new Date().toISOString(), by, artifact_hash: artifact.hash, artifacts: callerOrder.map((abs) => recordedPathFor(projectDir, abs)) };
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
