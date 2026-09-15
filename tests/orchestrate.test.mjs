#!/usr/bin/env node
/**
 * orchestrate.test.mjs — 阶段④「编排」的验收（**不联网、不烧卡**）。
 *
 * 编排要断言的是**时间线本身**：
 *   - 帧数必须落在 H3 的 17k+5 网格上（否则引擎直接拒）
 *   - 成片总时长必须等于各镜时长之和 —— 这就是"时长由音频反推"的可验证形式
 *   - 字幕时间戳必须首尾相接、不重叠、不跳空
 *   - SRT 里不许出现空字幕
 *   - 首尾帧方向必须是"下一镜首帧当本镜尾帧"，下一镜没首帧时要**诚实退回**而不是硬来
 *
 *   node tests/orchestrate.test.mjs <board.json>
 */

import fs from 'node:fs';
import {
  snapFrames, framesFor, speechSegments, durationForSpeech,
  flfPlan, srtTime, buildTimeline, toSrt, resolveVoice, emotionToProsody, estimateSpeechSeconds,
  planTransitions, applyTransitions,
} from '../src/orchestrate.mjs';

let passed = 0;
const failures = [];
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`FAIL   ${label}${detail ? '  → ' + detail : ''}`); }
}

const file = process.argv[2] || 'E:/AI-Tool/DeepSeek/story2video/examples/dashixiong.literal.json';
const board = JSON.parse(fs.readFileSync(file, 'utf8'));

console.log('\n帧网格（H3 的 17k+5）');
check('5 是合法帧数', snapFrames(5) === 5, String(snapFrames(5)));
check('17k+5 原样保留', [5, 22, 39, 56, 124].every((f) => snapFrames(f) === f), [5, 22, 39, 56, 124].map(snapFrames).join(','));
check('13 落到 5 或 22', [5, 22].includes(snapFrames(13)), String(snapFrames(13)));
check('24 落到 22', snapFrames(24) === 22, String(snapFrames(24)));
check('结果永远满足 (f-5) % 17 === 0', [1, 7, 13, 24, 50, 100, 240, 360].every((f) => (snapFrames(f) - 5) % 17 === 0));
check('秒 → 帧（5 秒 ≈ 124 帧）', framesFor(5) === snapFrames(120), `${framesFor(5)} vs ${snapFrames(120)}`);

console.log('\n配音清单');
const segs = speechSegments(board);
check('台词数与板子一致', segs.length === board.shots.flatMap((s) => s.dialogue || []).length, String(segs.length));
check('每段都带原文', segs.every((s) => s.text && s.text.length > 0));
check('每段都点名了角色', segs.every((s) => s.name));
check('OS 被标出来', segs.filter((s) => s.kind === 'voiceover').length === 2, String(segs.filter((s) => s.kind === 'voiceover').length));
check('每段挂在具体的镜头上', segs.every((s) => /^s\d+$/.test(s.shot_id)));

console.log('\n时长由音频反推');
check('音频 3s → 3.6s（+0.6 呼吸）', Math.abs(durationForSpeech(3) - 3.6) < 1e-9, String(durationForSpeech(3)));
check('极短的音频也有下限', durationForSpeech(0.1) >= 1.5, String(durationForSpeech(0.1)));
check('极长的音频被单镜上限截住', durationForSpeech(40) === 15, String(durationForSpeech(40)));

console.log('\n首尾帧方向：**下一镜首帧 = 本镜尾帧**');
// 造一个两镜板子来验方向
const probe = structuredClone(board);
probe.shots = [
  { id: 's01', transition: { type: 'last_frame_first' }, first_frame: 'a.png', duration_s: 3, dialogue: [] },
  { id: 's02', transition: { type: 'cut' }, first_frame: 'b.png', duration_s: 3, dialogue: [] },
  { id: 's03', transition: { type: 'last_frame_first' }, first_frame: 'c.png', duration_s: 3, dialogue: [] },
];
const plan = flfPlan(probe);
check('s01 用 s02 的首帧当尾帧（不是拿上一镜的）', plan[0].last === 'b.png', String(plan[0].last));
check('s01 走 fl2v', plan[0].mode === 'fl2v', plan[0].mode);
check('s02 是 cut，走 i2v', plan[1].mode === 'i2v', plan[1].mode);
check('s03 是最后一镜且要衔接 → 没有下一镜首帧，退回 i2v', plan[2].mode === 'i2v', `${plan[2].mode} / ${plan[2].why}`);
check('退回时**说清楚为什么**', /还没有首帧/.test(plan[2].why), plan[2].why);
check('每一镜都有 why', plan.every((p) => p.why && p.why.length > 4));

