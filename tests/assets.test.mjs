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
  shotPrompt, expandMarkers, styleAnchor, isHuman, wearsClothes,
} from '../src/assets.mjs';
import { FIXTURE, fixtureOrArg } from './fixtures/index.mjs';

let passed = 0;
const failures = [];
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`FAIL   ${label}${detail ? '  → ' + detail : ''}`); }
}

// 默认用**仓库内夹具**（随代码保存），命令行可覆盖成真实剧目的板子。
const file = fixtureOrArg(process.argv, 2, FIXTURE.board);
const board = JSON.parse(fs.readFileSync(file, 'utf8'));

// 放一个有辨识度的标记进风格圣经，用来看它有没有污染到不该去的地方
const STYLE_MARK = '【风格圣经标记】';
board.meta.style_prompt = `${STYLE_MARK}古风仙侠，青绿与暖阳金`;

/**
 * 灌入**确定性的合成资产路径**，专供"参考图从哪来"这一类断言。
 *
 * 参考图是从板子上的资产槽位解析的（`characters[].portrait` / `identities[].sheet` /
 * `scenes[].master` / `props[].ref_image`），而夹具是"配方层"的板子，
 * 这些槽位全是 `null`（真实流程在资产生成后回填）。
 *
 * 直接拿夹具跑，`keyframeRefs` 会解析出**空参考图集** —— 断言就退化成空转。
 * 原先这两条写成 `refs.length === 0 || …`，等于把空转兜住了：
 * **"紧景别用肖像、宽景别用身份图"这条规则从来没被验过。**
 *
 * 所以这里显式灌入路径。它们是**字符串**，不需要真实存在（解析只做匹配），
 * 但能让断言真的区分"紧景别拿到肖像"和"宽景别拿到身份图"。
 */
const ASSET = (kind, id) => `projects/demo/assets/${kind}_${id}.png`;
const refBoard = structuredClone(board);
for (const c of refBoard.characters) c.portrait = ASSET('portrait', c.id);
for (const x of refBoard.identities) x.sheet = ASSET('sheet', x.id);
for (const s of refBoard.scenes) s.master = ASSET('scene', s.id);
for (const p of refBoard.props || []) p.ref_image = ASSET('prop', p.id);

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
  const human = isHuman(c);
  // 族裔锚点 / 人类年龄档 / 素色上衣 —— 这三条**只对人类成立**。
  // 非人类卡司（猫/狗…）注入它们会把角色推向拟人化，所以反过来断言"不许出现"。
  if (human) {
    check(`${c.id}：含年龄`, p.includes(c.age_group) || /儿童|青年|中年|老年/.test(p));
    check(`${c.id}：**带族裔锚点**（没有它，模型会默认画成白人）`, /东亚|East Asian/.test(p), p.slice(0, 60));
    check(`${c.id}：明确禁服装细节`, /服装细节/.test(p));
  } else if (wearsClothes(board, c)) {
    // 🔁 穿衣的非人类（fat_cat 2026-09-20，超人装的猫）：肖像仍是脸锚，
    //    但不再断言「不穿任何衣物」——那是裸身配方的词，这只动物有服装。
    check(`${c.id}：非人类（穿衣）**四足、不拟人化、本图不表现服装**`,
      /四足动物/.test(p) && /不拟人化/.test(p) && /不表现服装/.test(p) && !/不穿任何衣物/.test(p), p.slice(0, 80));
  } else {
    check(`${c.id}：非人类**不带人类年龄档**`, !/儿童|青年|中年|老年/.test(p), p.slice(0, 60));
    check(`${c.id}：非人类**不带族裔锚点**（否则猫会被画成东亚人/拟人化）`, !/东亚|East Asian/.test(p), p.slice(0, 60));
    check(`${c.id}：非人类**点明四足、不穿衣、不拟人化**`,
      /四足动物/.test(p) && /不穿任何衣物/.test(p) && /不拟人化/.test(p), p.slice(0, 80));
  }
  check(`${c.id}：含脸部描述`, p.includes(c.face_prompt.slice(0, 8)));
  check(`${c.id}：正面 + 脸占 60-70% + 灰底`, /正面朝向/.test(p) && /60-70%/.test(p) && /灰底/.test(p));
  check(`${c.id}：**不带风格圣经**（否则会被成片色调拖走）`, !p.includes(STYLE_MARK), p.slice(0, 60));
  const pc = probeBoard.characters.find((x) => x.id === c.id);
  const pp = portraitPrompt(probeBoard, pc);
  check(`${c.id}：**服装描述不漏进肖像**（服装属于造型层）`, !pp.includes('【服装标记】'), pp.slice(0, 80));
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
  // 断言"带锚点"这件事本身，而不是锚点的具体措辞 ——
  // 原先写死 /写实实拍|2D 赛璐璐/，等于给 style 枚举加一个值就红一次。
  check(`${x.id}：身份图也带风格锚点`, ins.includes(styleAnchor(board)));
  // ---- 版面规则：**模型不会替你守版面，必须显式写死** ----
  // 来历：第一版只写了"4 个面板分别是什么"，没写怎么排 ——
  // 画幅用了 1:1 排不下，排成"上二下一大"，背景一格白一格灰。
  check(`${x.id}：**指定 16:9 横构图**（1:1 排不下 4 格）`, /16:9/.test(ins));
  check(`${x.id}：**指定只有一行、不许换行/2×2/上下堆叠**`,
    /只有一行/.test(ins) && /2×2/.test(ins) && /上下堆叠/.test(ins));
  check(`${x.id}：**四格等宽等高**`, /宽度完全相同/.test(ins) && /高度完全相同/.test(ins));
  check(`${x.id}：**人物在格内水平居中、脚踩同一水平线**`, /水平居中/.test(ins) && /同一条水平线/.test(ins));
  check(`${x.id}：**脚底和头顶都在格内、不裁切**`, /不裁切/.test(ins));
  check(`${x.id}：**四格背景统一**`, /四格背景统一/.test(ins));
  check(`${x.id}：Panel1 是 Panel2 头部的放大`, /Panel1 必须是 Panel2 头部的放大/.test(ins));
  check(`${x.id}：禁色标/边框/水印`, /色标/.test(ins) && /边框或水印/.test(ins));
  const refs = sheetRefs(refBoard, x);
  // 身份图的参考图必须取**该角色的肖像槽位**。
  // 这里原来写的是 `refs.length === 0 || /portrait/.test(refs[0])` —— 空参考图集直接算过。
  // 灌了资产路径之后就是硬判据：取不到肖像 = 身份图会脱离脸部锚点。
  check(`${x.id}：参考图取自角色的肖像槽位（取不到 = 身份图会脱离脸部锚点）`,
    refs.length > 0 && /portrait/.test(refs[0]), refs[0] || '(没解析出肖像)');
}

