import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import { checkBoard } from '../src/board.mjs';
import { parseScript, spokenLines } from '../src/parse-script.mjs';

/**
 * examples/demo-show 是**给别人看的样板**，所以它必须真的成立 ——
 * 一旦它烂了而没人发现，读者照着抄出来的东西就是坏的。
 *
 * 判据是行为：板子过不过契约、来源票的哈希对不对得上、导演稿的
 * 单元与台词有没有 Overflow。不是「目录里有没有这几个文件」。
 */

const DEMO = path.resolve('examples', 'demo-show');
const read = (f) => fs.readFileSync(path.join(DEMO, f), 'utf8');
const readJson = (f) => JSON.parse(read(f));

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

test('示例板子通过 Storyboard 契约校验，零 error', () => {
  const board = readJson('board.json');
  const { errors, warnings } = checkBoard(board);
  assert.deepEqual(errors, [], `板子不符合契约：\n${errors.join('\n')}`);
  assert.deepEqual(warnings, [], `示例不该带警告（它是范本）：\n${warnings.join('\n')}`);
});

test('示例写了立项时间 —— 看板按它倒序排剧目', () => {
  const board = readJson('board.json');
  assert.match(
    board.meta.created_at,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    'board.json 必须带 ISO 8601 的 meta.created_at',
  );
});

test('剧本来源票自证：票里的哈希等于 story.md 现在的哈希', () => {
  const story = read('story.md');
  const receipt = readJson('story.provenance.json');
  assert.equal(receipt.source, 'agent_draft');
  assert.equal(receipt.model, null, 'Agent 直写的稿子不许冒充模型产物');
  assert.equal(receipt.story_sha256, sha256(story), '剧本被改过但来源票没更新 —— 票据已经失去意义');
});

test('导演稿草稿：每句台词恰好被某一镜引用一次，且引用的是真实行号', () => {
  const parsed = parseScript(read('story.md'));
  const expected = spokenLines(parsed).map((l) => l.no).sort((a, b) => a - b);

  const draft = readJson('board.direction.draft.json');
  assert.equal(draft.version, 6, '导演协议版本必须是 6');

  const used = draft.units.flatMap((u) => u.shots.flatMap((s) => s.lines || []));
  assert.deepEqual(
    [...used].sort((a, b) => a - b),
    expected,
    '剧本每一句台词必须出现在某一镜里，且只出现一次',
  );
});

test('导演稿草稿：单元时长与镜头排布符合引擎硬约束', () => {
  const draft = readJson('board.direction.draft.json');
  for (const unit of draft.units) {
    let prevAt = -1;
    unit.shots.forEach((shot, i) => {
      assert.equal(shot.n, i + 1, `${unit.id} 的镜号必须连续`);
      assert.ok(shot.at > prevAt, `${unit.id} 第 ${shot.n} 镜的 at 必须严格递增`);
      prevAt = shot.at;
      const end = shot.at + shot.duration_s;
      assert.ok(end <= 15, `${unit.id} 第 ${shot.n} 镜 ${end}s 超过 15 秒引擎上限`);
      if (shot.n === 1) {
        assert.equal(shot.at, 0, '单元第一镜必须从 0 秒开始');
        assert.equal(shot.cut, undefined, '第一镜没有上一镜，不该有 cut');
      } else {
        assert.ok(shot.cut, `第 ${shot.n} 镜缺 cut`);
      }
      for (const who of shot.on_screen) {
        assert.ok(
          shot.emotion_analysis.some((e) => e.character === who),
          `${unit.id}/${shot.n} 的 emotion_analysis 漏了 ${who}`,
        );
      }
    });
  }
});

test('示例不含任何媒体产物 —— 仓库里不该出现图音视频', () => {
  const bad = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(png|jpe?g|webp|mp4|mov|mp3|wav|srt)$/i.test(e.name)) bad.push(p);
    }
  })(DEMO);
  assert.deepEqual(bad, [], `示例里混进了媒体文件：\n${bad.join('\n')}`);
});
