/**
 * `src/video-diff.mjs` —— 去字幕的**核查口径**。
 *
 * 这里守的是一个很容易自欺的地方：去字幕"输出存在、能播"就算成功。
 * 实际上两类翻车都不会报错：
 *   (a) 字幕根本没被抹掉（带画错了）
 *   (b) 掩码极性/位置反了，整帧被重画
 * 所以这些用例是**先造出这两类翻车**，再看裁决函数是否点得出来。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { diffStats, rectOf } from '../src/video-diff.mjs';

/** 造一帧灰度图：底色 base，矩形内填 fill。 */
function frame(width, height, base, rects = []) {
  const buf = new Uint8Array(width * height).fill(base);
  for (const r of rects) {
    for (let y = r.y; y < r.y + r.height; y++) {
      for (let x = r.x; x < r.x + r.width; x++) buf[y * width + x] = r.fill;
    }
  }
  return buf;
}

const W = 20;
const H = 20;
const BAND = { x: 4, y: 8, width: 12, height: 4 };

test('rectOf：两条边各算各的（"宽度=比例×宽"会差 1 像素）', () => {
  assert.deepEqual(rectOf({ top: 0.695, bottom: 0.805, left: 0.28, right: 0.72 }, 480, 864),
    { x: 134, y: 600, width: 212, height: 96 });
  // 0.72*480=345.6→346，0.28*480=134.4→134，差 212（"宽度=比例×宽"的算法会给 211）
  assert.deepEqual(rectOf({ left: 0, top: 0, right: 1, bottom: 1 }, 100, 50), { x: 0, y: 0, width: 100, height: 50 });
});

test('带内被改、带外没动 → band_only（这是想要的结果）', () => {
  const a = frame(W, H, 100, [{ ...BAND, fill: 200 }]);          // 带里有"字幕"
  const b = frame(W, H, 100, []);                                 // 字幕被抹掉
  const s = diffStats(a, b, { width: W, height: H, frames: 1, rect: BAND });
  assert.equal(s.verdict, 'band_only');
  assert.ok(s.band > 2, `带内差应显著：${s.band}`);
  assert.equal(s.outside, 0);
});

test('带外也被重画（极性反了）→ suspicious_whole_frame', () => {
  const a = frame(W, H, 100, []);
  const b = frame(W, H, 100, [
    { ...BAND, fill: 100 },                                       // 带原样保留
    { x: 0, y: 0, width: W, height: 8, fill: 40 },                // 带外被改成另一画面
    { x: 0, y: 12, width: W, height: 8, fill: 40 },
  ]);
  const s = diffStats(a, b, { width: W, height: H, frames: 1, rect: BAND });
  assert.equal(s.verdict, 'suspicious_whole_frame');
  assert.ok(s.band < 2, `带内几乎没动：${s.band}`);
  assert.ok(s.outside > 20, `带外改得很多：${s.outside}`);
});

test('全白掩码透传（什么都没做）→ band_untouched', () => {
  const a = frame(W, H, 100, [{ ...BAND, fill: 200 }]);
  const b = frame(W, H, 100, [{ ...BAND, fill: 200 }]);
  const s = diffStats(a, b, { width: W, height: H, frames: 1, rect: BAND });
  assert.equal(s.verdict, 'band_untouched');
  assert.equal(s.band, 0);
  assert.equal(s.outside, 0);
});

test('ratio 是主判据：带内改动强度 / 带外改动强度', () => {
  const a = frame(W, H, 100, [{ ...BAND, fill: 200 }]);
  const b = frame(W, H, 90, [{ ...BAND, fill: 190 }]);            // 带内 10、带外 10
  const s = diffStats(a, b, { width: W, height: H, frames: 1, rect: BAND });
  assert.equal(s.band, 10);
  assert.equal(s.outside, 10);
  assert.equal(s.ratio, 1);
  assert.equal(s.verdict, 'suspicious_whole_frame', '带内外一样大就不能说"只改了字幕带"');
});

test('多帧是累计的，不是只看最后一帧', () => {
  const n = 4;
  const big = new Uint8Array(W * H * n);
  const bb = new Uint8Array(W * H * n);
  for (let f = 0; f < n; f++) {
    // 只有最后一帧有"字幕"、其余帧干净 —— 只看最后一帧会高估，只看第一帧会低估
    big.set(f === n - 1 ? frame(W, H, 100, [{ ...BAND, fill: 200 }]) : frame(W, H, 100, []), f * W * H);
    bb.set(frame(W, H, 100, []), f * W * H);
  }
  const s = diffStats(big, bb, { width: W, height: H, frames: n, rect: BAND });
  assert.equal(s.frames, n);
  // 只有 1/4 的帧有字 → 带内均值被摊薄，但仍应 > 0 且带外为 0
  assert.ok(s.band > 0 && s.band < 200);
  assert.equal(s.outside, 0);
  assert.equal(s.verdict, 'band_only');
});

test('字节数不够要报错，不许拿短 buffer 算出一半的数', () => {
  assert.throws(() => diffStats(new Uint8Array(10), new Uint8Array(10), { width: W, height: H, frames: 1, rect: BAND }), /字节数不够/);
  assert.throws(() => diffStats(new Uint8Array(0), new Uint8Array(0), { width: 0, height: 0, frames: 1, rect: BAND }), /尺寸\/帧数非法/);
});
