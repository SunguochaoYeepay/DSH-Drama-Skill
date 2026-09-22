import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../web/server.mjs';
import { ARCHIVE_DIRNAME } from '../src/board-data.mjs';

/**
 * 管理动作（归档 / 恢复 / 删除）的 HTTP 行为测试。
 *
 * 两条底线在这里被钉住：
 * 1. **跨源防护**：本地服务也不能让浏览器里随便一个页面删掉项目；
 * 2. **删除必须过中文名校验**，且删除只走**注入的假回收站**（测试绝不碰真回收站）。
 *
 * 用 node:http 手写请求而不是 fetch —— 要完全控制 Origin 这类头。
 */

const HDR = { 'X-Kanban-Action': '1', 'Content-Type': 'application/json' };

function req(base, { method = 'GET', route = '/', headers = {}, body } = {}) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const r = http.request({
      hostname: u.hostname, port: u.port, path: route, method, headers,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* 非 JSON 响应留 null */ }
        resolve({ status: res.statusCode, headers: res.headers, body: data, json });
      });
    });
    r.on('error', reject);
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });
}

function newRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-actions-'));
  for (const [name, title] of [['alpha', '试拍剧'], ['beta', '此路是我开']]) {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.writeFileSync(path.join(root, name, 'board.json'), JSON.stringify({ meta: { title } }));
  }
  return root;
}

/** 起服务跑一段测试：注入假回收站、关掉定时清理。 */
async function withServer(fn) {
  const root = newRoot();
  const seen = [];
  const trash = (dir) => {
    seen.push(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true, verified: '假装进了回收站' };
  };
  const { server, port } = await startServer({ root, port: 0, gc: false, trash });
  try {
    await fn({ root, seen, base: `http://127.0.0.1:${port}` });
  } finally {
    server.close();
  }
}

// ── 跨源防护 ──────────────────────────────────────────────────────────────

test('写接口：缺 X-Kanban-Action 头 → 403（跨源防护第一道）', async () => {
  await withServer(async ({ root, seen, base }) => {
    const r = await req(base, {
      method: 'POST', route: '/api/archive',
      headers: { 'Content-Type': 'application/json' }, body: { name: 'alpha' },
    });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /X-Kanban-Action/);
    assert.equal(fs.existsSync(path.join(root, 'alpha')), true, '被拒的请求不能有任何副作用');
    assert.deepEqual(seen, []);
  });
});

test('写接口：外源 Origin → 403（跨源防护第二道）', async () => {
  await withServer(async ({ root, seen, base }) => {
    const r = await req(base, {
      method: 'POST', route: '/api/delete',
      headers: { ...HDR, Origin: 'http://evil.example' },
      body: { name: 'alpha', confirm: '试拍剧' },
    });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /跨源/);
    assert.equal(fs.existsSync(path.join(root, 'alpha')), true);
    assert.deepEqual(seen, [], '外源请求一下都不许碰回收站');
  });
});

