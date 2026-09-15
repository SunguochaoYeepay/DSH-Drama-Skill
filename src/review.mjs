/**
 * review.mjs — 成片自检。**不过就不许说成功。**
 *
 * 这个模块的来历：成片出来时我报的是"成功"，而它的音轨其实是坏的
 * （无台词镜头保留了 H3 的 32000Hz 音轨、有台词的换成 TTS，混着 `-c copy` 拼，
 *  AAC 比特流废掉。播放器能读出时长，解码器满屏 `channel element ... is not allocated`，
 *  听上去就是没声音）。**是用户用耳朵发现的，不是我的检查。**
 *
 * 教训：**"文件存在"不等于"成片能看"。** 每一次渲染后都必须真的去读一遍产物。
 *
 * 判据分两类：
 *   硬失败（exit 1）：解不出、没有音轨、音轨是死的、时长对不上、抽帧全黑
 *   警告（不影响退出码）：响度偏低、削波、字幕缺失
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const FFMPEG = (() => {
  const base = 'C:\\Users\\Administrator\\AppData\\Local\\Microsoft\\WinGet\\Packages';
  try {
    for (const dir of fs.readdirSync(base)) {
      if (!dir.startsWith('Gyan.FFmpeg_')) continue;
      const c = path.join(base, dir, 'ffmpeg-7.1.1-full_build', 'bin', 'ffmpeg.exe');
      if (fs.existsSync(c)) return c;
    }
  } catch { /* 退回 PATH */ }
  return 'ffmpeg';
})();
const FFPROBE = FFMPEG.replace(/ffmpeg\.exe$/i, 'ffprobe.exe');

