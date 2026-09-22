import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listProjects, loadProject, lineTextOf, relInside } from '../src/board-data.mjs';
import { startServer } from '../web/server.mjs';

/**
 * 看板测试：数据层纯函数 + HTTP 服务行为（真起服务、真请求）。
 * 夹具在临时目录里搭一个最小剧目 —— board/portrait/sheet/master 是假字节，
 * 但**结构与真实剧目一致**（字段名对齐 dsh-storyboard 核对过的契约）。
 */

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-kanban-'));
const PROJ = path.join(ROOT, 'alpha');
fs.mkdirSync(path.join(PROJ, 'keyframes_render'), { recursive: true });
fs.mkdirSync(path.join(PROJ, 'units'), { recursive: true });
fs.mkdirSync(path.join(PROJ, 'out'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'empty_shell'), { recursive: true }); // 没板子的空壳：不该进下拉

const board = {
  meta: { title: '试拍剧', project: 'alpha', logline: '一句话。', style: '写实', aspect: '9:16' },
  characters: [{ id: 'su_wan', name: '苏晚', portrait: 'assets/su_wan.png' }],
  identities: [{ id: 'su_wan_default', character: 'su_wan', name: '默认造型', sheet: 'assets/su_wan_default.png' }],
  scenes: [{ id: 'sc1', name: '机舱', master: 'assets/sc1.png' }],
  props: [],
  shots: [
    { id: 's01', duration_s: 3.2, action: '苏晚回头' },
    { id: 's02', duration_s: 2.0, action: '苏晚喊出那句话' },
  ],
};
fs.writeFileSync(path.join(PROJ, 'board.json'), JSON.stringify(board));
fs.writeFileSync(path.join(PROJ, 'story.md'), '第一行\n苏晚（急）：你别走\n旁白：门关上了\n');
fs.writeFileSync(path.join(PROJ, 'board.direction.json'), JSON.stringify({
  version: 6,
  units: [{
    id: 'u1', keyframe_start: '苏晚站在舱门口', why: '同一段连续时空',
    shots: [
      { n: 1, at: 0, duration_s: 3.2, framing: '中景', camera: '固定', action: '苏晚回头', lines: [2], cut: 'cut' },
      { n: 2, at: 3.2, duration_s: 2.0, framing: '近景', camera: '手持', action: '苏晚喊出那句话', lines: [3], cut: 'end',
        emotion_analysis: [{ character: 'su_wan_default', internal_state: '急', visible_behavior: '伸手', gaze: '看向门口' }] },
    ],
  }],
}));
fs.writeFileSync(path.join(PROJ, 'render.plan.json'), JSON.stringify({
  units: [{ id: 'g001', source_units: ['u1'], content_duration_s: 5.2, generation_duration_s: 5.17,
    scene: 'sc1', cast: ['su_wan'], audience_knows: '观众已知门开着', why: '同一段连续时空',
    keyframe: 'keyframes_render/g001.png',
    shots: [{ source: { unit: 'g001', shot: 's01' } }, { source: { unit: 'g001', shot: 's02' } }] }],
  totals: { content_duration_s: 5.2 },
}));
fs.writeFileSync(path.join(PROJ, 'review.approvals.json'), JSON.stringify({
  approvals: { direction: { artifact_hash: 'h1' }, clips: { g001: { artifact_hash: 'h2' } } },
}));
// result.json 里的 local_path 是**旧位置的绝对路径**（E 盘迁移形态）——
// 产物实体已随项目搬进 units/，读取层必须按「末级目录/文件名」找回来
const OLD_SNAPSHOT = path.join(ROOT, 'old_snapshot', 'units');
fs.mkdirSync(OLD_SNAPSHOT, { recursive: true });
fs.writeFileSync(path.join(PROJ, 'units', 'g001.result.json'), JSON.stringify({
  files: [{ local_path: path.join(OLD_SNAPSHOT, 'g001_clip_v1.mp4') }],
}));
fs.writeFileSync(path.join(PROJ, 'keyframes_render', 'g001.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
fs.writeFileSync(path.join(PROJ, 'units', 'g001_clip_v1.mp4'), Buffer.from([0x00, 0x00, 0x00, 0x18]));
fs.writeFileSync(path.join(PROJ, 'out', 'final.mp4'), Buffer.from([0x00, 0x00, 0x00, 0x20]));

// 前端产物夹具：服务应托管 dist 里的文件，且 Content-Type 正确
const DIST = path.join(ROOT, 'webdist');
fs.mkdirSync(path.join(DIST, 'assets'), { recursive: true });
fs.writeFileSync(path.join(DIST, 'index.html'), '<!DOCTYPE html><title>KANBAN_DIST_MARKER</title><div id="root"></div>');
fs.writeFileSync(path.join(DIST, 'assets', 'app.js'), 'console.log(1)');

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test('listProjects：有板子的进下拉，空壳不进', () => {
  const projects = listProjects(ROOT);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].name, 'alpha');
  assert.equal(projects[0].title, '试拍剧');
  assert.ok(projects[0].createdAt, '带创建时间（板子 mtime），供界面按时间倒序排');
});

