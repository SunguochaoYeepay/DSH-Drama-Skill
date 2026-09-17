/**
 * qa.mjs — 「质检」这一步：**看完产出的画面，判它能不能用**。
 *
 * ## 为什么要有这个角色
 *
 * 我（AI）一直是**自己随手看一眼就下结论** —— 而且一晚上看错了四五次：
 * 「H3 不烧字幕」（只查了一个文件）、「768 不烧字幕」（同上）、
 * 「尾段没雪花」（只抽到 13.25 秒，崩坏在 13.52 秒之后）。
 *
 * 而且**每个阶段都该有这一道**：资产、关键帧、片段、成片。
 * 所以它是个**角色**，不是一次性动作 —— 和「导演」是同一个模式。
 *
 * ## 职责边界（和导演刚好互补）
 *
 * ```
 * 导演   产出之前：决定怎么拍（创作判断）
 * 质检   产出之后：判断拍出来能不能看（验收判断）
 * ```
 *
 * ## ⚠ 最重要的一条
 *
 * > **通过 ≠ 可以往下走。通过 = 可以问用户了。**
 *
 * 质检是**把关的，不是开门的**。用户才是唯一能说"往下走"的人。
 * 查出问题 → 报出来，**不要拿没做完的东西去打扰用户**。
 * 查完干净 → **才去问用户**「这批 OK 吗？」
 *
 * ## 它看什么
 *
 * 技术指标（分辨率/帧数/编码/时长）**由 `cli/inspect.mjs` 去量**，不用它管。
 * **它管代码量不出来的**：脸是不是同一个人、景别对不对、朝向对不对、尾段糊没糊。
 *
 * 视觉能力：`bl vision describe`（Qwen-VL，**图和视频都能看**）。
 *
 * 用法：
 *   node src/qa.mjs <stage> <文件...> [--brief] [--prompt "额外的关注点"]
 *   node src/qa.mjs keyframes keyframes_v2/*.png
 *   node src/qa.mjs assets assets_v2/*.png
 *   node src/qa.mjs clips clips/s01.mp4
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBailian } from './bailian-cli.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** 每个阶段，质检该盯什么。**这些不是全部**，是"最容易在这里出错的"。 */
export const STAGE_FOCUS = {
  assets: [
    '【肖像】正面吗？脸部占 60-70% 吗？是侧脸或遮挡吗？身上有没有穿戏服（肖像只该穿素色上衣）？',
    '【身份图】是不是 16:9 横构图、**一排四格**？有没有排成 2×2 或上下堆叠？四格等宽等高吗？',
    '【身份图】Panel1 是不是 Panel2 头部的放大？四格是同一个人同一套衣服吗（只允许视角变化）？',
    '【通用】画面里有没有文字、水印、色卡、边框？有没有崩坏（多指、畸形、糊、拼接痕）？',
  ],
  keyframes: [
    '【景别 ⭐ 最重要】这张说好的景别（见文件名旁标注）**是不是真的对**？',
    '  全景=能看到整条路和树林；中景=**切在腰部**；近景=**只取胸部以上**；特写=**只有脸，头部占满**。',
    '  **差一级就是错。** 中景切到胸口算错，近景拉到腰也算错。',
    '【人物】这张脸是给定妆照里那个人吗（不是"像"，是"是"）？',
    '【服装】和身份设定图一致吗（颜色、层数、腰带）？',
    '【构图】人物在画面里的位置对吗？**朝向对吗**（朝左还是朝右 —— 错了正反打就废了）？',
    '【文字 ⭐】画面里**有没有任何字**？有字会跟着进视频。',
    '【崩坏】手、脸、边缘有没有明显坏掉？',
  ],
  clips: [
    '【切点 ⭐】这个片段如果包含多个镜头，**该切的地方切了吗**？切过去的内容对吗？',
    '【尾段 ⭐】**最后 0.2-0.5 秒的画面会不会糊成噪点/雪花**？（低分辨率长镜的常见病）',
    '【一致性】同一个人的脸和衣服，在片段内部不同镜头之间对得上吗？',
    '【动作】动作自然吗？有没有僵住、抖动、鬼畜、身体扭曲？',
    '【文字】画面里有没有烧进去的字幕？',
  ],
  film: [
    '【接缝】几个片段接起来的地方顺不顺？有没有突兀的跳变？',
    '【整体】连着看一遍 —— **哪里让你想快进？哪里看不懂？**',
    '【一致性】全片里人物长相、服装、环境光有没有前后不一致？',
  ],
};

/** 每个阶段要附带的上下文（判据里提到的"说好的景别"从哪来）。 */
export const STAGE_CONTEXT = {
  keyframes: '下面每张图我会标注【它应该是】—— 请**逐张**核对，不要拿别的图推断这一张。',
  assets: '下面每张图我会标注它是【肖像】还是【身份图】—— 判据不同，请分开看。',
  clips: '这是一段视频，请**特别注意结尾那 0.5 秒**有没有糊掉。',
  film: '这是拼好的成片，请连着看，注意接缝和整体观感。',
};

// ---------------------------------------------------------------- 调视觉

