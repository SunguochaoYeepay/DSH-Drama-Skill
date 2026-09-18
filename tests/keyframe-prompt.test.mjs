import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

test('composition override removes the conflicting base framing clauses', () => {
  const source = fs.readFileSync(new URL('../cli/keyframes.mjs', import.meta.url), 'utf8');
  assert.match(source, /applyCompositionOverride/);
  assert.match(source, /startsWith\('构图要求：'\)/);
  assert.match(source, /startsWith\('【生成前最终检查】'\)/);
});
