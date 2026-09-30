/**
 * 实验一（静态构图）：三臂对照。只调 lab 自己的生成后端与度量，不改主线代码。
 *
 *   text-only  纯文字提示词
 *   wb-frame   文字 + 白膜首帧
 *   wb-id      文字 + 白膜首帧 + 两张人物身份图
 *
 * 每臂 3 次；每次量：人数、桌子数量、两个人各自的 u 位置误差、左右顺序、桌子是否夹在两人中间。
 *
 * 用法：
 *   node lab/spatial/exp/run-static-arms.mjs --trials 3 --run-id exp1-static
 *   node lab/spatial/exp/run-static-arms.mjs --dry --trials 1 --run-id exp1-dry    # 不占 GPU
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { generateComfy, makeDryBackend, runtimePaths, REPO_ROOT } from '../lib/gen.mjs';

const HERE = import.meta.dirname;

function arg(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const SCENE_FILE = path.resolve(String(arg('scene', path.join(HERE, 'scene-face2face.json'))));
const SHOT_ID = String(arg('shot', 'f2f_front'));
const TRIALS = Number(arg('trials', 3));
const DRY = process.argv.includes('--dry');
const RUN_ID = String(arg('run-id', `exp1-static-${new Date().toISOString().slice(0, 10)}`));
const OUT_ROOT = path.join(REPO_ROOT, '.tmp', 'spatial-lab', RUN_ID);
const WEIGHTS = path.join(REPO_ROOT, '.tmp', 'spatial-lab', 'weights', 'yolo11n.pt');
const MEASURE = path.join(REPO_ROOT, 'lab', 'spatial', 'py', 'measure-count.py');

const scene = JSON.parse(fs.readFileSync(SCENE_FILE, 'utf8'));
const shot = scene.shots.find((s) => s.id === SHOT_ID);
if (!shot) throw new Error(`场景里没有这个镜头：${SHOT_ID}`);
const WB_STILL = path.resolve(REPO_ROOT, scene.whitebox.still);
if (!fs.existsSync(WB_STILL)) throw new Error(`白膜静帧还不存在：${WB_STILL}`);
const ID_SHEETS = scene.identities.map((i) => path.resolve(REPO_ROOT, i.sheet));
for (const f of ID_SHEETS) if (!fs.existsSync(f)) throw new Error(`身份图不存在：${f}`);

const LAYOUT = [
  `场景：${scene.scene.environment}`,
  '中景；一张长桌横在画面中间。',
  '画面里只有两个人，两人隔着餐桌面对面站着：男士站在画面偏右（约 70% 处），身体朝向画面左；女士站在画面偏左（约 30% 处），身体朝向画面右；一张长桌横在两人中间。',
  '两人都是全身中景，站姿自然，写实电影感，室内暖色吊灯，窗外冷色街景。',
].join('。');

const ARMS = [
  { id: 'text-only', refs: () => [], extra: '' },
  {
    id: 'wb-frame',
    refs: () => [WB_STILL],
    extra: '图1是这一镜的空间预演（白膜）：两个人的左右位置、身体朝向、以及桌子在两人中间的关系，全部以图1为准。',
  },
  {
    id: 'wb-id',
    refs: () => [WB_STILL, ...ID_SHEETS],
    extra:
      '图1是这一镜的空间预演（白膜）：两个人的左右位置、身体朝向、以及桌子在两人中间的关系，全部以图1为准；图2是男士的人物身份参考，图3是女士的人物身份参考，两人的脸和服装以身份图为准。',
  },
  {
    // 第 4 臂：提示词与 text-only 一字不差，只是多挂了一张白膜首帧。
    // 目的：把"白膜替身被画进成片"归因到**挂图**本身，而不是我那句话说漏了嘴（提到"白膜/空间预演"）。
    id: 'wb-frame-quiet',
    refs: () => [WB_STILL],
    extra: '',
  },
];

async function runPy(script, args) {
  const { requireComfyPython } = await runtimePaths();
  const py = requireComfyPython();
  return await new Promise((resolve, reject) => {
    const child = spawn(py, [script, ...args], { cwd: REPO_ROOT, windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${path.basename(script)} 超时`));
    }, 10 * 60 * 1000);
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${path.basename(script)} 退出码 ${code}\n${err.slice(-600)}`))));
  });
}

/** 声明值 → 检出人的贪心最近邻匹配，返回每个声明的 du 与匹配到的 u */
function matchTargets(subjects, persons) {
  const free = persons.map((p, i) => ({ i, u: p.u }));
  const pairs = [];
  for (const s of subjects) {
    if (!free.length) {
      pairs.push({ id: s.id, declared_u: s.u, detected_u: null, du: null });
      continue;
    }
    let best = 0;
    for (let k = 1; k < free.length; k++) if (Math.abs(free[k].u - s.u) < Math.abs(free[best].u - s.u)) best = k;
    pairs.push({ id: s.id, declared_u: s.u, detected_u: free[best].u, du: round4(Math.abs(free[best].u - s.u)) });
    free.splice(best, 1);
  }
  return pairs;
}

