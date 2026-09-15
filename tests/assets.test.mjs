#!/usr/bin/env node
/**
 * assets.test.mjs — 阶段③「双层资产」的验收（**不联网、不烧卡**）。
 *
 * 验收的不是"图好不好看"（那要靠人眼），而是**配方对不对**：
 *   - 肖像里有脸、有年龄、正面灰底，**没有服装**、**没有风格圣经**
 *   - 身份图一次出 4 面板、以肖像为参考、写明"只允许视角变化"
 *   - 场景主图**带风格圣经**、**明确禁人**
 *   - 道具图有正/侧/背、白底、无人、禁字
 *   - 关键帧用的是**身份图**（不是肖像），且标记已被展开
 *
 * 这些全是纯函数，所以能断言；断言得住，才谈得上"出图"。
 *
 *   node tests/assets.test.mjs <board.json>
 */

import fs from 'node:fs';
import {
  assetPlan, portraitPrompt, sheetInstruction, sheetRefs,
  masterPrompt, propPrompt, keyframeRefs, keyframeInstruction,
  shotPrompt, expandMarkers, h3Prompt, speakerIds,
} from '../src/assets.mjs';

let passed = 0;
const failures = [];
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`FAIL   ${label}${detail ? '  → ' + detail : ''}`); }
}

const file = process.argv[2] || 'E:/AI-Tool/DeepSeek/story2video/examples/dashixiong.literal.json';
const board = JSON.parse(fs.readFileSync(file, 'utf8'));

// 放一个有辨识度的标记进风格圣经，用来看它有没有污染到不该去的地方
const STYLE_MARK = '【风格圣经标记】';
board.meta.style_prompt = `${STYLE_MARK}古风仙侠，青绿与暖阳金`;

console.log('\n资产配方');
console.log(`  板子：${board.characters.length} 角色 / ${board.identities.length} 造型 / ${board.scenes.length} 场景 / ${(board.props || []).length} 道具`);

// ---------- 一、计划完整性 ----------
const plan = assetPlan(board);
const byKind = (k) => plan.filter((p) => p.kind === k);
check('每个角色一张肖像', byKind('portrait').length === board.characters.length, String(byKind('portrait').length));
check('每个造型一张身份图', byKind('sheet').length === board.identities.length, String(byKind('sheet').length));
check('每个场景至少一张主图', byKind('master').length === board.scenes.length, String(byKind('master').length));
// 反向图 / 平面图**默认不生成** —— 全工程没有任何东西消费它们（复盘时发现的死资产）。
// 它们只在 `--with-scene-extras` 时才进计划。
check('**默认不生成死资产**（反向图 / 平面图）',
  byKind('reverse_master').length === 0 && byKind('spatial_layout').length === 0,
  `反向 ${byKind('reverse_master').length} / 平面 ${byKind('spatial_layout').length}`);
const planX = assetPlan(board, { sceneExtras: true });
check('开了 --with-scene-extras 才有三件套',
  planX.filter((p) => p.kind === 'reverse_master').length === board.scenes.length
  && planX.filter((p) => p.kind === 'spatial_layout').length === board.scenes.length);
check('每个道具一张三视图', byKind('prop_3view').length === (board.props || []).length, String(byKind('prop_3view').length));
check('肖像排在身份图之前（身份图要用它当 anchor）',
  plan.findIndex((p) => p.kind === 'portrait') < plan.findIndex((p) => p.kind === 'sheet'));
check('每一项都有 why（说得出为什么要它）', plan.every((p) => p.why && p.why.length > 4));

// ---------- 二、肖像：脸是锚，不能带服装和风格 ----------
console.log('\n肖像（脸部锚点）');
// 用一个可辨识的服装词去探：它**绝不能**漏进肖像提示词。
// （注意不能拿"衣/装"两个字面去扫 —— 提示词里本来就有"只穿素色上衣""不出现任何服装细节"，
//   那是对的，扫字面会误报。要靠注入标记来验性质。）
const probeBoard = structuredClone(board);
probeBoard.identities = probeBoard.identities.map((x) => ({ ...x, appearance_details: `【服装标记】${x.appearance_details}` }));
for (const c of board.characters) {
  const p = portraitPrompt(board, c);
  check(`${c.id}：含年龄`, p.includes(c.age_group) || /儿童|青年|中年|老年/.test(p));
  check(`${c.id}：含脸部描述`, p.includes(c.face_prompt.slice(0, 8)));
  check(`${c.id}：正面 + 脸占 60-70% + 灰底`, /正面朝向/.test(p) && /60-70%/.test(p) && /灰底/.test(p));
  check(`${c.id}：**不带风格圣经**（否则会被成片色调拖走）`, !p.includes(STYLE_MARK), p.slice(0, 60));
  const pc = probeBoard.characters.find((x) => x.id === c.id);
  const pp = portraitPrompt(probeBoard, pc);
  check(`${c.id}：**服装描述不漏进肖像**（服装属于造型层）`, !pp.includes('【服装标记】'), pp.slice(0, 80));
  check(`\${c.id}：明确禁服装细节`, /服装细节/.test(p));
  check(`${c.id}：**带族裔锚点**（没有它，模型会默认画成白人）`, /东亚|East Asian/.test(p), p.slice(0, 60));
}

