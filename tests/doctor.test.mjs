import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * doctor 行为测试：真跑 CLI，断言 --json 的实际输出与退出码。
 * 环境变量注入优先于 .env（实测 process.loadEnvFile 不覆盖已存在的键），
 * 所以用 AIH_* 把每项依赖指到确定的位置 —— 不依赖本机装了什么。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-doctor-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function runDoctor(env) {
  const r = spawnSync(process.execPath, ['cli/doctor.mjs', '--json'], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return { code: r.status, json: JSON.parse(r.stdout) };
}

test('必需依赖缺失：exit 1，缺的项点名', () => {
  const missing = path.join(TMP, 'not', 'there');
  const { code, json } = runDoctor({
    AIH_GEN: missing, AIH_PYTHON: missing, AIH_FFMPEG: missing, AIH_BAILIAN_ENTRY: missing,
  });
  assert.equal(code, 1);
  assert.equal(json.ok, false);
  const byName = Object.fromEntries(json.checks.map((c) => [c.name, c]));
  for (const name of ['生图入口 gen.py（仓内 vendor）', 'ComfyUI Python（引擎侧，不入仓）', 'ffmpeg', '百炼 CLI（本地依赖）']) {
    assert.equal(byName[name].status, 'missing', `${name} 应报缺`);
    assert.equal(byName[name].required, true);
  }
  // 可选项缺了不扣退出码的分（Docker / projects 在这里都没保证）
  assert.ok(json.checks.some((c) => c.required === false));
});

test('必需依赖全在：exit 0', () => {
  const fake = path.join(TMP, 'fake.exe');
  fs.writeFileSync(fake, 'x');
  const { code, json } = runDoctor({
    AIH_GEN: fake, AIH_PYTHON: fake, AIH_FFMPEG: fake, AIH_BAILIAN_ENTRY: fake,
  });
  assert.equal(code, 0);
  assert.equal(json.ok, true);
  for (const c of json.checks) {
    if (c.required) assert.equal(c.status, 'ok', `${c.name} 应就位`);
  }
});
