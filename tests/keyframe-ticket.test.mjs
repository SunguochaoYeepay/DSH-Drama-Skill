import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { approve, approvalStatus, planKeyframeFiles } from '../src/human-gates.mjs';

test('channel draft cannot be approved in place of plan keyframe', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-keyframe-ticket-'));
  const draft = path.join(project, 'keyframes_bailian', 'g001.png');
  const slot = path.join(project, 'keyframes_render', 'g001.png');
  fs.mkdirSync(path.dirname(draft));
  fs.mkdirSync(path.dirname(slot));
  fs.writeFileSync(draft, 'same bytes');
  fs.writeFileSync(slot, 'same bytes');
  const plan = { units: [{ id: 'g001', keyframe: 'keyframes_render/g001.png' }] };
  fs.writeFileSync(path.join(project, 'render.plan.json'), JSON.stringify(plan));
  assert.deepEqual(planKeyframeFiles(project, plan), [slot]);
  approve(project, 'keyframes', [draft]);
  assert.equal(approvalStatus(project, 'keyframes', [slot]).ok, false);
  const root = path.resolve(import.meta.dirname, '..');
  const wrong = spawnSync(process.execPath, [path.join(root, 'cli/review-gate.mjs'), 'approve',
    '--project', project, '--stage', 'keyframes', '--artifacts', draft], { encoding: 'utf8' });
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /计划实际使用的图片/);
  const correct = spawnSync(process.execPath, [path.join(root, 'cli/review-gate.mjs'), 'approve',
    '--project', project, '--stage', 'keyframes'], { encoding: 'utf8' });
  assert.equal(correct.status, 0, correct.stderr);
  assert.equal(approvalStatus(project, 'keyframes', [slot]).ok, true);
});
