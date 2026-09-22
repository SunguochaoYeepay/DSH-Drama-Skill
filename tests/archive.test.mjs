import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ARCHIVE_DIRNAME, MARKER, GC_LOG,
  archiveProject, restoreProject, listArchived, purgeProject,
  runGc, isExpired, confirmMatches, titleOf,
} from '../src/archive.mjs';
import { listProjects, isValidProjectName } from '../src/board-data.mjs';

/**
 * 归档 / 恢复 / 删除 / 到期清理的**行为**测试。
 *
 * 删除一律走**注入的假回收站** —— 测试绝不真往用户回收站里扔东西。
 * 真的回收站通道由 `.tmp/probe-trash2.mjs` 探针 + 手工冒烟验证（已确认：
 * 目录确实进回收站，且退出码不可信、只能靠状态验证）。
 */

const DAY = 24 * 60 * 60 * 1000;

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aih-archive-'));

/** 搭一个最小剧目：只要有 board.json（meta.title 是删除确认串的来源）加一点产物。 */
function makeProject(root, name, title) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'units'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'board.json'), JSON.stringify({ meta: { title } }));
  fs.writeFileSync(path.join(dir, 'units', 'g001.result.json'), '{"files":[]}');
  return dir;
}

/** 假回收站：记账 + 真删目录，返回成功。 */
function fakeTrash(seen) {
  return (dir) => {
    seen.push(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true, verified: '假装进了回收站' };
  };
}

// ── 归档 / 恢复 ───────────────────────────────────────────────────────────

test('归档：目录进 _archive、产物跟着走、标记记下时间与标题，主线清单不再有它', () => {
  const root = tmpRoot();
  makeProject(root, 'alpha', '试拍剧');
  const now = new Date('2026-09-22T10:00:00.000Z');

  const r = archiveProject(root, 'alpha', { now });

  assert.equal(r.ok, true);
  assert.equal(r.title, '试拍剧');
  assert.equal(r.archivedAt, now.toISOString());
  assert.equal(fs.existsSync(path.join(root, 'alpha')), false, '主线目录应已不在');
  const moved = path.join(root, ARCHIVE_DIRNAME, 'alpha');
  assert.equal(fs.existsSync(path.join(moved, 'units', 'g001.result.json')), true, '产物必须跟着走');

  const marker = JSON.parse(fs.readFileSync(path.join(moved, MARKER), 'utf8'));
  assert.equal(marker.archived_at, now.toISOString());
  assert.equal(marker.title, '试拍剧');

  assert.deepEqual(listProjects(root), [], '归档剧目不该出现在主线清单');
  assert.deepEqual(listArchived(root, { now }).map((x) => x.name), ['alpha']);
});

test('恢复：搬回主线、标记被清掉，归档清单清空', () => {
  const root = tmpRoot();
  makeProject(root, 'alpha', '试拍剧');
  archiveProject(root, 'alpha');

  assert.equal(restoreProject(root, 'alpha').ok, true);

  assert.equal(fs.existsSync(path.join(root, 'alpha', 'board.json')), true);
  assert.equal(fs.existsSync(path.join(root, 'alpha', MARKER)), false, '归档标记该被清掉');
  assert.deepEqual(listArchived(root), []);
  assert.deepEqual(listProjects(root).map((p) => p.name), ['alpha']);
});

test('归档：归档区已有同名 → 拒绝，且不动主线那一份', () => {
  const root = tmpRoot();
  makeProject(root, 'alpha', '第一版');
  archiveProject(root, 'alpha');
  makeProject(root, 'alpha', '第二版');

  const r = archiveProject(root, 'alpha');

  assert.equal(r.ok, false);
  assert.match(r.error, /已有同名/);
  assert.equal(titleOf(path.join(root, 'alpha'), 'alpha'), '第二版', '主线那份必须原样在');
});

test('恢复：主线已有同名 → 拒绝，绝不覆盖（两边都还在）', () => {
  const root = tmpRoot();
  makeProject(root, 'alpha', '要归档的');
  archiveProject(root, 'alpha');
  makeProject(root, 'alpha', '主线在用的');

  const r = restoreProject(root, 'alpha');

  assert.equal(r.ok, false);
  assert.match(r.error, /覆盖/);
  assert.equal(titleOf(path.join(root, 'alpha'), 'alpha'), '主线在用的');
  assert.equal(fs.existsSync(path.join(root, ARCHIVE_DIRNAME, 'alpha')), true, '归档那份不能被动');
});

