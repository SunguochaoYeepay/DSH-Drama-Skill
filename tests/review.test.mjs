#!/usr/bin/env node
/**
 * review.test.mjs — 成片自检的验收。
 *
 * **负例驱动**：造几部真的有病的片子，断言自检必须把它们拦下。
 * 这不是走形式 —— 这套检查的来历就是一次真事故：
 * 成片报"成功"，音轨却是坏的（AAC 比特流被 `-c copy` 拼废），
 * **是用户用耳朵发现的**。
 *
 *   node tests/review.test.mjs <成片.mp4>
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { review } from '../src/review.mjs';

let passed = 0;
const failures = [];
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`FAIL   ${label}${detail ? '  → ' + detail : ''}`); }
}

const FFMPEG = (() => {
  const base = 'C:\\Users\\Administrator\\AppData\\Local\\Microsoft\\WinGet\\Packages';
  for (const dir of fs.readdirSync(base)) {
    if (!dir.startsWith('Gyan.FFmpeg_')) continue;
    const c = path.join(base, dir, 'ffmpeg-7.1.1-full_build', 'bin', 'ffmpeg.exe');
    if (fs.existsSync(c)) return c;
  }
  return 'ffmpeg';
})();
const NUL = process.platform === 'win32' ? 'NUL' : '-';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-rev-'));
const ff = (args) => spawnSync(FFMPEG, args, { stdio: 'ignore' });

console.log('\n成片自检');
const good = process.argv[2] || 'E:/AI-Tool/DeepSeek/story2video/shots/final.mp4';

// 期望时长**从板子算**，不写死 —— 写死的数字一重出就过期。
// （这条本身就是个教训：我第一次写死了 88.63s，重出后被自己的测试绊倒。）
const boardPath = process.argv[3] || 'E:/AI-Tool/DeepSeek/story2video/examples/dashixiong.literal.json';
let expectSeconds = null;
let expectSubtitles = null;
let srtPath = null;
if (fs.existsSync(boardPath)) {
  const { buildTimeline } = await import('../src/orchestrate.mjs');
  const b = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
  const tl = buildTimeline(b, Object.fromEntries(b.shots.map((s) => [s.id, s.duration_s])));
  expectSeconds = tl.total_seconds;
  expectSubtitles = tl.srt.trim() ? tl.srt.trim().split('\n\n').length : 0;
  srtPath = path.join(path.dirname(good), 'final.srt');
  console.log(`  期望来自板子：${expectSeconds.toFixed(2)}s / 字幕 ${expectSubtitles} 条`);
}

// ---- 好片子必须通过 ----
if (fs.existsSync(good)) {
  const r = review(good, { expectSeconds, toleranceFrames: 3, srt: srtPath, expectSubtitles });
  check('真成片通过自检', r.pass, r.fails.join(' | '));
  check('解码 0 报错', r.info.decode_errors === 0, String(r.info.decode_errors));
  check('有音轨且不是静音', r.info.audio && r.info.loudness && r.info.loudness.mean > -50, JSON.stringify(r.info.loudness));
  check('抽帧不是全黑', (r.info.frame_luma || []).some((x) => x && x > 8), JSON.stringify(r.info.frame_luma));
  check('字幕条数对得上', r.info.subtitle_count === expectSubtitles, `${r.info.subtitle_count} vs ${expectSubtitles}`);
  console.log(`       ${r.info.size_mb} MB　${r.info.duration.format.toFixed(2)}s　${r.info.duration.frames} 帧　mean ${r.info.loudness.mean} dB　max ${r.info.loudness.max} dB`);
} else {
  check('真成片存在', false, good);
}

// ---- 负例 1：全黑 + 无音轨 ----
const black = path.join(TMP, 'black.mp4');
ff(['-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', black]);
const rb = review(black);
check('**全黑无音的片子被拦下**', !rb.pass, rb.fails.join(' | '));
check('  理由里点出没有音轨', rb.fails.some((f) => /没有音轨/.test(f)), rb.fails.join(' | '));
check('  理由里点出画面全黑', rb.fails.some((f) => /全是黑的|全黑/.test(f)), rb.fails.join(' | '));

// ---- 负例 2：有画面但音轨是死的 ----
const silent = path.join(TMP, 'silent.mp4');
ff(['-y', '-f', 'lavfi', '-i', 'testsrc=s=320x180:d=3', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '3',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', silent]);
const rs = review(silent);
check('**静音片子被拦下**', !rs.pass, rs.fails.join(' | '));
check('  理由里点出基本是静音', rs.fails.some((f) => /静音/.test(f)), rs.fails.join(' | '));

// ---- 负例 3：时长对不上时间轴 ----
const rl = review(silent, { expectSeconds: expectSeconds ?? 88.63, toleranceFrames: 2 });
check('时长不符被拦下', !rl.pass && rl.fails.some((f) => /与时间轴/.test(f)), rl.fails.join(' | '));

// ---- 负例 4：音轨坏了（把 AAC 数据砸烂，模拟 `-c copy` 拼错的那种） ----
if (fs.existsSync(good)) {
  const broken = path.join(TMP, 'broken.mp4');
  const buf = fs.readFileSync(good);
  // 从 40% 处开始把后半段打成噪声 —— 视频头还在，所以能读、但解码会报错
  for (let i = Math.floor(buf.length * 0.4); i < buf.length; i += 7) buf[i] = (buf[i] + 137) & 0xff;
  fs.writeFileSync(broken, buf);
  const rbr = review(broken);
  check('**音视频流被打坏的片子被拦下**', !rbr.pass, `decode_errors=${rbr.info.decode_errors} fails=${rbr.fails.join(' | ')}`);
  check('  确实是靠"解码报错"这一条抓到的', (rbr.info.decode_errors || 0) > 0, String(rbr.info.decode_errors));
}

fs.rmSync(TMP, { recursive: true, force: true });

console.log('\n' + '─'.repeat(56));
if (failures.length) {
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项：`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log(`全部通过（${passed} 项）—— "文件存在"不等于"成片能看"，四种病都得拦下`);
}
