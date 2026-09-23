import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGraph, availabilityOf, frontierOf, nextStageOf, directorUnitOf, fmtSec,
  GATE_ORDER, COL_STEP, ROW_STEP, SCENE_TOP, SCENE_H, SCENE_GAP, EPISODE_H, UNIT_H,
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

test('决策链：剧本 → 导演稿 → 资源，外加侧挂的执行细节', () => {
  const g = buildGraph(makeSnapshot());
  assert.deepEqual(
    g.nodes.filter((x) => x.type === 'stage').map((x) => x.id),
    ['stage:story', 'stage:direction', 'stage:assets', 'stage:detail'],
  );
  const stageEdges = g.edges.filter((e) => e.source.startsWith('stage:') && e.target.startsWith('stage:'));
  // 主链两条 + 资源 → 执行细节一条（侧挂，虚线）
  assert.equal(stageEdges.length, 3);
  const toDetail = stageEdges.filter((e) => e.target === 'stage:detail');
  assert.equal(toDetail.length, 1);
  assert.match(String(toDetail[0].style.strokeDasharray), /4/, '执行细节是次要节点，用虚线连');
  const detail = g.nodes.find((x) => x.id === 'stage:detail');
  assert.equal(detail.data.secondary, true);
  assert.equal(detail.data.gates.length, 0, '执行细节不承载闸门');
  // 阶段节点水平铺开，不重叠
  const xs = g.nodes.filter((x) => x.type === 'stage').map((x) => x.position.x);
  assert.deepEqual(xs, [0, COL_STEP, COL_STEP * 2, COL_STEP * 3]);
});

test('单元挂在它所属场次下面：一场一条扇出边，单元各自汇聚成片', () => {
  const g = buildGraph(makeSnapshot({ n: 4 }));
  assert.equal(g.nodes.filter((x) => x.type === 'unit').length, 4);
  // 夹具里所有单元都属于 sc1，所以是一个场次节点扇出四条边
  assert.equal(g.nodes.filter((x) => x.type === 'scene').length, 1);
  assert.equal(g.edges.filter((e) => e.source === 'scene:sc1' && e.target.startsWith('unit:')).length, 4);
  // 场次节点由导演稿扇出
  assert.equal(g.edges.filter((e) => e.source === 'stage:direction' && e.target === 'scene:sc1').length, 1);
  assert.equal(g.edges.filter((e) => e.target === 'final').length, 4);
  assert.equal(g.nodes.filter((x) => x.id === 'final').length, 1);
});

test('多个场次：各自一列，单元挂到各自的场次下面', () => {
  const s = makeSnapshot({ n: 3 });
  s.board = {
    ...board,
    scenes: [
      { id: 'sc1', name: '机舱', scene_no: 1 },
      { id: 'sc2', name: '雨夜路口', scene_no: 2 },
    ],
  };
  s.units = s.units.map((u, i) => ({ ...u, scene: i === 2 ? 'sc2' : 'sc1' }));
  s.plan = { ...s.plan, units: s.units };
  const g = buildGraph(s);
  const sceneNodes = g.nodes.filter((x) => x.type === 'scene');
  assert.deepEqual(sceneNodes.map((x) => x.id), ['scene:sc1', 'scene:sc2']);
  // 编号沿用剧本的写法（单集就是「1-1」），不另造"场次 N"这套词
  assert.deepEqual(sceneNodes.map((x) => x.data.title), ['1-1 · 机舱', '1-2 · 雨夜路口']);
  assert.deepEqual(sceneNodes.map((x) => x.data.unitCount), [2, 1]);
  assert.equal(g.nodes.filter((x) => x.type === 'episode').length, 0, '单集不画「集」分组带');
  // 两列：第一列 x=0，第二列 x=COL_STEP
  assert.deepEqual(sceneNodes.map((x) => x.position.x), [0, COL_STEP]);
  const u3 = g.nodes.find((x) => x.id === 'unit:g003');
  assert.equal(u3.position.x, COL_STEP, '第三个单元属于第二场，应落在第二列');
  assert.equal(u3.position.y, SCENE_TOP + SCENE_H + SCENE_GAP, '它是那一场的第一个单元');
});

