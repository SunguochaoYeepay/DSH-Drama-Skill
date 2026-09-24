#!/usr/bin/env node
/**
 * subcheck.mjs — **去字幕之前的自检**：在"人说话的时间点"抽帧，按原视频比例截取画面中段，拼成一张可读的图。
 *
 * 由来（真实翻车）：
 *   核对 H3 有没有烧字幕时，我截的是 `crop=iw:ih*0.20:0:ih*0.68` + `scale=300:-1` + `tile=7x1`
 *   —— 每格 300×108px，一行字幕在里面约 8px 高，白字压在米白织物上根本分辨不出，
 *   于是我拿一张看不清字的图当成了"没有字幕"的证据 ✗。而字幕实际在画面的 66%–71%。
 *   同一批输出里它还跑到过 84%–91%（横屏），所以"按固定比例猜"本身也不可靠 ✗。
 *
 * 所以本工具做三件确定性的事：
 *   ① 采样只在**说话时刻**（字幕只随语音出现）；
 *   ② 窗口**保持原视频宽高比**（不是被压扁的横条）；
 *   ③ 窗口对准**画面中段**，并明确打印它**覆盖了哪一段、哪一段没看到**。
 *
 * 用法：
 *   node cli/subcheck.mjs <视频> [--out <png>] [--frames 6] [--window 0.55] [--center 0.60]
 *                             [--at 1.2,3.4] [--panel 640]
 *
 *   --frames  取几个时间点（默认 6）
 *   --window  截取窗口占画面高度的比例（默认 0.55）→ 字比全帧缩略图大约 1.8 倍
 *   --center  窗口纵向中心在画面高度的位置（默认 0.60 =「中部上下」）
 *   --at      手动指定时间点（秒，逗号分隔），覆盖自动的说话时刻检测
 *   --panel   每格放大到多少像素宽（默认 640）
 *
 * 看完这张图再决定要不要跑 cli/desub.mjs —— **别只看"文件存在"**。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { speechSegmentsFromSilence, pickSampleTimes, windowRect, coverageText } from '../src/subcheck.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => {
	const i = argv.indexOf(`--${n}`);
	return i < 0 ? d : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true);
};

const src = argv.find((a) => !a.startsWith('--') && fs.existsSync(a));
if (!src) {
	console.error(`用法: node cli/subcheck.mjs <视频> [--out <png>] [--frames 6] [--window 0.55] [--center 0.60]
                [--at 1.2,3.4] [--panel 640]

  --frames  取几个时间点（默认 6）
  --window  截取窗口占画面高度的比例（默认 0.55）—— 窗口**保持原视频宽高比**
  --center  窗口纵向中心位置（默认 0.60，「中部上下」）
  --at      手动指定时间点（秒，逗号分隔），覆盖自动检测
  --panel   每格放大到的像素宽（默认 640）`);
	process.exit(2);
}

const srcAbs = path.resolve(src);
const OUT = path.resolve(String(flag('out', path.join(path.dirname(srcAbs), `${path.basename(srcAbs, path.extname(srcAbs))}_subcheck.png`))));
const FRAMES = Number(flag('frames', 6));
const WIN = Number(flag('window', 0.55));
const CENTER = Number(flag('center', 0.60));
const PANEL = Number(flag('panel', 640));
const AT = flag('at', null);

// ---- 1. 量源视频 ----
const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
	'-show_entries', 'stream=width,height,r_frame_rate', '-show_entries', 'format=duration',
	'-of', 'default=nw=1', srcAbs], { encoding: 'utf8' });
const num = (key) => {
	const m = String(probe.stdout || '').match(new RegExp(`^${key}=(.+)$`, 'm'));
	return m ? m[1].trim() : '';
};
const W = Number(num('width'));
const H = Number(num('height'));
const DUR = Number(num('duration'));
const fpsRaw = num('r_frame_rate') || '24/1';
const [fpsN, fpsD] = fpsRaw.split('/').map(Number);
const FPS = fpsD ? fpsN / fpsD : (fpsN || 24);
if (!W || !H || !DUR) {
	console.error('✗ 读不到源视频的宽/高/时长（ffprobe 没装或文件不是视频？）');
	process.exit(1);
}

// ---- 2. 采样时刻：默认只在"人说话"的时候 ----
let speech = [];
let times = [];
if (AT && AT !== true) {
	times = String(AT).split(',').map((s) => Number(s.trim())).filter((t) => Number.isFinite(t) && t >= 0);
	speech = null;
} else {
	const sd = spawnSync('ffmpeg', ['-hide_banner', '-i', srcAbs,
		'-af', 'silencedetect=noise=-35dB:d=0.25', '-f', 'null', '-'], { encoding: 'utf8' });
	speech = speechSegmentsFromSilence(sd.stderr, DUR);
	times = pickSampleTimes(speech, DUR, FRAMES);
}

// ---- 3. 窗口：保持原视频比例、水平居中、对准中段 ----
const rect = windowRect(W, H, { window: WIN, center: CENTER });
const cols = Math.ceil(Math.sqrt(times.length));
const rows = Math.ceil(times.length / cols);

// ---- 4. 一次 ffmpeg 调用：抽这些帧 → 裁窗口 → 放大 → 拼网格 ----
const select = times.map((t) => `eq(n\\,${Math.round(t * FPS)})`).join('+');
const vf = `select='${select}',crop=${rect.w}:${rect.h}:${rect.x}:${rect.y},scale=${PANEL}:-1,tile=${cols}x${rows}`;
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const run = spawnSync('ffmpeg', ['-hide_banner', '-y', '-i', srcAbs, '-vf', vf, '-frames:v', '1', OUT], { encoding: 'utf8' });
if (!fs.existsSync(OUT)) {
	console.error('✗ 没产出。ffmpeg 最后几行：');
	console.error(String(run.stderr || '').split('\n').slice(-6).join('\n'));
	process.exit(1);
}

// ---- 5. 把"算了什么"讲清楚，尤其是**哪里没被看到** ----
console.log(`\n去字幕自检`);
console.log(`  源      ${path.basename(srcAbs)}　${W}×${H}　${DUR.toFixed(2)}s　${FPS.toFixed(2)}fps`);
if (speech === null) {
	console.log(`  采样    手动指定 ${times.length} 个时刻`);
} else if (speech.length) {
	console.log(`  说话段  ${speech.map(([a, b]) => `${a.toFixed(2)}–${b.toFixed(2)}s`).join('  ')}`);
} else {
	console.log(`  说话段  （没检测到语音 → 退化为整段均匀采样；纯环境音或音量过低时会这样）`);
}
console.log(`  采样时刻 ${times.map((t) => t.toFixed(2)).join('  ')}`);
console.log(`  截取窗口 宽 ${rect.w}×高 ${rect.h}（保持 ${(W / H).toFixed(3)} 原比例）`);
console.log(`           覆盖画面高度 ${coverageText(rect)}　横向居中`);
if (rect.topRatio > 0.02 || rect.bottomRatio < 0.98) {
	const missing = [];
	if (rect.topRatio > 0.02) missing.push(`顶部 0–${(rect.topRatio * 100).toFixed(1)}%`);
	if (rect.bottomRatio < 0.98) missing.push(`底部 ${(rect.bottomRatio * 100).toFixed(1)}–100%`);
	console.log(`           ⚠ 这两段没截到：${missing.join('、')}　→ 若怀疑字幕在画面很上方或很下方，加 --window 1`);
}
console.log(`  放大倍数 约 ${(1 / WIN).toFixed(1)}×（全帧缩略图看不清字幕，就是因为少了这一下）`);
console.log(`  网格      ${cols}×${rows}`);
console.log(`\n  → ${OUT}`);
console.log(`  看完这张图再决定要不要去字幕：**有字就去**，两条通道二选一 ——`);
console.log(`    · node cli/desub.mjs <视频> --top/--bottom      （VSR，走 Docker；句子长、吃显存）`);
console.log(`    · node cli/desub-void.mjs <视频> --auto-band（VOID，本地 ComfyUI，免 Docker）`);
console.log(`  --auto-band 自己找候选（tools/band_detect.py）；显式给 --top/--bottom/--left/--right 会覆盖它，`);
console.log(`  找不到候选时它**拒绝跑**而不是拿默认带蒙一个位置。VOID 跑完会自带"带内差/带外差"核查。`);
console.log(`  两条通道都别用默认带（默认值只是兜底）；完成后原片仍在，另存新文件。`);
console.log(`  ⚠ 换了产物就要按 references/qa-and-review.md 重批该段的 clip 票，否则合成取的还是带字幕的原片。`);
console.log(`  别只看"文件存在" ✗\n`);
