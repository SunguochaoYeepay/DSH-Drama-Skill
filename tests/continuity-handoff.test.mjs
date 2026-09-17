#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { bindHandoffKeyframe, createHandoffRecord, requireHandoff, writeHandoff } from '../src/continuity-handoff.mjs';

const unit = { id: 'g002', continuity: { mode: 'continue_previous', previous_unit: 'g001', handoff_state: '人物仍趴在地面', allowed_changes: ['framing'] } };
function fixture() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-test-'));
  fs.mkdirSync(path.join(project, 'units'));
  const clip = path.join(project, 'units', 'g001.mp4'); fs.writeFileSync(clip, 'clip-a');
  const frame = path.join(project, 'tail.png'); fs.writeFileSync(frame, 'frame-a');
  const keyframe = path.join(project, 'keyframe.png'); fs.writeFileSync(keyframe, 'keyframe-a');
  writeHandoff(project, createHandoffRecord({ projectDir: project, unit, sourceUnit: 'g001', sourceClip: clip, stableFrame: frame, tailOffsetS: 0.35 }));
  return { project, clip, frame, keyframe };
}

test('连续单元必须绑定实际尾帧和关键帧', () => {
  const f = fixture();
  assert.throws(() => requireHandoff(f.project, unit), /关键帧未绑定/);
  bindHandoffKeyframe(f.project, unit, f.keyframe);
  assert.equal(requireHandoff(f.project, unit).keyframe, path.resolve(f.keyframe));
});

test('上一视频变化后交接自动失效', () => {
  const f = fixture(); bindHandoffKeyframe(f.project, unit, f.keyframe);
  fs.writeFileSync(f.clip, 'clip-b');
  assert.throws(() => requireHandoff(f.project, unit), /上一段视频.*失效/);
});

test('下一关键帧变化后交接自动失效', () => {
  const f = fixture(); bindHandoffKeyframe(f.project, unit, f.keyframe);
  fs.writeFileSync(f.keyframe, 'keyframe-b');
  assert.throws(() => requireHandoff(f.project, unit), /关键帧未绑定/);
});

test('跨项目尾帧被拒绝', () => {
  const f = fixture();
  const outside = path.join(os.tmpdir(), `outside-${Date.now()}.png`); fs.writeFileSync(outside, 'x');
  assert.throws(() => createHandoffRecord({ projectDir: f.project, unit, sourceUnit: 'g001', sourceClip: f.clip, stableFrame: outside, tailOffsetS: 0.35 }), /跨项目/);
  fs.unlinkSync(outside);
});
