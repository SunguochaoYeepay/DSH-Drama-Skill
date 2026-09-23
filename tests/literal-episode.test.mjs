import assert from 'node:assert/strict';
import test from 'node:test';
import { compileLiteral } from '../src/literal.mjs';

/**
 * 集数（`第 1 集 1-1 场景：…` 里的**第一个** 1）：`parse-scenes` 一直解析得出来，
 * 但 `compileLiteral` 过去只搬了 `scene_no`，把集数丢在解析器里 —— 多集剧本的
 * `scene_no` 会跨集重号（1-1 与 2-1 的 scene_no 都是 1），看板因此既无法按集分组，
 * 也无法把「第 N 集 M-M」还原给人看。2026-09-23 补回。
 */
function seed(source) {
  return {
    meta: { title: '集数探针', project: 'episode_probe', logline: '这一部只用来验集数', aspect: '9:16', style: 'realistic' },
    story: {
      synopsis: '这是一段用于验证集数是否落进板子的概述，至少需要二十个字符才满足契约。',
      beats: [{ text: '第一拍', purpose: '起因' }, { text: '第二拍', purpose: '结果' }],
      source,
    },
    characters: [{ id: 'awei', name: '阿伟', age_group: 'youth', face_prompt: '东亚男性，方脸，短发' }],
    identities: [{ id: 'awei_default', character: 'awei', name: '常服', appearance_details: '深色夹克与长裤' }],
    // 故意不提供 scenes：让 literal 按剧本现造 —— 那正是写 episode 的那条分支
    scenes: [],
    props: [],
    shots: [],
  };
}

test('两集剧本：场景同时记住 episode 与 scene_no（跨集重号也分得开）', async () => {
  const source = [
    '短剧剧本：集数探针',
    '风格：写实',
    '时长：约 12 秒',
    '',
    '人物设定',
    '阿伟：末班车司机',
    '',
    '第 1 集 1-1 场景：内 末班公交车厢 夜 人物：阿伟',
    '△ 雨刷来回摆动，车厢空荡。',
    '第 1 集 1-2 场景：外 雨夜路口 夜 人物：阿伟',
    '△ 公交车在路口停下。',
    '第 2 集 2-1 场景：内 末班公交车厢 夜 人物：阿伟',
    '△ 他又坐回驾驶座。',
    '',
    '（完）',
    '',
  ].join('\n');
  const { board } = await compileLiteral(seed(source));
  assert.deepEqual(
    board.scenes.map((s) => [s.episode, s.scene_no]),
    [[1, 1], [1, 2], [2, 1]],
    '集数与场次号都要落到板子上；同一场次名在前两集里出现也要各算一场',
  );
  assert.equal(new Set(board.scenes.map((s) => s.id)).size, 3, '跨集重名的场次也要各有独立 id');
});

test('没有集号的剧本：episode 落成 1（不是 null），显示时不必画集数', async () => {
  const source = [
    '短剧剧本：单集探针',
    '风格：写实',
    '时长：约 8 秒',
    '',
    '人物设定',
    '阿伟：末班车司机',
    '',
    '1-1 场景：内 房间 夜 人物：阿伟',
    '△ 他坐在床边。',
    '1-2 场景：外 街道 夜 人物：阿伟',
    '△ 他走进夜色里。',
    '',
    '（完）',
    '',
  ].join('\n');
  const { board } = await compileLiteral(seed(source));
  assert.deepEqual(board.scenes.map((s) => [s.episode, s.scene_no]), [[1, 1], [1, 2]]);
});

test('Brief 里显式写过的 episode 不被剧本覆盖', async () => {
  const s = seed([
    '短剧剧本：显式集数',
    '风格：写实',
    '时长：约 6 秒',
    '',
    '人物设定',
    '阿伟：末班车司机',
    '',
    '第 3 集 3-1 场景：内 房间 夜 人物：阿伟',
    '△ 他坐在床边。',
    '',
    '（完）',
    '',
  ].join('\n'));
  s.scenes = [{ id: 'room_night', name: '房间', scene_no: 1, episode: 7, environment: '一个用于测试的最小空间描述。' }];
  const { board } = await compileLiteral(s);
  assert.equal(board.scenes[0].episode, 7, '显式值优先：剧本只是事实源，不是覆盖者');
});
