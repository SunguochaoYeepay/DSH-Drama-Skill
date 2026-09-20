/**
 * 提示词自检的行为测试：守的是 `references/prompt-rules.md` 的每一条禁令。
 *
 * 判据不是"函数存在"，是"违规文本真的会被报出来、允许的例外真的不会被报出来"。
 * 例外最重要 —— 禁文字与身份锚是实测有效的两条，误报会逼人把它们删掉，那才是真事故。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditPrompt, refinePrompt, PROMPT_MAX_CHARS } from '../src/draw-specialist.mjs';

const CLEAN = '敞开的机舱门洞内，教练和小雅并排站着，面朝镜头，画面下边界切在两人腰部。'
  + '机舱内部很暗，门洞与门外天空过曝发白。中景，写实电影剧照，手持纪实质感。';

const hit = (text, rule) => auditPrompt(text).violations.some((v) => v.rule === rule);

test('干净的画面描述没有违规', () => {
  const a = auditPrompt(CLEAN);
  assert.equal(a.violations.length, 0, JSON.stringify(a.violations));
  assert.ok(a.chars <= PROMPT_MAX_CHARS);
});

test('元标签与组织架构词要被报出来', () => {
  assert.ok(hit(`【全片规则】机舱内始终比门外暗。${CLEAN}`, '元标签/组织架构'));
  assert.ok(hit(`【抽卡师｜执行层执行编译】${CLEAN}`, '元标签/组织架构'));
  assert.ok(hit(`【人物造型师锁定】方脸。${CLEAN}`, '元标签/组织架构'));
  assert.ok(hit(`抽卡师提示：景别可能冲突。${CLEAN}`, '元标签/组织架构'));
});

test('对模型的策略建议要被报出来', () => {
  assert.ok(hit(`${CLEAN}构图拥挤时，依次尝试缩短人物间距、前后错位。`, '对模型的策略建议'));
  assert.ok(hit(`${CLEAN}不要为了保留横向留白而放松景别。`, '对模型的策略建议'));
});

test('空引用要被报出来', () => {
  assert.ok(hit(`${CLEAN}按导演分镜的景别与构图执行。`, '空引用'));
  assert.ok(hit(`${CLEAN}与导演首帧状态一致。`, '空引用'));
});

test('解释性文字要被报出来', () => {
  assert.ok(hit(`${CLEAN}绝不允许出现大腿或膝盖（那就成了全景）。`, '解释性文字'));
});

test('单帧不可见的信息要被报出来', () => {
  assert.ok(hit(`${CLEAN}飞机恒向画面左侧飞行，云层相对向右流动。`, '单帧不可见的信息'));
  assert.ok(hit(`${CLEAN}她尚未点头、尚未抬手。`, '单帧不可见的信息'));
});

test('拼接疤痕要被报出来', () => {
  assert.ok(hit(`${CLEAN}自然光学暗角。。图1是场景参考`, '拼接疤痕'));
});

test('正向里的否定句要被报出来', () => {
  assert.ok(hit(`${CLEAN}女跳伞员身上不得出现任何伞包、背带或伞绳。`, '正向里的否定句'));
});

test('例外：禁文字与身份锚不算违规', () => {
  assert.ok(!hit(`${CLEAN}画面中不要出现文字、字幕、水印、logo、边框或拼图。`, '正向里的否定句'));
  assert.ok(!hit(`${CLEAN}保持参考图的角色身份，不得重设计脸部或头部特征。`, '正向里的否定句'));
});

test('超字数要被报出来，且报出实际字数', () => {
  const long = CLEAN.repeat(12); // 上限放宽到 500 后，6 倍不再超线
  const a = auditPrompt(long);
  const over = a.violations.find((v) => v.rule === '超字数');
  assert.ok(over, '超字数必须被报出来');
  assert.match(over.hit, /^\d+ 字 > 500$/);
});

// ---------------------------------------------------------------- 最终整理

const refine = (text, opts) => refinePrompt(text, opts).text;

test('整理：删掉元标签段与组织架构词', () => {
  const out = refine('【全片规则】\n· door_light：机舱内比门外暗。\n【抽卡师｜执行层执行编译】\n【景别】中景\n【空间关系】与导演首帧一致\n敞开的门洞内两人站着。');
  assert.doesNotMatch(out, /全片规则/);
  assert.doesNotMatch(out, /抽卡师/);
  assert.doesNotMatch(out, /【景别】/);
  assert.doesNotMatch(out, /导演首帧/);
  assert.match(out, /door_light|机舱内比门外暗/);   // 正文要留下
});

test('整理：删掉正向里的排除项，但不删禁文字与身份锚', () => {
  const out = refine('【风格排除】不得出现：线稿、水彩、CG 渲染感。\n'
    + '保持参考图的角色身份、体型比例和体表材质。不得重设计脸部或头部特征。\n'
    + '画面中不要出现文字、字幕、水印、logo、边框或拼图。\n敞开的门洞内两人站着。');
  assert.doesNotMatch(out, /风格排除/);
  assert.doesNotMatch(out, /线稿/);
  assert.match(out, /不得重设计脸部/);   // 身份锚：实测有效，误删会让脸走样
  assert.match(out, /不要出现文字/);     // 禁文字：实测有效，误删会在衣服上冒字
});

test('整理：景别硬边界块换成一句画面陈述', () => {
  const out = refine('构图要求：【景别｜中景】画面下边界严格切在人物的腰部（腰带/腰线位置）。'
    + '绝不允许出现大腿或膝盖（那就成了全景）。\n敞开的门洞内两人站着。',
  { visualFraming: '中景，画面下边界切在人物的腰部' });
  assert.doesNotMatch(out, /构图要求|那就成了/);
  assert.match(out, /中景，画面下边界切在人物的腰部/);
});

test('整理：单帧不可见的信息要删，画面部分要留', () => {
  // ⚠ 这条守的是一个真实事故：句号不作切分符时，「她背上是一只体积小的日常双肩包，
  // 肩带细、包身瘪。教练尚未转身…」被当成一句整段删掉 —— 全片笑点就这么没了。
  const out = refine('她背上是一只体积小的日常双肩包，肩带细、包身瘪。教练尚未转身，她尚未点头、尚未抬手，两人都还没有移动。');
  assert.doesNotMatch(out, /尚未|还没有移动/);
  assert.match(out, /体积小的日常双肩包/);
});

test('整理：「已经 + 尚未」的混合句只删尚未子句，当下状态要留', () => {
  // 2026-09-20 g002 实测：「教练站在画面左侧，一只手已经握住门框，身体尚未完全转向她、
  // 尚未开口」被 /尚未/ 整句连坐删掉 —— 但"握住门框"是当下状态、画得出，还是
  // g003/g004 连续性承接的起点。UNSEEN 因此下沉到子句级。
  const out = refine('教练站在画面左侧，一只手已经握住门框，身体尚未完全转向她、尚未开口。');
  assert.match(out, /教练站在画面左侧/);
  assert.match(out, /已经握住门框/);
  assert.doesNotMatch(out, /尚未/);
});

test('整理：只丢命中的那一截，不整句连坐', () => {
  // door_light 的画面信息（半剪影）在否定子句前面，整句删会把它一起丢掉。
  const out = refine('机舱内始终比门外暗，门洞是全画面最亮的高光区；人物在门洞前呈半剪影，不得让人脸与门外天空亮度一致。');
  assert.doesNotMatch(out, /不得让人脸/);
  assert.match(out, /半剪影/);
  assert.match(out, /门洞是全画面最亮的高光区/);
});

test('整理：修掉拼接疤痕与重复行，且不留下双标点', () => {
  const out = refine('旧金属磨损质感。。图1是场景参考。\n重复的这一行。\n重复的这一行。');
  assert.doesNotMatch(out, /。。/);
  assert.doesNotMatch(out, /；；|。；/);
  assert.equal(out.match(/重复的这一行/g).length, 1);
});

test('整理：整理后自检必须干净（除了字数）', () => {
  const dirty = '【全片规则】\n· door_light：机舱内比门外暗。\n【风格排除】不得出现：线稿、水彩。\n'
    + '构图要求：【景别｜中景】下边界切在腰部。绝不允许出现大腿（那就成了全景）。\n'
    + '【抽卡师｜执行层执行编译】\n【空间关系】与导演首帧一致\n'
    + CLEAN;
  const { text } = refinePrompt(dirty, { visualFraming: '中景，画面下边界切在人物的腰部' });
  const after = auditPrompt(text).violations.filter((v) => v.rule !== '超字数');
  assert.deepEqual(after, [], JSON.stringify(after));
});