test('写接口：同源 Origin 正常放行，防护不误伤自己人', async () => {
  await withServer(async ({ root, base }) => {
    const r = await req(base, {
      method: 'POST', route: '/api/archive',
      headers: { ...HDR, Origin: base }, body: { name: 'alpha' },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
  });
});

test('写接口：OPTIONS 预检直接 405，不回任何 CORS 头', async () => {
  await withServer(async ({ base }) => {
    const r = await req(base, { method: 'OPTIONS', route: '/api/delete', headers: HDR });
    assert.equal(r.status, 405);
    assert.equal(r.headers['access-control-allow-origin'], undefined, '回 CORS 头等于自己拆掉第一道防线');
  });
});

test('写接口：不支持的方法（GET / PUT）→ 405，不是 SPA 回退', async () => {
  await withServer(async ({ base }) => {
    assert.equal((await req(base, { route: '/api/delete' })).status, 405);
    assert.equal((await req(base, { method: 'PUT', route: '/api/archive', headers: HDR, body: {} })).status, 405);
  });
});

test('写接口：请求体不是 JSON 对象 → 400', async () => {
  await withServer(async ({ base }) => {
    const r = await req(base, { method: 'POST', route: '/api/archive', headers: HDR, body: [1, 2, 3] });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /JSON/);
  });
});

// ── 归档 / 恢复 ───────────────────────────────────────────────────────────

test('归档 → 主线清单消失、归档清单出现；恢复 → 原样回来', async () => {
  await withServer(async ({ root, base }) => {
    const before = (await req(base, { route: '/api/projects' })).json.projects.map((p) => p.name);
    assert.deepEqual(before, ['alpha', 'beta']);

    const a = await req(base, { method: 'POST', route: '/api/archive', headers: HDR, body: { name: 'alpha' } });
    assert.equal(a.status, 200);
    assert.equal(a.json.title, '试拍剧');

    const after = (await req(base, { route: '/api/projects' })).json.projects.map((p) => p.name);
    assert.deepEqual(after, ['beta'], '归档后主线不该还有它');

    const arch = (await req(base, { route: '/api/archived' })).json;
    assert.equal(arch.retentionDays, 7);
    assert.deepEqual(arch.archived.map((x) => x.name), ['alpha']);
    assert.equal(arch.archived[0].title, '试拍剧');
    assert.equal(arch.archived[0].daysLeft, 7);
    assert.equal(arch.archived[0].expired, false);

    const s = await req(base, { method: 'POST', route: '/api/restore', headers: HDR, body: { name: 'alpha' } });
    assert.equal(s.status, 200);
    assert.deepEqual((await req(base, { route: '/api/projects' })).json.projects.map((p) => p.name), ['alpha', 'beta']);
    assert.deepEqual((await req(base, { route: '/api/archived' })).json.archived, []);
    assert.equal(fs.existsSync(path.join(root, 'alpha', 'board.json')), true);
  });
});

test('归档：归档区已有同名 → 400，如实报错', async () => {
  await withServer(async ({ root, base }) => {
    await req(base, { method: 'POST', route: '/api/archive', headers: HDR, body: { name: 'alpha' } });
    fs.mkdirSync(path.join(root, 'alpha'), { recursive: true });   // 主线又冒出一个同名的
    const again = await req(base, { method: 'POST', route: '/api/archive', headers: HDR, body: { name: 'alpha' } });
    assert.equal(again.status, 400);
    assert.match(again.json.error, /已有同名/);
  });
});

// ── 删除 ──────────────────────────────────────────────────────────────────

test('删除：缺 confirm → 400，且回显期望的中文标题（界面拿它做提示）', async () => {
  await withServer(async ({ root, seen, base }) => {
    const r = await req(base, { method: 'POST', route: '/api/delete', headers: HDR, body: { name: 'beta' } });
    assert.equal(r.status, 400);
    assert.equal(r.json.expected, '此路是我开');
    assert.equal(fs.existsSync(path.join(root, 'beta')), true, '没确认就不许删');
    assert.deepEqual(seen, []);
  });
});

test('删除：confirm 写成目录名或残缺 → 400，一律不删', async () => {
  await withServer(async ({ root, seen, base }) => {
    for (const confirm of ['beta', '此路是我', '', '  ']) {
      const r = await req(base, { method: 'POST', route: '/api/delete', headers: HDR, body: { name: 'beta', confirm } });
      assert.equal(r.status, 400, `confirm=${JSON.stringify(confirm)} 应被拒`);
      assert.equal(r.json.expected, '此路是我开');
    }
    assert.equal(fs.existsSync(path.join(root, 'beta')), true);
    assert.deepEqual(seen, []);
  });
});

test('删除：confirm 逐字相等 → 200，且只走注入的回收站', async () => {
  await withServer(async ({ root, seen, base }) => {
    const r = await req(base, { method: 'POST', route: '/api/delete', headers: HDR, body: { name: 'beta', confirm: '此路是我开' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.title, '此路是我开');
    assert.deepEqual(seen, [path.join(root, 'beta')], '删除必须落到注入的回收站上');
    assert.equal(fs.existsSync(path.join(root, 'beta')), false);
    // 另一个剧目毫发无伤
    assert.equal(fs.existsSync(path.join(root, 'alpha', 'board.json')), true);
  });
});

test('删除：confirm 两侧多空格仍算通过（只忽略首尾空白）', async () => {
  await withServer(async ({ base }) => {
    const r = await req(base, { method: 'POST', route: '/api/delete', headers: HDR, body: { name: 'beta', confirm: '  此路是我开  ' } });
    assert.equal(r.status, 200);
  });
});

test('删除归档剧目：archived=true 走归档区路径', async () => {
  await withServer(async ({ root, seen, base }) => {
    await req(base, { method: 'POST', route: '/api/archive', headers: HDR, body: { name: 'beta' } });
    const r = await req(base, { method: 'POST', route: '/api/delete', headers: HDR, body: { name: 'beta', confirm: '此路是我开', archived: true } });
    assert.equal(r.status, 200);
    assert.deepEqual(seen, [path.join(root, ARCHIVE_DIRNAME, 'beta')]);
  });
});

test('删除归档剧目：archived 漏传 → 找不到主线那份，404（不会误删）', async () => {
  await withServer(async ({ root, seen, base }) => {
    await req(base, { method: 'POST', route: '/api/archive', headers: HDR, body: { name: 'beta' } });
    const r = await req(base, { method: 'POST', route: '/api/delete', headers: HDR, body: { name: 'beta', confirm: '此路是我开' } });
    assert.equal(r.status, 404);
    assert.equal(fs.existsSync(path.join(root, ARCHIVE_DIRNAME, 'beta')), true, '归档那份必须还在');
    assert.deepEqual(seen, []);
  });
});

test('删除：非法剧目名（穿越）→ 400，不碰文件系统', async () => {
  await withServer(async ({ seen, base }) => {
    for (const name of ['../x', 'a/b', '_archive', '.']) {
      const r = await req(base, { method: 'POST', route: '/api/delete', headers: HDR, body: { name, confirm: 'x' } });
      assert.equal(r.status, 400, `name=${name} 应被拒`);
    }
    assert.deepEqual(seen, []);
  });
});
