import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * runtime-paths 的行为测试。
 *
 * **为什么必须开子进程**：这些值在模块 **import 时就定型**，同进程里改
 * `process.env` 再 import 拿不到新值 —— 所以每个断言都在干净子进程里跑一次。
 *
 * **为什么不断言源码文本**：仓库纪律明确禁止"源码里有没有这行字"式的断言。
 * 这里守的是行为：没配会喊人话、配了就用配置、认环境变量优先级。
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOD = path.join(ROOT, 'src', 'runtime-paths.mjs');

/**
 * 在子进程里对 runtime-paths 求值。
 * @param {Record<string,string>} env 注入的环境变量
 * @param {string} body 一句 `(m) => …`，返回值被 JSON 序列化带回
 */
function evalIn(env, body) {
  const code = `
    const { pathToFileURL } = await import('node:url');
    const m = await import(pathToFileURL(process.env.AIH_MOD).href);
    console.log(JSON.stringify((${body})(m)));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: ROOT,
    env: { ...process.env, AIH_MOD: MOD, ...env },
    encoding: 'utf8',
  });
  if (r.status !== 0) return { crashed: true, stderr: (r.stderr || '').trim() };
  return { value: JSON.parse(r.stdout.trim()) };
}

/** 把抛出的消息捞回来（子进程里 throw 会变成非零退出）。 */
function thrownIn(env, body) {
  const code = `
    const { pathToFileURL } = await import('node:url');
    const m = await import(pathToFileURL(process.env.AIH_MOD).href);
    (${body})(m);
    console.log('NO_THROW');
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: ROOT,
    env: { ...process.env, AIH_MOD: MOD, ...env },
    encoding: 'utf8',
  });
  return { status: r.status, stderr: (r.stderr || '').trim(), stdout: (r.stdout || '').trim() };
}

test('没配 AIH_PYTHON：模块照常加载，值就是空（不在 import 期炸）', () => {
  const r = evalIn({ AIH_PYTHON: '' }, '(m) => m.COMFY_PYTHON');
  assert.deepEqual(r, { value: '' });
});

test('没配 AIH_PYTHON：真要拿 Python 时抛可操作的错误，不是 spawn 出来的 ENOENT', () => {
  const r = thrownIn({ AIH_PYTHON: '' }, '(m) => m.requireComfyPython()');
  assert.notEqual(r.status, 0, '应当报错退出');
  assert.equal(r.stdout, '', '不该打印 NO_THROW');
  // 人话三要素：说清配什么键、配到哪、去哪查。
  assert.match(r.stderr, /AIH_PYTHON/, '错误消息要点名该配的键');
  assert.match(r.stderr, /\.env/, '错误消息要指出配在哪');
  assert.match(r.stderr, /doctor/, '错误消息要指一条自查的路');
});

test('配了 AIH_PYTHON：requireComfyPython 原值返回', () => {
  const r = evalIn({ AIH_PYTHON: 'X:/my-comfy/python/python.exe' }, '(m) => m.requireComfyPython()');
  assert.deepEqual(r, { value: 'X:/my-comfy/python/python.exe' });
});

test('AIH_WINGET_PACKAGES 优先于自动推导', () => {
  const r = evalIn(
    { AIH_WINGET_PACKAGES: 'X:/packages' },
    '(m) => m.WINGET_PACKAGES',
  );
  assert.deepEqual(r, { value: 'X:/packages' });
});

test('生图入口默认落在仓内 vendor（不依赖任何本机 Gen 路径）', () => {
  const r = evalIn({ AIH_GEN: '' }, '(m) => m.COMFY_GEN');
  assert.equal(typeof r.value, 'string');
  assert.ok(r.value.includes('vendor'), `应指向仓内 vendor，实际：${r.value}`);
  assert.ok(!/^[A-Za-z]:\\Users\\/.test(r.value), '不该出现任何人的用户目录');
});

console.log('runtime-paths: 5 passed');
