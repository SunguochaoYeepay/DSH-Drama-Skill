#!/usr/bin/env node
/**
 * compiler.test.mjs — 编译器确定性层的验收（不需要 LLM）。
 *
 * 模型总会手滑：年龄写「青年」、服装写进角色、造型挂名字不挂 id、
 * 服装字段漏进角色对象、镜头写 characters 不写 cast、时间写「卯时」。
 *
 * **这些不该靠提示词求它记住** —— 那是代码的事。这个测试喂一份「脏」的模型输出，
 * 断言补强层把它整理干净，而且**该报的错照样报**（不许把错误也抹平）。
 *
 *   node tests/compiler.test.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkBoard, normalizeIdentities, normalizeBeats } from '../src/board.mjs';

let passed = 0;
const failures = [];
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`FAIL   ${label}${detail ? '  → ' + detail : ''}`); }
}

/** 一份故意写脏的「模型输出」。 */
function messy() {
  return {
    meta: {
      title: '大师兄的离谱负责',
      logline: '小师妹因被救而要求大师兄负责，没想到直男理解的负责是赔钱',
      genre: '古风喜剧',
      language: 'zh-CN',
      aspect: '16:9',
      style: 'realistic',
      total_duration_s: 5,
      stage: 'shots',
      approvals: { story: { at: 'x', by: '用户' }, shots: null, assets: null, keyframes: null },
    },
    story: {
      synopsis: '清晨林间，小师妹追上大师兄道谢，并羞怯地提起昨晚之事，大师兄却只关心材料费是否结清。',
      // 脏：beats 是字符串，没有 purpose
      beats: ['小师妹追上大师兄', '她羞怯提起昨晚之事'],
      tone: '轻喜剧',
      ending: '两人各怀心思',
    },
    characters: [
      // 脏：年龄自由文本、face_prompt 空、服装和旧字段留在角色上
      { id: 'senior_brother', name: '大师兄', age_group: '青年', face_prompt: '', appearance: '清冷俊美，黑发束冠', wardrobe: '白色古装长衫，腰间佩剑' },
      // 脏：一个造型都没有
      { id: 'junior_sister', name: '小师妹', age_group: 'youth', face_prompt: '圆脸杏眼，长发挽髻' },
    ],
    identities: [
      // 脏：character 填的是名字不是 id；没有 junior_sister 的造型
      { id: 'senior_brother_white', character: '大师兄', name: '常服', appearance_details: '白色古装长衫，腰间佩剑' },
    ],
    scenes: [
      // 脏：时间用了别名
      { id: 'forest_path', name: '林间古道', environment: '清晨森林青石板路，阳光穿过树叶', time_of_day: '卯时' },
    ],
    props: [{ id: 'sword', name: '长剑', description: '青锋长剑，剑鞘有铜纹' }],
    shots: [
      {
        id: 's01', scene: 'forest_path',
        characters: ['senior_brother'],   // 脏：写的是 characters
        duration_s: 5, shot_size: '全景', lighting: '晨光斜射',
        camera: '缓慢前推', action: '大师兄独自走在青石板路上',
        prompt: '大师兄走在前面', audio: '布鞋踩在石板上的声音',
        dialogue: [{ character: 'senior_brother', text: '师妹，材料费结一下。' }],
        edit_note: '开场', transition: { type: 'cut' },
      },
      {
        id: 's02', scene: 'forest_path',
        cast: ['senior_brother_white'],
        duration_s: 4, shot_size: '近景', lighting: '柔和',
        camera: '固定',
        action: '他停下脚步',
        // 脏：出现备选表达 —— 这个必须仍然报错，不许被补强层抹平
        prompt: '{{senior_brother_white}}停下脚步，站在前面或者后面',
        audio: '脚步声停止', dialogue: [],
        edit_note: '反应', transition: { type: 'cut' },
      },
    ],
  };
}

console.log('\n编译器确定性层');

const b = messy();
const notes = normalizeIdentities(b);
check('补强层报告了它改了什么', notes.length >= 5, `${notes.length} 条`);
for (const n of notes) console.log(`       · ${n}`);
b.story.beats = normalizeBeats(b.story);

check('年龄「青年」被归一成枚举', b.characters[0].age_group === 'youth', `实际 ${b.characters[0].age_group}`);
check('空的 face_prompt 被 appearance 顶上', b.characters[0].face_prompt.includes('清冷俊美'));
check('角色身上的 wardrobe 已清掉', !('wardrobe' in b.characters[0]));
check('服装挪到了造型层', b.identities[0].appearance_details.includes('白色古装长衫'));
check('造型的 character 从名字修正成 id', b.identities[0].character === 'senior_brother');
check('没有造型的角色被补了一个默认造型', b.identities.some((x) => x.character === 'junior_sister' && x.id === 'junior_sister_default'));
check('characters[].identities 与 identities[] 双向一致',
  b.characters.every((c) => c.identities.length > 0 && c.identities.every((id) => b.identities.some((x) => x.id === id && x.character === c.id))));
check('镜头的 characters 被映射成 cast', Array.isArray(b.shots[0].cast) && b.shots[0].cast.length === 1 && !('characters' in b.shots[0]));
check('台词的角色被映射成造型 id', b.shots[0].dialogue[0].character === b.shots[0].cast[0]);
check('台词补了 kind', b.shots[0].dialogue[0].kind === 'spoken');
check('时间「卯时」被归一', b.scenes[0].time_of_day === '清晨', `实际 ${b.scenes[0].time_of_day}`);
check('beats 被整理成对象且带 purpose', b.story.beats.every((x) => x.text && x.purpose));

console.log('\n但该报的错照样报：');
const { errors } = checkBoard(b, { inject: true });
// 这条既验证「或者」被拒，也验证「格式错和语义错会一次报全」——
// 早退的实现在这里会只报「prompt 太短」而不报「备选表达」，模型就得改两轮。
check('「或者」被拒', errors.some((e) => e.includes('备选表达')), errors.slice(0, 3).join(' | '));
check('格式错与语义错同时报出（一轮改完）',
  errors.some((e) => e.includes('太短')) && errors.some((e) => e.includes('备选表达')),
  errors.slice(0, 3).join(' | '));
check('补强后没有结构类错误', !errors.some((e) => /不在 identities 里|双向一致|不在 characters 里/.test(e)));

console.log('\n' + '─'.repeat(56));
if (failures.length) {
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项：`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log(`全部通过（${passed} 项）—— 补强层能整理脏输出，但不抹平真正的错误`);
}
