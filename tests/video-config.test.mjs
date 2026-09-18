import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { VIDEO_ATTENTION, VIDEO_PROFILE, VIDEO_QUALITY, VIDEO_NORMAL_SIZE, VIDEO_HIGH_SIZE } from '../src/config.mjs';

test('默认视频档使用 FastH3 和 VSA', () => {
  assert.equal(VIDEO_PROFILE, 'fast');
  assert.equal(VIDEO_ATTENTION, 'vsa');
  assert.equal(VIDEO_QUALITY, 'normal');
  assert.equal(VIDEO_NORMAL_SIZE, '480x864');
  assert.equal(VIDEO_HIGH_SIZE, '768x1344');
});

test('非法注意力配置被明确拒绝', () => {
  const result = spawnSync(process.execPath, ['-e', "import('./src/config.mjs')"], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: { ...process.env, AIH_VIDEO_ATTENTION: 'unknown' },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AIH_VIDEO_ATTENTION 只能是/);
});

test('dense 不再是允许的注意力模式', () => {
  const result = spawnSync(process.execPath, ['-e', "import('./src/config.mjs')"], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: { ...process.env, AIH_VIDEO_ATTENTION: 'dense' },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /只能是 sage \/ vsa/);
});

test('视频尺寸配置可由环境变量覆盖', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    "import { VIDEO_QUALITY, VIDEO_NORMAL_SIZE, VIDEO_HIGH_SIZE } from './src/config.mjs'; console.log(JSON.stringify([VIDEO_QUALITY, VIDEO_NORMAL_SIZE, VIDEO_HIGH_SIZE]))"], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8',
    env: { ...process.env, AIH_VIDEO_QUALITY: 'high', AIH_VIDEO_NORMAL_SIZE: '432x768', AIH_VIDEO_HIGH_SIZE: '768x1344' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['high', '432x768', '768x1344']);
});
