/**
 * 白膜闸门接线（第 4 步）的行为测试 —— 对应 lab/whitebox/test-plan.md 的 T1-T5。
 *
 * ## 守什么
 * 闸门这条线守的是一句人话：**确认了 A 白膜，不能交付 B 白膜的片。**
 *
 * - T1 白膜票能按单元登记（绑规划 JSON 字节）
 * - T2 改一个坐标 → 白膜票自动作废
 * - T3 出片时白膜产物进产物清单 → 改白膜连带作废 clip 票；且视频仍是 files[0]
 * - T4 没有白膜的单元**完全不设闸**（老剧目零影响）
 * - T5 CLI 通路：review-gate 认 --stage whitebox，缺 --id 直接拒
 *
 * 全部用临时目录 + 仓库内范本，不烧卡、不需要 Blender。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  appendWhiteboxArtifacts,
  hasWhitebox,
  requireWhiteboxApproval,
  whiteboxArtifactFiles,
  whiteboxPlanPath,
  whiteboxVideoPath,
} from '../src/whitebox-gates.mjs';
import { approve, approvalStatus, readReviews } from '../src/human-gates.mjs';
import { runNode, skipIfUnavailable } from './helpers/spawn.mjs';

const root = path.resolve(import.meta.dirname, '..');
const TEMPLATE = JSON.parse(fs.readFileSync(path.join(root, 'lab', 'whitebox', 'fight.unit.json'), 'utf8'));
const GATE_CLI = path.join(root, 'cli', 'review-gate.mjs');

/** 搭一个最小剧目：units/g001.whitebox.json + 渲出来的白膜视频。 */
function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-wbg-'));
  fs.mkdirSync(path.join(dir, 'units'), { recursive: true });
  const planFile = path.join(dir, 'units', 'g001.whitebox.json');
  fs.writeFileSync(planFile, JSON.stringify(TEMPLATE, null, 2));
  const videoDir = path.join(dir, 'units', 'out', 'whitebox', TEMPLATE.scene_name);
  fs.mkdirSync(videoDir, { recursive: true });
  const videoFile = path.join(videoDir, `${TEMPLATE.scene_name}.mp4`);
  fs.writeFileSync(videoFile, 'fake-whitebox-video-bytes');
  return { dir, planFile, videoFile };
}

test('T1 白膜票按单元登记，绑的是规划 JSON 的字节', () => {
  const { dir, planFile } = makeProject();
  const unit = { id: 'g001' };
  assert.equal(whiteboxPlanPath(dir, unit), planFile, '默认路径约定：<剧目>/units/<id>.whitebox.json');

  const ticket = approve(dir, 'whitebox', [planFile], { id: 'g001' });
  assert.ok(ticket.artifact_hash, '票里必须有产物指纹');
  assert.equal(readReviews(dir).approvals.whitebox.g001.artifact_hash, ticket.artifact_hash);
  assert.equal(approvalStatus(dir, 'whitebox', [planFile], 'g001').ok, true);
});

test('T1b 计划里声明了 `{ plan, keyframe }` 对象时，按声明的 plan 找白膜（别当字符串 resolve）', () => {
  const { dir, planFile, videoFile } = makeProject();
  // 真实的剧目里单元 id 与场景名不相同（`g001` → `units/u_restaurant_inside.whitebox.json`），
  // 默认约定拼不出来 —— 计划声明才是白膜位置的所有者。
  const unit = { id: 'g001', whitebox: { keyframe: 'units/x-whitebox/still_f0001.png', plan: 'units/g001.whitebox.json' } };
  assert.equal(whiteboxPlanPath(dir, unit), planFile);
  assert.deepEqual(whiteboxArtifactFiles(dir, unit), [planFile, videoFile], '规划 JSON 在前、白膜视频在后');
  assert.equal(hasWhitebox(dir, unit), true);
  // 字符串老写法照样认
  assert.equal(whiteboxPlanPath(dir, { id: 'g001', whitebox: 'units/g001.whitebox.json' }), planFile);
});

