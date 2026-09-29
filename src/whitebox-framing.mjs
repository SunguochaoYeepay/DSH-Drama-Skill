/**
 * whitebox-framing.mjs — 白膜「取景预检」：把 coords.json 从交付物变成闸门。
 *
 * 来历（2026-09-29）：subway 场景渲完才发现主角全程贴在画面最左缘、f110–120 直接出画，
 * 「冲出人群追车」这个核心动作在成片里根本读不出来。而 coords.json **早就记录了这件事**
 * （每个资产的屏幕坐标逐帧都在），只是没人看。
 * ⇒ 教训：coords.json 不该只是给人查的表，它该是「渲染之后、送 H3 之前」的机器闸门。
 *
 * 三条规则全部由坐标表算得，不需要人眼、不需要 Blender、不需要跑 H3：
 *   F1 出框  role=character 的资产在画面内的帧占比低于 IN_FRAME_MIN
 *            （道具豁免：列车本来就该进画出画）
 *   F2 贴边  资产超过 EDGE_MAX 比例的可见帧落在画面左右最外侧 EDGE_BAND 内
 *            （抓「主体被挤到边缘」——最常见也最难靠肉眼早点发现的伤）
 *   F3 无位移 该动的资产（prop 有 path、character 有 end_pos）在屏幕上的横向位移不足 TRAVEL_MIN
 *            （抓「朝镜头纵深跑」——3/4 视角下透视会吃掉横向位移，等于白跑）
 *
 * 纯函数、零 IO：这样上面的规则能被单元测试直接打到（按 2026-09-28 的测试口径，
 * CLI 测试优先直接 import 函数，别裸写 spawnSync）。
 */

export const DEFAULT_RULES = {
  inFrameMin: 0.9,   // 角色在画面内的帧占比下限
  travelMin: 0.15,   // 该动的资产，屏幕横向位移下限（占屏宽比例）
  edgeBand: 0.08,    // 画面左右各多少算“贴边”
  edgeMax: 0.5,      // 贴边帧占比上限
};

/**
 * 这个资产「应该动」吗？只读规划 JSON 里已有的字段，不新增 schema：
 *   道具：有 path 且 waypoints 多于一个 ⇒ 在走
 *   角色：有任意 clip 带 end_pos ⇒ 在走
 */
export function mustMove(asset) {
  if (asset.kind === 'prop') {
    return !!(asset.path && Array.isArray(path_waypoints(asset)) && path_waypoints(asset).length > 1);
  }
  return (asset.clips || []).some((c) => Array.isArray(c.end_pos));
}

function path_waypoints(asset) {
  return asset.path && asset.path.waypoints;
}

/** 屏幕坐标表 → 每个资产的可视帧序列。 */
function visibleSeries(frames, assetId) {
  const out = [];
  for (const key of Object.keys(frames)) {
    const e = frames[key] && frames[key][assetId];
    if (e && Array.isArray(e.root) && e.root_visible === true) out.push(e.root[0]);
  }
  return out;
}

function presentCount(frames, assetId) {
  let n = 0;
  for (const key of Object.keys(frames)) {
    if (frames[key] && frames[key][assetId]) n += 1;
  }
  return n;
}

/**
 * 取景预检主入口。
 * @param {object} plan   whitebox/1 规划 JSON（已通过 validateWhitebox）
 * @param {object} coords coords.json：`{ fps, frames: { "<帧>": { "<id>": { root, root_visible, head, head_visible } } } }`
 * @param {object} rules  覆盖 DEFAULT_RULES 的字段
 * @returns {{ ok: boolean, skipped: string|null, assets: Array, findings: Array }}
 */
export function analyzeFraming(plan, coords, rules = {}) {
  const cfg = { ...DEFAULT_RULES, ...rules };
  const frames = coords && coords.frames;
  if (!frames || typeof frames !== 'object') {
    return { ok: true, skipped: '坐标表里没有 frames，跳过取景预检', assets: [], findings: [] };
  }
  if (!(plan && Array.isArray(plan.assets))) {
    return { ok: true, skipped: '规划里没有 assets，跳过取景预检', assets: [], findings: [] };
  }

  const assets = [];
  const findings = [];

  for (const a of plan.assets) {
    const id = a.asset_id;
    const xs = visibleSeries(frames, id);
    const present = presentCount(frames, id);
    if (!present) continue;

    const inFrame = xs.length / present;
    const travel = xs.length >= 2 ? Math.max(...xs) - Math.min(...xs) : 0;
    const edgeCount = xs.filter((u) => u < cfg.edgeBand || u > 1 - cfg.edgeBand).length;
    const edge = xs.length ? edgeCount / xs.length : 0;
    const move = mustMove(a);

    assets.push({ id, kind: a.kind, mustMove: move, inFrame, travel, edge, visible: xs.length, present });

    if (a.kind === 'character' && inFrame < cfg.inFrameMin) {
      findings.push({
        asset: id, rule: 'F1',
        message: `角色 ${id} 有 ${Math.round((1 - inFrame) * 100)}% 的帧不在画面内（要求 ≤ ${Math.round((1 - cfg.inFrameMin) * 100)}%）；`
          + '检查 look_at/机位是否没框住它，或它的轨迹是不是跑出了取景框。',
      });
    }
    if (xs.length && edge > cfg.edgeMax) {
      findings.push({
        asset: id, rule: 'F2',
        message: `资产 ${id} 有 ${Math.round(edge * 100)}% 的可见帧贴在画面边缘（要求 ≤ ${Math.round(cfg.edgeMax * 100)}%）；`
          + '主角被挤到边缘时，它的动作在成片里读不出来。',
      });
    }
    if (move && xs.length >= 2 && travel < cfg.travelMin) {
      findings.push({
        asset: id, rule: 'F3',
        message: `资产 ${id} 该动，但屏幕上横向位移只有 ${travel.toFixed(2)} 屏宽（要求 ≥ ${cfg.travelMin}）；`
          + '多半是运动方向朝着镜头纵深 —— 3/4 视角下透视会把横向位移吃掉，等于白跑。把轨迹改成横向穿过画面。',
      });
    }
  }

  return { ok: findings.length === 0, skipped: null, assets, findings };
}

const pct = (v) => `${Math.round(v * 100)}%`;

/** CLI 用的报告行. */
export function formatFraming(report) {
  const lines = [];
  if (report.skipped) {
    lines.push(`· 取景预检：跳过（${report.skipped}）`);
    return lines;
  }
  lines.push('取景预检（据 coords.json）：');
  lines.push('  资产    在框    位移    贴边');
  for (const a of report.assets) {
    lines.push(`  ${a.id.padEnd(6)} ${pct(a.inFrame).padStart(5)}  ${a.travel.toFixed(2).padStart(5)}  ${pct(a.edge).padStart(5)}`);
  }
  if (report.ok) {
    lines.push('✓ 取景预检通过：主体在框内、该动的都动了。');
  } else {
    lines.push(`✗ 取景预检未通过（${report.findings.length} 处）：`);
    for (const f of report.findings) lines.push(`  [${f.rule}] ${f.message}`);
  }
  return lines;
}
