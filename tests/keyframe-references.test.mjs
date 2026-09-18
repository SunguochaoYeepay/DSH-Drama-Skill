import assert from 'node:assert/strict';
import test from 'node:test';
import { withHandoffReference } from '../src/keyframe-references.mjs';

test('handoff never silently discards a character reference', () => {
  const refs = [{ file: 'scene', role: 'scene' }, { file: 'a', role: 'sheet' }, { file: 'b', role: 'sheet' }];
  assert.throws(() => withHandoffReference(refs, 'tail', 'bailian'), /不能静默丢掉角色/);
  assert.deepEqual(withHandoffReference(refs.slice(0, 2), 'tail', 'local').map((ref) => ref.file), ['tail', 'scene', 'a']);
  assert.equal(withHandoffReference(refs, 'tail', 'huimeng').length, 4);
});
