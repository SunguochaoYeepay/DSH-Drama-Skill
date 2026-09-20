#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { allowedChangesList, bindHandoffKeyframe, createHandoffRecord, requireHandoff, writeHandoff } from '../src/continuity-handoff.mjs';

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

// 回归守卫：手写导演稿常把 allowed_changes 写成一整句中文而不是数组。
// 早先 createHandoffRecord 直接 [...str]，凭证里会被塞进一串单字符；prepare-handoff 的 .join() 还会当场抛错。
test('allowed_changes 写成整句中文时不会拆成单字符', () => {
  assert.deepEqual(allowedChangesList('景别从全景收到中景、机位从舱内正面移到他侧后方；服装与身份不变。'),
    ['景别从全景收到中景', '机位从舱内正面移到他侧后方', '服装与身份不变。']);
  assert.deepEqual(allowedChangesList(['framing', 'camera']), ['framing', 'camera']);
  assert.deepEqual(allowedChangesList(undefined), []);
  // 单字符 touches：修复前这条会返回 ['景', '别', '从', ...]
  assert.ok(allowedChangesList('景别').length <= 1, '整词不应被拆散');
});

test('凭证里的 allowed_changes 归一成词数组', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-sentence-'));
  const clip = path.join(project, 'clip.mp4'); fs.writeFileSync(clip, 'c');
  const frame = path.join(project, 'frame.png'); fs.writeFileSync(frame, 'f');
  const sentence = { ...unit, continuity: { ...unit.continuity, allowed_changes: '景别收紧、机位后移' } };
  const record = createHandoffRecord({ projectDir: project, unit: sentence, sourceUnit: 'g001', sourceClip: clip, stableFrame: frame, tailOffsetS: 0.35 });
  assert.deepEqual(record.allowed_changes, ['景别收紧', '机位后移']);
});
