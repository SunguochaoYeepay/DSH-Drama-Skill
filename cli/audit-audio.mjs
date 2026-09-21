#!/usr/bin/env node
/**
 * audit-audio.mjs — **量一段视频的音轨到底响不响、什么时候响**。
 *
 * 为什么要有它：H3 会自带音轨，`inspect.mjs` 只报"有音轨 / mean 多少 dB"，
 * 但"有音轨"和"该响的时候响了"是两件事。上一部剧里导演写了「闹钟持续不断的铃声」，
 * 提示词也确实送进了 H3，实测却是**开场 2 秒近乎静音、铃声迟到** ——
 * 这种问题只有按时域切片量才看得见。
 *
 * 量什么：
 *   · 全频 / 低频(<300Hz) / 高频(>2.5kHz) 的 mean 与 peak —— 频段能区分「环境底噪」和「铃声敲击」；
 *   · 每 `--step` 秒一格的时间线（默认 0.25s）—— 看声音**什么时候**出现；
 *   · 开场 `--head` 秒内（默认 2s）是否近乎无声；
 *   · `-74 dB` 视为数字静音（ffmpeg volumedetect 对静音给这个值）。
 *
 * 用法：
 *   node cli/audit-audio.mjs <视频...>
 *   node cli/audit-audio.mjs --project <项目目录> --units g001,g002
 *
 * 选项：
 *   --step <秒>    时间线粒度（默认 0.25）
 *   --head <秒>    开场窗口，判"冷启动"（默认 2）
 *   --silent <dB>  静音阈值（默认 -74）
 *   --gap <dB>     开场比全段峰值低多少就算"迟到/过轻"（默认 12）
 *   --out <path>   报告写入路径
 *   --no-out       只打终端
 *
 * 退出码：0 = 全部文件都有音轨（内容静音只是**发现**，不算失败）；
 *         1 = 有文件没有音轨、或 ffmpeg/ffprobe 不可用。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { FFMPEG, FFPROBE } from '../src/runtime-paths.mjs';

// ---------------------------------------------------------------- 参数

const argv = process.argv.slice(2);
const flag = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? '') : dflt;
};
const has = (name) => argv.includes(`--${name}`);
const num = (name, dflt) => {
  const v = Number(flag(name, String(dflt)));
  return Number.isFinite(v) ? v : dflt;
};

const STEP = num('step', 0.25);
const HEAD = num('head', 2);
const SILENT = num('silent', -74);
const GAP = num('gap', 12);
const NO_OUT = has('no-out');

const files = [];
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) { if (['--project', '--units', '--out'].includes(a)) i++; continue; }
  const prev = argv[i - 1];
  if (['--project', '--units', '--out', '--step', '--head', '--silent'].includes(prev)) continue;
  positional.push(a);
}
files.push(...positional);

const PROJECT = flag('project');
const UNITS = flag('units');
if (PROJECT && UNITS) {
  for (const u of UNITS.split(',').map((s) => s.trim()).filter(Boolean)) {
    // 命名不统一：视频是 `units/g001.result.json`，关键帧是 `keyframes_local_v2/.g001.result.json`。
    const rp = ['units', 'keyframes_local_v2']
      .flatMap((d) => [path.join(PROJECT, d, `${u}.result.json`), path.join(PROJECT, d, `.${u}.result.json`)])
      .find((p) => fs.existsSync(p));
    if (!rp) {
      console.error(`在 ${PROJECT} 的 units / keyframes_local_v2 下找不到 ${u}.result.json`);
      process.exit(1);
    }
    const j = JSON.parse(fs.readFileSync(rp, 'utf8'));
    const local = j.files?.[0]?.local_path || j.local_files?.[0];
    if (!local) { console.error(`${rp} 里没有产物路径`); process.exit(1); }
    files.push(local);
  }
}
if (!files.length) {
  console.error('用法：node cli/audit-audio.mjs <视频...>  或  --project <目录> --units g001,g002');
  process.exit(1);
}

// ---------------------------------------------------------------- 量

const NUL = process.platform === 'win32' ? 'NUL' : '/dev/null';

function probe(file) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name,sample_rate,channels', '-of', 'csv=p=0', file],
  { encoding: 'utf8', maxBuffer: 1e7 });
  return (r.stdout || '').trim();
}

function duration(file) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
    { encoding: 'utf8', maxBuffer: 1e7 });
  return Number((r.stdout || '').trim()) || 0;
}

/** @returns {{mean:number, max:number}} dBFS；量不到给 NaN */
function measure(file, af, start = null, len = null) {
  const args = ['-nostats', '-hide_banner'];
  if (start != null) args.push('-ss', String(start), '-t', String(len));
  args.push('-i', file, '-map', '0:a', '-af', af, '-f', 'null', NUL);
  const r = spawnSync(FFMPEG, args, { encoding: 'utf8', maxBuffer: 1e8 });
  const s = String(r.stderr || '');
  return {
    mean: Number((s.match(/mean_volume:\s*([-\d.]+) dB/) || [])[1]),
    max: Number((s.match(/max_volume:\s*([-\d.]+) dB/) || [])[1]),
  };
}

const band = (file, kind) => {
  if (kind === 'low') return measure(file, 'lowpass=f=300,volumedetect');
  if (kind === 'high') return measure(file, 'highpass=f=2500,volumedetect');
  return measure(file, 'volumedetect');
};