test('归档 / 恢复不存在的剧目 → 明确报错，不抛异常', () => {
  const root = tmpRoot();
  assert.equal(archiveProject(root, 'nope').ok, false);
  assert.equal(restoreProject(root, 'nope').ok, false);
  assert.match(restoreProject(root, 'nope').error, /没有这个剧目/);
});

// ── 路径安全 ──────────────────────────────────────────────────────────────

test('剧目名校验：拒穿越、盘符、分隔符、点、归档区名', () => {
  for (const bad of ['..', '../x', 'a/b', 'a\\b', 'C:', 'C:\\x', '.', '..', ARCHIVE_DIRNAME, 'x..y', '', null, undefined]) {
    assert.equal(isValidProjectName(bad), false, `应拒：${String(bad)}`);
  }
  for (const ok of ['alpha', 'no_chute_v2', 'dashixiong.literal', '中文剧名']) {
    assert.equal(isValidProjectName(ok), true, `应放行：${ok}`);
  }
});

test('归档与删除都先过剧目名校验 —— 穿越企图进不了文件系统', () => {
  const root = tmpRoot();
  const seen = [];
  assert.equal(archiveProject(root, '../outside').ok, false);
  assert.equal(purgeProject(root, '../outside', { trash: fakeTrash(seen) }).ok, false);
  assert.deepEqual(seen, [], '非法名不该走到回收站那一步');
});

// ── 到期判定 ──────────────────────────────────────────────────────────────

test('到期判定：正好满 7 天算到期，差一秒不算', () => {
  const now = new Date('2026-09-22T00:00:00.000Z');
  assert.equal(isExpired(new Date(now.getTime() - 7 * DAY).toISOString(), now), true, '正好 7 天 → 到期');
  assert.equal(isExpired(new Date(now.getTime() - 7 * DAY + 1000).toISOString(), now), false, '差 1 秒 → 未到期');
  assert.equal(isExpired(new Date(now.getTime() - 8 * DAY).toISOString(), now), true, '8 天 → 到期');
  assert.equal(isExpired(null, now), false, '没有时间 → 不当成到期');
  assert.equal(isExpired('不是日期', now), false);
});

test('归档清单：剩余天数按保留期算；标记缺失时退回目录 mtime', () => {
  const root = tmpRoot();
  const now = new Date('2026-09-22T00:00:00.000Z');
  makeProject(root, 'alpha', '试拍剧');
  archiveProject(root, 'alpha', { now: new Date(now.getTime() - 2 * DAY) });

  const [a] = listArchived(root, { now });
  assert.equal(a.title, '试拍剧');
  assert.equal(a.daysLeft, 5);
  assert.equal(a.expired, false);

  // 标记被拿掉（手工挪进来的目录就是这形态）→ 退回 mtime，照样管得到
  const dir = path.join(root, ARCHIVE_DIRNAME, 'alpha');
  fs.rmSync(path.join(dir, MARKER));
  const old = new Date(now.getTime() - 8 * DAY);
  fs.utimesSync(dir, old, old);

  const [b] = listArchived(root, { now });
  assert.equal(b.expired, true, '标记缺失也得按 mtime 判到期，不能永远赖着');
  assert.ok(Math.abs(new Date(b.archivedAt) - old) < 5000, '归档时间应回落到目录 mtime');
});

// ── 到期清理 ──────────────────────────────────────────────────────────────

test('到期清理：只动到期的，未到期原样留着，流水账记下被清的', () => {
  const root = tmpRoot();
  const now = new Date('2026-09-22T00:00:00.000Z');
  makeProject(root, 'old_one', '老剧');
  makeProject(root, 'new_one', '新剧');
  archiveProject(root, 'old_one', { now: new Date(now.getTime() - 8 * DAY) });
  archiveProject(root, 'new_one', { now: new Date(now.getTime() - 2 * DAY) });

  const seen = [];
  const r = runGc(root, { now, trash: fakeTrash(seen) });

  assert.deepEqual(r.purged.map((x) => x.name), ['old_one']);
  assert.deepEqual(seen, [path.join(root, ARCHIVE_DIRNAME, 'old_one')], '只该对到期的那个动手');
  assert.equal(fs.existsSync(path.join(root, ARCHIVE_DIRNAME, 'old_one')), false);
  assert.equal(fs.existsSync(path.join(root, ARCHIVE_DIRNAME, 'new_one')), true, '未到期不许动');

  const log = fs.readFileSync(path.join(root, ARCHIVE_DIRNAME, GC_LOG), 'utf8');
  assert.match(log, /purged\told_one/);
  assert.match(log, /老剧/);
});

