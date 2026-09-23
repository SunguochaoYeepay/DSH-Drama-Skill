import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { startServer, regenerateArgs, isValidUnitId, keyframePromptPath, PROMPT_MAX_CHARS } from '../web/server.mjs';

/**
 * 「重出图片」端点（2026-09-23）。
 *
 * 它是看板里**唯一的执行类**动作，所以边界要钉死：
 * - 只跑**一个单元**（不给"跑全批"的口子）；
 * - 同一时刻只允许一个任务在跑；
 * - 跨源防护（`X-Kanban-Action` 头）照旧；
 * - 单元 id 要能进命令行，白名单不严就是命令注入；
 * - **它不签票** —— 这条由「服务端没有写 approvals 的路径」保证，测试只能钉住它的可见行为。
 */

/** 造一个探针剧目目录（有 board.json 就算数）。 */
function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-regen-'));
  const dir = path.join(root, 'probe');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'board.json'), JSON.stringify({ meta: { title: '重抽探针' } }));
  fs.writeFileSync(path.join(dir, 'render.plan.json'), JSON.stringify({ units: [{ id: 'g001' }] }));
  return { root, name: 'probe', dir };
}

/** 假 spawn：记录调用，并允许测试自己决定何时输出、何时结束。 */
function fakeSpawn() {
  const calls = [];
  const children = [];
  const impl = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    calls.push({ cmd, args, opts });
    children.push(child);
    return child;
  };
  return { impl, calls, children };
}

