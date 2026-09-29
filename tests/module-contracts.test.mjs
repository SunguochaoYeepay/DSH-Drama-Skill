import assert from 'node:assert/strict';
import test from 'node:test';
import { validateSchema } from '../src/schema-validator.mjs';
import { ensureMarkers, markersIn, propMarkersIn } from '../src/board-markers.mjs';

test('schema validator reports nested paths and enforces the supported subset', () => {
  const errors = validateSchema({
    title: '',
    count: 4.5,
    tags: ['ok'],
    extra: true,
    child: { enabled: 'yes' },
  }, {
    type: 'object',
    required: ['title', 'count', 'child'],
    additionalProperties: false,
    properties: {
      title: { type: 'string', minLength: 2 },
      count: { type: 'integer', minimum: 1, maximum: 4 },
      tags: { type: 'array', minItems: 2, items: { type: 'string', pattern: '^tag-' } },
      child: { type: 'object', required: ['enabled'], properties: { enabled: { type: 'boolean' } } },
    },
  });

  assert.deepEqual(errors, [
    '$: 不该有的字段 extra',
    '$.title: 太短（至少 2 字）',
    '$.count: 期望 integer，实际 number',
    '$.tags: 至少 2 项',
    '$.tags[0]: "ok" 不匹配 ^tag-',
    '$.child.enabled: 期望 boolean，实际 string',
  ]);
});

test('schema validator accepts number schemas for integers and enum values deterministically', () => {
  assert.deepEqual(validateSchema({ ratio: 2, mode: 'fast' }, {
    type: 'object',
    properties: {
      ratio: { type: 'number', minimum: 0, maximum: 3 },
      mode: { enum: ['fast', 'safe'] },
    },
  }), []);
  assert.match(validateSchema({ mode: 'slow' }, { type: 'object', properties: { mode: { enum: ['fast', 'safe'] } } })[0], /只能是/);
});

test('marker extraction keeps valid references and ignores malformed syntax', () => {
  assert.deepEqual(markersIn('{{hero}} {{ hero_2 }} {{Bad}} {{bad-id}} {{ok}}'), ['hero', 'hero_2', 'ok']);
  assert.deepEqual(propMarkersIn('[[sword]] [[ prop_2 ]] [[Bad]] [[bad-id]]'), ['sword', 'prop_2']);
});

test('ensureMarkers injects only missing known identities and leaves existing prompts intact', () => {
  const board = {
    characters: [{ id: 'c1', name: '阿青' }],
    identities: [{ id: 'hero', character: 'c1' }, { id: 'unknown-character', character: 'missing' }],
    shots: [
      { id: 's1', cast: ['hero', 'unknown-character', 'missing-identity'], prompt: '站在门口' },
      { id: 's2', cast: ['hero'], prompt: '{{hero}} 看向镜头' },
    ],
  };

  assert.deepEqual(ensureMarkers(board), ['s1: 补入身份标记 → {{hero}}（阿青）、{{unknown-character}}']);
  assert.equal(board.shots[0].prompt, '{{hero}}（阿青）、{{unknown-character}}，站在门口');
  assert.equal(board.shots[1].prompt, '{{hero}} 看向镜头');
});
