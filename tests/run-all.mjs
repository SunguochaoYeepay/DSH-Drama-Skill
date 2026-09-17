#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const tests = fs.readdirSync(testsDir)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort();

let failed = 0;
for (const name of tests) {
  process.stdout.write(`\n=== ${name} ===\n`);
  const result = spawnSync(process.execPath, [path.join(testsDir, name)], {
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
