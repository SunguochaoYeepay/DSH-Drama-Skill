import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_PORT, parsePort, probe, waitReady } from '../cli/kanban.mjs';
import { startServer } from '../web/server.mjs';

/**
 * 启动器的行为：**先判断再动手** —— 端口上有本项目的看板就不重复起，
 * 是别人的服务就明确拒绝，没人时才起。判据是内容（/api/projects 的 JSON），不是端口。
 *
 * 依据：2026-09-23 用户要启动脚本；此前 `npm run kanban` 是前台进程，机器重启后
 * 服务不会自己回来（用户报「8787 打不开」时就是进程没了）。
 */
function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-launch-'));
  fs.mkdirSync(path.join(root, 'probe'), { recursive: true });
  fs.writeFileSync(path.join(root, 'probe', 'board.json'), JSON.stringify({ meta: { title: '探针' } }));
  return root;
}

test('端口取值：--port > 环境变量 > 默认，非法值直接报错', () => {
  assert.equal(parsePort([], {}), DEFAULT_PORT);
  assert.equal(parsePort([], { AIH_KANBAN_PORT: '9000' }), 9000);
  assert.equal(parsePort(['--port', '9100'], { AIH_KANBAN_PORT: '9000' }), 9100);
  assert.throws(() => parsePort(['--port', 'abc'], {}), /端口不合法/);
  assert.throws(() => parsePort(['--port', '70000'], {}), /端口不合法/);
});

test('没人监听时报 down，waitReady 会超时返回 false', async () => {
  const { server, port } = await startServer({ root: tmpRoot(), port: 0, gc: false });
  await new Promise((r) => server.close(r));            // 拿到一个刚空出来的端口
  assert.deepEqual(await probe(port), { up: false, kind: 'down' });
  assert.equal(await waitReady(port, { timeoutMs: 600, intervalMs: 100 }), false);
});

test('认得出本项目的看板，且 waitReady 会等到它就绪', async () => {
  const { server, port } = await startServer({ root: tmpRoot(), port: 0, gc: false });
  try {
    const p = await probe(port);
    assert.equal(p.up, true);
    assert.equal(p.kind, 'kanban', '本项目的 /api/projects 必须被认出来');
    assert.equal(await waitReady(port, { timeoutMs: 3000 }), true);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('端口被别的服务占着时判成 other（启动器据此拒绝重复起）', async () => {
  const other = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body>别人的服务</body></html>');
  });
  await new Promise((r) => other.listen(0, '127.0.0.1', r));
  const port = other.address().port;
  try {
    const p = await probe(port);
    assert.equal(p.up, true);
    assert.equal(p.kind, 'other');
    assert.equal(await waitReady(port, { timeoutMs: 600, intervalMs: 100 }), false, '别人的服务不算就绪');
  } finally {
    await new Promise((r) => other.close(r));
  }
});
