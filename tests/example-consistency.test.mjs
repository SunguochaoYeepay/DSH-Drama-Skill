import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parseScript } from '../src/parse-script.mjs';

/**
 * 示例剧目的**跨文件一致性** —— 单看一份文件都成立，合起来却对不上，是最难发现的一类破绽。
 *
 * 起因（2026-09-22）：示例剧目改过一轮剧本后，`render.plan.json` 里凭空造了一个
 * `source_units: ["u3"]`，而导演稿里根本没有 u3 —— 片子照样出了，因为计划里连
 * `why` / `audience_knows` / `keyframe_start` 这些**本该属于导演稿**的字段也手工填了，
 * 等于绕过导演稿自己造了一段。读者顺着 g003 往回追来源，会追到一个不存在的单元。
 *
 * 这类漂移机器判不出语义，但**引用闭合、时长自洽、台词快照对得上**都判得出。
 * 每加一条断言，就是替未来的自己记一次体检。
 *
 * 与 `example-demo.test.mjs` 的分工：那边管**单文件成不成立**（契约/哈希/提示词违规），
 * 这边管**文件之间咬不咬得合**。
 */

const DEMO = path.resolve('examples', 'demo-show');
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(DEMO, f), 'utf8'));

const board = readJson('board.json');
const draft = readJson('board.direction.json');
const plan = readJson('render.plan.json');
const unitById = new Map(draft.units.map((u) => [u.id, u]));
const sceneById = new Map(board.scenes.map((s) => [s.id, s]));
const sumShots = (shots) => (shots || []).reduce((a, s) => a + (s.duration_s || 0), 0);

test('计划引用的导演单元必须真实存在 —— 不许凭空造 u', () => {
  const dangling = [];
  for (const unit of plan.units || []) {
    for (const id of unit.source_units || []) {
      if (!unitById.has(id)) dangling.push(`${unit.id}.source_units → ${id}（导演稿里没有）`);
    }
    for (const shot of unit.shots || []) {
      const id = shot.source?.unit;
      if (id && !unitById.has(id)) dangling.push(`${unit.id} 第 ${shot.n} 镜.source.unit → ${id}（导演稿里没有）`);
    }
  }
  assert.deepEqual(dangling, [], `生成计划引用了不存在的导演单元：\n${dangling.join('\n')}\n`
    + '原因通常是剧本改了、导演稿没跟着补单元，只在计划里手工切了一段。');
});

test('时长三处自洽：计划单元 = 自己镜头之和 = 来源单元镜头之和', () => {
  const bad = [];
  for (const unit of plan.units || []) {
    const own = sumShots(unit.shots);
    if (Math.abs(own - unit.generation_duration_s) > 0.01) {
      bad.push(`${unit.id}: 声明 ${unit.generation_duration_s}s ≠ 镜头之和 ${own.toFixed(2)}s`);
    }
    for (const id of unit.source_units || []) {
      const src = unitById.get(id);
      if (!src) continue;
      const s = sumShots(src.shots);
      if (Math.abs(s - unit.generation_duration_s) > 0.01) {
        bad.push(`${unit.id}: 声明 ${unit.generation_duration_s}s ≠ 来源 ${id} 的 ${s.toFixed(2)}s`);
      }
    }
  }
  assert.deepEqual(bad, [], `导演稿与生成计划的时长对不上：\n${bad.join('\n')}`);
});

test('板子：镜头字段齐全，且总时长等于各镜之和', () => {
  const [first, ...rest] = board.shots;
  const want = Object.keys(first).sort().join(',');
  const thin = rest.filter((s) => Object.keys(s).sort().join(',') !== want)
    .map((s) => `${s.id}（缺：${want.split(',').filter((k) => !(k in s)).join('、') || '字段集不同'}）`);
  assert.deepEqual(thin, [], `镜头字段不完整：\n${thin.join('\n')}`);

  const total = sumShots(board.shots);
  assert.ok(
    Math.abs((board.meta.total_duration_s ?? -1) - total) < 0.01,
    `meta.total_duration_s=${board.meta.total_duration_s} ≠ 镜头之和 ${total.toFixed(2)}`,
  );
});