test('listProjects：按创建时间倒序，时间相同的按目录名升序', () => {
  // 三个剧目，板子 mtime 分别 3 天前 / 今天 / 3 天前（与 c 撞同一刻）
  const base = Date.parse('2026-09-20T10:00:00Z');
  const mk = (name, mtime) => {
    const d = path.join(ROOT, name);
    fs.mkdirSync(d, { recursive: true });
    const f = path.join(d, 'board.json');
    fs.writeFileSync(f, JSON.stringify({ meta: { title: `剧${name}` } }));
    fs.utimesSync(f, new Date(mtime), new Date(mtime));
    return d;
  };
  mk('older_a', base - 86400000);
  mk('newest', base);
  mk('older_c', base - 86400000);   // 与 older_a 同一刻 → 按名字排 a 在 c 前

  const names = listProjects(ROOT).map((p) => p.name);
  assert.deepEqual(
    names.filter((n) => n !== 'alpha'),
    ['newest', 'older_a', 'older_c'],
    '新的在前；同刻的按目录名升序保证顺序稳定',
  );

  for (const n of ['older_a', 'newest', 'older_c']) fs.rmSync(path.join(ROOT, n), { recursive: true, force: true });
});

test('listProjects：板子 mtime 读不到时退回目录 mtime，不抛也不乱排', () => {
  const d = path.join(ROOT, 'no_board_time');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'board.json'), JSON.stringify({ meta: { title: '无时间剧' } }));
  const list = listProjects(ROOT);
  const found = list.find((p) => p.name === 'no_board_time');
  assert.ok(found, '仍要进清单');
  assert.ok(found.createdAt, '退回目录 mtime，不该是 null');
  fs.rmSync(d, { recursive: true, force: true });
});

test('loadProject：单元/关键帧/片段/票/资产一次给齐', () => {
  const snap = loadProject(ROOT, 'alpha');
  assert.equal(snap.error, undefined);
  assert.equal(snap.title, '试拍剧');
  // 单元：以生成计划为权威 —— 导演单元叫 u1、计划单元叫 g001（真实剧目的形态），
  // 可执行视图必须按计划编号走，关键帧/片段不受导演稿编号影响
  assert.equal(snap.units.length, 1);
  assert.equal(snap.units[0].id, 'g001');
  assert.equal(snap.units[0].keyframe, 'keyframes_render/g001.png');
  // 片段：local_path 指向旧盘快照，产物实体在项目 units/ 里 —— 按同名拷贝找回
  assert.equal(snap.units[0].clip, 'units/g001_clip_v1.mp4');
  assert.equal(snap.units[0].shotCount, 2);
  // 票
  assert.equal(snap.tickets.approvals.direction.artifact_hash, 'h1');
  assert.equal(snap.tickets.approvals.clips.g001.artifact_hash, 'h2');
  // 闸门摘要：clips 是按单元一张，所以单独按分母算
  assert.equal(snap.gates.direction.signed, true);
  assert.equal(snap.gates.story.signed, false);
  assert.deepEqual(snap.gates.clips.perUnit, { g001: true });
  assert.equal(snap.gates.clips.signed, true);
  assert.equal(snap.gates.clips.signedCount, 1);
  // 导演单元：lines 的行号已解成台词正文（前端不重复实现这套规则）
  assert.equal(snap.directionUnits.length, 1);
  assert.equal(snap.directionUnits[0].id, 'u1');
  assert.deepEqual(snap.directionUnits[0].shots[0].lines, [{ n: 2, text: '你别走' }]);
  assert.deepEqual(snap.directionUnits[0].shots[1].lines, [{ n: 3, text: '门关上了' }]);
  // 单元带上计划里的场景/出场/切分理由
  assert.equal(snap.units[0].scene, 'sc1');
  assert.deepEqual(snap.units[0].cast, ['su_wan']);
  assert.equal(snap.units[0].generationDuration, 5.17);
  // 文件就位标记
  assert.deepEqual(snap.files, {
    'story.md': true, 'board.direction.json': true, 'render.plan.json': true, 'review.approvals.json': true,
  });
  // 资产：肖像 / 身份图 / 场景 / 关键帧 / 片段 / 成片
  const keys = snap.assets.map((a) => a.key);
  for (const k of ['portrait:su_wan', 'sheet:su_wan_default', 'scene:sc1', 'kf:g001', 'clip:g001', 'final']) {
    assert.ok(keys.includes(k), `缺资产 ${k}`);
  }
  assert.equal(snap.finalRel, 'out/final.mp4');
});

