/**
 * `cli/dump-payload.mjs` 的行为测试。
 *
 * ## 为什么值得测
 * 这个工具存在的理由就是**本仓提示词 ≠ 进模型的提示词**。它一旦取错字段，
 * 排查画面问题就会拿着错的原文下结论——比没有这个工具更糟。
 *
 * ## 怎么测
 * 造一份 `/history/<id>` 的 JSON 喂进 `--history`，断言工具从里面认出的
 * positive / negative / 采样参数。测的是**解析行为**，不是源码里有没有那行字。
 * （用文件而不是真连 ComfyUI：本机服务不是测试的一部分，且沙箱里起 server 不稳。）
 *
 * 守三条：
 *   1. Qwen 2.1 那种**单节点同时给正负向**的结构，两个字段都要被认出来；
 *   2. 采样参数按 class_type 认，不按节点号（换模型族布局会变）；
 *   3. 缺 prompt_id / history 里没有这次提交 → 退出码 1，且不留下空报告。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const CLI = path.join(root, 'cli', 'dump-payload.mjs');
const PID = 'test-prompt-id-0001';

/** Qwen 2.1：一个编码节点同时输出 positive 和 negative；采样节点编号与老家族不同。 */
const GRAPH = {
  '1': { class_type: 'UNETLoader', inputs: { unet_name: 'qwen_image_2.1_bf16.safetensors', weight_dtype: 'default' } },
  '7': { class_type: 'TextEncodeQwenImage21', inputs: { prompt: '正向：柜面近景', negative_prompt: '负向：卡通，动漫' } },
  '8': { class_type: 'KSampler', inputs: { steps: 25, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1 } },
  '20': { class_type: 'LoadImage', inputs: { image: 'scene.png' } },
};

function makeFixture(extra = {}, historyFor = PID) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-dump-payload-'));
  const resultFile = path.join(dir, '.g009.result.json');
  fs.writeFileSync(resultFile, JSON.stringify({
    prompt_id: PID,
    params: { mode: 'edit', width: 1152, height: 2048, image_model: 'qwen21' },
    prompt_used: '正向：柜面近景',
    seed_used: 42,
    elapsed_s: 17.2,
    ...extra,
  }));
  const historyFile = path.join(dir, 'history.json');
  fs.writeFileSync(historyFile, JSON.stringify({
    [historyFor]: { prompt: [0, historyFor, GRAPH, {}, {}] },
  }));
  return { dir, resultFile, historyFile };
}

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

test('单节点同时给正负向时，两个字段都被认出来', () => {
  const { dir, resultFile, historyFile } = makeFixture();
  const md = path.join(dir, 'report.md');
  const r = run([resultFile, '--history', historyFile, '--out', md]);
  assert.equal(r.status, 0, `应成功：${r.stderr}`);
  const text = fs.readFileSync(md, 'utf8');
  assert.match(text, /正向：柜面近景/, 'positive 应进报告');
  assert.match(text, /负向：卡通，动漫/, 'negative 应进报告');
  // 两个字段都在节点 7 —— 这正是 2.1 与老家族的结构差异，认错就只剩一半
  assert.match(text, /节点 7 `TextEncodeQwenImage21`/);
});

test('采样参数按 class_type 认，不按节点号', () => {
  const { dir, resultFile, historyFile } = makeFixture();
  const md = path.join(dir, 'report.md');
  const r = run([resultFile, '--history', historyFile, '--out', md]);
  assert.equal(r.status, 0, r.stderr);
  const text = fs.readFileSync(md, 'utf8');
  assert.match(text, /steps=25 cfg=1 euler\/simple/);
  assert.match(text, /unet=qwen_image_2\.1_bf16\.safetensors/);
  assert.match(text, /参考图 scene\.png/);
});

test('中间层改动量算得出来（本仓 prompt 与进模型的字数差）', () => {
  // 本仓 4 字符 vs 进模型 7 字符 —— 差就是中间层（上游 build_*）加的那一截
  const { dir, resultFile, historyFile } = makeFixture({ prompt_used: '正向：柜' });
  const md = path.join(dir, 'report.md');
  const r = run([resultFile, '--history', historyFile, '--out', md]);
  assert.equal(r.status, 0, r.stderr);
  const text = fs.readFileSync(md, 'utf8');
  assert.match(text, /本仓下发的提示词：4 字符/);
  assert.match(text, /进 ComfyUI 的 positive：7 字符/);
  assert.match(text, /中间层改动：\+3 字符/, `应算出差值：\n${text}`);
});

test('取不到提交原文时退出码 1，不产出空报告', () => {
  const { dir, resultFile, historyFile } = makeFixture({ prompt_id: undefined });   // 没走 ComfyUI 的记录
  const md = path.join(dir, 'never.md');
  const r = run([resultFile, '--history', historyFile, '--out', md]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /prompt_id/);
  assert.ok(!fs.existsSync(md), '失败时不该留下报告');
});

test('history 里没有这次提交时退出码 1', () => {
  const { dir, resultFile, historyFile } = makeFixture({}, 'some-other-id');
  const r = run([resultFile, '--history', historyFile, '--out', path.join(dir, 'x.md')]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /history/);
});

console.log('dump-payload: 5/5 passed');