const round4 = (x) => Math.round(x * 10000) / 10000;

/** ComfyUI 会被别人重启（本轮实测两次），瞬断不该让整批实验白跑 */
async function genWithRetry(opts, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await generateComfy(opts);
    } catch (e) {
      const msg = String(e.message || '');
      const transient = /URLError|10061|ECONNREFUSED|超时|退出码 1/.test(msg);
      if (!transient || i === attempts) throw e;
      console.log(`[exp1] 生成失败（第 ${i}/${attempts} 次）：${msg.slice(0, 140)} —— 20s 后重试`);
      await new Promise((r) => setTimeout(r, 20000));
    }
  }
  return null;
}

const RESUME = process.argv.includes('--resume');
// 只重算指标、不重新出图（改度量口径后复核历史结果用，比如给 measure-count 加框去重）
const METRICS_ONLY = process.argv.includes('--metrics-only');

// 单个产物的指标计算（原先是内联代码；抽出来是为了 --metrics-only 能在不重出图的情况下重算）
async function measureRow({ arm, t, produced, shot, seed, metricsPath }) {
  await runPy(MEASURE, [
    '--image', produced,
    '--weights', fs.existsSync(WEIGHTS) ? WEIGHTS : 'yolo11n.pt',
    '--out-json', metricsPath,
  ]);
  const m = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
  const pairs = matchTargets(shot.subjects, m.persons || []);
  const us = (m.persons || []).map((p) => p.u);
  const orderOk = us.length >= 2 ? us[us.length - 1] - us[0] > 0.1 : null; // 左女右男 → 最右的人应明显在最左的人右侧
  const tableUs = (m.tables || []).map((x) => x.u);
  return {
    arm: arm.id,
    trial: t,
    seed,
    file: path.relative(REPO_ROOT, produced),
    detector: m.detector,
    n_person: m.n_person,
    n_person_raw: m.n_person_raw ?? null,
    n_table: m.n_table,
    // 去重后的"多出来的人"（measure-count 会把同一个人身上的重叠框合并）
    extra_person: m.n_person == null ? null : Math.max(0, m.n_person - shot.subjects.length),
    missing_person: m.n_person == null ? null : Math.max(0, shot.subjects.length - m.n_person),
    persons_u: us,
    table_u: tableUs[0] ?? null,
    order_ok: orderOk,
    // 只要**任意**一个桌框落在两人之间就算桌子在中间（只看第一个框会误判：三张桌时中间那张未必排第一）
    table_between:
      us.length >= 2 ? tableUs.some((u) => u > Math.min(...us) && u < Math.max(...us)) : null,
    du_pairs: pairs,
    du_max: pairs.every((p) => p.du != null) ? round4(Math.max(...pairs.map((p) => p.du))) : null,
    error: m.error,
  };
}

