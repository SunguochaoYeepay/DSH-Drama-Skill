/**
 * 汇总一次（或最近一次）试验 → report.md，并按预设的 kill criteria 给出判定。
 * 用法：node lab/spatial/report.mjs [--run <runId>]
 */

import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './lib/gen.mjs';

const ROOT = path.join(REPO_ROOT, '.tmp', 'spatial-lab');

function arg(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? dflt : process.argv[i + 1];
}

function newestRun() {
  if (!fs.existsSync(ROOT)) throw new Error(`还没有任何试验：${ROOT}`);
  const dirs = fs
    .readdirSync(ROOT)
    .map((d) => ({ d, m: fs.statSync(path.join(ROOT, d)).mtimeMs }))
    .filter((x) => fs.existsSync(path.join(ROOT, x.d, 'run.json')))
    .sort((a, b) => b.m - a.m);
  if (!dirs.length) throw new Error('没有找到含 run.json 的试验目录');
  return dirs[0].d;
}

const median = (xs) => {
  const a = [...xs].sort((p, q) => p - q);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
};
const round = (x, n = 3) => (x == null ? '—' : Number(x).toFixed(n));

function main() {
  const runId = arg('run') || newestRun();
  const dir = path.join(ROOT, runId);
  const run = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'));
  const log = run.trials_log || [];

  const key = (t) => `${t.shot}|${t.arm}`;
  const groups = new Map();
  for (const t of log) {
    const k = key(t);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }

  // 位置命中（单主体场景的硬指标）：|实际 u − 目标 u| ≤ 0.10 记为命中
  let scene = null;
  try {
    if (run.scene_path && fs.existsSync(run.scene_path)) scene = JSON.parse(fs.readFileSync(run.scene_path, 'utf8'));
  } catch {
    scene = null;
  }
  const posOf = new Map((scene?.shots || []).map((s) => [s.id, s.subjects[0].u]));
  const allPos = [...posOf.entries()];
  // 命中：目标位置有应用声明、且检出的主体落在 ±0.10 内。
  // **"完全没检出主体"记为未命中**（不是"不可判定"）—— 漏人是最严重的空间失败，不能从分母里消失。
  const hit = (t) => {
    const tu = posOf.get(t.shot);
    if (tu == null) return null;
    if (t.subject_u == null) return false;
    return Math.abs(t.subject_u - tu) <= 0.1;
  };
  const present = (t) => t.subject_u != null;
  const nearest = (t) => {
    if (t.subject_u == null || !allPos.length) return null;
    let best = null;
    for (const [id, u] of allPos) {
      const d = Math.abs(t.subject_u - u);
      if (!best || d < best.d) best = { id, d };
    }
    return best.id;
  };

  const shots = [...new Set(log.map((t) => t.shot))];
  const arms = [...new Set(log.map((t) => t.arm))];
  const rows = [];
  for (const sh of shots) {
    for (const arm of arms) {
      const g = groups.get(`${sh}|${arm}`) || [];
      const dus = g.map((t) => t.mean_abs_du).filter((x) => x != null);
      const det = g.map((t) => t.n_detected).filter((x) => x != null);
      const hits = g.map(hit).filter((x) => x !== null);
      const presentN = g.filter(present).length;
      const missTo = {};
      for (const t of g) {
        if (hit(t) === false) {
          const n = t.subject_u == null ? '画面里没人' : nearest(t);
          if (n) missTo[n] = (missTo[n] || 0) + 1;
        }
      }
      rows.push({
        shot: sh,
        arm,
        n: g.length,
        n_expected: g[0]?.n_expected ?? null,
        present_rate: g.length ? presentN / g.length : null,
        hit_rate: hits.length ? hits.filter(Boolean).length / hits.length : null,
        miss_to: Object.entries(missTo)
          .map(([k, v]) => `${k}×${v}`)
          .join(' '),
        mean_abs_du: median(dus),
        best_abs_du: dus.length ? Math.min(...dus) : null,
        order_ok_rate: g.filter((t) => t.order_ok === true).length / (g.length || 1),
        matched_subjects: median(det),
        detectors: [...new Set(g.map((t) => t.detector))].join(','),
      });
    }
  }

  const improvements = [];
  for (const sh of shots) {
    const base = rows.find((r) => r.shot === sh && r.arm === 'prompt-only');
    if (!base) continue;
    for (const arm of arms.filter((a) => a !== 'prompt-only')) {
      const other = rows.find((r) => r.shot === sh && r.arm === arm);
      if (!other) continue;
      const duDrop =
        base.mean_abs_du != null && other.mean_abs_du != null && base.mean_abs_du > 0
          ? (base.mean_abs_du - other.mean_abs_du) / base.mean_abs_du
          : null;
      improvements.push({ shot: sh, arm, duDrop, hitBase: base.hit_rate, hitOther: other.hit_rate });
    }
  }

  // 总体命中率（每个臂跨所有镜；"没人"计入未命中）
  const overall = arms.map((arm) => {
    const g = log.filter((t) => t.arm === arm);
    const hits = g.map(hit).filter((x) => x !== null);
    const countOk = g.filter((t) => t.n_expected != null && t.n_detected === t.n_expected).length;
    return {
      arm,
      n: hits.length,
      hit: hits.filter(Boolean).length,
      rate: hits.length ? hits.filter(Boolean).length / hits.length : null,
      present: g.filter(present).length,
      presentRate: g.length ? g.filter(present).length / g.length : null,
      countRate: g.length ? countOk / g.length : null,
    };
  });

  const L = [];
  L.push(`# 空间试验箱报告 — ${runId}`);
  L.push('');
  L.push(`- 场景：\`${run.scene}\`　臂：${run.arms.join(' / ')}　镜：${run.shots.join(', ')}　每镜次数：${run.trials}`);
  L.push(`- 后端：${run.dry ? `**dry（假生成，源图 ${path.basename(run.dry_source || '')}）—— 只能验证链路，不能作结论**` : '本地 ComfyUI（真实生成）'}`);
  L.push(`- 开始：${run.started_at}　结束：${run.finished_at || '（未完）'}`);
  L.push('');
  L.push('## 结果（`mean_abs_du` 为该臂各次试验的**中位数**，越小越好）');
  L.push('');
  L.push('| 镜 | 臂 | 次数 | 人数(声明/检出中位) | 出人率 | 位置命中率(±0.10) | 未命中跑去了哪 | mean \\|Δu\\| |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    L.push(
      `| ${r.shot} | ${r.arm} | ${r.n} | ${r.n_expected ?? '—'} / ${r.matched_subjects ?? '—'} | ${r.present_rate == null ? '—' : `${(r.present_rate * 100).toFixed(0)}%`} | ${r.hit_rate == null ? '—' : `${(r.hit_rate * 100).toFixed(0)}%`} | ${r.miss_to || '—'} | ${round(r.mean_abs_du)} |`
    );
  }
  L.push('');

  if (overall.length) {
    L.push('## 总体结果（跨所有镜）');
    L.push('');
    L.push('> **"完全没检出主体"计入未命中** —— 漏人是最严重的空间失败，不能从分母里消失。');
    L.push('');
    L.push('| 臂 | 次数 | 出人率(检出) | 人数与声明一致 | 位置命中率(±0.10) | 命中/总计 |');
    L.push('|---|---|---|---|---|---|');
    for (const o of overall) {
      L.push(
        `| ${o.arm} | ${o.n} | ${o.presentRate == null ? '—' : `${(o.presentRate * 100).toFixed(0)}%`} | ${o.countRate == null ? '—' : `${(o.countRate * 100).toFixed(0)}%`} | ${o.rate == null ? '—' : `${(o.rate * 100).toFixed(0)}%`} | ${o.hit}/${o.n} |`
      );
    }
    L.push('');
  }

  if (improvements.length) {
    L.push('## 相对基线（`prompt-only`）的改善');
    L.push('');
    L.push('| 镜 | 对照臂 | 命中率 基线→对照 | mean \\|Δu\\| 下降 | 判据 |');
    L.push('|---|---|---|---|---|');
    for (const it of improvements) {
      const ok = it.duDrop != null && it.duDrop >= 0.3;
      L.push(
        `| ${it.shot} | ${it.arm} | ${it.hitBase == null ? '—' : `${(it.hitBase * 100).toFixed(0)}%`} → ${it.hitOther == null ? '—' : `${(it.hitOther * 100).toFixed(0)}%`} | ${it.duDrop == null ? '—' : `${(it.duDrop * 100).toFixed(1)}%`} | ${ok ? '✅' : '❌'} |`
      );
    }
    L.push('');
    L.push('> 判据：`|Δu|` 下降 ≥30% 才算控制通道有效（写死在 `report.mjs`，不可事后改口）。');
    L.push('');
  } else {
    L.push('> 只有单臂数据，无法比较。补跑另一臂即可自动出对照。');
    L.push('');
  }

  L.push('## 预设的判定（写死在这里，避免事后找理由）');
  L.push('');
  L.push('| 观察 | 判断 |');
  L.push('|---|---|');
  L.push('| `prompt-only` 的 mean \\|Δu\\| 已经 ≤0.05 且抽卡 ≤2 次 | **方案缩水**：只做「字段 + lint」，不建控制通道 |');
  L.push('| 控制臂的 mean \\|Δu\\| 下降 <30% | **控制通道砍掉**，第 3 步（全景/体素）整体不做 |');
  L.push('| 检测器 unavailable / 匹配主体数不足 | 本报告不作结论，改由人眼看 `annotated.png` |');
  L.push('| `order_ok` 两臂都接近 0 | 说明维度选错了（前后序不是模型的能力边界），换「同物件跨镜唯一性」再测 |');
  L.push('');
  L.push('> Δv 故意不进判定：框中心取决于入画了多少身体，噪声大。');
  L.push('> 抽卡次数需人工记录（本试验箱不模拟"抽到可签"的循环）。');

  const out = path.join(dir, 'report.md');
  fs.writeFileSync(out, L.join('\n') + '\n', 'utf8');
  console.log(L.join('\n'));
  console.log(`\n[lab] 报告 → ${path.relative(REPO_ROOT, out)}`);
}

try {
  main();
} catch (e) {
  console.error('[lab] 失败:', e.message);
  process.exit(1);
}