console.log('\n时间轴 + 字幕');
const durations = {};
for (const s of board.shots) durations[s.id] = 2.5;
const tl = buildTimeline(board, durations);
const sum = board.shots.reduce((a, s) => a + (framesFor(durations[s.id]) / 24), 0);
check('总时长 = 各镜时长之和（±1 帧）', Math.abs(tl.total_seconds - sum) <= 1 / 24 + 1e-9, `${tl.total_seconds.toFixed(3)} vs ${sum.toFixed(3)}`);
check('每条都落在帧网格上', tl.entries.every((e) => (e.frames - 5) % 17 === 0), tl.entries.map((e) => e.frames).join(','));
check('时间戳首尾相接（不重叠不跳空）', tl.entries.every((e, i) => i === 0 || Math.abs(e.start - tl.entries[i - 1].end) < 1e-9));
check('第一条从 0 开始', tl.entries[0].start === 0);
check('最后一条的结束 = 总时长', Math.abs(tl.entries[tl.entries.length - 1].end - tl.total_seconds) < 1e-9);

console.log('\nSRT');
const srtLines = tl.srt.trim().split('\n\n');
check('SRT 条目数 = 有台词的镜数', srtLines.length === board.shots.filter((s) => (s.dialogue || []).length).length, `${srtLines.length}`);
check('没有空字幕', !/-->[^\n]*\n\s*\n/.test(tl.srt) && !/：\s*$/.test(tl.srt));
check('时间戳格式对', /^\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}$/.test(srtLines[0].split('\n')[1]), srtLines[0].split('\n')[1]);
check('序号从 1 开始且连续', srtLines.every((b, i) => b.split('\n')[0] === String(i + 1)));
check('OS 标了画外音', /画外音/.test(tl.srt));
check('时间戳换算正确', srtTime(3661.5) === '01:01:01,500', srtTime(3661.5));
check('toSrt 会滤掉空条目', toSrt([{ kind: 'none', text: '', start: 0, end: 1 }]) === '');

console.log('\n音色分配（必需属性，代码兜底）');
check('board 上写死 voice ID 时优先用它', resolveVoice(board, { voice: 'longtian_v3' }).voice === 'longtian_v3');
check('女性线索 → 女声', resolveVoice(board, { name: '小师妹', face_prompt: '' }).voice === 'longhua_v3');
check('男性线索 → 男声', resolveVoice(board, { name: '大师兄', face_prompt: '' }).voice === 'longtian_v3');
check('没有线索时也有兜底', Boolean(resolveVoice(board, { name: '甲乙', face_prompt: '' }).voice));
check('说得出为什么选这个', resolveVoice(board, { name: '小师妹' }).why.length > 4);

console.log('\n情绪 → 语速/音高（服务端不支持 --instruction）');
const p1 = emotionToProsody('语气慌张，手足无措', 'spoken');
const p2 = emotionToProsody('语气闷闷，小声嘟囔', 'spoken');
const p3 = emotionToProsody('', 'voiceover');
check('慌张 → 加快', p1.rate > 1, String(p1.rate));
check('闷闷 → 放慢', p2.rate < 1, String(p2.rate));
check('内心独白 → 放慢且压低', p3.rate < 1 && p3.pitch < 1, `${p3.rate}/${p3.pitch}`);
check('全部夹在 0.5–2.0 之间', [p1, p2, p3].every((p) => p.rate >= 0.5 && p.rate <= 2 && p.pitch >= 0.5 && p.pitch <= 2));
check('说得清是因为哪条规则', p1.why.length > 2 && p3.why.includes('内心独白'));
check('没有任何情绪线索时是中性的', emotionToProsody('', 'spoken').rate === 1);

