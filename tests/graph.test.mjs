import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGraph, availabilityOf, frontierOf, nextStageOf, directorUnitOf, fmtSec,
  GATE_ORDER, COL_STEP, ROW_STEP, MAX_UNIT_COLS, UNIT_H, EPISODE_H,
} from '../web/src/graph.js';
import { gateSummary } from '../src/board-data.mjs';

/**
 * 画布图层测试：`web/src/graph.js` 是纯函数（不 import React/DOM），node 直接跑。
 *
 * 钉住的是"排布与卡点判定"这类可判定的逻辑 —— 与界面渲染无关，
 * 所以界面怎么改都不该让这些断言失效；反过来说，这些断言挂了就是逻辑真错了。
 */

const board = {
  meta: { title: '试拍剧', aspect: '16:9' },
  shots: [{ id: 's01' }, { id: 's02' }],
  characters: [{ id: 'c1', name: '苏晚' }],
  scenes: [{ id: 'sc1', name: '机舱' }],
};

/** 造一个快照：n 个计划单元，票由 approvals 决定。 */
function makeSnapshot({ n = 1, approvals = {}, withClip = true, withKeyframe = true } = {}) {
  const units = Array.from({ length: n }, (_, i) => {
    const id = `g${String(i + 1).padStart(3, '0')}`;
    return {
      id,
      shotCount: 1,
      contentDuration: 5.2,
      generationDuration: 5.17,
      scene: 'sc1',
      cast: ['c1'],
      audienceKnows: '',
      why: '',
      keyframe: withKeyframe ? `keyframes_render/${id}.png` : null,
      clip: withClip ? `units/${id}_clip_v1.mp4` : null,
    };
  });
  return {
    name: 'alpha',
    title: '试拍剧',
    story: '第一行\n苏晚（急）：你别走\n',
    board,
    direction: { units: [{ id: 'u1', shots: [{ n: 1, lines: [2] }] }] },
    plan: { units, totals: { content_duration_s: 21.4 } },
    units,
    assets: [{ key: 'portrait:c1', tab: 1, group: '肖像', label: '苏晚', path: 'assets/c1.png' }],
    finalRel: 'out/final.mp4',
    directionUnits: [{ id: 'u1', keyframe_start: '', why: '', shots: [{ n: 1, lines: [{ n: 2, text: '你别走' }] }] }],
    gates: gateSummary({ approvals }, units.map((u) => u.id)),
  };
}

const gateOf = (node, key) => (node.data.gates || []).find((g) => g.key === key);

test('决策链只有三节：剧本 → 导演稿 → 资源（执行细节已撤）', () => {
  const g = buildGraph(makeSnapshot());
  assert.deepEqual(
    g.nodes.filter((x) => x.type === 'stage').map((x) => x.id),
    ['stage:story', 'stage:direction', 'stage:assets'],
  );
  assert.equal(g.nodes.find((x) => x.id === 'stage:detail'), undefined, '执行细节节点已撤（用户 2026-09-23）');
  const stageEdges = g.edges.filter((e) => e.source.startsWith('stage:') && e.target.startsWith('stage:'));
  assert.equal(stageEdges.length, 2, '主链两条；侧挂虚线也不再有');
  // 阶段节点水平铺开，不重叠
  const xs = g.nodes.filter((x) => x.type === 'stage').map((x) => x.position.x);
  assert.deepEqual(xs, [0, COL_STEP, COL_STEP * 2]);
});

test('画布不画场次层：单元排成网格直接挂导演稿', () => {
  const g = buildGraph(makeSnapshot({ n: 4 }));
  assert.equal(g.nodes.filter((x) => x.type === 'unit').length, 4);
  assert.equal(g.nodes.filter((x) => x.type === 'scene').length, 0, '场次层已按用户拍板撤掉');
  assert.equal(g.edges.filter((e) => e.source === 'stage:direction' && e.target.startsWith('unit:')).length, 4);
  // 单元仍各自汇聚成片
  assert.equal(g.edges.filter((e) => e.target === 'final').length, 4);
  assert.equal(g.nodes.filter((x) => x.id === 'final').length, 1);
  // 网格：4 个一排，从导演稿正下开始
  assert.deepEqual(
    g.nodes.filter((x) => x.type === 'unit').map((x) => x.position.x),
    [COL_STEP, COL_STEP * 2, COL_STEP * 3, COL_STEP * 4],
  );
});