async function withServer(spawnImpl, fn) {
  const p = makeProject();
  const { server, port } = await startServer({
    root: p.root, port: 0, gc: false, webDist: os.tmpdir(), spawn: spawnImpl,
  });
  const base = `http://127.0.0.1:${port}`;
  const post = (body, { withAction = true } = {}) => fetch(`${base}/api/regenerate`, {
    method: 'POST',
    headers: withAction
      ? { 'Content-Type': 'application/json', 'X-Kanban-Action': '1' }
      : { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const status = (id) => fetch(`${base}/api/regenerate${id ? `?id=${id}` : ''}`).then((r) => r.json());
  try {
    await fn({ base, post, status, p });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('命令参数只跑一个单元，板子与计划的路径都在剧目里', () => {
  const args = regenerateArgs('/tmp/库/剧', 'g001');
  assert.deepEqual(args, [
    path.join('/tmp/库/剧', 'board.json'),
    '--direction', path.join('/tmp/库/剧', 'render.plan.json'),
    '--units', 'g001',
  ]);
});

test('单元 id 白名单：命令注入与额外参数都进不来', () => {
  for (const ok of ['g001', 'u_1', 'unit-2']) assert.equal(isValidUnitId(ok), true, ok);
  for (const bad of ['g001; rm -rf /', 'g001 --bailian-size 1024', 'a b', '../etc/passwd', '', 'x'.repeat(41)]) {
    assert.equal(isValidUnitId(bad), false, bad);
  }
});

test('重抽是写动作：缺 X-Kanban-Action 头一律 403，且不会起进程', async () => {
  const sp = fakeSpawn();
  await withServer(sp.impl, async ({ post }) => {
    const r = await post({ name: 'probe', unit: 'g001' }, { withAction: false });
    assert.equal(r.status, 403);
    assert.equal(sp.calls.length, 0, '被拦下的请求不该起进程');
  });
});

test('起重抽 → 轮询状态：running → done，且只调用了 keyframes.mjs --units 这一个单元', async () => {
  const sp = fakeSpawn();
  await withServer(sp.impl, async ({ post, status, p }) => {
    const r = await post({ name: 'probe', unit: 'g001' });
    assert.equal(r.status, 200);
    const { jobId } = await r.json();
    assert.ok(jobId);

    // 进程真的被起了：node cli/keyframes.mjs <剧目板子> --direction <计划> --units g001
    assert.equal(sp.calls.length, 1);
    const [cmd, args, opts] = [sp.calls[0].cmd, sp.calls[0].args, sp.calls[0].opts];
    assert.equal(cmd, process.execPath);
    assert.ok(args[0].endsWith(path.join('cli', 'keyframes.mjs')), args[0]);
    assert.equal(args[1], path.join(p.dir, 'board.json'));
    assert.deepEqual(args.slice(2), ['--direction', path.join(p.dir, 'render.plan.json'), '--units', 'g001']);
    assert.equal(opts.cwd, path.resolve('.'), 'cwd 必须是仓库根，CLI 靠它找 .env');

    assert.equal((await status(jobId)).state, 'running');

    sp.children[0].stdout.emit('data', Buffer.from('关键帧 g001 送模型…\n'));
    sp.children[0].emit('close', 0);
    const done = await status(jobId);
    assert.equal(done.state, 'done');
    assert.equal(done.exitCode, 0);
    assert.match(done.log, /送模型/);
  });
});

test('失败要如实回传：退出码与最后一段日志', async () => {
  const sp = fakeSpawn();
  await withServer(sp.impl, async ({ post, status }) => {
    const { jobId } = await (await post({ name: 'probe', unit: 'g001' })).json();
    sp.children[0].stderr.emit('data', Buffer.from('ComfyUI 连不上\n'));
    sp.children[0].emit('close', 1);
    const j = await status(jobId);
    assert.equal(j.state, 'failed');
    assert.equal(j.exitCode, 1);
    assert.match(j.log, /连不上/);
  });
});

test('同一时刻只允许一个任务在跑：第二个请求 409，且不会多起进程', async () => {
  const sp = fakeSpawn();
  await withServer(sp.impl, async ({ post }) => {
    await post({ name: 'probe', unit: 'g001' });
    const second = await post({ name: 'probe', unit: 'g001' });
    assert.equal(second.status, 409);
    assert.equal(sp.calls.length, 1);
  });
});

test('非法单元 id 与不存在的剧目都不起进程', async () => {
  const sp = fakeSpawn();
  await withServer(sp.impl, async ({ post }) => {
    assert.equal((await post({ name: 'probe', unit: 'g001; rm -rf /' })).status, 400);
    assert.equal((await post({ name: 'nope', unit: 'g001' })).status, 400);
    assert.equal(sp.calls.length, 0);
  });
});

test('没有任务时查状态是 404，不是空 200', async () => {
  const sp = fakeSpawn();
  await withServer(sp.impl, async ({ base }) => {
    const r = await fetch(`${base}/api/regenerate`);
    assert.equal(r.status, 404);
  });
});

/* ── 写提示词（看板唯一会写项目文件的地方）────────────────────────────── */

test('提示词落点只可能在剧目的 keyframe-prompts 里（单元 id 已过白名单）', () => {
  const p = keyframePromptPath(path.join('/tmp', '库', '剧'), 'g001');
  assert.equal(p, path.join('/tmp', '库', '剧', 'keyframe-prompts', 'g001.txt'));
});

test('写提示词：缺防护头 403、空文本/超长/非法单元都拒绝，合法写入带一个尾换行', async () => {
  const sp = fakeSpawn();
  await withServer(sp.impl, async ({ base, p }) => {
    const post = (body, withAction = true) => fetch(`${base}/api/keyframe-prompt`, {
      method: 'POST',
      headers: withAction
        ? { 'Content-Type': 'application/json', 'X-Kanban-Action': '1' }
        : { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    assert.equal((await post({ name: 'probe', unit: 'g001', text: 'x' }, false)).status, 403);
    assert.equal((await post({ name: 'probe', unit: 'g001', text: '   ' })).status, 400);
    assert.equal((await post({ name: 'probe', unit: '../x', text: 'x' })).status, 400);
    assert.equal((await post({ name: 'nope', unit: 'g001', text: 'x' })).status, 404);
    assert.equal((await post({ name: 'probe', unit: 'g001', text: 'x'.repeat(PROMPT_MAX_CHARS + 1) })).status, 400);

    const ok = await post({ name: 'probe', unit: 'g001', text: '  一个合法的提示词  ' });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).chars, 8);
    const written = fs.readFileSync(path.join(p.dir, 'keyframe-prompts', 'g001.txt'), 'utf8');
    assert.equal(written, '一个合法的提示词\n', '去掉首尾空白，补一个尾换行');
    // 只写这一个文件：目录里不该多出别的
    assert.deepEqual(fs.readdirSync(path.join(p.dir, 'keyframe-prompts')), ['g001.txt']);
  });
});

/* ── 签署（转交 review-gate 执行）──────────────────────────────────────── */

test('签署：阶段白名单之外一律拒绝，且不起进程', async () => {
  const sp = fakeSpawn();
  await withServer(sp.impl, async ({ base }) => {
    const post = (body) => fetch(`${base}/api/sign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Kanban-Action': '1' },
      body: JSON.stringify(body),
    });
    for (const stage of ['board', 'story', '', 'keyframes; rm -rf /']) {
      assert.equal((await post({ name: 'probe', stage })).status, 400, stage);
    }
    assert.equal(sp.calls.length, 0);
  });
});

test('签署 keyframes：起的是 review-gate approve，票由它落笔；失败原样回传', async () => {
  const sp = fakeSpawn();
  await withServer(sp.impl, async ({ base, p }) => {
    const post = () => fetch(`${base}/api/sign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Kanban-Action': '1' },
      body: JSON.stringify({ name: 'probe', stage: 'keyframes' }),
    });

    const pending = post();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(sp.calls.length, 1, '批准动作要落到唯一所有者身上');
    const args = sp.calls[0].args;
    assert.ok(args[0].endsWith(path.join('cli', 'review-gate.mjs')), args[0]);
    assert.deepEqual(args.slice(1, 4), ['approve', '--project', p.dir]);
    assert.deepEqual(args.slice(4, 6), ['--stage', 'keyframes']);

    sp.children[0].stdout.emit('data', Buffer.from('✓ 人工确认已记录：keyframes\n'));
    sp.children[0].emit('close', 0);
    const ok = await pending;
    assert.equal(ok.status, 200);
    assert.match((await ok.json()).output, /人工确认已记录/);

    // 失败那次：退出码 1 → 400，并把 CLI 的原文带回去
    const pending2 = post();
    await new Promise((r) => setTimeout(r, 30));
    sp.children[1].stderr.emit('data', Buffer.from('✗ 产物已变化，旧确认自动失效\n'));
    sp.children[1].emit('close', 1);
    const bad = await pending2;
    assert.equal(bad.status, 400);
    const j = await bad.json();
    assert.match(j.error, /退出码 1/);
    assert.match(j.output, /旧确认自动失效/);
  });
});
