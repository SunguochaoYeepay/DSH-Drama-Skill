/**
 * 关键帧提示词的行为测试。
 *
 * ## 为什么不直接读 `cli/keyframes.mjs` 的源码做正则
 *
 * 这一版之前是三条 `assert.match(source, /…/)`，查的是「源码里有没有写这行字」：
 * 源码换个等价写法它就红，提示词真错了它却绿。**它没测过任何行为。**
 *
 * 现在改成**真的跑一遍 `cli/keyframes.mjs --dry-run`**，断言打印出来的提示词。
 * 干跑不调任何通道、不写任何图，所以是确定性的。
 *
 * 守的三条行为：
 *   1. 关键帧起始姿态要把「0秒时：」这种时间措辞剥掉（关键帧是静帧，没有时间轴）；
 *   2. 有构图覆盖时，基础构图那两行硬约束必须让位（否则模型同时收到两套构图，必偏）；
 *   3. 没有覆盖时，基础构图必须原样在（不能因为改了覆盖逻辑就常年把硬约束删了）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');

/** 造一个能跑通干跑的最小项目：板子 + 编译计划（可选构图覆盖）。 */
function makeProject(override) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-keyframe-prompt-'));
  const png = path.join(dir, 'portrait.png');
  fs.writeFileSync(png, 'stub');
  fs.writeFileSync(path.join(dir, 'board.json'), JSON.stringify({
    meta: { project: 'keyframe-prompt', aspect: '9:16', style_prompt: '暖色调绘本风格' },
    characters: [{ id: 'c_girl', name: '女孩', face_prompt: '圆脸', portrait: png }],
    identities: [{ id: 'i_girl', character: 'c_girl', appearance_details: '白裙', sheet: png }],
    scenes: [{ id: 's_room', name: '卧室', master: png }],
    props: [],
  }));
  fs.writeFileSync(path.join(dir, 'render.plan.json'), JSON.stringify({
    units: [{
      id: 'g001',
      keyframe_start: '0秒时：女孩坐在床边',
      shots: [{ framing: '中景', action: '女孩坐在床边', scene: 's_room', on_screen: ['i_girl'] }],
    }],
  }));
  if (override) {
    fs.mkdirSync(path.join(dir, 'reviews'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'reviews', 'keyframe-overrides.json'),
      JSON.stringify({ units: { g001: override } }));
  }
  return dir;
}

// ⚠ `units` 必须与 fixture 里单元的 id 一致：不一致时 CLI 只是静默跳过（不报错、不打印），
// 断言「不存在某句」会假绿、断言「存在某句」才红（2026-09-21 加无人镜头用例时踩过）。
function dryRun(dir, units = 'g001') {
  const result = spawnSync(process.execPath, [
    path.join(root, 'cli', 'keyframes.mjs'),
    path.join(dir, 'board.json'),
    '--direction', path.join(dir, 'render.plan.json'),
    '--units', units,
    '--dry-run',
    '--skip-gate',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, `干跑应成功：${result.stderr}`);
  assert.ok(result.stdout.includes(`【${units}】`), `干跑应真的编译了 ${units}，实际输出没有它`);
  return result.stdout;
}

test('timeline wording is stripped from the static keyframe pose', () => {
  const out = dryRun(makeProject(null));
  assert.match(out, /关键帧起始姿态：女孩坐在床边/);
  assert.doesNotMatch(out, /0秒时/);
});

/**
 * 无人镜头的 fixture：画面里只有柜面和一只从画外伸进来的手，没有可锚定的人。
 *
 * 2026-09-21 not_awake g002 就是这个形态，当时 templates 拼出
 * 「请把参考图中的放进同一个镜头」——一句主语缺失的残句，还是提示词的第一句。
 */
function makeNoPeopleProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-keyframe-nobody-'));
  const png = path.join(dir, 'portrait.png');
  fs.writeFileSync(png, 'stub');
  fs.writeFileSync(path.join(dir, 'board.json'), JSON.stringify({
    meta: { project: 'keyframe-prompt', aspect: '9:16', style_prompt: '暖色调绘本风格' },
    characters: [{ id: 'c_girl', name: '女孩', face_prompt: '圆脸', portrait: png }],
    identities: [{ id: 'i_girl', character: 'c_girl', appearance_details: '白裙', sheet: png }],
    scenes: [{ id: 's_bedside', name: '床头柜', master: png }],
    props: [],
  }));
  fs.writeFileSync(path.join(dir, 'render.plan.json'), JSON.stringify({
    units: [{
      id: 'g002',
      cast: [],
      keyframe_start: '0秒时：近景取床头柜柜面，她的右手从画面右下方的被子边缘伸进来，五指张开悬在白搪瓷杯上方',
      shots: [{ framing: '近景', action: '手在柜面上移动', scene: 's_bedside', on_screen: [] }],
    }],
  }));
  return dir;
}

test('no-people shot gets no dangling "把参考图中的" sentence', () => {
  const out = dryRun(makeNoPeopleProject(), 'g002');
  assert.doesNotMatch(out, /参考图中的放进同一个镜头/);
  // 风格与参考图职责仍然要交代，只是不再要求把谁「放进镜头」
  assert.match(out, /整体风格严格遵循：暖色调绘本风格/);
  assert.match(out, /图1是场景参考/);
});