// ---------- 三、身份图：4 面板 + 以肖像为参考 ----------
console.log('\n身份图（4 面板，一次出）');
for (const x of board.identities) {
  const ins = sheetInstruction(board, x);
  check(`${x.id}：四个面板都点到`, ['Panel1', 'Panel2', 'Panel3', 'Panel4'].every((k) => ins.includes(k)));
  check(`${x.id}：写明"只允许视角变化"`, /只允许视角变化/.test(ins));
  check(`${x.id}：声明"参考图只锁脸、衣着听文字"（否则会继承肖像那件素色上衣）`, /参考图只用于锁定长相/.test(ins));
  check(`${x.id}：带该造型的服装描述`, ins.includes(x.appearance_details.slice(0, 6)));
  check(`${x.id}：**禁止把文字烧进画面**（烧进去会污染关键帧）`, /不许出现任何文字/.test(ins));
  check(`${x.id}：身份图也带风格锚点`, /写实实拍|2D 赛璐璐/.test(ins));
  const refs = sheetRefs(board, x);
  // 注意：这一步在真实流程里要等肖像出完才有值；配方层只保证"参考图取自角色肖像槽位"
  check(`${x.id}：参考图取自角色的肖像槽位`, refs.length === 0 || /portrait/.test(refs[0]), refs[0] || '(肖像还没出)');
}

// ---------- 四、场景：带风格圣经 + 禁人 ----------
console.log('\n场景');
for (const s of board.scenes) {
  const p = masterPrompt(board, s);
  check(`${s.id}：主图**带**风格圣经`, p.includes(STYLE_MARK));
  check(`${s.id}：主图明确禁人`, /没有任何人/.test(p));
  check(`${s.id}：主图禁临时道具（否则它就不是"这个地方"了）`, /临时道具/.test(p));
  for (const c of board.characters) {
    if (p.includes(c.name)) { check(`${s.id}：主图里不该出现角色名 ${c.name}`, false, p); }
  }
}

// ---------- 五、道具 ----------
console.log('\n道具');
for (const pr of board.props || []) {
  const p = propPrompt(pr);
  check(`${pr.id}：正/侧/背三视图`, /正面/.test(p) && /侧面/.test(p) && /背面/.test(p));
  check(`${pr.id}：白底静物`, /白/.test(p) && /静物|产品/.test(p));
  check(`${pr.id}：无人、禁可读文字`, /没有任何人物/.test(p) && /可读文字/.test(p));
}

// ---------- 六、关键帧：用身份图 + 标记展开 ----------
console.log('\n关键帧');
const shot = board.shots.find((s) => (s.cast || []).length && (s.dialogue || []).length) || board.shots[1];
const { refs, series } = keyframeRefs(board, shot);
check(`关键帧参考图用了**身份图**（不是肖像）`,
  refs.length === 0 || refs.every((r) => !/portrait/.test(r)),
  refs.join(' | '));
check(`参考图不超过 3 张（Qwen-Image-Edit 上限）`, refs.length <= 3, String(refs.length));

