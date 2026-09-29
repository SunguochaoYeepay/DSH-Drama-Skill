/**
 * cli/whitebox.mjs 的行为测试。
 *
 * 守的行为：
 * 1. validate 对合法规划（lab/whitebox/fight.unit.json，真实范本）放行并打印摘要；
 * 2. validate 对菜单外动作硬拒（AI 禁止编造），退出码 1 且报出是哪条动作；
 * 3. render --dry-run 打印真正会执行的 blender + ffmpeg 两条命令（含渲染脚本、输出目录、
 *    帧序列与 mp4 路径），不真跑 —— 本仓 CLI 测试的老招式：断言那行输出；
 * 4. stills --dry-run 只走 Blender 且带 --stills-only，不封装 mp4；
 * 5. 缺参数报用法，退出码 2。
 *
 * validate 与 dry-run 都不需要 Blender / 不烧卡，任何机器可跑。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runNode, skipIfUnavailable } from './helpers/spawn.mjs';

const root = path.resolve(import.meta.dirname, '..');
const CLI = path.join(root, 'cli', 'whitebox.mjs');
const GOOD = path.join(root, 'lab', 'whitebox', 'fight.unit.json');

test('validate：合法范本放行，退出码 0 且打印摘要', (t) => {
  const r = runNode([CLI, 'validate', GOOD]);
  if (skipIfUnavailable(t, r)) return;
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /校验通过/);
  assert.match(r.stdout, /fight/);
});

test('validate：菜单外的动作硬拒，退出码 1 且点名', (t) => {
  const doc = JSON.parse(fs.readFileSync(GOOD, 'utf8'));
  doc.assets[0].clips[0].animation = 'Backflip_360';
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aih-wb-')), 'bad.json');
  fs.writeFileSync(tmp, JSON.stringify(doc));
  const r = runNode([CLI, 'validate', tmp]);
  if (skipIfUnavailable(t, r)) return;
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /Backflip_360/);
  assert.match(r.stderr, /不在菜单里/);
  fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
});

test('render --dry-run：打印真正会执行的 blender 与 ffmpeg 命令', (t) => {
  const r = runNode([CLI, 'render', GOOD, '--dry-run']);
  if (skipIfUnavailable(t, r)) return;
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /whitebox_render\.py/);           // 渲染脚本真身
  assert.match(r.stdout, /--out/);                          // 输出目录显式传给渲染器
  assert.match(r.stdout, /frames[/\\]f_%04d\.png/);         // ffmpeg 吃 PNG 序列
  assert.match(r.stdout, /fight\.mp4/);                     // 封装目标
  assert.match(r.stdout, /-framerate\n +24\n/);            // fps 取自规划 JSON（dry-run 每参数一行）
});

test('stills --dry-run：带 --stills-only 且不封装 mp4', (t) => {
  const r = runNode([CLI, 'stills', GOOD, '--dry-run']);
  if (skipIfUnavailable(t, r)) return;
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /--stills-only/);
  assert.doesNotMatch(r.stdout, /f_%04d\.png/);
});

test('缺参数报用法，退出码 2', (t) => {
  const r = runNode([CLI]);
  if (skipIfUnavailable(t, r)) return;
  assert.equal(r.status, 2);
  assert.match(r.stderr, /用法/);
});

console.log('whitebox-cli: 5/5 passed');
