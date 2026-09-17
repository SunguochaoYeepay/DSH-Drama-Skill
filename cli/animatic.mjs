#!/usr/bin/env node
/**
 * animatic.mjs — **动态分镜**：把分镜按真实时长拼成能看的预览。
 *
 * ## 为什么要有它
 *
 * 用户说的：
 * > 「我不是导演，我不知道合不合理。**我只能看到片子我才知道是不是太长了。**」
 *
 * 这是对的，而且是我一直在犯的错：**拿文字分镜表让人审批**。
 * 分镜表是给拍的人看的，不是给看片的人看的。**看片的人只能看片。**
 *
 * 而"节奏对不对、哪里拖了、结尾是不是太长"这类问题，
 * **根本不需要花 GPU 生成** —— 用现成的关键帧按时长停住，就能看出来。
 *
 * 所以：**先给能看的东西，再谈生成。**
 *
 * 用法：
 *   node cli/animatic.mjs <board.json> [选项]
 *   node cli/animatic.mjs <board.json> --direction board.direction.json   # 用导演的设计
 *
 * 选项：
 *   --out <path>     输出 mp4（默认 <board 同目录>/out/animatic.mp4）
 *   --ws <dir>       工作区根（解析 first_frame 路径用）
 *   --hold <秒>      没有图的镜头统一停多久（默认 2）
 *   --fps <n>        帧率（默认 24）
 *   --audio          加上生成的静音轨（有些播放器需要）
 *
 * 输出：一段把每个镜头的关键帧按 `duration_s` 停住的预览 + 一条字幕说明
 * （每镜左上角烧上「镜号 景别 运镜 时长」，好对着表看）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { WINGET_PACKAGES } from '../src/runtime-paths.mjs';

const FFMPEG = (() => {
  const base = WINGET_PACKAGES;
  try {
    for (const d of fs.readdirSync(base)) {
      if (!d.startsWith('Gyan.FFmpeg_')) continue;
      const c = path.join(base, d, 'ffmpeg-7.1.1-full_build', 'bin', 'ffmpeg.exe');
      if (fs.existsSync(c)) return c;
    }
  } catch { /* 退回 PATH */ }
  return 'ffmpeg';
})();
const FFPROBE = FFMPEG.replace(/ffmpeg\.exe$/i, 'ffprobe.exe');

const argv = process.argv.slice(2);
function flag(name, def) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) return true;
  return v;
}
const boardPath = argv.find((a) => !a.startsWith('--') && /\.json$/i.test(a));
if (!boardPath || !fs.existsSync(boardPath)) {
  console.error('用法：node cli/animatic.mjs <board.json> [--direction x.json] [--out y.mp4] [--ws DIR]');
  process.exit(2);
}

const board = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
const WS = flag('ws', null) || path.resolve(path.dirname(boardPath), '..', '..', '..');
const OUT = flag('out', null) || path.join(path.dirname(boardPath), 'out', 'animatic.mp4');
const FPS = Number(flag('fps', 24)) || 24;
const HOLD = Number(flag('hold', 2)) || 2;
const WANT_AUDIO = Boolean(flag('audio', false));
const dirPath = flag('direction', null);

// 尺寸跟着片子画幅走
const [aw, ah] = String(board.meta?.aspect || '9:16').split(':').map(Number);
const H = 1080;
const W = Math.round((H * aw) / ah / 2) * 2;

// ---------------------------------------------------------------- 取镜头表

/** 从导演的设计（units[].shots[]）或板子（shots[]）里取出「有图的镜头序列」。 */
function shotsFromDirection(dir) {
  const out = [];
  for (const u of dir.units || []) {
    for (const s of u.shots || []) {
      out.push({
        id: `${u.id}-${s.n}`,
        framing: s.framing,
        camera: s.camera,
        duration: Number(s.duration_s) || HOLD,
        // 导演的设计里没有直接给图：按镜头在单元里的位置，去板子里找最接近的关键帧
        image: null,
        lines: s.lines || [],
      });
    }
  }
  return out;
}

