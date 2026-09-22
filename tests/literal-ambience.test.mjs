import assert from 'node:assert/strict';
import test from 'node:test';
import { compileLiteral } from '../src/literal.mjs';

/**
 * 索引镜头的音效是代码从场景/动作文本里**猜**出来的 —— 词表必须是词，不能是单字。
 *
 * 依据（desk_quake 2026-09-22 实测）：场景名「**林**薇工位」（开放式办公区）被 `/林/` 命中，
 * 那条索引镜头拿到了「树叶摩擦的沙沙声与踩在石板路上的脚步声」；而这个字段会被
 * `src/h3-prompt.mjs` 拼进视频提示词的 `overall_soundscape`。中文人名/地名里「林」「山」都是常见姓。
 */
function seedFor(location, action) {
  const source = [
    '短剧剧本：音效词表探针',
    '风格：写实',
    '时长：约 5 秒',
    '类型：测试',
    '',
    '人物设定',
    '林薇：测试用角色，黑色长直发',
    '',
    `第 1 集 1-1 场景：内 ${location} 白天 人物：林薇`,
    `△ ${action}`,
    '',
    '（完）',
    '',
  ].join('\n');
  return {
    meta: {
      title: '音效词表探针', project: 'ambience_probe', logline: '这一部只用来验音效词表',
      aspect: '9:16', style: 'realistic',
    },
    story: {
      synopsis: '这是一段用于验证音效词表的最小故事概述，至少需要二十个字符才满足契约要求。',
      beats: [
        { text: '第一拍：她坐下', purpose: '建立场景' },
        { text: '第二拍：她开始做事', purpose: '给出动作' },
      ],
      source,
    },
    characters: [{ id: 'lin_wei', name: '林薇', age_group: 'youth', face_prompt: '东亚女性，鹅蛋脸，黑色长直发' }],
    identities: [{ id: 'lin_wei_default', character: 'lin_wei', name: '常服', appearance_details: '米白色针织衫与深灰色长裤' }],
    scenes: [{ id: 'probe_scene', name: location, scene_no: 1, time_of_day: '白天', environment: '一个用于测试的最小空间描述，够六个字。' }],
    props: [],
    shots: [],
  };
}

test('场景名里带「林」的办公区不会被判成林地音效', async () => {
  const { board } = await compileLiteral(seedFor('林薇工位', '她坐在工位前敲键盘。'));
  const audio = board.shots.map((s) => s.audio).join(' | ');
  assert.doesNotMatch(audio, /树叶摩擦/, `办公区不该出现林地音效，实际：${audio}`);
});

test('真正的林地场景仍然拿得到林地音效（词表收紧不等于功能丢失）', async () => {
  const { board } = await compileLiteral(seedFor('林间古道', '她沿着古道往前走。'));
  const audio = board.shots.map((s) => s.audio).join(' | ');
  assert.match(audio, /树叶摩擦/, `林地场景应当保留林地音效，实际：${audio}`);
});
