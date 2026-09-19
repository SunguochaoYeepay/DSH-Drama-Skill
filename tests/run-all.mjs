#!/usr/bin/env node
/**
 * 跑全部确定性测试。
 *
 * **递归**：`tests/integration/` 里的活体验证也算在内 ——
 * 它默认验的是仓库 `plugins/` 源码（不碰本机 DSH profile），是确定性的；
 * 之前只扫顶层，它一次都没被跑过，等于没有保护。
 * `fixtures/` 是测试输入不是测试，跳过。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));

function collect(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === 'fixtures' ? [] : collect(full);
      return entry.name.endsWith('.test.mjs') ? [full] : [];
    });
}

const tests = collect(testsDir).sort();

let failed = 0;
for (const file of tests) {
  const name = path.relative(testsDir, file).split(path.sep).join('/');
  process.stdout.write(`\n=== ${name} ===\n`);
  const result = spawnSync(process.execPath, [file], {
    cwd: path.resolve(testsDir, '..'),
    stdio: 'inherit',
  });
  if (result.status !== 0) failed++;
}

if (failed) {
  console.error(`\n${failed}/${tests.length} 个确定性测试失败`);
  process.exit(1);
}
console.log(`\n全部通过：${tests.length}/${tests.length}`);
