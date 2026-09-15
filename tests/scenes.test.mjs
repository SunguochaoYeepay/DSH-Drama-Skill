#!/usr/bin/env node
/**
 * scenes.test.mjs — 场次正则解析的验收（不需要 LLM）。
 *
 * 剧本的场次头是格式化的，正则该认全；认不出来时要**返回空**而不是瞎猜。
 *
 *   node tests/scenes.test.mjs
 */

import { parseScenes, sceneMenu } from '../src/parse-scenes.mjs';

let passed = 0;
const failures = [];
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`FAIL   ${label}${detail ? '  → ' + detail : ''}`); }
}

console.log('\n场次解析');

// ① 标准短剧格式
const s1 = `
第1集

1-1　【清晨】【外】林间古道

小师妹：（追上去）大师兄，昨天晚上，谢谢你救了我。
大师兄：举手之劳，不用谢。

1-2　【夜】【内】客栈房间

小师妹：我一点都不记得了。
大师兄：你已经昏死过去了。

第2集

2-1　【黄昏】【外】山道

小师妹：你要对我负责！
`;
const r1 = parseScenes(s1);
check('认出 3 个场次', r1.scenes.length === 3, `实际 ${r1.scenes.length}`);
check('第 1 场是清晨/外景', r1.scenes[0]?.time_of_day === '清晨' && r1.scenes[0]?.interior_exterior === '外', JSON.stringify(r1.scenes[0] || {}));
check('第 2 场是夜晚/内景', r1.scenes[1]?.time_of_day === '夜晚' && r1.scenes[1]?.interior_exterior === '内', JSON.stringify(r1.scenes[1] || {}));
check('集号归属正确（1,1,2）', r1.scenes.map((s) => s.episode).join(',') === '1,1,2', r1.scenes.map((s) => s.episode).join(','));
check('场次号归属正确（1,2,1）', r1.scenes.map((s) => s.scene_no).join(',') === '1,2,1', r1.scenes.map((s) => s.scene_no).join(','));
check('场景名取到了', r1.scenes[0]?.location.includes('林间古道'), r1.scenes[0]?.location);
check('出场人物回填了', r1.scenes[0]?.characters.includes('小师妹') && r1.scenes[0]?.characters.includes('大师兄'), JSON.stringify(r1.scenes[0]?.characters));
check('第 2 场人物与第 1 场分开', !r1.scenes[1]?.characters.includes('旁白'), JSON.stringify(r1.scenes[1]?.characters));
check('episode_count = 2', r1.episode_count === 2, String(r1.episode_count));

// ② 「地点：」标签格式
const s2 = `
场次1
地点：废弃的社区球场
时间：傍晚
【外】

旁白：拆迁前最后一天。
`;
const r2 = parseScenes(s2);
check('认出「地点：」格式', r2.scenes.length === 1 && r2.scenes[0].location === '废弃的社区球场', JSON.stringify(r2.scenes[0] || {}));
check('「傍晚」归一成黄昏', r2.scenes[0]?.time_of_day === '黄昏', r2.scenes[0]?.time_of_day);

// ③ 中文集号
const r3 = parseScenes('第三集\n\n3-1　【内】【白天】大殿\n\n甲：在。\n');
check('中文集号「第三集」认得出', r3.scenes[0]?.episode === 3, String(r3.scenes[0]?.episode));
check('白天归一正确', r3.scenes[0]?.time_of_day === '白天', r3.scenes[0]?.time_of_day);

// ④ 不是剧本就返回空，不许瞎猜
const r4 = parseScenes('有一天小明去公园玩，他遇到了小红。他们聊了很久。');
check('非剧本文本返回空（不瞎猜）', r4.scenes.length === 0 && r4.looks_like_screenplay === false, `认出 ${r4.scenes.length} 场`);

// ⑤ 真实剧本的复合头格式（「标准分镜版」）—— 这条例最该锁住，它是实战格式
const s5 = `短剧剧本：大师兄的离谱负责（标准分镜版）

风格：古风仙侠、轻甜搞笑
时长：2分钟左右

人物设定
大师兄：清冷靠谱、钢铁直男
小师妹：灵动傲娇、脸皮薄

第 1 集 1-1 场景：外 林间古道 清晨 人物：大师兄、小师妹

△ 清晨林间古道，阳光穿透枝叶洒落，大师兄背负长剑独自前行。

小师妹（语气温软）：大师兄，昨天晚上，谢谢你救了我。

△ 大师兄目视前方，步伐未停。

大师兄（语气平淡）：举手之劳，不用谢。把我救你耗用的材料补给我就行。

小师妹（语气闷闷）：……好嘛。

第 2 集 2-1 场景：内 客栈房间 夜晚 人物：小师妹

小师妹（压低嗓音）：你千万不要跟别人说。
`;
const r5 = parseScenes(s5);
check('复合头：认出 2 场', r5.scenes.length === 2, `实际 ${r5.scenes.length}`);
check('复合头：场景名取到「林间古道」', r5.scenes[0]?.location === '林间古道', r5.scenes[0]?.location);
check('复合头：时间「清晨」', r5.scenes[0]?.time_of_day === '清晨', r5.scenes[0]?.time_of_day);
check('复合头：内外「外」', r5.scenes[0]?.interior_exterior === '外', r5.scenes[0]?.interior_exterior);
check('复合头：人物从「人物：」标签取到', r5.scenes[0]?.characters.join(',') === '大师兄,小师妹', JSON.stringify(r5.scenes[0]?.characters));
check('复合头：第 2 场是 内/夜晚', r5.scenes[1]?.interior_exterior === '内' && r5.scenes[1]?.time_of_day === '夜晚', JSON.stringify(r5.scenes[1] || {}));
check('复合头：集号 1、2 归属正确', r5.scenes.map((s) => s.episode).join(',') === '1,2', r5.scenes.map((s) => s.episode).join(','));
check('复合头：△ 动作行没被当成场次', r5.scenes.length === 2, `实际 ${r5.scenes.length}`);

// ⑥ 菜单形态
const menu = sceneMenu(r1);
check('菜单带稳定 id', menu.every((m) => /^scene_\d{2}$/.test(m.id)), JSON.stringify(menu.map((m) => m.id)));
check('菜单保留了原文行（可溯源）', menu[0].source_line.includes('林间古道'), menu[0].source_line);

console.log('\n' + '─'.repeat(56));
if (failures.length) {
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项：`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log(`全部通过（${passed} 项）—— 场次能被确定性解析，认不出时不瞎猜`);
}
