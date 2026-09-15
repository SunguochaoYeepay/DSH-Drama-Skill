#!/usr/bin/env node
/**
 * score.test.mjs — 阶段④「候选池逐维打分」的验收（**不联网、不烧卡**）。
 *
 * 打分本身要调模型，但**判据不该调模型才说得清**：
 *   - 提示词必须点名维度、必须要求 JSON、必须鼓励给低分
 *   - 解析必须能吃下模型偶尔包的围栏和解释
 *   - 挑选必须**先看"过不过"，再看总分** —— 不然会出现"脸 3 分但构图 10 分"当选
 *   - 全不过时不能卡死，要给一个 provisional 的
 *
 *   node tests/score.test.mjs
 */

import {
  buildScorePrompt, parseScore, passes, pickBest, PASS_FACE, PASS_CLOTHING,
} from '../src/score.mjs';

let passed = 0;
const failures = [];
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`FAIL   ${label}${detail ? '  → ' + detail : ''}`); }
}

console.log('\n打分提示词');

const idp = buildScorePrompt('identity', { face: '清冷俊美', costume: '白色长衫' });
check('身份图：点名 face_score', idp.includes('face_score'));
check('身份图：点名 clothing_score', idp.includes('clothing_score'));
check('身份图：要面板数', idp.includes('panels'));
check('身份图：查族裔', idp.includes('region_ok'));
check('身份图：查有没有把字烧进图', idp.includes('has_baked_text'));
check('身份图：查 critical', idp.includes('critical'));
check('身份图：带上了期望的脸', idp.includes('清冷俊美'));
check('身份图：带上了期望的服装', idp.includes('白色长衫'));
check('要求 JSON', /只输出一个 JSON/.test(idp));
check('**鼓励给低分**（否则模型一路给 8 分，打分就白打了）', /敢给低分/.test(idp));

const kp = buildScorePrompt('keyframe', { action: '抱球走过草地', shot_size: '全景', cast: '男孩' });
check('关键帧：点名 face/clothing/framing', ['face_score', 'clothing_score', 'framing_score'].every((k) => kp.includes(k)));
check('关键帧：查动作对不对得上', kp.includes('action_match'));
check('关键帧：带上了动作', kp.includes('抱球走过草地'));

const sp = buildScorePrompt('scene', { environment: '黄昏球场' });
check('场景：点名 match_score', sp.includes('match_score'));
check('场景：查该禁人的场景里有没有人', sp.includes('empty_ok'));
check('场景：也带上了 JSON 要求', /只输出一个 JSON/.test(sp));

console.log('\n解析（模型爱包围栏和解释）');
check('纯 JSON', parseScore('{"face_score": 8}')?.face_score === 8);
check('带围栏', parseScore('```json\n{"face_score": 8}\n```')?.face_score === 8);
check('带前后解释', parseScore('好的，我的评估是：{"face_score": 8, "note": "还行"} 以上。')?.face_score === 8);
check('嵌套对象不截断', parseScore('{"a": {"b": 1}, "c": 2}')?.c === 2);
check('字符串里的花括号不捣乱', parseScore('{"note": "他说 {不} 行", "face_score": 5}')?.face_score === 5);
check('垃圾输入返回 null', parseScore('完全不是 JSON') === null);

console.log('\n判据：脸 ≥ 7 且 衣 ≥ 7 且无 critical');
check('双 7 通过', passes({ face_score: 7, clothing_score: 7 }, 'keyframe'));
check('脸 6 不过', !passes({ face_score: 6, clothing_score: 9 }, 'keyframe'));
check('衣 6 不过', !passes({ face_score: 9, clothing_score: 6 }, 'keyframe'));
check('有 critical 一票否决', !passes({ face_score: 10, clothing_score: 10, critical: '性别错了' }, 'keyframe'));
check('身份图面板不够 4 个不过', !passes({ panels: 3, face_score: 9, clothing_score: 9 }, 'identity'));
check('身份图烧了字不过', !passes({ panels: 4, face_score: 9, clothing_score: 9, has_baked_text: true }, 'identity'));
check('身份图正常通过', passes({ panels: 4, face_score: 8, clothing_score: 8 }, 'identity'));
check('场景用 match_score 当脸维度', passes({ match_score: 8 }, 'scene'));

console.log('\n择优：先看"过不过"，再看总分');
const pool = [
  { path: 'a.png', score: { face_score: 3, clothing_score: 2, framing_score: 10 } },   // 总分 15，但脸崩了
  { path: 'b.png', score: { face_score: 7, clothing_score: 7, framing_score: 4 } },    // 总分 18，双 7 过线
  { path: 'c.png', score: { face_score: 9, clothing_score: 9, framing_score: 9 } },    // 最好
];
const best = pickBest(pool, 'keyframe');
check('选出的是真正合格的，不是总分最高的废图', best.path === 'c.png', String(best && best.path));
check('标记为已过线', best.provisional === false);

const bad = pickBest([
  { path: 'x.png', score: { face_score: 7, clothing_score: 6 } },
  { path: 'y.png', score: { face_score: 5, clothing_score: 8 } },
], 'keyframe');
check('全不过时也返回一个（不把流程卡死）', bad && bad.path === 'x.png', String(bad && bad.path));
check('但标明是 provisional', bad.provisional === true);

check('空池返回 null', pickBest([], 'keyframe') === null);
check('判据常量就是 7', PASS_FACE === 7 && PASS_CLOTHING === 7);

console.log('\n' + '─'.repeat(56));
if (failures.length) {
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项：`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log(`全部通过（${passed} 项）—— 判据可断言：脸和服装都得过线，且总分不能替它们说话`);
}