test('单元卡带上场次小标签（画布不画那一层，但"这段在哪个空间"要看得见）', () => {
  const s = makeSnapshot({ n: 2 });
  s.board = {
    ...board,
    scenes: [
      { id: 'sc1', name: '机舱', scene_no: 1 },
      { id: 'sc2', name: '雨夜路口', scene_no: 2 },
    ],
  };
  s.units = s.units.map((u, i) => ({ ...u, scene: i === 1 ? 'sc2' : 'sc1' }));
  s.plan = { ...s.plan, units: s.units };
  const g = buildGraph(s);
  const u1 = g.nodes.find((x) => x.id === 'unit:g001');
  const u2 = g.nodes.find((x) => x.id === 'unit:g002');
  assert.deepEqual([u1.data.sceneNo, u1.data.sceneName, u1.data.sceneEpisode], [1, '机舱', null]);
  // 夹具的板子没有 episode 字段（老板子就是这样）→ 标签退回「1-1」，不假装知道集数
  assert.deepEqual([u2.data.sceneNo, u2.data.sceneName], [2, '雨夜路口']);
  assert.equal(u1.data.crossScene, false);
});

test('跨场单元：场次标签取首镜那一场，并标出「跨场」', () => {
  const s = makeSnapshot({ n: 2 });
  s.board = {
    ...board,
    scenes: [
      { id: 'sc1', name: '机舱', scene_no: 1 },
      { id: 'sc2', name: '雨夜路口', scene_no: 2 },
    ],
  };
  // g001 的两镜跨了两场 → 计划不给单元级 scene（generation-plan 就是这么写的）
  s.units = [
    { ...s.units[0], scene: undefined, shots: [{ n: 1, scene: 'sc1' }, { n: 2, scene: 'sc2' }] },
    { ...s.units[1], scene: 'sc2', shots: [{ n: 1, scene: 'sc2' }] },
  ];
  s.plan = { ...s.plan, units: s.units };
  const g = buildGraph(s);

  const u1 = g.nodes.find((x) => x.id === 'unit:g001');
  assert.equal(u1.data.crossScene, true, '跨场要标出来');
  assert.equal(u1.data.sceneName, '机舱', '标签取首镜那一场');
  assert.equal(g.nodes.find((x) => x.id === 'unit:g002').data.crossScene, false);
});

test('多集：每集一条分组带，单元按集分块，跨集重号也分得开', () => {
  const s = makeSnapshot({ n: 3 });
  s.board = {
    ...board,
    scenes: [
      { id: 'sc1', name: '车厢', scene_no: 1, episode: 1 },
      { id: 'sc2', name: '路口', scene_no: 2, episode: 1 },
      { id: 'sc3', name: '车厢', scene_no: 1, episode: 2 },   // 跨集重号：scene_no 又是 1
    ],
  };
  s.units = s.units.map((u, i) => ({ ...u, scene: ['sc1', 'sc2', 'sc3'][i] }));
  s.plan = { ...s.plan, units: s.units };
  const g = buildGraph(s);

  const eps = g.nodes.filter((x) => x.type === 'episode');
  assert.deepEqual(eps.map((x) => x.id), ['episode:1', 'episode:2']);
  assert.deepEqual(eps.map((x) => x.data.title), ['第 1 集', '第 2 集']);
  assert.deepEqual(eps.map((x) => x.data.subtitle), ['2 单元', '1 单元']);

  // 第二集的单元换到下一块
  const u1 = g.nodes.find((x) => x.id === 'unit:g001');
  const u3 = g.nodes.find((x) => x.id === 'unit:g003');
  assert.equal(u3.position.x, u1.position.x, '两集的第一个单元都从同一列开始');
  assert.ok(u3.position.y > u1.position.y, '第二集的单元在下一块');
  assert.ok(eps[1].position.y + EPISODE_H < u3.position.y, '集带在该集单元上面');

  // 导演稿 → 集带 → 单元
  assert.equal(g.edges.filter((e) => e.source === 'stage:direction' && e.target.startsWith('episode:')).length, 2);
  assert.equal(g.edges.filter((e) => e.source === 'episode:2' && e.target === 'unit:g003').length, 1);
  // 单元标签里的场次号按集分开：2-1 与 1-1 不同
  assert.equal(u3.data.sceneEpisode, 2);
  assert.equal(u3.data.sceneNo, 1);
});

