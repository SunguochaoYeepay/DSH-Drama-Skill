#!/usr/bin/env node
/**
 * 把 gpt 四实验的原始产物汇成一张可交付的表。
 *
 * 设计原则：**所有数字都从磁盘上的原始 metrics 重新算**，不信任中间脚本当年打印的那一行
 * （实验一是先跑的，当时 `table_between` 只看了第一个桌框，是错的）。
 *
 * 用法：node lab/spatial/exp/summarize.mjs [--out <md>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const TMP = path.join(ROOT, '.tmp');
const LAB = path.join(TMP, 'spatial-lab');
const PROBE = path.join(TMP, 'probe');
const PY = process.env.AIH_PYTHON || 'python';
const WEIGHTS = path.join(LAB, 'weights', 'yolo11n.pt');
const outArg = process.argv.indexOf('--out');
const OUT_MD = outArg > 0 ? process.argv[outArg + 1] : path.join(TMP, 'exp', 'summary.md');

fs.mkdirSync(PROBE, { recursive: true });
const lines = [];
const say = (s = '') => { lines.push(s); console.log(s); };
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const f2 = (n, d = 3) => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(d) : '—');

// ── 图片级度量（实验四用；已存在就复用） ─────────────────────────────────
function measureImage(absPath, tag) {
  const outJson = path.join(PROBE, `img-${tag}.json`);
  if (!fs.existsSync(outJson)) {
    const r = spawnSync(PY, [path.join(ROOT, 'lab', 'spatial', 'py', 'measure-count.py'),
      '--image', absPath, '--weights', WEIGHTS, '--conf', '0.25', '--device', 'cpu',
      '--sharpness', '--out-json', outJson],
      { encoding: 'utf8', cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) return { detector: 'unavailable', error: (r.stderr || '').trim().slice(0, 200), persons: [] };
  }
  return readJson(outJson);
}

// ── 实验一：静态构图 ────────────────────────────────────────────────────
say('# 白膜能力验证（gpt 四实验）');
say();
say(`生成时间：${new Date().toISOString()}`);
say();
say('## 实验一：静态构图（三人？不，两人隔桌面对面）');
say();
const exp1 = readJson(path.join(LAB, 'exp1-static', 'report.json'));
if (!exp1) {
  say('（缺 `.tmp/spatial-lab/exp1-static/report.json`）');
} else {
  say(`声明：男士 u 0.70（画面右）、女士 u 0.30（画面左）、桌子夹在中间。场景 ` +
      `\`${exp1.scene}\` / shot \`${exp1.shot}\`，白膜首帧 \`${exp1.whitebox_still}\`，` +
      `${exp1.aspect} ${exp1.style}，本地通道 qwen21（0 元）。`);
  say();
  say('| 臂 | 次 | 人数 | 多出主体 | 声明人 u 检出 | 位置误差 du_max | 左右顺序对 | 桌子在两人 u 之间 | 生成图 |');
  say('|---|---|---|---|---|---|---|---|---|');
  const byArm = new Map();
  for (const row of exp1.rows) {
    const m = readJson(path.join(ROOT, row.file.replace(/[^\\/]+$/, ''), 'metrics.json'));
    const persons = (m?.persons || []).map((p) => p.u).sort((a, b) => a - b);
    const tables = (m?.tables || []).map((t) => t.u);
    const matched = (row.du_pairs || []).map((p) => p.detected_u).sort((a, b) => a - b);
    const lo = matched[0], hi = matched[matched.length - 1];
    // 只要**任意**一个桌框落在两人之间，就算桌子在中间（原来只看第一个桌框，是错的）
    const between = typeof lo === 'number' && typeof hi === 'number'
      ? tables.some((u) => u > lo && u < hi) : false;
    const stat = byArm.get(row.arm) || { n: 0, du: [], extra: 0, order: 0, between: 0 };
    stat.n += 1; stat.du.push(row.du_max); stat.extra += row.extra_person;
    stat.order += row.order_ok ? 1 : 0; stat.between += between ? 1 : 0;
    byArm.set(row.arm, stat);
    say(`| ${row.arm} | ${row.trial} | ${row.n_person} | ${row.extra_person} | ` +
        `${persons.map((u) => f2(u)).join(', ')} | ${f2(row.du_max)} | ${row.order_ok ? '✓' : '✗'} | ` +
        `${between ? '✓' : '✗'} | \`${path.basename(row.file)}\` |`);
  }
  say();
  say('| 臂 | 次数 | 平均 du_max | 最大 du_max | 主体漏检 | 多出主体合计 | 顺序对 | 桌子在中间 |');
  say('|---|---|---|---|---|---|---|---|');
  for (const [arm, s] of byArm) {
    const mean = s.du.reduce((a, b) => a + b, 0) / s.du.length;
    say(`| ${arm} | ${s.n} | ${f2(mean)} | ${f2(Math.max(...s.du))} | ${s.du.filter((d) => d == null).length} | ` +
        `${s.extra} | ${s.order}/${s.n} | ${s.between}/${s.n} |`);
  }
}

// ── 实验二：运动落点 ────────────────────────────────────────────────────
say();
say('## 实验二：运动落点（A 从左走到目标位；期望 drift −0.29）');
say();
say('| 臂 | 次 | 出人率 | u_first → u_last | drift | 落点误差 \\|drift−期望\\| | 背景变化中位 | 相邻帧差中位 |');
say('|---|---|---|---|---|---|---|---|');
const exp2 = [];
for (const [runId, label] of [['exp2a-walk', 'i2v'], ['exp2b-walk-fl2v', 'fl2v']]) {
  const run = readJson(path.join(LAB, runId, 'run.json'));
  if (!run) { say(`| ${label} | — | — | — | — | — | — | — | （缺 ${runId}/run.json） |`); continue; }
  for (const t of run.trials_log || []) {
    const m = readJson(path.join(ROOT, t.dir, 'metrics.json'));
    const err = t.expected_drift != null && t.drift != null ? Math.abs(t.drift - t.expected_drift) : null;
    exp2.push({ arm: t.arm, err, drift: t.drift, bg: t.bg_change, jump: m?.jump_median });
    say(`| ${t.arm} | ${t.trial} | ${f2(t.presence_rate, 2)} | ${f2(t.u_first)} → ${f2(t.u_last)} | ` +
        `${f2(t.drift, 4)} | ${f2(err, 4)} | ${t.bg_change ?? '—'} | ${f2(m?.jump_median)} |`);
  }
}
if (exp2.length) {
  const arms = [...new Set(exp2.map((r) => r.arm))];
  say();
  for (const a of arms) {
    const rows = exp2.filter((r) => r.arm === a && r.err != null);
    if (!rows.length) continue;
    const errs = rows.map((r) => r.err);
    const mean = errs.reduce((x, y) => x + y, 0) / errs.length;
    say(`- **${a}**：${rows.length} 次，落点误差 平均 ${f2(mean, 4)} / 最大 ${f2(Math.max(...errs), 4)}；` +
        `漂移方向一致 ${rows.filter((r) => r.drift < 0).length}/${rows.length}`);
  }
}

// ── 实验三：镜头运动 ────────────────────────────────────────────────────
say();
say('## 实验三：镜头运动（人不动，推镜 / 环绕）');
say();
say('| shot | 臂 | 次 | 出人率 | u_first → u_last | 人高 h 首 → 末 | 背景变化中位/ p90 | 相邻帧差中位 / p90 / max |');
say('|---|---|---|---|---|---|---|---|');
const exp3 = readJson(path.join(LAB, 'exp3-camera', 'run.json'));
if (!exp3) {
  say('| — | — | — | — | — | — | — | （缺 exp3-camera/run.json） |');
} else {
  for (const t of exp3.trials_log || []) {
    const dir = path.join(ROOT, t.dir);
    const m = readJson(path.join(dir, 'metrics.json'));
    const traceJson = path.join(dir, 'trace.json');
    if (!fs.existsSync(traceJson) && fs.existsSync(path.join(dir, 'raw.mp4'))) {
      spawnSync(PY, [path.join(ROOT, 'lab', 'spatial', 'py', 'trace-person.py'),
        '--video', path.join(dir, 'raw.mp4'), '--out-json', traceJson, '--sample', '6',
        '--weights', WEIGHTS, '--device', 'cpu'],
        { encoding: 'utf8', cwd: ROOT, maxBuffer: 32 * 1024 * 1024 });
    }
    const tr = readJson(traceJson);
    const pres = (tr?.samples || []).filter((s) => s.present);
    const hFirst = pres.length ? pres[0].h : null;
    const hLast = pres.length ? pres[pres.length - 1].h : null;
    say(`| ${t.shot} | ${t.arm} | ${t.trial} | ${f2(t.presence_rate, 2)} | ${f2(t.u_first)} → ${f2(t.u_last)} | ` +
        `${f2(hFirst)} → ${f2(hLast)} | ${m?.bg_change ?? '—'} / ${m?.bg_change_p90 ?? '—'} | ` +
        `${f2(m?.jump_median)} / ${f2(m?.jump_p90)} / ${f2(m?.jump_max)} |`);
  }
}

// ── 实验四：餐厅案例 ────────────────────────────────────────────────────
say();
say('## 实验四：餐厅案例（已交付成片的机械核查）');
say();
say('| 图 | 声明主体 | 检出人 | 多出主体 | 这些人是谁（Laplacian 清晰度区分） |');
say('|---|---|---|---|---|');
const PROJ = path.join(ROOT, 'projects', 'glass_restaurant');
const exp4 = [
  ['g001 关键帧', path.join(PROJ, 'keyframes_render', 'g001.png'), 3],
  ['g002 关键帧', path.join(PROJ, 'keyframes_render', 'g002.png'), 2],
  ['g002 落幅', path.join(PROJ, 'keyframes_render', 'g002_last.png'), 2],
  ['g002 片段首帧', path.join(PROJ, 'units', 'fl2v_20260930-135643_first.png'), 2],
  ['g002 片段末帧', path.join(PROJ, 'units', 'fl2v_20260930-135643_last.png'), 2],
  ['白膜首帧(face2face)', path.join(ROOT, 'lab', 'spatial', 'exp', 'out', 'face2face', 'still_f0001.png'), 2],
];
for (const [label, p, declared] of exp4) {
  if (!fs.existsSync(p)) { say(`| ${label} | ${declared} | — | — | （缺文件） |`); continue; }
  const m = measureImage(p, path.basename(p).replace(/[^\w.-]/g, '_'));
  const persons = m.persons || [];
  const blur = persons.filter((x) => (x.lap ?? 999) < 60).length;
  const who = persons.map((x) => `u${f2(x.u, 2)}${x.lap != null ? `/lap${Math.round(x.lap)}` : ''}`).join(' ');
  say(`| ${label} | ${declared} | ${m.n_person ?? '—'} | ${m.n_person != null ? m.n_person - declared : '—'} | ${who} |`);
}
say();
say('说明：`lap` = 人物框内灰度 Laplacian 方差（清晰度）。lap < 60 基本是运动模糊的路人或玻璃反射，');
say('不是"多出来的主体"；`g001` 里 lap 298–634 的第二个"人"是**玻璃上的倒影**（同一批食客被数了第二遍）。');

// ── 实验二第 3 臂：白膜视频当 control_video ──────────────────────────────
say();
say('## 实验二 · 第 3 臂：白膜视频当 `control_video`（用 lab 现成同内容对照）');
say();
say('白膜真值（`lab/whitebox/out/whitebox/fight/coords.json`）：A root u 0.5→0.5（不动），' +
    'B root u 0.5993→0.1147 → **声明 drift −0.485**（`video_probe.py` 取"最大人框"，' +
    '双人镜头里身份可能切换，故此项为指示性）。');
say();
say('| 控制信号 | presence | u_first → u_last | drift | 对白膜声明误差 | 背景变化中位/p90 | 相邻帧差中位/p90/max |');
say('|---|---|---|---|---|---|---|');
for (const [tag, label] of [['fight-e1', '白膜原始帧（e1-json）'], ['s100', '官方骨架（s100）']]) {
  const m = readJson(path.join(PROBE, `${tag}.json`));
  if (!m) { say(`| ${label} | — | — | — | — | — | （缺 ${tag}.json） |`); continue; }
  say(`| ${label} | ${f2(m.presence_rate, 2)} | ${f2(m.u_first)} → ${f2(m.u_last)} | ${f2(m.drift, 4)} | ` +
      `${f2(Math.abs(m.drift + 0.4846), 4)} | ${m.bg_change} / ${m.bg_change_p90} | ` +
      `${f2(m.jump_median)} / ${f2(m.jump_p90)} / ${f2(m.jump_max)} |`);
}
say();
say('同内容另有一对"小目标"证据（jet/谷地，白膜当 control_video，彩色代理口径）：');
say('飞机横向误差 0.003 → 0.155（≈50×）、导弹 0.001 → 0.474（≈500×）、飞机屏幕位移 −0.524 → −0.011。');
say('口径见 `lab/spatial/FINDINGS.md`（E2）。');

fs.mkdirSync(path.dirname(OUT_MD), { recursive: true });
fs.writeFileSync(OUT_MD, lines.join('\n') + '\n', 'utf8');
console.log(`\n已写 ${path.relative(ROOT, OUT_MD)}`);
