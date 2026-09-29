import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_RULES, analyzeFraming, formatFraming, mustMove } from '../src/whitebox-framing.mjs';

/**
 * 取景预检的行为测试：全部用合成坐标表，不依赖 Blender、不依赖 lab 产物。
 * 守护的是「今天这条规则还在不在」——2026-09-29 subway 那次失败（主角贴左缘、
 * 中途出画、屏幕几乎不位移）必须在这几条里被稳稳抓到。
 */

const N = 10;
/** 造 N 帧坐标表；fn(i) 返回该帧每个资产的横向屏幕坐标，null = 不在画面内。 */
function coords(fn) {
  const frames = {};
  for (let i = 1; i <= N; i += 1) {
    const row = {};
    for (const [id, u] of Object.entries(fn(i))) {
      row[id] = { root: [u, 0.5], root_visible: u !== null, head: [u, 0.3], head_visible: u !== null };
    }
    frames[String(i)] = row;
  }
  return { fps: 24, frames };
}

const char = (id, clips) => ({ asset_id: id, kind: 'character', asset_type: 'male', clips });
const prop = (id, waypoints) => ({ asset_id: id, kind: 'prop', asset_type: 'train', path: { waypoints } });

const stationPlan = [
  char('H', [{ frame_range: [1, N], animation: 'Sprint_Loop', start_pos: [1, 0], end_pos: [-1, 1] }]),
  prop('TRAIN', [[8, 1.2, 0], [-8, 1.2, 0]]),
];

// ---------- 正面：健康的规划要通过 ----------
test('健康的规划：角色在框中央、该动的位移够 → 通过', () => {
  const plan = [char('H', [{ start_pos: [1, 0], end_pos: [-1, 1] }]), prop('TRAIN', [[8, 0, 0], [-8, 0, 0]])];
  const c = coords((i) => ({
    // 屏幕 x：0.55 → 0.25 横穿画面
    H: 0.55 - 0.03 * (i - 1),
    TRAIN: i <= 8 ? 0.90 - 0.09 * (i - 1) : null,
  }));
  const r = analyzeFraming({ assets: plan }, c);
  assert.equal(r.ok, true, JSON.stringify(r.findings));
  assert.deepEqual(r.findings, []);
});

test('道具进画出画不报出框（角色才管这条）', () => {
  const c = coords((i) => ({ H: 0.5, TRAIN: i <= 4 ? 0.9 : null }));
  const r = analyzeFraming({ assets: stationPlan }, c);
  assert.equal(r.assets.find((a) => a.id === 'TRAIN').inFrame, 0.4);
  assert.ok(!r.findings.some((f) => f.rule === 'F1'), JSON.stringify(r.findings));
});

// ---------- 反面：subway 那次失败的三条症状 ----------
test('F1：角色长时间不在画面内 → 拦下（subway 主角同款）', () => {
  const c = coords((i) => ({ H: i <= 8 ? 0.13 - 0.015 * (i - 1) : null, TRAIN: null }));
  const r = analyzeFraming({ assets: stationPlan }, c);
  const f = r.findings.find((x) => x.rule === 'F1');
  assert.ok(f, JSON.stringify(r.findings));
  assert.equal(f.asset, 'H');
  assert.ok(f.message.includes('20%'), f.message);
  assert.equal(r.ok, false);
});

test('F2：主体被挤在画面边缘 → 拦下', () => {
  const plan = [char('P', [{ start_pos: [0, 0] }])];
  const c = coords(() => ({ P: 0.03 }));
  const r = analyzeFraming({ assets: plan }, c);
  const f = r.findings.find((x) => x.rule === 'F2');
  assert.ok(f, JSON.stringify(r.findings));
  assert.equal(f.asset, 'P');
  assert.equal(r.assets[0].edge, 1);
});

test('F3：该动的资产屏幕几乎不位移 → 拦下（朝镜头纵深跑就长这样）', () => {
  const c = coords((i) => ({ H: 0.13 - 0.001 * (i - 1), TRAIN: null }));
  const r = analyzeFraming({ assets: stationPlan }, c);
  const f = r.findings.find((x) => x.rule === 'F3');
  assert.ok(f, JSON.stringify(r.findings));
  assert.equal(f.asset, 'H');
  assert.ok(f.message.includes('0.01'), f.message);
});

