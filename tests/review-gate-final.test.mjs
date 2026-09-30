/**
 * final 阶段的默认产物（`out/final.mp4`）。
 *
 * ## 守什么
 * story / board / direction / assets（以及 clip）都能不传 `--artifacts` 自己找产物，
 * 唯独 final 要求手传 —— 于是 `node cli/review-gate.mjs status --project <项目> --stage final`
 * 打的是**用法**而不是"票还在不在"，看起来像票丢了。这里补的是那一格默认。
 *
 * 两句人话：
 * - **成片按约定就位时，命令行不该被迫重复说一遍路径**（约定路径只有一个所有者：`out/final.mp4`）。
 * - **省了参数不等于省了保护**：默认路径照样要走指纹校验，成片换了字节，旧票必须作废。
 * - 显式 `--artifacts` 优先（看板那条路就显式绑，见 `web/server.mjs`）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runNode, skipIfUnavailable } from './helpers/spawn.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const GATE = path.join(ROOT, 'cli', 'review-gate.mjs');

function makeProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-gate-final-'));
}

function ticketFor(project, stage) {
  const doc = JSON.parse(fs.readFileSync(path.join(project, 'review.approvals.json'), 'utf8'));
  return doc.approvals[stage];
}

test('T1 成片在约定位置时，final 不必手传 --artifacts；成片变了票照样作废', (t) => {
  const project = makeProject();

  // 还没合成 → 没有默认可绑，明确拒（exit 2 = 用法），别记出一张绑空气的票
  const early = runNode([GATE, 'approve', '--project', project, '--stage', 'final']);
  if (skipIfUnavailable(t, early)) return;
  assert.equal(early.status, 2, '成片不在约定位置时必须拒');

  fs.mkdirSync(path.join(project, 'out'), { recursive: true });
  const finalFile = path.join(project, 'out', 'final.mp4');
  fs.writeFileSync(finalFile, 'fake-final-bytes');

  const approved = runNode([GATE, 'approve', '--project', project, '--stage', 'final']);
  if (skipIfUnavailable(t, approved)) return;
  assert.equal(approved.status, 0, approved.stderr || approved.stdout);
  assert.match(approved.stdout, /人工确认已记录：final/);
  assert.ok(ticketFor(project, 'final').artifacts[0].endsWith('final.mp4'), '票绑的就是约定位置的成片');

  const status = runNode([GATE, 'status', '--project', project, '--stage', 'final']);
  if (skipIfUnavailable(t, status)) return;
  assert.equal(status.status, 0, status.stderr || status.stdout);
  assert.match(status.stdout, /已人工确认/);

  // 默认路径也要走指纹校验：成片换了字节，旧票必须作废
  fs.writeFileSync(finalFile, 'other-final-bytes');
  const stale = runNode([GATE, 'status', '--project', project, '--stage', 'final']);
  if (skipIfUnavailable(t, stale)) return;
  assert.equal(stale.status, 1, '成片变了，旧确认不该还有效');
  assert.match(stale.stdout + stale.stderr, /产物已变化/);
});

test('T2 显式 --artifacts 优先于默认（约定之外的落点照样能签）', (t) => {
  const project = makeProject();
  fs.mkdirSync(path.join(project, 'out'), { recursive: true });
  fs.writeFileSync(path.join(project, 'out', 'final.mp4'), 'default-bytes');
  const custom = path.join(project, 'cut', 'delivery.mp4');
  fs.mkdirSync(path.dirname(custom), { recursive: true });
  fs.writeFileSync(custom, 'custom-bytes');

  const approved = runNode([GATE, 'approve', '--project', project, '--stage', 'final', '--artifacts', custom]);
  if (skipIfUnavailable(t, approved)) return;
  assert.equal(approved.status, 0, approved.stderr || approved.stdout);
  const ticket = ticketFor(project, 'final');
  assert.equal(ticket.artifacts.length, 1);
  assert.ok(ticket.artifacts[0].endsWith(path.join('cut', 'delivery.mp4')), ticket.artifacts[0]);
  assert.ok(!ticket.artifacts[0].endsWith('out/final.mp4'));
});
