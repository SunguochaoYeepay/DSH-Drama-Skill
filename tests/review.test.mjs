#!/usr/bin/env node
/**
 * review.test.mjs — 成片自检的验收。
 *
 * **负例驱动**：造几部真的有病的片子，断言自检必须把它们拦下。
 * 这不是走形式 —— 这套检查的来历就是一次真事故：
 * 成片报"成功"，音轨却是坏的（AAC 比特流被 `-c copy` 拼废），
 * **是用户用耳朵发现的**。
 *
 * ## 为什么输入全是自造的
 *
 * 这个文件是**确定性测试**，就不该要求外部存在一部真实成片。
 * 原先正例写死 `E:/AI-Tool/DeepSeek/story2video/shots/final.mp4`，
 * 工作区改成 `projects/<剧目>/` 之后直接 ENOENT；
 * 而且"换成另一个现存路径"只是重新绑一次会继续变的外部目录。
 *
 * 所以：**正例和负例都在临时目录里用 FFmpeg 现造**，时长已知、音轨已知、字幕条数已知。
 * 换工作区、换机器都不失效。
 *
 * 想看真实成片过不过，显式传：
 *
 *   node tests/review.test.mjs --film <成片.mp4> [--board <board.json>]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { review } from '../src/review.mjs';
import { FIXTURE, fixture } from './fixtures/index.mjs';
import { WINGET_PACKAGES } from '../src/runtime-paths.mjs';

let passed = 0;
const failures = [];
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`FAIL   ${label}${detail ? '  → ' + detail : ''}`); }
}

const FFMPEG = (() => {
  const base = WINGET_PACKAGES;
  try {
    for (const dir of fs.readdirSync(base)) {
      if (!dir.startsWith('Gyan.FFmpeg_')) continue;
      const c = path.join(base, dir, 'ffmpeg-7.1.1-full_build', 'bin', 'ffmpeg.exe');
      if (fs.existsSync(c)) return c;
    }
  } catch { /* 找不到就退回 PATH */ }
  return 'ffmpeg';
})();
const NUL = process.platform === 'win32' ? 'NUL' : '-';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-rev-'));
const ff = (args) => spawnSync(FFMPEG, args, { stdio: 'ignore' });

/**
 * 跑自检，把"自检自己抛异常"也当成一种结果返回，而不是让它把测试打断。
 *
 * 为什么需要这层收口：自检崩掉是**必须被看见的失败**，
 * 但如果它直接把进程打断，后面的负例一条都跑不到 —— 一次只暴露一个问题。
 * （真实教训：`review.mjs` 用了没 import 的 `aspectMatches`，
 *  已删除的旧 `render.mjs` 合成阶段又一直在传 `expectAspect`，于是每次合成都在自检处崩，
 *  而"成片自检"这条判据等于从来没生效过。）
 *
 * 收成统一的 `threw` 字段后，每个用例都能自己断言「没崩、且判对」。
 */
function runReview(file, opts) {
  try {
    return review(file, opts);
  } catch (e) {
    return {
      threw: e,
      pass: false,
      fails: [`自检抛异常：${e.name}: ${e.message}`],
      warns: [],
      info: {},
    };
  }
}

// ---------------------------------------------------------------- 造输入

/** 自造正例的时长。所有断言都从这个数推，不写死秒数。 */
const GOOD_SECONDS = 3.2;
/** 自造配套字幕的条数。 */
const GOOD_SUBTITLES = 3;
/** 自造片的画幅（16:9）。 */
const GOOD_ASPECT = '16:9';

const GOOD = path.join(TMP, 'good.mp4');
const SRT = path.join(TMP, 'good.srt');

