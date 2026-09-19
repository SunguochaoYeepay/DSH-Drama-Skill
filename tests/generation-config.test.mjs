/**
 * 生成配置（视频档 / 步数 / 超时 / 尺寸 / 模型）的行为测试。
 *
 * ## 判据
 *
 * 这里每一条都**跑出结果再断言**：配置类的用子进程 `import` 真实导出值，
 * 装配类的跑 CLI `--dry-run` 断言打印出来的档位。
 * 之前用 `assert.match(源码, /flag\('steps', …\)/)` 这类正则查「源码里有没有这行字」的写法已全部删除 ——
 * 那种断言在源码换个等价写法时会假红，在行为真坏了时却绿。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 在子进程里 import 配置模块，拿真实导出值（env 覆盖必须是新进程才生效）。 */
function configValues(names, env) {
  const code = `import { ${names.join(', ')} } from './src/config.mjs'; console.log(JSON.stringify([${names.join(', ')}]))`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: root, encoding: 'utf8', env: { ...process.env, ...(env || {}) },
  });
  return result;
}

function assertConfigValues(names, env, expected) {
  const result = configValues(names, env);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), expected);
}

/** 造一个能跑通 `unit.mjs --dry-run` 的最小项目。 */
function makeUnitProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-unit-config-'));
  const png = path.join(dir, 'master.png');
  fs.writeFileSync(png, 'stub');
  fs.writeFileSync(path.join(dir, 'board.json'), JSON.stringify({
    meta: { project: 'unit-config', aspect: '9:16' },
    characters: [], identities: [], props: [],
    scenes: [{ id: 's_room', name: '卧室', master: png }],
  }));
  fs.writeFileSync(path.join(dir, 'render.plan.json'), JSON.stringify({
    units: [{ id: 'g001', shots: [{ at: 0, duration_s: 5, scene: 's_room' }] }],
  }));
  return dir;
}

test('legacy from-story cannot generate an untracked storyboard', () => {
  const result = spawnSync(process.execPath, ['src/board.mjs', 'from-story'], {
    cwd: root, encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /from-story 已停用/);
});

// 默认档必须是 FastH3 + VSA：退化成 4 步 draft 或 dense 注意力都会让单轮跑进几分钟。
// 这里断言的是干跑**打印出来的档位**，不是源码里写没写那行参数。
test('default video run really is FastH3 + VSA on the small canvas', () => {
  const dir = makeUnitProject();
  const result = spawnSync(process.execPath, [
    path.join(root, 'cli', 'unit.mjs'),
    path.join(dir, 'board.json'),
    '--direction', path.join(dir, 'render.plan.json'),
    '--unit', 'g001',
    '--dry-run', '--skip-gate',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /单元 g001　.*　fast \/ i2v \/ normal \/ vsa/);
  assertConfigValues(['VIDEO_NORMAL_SIZE', 'VIDEO_HIGH_SIZE'], null, ['480x864', '768x1344']);
});

test('video timeout comes from env and rejects values outside 1-600s', () => {
  assertConfigValues(['VIDEO_TIMEOUT_SECONDS'], { AIH_VIDEO_TIMEOUT_SECONDS: '300' }, [300]);
  for (const bad of ['0', '601', 'abc']) {
    const result = configValues(['VIDEO_TIMEOUT_SECONDS'], { AIH_VIDEO_TIMEOUT_SECONDS: bad });
    assert.notEqual(result.status, 0, `${bad} 应被拒绝`);
    assert.match(result.stderr, /AIH_VIDEO_TIMEOUT_SECONDS/);
  }
});

test('local image steps come from env and can be overridden', () => {
  assertConfigValues(['LOCAL_IMAGE_STEPS', 'LOCAL_IMAGE_CFG'], null, ['20', '4']);
  assertConfigValues(['LOCAL_IMAGE_STEPS'], { AIH_LOCAL_IMAGE_STEPS: '8' }, ['8']);
});

test('Bailian keyframe size and Huimeng model have independent env defaults', () => {
  assertConfigValues(['BAILIAN_KEYFRAME_SIZE', 'HUIMENG_IMAGE_MODEL'],
    { AIH_BAILIAN_KEYFRAME_SIZE: '768*1344', AIH_HUIMENG_IMAGE_MODEL: 'image-2' },
    ['768*1344', 'image-2']);
});

test('text output budgets and timeout come from env and reject invalid values', () => {
  const names = ['SCRIPT_MAX_OUTPUT_TOKENS', 'DIRECTOR_MAX_OUTPUT_TOKENS', 'BAILIAN_TEXT_TIMEOUT_SECONDS'];
  assertConfigValues(names,
    { AIH_SCRIPT_MAX_OUTPUT_TOKENS: '7000', AIH_DIRECTOR_MAX_OUTPUT_TOKENS: '14000', AIH_BAILIAN_TEXT_TIMEOUT_SECONDS: '800' },
    [7000, 14000, 800]);
  const invalid = configValues(names, { AIH_SCRIPT_MAX_OUTPUT_TOKENS: '0' });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /AIH_SCRIPT_MAX_OUTPUT_TOKENS/);
});