test('单元多时按网格换行，成片落在最后一个单元之下', () => {
  const g = buildGraph(makeSnapshot({ n: 16 }));
  assert.equal(g.info.cols, MAX_UNIT_COLS);
  assert.equal(g.info.rows, 4);
  const final = g.nodes.find((x) => x.id === 'final');
  const last = g.nodes.find((x) => x.id === 'unit:g016');
  assert.ok(final.position.y > last.position.y + UNIT_H, `成片 y=${final.position.y} 应在最后一个单元之下`);
  const u1 = g.nodes.find((x) => x.id === 'unit:g001');
  const u5 = g.nodes.find((x) => x.id === 'unit:g005');
  assert.equal(u5.position.x, u1.position.x, '第 5 个单元换行后回到第一列');
  assert.equal(u5.position.y, u1.position.y + ROW_STEP, '换行 = 下一行');
});

test('没有任何单元时不出成片以外的空节点', () => {
  const g = buildGraph(makeSnapshot({ n: 0 }));
  assert.equal(g.nodes.filter((x) => x.type === 'unit').length, 0);
  assert.equal(g.edges.filter((e) => e.target === 'final').length, 0);
  assert.ok(g.nodes.find((x) => x.id === 'final'));
});

test('卡点：产物已出但票未签的第一处；产物没出的阶段不算卡点', () => {
  const gates = gateSummary({ approvals: { story: { at: 't', by: '用户', artifact_hash: 'h' } } }, ['g001']);
  // 剧本已签、板子有产物未签、导演稿还没产出 → 卡点是板子，不该跳到导演稿
  const avail = { story: true, board: true, direction: false, assets: false, keyframes: false, clips: false, final: false };
  assert.equal(frontierOf(gates, avail), 'board');
  // 全部产物在、全部票空 → 卡点是最早的剧本票
  const allThere = Object.fromEntries(GATE_ORDER.map((k) => [k, true]));
  assert.equal(frontierOf(gateSummary(null, ['g001']), allThere), 'story');
  // 产物都没出 → 没有卡点可言
  assert.equal(frontierOf(gateSummary(null, []), Object.fromEntries(GATE_ORDER.map((k) => [k, false]))), null);
});

test('卡点只看"已推进到的最远处之后"：老剧目缺早期票不误报', () => {
  // 实测形态（cat_mouse）：direction 与 keyframes 签了、片段也签了，
  // 但 story/board/assets 从来没有票 —— 卡点应是成片，不该是剧本票
  const signed = { at: 't', by: '用户', artifact_hash: 'h' };
  const gates = gateSummary({
    approvals: { direction: signed, keyframes: signed, clips: { g001: signed } },
  }, ['g001']);
  const avail = { story: true, board: true, direction: true, assets: true, keyframes: true, clips: true, final: true };
  assert.equal(frontierOf(gates, avail), 'final');
  // 同样缺早期票、但成片也签了 → 没有卡点
  assert.equal(frontierOf(gateSummary({ approvals: { direction: signed, keyframes: signed, clips: { g001: signed }, final: signed } }, ['g001']), avail), null);
});

test('nextStageOf：第一个还没产出的阶段，全出齐给 null', () => {
  assert.equal(nextStageOf({ story: true, board: true, direction: false, assets: false, keyframes: false, clips: false, final: false }), 'direction');
  assert.equal(nextStageOf(Object.fromEntries(GATE_ORDER.map((k) => [k, true]))), null);
});

test('availabilityOf：以产物为准，不看票', () => {
  const s = makeSnapshot({ n: 2 });
  const a = availabilityOf(s);
  assert.equal(a.story, true);
  assert.equal(a.assets, true);
  assert.equal(a.keyframes, true);
  assert.equal(a.clips, true);
  assert.equal(a.final, true);
  const noMedia = availabilityOf(makeSnapshot({ n: 2, withClip: false, withKeyframe: false }));
  assert.equal(noMedia.keyframes, false);
  assert.equal(noMedia.clips, false);
});