console.log('\n自造成片输入');
{
  // 有画面的短片 + 听得见的音轨 + 已知时长
  ff(['-y',
    '-f', 'lavfi', '-i', `testsrc2=s=320x180:r=24:d=${GOOD_SECONDS}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=44100:duration=${GOOD_SECONDS}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-shortest', GOOD]);

  // 配套字幕：条数必须已知，否则"字幕条数对得上"这条没法断言
  const at = (s) => {
    const hh = String(Math.floor(s / 3600)).padStart(2, '0');
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(Math.floor(s % 60)).padStart(2, '0');
    return `${hh}:${mm}:${ss},000`;
  };
  const blocks = [];
  for (let i = 0; i < GOOD_SUBTITLES; i++) {
    blocks.push(`${i + 1}\n${at(i)} --> ${at(i + 1)}\n第 ${i + 1} 句`);
  }
  fs.writeFileSync(SRT, blocks.join('\n\n') + '\n', 'utf8');

  check('自造成片落盘', fs.existsSync(GOOD) && fs.statSync(GOOD).size > 0, GOOD);
  check('自造字幕落盘', fs.existsSync(SRT), SRT);
}

// ---------------------------------------------------------------- 正例

console.log('\n成片自检（正例：健康的片子必须过）');
{
  const r = runReview(GOOD, {
    expectSeconds: GOOD_SECONDS,
    // 自造片不需要卡到 2 帧 —— 但要小到能抓住"时长根本不是这一部"这类错。
    toleranceFrames: 6,
    expectAspect: GOOD_ASPECT,
    srt: SRT,
    expectSubtitles: GOOD_SUBTITLES,
  });
  check('健康成片通过自检', r.pass, r.fails.join(' | '));
  check('解码 0 报错', r.info.decode_errors === 0, String(r.info.decode_errors));
  check('有音轨且不是静音', r.info.audio && r.info.loudness && r.info.loudness.mean > -50, JSON.stringify(r.info.loudness));
  check('抽帧不是全黑', (r.info.frame_luma || []).some((x) => x && x > 8), JSON.stringify(r.info.frame_luma));
  check('字幕条数对得上', r.info.subtitle_count === GOOD_SUBTITLES, `${r.info.subtitle_count} vs ${GOOD_SUBTITLES}`);
  check('画幅核对通过', Boolean(r.info.aspect) && r.info.aspect.got !== null, JSON.stringify(r.info.aspect));
  if (r.info.duration && r.info.loudness) {
    console.log(`       ${r.info.size_mb} MB　${r.info.duration.format.toFixed(2)}s　${r.info.duration.frames} 帧　mean ${r.info.loudness.mean} dB　max ${r.info.loudness.max} dB`);
  }
}

// ---- 回归守卫：画幅判据必须**真的会判**，而不是抛异常 ----
//
// 来历：`review.mjs` 用了 `aspectMatches` 却没 import，只 import 了 fs/path/spawnSync。
// 于是**凡是传了 expectAspect 的调用都抛 ReferenceError**；
// 而已删除的旧 `render.mjs` 合成阶段一直在传 `expectAspect: ASPECT`（`ASPECT` 恒为真值），
// 也就是说 **"成片也要核对画幅"这条判据从来没生效过** —— 合成一到自检就崩。
// 下面两条把它钉住：一条证明对的时候不抛，一条证明错的时候是"判失败"而不是"炸掉"。
console.log('\n画幅判据（回归守卫：不能靠抛异常"通过"）');
{
  const right = runReview(GOOD, { expectAspect: GOOD_ASPECT });
  const wrong = runReview(GOOD, { expectAspect: '9:16' });
  check('画幅对得上时不抛异常且通过', right.pass === true && !right.threw, JSON.stringify(right.fails));
  check('**画幅对不上时判失败，而不是抛异常**', !wrong.threw && !wrong.pass,
    wrong.threw ? `抛了 ${wrong.threw.name}：${wrong.threw.message}` : JSON.stringify(wrong.fails));
  check('  理由里点出画幅不符', wrong.fails.some((f) => /画幅不符/.test(f)), JSON.stringify(wrong.fails));
}

// ---------------------------------------------------------------- 负例

// ---- 负例 1：全黑 + 无音轨 ----
console.log('\n负例');
const black = path.join(TMP, 'black.mp4');
ff(['-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', black]);
const rb = runReview(black);
check('**全黑无音的片子被拦下**', !rb.pass, rb.fails.join(' | '));
check('  理由里点出没有音轨', rb.fails.some((f) => /没有音轨/.test(f)), rb.fails.join(' | '));
check('  理由里点出画面全黑', rb.fails.some((f) => /全是黑的|全黑/.test(f)), rb.fails.join(' | '));

// ---- 负例 2：有画面但音轨是死的 ----
const silent = path.join(TMP, 'silent.mp4');
ff(['-y', '-f', 'lavfi', '-i', 'testsrc=s=320x180:d=3', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '3',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', silent]);
const rs = runReview(silent);
check('**静音片子被拦下**', !rs.pass, rs.fails.join(' | '));
check('  理由里点出基本是静音', rs.fails.some((f) => /静音/.test(f)), rs.fails.join(' | '));

// ---- 负例 3：时长对不上时间轴 ----
const rl = runReview(silent, { expectSeconds: GOOD_SECONDS + 10, toleranceFrames: 2 });
check('时长不符被拦下', !rl.pass && rl.fails.some((f) => /与时间轴/.test(f)), rl.fails.join(' | '));

// ---- 负例 4：音视频流坏了（把整形后的字节砸烂，模拟 `-c copy` 拼错的那种） ----
{
  const broken = path.join(TMP, 'broken.mp4');
  const buf = fs.readFileSync(GOOD);
  // 从 40% 处开始把后半段打成噪声 —— 视频头还在，所以能读、但解码会报错
  for (let i = Math.floor(buf.length * 0.4); i < buf.length; i += 7) buf[i] = (buf[i] + 137) & 0xff;
  fs.writeFileSync(broken, buf);
  const rbr = runReview(broken);
  check('**音视频流被打坏的片子被拦下**', !rbr.pass, `decode_errors=${rbr.info.decode_errors} fails=${rbr.fails.join(' | ')}`);
  check('  确实是靠"解码报错"这一条抓到的', (rbr.info.decode_errors || 0) > 0, String(rbr.info.decode_errors));
}

// ---------------------------------------------------------------- 可选：真实成片

const filmAt = process.argv.indexOf('--film');
if (filmAt >= 0) {
  const film = process.argv[filmAt + 1];
  const boardAt = process.argv.indexOf('--board');
  const boardPath = boardAt >= 0 && process.argv[boardAt + 1]
    ? path.resolve(process.argv[boardAt + 1])
    : fixture(FIXTURE.board);

  console.log('\n真实成片（--film）');
  const { buildTimeline } = await import('../src/orchestrate.mjs');
  const b = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
  const tl = buildTimeline(b, Object.fromEntries(b.shots.map((s) => [s.id, s.duration_s])));
  const subtitles = tl.srt.trim() ? tl.srt.trim().split('\n\n').length : 0;
  console.log(`  期望来自板子：${tl.total_seconds.toFixed(2)}s / 字幕 ${subtitles} 条`);

  const r = runReview(film, {
    expectSeconds: tl.total_seconds,
    toleranceFrames: 3,
    srt: path.join(path.dirname(film), 'final.srt'),
    expectSubtitles: subtitles,
  });
  check('真实成片通过自检', r.pass, r.fails.join(' | '));
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