test('板子的台词快照对得上剧本 —— 别让快照漂移到剧本之外', () => {
  const lines = new Map(parseScript(fs.readFileSync(path.join(DEMO, 'story.md'), 'utf8')).lines.map((l) => [l.no, l.text || '']));
  const strip = (s) => String(s).replace(/[\s，。！？、；：「」“”‘’()（）]/g, '');
  const bad = [];
  for (const shot of board.shots) {
    for (const d of shot.dialogue || []) {
      const at = (shot.source_lines || []).find((n) => strip(lines.get(n) || '').includes(strip(d.text)));
      if (at === undefined) bad.push(`${shot.id} 的台词「${d.text}」在 source_lines ${JSON.stringify(shot.source_lines)} 里找不到`);
    }
  }
  assert.deepEqual(bad, [], `板子记的台词与剧本对不上（改了剧本没回填板子）：\n${bad.join('\n')}`);
});

test('场景描述撑得住镜头 —— 镜头里的空间实体必须在场景里存在', () => {
  // 与 cli/register-direction.mjs 的启发式同源：抓的是「镜头写到的空间，在场景描述里一个字都没有」。
  // 词表只收本剧涉及的空间名词，命中即值得看一眼。
  const WORDS = ['驾驶座', '车门', '车窗', '站牌', '马路', '人行道', '路缘', '过道', '椅背', '座椅'];
  const bad = [];
  const scan = (tag, scene, text) => {
    const env = sceneById.get(scene);
    if (!env || !text) return;
    const missing = WORDS.filter((w) => text.includes(w) && !`${env.name || ''}${env.environment || ''}`.includes(w));
    if (missing.length) bad.push(`${tag}（场景 ${scene}）写到了「${missing.join('、')}」，但场景描述里没有它`);
  };
  for (const unit of draft.units) {
    scan(`导演稿 ${unit.id} keyframe_start`, unit.shots?.[0]?.scene, unit.keyframe_start);
    for (const shot of unit.shots || []) scan(`导演稿 ${unit.id} 镜${shot.n}`, shot.scene, shot.action);
  }
  for (const unit of plan.units || []) {
    const scene = unit.scene || unit.shots?.[0]?.scene;
    scan(`计划 ${unit.id} keyframe_start`, scene, unit.keyframe_start);
    for (const shot of unit.shots || []) scan(`计划 ${unit.id} 镜${shot.n}`, shot.scene || scene, shot.action);
  }
  assert.deepEqual(bad, [], `镜头与场景描述不一致：\n${bad.join('\n')}\n补场景的 environment，而不是删镜头里的动作。`);
});

test('事实一致：公交车上没有安全带 —— 别在任何一层把它写回画面', () => {
  // 允许**澄清句**：提示词里写「公交车没有安全带」是为了压住模型的惯性（它会自己画一条）。
  // 禁止的是**把它当画面元素描写**（「解开安全带」「安全带扣着」）。
  // ⚠ 只写「没有 X」这类否定短语，不要加 `公交车没有` 这种前缀分支：
  // 它会先吃掉「公交车没有」，把「安全带」剩在原处，反而永远命中。
  const CLARIFY = /没有安全带|无安全带|不设安全带|未系安全带/g;
  const bad = [];
  const scan = (where, text) => { if (/安全带/.test(String(text || '').replace(CLARIFY, ''))) bad.push(where); };
  for (const s of board.shots) { scan(`board ${s.id}.action`, s.action); scan(`board ${s.id}.prompt`, s.prompt); }
  for (const u of draft.units) {
    scan(`导演稿 ${u.id}.keyframe_start`, u.keyframe_start);
    for (const shot of u.shots || []) {
      scan(`导演稿 ${u.id} 镜${shot.n}.action`, shot.action);
      scan(`导演稿 ${u.id} 镜${shot.n}.keyframe_start`, shot.keyframe_start);
    }
  }
  for (const u of plan.units || []) {
    scan(`计划 ${u.id}.keyframe_start`, u.keyframe_start);
    for (const shot of u.shots || []) scan(`计划 ${u.id} 镜${shot.n}.action`, shot.action);
  }
  assert.deepEqual(bad, [], `公交车场景里不该出现安全带：\n${bad.join('\n')}`);
});

test('导演稿单元都写了 audience_knows —— 悬念唯一的落点', () => {
  const missing = draft.units.filter((u) => !String(u.audience_knows || '').trim()).map((u) => u.id);
  assert.deepEqual(missing, [], `这些单元没写 audience_knows：${missing.join('、')}`);
});
