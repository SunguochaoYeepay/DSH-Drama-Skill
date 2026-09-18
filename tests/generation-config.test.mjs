import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('legacy from-story cannot generate an untracked storyboard', () => {
  const result = spawnSync(process.execPath, ['src/board.mjs', 'from-story'], {
    cwd: root, encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /from-story 已停用/);
});

test('local assets use configured steps unless overridden on CLI', () => {
  const assets = source('cli/assets.mjs');
  assert.match(assets, /flag\('steps', LOCAL_IMAGE_STEPS\)/);
  assert.match(assets, /common\.steps = Number\(STEPS\)/);
});

test('keyframe prompts translate timeline wording into a static pose', () => {
  const keyframes = source('cli/keyframes.mjs');
  assert.match(keyframes, /关键帧起始姿态/);
  assert.match(keyframes, /replace\(\/\^0\\s\*秒/);
  assert.doesNotMatch(keyframes, /画面起点：\$\{unit\.keyframe_start/);
});

test('Bailian keyframe size and Huimeng model have independent env defaults', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    "import { BAILIAN_KEYFRAME_SIZE, HUIMENG_IMAGE_MODEL } from './src/config.mjs'; console.log(JSON.stringify([BAILIAN_KEYFRAME_SIZE, HUIMENG_IMAGE_MODEL]))"], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, AIH_BAILIAN_KEYFRAME_SIZE: '768*1344', AIH_HUIMENG_IMAGE_MODEL: 'image-2' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['768*1344', 'image-2']);
  assert.match(source('cli/keyframes.mjs'), /size: dimensionsForAspect\(BAILIAN_SIZE, ASPECT, '\*'\)/);
  assert.match(source('cli/huimeng.mjs'), /flag\('model', HUIMENG_IMAGE_MODEL\)/);
});

test('text output budgets and timeout come from env and reject invalid values', () => {
  const code = "import { SCRIPT_MAX_OUTPUT_TOKENS, DIRECTOR_MAX_OUTPUT_TOKENS, BAILIAN_TEXT_TIMEOUT_SECONDS } from './src/config.mjs'; console.log(JSON.stringify([SCRIPT_MAX_OUTPUT_TOKENS, DIRECTOR_MAX_OUTPUT_TOKENS, BAILIAN_TEXT_TIMEOUT_SECONDS]))";
  const env = { ...process.env, AIH_SCRIPT_MAX_OUTPUT_TOKENS: '7000', AIH_DIRECTOR_MAX_OUTPUT_TOKENS: '14000', AIH_BAILIAN_TEXT_TIMEOUT_SECONDS: '800' };
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [7000, 14000, 800]);
  const invalid = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: root, encoding: 'utf8', env: { ...env, AIH_SCRIPT_MAX_OUTPUT_TOKENS: '0' },
  });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /AIH_SCRIPT_MAX_OUTPUT_TOKENS/);
});