console.log('\n本地估时长（不再花钱调 TTS）');
check('空文本 → 0', estimateSpeechSeconds('') === 0);
check('极短台词有下限 1.2s', estimateSpeechSeconds('嗯。') >= 1.2, String(estimateSpeechSeconds('嗯。')));
check('极长台词被单镜上限截住', estimateSpeechSeconds('字'.repeat(400)) === 15, String(estimateSpeechSeconds('字'.repeat(400))));
check('长台词估得比短台词长', estimateSpeechSeconds('这是一句比较长的台词，说了不少内容。') > estimateSpeechSeconds('好。'));
// **停顿要单独算** —— 同样长度，标点多的那句要更久
const punctA = estimateSpeechSeconds('昏死？那我的衣服是你给我穿的吗？');
const punctB = estimateSpeechSeconds('昏死那我的衣服是你给我穿的吗啊');
check('标点多的估得更久（停顿是特征）', punctA > punctB, `${punctA.toFixed(2)} vs ${punctB.toFixed(2)}`);
// 对 12 条真实 TTS 实测数据的误差 —— 这个模型存在的意义就是替代那次付费测量
const MEASURED = [3.50, 4.68, 1.46, 12.14, 4.10, 10.63, 3.72, 4.66, 5.09, 1.58, 9.19, 7.78];
const TEXTS = [
  '大师兄，昨天晚上，谢谢你救了我。',
  '举手之劳，不用谢。把我救你耗用的材料补给我就行。',
  '……好嘛。',
  '大师兄，昨晚的事，你千万不要跟别人说。我昨天沐浴时被邪祟上身，后面的事我一点都不记得了。',
  '没事，我进来的时候，你已经昏死过去了。',
  '昏死？那我的衣服……是你给我穿的？那你、那你有没有对我做什么？',
  '不然呢？难道让邪祟给你穿？',
  '那你看过也碰过了，你要对我负责！',
  '嗯，行。等会儿除掉邪祟卖的钱，全都给你。',
  '……你果然是个木头！',
  '我以为的负责是相守相伴，他居然只想着赔钱？这个呆子到底懂不懂儿女情长！',
  '救人耗材需核算清楚，邪祟内丹变卖的银两刚好可以补偿师妹受惊之苦，也算公允。',
];
let sumErr = 0, maxErr = 0, under = 0;
for (let i = 0; i < TEXTS.length; i++) {
  const est = estimateSpeechSeconds(TEXTS[i]);
  const err = Math.abs(est - MEASURED[i]);
  sumErr += err; maxErr = Math.max(maxErr, err);
  if (est < MEASURED[i] - 0.6) under++;   // 估短超过呼吸余量 = 会截断台词
}
// **追求准，不追求偏长**：H3 会把人声塞进我们给的时长，所以估短只是"H3 说快一点"，
// 估长才是真浪费（整片一堆没人说话的空白）。我一开始加了偏置，片子从 87s 涨到 103s。
check('平均误差 < 1.2s', sumErr / TEXTS.length < 1.2, `${(sumErr / TEXTS.length).toFixed(2)}s`);
check('最大误差 < 2.5s', maxErr < 2.5, `${maxErr.toFixed(2)}s`);
check('估长和估短基本对称（没有系统性偏置）', (() => {
  const bias = TEXTS.reduce((a, t, i) => a + (estimateSpeechSeconds(t) - MEASURED[i]), 0) / TEXTS.length;
  console.log(`       偏置 ${bias.toFixed(2)}s（正=偏长）`);
  return Math.abs(bias) < 0.5;
})());
console.log(`       平均误差 ${(sumErr / TEXTS.length).toFixed(2)}s　最大 ${maxErr.toFixed(2)}s`);

console.log('\n转场决策（不能整片都是硬切）');
const trBoard = {
  shots: [
    { id: 's01', scene: 'a', shot_size: '全景', cast: ['x'], transition: { type: 'cut' } },
    { id: 's02', scene: 'a', shot_size: '全景', cast: ['x'], transition: { type: 'cut' } },   // 该接
    { id: 's03', scene: 'a', shot_size: '全景', cast: ['x'], transition: { type: 'cut' } },   // 该接
    { id: 's04', scene: 'a', shot_size: '全景', cast: ['x'], transition: { type: 'cut' } },   // 超出上限 → 切
    { id: 's05', scene: 'a', shot_size: '近景', cast: ['x'], transition: { type: 'cut' } },   // 换景别 → 切
    { id: 's06', scene: 'a', shot_size: '近景', cast: ['x'], transition: { type: 'cut' } },   // 该接
    { id: 's07', scene: 'b', shot_size: '近景', cast: ['x'], transition: { type: 'cut' } },   // 换场景 → 切
    { id: 's08', scene: 'b', shot_size: '近景', cast: ['y'], transition: { type: 'cut' } },   // 人物无交集 → 切
  ],
};
const tr = planTransitions(trBoard, { maxRun: 2 });
const t = (i) => tr[i].type;
check('开场是 cut', t(0) === 'cut');
check('同场景同景别同人物 → 衔接', t(1) === 'last_frame_first', t(1));
check('第二个也接得上', t(2) === 'last_frame_first', t(2));
check('**连续衔接不超上限**，第三个给剪辑点', t(3) === 'cut', `${t(3)} / ${tr[3].why}`);
check('换景别 → 必须 cut', t(4) === 'cut' && /景别/.test(tr[4].why), tr[4].why);
check('换景别后重新计数，能再接', t(5) === 'last_frame_first', t(5));
check('换场景 → 必须 cut', t(6) === 'cut' && /场景/.test(tr[6].why), tr[6].why);
check('人物没交集 → cut', t(7) === 'cut' && /交集/.test(tr[7].why), tr[7].why);
check('每一条都说得出为什么', tr.every((x) => x.why && x.why.length > 3));
check('**不是整片硬切**（至少有几个衔接）', tr.filter((x) => x.type === 'last_frame_first').length >= 3, String(tr.filter((x) => x.type === 'last_frame_first').length));

const probe2 = structuredClone(trBoard);
const applied = applyTransitions(probe2, { maxRun: 2 });
check('applyTransitions 写回了板子', probe2.shots[1].transition.type === 'last_frame_first');
check('并报告改了几处', applied.changed > 0, String(applied.changed));
check('每条都带上了理由', probe2.shots.every((s) => s.transition.note && s.transition.note.length > 3));

console.log('\n' + '─'.repeat(56));
if (failures.length) {
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项：`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log(`全部通过（${passed} 项）—— 时间线可断言：帧落网格、总长等于各镜之和、字幕首尾相接`);
}
