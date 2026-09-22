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
  units: [{ id: 'g001', content_duration_s: 5.2, keyframe: 'keyframes_render/g001.png',
    shots: [{ source: { unit: 'g001', shot: 's01' } }, { source: { unit: 'g001', shot: 's02' } }] }],
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

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test('listProjects：有板子的进下拉，空壳不进', () => {
  const projects = listProjects(ROOT);
  assert.deepEqual(projects, [{ name: 'alpha', title: '试拍剧' }]);
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

test('服务：页面 / 清单 / 快照 / 媒体 / 防穿越', async () => {
  const { server, port } = await startServer({ root: ROOT, port: 0 });
  const base = `http://127.0.0.1:${port}`;
  try {
    // 页面
    const page = await fetch(base + '/');
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes('分镜确认表'));

    // 剧目清单
    const projects = await (await fetch(base + '/api/projects')).json();
    assert.deepEqual(projects.projects, [{ name: 'alpha', title: '试拍剧' }]);

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
