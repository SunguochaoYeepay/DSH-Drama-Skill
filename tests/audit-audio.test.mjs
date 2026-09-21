/**
 * `cli/audit-audio.mjs` 的行为测试。
 *
 * ## 守什么
 * 1. **有音轨 ≠ 该响的时候响了**。一部剧里导演写了"闹钟持续不断的铃声"、提示词也送进了 H3，
 *    实测却是开场 2 秒近乎无声 —— `inspect.mjs` 只报"有音轨 / mean 多少 dB"，看不见这个。
 *    所以本工具的核心判据是**开场窗口 vs 全段峰值的差值**，不是绝对音量。
 * 2. 没有音轨是**硬问题**，必须退出码 1；内容静音只是发现，不算失败。
 *
 * 夹具用 ffmpeg 现场造（本机 ffmpeg 在测试里真实可用，响度测试已有先例），
 * 断言的是 CLI 的真实 stdout / 退出码。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const CLI = path.join(root, 'cli', 'audit-audio.mjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-audit-audio-'));

/** 全程有声（3kHz 正弦——落在"金属铃声"的高频段）。 */
const TONE = path.join(dir, 'tone.m4a');
/** 前 2.5s 静音、最后 0.5s 有声 —— 模拟"声音迟到"。 */
const LATE = path.join(dir, 'late.m4a');
/** 只有画面没有音轨。 */
const NOAUDIO = path.join(dir, 'silent.mp4');

function ffmpeg(args) {
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', ...args], { encoding: 'utf8', maxBuffer: 1e8 });
  assert.equal(r.status, 0, `造夹具失败：${r.stderr}`);
}

ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=3000:duration=3', '-c:a', 'aac', TONE]);
ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=3000:duration=3',
  '-af', "volume=0:enable='between(t,0,2.5)'", '-c:a', 'aac', LATE]);
ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=10:duration=1', '-pix_fmt', 'yuv420p', NOAUDIO]);

function run(file, extra = []) {
  return spawnSync(process.execPath, [CLI, file, '--no-out', '--step', '0.5', ...extra], { encoding: 'utf8' });
}

test('全程有声的片段判为通过', () => {
  const r = run(TONE);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /全频/);
  assert.match(r.stdout, /✓/, `应判通过：${r.stdout}`);
});

test('开场静音、后面才响的片段要判出来（声音迟到）', () => {
  const r = run(LATE);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /⚠/, `应判警告：${r.stdout}`);
  assert.match(r.stdout, /静音|缺席|迟到/, `应说明原因：${r.stdout}`);
});

test('没有音轨是硬问题：退出码 1', () => {
  const r = run(NOAUDIO);
  assert.equal(r.status, 1, `应失败：${r.stdout}`);
  assert.match(r.stderr + r.stdout, /没有音轨/);
});

console.log('audit-audio: 3/3 passed');
