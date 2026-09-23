import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { startServer, resolveRoots, findProjectDir, defaultRoots } from '../web/server.mjs';

/**
 * 剧目根可以不止一个（2026-09-23）。
 *
 * 起因：正式那份示例在 `examples/demo-show`，而看板只扫 `projects/`，
 * 于是有人把示例复制进 projects/ 才看得见 —— 副本里的交接凭证还写着原路径，
 * 重出一跑就被凭证校验拦下，两份数据也开始分叉。
 * 现在默认扫 `projects`（主根，可写）+ `examples`（只读）。
 *
 * 这套测试守住四件事：
 * 1. 多个根都列得出来，且标明来自哪个根、能不能写；
 * 2. **同名主根优先**（自己的项目不许被示例遮住）；
 * 3. 只读根里的剧目：读得到、媒体取得到、**但不能归档/删除**；
 * 4. 剧目名 →目录的解析对重出与签署同样生效（否则又会跑到错的路径上）。
 */

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-roots-'));
}

function makeProject(root, name, title = name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'board.json'), JSON.stringify({
    meta: { title, aspect: '9:16', style: 'realistic' }, shots: [], characters: [], identities: [], scenes: [], props: [],
  }));
  fs.writeFileSync(path.join(dir, 'render.plan.json'), JSON.stringify({ units: [{ id: 'g001' }] }));
  return dir;
}

test('parse：显式 root/roots 优先；AIH_PROJECTS_ROOT 用 ; 分隔且第一个是主根', () => {
  assert.deepEqual(resolveRoots({ roots: ['/a', '/b'] }), ['/a', '/b']);
  assert.deepEqual(resolveRoots({ root: '/only' }), ['/only']);
  assert.deepEqual(resolveRoots({ env: { AIH_PROJECTS_ROOT: '/p1;/p2' } }), ['/p1', '/p2']);
  // 都没给 → 默认两个根（本仓库里 projects 与 examples 都存在）
  const d = defaultRoots();
  assert.ok(d.length >= 1);
  assert.ok(d[0].endsWith(path.join('', 'projects')) || d[0].endsWith('projects'), d[0]);
});

test('findProjectDir：按根顺序找，主根优先；都没有就是 null', () => {
  const a = tmpRoot();
  const b = tmpRoot();
  makeProject(a, 'both');
  makeProject(b, 'both');
  makeProject(b, 'only-b');
  assert.equal(findProjectDir([a, b], 'both'), path.join(a, 'both'), '同名时主根优先');
  assert.equal(findProjectDir([a, b], 'only-b'), path.join(b, 'only-b'));
  assert.equal(findProjectDir([a, b], 'nope'), null);
  assert.equal(findProjectDir([a, b], 'both'), path.join(a, 'both'));
});

test('清单合并：两个根的剧目都在，带 root 与 writable；同名只出现主根那条', async () => {
  const primary = tmpRoot();
  const extra = tmpRoot();
  makeProject(primary, 'mine', '我的剧');
  makeProject(extra, 'demo-show', '示例剧');
  makeProject(extra, 'mine', '示例里的同名剧');   // 应被主根遮住
  const { server, port } = await startServer({ roots: [primary, extra], port: 0, gc: false, webDist: os.tmpdir() });
  try {
    const j = await (await fetch(`http://127.0.0.1:${port}/api/projects`)).json();
    const byName = Object.fromEntries(j.projects.map((p) => [p.name, p]));
    assert.deepEqual(Object.keys(byName).sort(), ['demo-show', 'mine']);
    assert.equal(byName.mine.writable, true, '主根的剧目可写');
    assert.equal(byName.mine.title, '我的剧', '同名时取主根那条');
    assert.equal(byName['demo-show'].writable, false, '只读根的剧目标记为不可写');
    assert.equal(byName['demo-show'].root, path.basename(extra));
    assert.deepEqual(j.roots, [path.basename(primary), path.basename(extra)]);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('只读根的剧目：读得到、媒体取得到，但归档/删除一律 400', async () => {
  const primary = tmpRoot();
  const extra = tmpRoot();
  makeProject(primary, 'mine');
  const demoDir = makeProject(extra, 'demo-show');
  fs.mkdirSync(path.join(demoDir, 'units'), { recursive: true });
  fs.writeFileSync(path.join(demoDir, 'units', 'x.mp4'), Buffer.from([0, 0, 0, 0x18]));

  const { server, port } = await startServer({ roots: [primary, extra], port: 0, gc: false, webDist: os.tmpdir() });
  const post = (route, body) => fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Kanban-Action': '1' },
    body: JSON.stringify(body),
  });
  try {
    const snap = await fetch(`http://127.0.0.1:${port}/api/project?name=demo-show`);
    assert.equal(snap.status, 200, '只读根的剧目照样读得到');

    const media = await fetch(`http://127.0.0.1:${port}/media/demo-show/units/x.mp4`);
    assert.equal(media.status, 200, '只读根的媒体也发得出去');

    for (const route of ['/api/archive', '/api/delete', '/api/restore']) {
      const r = await post(route, { name: 'demo-show', confirm: '示例剧' });
      assert.equal(r.status, 400, route);
      assert.match((await r.json()).error, /只读/, route);
    }
    // 主根那条照样可以归档（证明拦的是"根"而不是整个接口）
    const ok = await post('/api/archive', { name: 'mine' });
    assert.equal(ok.status, 200);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('重出与签署也按"多根解析"找剧目：不会跑到主根下的同名路径上', async () => {
  const primary = tmpRoot();
  const extra = tmpRoot();
  makeProject(primary, 'mine');
  makeProject(extra, 'demo-show');
  const calls = [];
  const fakeSpawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    calls.push(args);
    setImmediate(() => child.emit('close', 0));
    return child;
  };
  const { server, port } = await startServer({
    roots: [primary, extra], port: 0, gc: false, webDist: os.tmpdir(), spawn: fakeSpawn,
  });
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/regenerate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Kanban-Action': '1' },
      body: JSON.stringify({ name: 'demo-show', unit: 'g001', kind: 'keyframe' }),
    });
    assert.equal(r.status, 200);
    await new Promise((res) => setTimeout(res, 30));
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], path.join(extra, 'demo-show', 'board.json'),
      '跑的是只读根里那份的板子 —— 凭证里的路径才和它一致');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