/**
 * 让视觉模型看一张图/一段视频，返回它的描述。
 *
 * 提示词**按参数数组直传**（`src/bailian-cli.mjs`），不拼命令行、不过临时脚本 ——
 * 中文长提示词、换行、引号都原样送达。
 *
 * 早先这里走的是「写 .ps1 → PowerShell 读变量 → 用变量传参」，为了绕开
 * PS 5.1 吃引号。**后来实测发现本机 PowerShell 根本起不了外部进程**，
 * 那条链是「exit 0 但没产出」—— 于是整条 PS 路都被拔掉了。
 *
 * 视觉能力：`bl vision describe`（Qwen-VL，**图和视频都支持**，**没有** `--prompt-file`）。
 */
export function look(file, { focus = [], extra = '', model = 'qwen3-vl-plus' } = {}) {
  const isVideo = /\.(mp4|mov|avi|mkv|webm)$/i.test(file);
  const lines = [
    '你是一个严格的质量检查员。请**仔细看这张画面**，然后按下面的问题逐条回答。',
    '',
    '要求：',
    '· 每条都要说出**你实际看到的**，不要笼统地说"正常""没问题"。',
    '· 拿不准的就直说拿不准，**宁可多报，不要放过**。',
    '· 如果发现任何问题，指出**具体在画面哪个位置**、是什么样。',
    '',
    '逐条回答：',
    ...focus.map((f, i) => `${i + 1}. ${f}`),
  ];
  if (extra) lines.push('', `额外关注：${extra}`);
  lines.push('', '最后用一行给出结论，格式：`结论：通过` 或 `结论：有问题 —— <一句话>`。');

  // 参数数组直传 CLI（见 src/bailian-cli.mjs）——不再拼 PS 脚本、不再过临时文件
  const r = runBailian([
    'vision', 'describe', isVideo ? '--video' : '--image', path.resolve(file),
    '--prompt', lines.join('\n'), '--model', model, '--timeout', '180',
  ], { timeoutMs: 300000 });

  const out = String(r.stdout || '').trim();
  if (r.status !== 0 && !out) return { ok: false, text: String(r.stderr || r.error || '').slice(0, 400) };
  return { ok: true, text: out };
}

/** 从模型回复里抠出结论行。 */
export function verdictOf(text) {
  const m = String(text || '').match(/结论[：:]\s*(.+)/);
  if (!m) return { pass: null, why: '模型没给结论' };
  const s = m[1].trim();
  return { pass: /^通过/.test(s), why: s };
}

// ---------------------------------------------------------------- 主流程

function main() {
  const argv = process.argv.slice(2);
  const stage = argv[0];
  const files = argv.slice(1).filter((a) => !a.startsWith('--') && fs.existsSync(a));
  const wantBrief = argv.includes('--brief');
  const extra = (() => { const i = argv.indexOf('--prompt'); return i >= 0 ? argv[i + 1] : ''; })();

  if (wantBrief || !stage || !STAGE_FOCUS[stage]) {
    console.log(fs.readFileSync(path.join(ROOT, 'references', 'qa', 'brief.md'), 'utf8'));
    if (stage && !STAGE_FOCUS[stage]) console.error(`\n✗ 不认识的阶段「${stage}」，可用：${Object.keys(STAGE_FOCUS).join(' / ')}`);
    process.exit(stage && !STAGE_FOCUS[stage] ? 2 : 0);
  }
  if (!files.length) {
    console.error(`用法：node src/qa.mjs ${stage} <文件...> [--prompt "额外关注点"]`);
    process.exit(2);
  }

  const focus = STAGE_FOCUS[stage];
  console.log(`\n【质检：${stage}】共 ${files.length} 个`);
  console.log(STAGE_CONTEXT[stage] || '');
  console.log('─'.repeat(66));

  const results = [];
  for (const f of files) {
    // 文件名旁带上"它应该是什么"，视觉模型才知道拿什么比对
    const label = `${path.basename(f)}${extra ? `（${extra}）` : ''}`;
    process.stderr.write(`  看 ${path.basename(f)} … `);
    const r = look(f, { focus, extra: extra ? `${label}：${extra}` : '' });
    if (!r.ok) { console.log('✗ 看不了'); results.push({ f, pass: false, text: r.text }); continue; }
    const v = verdictOf(r.text);
    console.log(v.pass === true ? '✓' : v.pass === false ? '✗' : '?');
    results.push({ f, pass: v.pass, why: v.why, text: r.text });
  }

  console.log('─'.repeat(66));
  const bad = results.filter((x) => x.pass !== true);
  for (const x of results) {
    const mark = x.pass === true ? '✓' : x.pass === false ? '✗' : '?';
    console.log(`  ${mark} ${path.basename(x.f)}　${x.why || ''}`);
  }
  console.log('');
  if (bad.length) {
    console.log(`  结论：**${bad.length}/${results.length} 个有问题，不建议往下走。**`);
    console.log('  详细的逐条回答：');
    for (const x of bad) {
      console.log(`\n  ── ${path.basename(x.f)} ──`);
      console.log(String(x.text).split('\n').map((l) => '    ' + l).join('\n'));
    }
    process.exit(1);
  }
  console.log(`  结论：全部通过（${results.length} 个）。`);
  console.log('');
  console.log('  ⚠ **通过 ≠ 可以往下走。通过 = 可以问用户了。**');
  console.log(`  → 现在可以问：这批 ${stage} OK 吗？`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