test('单元节点携带关键帧票与片段票，clips 按单元逐张算', () => {
  const signed = { at: 't', by: '用户', artifact_hash: 'h' };
  const s = makeSnapshot({
    n: 2,
    approvals: {
      // 前面几个阶段都签过了，只剩片段票只签了一半 —— 这才叫"卡在片段上"
      story: signed, board: signed, direction: signed, assets: signed,
      keyframes: signed,
      clips: { g001: signed },
    },
  });
  const g = buildGraph(s);
  const u1 = g.nodes.find((x) => x.id === 'unit:g001');
  const u2 = g.nodes.find((x) => x.id === 'unit:g002');
  assert.equal(gateOf(u1, 'keyframes').signed, true);
  assert.equal(gateOf(u1, 'clips').signed, true);
  assert.equal(gateOf(u2, 'keyframes').signed, true, '关键帧票是阶段级，两个单元都算已签');
  assert.equal(gateOf(u2, 'clips').signed, false);
  assert.equal(g.info.frontier, 'clips');
  assert.equal(u2.data.pending, true);
  assert.equal(u1.data.pending, false);
});

test('票徽标文案与顺序：资源节点背板子票 + 资源票', () => {
  const g = buildGraph(makeSnapshot());
  const assetsNode = g.nodes.find((x) => x.id === 'stage:assets');
  assert.deepEqual(assetsNode.data.gates.map((x) => x.label), ['板子票', '资源票']);
  assert.deepEqual(assetsNode.data.gates.map((x) => x.key), ['board', 'assets']);
  const finalNode = g.nodes.find((x) => x.id === 'final');
  assert.deepEqual(finalNode.data.gates.map((x) => x.label), ['成片票']);
});

test('directorUnitOf：按计划的 source_units 映射，绝不按序号猜（且用解过正文的那份）', () => {
  const s = makeSnapshot();
  // 同一份快照的两份列表永远描述同一批单元，所以两边同步改
  s.plan.units[0].source_units = ['u1'];
  s.direction.units = [{ id: 'u9', shots: [] }, { id: 'u1', shots: [] }];
  s.directionUnits = [
    { id: 'u9', why: '', shots: [] },
    { id: 'u1', why: '', shots: [{ n: 1, lines: [{ n: 2, text: '你别走' }] }] },
  ];
  assert.equal(directorUnitOf(s, 'g001').id, 'u1', '导演顺序与计划不同也必须对上');
  // 取到的是**解过正文**的那份：行号已经带 text，前端直接渲染
  assert.deepEqual(directorUnitOf(s, 'g001').shots[0].lines, [{ n: 2, text: '你别走' }]);
  // 有 source_units 但导演稿里找不到 → 退回同序号；没有导演稿 → null
  s.plan.units[0].source_units = ['u404'];
  assert.equal(directorUnitOf(s, 'g001').id, 'u9');
  assert.equal(directorUnitOf({ plan: { units: [] }, direction: null }, 'g001'), null);
  // 快照里没有解过的那份（老夹具/老接口）时退回原始档案，不能崩
  assert.equal(directorUnitOf({ plan: { units: [{ id: 'g001', source_units: ['u1'] }] }, direction: { units: [{ id: 'u1', shots: [] }] } }, 'g001').id, 'u1');
});

test('副标题取得到真值：剧本行数 / 资源清单 / 导演稿单元与镜数', () => {
  const g = buildGraph(makeSnapshot({ n: 2 }));
  const story = g.nodes.find((x) => x.id === 'stage:story');
  const assetsN = g.nodes.find((x) => x.id === 'stage:assets');
  const dirN = g.nodes.find((x) => x.id === 'stage:direction');
  assert.equal(story.data.subtitle, '2 行');
  // 清单规模（只报非零类别）：夹具里 1 角色 1 场景，没有造型与道具
  assert.equal(assetsN.data.subtitle, '1 角色 · 1 场景');
  assert.equal(dirN.data.subtitle, '1 单元 · 1 镜');
});

test('fmtSec：没有值给破折号，不做假数据', () => {
  assert.equal(fmtSec(5.17), '5.2s');
  assert.equal(fmtSec(null), '—');
  assert.equal(fmtSec(undefined), '—');
  assert.equal(fmtSec('abc'), '—');
});
