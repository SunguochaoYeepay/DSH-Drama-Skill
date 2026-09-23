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
export const MAX_UNIT_COLS = 4;   // 单元网格每行最多几个
export const UNIT_TOP = STAGE_H + 104;    // 单元行紧贴阶段行下面
export const EPISODE_H = 34;              // 「集」分组条（只在多集时出现）
export const EPISODE_ROW_GAP = 40;        // 集与集之间的间距
export const FINAL_GAP = 76;

/** 票的流水线顺序。`handoffs` 不在此列：它是交接记录，不是阶段闸门。 */
export const GATE_ORDER = ['story', 'board', 'direction', 'assets', 'keyframes', 'clips', 'final'];

/**
 * 阶段行 = **用户要审的那条决策链**（2026-09-23 用户拍板）：
 *   剧本 → 导演稿 → 资源 → 单元（关键帧 / 视频）→ 成片
 *
 * 「板子」与「生成计划」属于执行逻辑（编译产物、单元切分与时长钳制），**一律不上画布**：
 * - 板子票与资源票一起挂在**资源**节点上 —— 板子里的场景/角色/造型/道具清单**就是资源**；
 * - 编译产物与计划连侧挂节点也撤掉了（用户 2026-09-23：不想再看到执行细节）。
 */
export const STAGE_DEFS = [
  { key: 'story', title: '剧本', file: 'story.md', gates: ['story'] },
  { key: 'direction', title: '导演稿', file: 'board.direction.json', gates: ['direction'] },
  { key: 'assets', title: '资源', file: 'board.json', gates: ['board', 'assets'] },
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
  if (def.key === 'assets') {
    // 资源节点报的是**清单规模**（决策物），不是编译出来的镜头数 —— 那属于执行细节。
    // 只报非零的类别，免得满屏"0 道具"。
    return [
      `${(board.characters || []).length} 角色`,
      (board.identities || []).length ? `${(board.identities || []).length} 造型` : null,
      `${(board.scenes || []).length} 场景`,
      (board.props || []).length ? `${(board.props || []).length} 道具` : null,
    ].filter(Boolean).join(' · ');
  }
  if (def.key === 'direction') {
    const dirUnits = snapshot.direction?.units || [];
    const shots = dirUnits.reduce((n, u) => n + (u.shots || []).length, 0);
    return dirUnits.length ? `${dirUnits.length} 单元 · ${shots} 镜` : '未读到导演稿';
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
  const board = snapshot?.board || {};
  const gates = snapshot?.gates || {};
  const units = snapshot?.units || [];
  const availability = availabilityOf(snapshot);
  const frontier = frontierOf(gates, availability);
  const nextStage = nextStageOf(availability);

  const nodes = [];
  const edges = [];

  // ── 阶段行（左 → 右）：剧本 → 导演稿 → 资源 ─────────────────────────
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
        // 场次从**导演稿**扇出：单元边界是导演划的，场次也一样
        hasScenesHandle: def.key === 'direction',
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

  // ── 单元 → 成片 ──────────────────────────────────────────────────
  // **画布不画场次层**（用户 2026-09-23 拍板：「不要场次了，按单元来吧，这样更简单」）。
  // 场次信息没有丢：右侧单元页的「基本」有场景名、「用到的资源」有那一场的场景主图。
  // 「集」只在**多于一集**时才画分组带（同一条规矩：只在不止一个时才画那一层）。
  const sceneById = new Map((board.scenes || []).map((s) => [s.id, s]));
  const planByUnit = new Map((snapshot?.plan?.units || []).map((u) => [u.id, u]));
  /** 单元所属场次：先看计划给的 `unit.scene`，没有就退回**首镜**的 scene
   *  （场次归属是导演稿逐镜写的；跨场单元计划不提升到单元级）。 */
  const sceneOfUnit = (u) => {
    if (sceneById.has(u.scene)) return sceneById.get(u.scene);
    const shots = planByUnit.get(u.id)?.shots || [];
    const first = shots.find((s) => s.scene && sceneById.has(s.scene));
    return first ? sceneById.get(first.scene) : null;
  };
  const episodes = [...new Set(units.map((u) => sceneOfUnit(u)?.episode).filter((v) => v != null))].sort((a, b) => a - b);
  const multiEpisode = episodes.length > 1;
  /** 这个单元的镜头是不是跨了多场（数据允许，实践上很少）—— 卡片上标一下，
   *  免得看见的场次号只是"首镜那一场"却被当成整段都在那儿。 */
  const isCrossScene = (u) => {
    const shots = planByUnit.get(u.id)?.shots || [];
    return new Set(shots.map((s) => s.scene).filter(Boolean)).size > 1;
  };

  const wide = units.length > 6;   // 单元多时把边画细一点，免得糊成一片

  // 分块：多集时一集一块（块首是「集」分组带），单集时就是一块
  const blocks = [];
  if (multiEpisode) {
    for (const u of units) {
      const ep = sceneOfUnit(u)?.episode ?? null;
      let b = blocks.find((x) => x.ep === ep);
      if (!b) { b = { ep, units: [] }; blocks.push(b); }
      b.units.push(u);
    }
    blocks.sort((a, b) => (a.ep ?? -1) - (b.ep ?? -1));
  } else {
    blocks.push({ ep: null, units });
  }

  // 单元排成网格（每行最多 MAX_UNIT_COLS 个），整块对齐在导演稿下方 —— 扇出线短
  const unitOriginX = COL_STEP;
  const blockWidth = (count) => (Math.min(MAX_UNIT_COLS, Math.max(1, count)) - 1) * COL_STEP + UNIT_W;
  let cursorY = UNIT_TOP;
  let bottomY = UNIT_TOP;
  let widestX = unitOriginX;
  blocks.forEach((b) => {
    const bandH = multiEpisode ? EPISODE_H + 12 : 0;
    const gridY = cursorY + bandH;
    const cols = Math.max(1, Math.min(MAX_UNIT_COLS, b.units.length));
    const rows = Math.ceil(b.units.length / cols);

    if (multiEpisode) {
      nodes.push({
        id: `episode:${b.ep}`,
        type: 'episode',
        position: { x: unitOriginX, y: cursorY },
        width: blockWidth(b.units.length),
        height: EPISODE_H,
        data: {
          kind: 'episode',
          title: b.ep == null ? '未分集' : `第 ${b.ep} 集`,
          subtitle: `${b.units.length} 单元`,
        },
      });
      edges.push(edge({
        id: `e:direction->ep${b.ep}`,
        source: 'stage:direction',
        target: `episode:${b.ep}`,
        sourceHandle: 'scenes',
        targetHandle: 'in',
      }));
    }

    b.units.forEach((u, i) => {
      const c = i % cols;
      const r = Math.floor(i / cols);
      const x = unitOriginX + c * COL_STEP;
      const y = gridY + r * ROW_STEP;
      const rows2 = gateRows(['keyframes', 'clips'], gates, u.id);
      const scene = sceneOfUnit(u);
      nodes.push({
        id: `unit:${u.id}`,
        type: 'unit',
        position: { x, y },
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
          // 场次信息以**小标签**留在卡片上（画布不再画那一层，但"这段在哪个空间"要看得见）
          sceneNo: scene?.scene_no ?? null,
          sceneEpisode: scene?.episode ?? null,
          sceneName: scene?.name || null,
          crossScene: isCrossScene(u),
          gates: rows2,
          pending: isPendingNode(rows2, frontier),
        },
      });
      edges.push(edge({
        id: multiEpisode ? `e:ep${b.ep}->${u.id}` : `e:direction->${u.id}`,
        source: multiEpisode ? `episode:${b.ep}` : 'stage:direction',
        target: `unit:${u.id}`,
        sourceHandle: 'scenes',
        targetHandle: 'in',
        faint: wide,
      }));
      widestX = Math.max(widestX, x);
    });

    bottomY = Math.max(bottomY, gridY + (rows - 1) * ROW_STEP + UNIT_H);
    cursorY = bottomY + EPISODE_ROW_GAP;
  });

  const cols = units.length ? Math.min(MAX_UNIT_COLS, units.length) : 0;
  const rows = blocks.reduce((m, b) => {
    const c = Math.max(1, Math.min(MAX_UNIT_COLS, b.units.length));
    return Math.max(m, Math.ceil(b.units.length / c));
  }, 0);
  const finalY = bottomY + FINAL_GAP;
  const finalX = (unitOriginX + widestX) / 2;
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
 *
 * **必须用解过正文的那份**（`directionUnits`：行号已由 board-data 就地解成台词）。
 * 原始 `board.direction.json` 的 `shots[].lines` 只有**裸行号**（`[12]`），
 * 拿它去渲染 `ln.text`/`ln.n` 全是 undefined —— 整片镜头都会显示"行号对不上"，
 * 而且行号位置是空的（2026-09-23 实测，就是这个 bug）。
 * 只有快照里没有解过的那份时（老测试夹具）才退回原始档案。
 */
export function directorUnitOf(snapshot, unitId) {
  const planUnits = snapshot?.plan?.units || [];
  const dirUnits = snapshot?.directionUnits?.length
    ? snapshot.directionUnits
    : (snapshot?.direction?.units || []);
  if (!dirUnits.length) return null;
  const idx = planUnits.findIndex((u) => u.id === unitId);
  const sources = idx >= 0 ? planUnits[idx].source_units : null;
  if (Array.isArray(sources) && sources.length) {
    const hit = dirUnits.find((d) => sources.includes(d.id));
    if (hit) return hit;
  }
  return dirUnits[idx] || null;
}
