import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { checkBoard } from '../src/board.mjs';
import { parseScript, spokenLines } from '../src/parse-script.mjs';
import { auditPrompt, PROMPT_MAX_CHARS } from '../src/draw-specialist.mjs';

/**
 * examples/demo-show 是**给别人看的样板**，所以它必须真的成立 ——
 * 一旦它烂了而没人发现，读者照着抄出来的东西就是坏的。
 *
 * 判据是行为：板子过不过契约、来源票的哈希对不对得上、导演稿的
 * 单元与台词有没有 Overflow。不是「目录里有没有这几个文件」。
 */

const DEMO = path.resolve('examples', 'demo-show');
const root = path.resolve('.');
const read = (f) => fs.readFileSync(path.join(DEMO, f), 'utf8');
const readJson = (f) => JSON.parse(read(f));

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** git 当前跟踪的示例文件（仓库相对路径）。 */
function gitTrackedDemoFiles() {
  const r = spawnSync('git', ['ls-files', '--', 'examples/demo-show'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ls-files 失败：${r.stderr}`);
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

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

test('导演稿：每句台词恰好被某一镜引用一次，且引用的是真实行号', () => {
  const parsed = parseScript(read('story.md'));
  const expected = spokenLines(parsed).map((l) => l.no).sort((a, b) => a - b);

  const draft = readJson('board.direction.json');
  assert.equal(draft.version, 6, '导演协议版本必须是 6');

  const used = draft.units.flatMap((u) => u.shots.flatMap((s) => s.lines || []));
  assert.deepEqual(
    [...used].sort((a, b) => a - b),
    expected,
    '剧本每一句台词必须出现在某一镜里，且只出现一次',
  );
});

test('导演稿：单元时长与镜头排布符合引擎硬约束', () => {
  const draft = readJson('board.direction.json');
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

test('导演稿已登记：有正本，也有自证的来源票', () => {
  const receipt = readJson('board.direction.json.provenance.json');
  assert.equal(receipt.provider, 'agent_draft', '来源票必须写明是 Agent 直写');
  assert.equal(receipt.model, null, 'Agent 直写的稿子不许冒充模型产物');
  assert.equal(
    receipt.direction_sha256,
    sha256(read('board.direction.json')),
    '导演稿被改过但来源票没更新',
  );
});

test('生成计划：每个单元都在引擎上限内，且关键帧落点指向计划里的单元', () => {
  const plan = readJson('render.plan.json');
  const units = plan.groups || plan.units || [];
  assert.ok(units.length >= 1, '计划里至少要有一个单元');
  for (const unit of units) {
    assert.ok(unit.id, '单元缺 id');
    assert.ok(
      unit.generation_duration_s > 0 && unit.generation_duration_s <= 15,
      `${unit.id} 的生成时长 ${unit.generation_duration_s}s 超出引擎上限`,
    );
  }
});

test('关键帧提示词：每个计划单元都有一份，且零违规、不超字数', () => {
  const plan = readJson('render.plan.json');
  const units = plan.groups || plan.units || [];
  for (const unit of units) {
    const file = path.join(DEMO, 'keyframe-prompts', `${unit.id}.txt`);
    assert.ok(fs.existsSync(file), `缺 ${unit.id} 的关键帧提示词 —— 直写制下它是唯一来源`);
    const text = fs.readFileSync(file, 'utf8').trim();
    assert.ok(text.length > 0, `${unit.id} 的提示词是空的`);
    assert.ok(text.length <= PROMPT_MAX_CHARS, `${unit.id} 提示词 ${text.length} 字，超过 ${PROMPT_MAX_CHARS} 上限`);
    const { violations } = auditPrompt(text);
    assert.deepEqual(
      violations,
      [],
      `${unit.id} 提示词违规：\n${violations.map((v) => `  [${v.rule}] ${v.detail}`).join('\n')}`,
    );
  }
});

test('人工票是真的：story 与 direction 两道闸都已由人签过', () => {
  const { approvals } = readJson('review.approvals.json');
  for (const stage of ['story', 'direction']) {
    const ticket = approvals[stage];
    assert.ok(ticket, `${stage} 闸没签 —— 示例不该给人看一条没过闸的链`);
    assert.ok(ticket.at, `${stage} 票缺时间`);
    assert.ok(ticket.by, `${stage} 票缺签字人`);
    assert.ok(ticket.artifact_hash, `${stage} 票缺产物哈希`);
  }
});

test('入库的示例文件不含本机绝对路径 —— 它是要发到 GitHub 的', () => {
  // 运行态产物（生成记录/审阅单/交接凭证）不入库，但 CLI 会往里写本机绝对路径，
  // 所以这条断言只对 **git 跟踪的文件** 生效（.gitignore 已挡运行态目录）。
  const tracked = gitTrackedDemoFiles();
  const bad = [];
  for (const rel of tracked) {
    if (!/\.(json|md|txt)$/.test(rel)) continue;
    fs.readFileSync(path.join(root, rel), 'utf8').split('\n').forEach((line, i) => {
      const m = line.match(/(?<![A-Za-z:/])[A-Za-z]:[/\\]/g);
      if (m) bad.push(`${rel}:${i + 1}  ${line.trim().slice(0, 80)}`);
    });
  }
  assert.deepEqual(bad, [], `示例里出现了本机绝对路径：\n${bad.join('\n')}`);
});

test('git 不跟踪示例里的任何媒体产物 —— 仓库里不该出现图音视频', () => {
  // 磁盘上允许有（生成必然产生媒体），但 .gitignore 必须把它们全部挡住。
  const media = gitTrackedDemoFiles().filter((f) => /\.(png|jpe?g|webp|mp4|mov|mp3|wav|srt)$/i.test(f));
  assert.deepEqual(media, [], `示例媒体混进了 git：\n${media.join('\n')}`);
});