test('no-people shot drops the identity-anchor sentence aimed at a missing portrait', () => {
  const out = dryRun(makeNoPeopleProject(), 'g002');
  assert.doesNotMatch(out, /保持参考图的角色身份、体型比例和体表材质/);
  // 有人有身份图的常规镜头必须照旧带上，不能被这次裁剪误伤
  assert.match(dryRun(makeProject(null)), /保持参考图的角色身份、体型比例和体表材质/);
});

test('no-people shot keeps out bed-scene footwear exclusion', () => {
  // 起始姿态里出现「被子」会命中椅子内的寝具正则；但画面里没有人，禁鞋禁站立没有对象。
  const out = dryRun(makeNoPeopleProject(), 'g002');
  assert.doesNotMatch(out, /鞋履|站立姿态/);
});

test('framing rule appears exactly once when there is no composition override', () => {
  const out = dryRun(makeProject(null));
  assert.match(out, /构图要求：/);
  // 去重守卫（2026-09-20 no_chute 对照实验）：景别硬边界曾经说三遍
  // （构图要求 / 生成前最终检查 / 抽卡师画面截取范围），重复块把关键实体的字面权重稀释掉，
  // 五连抽全废；130 字短提示词一发命中。现在**只允许出现一次**。
  const hits = (out.match(/画面下边界严格切在人物的腰部/g) || []).length;
  assert.equal(hits, 1, `景别规则应只出现一次，实际 ${hits} 次`);
  assert.doesNotMatch(out, /【生成前最终检查】/);
  assert.doesNotMatch(out, /【画面截取范围】/);
});

test('keyframe start pose appears exactly once', () => {
  const out = dryRun(makeProject(null));
  // 起始姿态曾经被 buildPrompt 与 compileDrawPlan 各拼一次（150 字整段重复）。
  const hits = (out.match(/关键帧起始姿态：/g) || []).length;
  assert.equal(hits, 1, `起始姿态应只出现一次，实际 ${hits} 次`);
});

test('composition override removes the conflicting base framing clauses', () => {
  const out = dryRun(makeProject('构图覆盖：改为斜侧中景，完整保留床头到床尾'));
  assert.doesNotMatch(out, /构图要求：/);
  assert.match(out, /斜侧中景/);
});

test('composition override is the capture itself and injects no bed-scene wording', () => {
  // 回归守卫：这段取景曾经被硬编码成床戏描述（「画面从床头的斜侧方向取景…床尾方向」），
  // 导致任何非床戏场景一用覆盖就被注入「床头板、枕头、床尾」。
  // 覆盖是通用机制 —— 覆盖文本里没有的东西，提示词里也不许出现。
  const text = '构图覆盖：中景，她站在台阶最下一级的水痕地面上，双手自然垂在身侧；矮桌在她身后的门洞里';
  const out = dryRun(makeProject(text));
  assert.match(out, new RegExp(`【画面截取范围】${text}`));
  assert.doesNotMatch(out, /床头|枕头|床尾|镜面/);
  assert.match(out, /楼道口|门洞/);
});

/** 两人 fixture：远景/中景的多人措辞行为要用两个角色才能触发。 */
function makeTwoPersonProject(framing) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-keyframe-prompt2-'));
  const png = path.join(dir, 'portrait.png');
  fs.writeFileSync(png, 'stub');
  fs.writeFileSync(path.join(dir, 'board.json'), JSON.stringify({
    meta: { project: 'keyframe-prompt', aspect: '9:16', style_prompt: '暖色调绘本风格' },
    characters: [
      { id: 'c_a', name: '甲', face_prompt: '圆脸', portrait: png },
      { id: 'c_b', name: '乙', face_prompt: '方脸', portrait: png },
    ],
    identities: [
      { id: 'i_a', character: 'c_a', appearance_details: '红衣', sheet: png },
      { id: 'i_b', character: 'c_b', appearance_details: '蓝衣', sheet: png },
    ],
    scenes: [{ id: 's_room', name: '卧室', master: png }],
    props: [],
  }));
  fs.writeFileSync(path.join(dir, 'render.plan.json'), JSON.stringify({
    units: [{
      id: 'g001',
      keyframe_start: '0秒时：甲和乙并排站着',
      shots: [{ framing, action: '甲和乙并排站着', scene: 's_room', on_screen: ['i_a', 'i_b'] }],
    }],
  }));
  return dir;
}

test('wide framing does not demand clearly visible faces for two-person casts', () => {
  // 回归守卫（2026-09-20 no_chute_v2）：远景里人本来就不到画面 1/4，
  // 再追加「两个人都必须清楚可见」与景别规则正面互搏，模型往「把人放大」妥协——
  // 两连抽人都被挪出应有位置。宽景别只要求「在画面里、位置对」。
  const out = dryRun(makeTwoPersonProject('远景'));
  assert.doesNotMatch(out, /两个人都必须清楚可见/);
  assert.match(out, /两个人都出现在画面里即可/);
});

test('non-wide framing keeps the clearly-visible requirement for two-person casts', () => {
  // 中景/近景/特写走 TIGHT_FRAMINGS 分支（「脸都必须清楚可辨」）；
  // 这里用全景验证非宽非紧景别仍保留「清楚可见」。
  const out = dryRun(makeTwoPersonProject('全景'));
  assert.match(out, /两个人都必须清楚可见/);
  assert.doesNotMatch(out, /两个人都出现在画面里即可/);
});
