import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { directorBoardView, directionReceiptPath } from './direction-provenance.mjs';

export const MIN_DIRECTOR_VERSION = 6;
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const hashJson = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const boardIdentityHash = (file) => hashJson(directorBoardView(JSON.parse(fs.readFileSync(file, 'utf8'))));

export function projectId(board, boardPath) {
  const id = String(board.meta?.project || '').trim();
  if (!id) throw new Error(`${boardPath}: meta.project 为空，不能建立项目身份证`);
  return id;
}

// 计划身份证只作留痕：记录这份计划是从哪份 board / story / 导演稿编译出来的。
// 它不再是闸门 —— 跨剧复用、手改计划、换剧本都不会被拦，判断交给看片子的人。
export function makePlanProvenance({ boardPath, storyPath, directionPath, legacyMigration = false }) {
  const board = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
  const direction = JSON.parse(fs.readFileSync(directionPath, 'utf8'));
  const receiptFile = directionReceiptPath(directionPath);
  return {
    contract: 1,
    project_id: projectId(board, boardPath),
    board_identity_sha256: boardIdentityHash(boardPath),
    story_sha256: hash(storyPath),
    direction_sha256: hash(directionPath),
    // 票据只作留痕：有票就记哈希，没有票也不拦。
    ...(fs.existsSync(receiptFile) ? { direction_receipt_sha256: hash(receiptFile) } : {}),
    direction_version: Number(direction.version || 0),
    direction_file: path.basename(directionPath),
    bound_at: new Date().toISOString(),
    ...(legacyMigration ? { legacy_migration: true } : {}),
  };
}

export function sealPlan(plan) {
  if (!plan.provenance) throw new Error('计划尚未建立 provenance');
  plan.provenance.plan_units_sha256 = hashJson(plan.units);
  return plan;
}
