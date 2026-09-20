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

function dryRun(dir) {
  const result = spawnSync(process.execPath, [
    path.join(root, 'cli', 'keyframes.mjs'),
    path.join(dir, 'board.json'),
    '--direction', path.join(dir, 'render.plan.json'),
    '--units', 'g001',
    '--dry-run',
    '--skip-gate',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, `干跑应成功：${result.stderr}`);
  return result.stdout;
}

test('timeline wording is stripped from the static keyframe pose', () => {
  const out = dryRun(makeProject(null));
  assert.match(out, /关键帧起始姿态：女孩坐在床边/);
  assert.doesNotMatch(out, /0秒时/);
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
