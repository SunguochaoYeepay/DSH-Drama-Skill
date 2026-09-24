/**
 * `cli/desub.mjs`（VSR 通道）—— 带 → 像素的换算、自动找带、以及"先干跑再跑"。
 *
 * 这里守两件事：
 *  1. **切给 VSR 的窗口必须与掩码脚本算出同一个矩形**。同一部剧里两条通道
 *     （VSR 的 `-c ymin ymax xmin xmax` 与 VOID 的掩码 PNG）如果各算各的，
 *     "我量的带"和"我修的带"就错开几像素 —— 静默的错。两边都走 `rectOf`，这里断言一致。
 *  2. `--auto-band` 的语义：**候选来自探测器，显式参数覆盖它**，找不到候选就拒绝跑。
 *
 * 用 `--dry-run` 测（不碰 Docker、不需要镜像）—— 所以这套用例在没装 Docker 的机器上也绿。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { COMFY_PYTHON, FFMPEG } from '../src/runtime-paths.mjs';
import { rectOf } from '../src/video-diff.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'cli', 'desub.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-desub-vsr-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const ffmpegOk = spawnSync(FFMPEG, ['-version'], { encoding: 'utf8' }).status === 0;
const pythonOk = Boolean(COMFY_PYTHON) && fs.existsSync(COMFY_PYTHON)
  && spawnSync(COMFY_PYTHON, ['-c', 'import numpy, PIL'], { encoding: 'utf8' }).status === 0;

const W = 240;
const H = 432;
const VIDEO = path.join(TMP, 'clip.mp4');
const TEXT_Y = 0.72;

/** 合成一段短片：带字幕（drawtext）或不带。 */
function makeVideo(out, withText) {
  const vf = withText
    ? `drawtext=fontfile='C\\:/Windows/Fonts/arial.ttf':text='TEST SUBTITLE':fontcolor=white:fontsize=24:`
      + `borderw=3:bordercolor=black:x=(w-text_w)/2:y=${TEXT_Y}*h-text_h/2`
    : null;
  const args = ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x303030:s=${W}x${H}:d=1:r=12`];
  if (vf) args.push('-vf', vf);
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', out);
  const r = spawnSync(FFMPEG, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`合成视频失败：${String(r.stderr).slice(0, 200)}`);
  return out;
}

/** 跑 CLI（默认加 --dry-run），返回 {code, out}。 */
function runCli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

/** 从 dry-run 打印的 docker 命令里抠出 `-c ymin ymax xmin xmax`。 */
function cropOf(out) {
  const m = /-c (\d+) (\d+) (\d+) (\d+) --inpaint-mode/.exec(out);
  return m ? m.slice(1).map(Number) : null;
}

if (!ffmpegOk) {
  test('ffmpeg 不可用 —— 跳过（机器侧前置，不是代码问题）', () => { assert.ok(true); });
} else {
  makeVideo(VIDEO, true);

  test('默认带：切给 VSR 的窗口 = rectOf 算出来的那个矩形', () => {
    const { code, out } = runCli([VIDEO, '--dry-run']);
    assert.equal(code, 0, out);
    const band = { top: 0.71, bottom: 0.87, left: 0, right: 1 };
    const r = rectOf(band, W, H);
    assert.deepEqual(cropOf(out), [r.y, r.y + r.height, r.x, r.x + r.width], out);
    // 左右默认满幅：老调用方（只给 --top/--bottom）行为不能变
    assert.equal(r.x, 0);
    assert.equal(r.width, W);
  });

  test('显式带：窗口逐项跟着走，且与掩码脚本同一套取整', () => {
    const { code, out } = runCli([VIDEO, '--top', '0.695', '--bottom', '0.805', '--left', '0.28', '--right', '0.72', '--dry-run']);
    assert.equal(code, 0, out);
    const r = rectOf({ top: 0.695, bottom: 0.805, left: 0.28, right: 0.72 }, W, H);
    assert.deepEqual(cropOf(out), [r.y, r.y + r.height, r.x, r.x + r.width], out);
    // 0.72*240=172.8→173、0.28*240=67.2→67 ⇒ 宽 106（"宽度=比例×宽"会给 105）
    assert.equal(r.width, 106);
  });

  test('干跑不跑 Docker、不写产物', () => {
    const out1 = path.join(TMP, 'never-written.mp4');
    const { code, out } = runCli([VIDEO, '--out', out1, '--dry-run']);
    assert.equal(code, 0, out);
    assert.match(out, /--dry-run：将要执行的命令/);
    assert.equal(fs.existsSync(out1), false);
  });

  test('视频不存在 → 用法/错误退出，不是静默成功', () => {
    const { code } = runCli([path.join(TMP, 'nope.mp4'), '--dry-run']);
    assert.notEqual(code, 0);
  });
}

if (ffmpegOk && pythonOk) {
  test('--auto-band：找到的带被用上；显式给的项覆盖它', () => {
    const auto = runCli([VIDEO, '--auto-band', '--dry-run']);
    assert.equal(auto.code, 0, auto.out);
    assert.match(auto.out, /自动找带：y /);
    const crop = cropOf(auto.out);
    assert.ok(crop, auto.out);
    // 合成字幕画在 0.72 高度上：窗口必须罩住它
    const mid = (crop[0] + crop[1]) / 2 / H;
    assert.ok(Math.abs(mid - TEXT_Y) < 0.06, `窗口中心 ${mid.toFixed(3)} 偏离字幕 ${TEXT_Y}`);

    const over = runCli([VIDEO, '--auto-band', '--top', '0.1', '--bottom', '0.2', '--dry-run']);
    assert.equal(over.code, 0, over.out);
    const crop2 = cropOf(over.out);
    assert.equal(crop2[0], rectOf({ top: 0.1, bottom: 0.2, left: 0, right: 1 }, W, H).y, '显式 --top 必须覆盖自动结果');
    assert.match(over.out, /（top\/bottom 用你显式给的值）/);
  });

  test('没有字幕的片段：auto-band 拒绝跑，而不是拿默认带蒙一个位置', () => {
    const plain = makeVideo(path.join(TMP, 'plain.mp4'), false);
    const { code, out } = runCli([plain, '--auto-band', '--dry-run']);
    assert.notEqual(code, 0);
    assert.match(out, /没找到候选/);
  });
} else {
  test('没有 ComfyUI python —— 跳过 auto-band 用例', () => { assert.ok(true); });
}
