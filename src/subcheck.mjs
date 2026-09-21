/**
 * subcheck —— 去字幕**之前**的自检（纯逻辑，方便测试）
 *
 * 为什么要它：H3 会**不稳定地烧字幕** —— 同一个尺寸、同一套提示词，有的片段有、有的没有。
 * 于是"去字幕"第一步其实是"先确认字幕在不在、在哪"。而人手/agent 核对时最容易犯的错是**用错图**：
 *   · 截成 20:1 的横条 → 一行字幕在缩略图里只剩约 8px，看不清却被当成"没有字幕"（真实翻车两次 ✗）；
 *   · 按固定比例猜字幕带 → 同一批输出里字幕跑到了三个不同高度（竖屏 66%–71%、横屏 84%–91%、
 *     而 cli/desub.mjs 的默认带是 71%–87%）✗。
 *
 * 本模块给出三件**确定性**的东西，把"猜"换成"算"：
 *   1. 从 ffmpeg silencedetect 的输出求出**说话段** —— 字幕只在有语音时出现，采样必须落在说话时；
 *   2. 在这些段里均匀取 N 个采样时刻（取每格中点，避开刚起/刚收的边界）；
 *   3. 一个**保持原视频宽高比**、水平居中、纵向对准中段的截取窗口
 *      —— 窗口宽 = 窗口高 × (原宽/原高)，所以放大后文字不会被压扁，且只占画面中段、字自然更大。
 */

/**
 * 解析 ffmpeg `silencedetect` 的 stderr，返回**说话段**（静音段的补集）。
 * @param {string} stderr ffmpeg 的 stderr 原文
 * @param {number} duration 视频时长（秒）
 * @returns {Array<[number, number]>} 按时间排序的说话段
 */
export function speechSegmentsFromSilence(stderr, duration) {
	const starts = [];
	const ends = [];
	for (const line of String(stderr || '').split('\n')) {
		const s = line.match(/silence_start:\s*(-?[\d.]+)/);
		if (s) starts.push(Number(s[1]));
		const e = line.match(/silence_end:\s*(-?[\d.]+)/);
		if (e) ends.push(Number(e[1]));
	}
	const silences = [];
	for (let i = 0; i < starts.length; i++) {
		const from = Math.max(0, starts[i]);
		const to = Math.min(duration, ends[i] ?? duration);
		if (to > from) silences.push([from, to]);
	}
	silences.sort((a, b) => a[0] - b[0]);

	const speech = [];
	let cursor = 0;
	for (const [from, to] of silences) {
		if (from > cursor + 1e-6) speech.push([cursor, from]);
		cursor = Math.max(cursor, to);
	}
	if (cursor < duration - 1e-6) speech.push([cursor, duration]);
	// 太短的碎片没有采样价值
	return speech.filter(([a, b]) => b - a > 0.05);
}

/**
 * 在说话段里均匀取 N 个时刻（按各段时长加权分配）。没有说话段就整段均匀取。
 * @param {Array<[number, number]>} speech 说话段
 * @param {number} duration 时长（秒）
 * @param {number} n 采样个数
 */
export function pickSampleTimes(speech, duration, n) {
	const count = Math.max(1, Math.round(Number(n) || 1));
	const segs = speech && speech.length ? speech : [[0, duration]];
	const total = segs.reduce((s, [a, b]) => s + (b - a), 0);
	if (!(total > 0)) return [0];
	const times = [];
	for (let i = 0; i < count; i++) {
		// 取每格中点：段边界处台词刚起或刚收，字幕可能还没出/已消失
		const target = ((i + 0.5) / count) * total;
		let acc = 0;
		for (const [a, b] of segs) {
			const len = b - a;
			if (target <= acc + len) { times.push(a + (target - acc)); break; }
			acc += len;
		}
	}
	const last = Math.max(0, duration - 0.04);
	return times.map((t) => Math.min(Math.max(t, 0), last));
}

/**
 * 截取窗口：**保持原视频宽高比**、水平居中、纵向中心落在 center 处。
 *
 * 这是用户那条要求的落点 ——「按原视频比例截取」：窗口宽 = 窗口高 × (W/H)。
 * 因为它同时是"整帧按 win 缩放"，所以既不会像横条那样把文字压扁，
 * 又比全帧缩略图大 1/win 倍（win=0.55 → 字大 1.8 倍），字幕才真的看得见。
 *
 * @param {number} W 源宽
 * @param {number} H 源高
 * @param {{window?: number, center?: number}} opts window=窗口占画面高度的比例；center=窗口纵向中心位置
 */
export function windowRect(W, H, opts = {}) {
	const win = Math.min(1, Math.max(0.05, Number(opts.window ?? 0.55)));
	const center = Math.min(1, Math.max(0, Number(opts.center ?? 0.60)));
	const w = Math.max(1, Math.round(W * win));
	const h = Math.max(1, Math.round(H * win));
	const x = Math.max(0, Math.min(W - w, Math.round((W - w) / 2)));
	const y = Math.max(0, Math.min(H - h, Math.round(H * center - h / 2)));
	return { x, y, w, h, topRatio: y / H, bottomRatio: (y + h) / H };
}

/** 把窗口的纵向覆盖范围写成百分比文案（让调用方知道**哪里没被看到**）。 */
export function coverageText(rect) {
	const p = (v) => `${(v * 100).toFixed(1)}%`;
	return `${p(rect.topRatio)}–${p(rect.bottomRatio)}`;
}