test('T2 改一个坐标，白膜票自动作废', () => {
  const { dir, planFile } = makeProject();
  approve(dir, 'whitebox', [planFile], { id: 'g001' });

  const doc = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  doc.assets[0].clips[0].start_pos = [9.9, 9.9];   // 只动一个坐标
  fs.writeFileSync(planFile, JSON.stringify(doc, null, 2));

  const status = approvalStatus(dir, 'whitebox', [planFile], 'g001');
  assert.equal(status.ok, false, '改了白膜，旧确认不该还有效');
  assert.match(status.reason, /产物已变化/);
});

test('T3 白膜进产物清单后，改白膜连带作废 clip 票（视频仍是 files[0]）', () => {
  const { dir, planFile, videoFile } = makeProject();
  const unit = { id: 'g001' };
  const clip = path.join(dir, 'units', 'g001.mp4');
  fs.writeFileSync(clip, 'fake-clip-bytes');

  // 出片后的产物清单：视频 [0]，白膜产物追加在末尾（与落幅同一条机制）
  const result = { ok: true, files: [clip] };
  assert.equal(appendWhiteboxArtifacts(dir, unit, result), true);
  assert.equal(result.files[0], clip, '合成取 files[0]，视频必须稳坐首位');
  assert.ok(result.files.includes(planFile) && result.files.includes(videoFile));

  fs.writeFileSync(path.join(dir, 'units', 'g001.result.json'), JSON.stringify(result, null, 2));
  approve(dir, 'clip', result.files, { id: 'g001' });
  assert.equal(approvalStatus(dir, 'clip', result.files, 'g001').ok, true);

  // 白膜改了（哪怕视频还没重渲）→ 这一段的人工确认必须作废
  const doc = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  doc.assets[0].clips[0].end_pos = [-1.1, -1.1];
  fs.writeFileSync(planFile, JSON.stringify(doc, null, 2));
  assert.equal(approvalStatus(dir, 'clip', result.files, 'g001').ok, false, '白膜变了，clip 票必须连带作废');
});

test('T4 没有白膜的单元完全不设闸（老剧目零影响）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-wbg-'));
  fs.mkdirSync(path.join(dir, 'units'), { recursive: true });
  const unit = { id: 'g002' };
  assert.equal(hasWhitebox(dir, unit), false);
  assert.deepEqual(whiteboxArtifactFiles(dir, unit), []);
  assert.equal(appendWhiteboxArtifacts(dir, unit, { ok: true, files: ['x.mp4'] }), false);
  // 关键：不该抛「人工闸门未通过」
  assert.doesNotThrow(() => requireWhiteboxApproval(dir, unit));
});

test('T5 review-gate 认 --stage whitebox；缺 --id 直接拒', (t) => {
  const { dir, planFile, videoFile } = makeProject();
  const r = runNode([GATE_CLI, 'approve', '--project', dir, '--stage', 'whitebox', '--id', 'g001']);
  if (skipIfUnavailable(t, r)) return;
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /人工确认已记录：whitebox g001/);

  const s = runNode([GATE_CLI, 'status', '--project', dir, '--stage', 'whitebox', '--id', 'g001']);
  if (skipIfUnavailable(t, s)) return;
  assert.equal(s.status, 0, s.stdout);
  assert.match(s.stdout, /已人工确认/);
  // 白膜票绑的是规划 JSON；视频存在时也一起进票
  assert.ok(fs.existsSync(planFile) && fs.existsSync(videoFile));
  assert.equal(whiteboxVideoPath(dir, { id: 'g001' }), videoFile, '视频路径约定与渲染器一致');

  const noId = runNode([GATE_CLI, 'approve', '--project', dir, '--stage', 'whitebox', '--artifacts', planFile]);
  if (skipIfUnavailable(t, noId)) return;
  assert.equal(noId.status, 1, '缺 --id 必须拒（一个单元一份白膜）');
  assert.match(noId.stderr, /--id/);
});

console.log('whitebox-gates: 5/5 passed');
