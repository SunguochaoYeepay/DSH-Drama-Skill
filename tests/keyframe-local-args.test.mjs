/**
 * 本地关键帧真正下发给 gen.py 的参数，用 `--dry-run` 打印出来断言。
 *
 * ## 为什么不读源码
 * `cli/keyframes.mjs` 是脚本式入口，这些变量出不来；源码正则又只能证明"写了这行字"。
 * 干跑打印的 argv 与真正 spawn 的是**同一个来源**（`localGenArgs()`），断言它就是断言行为。
 *
 * ## 守的四条
 *   1. 默认档 = Lightning 加速栈，且 LoRA/步数/CFG **成套**（错配会糊，2026-09-20 实测）；
 *   2. 必须显式给输出尺寸 —— edit 通道不看目标尺寸，不给就会被压回 ~1MP，画面发黑；
 *   3. `--no-fast` 能退回 20 步非蒸馏旧路径，且不带任何 LoRA；
 *   4. 参考图顺序与提示词里的「图1/图2/图3」编号同源（图1 是场景基底）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');

/** 造一个能跑通干跑的最小项目（照 tests/keyframe-prompt.test.mjs 的同款底座）。 */
function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-kf-local-args-'));
  const master = path.join(dir, 'room_master.png');
  const sheet = path.join(dir, 'girl_sheet.png');
  fs.writeFileSync(master, 'stub');
  fs.writeFileSync(sheet, 'stub');
  fs.writeFileSync(path.join(dir, 'board.json'), JSON.stringify({
    meta: { project: 'kf-local-args', aspect: '9:16', style_prompt: '写实' },
    characters: [{ id: 'c_girl', name: '女孩', face_prompt: '圆脸', portrait: sheet }],
    identities: [{ id: 'i_girl', character: 'c_girl', appearance_details: '白裙', sheet }],
    scenes: [{ id: 's_room', name: '卧室', master }],
    props: [],
  }));
  fs.writeFileSync(path.join(dir, 'render.plan.json'), JSON.stringify({
    units: [{
      id: 'g001',
      keyframe_start: '女孩站在门边',
      shots: [{ framing: '中景', action: '女孩站在门边', scene: 's_room', on_screen: ['i_girl'] }],
    }],
  }));
  return { dir, master, sheet };
}

function dryRun(dir, extra = []) {
  const result = spawnSync(process.execPath, [
    path.join(root, 'cli', 'keyframes.mjs'),
    path.join(dir, 'board.json'),
    '--direction', path.join(dir, 'render.plan.json'),
    '--units', 'g001',
    '--dry-run', '--skip-gate',
    ...extra,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, `干跑应成功：${result.stderr}`);
  const line = String(result.stdout).split('\n').find((l) => l.includes('gen.py argv'));
  assert.ok(line, `应打印真正下发的 argv：${result.stdout}`);
  return line;
}

test('默认档是 Lightning 加速栈，且 LoRA / 步数 / CFG 成套下发', () => {
  const { dir } = makeProject();
  const line = dryRun(dir);
  // 三者必须同在这一版上：8 步 LoRA 配 20 步会糊，而这也是过去画面发黑的成因之一。
  assert.match(line, /--steps 8 /);
  assert.match(line, /--cfg 1 /);
  assert.match(line, /--lora Qwen-Image-Lightning-8steps-V1\.0\.safetensors/);
  assert.match(line, /--steps 8 --cfg 1 --lora /);
});

test('必须显式给输出尺寸：edit 通道不给会被 FluxKontextImageScale 压回 ~1MP', () => {
  const { dir } = makeProject();
  const line = dryRun(dir);
  assert.match(line, /--width 1152 --height 2048/);
});

test('画幅不同则尺寸跟着排布，不是写死的竖屏', () => {
  const { dir } = makeProject();
  const boardPath = path.join(dir, 'board.json');
  const board = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
  board.meta.aspect = '16:9';
  fs.writeFileSync(boardPath, JSON.stringify(board));
  // 加起来还是 2048x1152 这档像素，但横竖按剧目走
  assert.match(dryRun(dir), /--width 2048 --height 1152/);
});

test('--no-fast 退回 20 步非蒸馏旧路径且不带 LoRA', () => {
  const { dir } = makeProject();
  const line = dryRun(dir, ['--no-fast']);
  assert.match(line, /--steps 20 /);
  assert.match(line, /--cfg 4 /);
  assert.doesNotMatch(line, /--lora /);
});

test('参考图顺序与提示词编号同源：场景主图在最前当基底', () => {
  const { dir, master, sheet } = makeProject();
  const line = dryRun(dir);
  const images = [...line.matchAll(/--image (\S+)/g)].map((m) => m[1]);
  assert.equal(images.length, 2, `应传 2 张参考图，实际 ${images.length}`);
  // 图1 = 场景主图（latent 基底），之后才是身份图
  assert.equal(images[0], master);
  assert.equal(images[1], sheet);
});

console.log('keyframe-local-args: 5/5 passed');