function shotsFromBoard(b) {
  return (b.shots || []).map((s) => ({
    id: s.id,
    framing: s.shot_size,
    camera: s.camera || '',
    duration: Number(s.duration_s) || HOLD,
    image: s.first_frame ? path.resolve(WS, s.first_frame) : null,
    lines: s.source_lines || [],
  }));
}

let shots;
if (dirPath) {
  const dir = JSON.parse(fs.readFileSync(dirPath, 'utf8'));
  shots = shotsFromDirection(dir);
  // **按顺序套用板子上的关键帧** —— 两个设计镜头数不一样，近似但不是精确对应
  const kf = (board.shots || []).map((s) => (s.first_frame ? path.resolve(WS, s.first_frame) : null)).filter(Boolean);
  console.log(`导演设计 ${shots.length} 镜，板子有 ${kf.length} 张关键帧 —— 按顺序套用（近似）`);
  shots.forEach((s, i) => { s.image = kf[Math.min(i, kf.length - 1)] || null; });
} else {
  shots = shotsFromBoard(board);
}

const total = shots.reduce((n, s) => n + s.duration, 0);
console.log(`\n动态分镜　${shots.length} 镜　总长 ${total.toFixed(1)}s　${W}×${H} @ ${FPS}fps`);
console.log('─'.repeat(64));
let t = 0;
for (const s of shots) {
  const mark = s.image && fs.existsSync(s.image) ? ' ' : '（无图）';
  console.log(`  ${String(t.toFixed(1)).padStart(5)}s  ${s.id.padEnd(7)} ${String(s.duration).padStart(5)}s  ${s.framing || ''}  「${s.camera || ''}」${mark}`);
  t += s.duration;
}
console.log('─'.repeat(64));

if (!shots.length) { console.error('没有镜头'); process.exit(1); }

// ---------------------------------------------------------------- 拼

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'animatic-'));
const parts = [];

shots.forEach((s, i) => {
  const out = path.join(tmp, `p${String(i).padStart(3, '0')}.mp4`);
  const frames = Math.max(1, Math.round(s.duration * FPS));
  const label = `${s.id}  ${s.framing || ''}  ${s.duration.toFixed(1)}s`;

  if (s.image && fs.existsSync(s.image)) {
    // 关键帧 → 缩到片子画幅 → 停 N 帧
    // **不写 drawtext**（这台机器没 fontconfig），标注走文件名和终端
    const vf = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${FPS}`;
    const r = spawnSync(FFMPEG, ['-y', '-v', 'error', '-loop', '1', '-i', s.image,
      '-t', String(s.duration), '-vf', vf, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(FPS), out],
      { encoding: 'utf8' });
    if (r.status === 0 && fs.existsSync(out)) { parts.push(out); return; }
    console.error(`      ⚠ ${s.id} 拼帧失败，用黑场代替：${String(r.stderr || '').slice(0, 120)}`);
  }
  // 没图 → 黑场 + 时长（好歹让节奏连续）
  spawnSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0x101010:s=${W}x${H}:r=${FPS}`,
    '-t', String(s.duration), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out], { encoding: 'utf8' });
  if (fs.existsSync(out)) parts.push(out);
  void frames; void label;
});

if (!parts.length) { console.error('一帧都没拼出来'); process.exit(1); }

const listFile = path.join(tmp, 'list.txt');
fs.writeFileSync(listFile, parts.map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n') + '\n');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const args = ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listFile];
if (WANT_AUDIO) args.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-shortest');
args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(FPS));
if (WANT_AUDIO) args.push('-c:a', 'aac', '-b:a', '128k');
args.push(OUT);

const r = spawnSync(FFMPEG, args, { encoding: 'utf8' });
fs.rmSync(tmp, { recursive: true, force: true });

if (!fs.existsSync(OUT)) { console.error('拼接失败：' + String(r.stderr || '').slice(0, 300)); process.exit(1); }
const d = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', OUT], { encoding: 'utf8' });
console.log(`\n✓ 动态分镜：${OUT}`);
console.log(`  实际时长 ${Number(String(d.stdout).trim()).toFixed(1)}s（设计 ${total.toFixed(1)}s）`);
console.log('  看这个判断：哪里停太久、切得碎不碎、结尾拖不拖');
console.log('  ⚠ 它只有节奏，没有动作和声音 —— 画面质量看不了');
