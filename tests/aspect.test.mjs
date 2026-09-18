import assert from 'node:assert/strict';
import test from 'node:test';
import { aspectOf, dimensionsForAspect } from '../src/aspect.mjs';

test('project aspect maps both video and Bailian image sizes', () => {
  assert.equal(aspectOf({ meta: { aspect: '16:9' } }), '16:9');
  assert.equal(dimensionsForAspect('480x864', '9:16'), '480x864');
  assert.equal(dimensionsForAspect('480x864', '16:9'), '864x480');
  assert.equal(dimensionsForAspect('768x1344', '1:1'), '768x768');
  assert.equal(dimensionsForAspect('1024*1792', '16:9', '*'), '1792*1024');
  assert.throws(() => aspectOf({ meta: {} }), /未设置/);
  assert.throws(() => dimensionsForAspect('bad', '9:16'), /尺寸/);
});