test('relInside：项目外绝对路径返回 null（服务端喂不了）', () => {
  assert.equal(relInside(PROJ, 'assets/a.png'), 'assets/a.png');
  assert.equal(relInside(PROJ, path.join(PROJ, 'assets', 'a.png')), 'assets/a.png');
  assert.equal(relInside(PROJ, 'E:/other/x.png'), null);
  assert.equal(relInside(PROJ, ''), null);
});

test('lineTextOf：去「说话人（提示）：」前缀，取不到行给 null', () => {
  const story = '第一行\n苏晚（急）：你别走\n';
  assert.equal(lineTextOf(story, 2), '你别走');
  assert.equal(lineTextOf(story, 1), '第一行');
  assert.equal(lineTextOf(story, 99), null);
});

test('服务：前端产物 / 清单 / 快照 / 媒体 / 防穿越', async () => {
  const { server, port } = await startServer({ root: ROOT, port: 0, webDist: DIST });
  const base = `http://127.0.0.1:${port}`;
  try {
    // 前端产物：Content-Type 必须是 text/html —— 曾因 MIME 缺失退化成
    // application/octet-stream，浏览器不渲染直接白页
    const page = await fetch(base + '/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') || '', /^text\/html/);
    assert.ok((await page.text()).includes('KANBAN_DIST_MARKER'));

    // dist 内的静态资源按真实扩展名给 MIME
    const js = await fetch(base + '/assets/app.js');
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type') || '', /javascript/);

    // 单页应用：dist 里没有的路径回退 index.html，而不是 404
    const deep = await fetch(base + '/some/deep/route');
    assert.equal(deep.status, 200);
    assert.ok((await deep.text()).includes('KANBAN_DIST_MARKER'));

    // 穿越企图不得读到 dist 外的文件
    const escaped = await fetch(base + '/..%2F..%2Fboard.json');
    assert.ok((await escaped.text()).includes('KANBAN_DIST_MARKER'), '越界路径应回退首页，不吐露文件');

    // 剧目清单
    const projects = await (await fetch(base + '/api/projects')).json();
    assert.deepEqual(
      projects.projects.map((p) => `${p.name}|${p.title}`),
      ['alpha|试拍剧'],
    );
    assert.ok(projects.projects[0].createdAt, '清单带创建时间，界面按它倒序');

    // 快照
    const snap = await (await fetch(base + '/api/project?name=alpha')).json();
    assert.equal(snap.title, '试拍剧');
    assert.equal(snap.units[0].clip, 'units/g001_clip_v1.mp4');

    // 非法剧目名（400 拒绝）/ 不存在的剧目（404）
    assert.equal((await fetch(base + '/api/project?name=' + encodeURIComponent('..%2F..'))).status, 400);
    assert.equal((await fetch(base + '/api/project?name=nope')).status, 404);

    // 媒体：类型与字节都对
    const png = await fetch(base + '/media/alpha/keyframes_render/g001.png');
    assert.equal(png.status, 200);
    assert.equal(png.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await png.arrayBuffer()), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    // 目录穿越拒载
    const evil = await fetch(base + '/media/alpha/' + encodeURIComponent('..') + '%2F..%2Fetc');
    assert.equal(evil.status, 403);

    // 不存在的媒体
    assert.equal((await fetch(base + '/media/alpha/nope.png')).status, 404);
  } finally {
    server.close();
  }
});

test('服务：前端没构建时给构建引导页，不是白页也不是 500', async () => {
  const missing = path.join(ROOT, 'no-such-dist');
  const { server, port } = await startServer({ root: ROOT, port: 0, webDist: missing });
  const base = `http://127.0.0.1:${port}`;
  try {
    const r = await fetch(base + '/');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /^text\/html/);
    const html = await r.text();
    assert.ok(html.includes('尚未构建'));
    assert.ok(html.includes('npm run web:setup'), '引导页要给出确切命令');
    // 前端缺失不影响 API
    assert.equal((await fetch(base + '/api/projects')).status, 200);
  } finally {
    server.close();
  }
});