const ins = keyframeInstruction(board, shot, series);
check('关键帧指令里没有裸标记', !/\{\{|\[\[/.test(ins), ins.slice(0, 80));
check('关键帧指令含景别与运镜', ins.includes(shot.shot_size) && ins.includes(shot.camera));

const finalP = shotPrompt(board, shot);
check('最终提示词里标记已全部展开', !/\{\{|\[\[/.test(finalP), finalP.slice(0, 100));
check('展开后带上了服装描述',
  (shot.cast || []).length === 0 || board.identities.filter((x) => (shot.cast || []).includes(x.id))
    .every((x) => finalP.includes(x.appearance_details.slice(0, 5))));

// ---------- 七、展开函数本身 ----------
console.log('\n标记展开');
const fake = { identities: [{ id: 'a_b', character: 'a', appearance_details: '红袍' }], characters: [{ id: 'a', name: '甲' }], props: [{ id: 'p1', description: '青铜剑' }] };
check('{{id}} → 名字+服装', expandMarkers(fake, { prompt: '{{a_b}}站着' }).includes('甲，红袍'));
check('[[id]] → 道具描述', expandMarkers(fake, { prompt: '握着[[p1]]' }).includes('青铜剑'));
check('未知 id 不炸', expandMarkers(fake, { prompt: '{{nobody}}' }) === 'nobody');

console.log('\nH3 官方提示词格式');
{
  const withDialogue = board.shots.filter((s) => (s.dialogue || []).length);
  const spoken = withDialogue.find((s) => (s.dialogue || [])[0].kind !== 'voiceover');
  const vo = withDialogue.find((s) => (s.dialogue || [])[0].kind === 'voiceover');
  const silent = board.shots.find((s) => !(s.dialogue || []).length);
  const p = h3Prompt(board, spoken);

  // ① I2VA 对齐指令 —— 官方固定句式，缺了首帧锁不牢
  check('**带 I2VA 对齐指令**（官方固定句式）',
    /^For the target video, at 0\.00 seconds into the target video, <Picture 1> \(from \[Shot 1\]\) is fully referenced\./.test(p),
    p.split('\n')[0].slice(0, 70));

  // ② 台词必须包在 <d>[语言] …</d> 里 —— **这是字幕 bug 的正主**
  check('**台词包在 `<d>[Chinese] …</d>` 里**（没有它模型会把对白画成画面文字）',
    /<d>\[Chinese\] .+<\/d>/.test(p), (p.match(/<d>.{0,40}/) || ['（没找到 <d>）'])[0]);
  check('台词逐字保留（不翻译不改写）', spoken.dialogue.some((d) => p.includes(d.text)));

  // ③ 台词**不能**出现在 overall_soundscape 里 —— 官方明令禁止
  const soundscape = p.split('overall_soundscape:')[1].split('\n')[0];
  check('**overall_soundscape 里没有台词**（官方禁止重复）',
    spoken.dialogue.every((d) => !soundscape.includes(d.text.slice(0, 8))),
    soundscape.trim().slice(0, 50));

  // ④ 说话者有稳定 ID
  check('**说话者带稳定 ID `(S1)`/`(S2)`**', /\(S\d\)/.test(p), (p.match(/\(S\d\)/) || [''])[0]);
  check('同一角色的 ID 跨镜头不变', (() => {
    const a = (h3Prompt(board, spoken).match(/\(S\d\)/) || [])[0];
    const same = withDialogue.filter((s) => s.dialogue[0].character === spoken.dialogue[0].character)
      .map((s) => (h3Prompt(board, s).match(/\(S\d\)/) || [])[0]);
    return a && same.every((x) => x === a);
  })(), JSON.stringify([...speakerIds(board)]));

  // ⑤ 画外音用官方固定短语 + "嘴唇不动"
  if (vo) {
    const vp = h3Prompt(board, vo);
    check('**画外音用官方固定短语** says in an off-screen voiceover',
      /says in an off-screen voiceover:/.test(vp));
    check('画外音紧跟一句"嘴唇不动"', /嘴唇始终完全闭合|lips remain/.test(vp));
  }

  // ⑥ 屏上文字是"显式声明制" —— 不写就不会有，所以绝不能写否定句
  check('**不写"不要出现字幕"这类否定句**（实测反而更容易画出来）',
    !/不要.{0,4}字幕|不出现.{0,4}文字|画面干净/.test(p));

  // ⑦ 三段字段齐全，顺序固定
  const order = ['integrated_multimodal_description:', 'overall_soundscape:', 'non_diegetic_music:']
    .map((m) => p.indexOf(m));
  check('三段字段齐全且顺序正确', order.every((i) => i >= 0) && order[0] < order[1] && order[1] < order[2], JSON.stringify(order));
  check('没有台词时也不编台词', (() => {
    const sp = h3Prompt(board, silent);
    return !/<d>/.test(sp) && /overall_soundscape:/.test(sp);
  })());
}

console.log('\n' + '─'.repeat(56));
if (failures.length) {
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项：`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log(`全部通过（${passed} 项）—— 配方可断言，出图前就知道对不对`);
}