test('多集：每集一条分组带，场次按集分行，标题写全「第 N 集 M-M」', () => {
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

  const scenes = g.nodes.filter((x) => x.type === 'scene');
  assert.deepEqual(scenes.map((x) => x.data.title), [
    '第 1 集 1-1 · 车厢',
    '第 1 集 1-2 · 路口',
    '第 2 集 2-1 · 车厢',
  ], '跨集重号的 1-1 / 2-1 必须分得开');

  const ep1Scene = scenes.find((x) => x.id === 'scene:sc1');
  const ep2Scene = scenes.find((x) => x.id === 'scene:sc3');
  assert.equal(ep2Scene.position.x, ep1Scene.position.x, '两集的第一场都从第一列开始');
  assert.ok(ep2Scene.position.y > ep1Scene.position.y, '第二集的场次换到下一行');
  assert.ok(eps[1].position.y + EPISODE_H < ep2Scene.position.y, '集带在该集场次上面');

  // 导演稿 → 集带 → 场次 → 单元
  assert.equal(g.edges.filter((e) => e.source === 'stage:direction' && e.target.startsWith('episode:')).length, 2);
  assert.equal(g.edges.filter((e) => e.source === 'episode:2' && e.target === 'scene:sc3').length, 1);
  assert.equal(g.edges.filter((e) => e.source === 'scene:sc3' && e.target === 'unit:g003').length, 1);
});

test('同一场次的单元纵向排下去，成片落在最后一个单元之下', () => {
  const g = buildGraph(makeSnapshot({ n: 16 }));
  assert.equal(g.info.cols, 1, '只有一个场次');
  assert.equal(g.info.rows, 16);
  const final = g.nodes.find((x) => x.id === 'final');
  const last = g.nodes.find((x) => x.id === 'unit:g016');
  assert.ok(final.position.y > last.position.y + UNIT_H, `成片 y=${final.position.y} 应在最后一个单元之下`);
  const u1 = g.nodes.find((x) => x.id === 'unit:g001');
  const u5 = g.nodes.find((x) => x.id === 'unit:g005');
  assert.equal(u1.position.x, u5.position.x, '同一场次的单元同一列');
  assert.equal(u5.position.y, u1.position.y + 4 * ROW_STEP, '第 5 个单元在第 1 个下面第 4 行');
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

test('directorUnitOf：按计划的 source_units 映射，绝不按序号猜', () => {
  const s = makeSnapshot();
  s.plan.units[0].source_units = ['u1'];
  s.direction.units = [{ id: 'u9', shots: [] }, { id: 'u1', shots: [] }];
  assert.equal(directorUnitOf(s, 'g001').id, 'u1', '导演顺序与计划不同也必须对上');
  // 有 source_units 但导演稿里找不到 → 退回同序号；没有导演稿 → null
  s.plan.units[0].source_units = ['u404'];
  assert.equal(directorUnitOf(s, 'g001').id, 'u9');
  assert.equal(directorUnitOf({ plan: { units: [] }, direction: null }, 'g001'), null);
});

test('副标题取得到真值：剧本行数 / 资源清单 / 执行细节把计划与索引合起来报', () => {
  const g = buildGraph(makeSnapshot({ n: 2 }));
  const story = g.nodes.find((x) => x.id === 'stage:story');
  const detail = g.nodes.find((x) => x.id === 'stage:detail');
  const assetsN = g.nodes.find((x) => x.id === 'stage:assets');
  assert.equal(story.data.subtitle, '2 行');
  // 清单规模（只报非零类别）：夹具里 1 角色 1 场景，没有造型与道具
  assert.equal(assetsN.data.subtitle, '1 角色 · 1 场景');
  assert.equal(detail.data.subtitle, '2 单元 · 21.4s · 索引 2 镜');
});

test('fmtSec：没有值给破折号，不做假数据', () => {
  assert.equal(fmtSec(5.17), '5.2s');
  assert.equal(fmtSec(null), '—');
  assert.equal(fmtSec(undefined), '—');
  assert.equal(fmtSec('abc'), '—');
});
