#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';
import { speechSegmentsFromSilence, pickSampleTimes, windowRect, coverageText } from '../src/subcheck.mjs';

// ffmpeg silencedetect 的真实输出形态（stderr 里 silence_start / silence_end 成对出现）
const STDERR = [
	'[silencedetect @ 0x1] silence_start: 0',
	'[silencedetect @ 0x1] silence_end: 1.0 | silence_duration: 1.0',
	'[silencedetect @ 0x1] silence_start: 3.0',
	'[silencedetect @ 0x1] silence_end: 5.0 | silence_duration: 2.0',
].join('\n');

test('说话段 = 静音段的补集', () => {
	assert.deepEqual(speechSegmentsFromSilence(STDERR, 6), [[1, 3], [5, 6]]);
});

test('一段静音都没有时，整段都是说话段（不返回空）', () => {
	assert.deepEqual(speechSegmentsFromSilence('', 5), [[0, 5]]);
});

test('采样点全部落在说话段内，且取每格中点而不是段边界', () => {
	const speech = [[1, 3], [5, 6]];
	const t = pickSampleTimes(speech, 6, 4);
	assert.equal(t.length, 4);
	for (const x of t) {
		assert.ok(speech.some(([a, b]) => x >= a && x <= b), `${x} 不在说话段内`);
	}
	// 边界处台词刚起/刚收，字幕可能还没出现，所以第一个中点必须离开 1.0
	assert.ok(t[0] > 1.05 && t[0] < 2.95, `首个采样点贴边了: ${t[0]}`);
	assert.ok(Math.max(...t) <= 6);
});

test('窗口保持原视频宽高比 —— 这就是「按原视频比例截取」的判据', () => {
	const r = windowRect(480, 864, { window: 0.55, center: 0.6 });
	assert.equal(r.w, Math.round(480 * 0.55));
	assert.equal(r.h, Math.round(864 * 0.55));
	assert.ok(Math.abs((r.w / r.h) - (480 / 864)) < 0.01, '宽高比被改掉了');
	assert.equal(r.x, Math.round((480 - r.w) / 2), '没有水平居中');
});

test('窗口对准画面中段，且不会越出画面', () => {
	const r = windowRect(480, 864, { window: 0.55, center: 0.6 });
	assert.ok(r.topRatio > 0.30 && r.topRatio < 0.35, `上沿 ${r.topRatio}`);
	assert.ok(r.bottomRatio > 0.85 && r.bottomRatio < 0.90, `下沿 ${r.bottomRatio}`);
	const full = windowRect(480, 864, { window: 1, center: 1 });
	assert.equal(full.y, 0);
	assert.equal(full.h, 864);
	assert.equal(full.w, 480);
});

test('覆盖范围写成人能读的百分比（用来交代哪里没看到）', () => {
	assert.match(coverageText(windowRect(480, 864, { window: 0.5, center: 0.6 })), /^\d+\.\d%–\d+\.\d%$/);
});
