import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MIN_DIRECTOR_VERSION = 6;
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const hashJson = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function projectId(board, boardPath) {
  const id = String(board.meta?.project || '').trim();
  if (!id) throw new Error(`${boardPath}: meta.project 为空，不能建立项目身份证`);
  return id;
}

export function makePlanProvenance({ boardPath, storyPath, directionPath, legacyMigration = false }) {
  const board = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
  const direction = JSON.parse(fs.readFileSync(directionPath, 'utf8'));
  return {
    contract: 1,
    project_id: projectId(board, boardPath),
    board_sha256: hash(boardPath),
    story_sha256: hash(storyPath),
    direction_sha256: hash(directionPath),
    direction_version: Number(direction.version || 0),
    direction_file: path.basename(directionPath),
    bound_at: new Date().toISOString(),
    ...(legacyMigration ? { legacy_migration: true } : {}),
  };
}

export function assertPlanProvenance(plan, { boardPath, storyPath, planPath }) {
  const p = plan.provenance;
  if (!p || p.contract !== 1) throw new Error('生成计划没有项目身份证；历史计划禁止直接执行，请重新编译或显式迁移');
  const board = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
  if (p.project_id !== projectId(board, boardPath)) throw new Error(`生成计划属于项目 ${p.project_id}，当前项目是 ${board.meta.project}`);
  if (p.board_sha256 !== hash(boardPath)) throw new Error('Storyboard 已变化，历史生成计划失效');
  if (p.story_sha256 !== hash(storyPath)) throw new Error('剧本已变化，历史生成计划失效');
  const directionPath = path.join(path.dirname(planPath), p.direction_file);
  if (!fs.existsSync(directionPath) || p.direction_sha256 !== hash(directionPath)) throw new Error('导演稿已变化或不在当前项目，生成计划失效');
  if (p.plan_units_sha256 !== hashJson(plan.units)) throw new Error('生成计划内容已被修改，项目身份证失效');
  if (p.direction_version < MIN_DIRECTOR_VERSION && !p.legacy_migration) throw new Error(`导演协议 v${p.direction_version} 低于最低 v${MIN_DIRECTOR_VERSION}`);
  if (p.legacy_migration) {
    if (!Array.isArray(p.reviewed_units) || !p.reviewed_units.length) {
      throw new Error('历史计划缺少 reviewed_units；没有单元获得人工迁移复核');
    }
    const known = new Set((plan.units || []).map((unit) => unit.id));
    const invalid = p.reviewed_units.filter((id) => !known.has(id));
    if (invalid.length) throw new Error(`reviewed_units 含计划外单元：${invalid.join(', ')}`);
    if (new Set(p.reviewed_units).size !== p.reviewed_units.length) throw new Error('reviewed_units 不得重复登记同一单元');
  }
}

export function sealPlan(plan) {
  if (!plan.provenance) throw new Error('计划尚未建立 provenance');
  plan.provenance.plan_units_sha256 = hashJson(plan.units);
  return plan;
}

export function assertUnitEmotionContract(unit, { plan = null } = {}) {
  if (plan?.provenance?.legacy_migration && !plan.provenance.reviewed_units?.includes(unit.id)) {
    throw new Error(`${unit.id} 未列入 provenance.reviewed_units；历史计划必须逐单元补齐 v5 情绪并人工复核`);
  }
  for (const shot of unit.shots || []) {
    const entries = shot.emotion_analysis || [];
    const covered = new Set(entries.map((item) => item.character));
    for (const id of shot.on_screen || []) if (!covered.has(id)) throw new Error(`${unit.id} 第${shot.n}镜缺少 ${id} 的 emotion_analysis，旧计划不能执行该镜`);
  }
}

export function assertPlanEmotionContract(plan) {
  for (const unit of plan.units || []) assertUnitEmotionContract(unit, { plan });
}