async function main() {
  fs.mkdirSync(OUT_ROOT, { recursive: true });
  const reportPath = path.join(OUT_ROOT, 'report.json');
  const dry = DRY ? makeDryBackend({ sourceImage: WB_STILL }) : null;
  const record = {
    run_id: RUN_ID,
    kind: 'exp1-static-arms',
    scene: scene.id,
    shot: shot.id,
    scene_file: SCENE_FILE,
    whitebox_still: path.relative(REPO_ROOT, WB_STILL),
    identity_sheets: ID_SHEETS.map((f) => path.relative(REPO_ROOT, f)),
    aspect: scene.aspect,
    style: scene.style,
    arms: ARMS.map((a) => a.id),
    trials: TRIALS,
    dry: DRY,
    started_at: new Date().toISOString(),
    prompts: {},
    rows: [],
  };

  // 断点续跑：已经算过（有 du_max 或至少留下图）的 (臂, 次) 不重复烧 GPU
  if (RESUME && fs.existsSync(reportPath)) {
    const prev = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    record.rows = prev.rows || [];
    record.prompts = { ...(prev.prompts || {}), ...record.prompts };
    record.started_at = prev.started_at || record.started_at;
    console.log(`[exp1] resume：已有 ${record.rows.length} 条结果，跳过它们`);
  }
  const done = new Set(record.rows.map((r) => `${r.arm}#${r.trial}`));

  if (METRICS_ONLY) {
    console.log(`[exp1] --metrics-only：只重算 ${record.rows.length} 条已有结果的指标，不重新出图`);
    for (const row of record.rows) {
      const abs = path.resolve(REPO_ROOT, row.file);
      const metricsPath = path.join(path.dirname(abs), 'metrics.json');
      const fresh = await measureRow({
        arm: { id: row.arm },
        t: row.trial,
        produced: abs,
        shot,
        seed: row.seed,
        metricsPath,
      });
      Object.assign(row, fresh);
      console.log(
        `[exp1] ${row.arm} t${row.trial} 人=${row.n_person}${row.n_person_raw != null && row.n_person_raw !== row.n_person ? `(原始${row.n_person_raw})` : ''} 桌=${row.n_table} u=[${row.persons_u.join(', ')}] du_max=${row.du_max} 多出=${row.extra_person}`
      );
    }
    record.metrics_only_at = new Date().toISOString();
    fs.writeFileSync(reportPath, JSON.stringify(record, null, 2), 'utf8');
    return;
  }

  for (const arm of ARMS) {
    const refs = arm.refs();
    const prompt = arm.extra ? `${LAYOUT} ${arm.extra}` : LAYOUT;
    record.prompts[arm.id] = { prompt, refs: refs.map((r) => path.relative(REPO_ROOT, r)) };
    for (let t = 1; t <= TRIALS; t++) {
      if (RESUME && done.has(`${arm.id}#${t}`)) {
        console.log(`[exp1] ${arm.id} t${t} 已有结果，跳过`);
        continue;
      }
      const dir = path.join(OUT_ROOT, arm.id, `trial_${t}`);
      fs.mkdirSync(dir, { recursive: true });
      const seed = 60000 + ARMS.findIndex((a) => a.id === arm.id) * 100 + t;
      let produced;
      if (dry) {
        const r = await dry({ outDir: dir, tag: `${arm.id}_${t}` });
        produced = r.produced[0];
      } else {
        const r = await genWithRetry({
          mode: refs.length ? 'edit' : 't2i',
          prompt,
          refs,
          outDir: dir,
          ratio: scene.aspect,
          style: scene.style,
          fast: true,
          seed,
        });
        produced = r.produced[0];
      }
      if (!produced) throw new Error(`没有产出图片：${dir}`);

      const metricsPath = path.join(dir, 'metrics.json');
      const row = await measureRow({ arm, t, produced, shot, seed, metricsPath });
      record.rows.push(row);
      fs.writeFileSync(reportPath, JSON.stringify(record, null, 2), 'utf8');
      console.log(
        `[exp1] ${record.rows.length} ${arm.id} t${t} 人=${row.n_person}${row.n_person_raw != null && row.n_person_raw !== row.n_person ? `(原始${row.n_person_raw})` : ''} 桌=${row.n_table} u=[${row.persons_u.join(', ')}] du_max=${row.du_max} 顺序=${row.order_ok} 桌在中=${row.table_between}`
      );
    }
  }

  record.finished_at = new Date().toISOString();
  fs.writeFileSync(reportPath, JSON.stringify(record, null, 2), 'utf8');

  console.log('\n臂            trial  人数  桌子  左右顺序  桌子在中  du_女  du_男  du_max');
  for (const r of record.rows) {
    const du = Object.fromEntries((r.du_pairs || []).map((p) => [p.id, p.du]));
    console.log(
      `${r.arm.padEnd(12)}  t${r.trial}    ${String(r.n_person).padEnd(4)}  ${String(r.n_table).padEnd(4)}  ${String(r.order_ok).padEnd(8)}  ${String(r.table_between).padEnd(8)}  ${String(du[shot.subjects[1].id]).padEnd(6)} ${String(du[shot.subjects[0].id]).padEnd(6)} ${r.du_max}`
    );
  }
  console.log(`\n[exp1] 完成 → ${path.relative(REPO_ROOT, OUT_ROOT)}`);
}

main().catch((e) => {
  console.error('[exp1] 失败:', e.message);
  process.exit(1);
});
