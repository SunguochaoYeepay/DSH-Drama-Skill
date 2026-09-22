import assert from 'node:assert/strict';
import test from 'node:test';
import { refImageLimit, withHandoffReference } from '../src/keyframe-references.mjs';

test('handoff never silently discards a character reference', () => {
  const refs = [{ file: 'scene', role: 'scene' }, { file: 'a', role: 'sheet' }, { file: 'b', role: 'sheet' }];
  assert.throws(() => withHandoffReference(refs, 'tail', 'bailian'), /不能静默丢掉角色/);
  assert.deepEqual(withHandoffReference(refs.slice(0, 2), 'tail', 'local').map((ref) => ref.file), ['tail', 'scene', 'a']);
  assert.equal(withHandoffReference(refs, 'tail', 'huimeng').length, 4);
});

test('参考位容量按通道与图像模型家族算，不是全局 3', () => {
  // 上游：2.1 的 autogrow 暴露 image_1..16（graphs.py 的 QWEN21_MAX_IMAGES）
  assert.equal(refImageLimit('local', 'qwen21'), 16);
  // 旧 Qwen-Image/Edit 2511 链路的硬上限仍是 3
  assert.equal(refImageLimit('local', 'qwen'), 3);
  // 百炼 / 火山不跟着放开
  assert.equal(refImageLimit('bailian', 'qwen21'), 3);
  assert.equal(refImageLimit('volcengine', 'qwen21'), 3);
  // 绘梦自己的一档
  assert.equal(refImageLimit('huimeng', null), 9);
  // `--provider local` 是历史叫法，与 comfyui 同名同量
  assert.equal(refImageLimit('comfyui', 'qwen21'), 16);
});

test('本地 2.1 上「交接帧 + 场景 + 两名角色」放得下', () => {
  const refs = [{ file: 'scene', role: 'scene' }, { file: 'a', role: 'sheet' }, { file: 'b', role: 'sheet' }];
  const combined = withHandoffReference(refs, 'tail', 'local', { imageModel: 'qwen21' });
  assert.deepEqual(combined.map((ref) => ref.file), ['tail', 'scene', 'a', 'b']);
});

test('旧 qwen 家族仍按 3 张拒绝，不因为改了本地默认就悄悄放开', () => {
  const refs = [{ file: 'scene', role: 'scene' }, { file: 'a', role: 'sheet' }, { file: 'b', role: 'sheet' }];
  assert.throws(() => withHandoffReference(refs, 'tail', 'local', { imageModel: 'qwen' }), /上限 3/);
});
