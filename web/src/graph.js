/**
 * graph.js — 剧目快照 → 画布节点/边（纯函数：不碰 React、不碰 DOM）。
 *
 * 为什么单独一层：画布的"排布对不对、闸门挂在哪个节点上、卡点算得准不准"
 * 全是可判定的逻辑，不该埋在 JSX 里。`tests/graph.test.mjs` 用 node 直接 import
 * 本文件跑断言，与界面渲染无关。
 *
 * 图层语义（与 references/workflow.md 的阶段序一致）：
 *   剧本 → 板子 → 导演稿 → 生成计划 ─┬→ 单元 g001 ─┐
 *                                    ├→ 单元 g002 ─┼→ 成片
 *                                    └→ 单元 g00N ─┘
 * 闸门票（人工签的）挂在对应节点上；「卡点」= 产物已出但票没签的第一处。
 */

/** 节点尺寸与排布（像素，画布坐标）。 */
export const STAGE_W = 264;
export const STAGE_H = 96;
export const UNIT_W = 264;
export const UNIT_H = 214;
export const FINAL_W = 264;
export const FINAL_H = 96;
export const COL_STEP = 304;      // 阶段节点水平步长 = STAGE_W + 40
export const ROW_STEP = 246;      // 单元行步长 = UNIT_H + 32
export const MAX_UNIT_COLS = 4;
export const UNIT_TOP = STAGE_H + 104;
export const FINAL_GAP = 76;

/** 票的流水线顺序。`handoffs` 不在此列：它是交接记录，不是阶段闸门。 */
export const GATE_ORDER = ['story', 'board', 'direction', 'assets', 'keyframes', 'clips', 'final'];

/** 阶段节点定义：gates 是本节点承载的票。 */
export const STAGE_DEFS = [
  { key: 'story', title: '剧本', file: 'story.md', gates: ['story'] },
  { key: 'board', title: '板子', file: 'board.json', gates: ['board', 'assets'] },
  { key: 'direction', title: '导演稿', file: 'board.direction.json', gates: ['direction'] },
  { key: 'plan', title: '生成计划', file: 'render.plan.json', gates: [] },
];

/** 票的中文名（界面与测试共用，改一处生效）。 */
export const GATE_LABELS = {
  story: '剧本票',
  board: '板子票',
  direction: '导演票',
  assets: '资源票',
  keyframes: '关键帧票',
  handoffs: '交接单',
  clips: '片段票',
  final: '成片票',
};

/** 秒数 → 一位小数（`—` 表示没有值）。注意 `Number(null)===0`，缺值必须先挡掉。 */
export function fmtSec(n) {
  if (n === null || n === undefined || n === '') return '—';
  const v = Number(n);
  return Number.isFinite(v) ? `${v.toFixed(1)}s` : '—';
}

/**
 * 各阶段「产物在不在」——判卡点必须用它：
 * 东西还没生成的阶段谈不上"卡在票上"，否则老剧目会报出假卡点。
 * @returns {Record<string, boolean>}
 */
export function availabilityOf(snapshot) {
  const units = snapshot?.units || [];
  return {
    story: Boolean(snapshot?.story),
    board: Boolean(snapshot?.board),
    direction: Boolean(snapshot?.direction),
    assets: (snapshot?.assets || []).some((a) => a.tab === 1 && a.path),
    keyframes: units.some((u) => u.keyframe),
    clips: units.some((u) => u.clip),
    final: Boolean(snapshot?.finalRel),
  };
}

/**
 * 卡点：**已推进到的最远处之后**，第一个「产物已出但票未签」的阶段。
 *
 * 为什么要"最远处之后"而不是"最早未签"：老剧目常有"前面几张票从来没写过、
 * 但后面已经签到片段"的情况（实测 cat_mouse 签了 5 张片段票、却没有 story/board/
 * assets 票）。按"最早未签"会把这种剧目报成「卡在剧本票」—— 与事实相反。
 * 产物还没出的阶段同样跳过：那是"还没做到"，不是"卡住了"。
 *
 * @returns {string|null}
 */
export function frontierOf(gates, availability) {
  const live = GATE_ORDER.filter((key) => availability[key]);
  if (!live.length) return null;
  let lastSigned = -1;
  live.forEach((key, i) => {
    if (gates?.[key]?.signed) lastSigned = i;
  });
  for (let i = lastSigned + 1; i < live.length; i++) {
    if (!gates?.[live[i]]?.signed) return live[i];
  }
  return null;
}

/** 下一个还没产出的阶段（全出齐则 null）—— 用来提示"下一步该做什么"。 */
export function nextStageOf(availability) {
  for (const key of GATE_ORDER) if (!availability[key]) return key;
  return null;
}

/** 票的展示行（键 + 中文名 + 是否已签），只给渲染用。 */
function gateRows(keys, gates, unitId) {
  return keys.map((key) => {
    const signed = key === 'clips' && unitId
      ? Boolean(gates?.clips?.perUnit?.[unitId])
      : Boolean(gates?.[key]?.signed);
    return { key, label: GATE_LABELS[key] || key, signed };
  });
}

/** 这个节点是不是当前卡点：命中卡点票，且**那张票确实还没签**。 */
function isPendingNode(rows, frontier) {
  return Boolean(frontier) && rows.some((r) => r.key === frontier && !r.signed);
}

