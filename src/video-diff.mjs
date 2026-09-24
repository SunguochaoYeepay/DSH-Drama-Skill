/**
 * video-diff —— **"去字幕到底改了什么"** 的可断言口径。
 *
 * 为什么需要它：去字幕是个**看起来成功**很容易的操作 —— 输出存在、时长对、能播，
 * 但可能（a）字幕根本没被抹掉，（b）掩码极性反了把整帧重画了。这两种翻车
 * 用眼睛看单帧都可能漏（尤其 (a)，字还在但淡了）。所以这里只做一件事：
 * 逐像素量"带内改了多少、带外改了多少"，让判断落在数字上。
 *
 * 口径（与 `lab/spatial` 的实验一致）：
 *   band    字幕带内的平均绝对灰度差 —— **越大越说明带被真的重画了**
 *   outside 带外的平均绝对灰度差 —— **越小越说明画面其余部分被保留**
 * 判读：band 明显大于 outside = 这次去字幕做了该做的事；
 *       outside 和 band 一样大 = 掩码极性/位置反了，整帧都被重画（实测反极性时带外差 100.99）。
 *
 * 纯函数：输入是两段**同尺寸、同帧数**的灰度原始帧，输出统计量。解码交给调用方（ffmpeg）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { FFMPEG } from './runtime-paths.mjs';

/**
 * 往返编码底噪（灰度均值差）。实测来源：480×864 的 3 秒片段，
 * 全白掩码（= 什么都不修、原样透传）跑完两趟后 带内 4.6 / 带外 3.9。
 * 低于这个量级的变化判成"没动"，否则会把编码噪声当成功劳。
 */
export const NOISE_FLOOR = 6;

/** 百分比带 → 像素矩形；越界钳制，保证至少 1 像素。
 *
 *  **必须与 `tools/band_mask.py` 算出同一个矩形** —— 否则"我量的带"和"我修的带"不是一个带，
 *  量出来的数就答非所问。两边都按"两条边各算各的再相减"来取整。 */
export function rectOf(band, width, height) {
  const x0 = Math.max(0, Math.min(width - 1, Math.round(Number(band.left) * width)));
  const y0 = Math.max(0, Math.min(height - 1, Math.round(Number(band.top) * height)));
  const x1 = Math.max(x0 + 1, Math.min(width, Math.round(Number(band.right) * width)));
  const y1 = Math.max(y0 + 1, Math.min(height, Math.round(Number(band.bottom) * height)));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * 量两段灰度帧的差异。
 *
 * @param {Uint8Array} a 原始灰度帧（len = width*height*frames）
 * @param {Uint8Array} b 同上
 * @param {{width:number,height:number,frames:number,rect:{x,y,width,height}}} opts
 * @param {number} [noiseFloor] 往返编码的底噪（见下），默认 6
 * @returns {{frames:number,band:number,outside:number,band_max:number,outside_max:number,ratio:number,verdict:string}}
 */
export function diffStats(a, b, { width, height, frames, rect, noiseFloor = NOISE_FLOOR }) {
  const per = width * height;
  if (!(width > 0 && height > 0 && frames > 0)) throw new Error(`尺寸/帧数非法：${width}x${height}x${frames}`);
  for (const [name, buf] of [['a', a], ['b', b]]) {
    if (!buf || buf.length < per * frames) {
      throw new Error(`${name} 的字节数不够：需要 ${per * frames}，拿到 ${buf ? buf.length : 0}`);
    }
  }
  let bandSum = 0; let bandN = 0; let bandMax = 0;
  let outSum = 0; let outN = 0; let outMax = 0;

  for (let f = 0; f < frames; f += 1) {
    const base = f * per;
    for (let y = 0; y < height; y += 1) {
      const row = base + y * width;
      const inBandRow = y >= rect.y && y < rect.y + rect.height;
      for (let x = 0; x < width; x += 1) {
        const d = Math.abs(a[row + x] - b[row + x]);
        if (inBandRow && x >= rect.x && x < rect.x + rect.width) {
          bandSum += d; bandN += 1; if (d > bandMax) bandMax = d;
        } else {
          outSum += d; outN += 1; if (d > outMax) outMax = d;
        }
      }
    }
  }
  const r2 = (v) => Math.round(v * 100) / 100;
  const band = bandN ? bandSum / bandN : 0;
  const outside = outN ? outSum / outN : 0;
  const ratio = outside > 0 ? band / outside : (band > 0 ? Infinity : 0);

  // 判读阈值写死在这里，免得每个调用方各拍一个数。
  //
  // **底噪必须先扣掉**：VOID 一趟本身就是"解码→推理→再编码"，即使一概不改，
  // 带内带外也各有 ~4 的灰度差（实测：全白掩码=透传时 带内 4.6 / 带外 3.9）。
  // 所以"带内没动"不能写成 band < 2 —— 那样永远判不出来。
  let verdict;
  if (band < noiseFloor && outside < noiseFloor) verdict = 'band_untouched';
  else if (ratio >= 1.5) verdict = 'band_only';
  else verdict = 'suspicious_whole_frame';
  return { frames, band: r2(band), outside: r2(outside), band_max: bandMax, outside_max: outMax, ratio: Number.isFinite(ratio) ? r2(ratio) : null, verdict };
}

/** 抽灰度帧到 `<tmpDir>/<tag>.raw`，返回字节。隔 `step` 帧取一张，够判读就行。 */
function dumpGray(file, { width, height, step, tmpDir, tag }) {
  fs.mkdirSync(tmpDir, { recursive: true });
  const raw = path.join(tmpDir, `${tag}.raw`);
  const r = spawnSync(FFMPEG, ['-v', 'error', '-y', '-i', file,
    '-vf', `select='not(mod(n\\,${step}))',format=gray`, '-fps_mode', 'passthrough',
    '-f', 'rawvideo', raw], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`抽帧失败（${path.basename(file)}）：${String(r.stderr || '').slice(0, 200)}`);
  return fs.readFileSync(raw);
}

/**
 * 端到端核查：解码 + 比较 + 判读。`frames` 用**输入的**总帧数（输出可能少一帧）。
 *
 * @returns {{frames:number,band:number,outside:number,ratio:number|null,verdict:string,rect:object}|null}
 *          抽不出帧时返回 null（不抛 —— 核查失败不该把已经跑出来的产物判成失败）。
 */
export function verifyBandEdit({ input, output, width, height, frames, band, sampleFrames = 12, tmpDir = '.tmp' }) {
  const per = width * height;
  if (!(per > 0) || !(frames > 0)) return null;
  const step = Math.max(1, Math.floor(frames / sampleFrames));
  const rect = rectOf(band, width, height);
  let fa; let fb;
  try {
    fa = dumpGray(input, { width, height, step, tmpDir, tag: `${path.basename(input, path.extname(input))}-${width}x${height}` });
    fb = dumpGray(output, { width, height, step, tmpDir, tag: `${path.basename(output, path.extname(output))}-${width}x${height}` });
  } catch {
    return null;
  }
  const n = Math.min(Math.floor(fa.length / per), Math.floor(fb.length / per));
  if (n <= 0) return null;
  return { ...diffStats(fa, fb, { width, height, frames: n, rect }), rect };
}