test('到期清理：删除失败要落进 failed 并记账，不许静默吞掉', () => {
  const root = tmpRoot();
  const now = new Date('2026-09-22T00:00:00.000Z');
  makeProject(root, 'stuck', '删不掉的');
  archiveProject(root, 'stuck', { now: new Date(now.getTime() - 9 * DAY) });

  const r = runGc(root, { now, trash: () => ({ ok: false, reason: '回收站不可用' }) });

  assert.deepEqual(r.purged, []);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].name, 'stuck');
  assert.equal(r.failed[0].error, '回收站不可用');
  assert.equal(fs.existsSync(path.join(root, ARCHIVE_DIRNAME, 'stuck')), true, '清理失败就得原地留着');
  assert.match(fs.readFileSync(path.join(root, ARCHIVE_DIRNAME, GC_LOG), 'utf8'), /FAILED\tstuck/);
});

test('到期清理：归档区根本不存在时安静返回，不抛', () => {
  const root = tmpRoot();
  const r = runGc(root, { trash: () => { throw new Error('不该被调用'); } });
  assert.deepEqual(r.purged, []);
  assert.deepEqual(r.failed, []);
});

// ── 删除确认串 ────────────────────────────────────────────────────────────

test('删除确认串：必须与中文标题逐字相等，只忽略首尾空白', () => {
  assert.equal(confirmMatches('此路是我开', '此路是我开'), true);
  assert.equal(confirmMatches('  此路是我开  ', '此路是我开'), true, '首尾空白不算差别');
  assert.equal(confirmMatches('此路是', '此路是我开'), false, '少一个字就不给删');
  assert.equal(confirmMatches('', '此路是我开'), false);
  assert.equal(confirmMatches(undefined, '此路是我开'), false);
  assert.equal(confirmMatches('gopher_toll', '此路是我开'), false, '目录名不能代替中文标题');
  assert.equal(confirmMatches('此路是我开!', '此路是我开'), false, '多标点也不算');
});

test('重名剧目：标题相同都能过 —— 定位靠「点的是哪一个」，确认串只证明知道在删什么', () => {
  const root = tmpRoot();
  makeProject(root, 'no_chute', '没说完的那句');
  makeProject(root, 'no_chute_v2', '没说完的那句');
  // 两个标题一样，但确认的是具体那一个
  assert.equal(confirmMatches('没说完的那句', titleOf(path.join(root, 'no_chute'), 'no_chute')), true);
  assert.equal(confirmMatches('没说完的那句', titleOf(path.join(root, 'no_chute_v2'), 'no_chute_v2')), true);

  const seen = [];
  const r = purgeProject(root, 'no_chute', { trash: fakeTrash(seen) });
  assert.equal(r.ok, true);
  assert.deepEqual(seen, [path.join(root, 'no_chute')], '删的必须是点中的那一个');
  assert.equal(fs.existsSync(path.join(root, 'no_chute_v2')), true, '同名另一个不许被牵连');
});

// ── 删除执行 ──────────────────────────────────────────────────────────────

test('删除：走注入的回收站，目录确实消失；目标不存在则报错且不调回收站', () => {
  const root = tmpRoot();
  makeProject(root, 'alpha', '试拍剧');
  const seen = [];

  const r = purgeProject(root, 'alpha', { trash: fakeTrash(seen) });
  assert.equal(r.ok, true);
  assert.deepEqual(seen, [path.join(root, 'alpha')]);
  assert.equal(fs.existsSync(path.join(root, 'alpha')), false);

  const miss = purgeProject(root, 'nope', { trash: () => { throw new Error('不该被调用'); } });
  assert.equal(miss.ok, false);
  assert.match(miss.error, /不存在/);
});

test('删除归档剧目：落点在归档区路径，不是主线路径', () => {
  const root = tmpRoot();
  makeProject(root, 'alpha', '试拍剧');
  archiveProject(root, 'alpha');
  const seen = [];

  const r = purgeProject(root, 'alpha', { archived: true, trash: fakeTrash(seen) });

  assert.equal(r.ok, true);
  assert.deepEqual(seen, [path.join(root, ARCHIVE_DIRNAME, 'alpha')]);
});

test('删除失败：回收站拒绝时如实报错，目录原地留着', () => {
  const root = tmpRoot();
  makeProject(root, 'alpha', '试拍剧');
  const r = purgeProject(root, 'alpha', { trash: () => ({ ok: false, reason: '目录消失了但回收站没增加' }) });
  assert.equal(r.ok, false);
  assert.equal(r.error, '目录消失了但回收站没增加');
  assert.equal(fs.existsSync(path.join(root, 'alpha')), true);
});
