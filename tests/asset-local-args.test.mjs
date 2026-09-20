/**
 * 资产通道真正下发的参数，用 `--dry-run` 打印出来断言。
 *
 * ## 守什么
 * 资产通道曾经一直在跑 20 步非蒸馏路径：`assets.mjs` 写了 `flag('steps', LOCAL_IMAGE_STEPS)`
 * 当默认值，那个 20 恒为真 → 永远下发 steps=20 → provider 里 `fast=true` 的默认从未生效。
 * 同型入口漏接在 keyframes.mjs 已犯过一次。这条测试守的是「资产默认档 = Lightning 加速栈
 * （LoRA + 步数 + CFG 成套）+ 按资产比例排布的显式尺寸」——三者任何一个退回旧默认都会红。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-asset-local-args-'));
  const png = path.join(dir, 'stub.png');
  fs.writeFileSync(png, 'stub');
  fs.writeFileSync(path.join(dir, 'board.json'), JSON.stringify({
    meta: { project: 'asset-local-args', aspect: '9:16', style_prompt: '写实' },
    characters: [{ id: 'c_coach', name: '教练', face_prompt: '短寸头中年男性', portrait: png }],
    identities: [{ id: 'i_coach', character: 'c_coach', appearance_details: '皮夹克', sheet: png }],
    scenes: [{ id: 's_room', name: '机舱', master: png }],
    props: [],
  }));
  return dir;
}

function dryRun(dir, extra = []) {
  const result = spawnSync(process.execPath, [
    path.join(root, 'cli', 'assets.mjs'),
    path.join(dir, 'board.json'),
    '--dry-run', '--skip-gate',
    ...extra,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, `干跑应成功：${result.stderr}`);
  return String(result.stdout).split('\n').filter((l) => l.includes('通道参数'));
}

test('资产默认档是 Lightning 加速栈，LoRA/步数/CFG 成套', () => {
  const lines = dryRun(makeProject());
  assert.ok(lines.length >= 1, `至少应有一个资产任务：${lines}`);
  for (const line of lines) {
    assert.match(line, /lora=Qwen-Image-Lightning-8steps-V1\.0\.safetensors/);
    assert.match(line, /steps=8 /);
    assert.match(line, /cfg=1 /);
    assert.doesNotMatch(line, /steps=20/);
  }
});

test('尺寸按资产自己的比例排布，不留 ~1MP 默认', () => {
  const lines = dryRun(makeProject());
  // 肖像 1:1 → 1152x1152；身份图 16:9 → 2048x1152；场景主图跟剧目画幅 9:16 → 1152x2048
  const portrait = lines.find((l) => /prefix=c_coach /.test(l) && !l.includes('images='));
  assert.ok(portrait, `应存在肖像任务：${lines}`);
  assert.match(portrait, /width=1152  height=1152/);
  const sheet = lines.find((l) => l.includes('images='));
  assert.ok(sheet, `应存在身份图任务：${lines}`);
  assert.match(sheet, /width=2048  height=1152/);
});

test('显式给 steps 会退回手动档且不再挂默认 LoRA', () => {
  const lines = dryRun(makeProject(), ['--steps', '20', '--cfg', '4']);
  assert.ok(lines.length >= 1);
  assert.doesNotMatch(lines.join('\n'), /lora=/);
  assert.match(lines[0], /steps=20/);
});

console.log('asset-local-args: 3/3 passed');
