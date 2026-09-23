import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveRecordedPath, recordedPathCandidates, recordedPathFor, repoRootOf } from '../src/recorded-path.mjs';
import { approve, approvalStatus, fingerprint } from '../src/human-gates.mjs';

/**
 * 「记录下来的路径」→ 真实文件，以及**票里 artifacts 的顺序**（2026-09-23）。
 *
 * 两件事都是真实翻车换来的：
 * 1. 记录里的路径有三种历史写法（仓库相对 / 剧目相对 / 本机绝对），过去看板按剧目解析、
 *    CLI 按 cwd 解析 —— 往 `files[]` 里插一条**剧目相对**的去字幕片段，看板认、CLI 当它
 *    不存在，票看着"没失效"其实那条根本没生效（指纹照旧算的是原片）。
 * 2. `fingerprint()` 会把路径**排序**，而 `approve()` 把排序后的顺序写进 `artifacts` ——
 *    于是 `assemble-units` 取的 `artifacts[0]` 是字母序最小的那个，
 *    "在旁边放一条更好的版本（如去字幕版）再签票"天然不成立。
 */

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-recpath-'));
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const dir = path.join(repo, 'examples', 'demo');
  fs.mkdirSync(path.join(dir, 'units'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'units', 'a.mp4'), Buffer.from([0, 0, 0, 0x18]));
  fs.writeFileSync(path.join(dir, 'units', 'b_nosub.mp4'), Buffer.from([0, 0, 0, 0x18]));
  return { repo, dir };
}

test('仓库根认得出；仓库相对 / 剧目相对 / 本机绝对 三种写法都能解析到同一个文件', () => {
  const { repo, dir } = makeRepo();
  assert.equal(repoRootOf(dir), repo);
  const target = path.join(dir, 'units', 'a.mp4');
  assert.equal(resolveRecordedPath(dir, target), target, '绝对路径');
  assert.equal(resolveRecordedPath(dir, 'examples/demo/units/a.mp4'), target, '仓库相对');
  assert.equal(resolveRecordedPath(dir, 'units/a.mp4'), target, '剧目相对');
  assert.equal(resolveRecordedPath(dir, 'units\\a.mp4'), target, '反斜杠也认');
  assert.equal(resolveRecordedPath(dir, path.join(os.tmpdir(), '别处', 'a.mp4')), null, '既不猜也不编');
  assert.equal(resolveRecordedPath(dir, ''), null);
});

test('候选表：认出"仓库相对"形态时先按仓库根解释；表里的每个候选都是绝对路径', () => {
  const { dir } = makeRepo();
  const real = path.join(dir, 'units', 'a.mp4');
  const cands = recordedPathCandidates(dir, 'examples/demo/units/a.mp4');
  assert.equal(cands[0], real, '形如 <剧目仓库相对前缀>/… 的，先按仓库根解释');
  assert.ok(cands.every((c) => path.isAbsolute(c)));
  // 剧目相对形态：先按剧目目录
  const cands2 = recordedPathCandidates(dir, 'units/a.mp4');
  assert.equal(cands2[0], real);
});

test('写入用仓库相对；仓库外或本来就相对的，原样返回', () => {
  const { repo, dir } = makeRepo();
  assert.equal(recordedPathFor(dir, path.join(dir, 'units', 'a.mp4')), 'examples/demo/units/a.mp4');
  assert.equal(recordedPathFor(dir, 'units/a.mp4'), 'units/a.mp4');
  const outside = path.join(os.tmpdir(), '别的地方', 'x.png');
  assert.equal(recordedPathFor(dir, outside), outside);
  void repo;
});

test('签票：artifacts 按**调用方给的顺序**记（顺序有意义），哈希仍与顺序无关', () => {
  const { dir } = makeRepo();
  const nosub = path.join(dir, 'units', 'b_nosub.mp4');
  const plain = path.join(dir, 'units', 'a.mp4');
  // 调用方把"想用的那条"放在前面
  const t1 = approve(dir, 'clip', [nosub, plain], { id: 'g001', by: '测试' });
  assert.deepEqual(t1.artifacts, ['examples/demo/units/b_nosub.mp4', 'examples/demo/units/a.mp4']);
  assert.equal(t1.artifacts[0].includes('nosub'), true, '第一条就是调用方的主产物');

  // 换个顺序再签：哈希不变（同一批文件），但 artifacts 顺序跟着调用方走
  const t2 = approve(dir, 'clip', [plain, nosub], { id: 'g002', by: '测试' });
  assert.equal(t2.artifact_hash, t1.artifact_hash, '哈希与顺序无关');
  assert.deepEqual(t2.artifacts[0], 'examples/demo/units/a.mp4');

  // 校验只认哈希，不受顺序影响
  assert.equal(approvalStatus(dir, 'clip', [nosub, plain], 'g001').ok, true);
  assert.equal(approvalStatus(dir, 'clip', [plain, nosub], 'g002').ok, true);
  assert.equal(fingerprint([nosub, plain]).hash, fingerprint([plain, nosub]).hash);
});

test('票里 artifacts 去重：同一文件给两次只记一次，且不影响哈希', () => {
  const { dir } = makeRepo();
  const plain = path.join(dir, 'units', 'a.mp4');
  const t = approve(dir, 'clip', [plain, plain], { id: 'g003', by: '测试' });
  assert.deepEqual(t.artifacts, ['examples/demo/units/a.mp4']);
});