const fmt = (v, w = 7) => (Number.isFinite(v) ? v.toFixed(1) : '—').padStart(w);

// ---------------------------------------------------------------- 报告

const out = [];
const problems = [];
out.push('# 音轨审计');
out.push('');
out.push(`单位 dBFS。低频 = <300Hz，高频 = >2.5kHz（金属铃声主体在 2–6kHz）。`);
out.push(`时间线粒度 ${STEP}s；静音阈值 ${SILENT} dB。`);
out.push('');

for (const file of files) {
  const name = path.basename(file);
  const stream = probe(file);
  out.push(`## ${name}`);
  out.push('');

  if (!stream) {
    out.push('❌ **没有音轨** —— ffprobe 选不到 a:0。');
    out.push('');
    console.log(`${name.padEnd(34)} ❌ 无音轨`);
    problems.push(name);
    continue;
  }

  const full = band(file, 'full');
  const low = band(file, 'low');
  const high = band(file, 'high');
  const dur = duration(file);

  out.push('| 项 | 值 |');
  out.push('|---|---|');
  out.push(`| 音轨 | \`${stream}\` |`);
  out.push(`| 时长 | ${dur.toFixed(2)}s |`);
  out.push(`| 全频 mean / peak | ${fmt(full.mean)} / ${fmt(full.max)} |`);
  out.push(`| <300Hz mean | ${fmt(low.mean)} |`);
  out.push(`| >2.5kHz mean | ${fmt(high.mean)} |`);
  out.push(`| 高频−低频 | ${fmt(high.mean - low.mean)} |`);
  out.push('');

  // 时间线
  const rows = [];
  for (let t = 0; t < dur - 0.01; t += STEP) {
    rows.push({
      t,
      rms: measure(file, 'volumedetect', t, STEP).mean,
      hi: measure(file, 'highpass=f=2500,volumedetect', t, STEP).mean,
    });
  }
  const his = rows.map((r) => r.hi).filter(Number.isFinite);
  const hiMax = his.length ? Math.max(...his) : 0;
  const hiMin = his.length ? Math.min(...his) : 0;
  const bar = (v) => {
    if (!Number.isFinite(v)) return '(静音)';
    const span = Math.max(hiMax - hiMin, 1);
    const n = Math.round(((v - hiMin) / span) * 24);
    return '#'.repeat(n).padEnd(24, '.') + ' ' + v.toFixed(1);
  };

  out.push('### 时间线（每格高频能量）');
  out.push('');
  out.push('```');
  out.push(`  t      全频     高频(>2.5kHz)`);
  for (const r of rows) {
    out.push(`${r.t.toFixed(2).padStart(5)}s ${fmt(r.rms, 6)}   ${bar(r.hi)}`);
  }
  out.push('```');
  out.push('');

  // 开场冷启动判定。
  //
  // 只看绝对静音是不够的：上一部剧 g001 开场有 -51 dB 的底噪，按"数字静音"判是通过的，
  // 但它比全段峰值低了 24 dB —— 那场戏的前提是"闹钟正在响"，前两秒听不见，动机就是悬空的。
  // 所以两条都看：① 开场窗口近乎数字静音；② 开场比全段峰值低 `--gap` dB 以上（默认 12）。
  const headRows = rows.filter((r) => r.t < HEAD);
  const headBest = headRows.length ? Math.max(...headRows.map((r) => (Number.isFinite(r.hi) ? r.hi : -120))) : -120;
  const gap = Number.isFinite(hiMax) ? hiMax - headBest : 0;
  const mute = headBest <= SILENT + 3;
  const late = !mute && gap >= GAP;

  if (mute) {
    out.push(`⚠ **开场 ${HEAD}s 内高频最高只有 ${headBest.toFixed(1)} dB**（≈ 数字静音）—— 声音缺席。`);
  } else if (late) {
    out.push(`⚠ **开场 ${HEAD}s 内高频峰值 ${headBest.toFixed(1)} dB，比全段峰值低 ${gap.toFixed(1)} dB**`
      + ` —— 声音迟到或开场过轻（阈值 ${GAP} dB）。`);
  } else {
    out.push(`✓ 开场 ${HEAD}s 内有声（高频峰值 ${headBest.toFixed(1)} dB，与全段峰值差 ${gap.toFixed(1)} dB）。`);
  }
  out.push(`全段高频峰值出现在 ${rows.filter((r) => r.hi === hiMax).map((r) => r.t.toFixed(2) + 's').slice(0, 3).join(' / ')}。`);
  out.push('');

  console.log(`${name.padEnd(34)} 全频 ${fmt(full.mean)} 低频 ${fmt(low.mean)} 高频 ${fmt(high.mean)}`
    + `  开场 ${fmt(headBest, 6)} vs 峰值 ${fmt(hiMax, 6)}`
    + `  ${mute ? '⚠ 开场静音' : late ? `⚠ 迟到 ${gap.toFixed(0)}dB` : '✓'}`);
}

const target = NO_OUT ? null : (flag('out') || (PROJECT ? path.join(PROJECT, 'reviews', 'audio-audit.md') : null));
if (target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, out.join('\n'), 'utf8');
  console.log(`\n报告：${target}`);
}
if (problems.length) {
  console.error(`\n${problems.length} 个文件没有音轨：${problems.join(', ')}`);
  process.exit(1);
}
