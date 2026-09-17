import assert from 'node:assert/strict';

const hasDialogue = (unit) => (unit.shots || []).some((shot) => (shot.lines || []).length > 0);
assert.equal(hasDialogue({ shots: [{ lines: [11] }] }), true);
assert.equal(hasDialogue({ shots: [{ lines: [] }, {}] }), false);
assert.equal(hasDialogue({ shots: [{ lines: [] }, { lines: [17] }] }), true);
console.log('assemble policy: 3/3 passed');