test('F3 同样管道具：有轨迹却不动也不能放行', () => {
  const c = coords(() => ({ TRAIN: 0.5 }));
  const r = analyzeFraming({ assets: [prop('TRAIN', [[8, 0, 0], [-8, 0, 0]])] }, c);
  const f = r.findings.find((x) => x.rule === 'F3');
  assert.ok(f, JSON.stringify(r.findings));
  assert.equal(f.asset, 'TRAIN');
});

test('静止角色不做位移要求（站桩的人本来就不该动）', () => {
  const c = coords(() => ({ P: 0.5 }));
  const r = analyzeFraming({ assets: [char('P', [{ start_pos: [0, 0] }])] }, c);
  assert.equal(r.ok, true, JSON.stringify(r.findings));
  assert.equal(r.assets[0].mustMove, false);
});

test('导演 must_show：被镜头挡住或出画的关键道具也要拦下', () => {
  const c = coords((i) => ({ TABLE: i <= 4 ? 0.5 : null }));
  const r = analyzeFraming({
    assets: [{ asset_id: 'TABLE', kind: 'prop', asset_type: 'table', path: { waypoints: [[0, 0, 0]] } }],
    camera: { must_show: ['TABLE'] },
  }, c);
  assert.equal(r.ok, false);
  assert.equal(r.findings[0].rule, 'D1');
  assert.equal(r.findings[0].asset, 'TABLE');
});

// ---------- mustMove 的判据 ----------
test('mustMove：角色看有没有 end_pos，道具看有没有多段 waypoints', () => {
  assert.equal(mustMove(char('A', [{ start_pos: [0, 0] }])), false);
  assert.equal(mustMove(char('A', [{ start_pos: [0, 0], end_pos: [1, 1] }])), true);
  assert.equal(mustMove(prop('T', [[0, 0, 0]])), false);
  assert.equal(mustMove(prop('T', [[0, 0, 0], [0, 0, 0]])), false);
  assert.equal(mustMove(prop('T', [[0, 0, 0], [1, 0, 0]])), true);
});

// ---------- 边界与兜底 ----------
test('坐标表残缺时不崩、按跳过处理', () => {
  assert.equal(analyzeFraming({ assets: stationPlan }, {}).ok, true);
  assert.ok(analyzeFraming({ assets: stationPlan }, {}).skipped);
  const r = analyzeFraming({}, coords(() => ({ H: 0.5 })));
  assert.equal(r.ok, true);
  assert.ok(r.skipped);
});

test('阈值可调：同一份坐标，放宽容错后放行', () => {
  const c = coords((i) => ({ H: i <= 8 ? 0.13 - 0.015 * (i - 1) : null, TRAIN: null }));
  const r = analyzeFraming({ assets: stationPlan }, c, { inFrameMin: 0.5, travelMin: 0.02 });
  assert.equal(analyzeFraming({ assets: stationPlan }, c).ok, false);
  assert.equal(r.ok, true, JSON.stringify(r.findings));
});

// ---------- 报告输出 ----------
test('报告：通过 / 未通过 / 跳过 三种文案都清楚', () => {
  const bad = analyzeFraming({ assets: stationPlan }, coords((i) => ({ H: i <= 8 ? 0.13 : null, TRAIN: 0.5 })));
  const badLines = formatFraming(bad).join('\n');
  assert.match(badLines, /✗ 取景预检未通过/);
  assert.match(badLines, /\[F1\]/);

  const good = analyzeFraming({ assets: [char('H', [{ start_pos: [0, 0], end_pos: [1, 0] }])] },
    coords((i) => ({ H: 0.5 - 0.03 * (i - 1) })));
  assert.match(formatFraming(good).join('\n'), /✓ 取景预检通过/);

  const skip = analyzeFraming({ assets: stationPlan }, {});
  assert.match(formatFraming(skip).join('\n'), /跳过/);
});

test('默认阈值与已 Bootstrap 的规则一致（改了的要同步更新这里）', () => {
  assert.equal(DEFAULT_RULES.inFrameMin, 0.9);
  assert.equal(DEFAULT_RULES.travelMin, 0.15);
  assert.equal(DEFAULT_RULES.edgeBand, 0.08);
  assert.equal(DEFAULT_RULES.edgeMax, 0.5);
});