function probe(args) {
  return spawnSync(FFPROBE, args, { encoding: 'utf8' }).stdout || '';
}
function run(args) {
  return spawnSync(FFMPEG, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
}

/**
 * **整片完整解码一遍，数报错行。**
 * 这一条是本次的核心 —— 它一个就能抓住那个"听起来没声音"的 bug。
 */
export function decodeErrors(file) {
  const r = run(['-v', 'error', '-i', file, '-f', 'null', process.platform === 'win32' ? 'NUL' : '-']);
  const lines = String(r.stderr || '').split(/\r?\n/).filter((l) => l.trim());
  return { count: lines.length, sample: lines.slice(0, 3) };
}

/** 音频响度与峰值。 */
export function loudness(file) {
  const r = run(['-i', file, '-af', 'volumedetect', '-f', 'null', process.platform === 'win32' ? 'NUL' : '-']);
  const text = String(r.stderr || '');
  const mean = text.match(/mean_volume:\s*(-?[\d.]+) dB/);
  const max = text.match(/max_volume:\s*(-?[\d.]+) dB/);
  return {
    mean: mean ? Number(mean[1]) : null,
    max: max ? Number(max[1]) : null,
  };
}

/** 有没有音轨、参数是什么。 */
export function audioStream(file) {
  const out = probe(['-v', 'error', '-select_streams', 'a:0', '-show_entries',
    'stream=codec_name,sample_rate,channels,bit_rate,duration', '-of', 'default=noprint_wrappers=1', file]);
  if (!out.trim()) return null;
  const g = (k) => (out.match(new RegExp(`${k}=(.+)`)) || [])[1];
  return {
    codec: g('codec_name'),
    sample_rate: Number(g('sample_rate')),
    channels: Number(g('channels')),
    bit_rate: Number(g('bit_rate')),
    duration: Number(g('duration')),
  };
}

/** 视频流与容器的时长。 */
export function durations(file) {
  const v = probe(['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=duration,nb_frames', '-of', 'default=noprint_wrappers=1', file]);
  const f = probe(['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return {
    video: Number((v.match(/duration=(.+)/) || [])[1]),
    frames: Number((v.match(/nb_frames=(.+)/) || [])[1]),
    format: Number(f.trim()),
  };
}

/** 抽 N 帧，返回每帧的平均亮度 —— 全黑或全白说明渲染坏了。 */
export function frameLuma(file, count = 5) {
  const total = durations(file).format || 0;
  const luma = [];
  for (let i = 0; i < count; i++) {
    const t = total > 0 ? (total * (i + 0.5)) / count : 0;
    const r = run(['-ss', t.toFixed(3), '-i', file, '-frames:v', '1',
      '-vf', 'scale=160:90,format=gray,signalstats,metadata=print',
      '-f', 'null', process.platform === 'win32' ? 'NUL' : '-']);
    const m = String(r.stderr || '').match(/lavfi\.signalstats\.YAVG=([\d.]+)/);
    luma.push(m ? Number(m[1]) : null);
  }
  return luma;
}

/** 数 SRT 里的字幕条数。 */
export function subtitleCount(srtPath) {
  if (!srtPath || !fs.existsSync(srtPath)) return 0;
  return fs.readFileSync(srtPath, 'utf8').trim().split(/\n\n+/).filter((b) => b.includes('-->')).length;
}

/**
 * 跑全部检查。
 * @returns {{pass: boolean, fails: string[], warns: string[], info: object}}
 */
export function review(file, opts = {}) {
  const fails = [];
  const warns = [];
  const info = {};

  if (!fs.existsSync(file)) {
    return { pass: false, fails: [`成片不存在：${file}`], warns, info };
  }
  info.size_mb = Number((fs.statSync(file).size / 1048576).toFixed(1));

  // ① 完整解码 —— 最重要的一条
  const dec = decodeErrors(file);
  info.decode_errors = dec.count;
  if (dec.count > 0) {
    fails.push(`解码报错 ${dec.count} 行（音视频流可能是坏的）：${dec.sample.join(' / ').slice(0, 160)}`);
  }

  // ② 音轨
  const a = audioStream(file);
  info.audio = a;
  if (!a) {
    fails.push('成片没有音轨');
  } else {
    if (!a.duration || a.duration < 0.5) fails.push(`音轨时长只有 ${a.duration}s`);
    const dur = durations(file);
    info.duration = dur;
    if (dur.format && a.duration && Math.abs(dur.format - a.duration) > 0.5) {
      fails.push(`音轨时长 ${a.duration.toFixed(2)}s 与容器 ${dur.format.toFixed(2)}s 差 ${Math.abs(dur.format - a.duration).toFixed(2)}s`);
    }
    const l = loudness(file);
    info.loudness = l;
    if (l.mean === null) fails.push('量不到音频电平（音轨可能解不开）');
    else if (l.mean < -50) fails.push(`整片平均电平 ${l.mean} dB —— 基本是静音`);
    else if (l.mean < -32) warns.push(`整片平均电平偏低（${l.mean} dB）`);
    if (l.max !== null && l.max >= -0.1) warns.push(`峰值顶到 ${l.max} dB，有削波`);
  }

  // ③ 时长必须对得上时间轴
  if (opts.expectSeconds !== undefined && opts.expectSeconds !== null) {
    const dur = info.duration || durations(file);
    const diff = Math.abs(dur.format - opts.expectSeconds);
    const tol = (opts.toleranceFrames || 2) / 24;
    info.duration_diff = Number(diff.toFixed(3));
    if (diff > tol + 0.05) {
      fails.push(`成片 ${dur.format.toFixed(2)}s 与时间轴 ${Number(opts.expectSeconds).toFixed(2)}s 差 ${diff.toFixed(2)}s（容差 ${tol.toFixed(3)}s）`);
    }
  }

  // ④ 抽帧不能全黑 / 全白
  const luma = frameLuma(file, opts.frames || 5);
  info.frame_luma = luma;
  const known = luma.filter((x) => x !== null);
  if (known.length && known.every((x) => x < 8)) fails.push(`抽帧全是黑的（亮度 ${known.join('/')}）`);
  else if (known.length && known.every((x) => x > 247)) fails.push(`抽帧全是白的（亮度 ${known.join('/')}）`);

  // ⑤ 字幕
  if (opts.srt) {
    const n = subtitleCount(opts.srt);
    info.subtitle_count = n;
    const expect = opts.expectSubtitles;
    if (expect !== undefined && n !== expect) {
      (n === 0 ? fails : warns).push(`字幕 ${n} 条，期望 ${expect} 条`);
    }
  }

  return { pass: fails.length === 0, fails, warns, info };
}