/** 阶段节点的副标题：把该阶段最要紧的量报出来。 */
function stageSubtitle(def, snapshot) {
  const board = snapshot.board || {};
  const units = snapshot.units || [];
  if (def.key === 'story') {
    const lines = String(snapshot.story || '').split(/\r?\n/).filter((s) => s.trim()).length;
    return lines ? `${lines} 行` : '未读到剧本';
  }
  if (def.key === 'board') {
    return `${(board.shots || []).length} 镜 · ${(board.characters || []).length} 角色 · ${(board.scenes || []).length} 场景`;
  }
  if (def.key === 'direction') {
    const dirUnits = snapshot.direction?.units || [];
    const shots = dirUnits.reduce((n, u) => n + (u.shots || []).length, 0);
    return dirUnits.length ? `${dirUnits.length} 单元 · ${shots} 镜` : '未读到导演稿';
  }
  if (def.key === 'plan') {
    const total = snapshot.plan?.totals?.content_duration_s;
    return units.length ? `${units.length} 单元 · ${fmtSec(total)}` : '未读到生成计划';
  }
  return '';
}

/**
 * 快照 → React Flow 的 nodes / edges。
 *
 * @param {object} snapshot `loadProject()` 的快照
 * @returns {{nodes:Array,edges:Array,info:{frontier:string|null,nextStage:string|null,cols:number,rows:number}}}
 */
export function buildGraph(snapshot) {
  const gates = snapshot?.gates || {};
  const units = snapshot?.units || [];
  const availability = availabilityOf(snapshot);
  const frontier = frontierOf(gates, availability);
  const nextStage = nextStageOf(availability);

  const nodes = [];
  const edges = [];

  // ── 阶段行（左 → 右） ──────────────────────────────────────────────
  STAGE_DEFS.forEach((def, i) => {
    const rows = gateRows(def.gates, gates);
    nodes.push({
      id: `stage:${def.key}`,
      type: 'stage',
      position: { x: i * COL_STEP, y: 0 },
      width: STAGE_W,
      height: STAGE_H,
      data: {
        kind: 'stage',
        key: def.key,
        title: def.title,
        file: def.file,
        subtitle: stageSubtitle(def, snapshot),
        present: availability[def.key] ?? null,
        gates: rows,
        pending: isPendingNode(rows, frontier),
      },
    });
  });

  for (let i = 0; i < STAGE_DEFS.length - 1; i++) {
    edges.push(edge({
      id: `e:${STAGE_DEFS[i].key}->${STAGE_DEFS[i + 1].key}`,
      source: `stage:${STAGE_DEFS[i].key}`,
      target: `stage:${STAGE_DEFS[i + 1].key}`,
      sourceHandle: 'out',
      targetHandle: 'in',
    }));
  }

  // ── 单元网格（计划扇出 → 每单元 → 汇聚成片） ──────────────────────
  const n = units.length;
  const cols = n ? Math.min(MAX_UNIT_COLS, n) : 0;
  const rows = cols ? Math.ceil(n / cols) : 0;
  const wide = n > 6;   // 单元多时把扇出边画细一点，免得糊成一片

  units.forEach((u, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const rows2 = gateRows(['keyframes', 'clips'], gates, u.id);
    nodes.push({
      id: `unit:${u.id}`,
      type: 'unit',
      position: { x: c * COL_STEP, y: UNIT_TOP + r * ROW_STEP },
      width: UNIT_W,
      height: UNIT_H,
      data: {
        kind: 'unit',
        id: u.id,
        duration: fmtSec(u.contentDuration),
        genDuration: fmtSec(u.generationDuration),
        shotCount: u.shotCount || 0,
        keyframe: u.keyframe || null,
        clip: u.clip || null,
        gates: rows2,
        pending: isPendingNode(rows2, frontier),
      },
    });
    edges.push(edge({
      id: `e:plan->${u.id}`,
      source: 'stage:plan',
      target: `unit:${u.id}`,
      sourceHandle: 'units',
      targetHandle: 'in',
      faint: wide,
    }));
  });

  const finalY = UNIT_TOP + rows * ROW_STEP + FINAL_GAP;
  const finalX = cols > 1 ? ((cols - 1) * COL_STEP) / 2 : 0;
  const finalGates = gateRows(['final'], gates);
  nodes.push({
    id: 'final',
    type: 'final',
    position: { x: finalX, y: finalY },
    width: FINAL_W,
    height: FINAL_H,
    data: {
      kind: 'final',
      title: '成片',
      subtitle: snapshot?.finalRel || '尚未合成',
      present: availability.final,
      gates: finalGates,
      pending: isPendingNode(finalGates, frontier),
    },
  });
  for (const u of units) {
    edges.push(edge({
      id: `e:${u.id}->final`,
      source: `unit:${u.id}`,
      target: 'final',
      sourceHandle: 'out',
      targetHandle: 'in',
      faint: wide,
    }));
  }

  return { nodes, edges, info: { frontier, nextStage, cols, rows } };
}

/** 边的统一形态：命中卡点的边加动画，扇出量大的边画细。 */
function edge({ id, source, target, sourceHandle, targetHandle, faint = false }) {
  return {
    id,
    source,
    target,
    sourceHandle,
    targetHandle,
    type: 'smoothstep',
    animated: false,
    style: { strokeWidth: faint ? 1 : 1.6, opacity: faint ? 0.45 : 0.85 },
  };
}

/**
 * 单元 → 导演单元：计划单元的 `source_units`（如 g001 ← u1）是权威映射。
 * 拿不到（老计划没有该字段）就退回同序号，再不行给 null —— 绝不硬猜。
 */
export function directorUnitOf(snapshot, unitId) {
  const planUnits = snapshot?.plan?.units || [];
  const dirUnits = snapshot?.direction?.units || [];
  if (!dirUnits.length) return null;
  const idx = planUnits.findIndex((u) => u.id === unitId);
  const sources = idx >= 0 ? planUnits[idx].source_units : null;
  if (Array.isArray(sources) && sources.length) {
    const hit = dirUnits.find((d) => sources.includes(d.id));
    if (hit) return hit;
  }
  return dirUnits[idx] || null;
}