// ---------- 三之二、非人类卡司的身份图分支 ----------
// 夹具里两个角色都是人类，所以这条分支原先**没有任何断言** ——
// 结果非人类分支里残留了三处人类措辞（「四格人物高度一致」「五官、发型、领口」「其他人物」），
// 会把一只狗的身份图往拟人化/穿衣服的方向推。这几条断言就是钉住它。
//
// 🔁 非人类分两种（fat_cat 2026-09-20）：**裸身动物**（identity 描述里没有衣物词）
// 仍走「不穿衣」老配方；**穿衣动物**（超人装的猫——identity 描述里有衣物词）的服装
// 归 appearance_details 所有，配方不再说「不穿衣」，否则会把导演写的紧身衣+披风盖掉。
console.log('\n身份图（非人类分支）');
{
  const animalBoard = structuredClone(board);
  const ch = animalBoard.characters[0];
  ch.species = 'dog';
  const ident = animalBoard.identities.find((y) => y.character === ch.id);

  // 裸身动物：identity 描述里没有衣物词 → 老配方（不穿衣、不拟人化）必须保留
  const nakedBoard = structuredClone(animalBoard);
  const nakedIdent = nakedBoard.identities.find((y) => y.character === ch.id);
  nakedIdent.appearance_details = '金黄色短毛，背部深色斑纹，立耳，体型圆润';
  const insNaked = sheetInstruction(nakedBoard, nakedIdent);
  check('非人类（裸身）：不出现「人物」措辞', !/人物/.test(insNaked), insNaked.slice(0, 80));
  check('非人类（裸身）：不出现「发型／领口」等人类措辞', !/发型|领口/.test(insNaked), insNaked.slice(0, 80));
  check('非人类（裸身）：点明四足、不穿衣、不拟人化',
    /四足动物/.test(insNaked) && /不穿/.test(insNaked) && /不拟人化/.test(insNaked), insNaked.slice(0, 80));
  const pNaked = portraitPrompt(nakedBoard, nakedBoard.characters[0]);
  check('非人类（裸身）肖像：点明四足、不穿衣、不拟人化',
    /四足动物/.test(pNaked) && /不穿任何衣物/.test(pNaked) && /不拟人化/.test(pNaked), pNaked.slice(0, 80));

  // 穿衣动物：夹具角色的 identity 描述本身就是一身古装（长袍/外衫/软靴）→ 穿衣分支
  const ins = sheetInstruction(animalBoard, ident);
  check('非人类（穿衣）：不出现「人物」措辞', !/人物/.test(ins), ins.slice(0, 80));
  check('非人类（穿衣）：不出现「发型／领口」等人类措辞', !/发型|领口/.test(ins), ins.slice(0, 80));
  check('非人类（穿衣）：服装以 appearance_details 为准、不再说「不穿衣」',
    !/不穿衣|不穿任何衣物/.test(ins) && /服装一律以上面/.test(ins), ins.slice(0, 80));
  check('非人类（穿衣）：仍是四足动物、不直立、不拟人化',
    /四足动物/.test(ins) && /不直立/.test(ins) && /不拟人化/.test(ins), ins.slice(0, 80));
  const pClothed = portraitPrompt(animalBoard, animalBoard.characters[0]);
  check('非人类（穿衣）肖像：四足、不拟人化、本图不表现服装',
    /四足动物/.test(pClothed) && /不拟人化/.test(pClothed) && /不表现服装/.test(pClothed) && !/不穿任何衣物/.test(pClothed), pClothed.slice(0, 80));
  check('非人类：一致性改成毛色与斑纹，不是同一套服装',
    /同一身毛色与斑纹/.test(ins) && !/同一套服装/.test(ins), ins.slice(0, 80));
  check('人类：仍保留「人物」与「发型、领口」措辞（不能被改回归）',
    /人物/.test(sheetInstruction(board, board.identities[0])) && /发型、领口/.test(sheetInstruction(board, board.identities[0])));
}

// ---------- 四、场景：带风格圣经 + 禁人 ----------
console.log('\n场景');
for (const s of board.scenes) {
  const p = masterPrompt(board, s);
  check(`${s.id}：主图**带**风格圣经`, p.includes(STYLE_MARK));
  check(`${s.id}：主图明确禁人`, /没有人物|没有任何人/.test(p));
  // 实测：只写「没有任何人」时，猫片的场景主图正中是一只腾空跳起的橘猫；扩成
  // 「没有任何动物」后本地 Qwen 仍把猫画成主体。场景主图是空镜、要喂给全部关键帧，
  // 所以**卡司的每一个类别都必须被显式禁掉**，且要有正向的画面定义托底。
  check(`${s.id}：主图**也禁掉动物/宠物**（"人"这个字管不住一只猫）`,
    /没有动物/.test(p) && /没有宠物/.test(p));
  // 正向的画面定义要托底，但**场景类型不许写死在配方里** —— 上一版是
  // 「纯室内环境空镜：画面里只有房间本身 —— 家具、地面、灯光与陈设」，
  // 那是从一部室内猫片提炼的规则。户外场景（海滨栈道）拿到的是
  // 「午后海滨木栈道、海面泛白反光…纯室内环境空镜：画面里只有房间本身」，
  // 自相矛盾（干跑实测暴露）。场景类型归 `scene.environment` 拥有。
  check(`${s.id}：主图有**正向**的画面定义（全靠否定式压不住）`, /纯环境空镜/.test(p));
  check(`${s.id}：主图**不写死场景类型**（室内/户外由 scene.environment 拥有）`,
    !/纯室内|室内环境空镜|房间本身/.test(p));
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

// ---------- 六、关键帧：参考图按景别选（肖像 / 身份图）+ 标记展开 ----------
console.log('\n关键帧');
const shot = refBoard.shots.find((s) => (s.cast || []).length && (s.dialogue || []).length) || refBoard.shots[1];
const { refs, series } = keyframeRefs(refBoard, shot);
// 参考图要**跟着景别走**：紧的用肖像（脸部锚点，天然偏紧），宽的用身份图（全身 4 面板）。
// 原先这里写死「必须不是肖像」—— 那条断言把"参考图只能是全身图"钉成了规范，
// 而实测恰恰是全身参考图让每一镜都出成全身，景别的文字约束压不住。
//
// 注意这里是**硬判据**：`refs.length === 0` 不再算通过。
// 空参考图集只能说明"夹具没灌资产路径 / 解析坏了"，那是失败，不是"没得验"。
const TIGHT = ['特写', '近景', '中景'];
const isTight = TIGHT.includes(shot.shot_size);
check(`参考图解析得出来（${shot.id} ${shot.shot_size}）`, refs.length > 0,
  `${shot.shot_size} → ${refs.join(' | ') || '(空)'}`);
check(`关键帧参考图跟着景别走（${shot.id} ${shot.shot_size}）`,
  isTight ? refs.some((r) => /portrait/.test(r)) : refs.every((r) => !/portrait/.test(r)),
  `${shot.shot_size} → ${refs.join(' | ')}`);
const tightShot = refBoard.shots.find((s) => TIGHT.includes(s.shot_size) && (s.cast || []).length);
const wideShot = refBoard.shots.find((s) => !TIGHT.includes(s.shot_size) && (s.cast || []).length);
// 夹具必须同时含紧景别和宽景别的镜头 —— 缺一个，"按景别选图"这条就只剩一半被验到。
check('夹具里紧景别与宽景别的镜头都在（缺一个这条规则就只验一半）',
  Boolean(tightShot) && Boolean(wideShot),
  `紧=${tightShot ? tightShot.id : '无'} 宽=${wideShot ? wideShot.id : '无'}`);
if (tightShot) {
  const t = keyframeRefs(refBoard, tightShot);
  check(`${tightShot.id}（${tightShot.shot_size}）改用**肖像**当身份参考`,
    t.refs.length > 0 && t.refs.some((r) => /portrait/.test(r)), t.refs.join(' | ') || '(空)');
}
if (wideShot) {
  const w = keyframeRefs(refBoard, wideShot);
  check(`${wideShot.id}（${wideShot.shot_size}）仍用**身份图**（全身镜要全身锚）`,
    w.refs.length > 0 && w.refs.every((r) => !/portrait/.test(r)), w.refs.join(' | ') || '(空)');
}
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

console.log('\n' + '─'.repeat(56));
if (failures.length) {
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项：`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log(`全部通过（${passed} 项）—— 配方可断言，出图前就知道对不对`);
}
