import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadProject } from '../src/board-data.mjs';

/**
 * `render.plan.json` 的 `units[].keyframe` 是**编译期写死的路径**，关键帧生成前必然不存在。
 * 看板若不查存在性，就会给不存在的文件渲染 `<img>` —— 裂图 + alt 文本漏到页面上
 * （desk_quake 2026-09-22 实测，用户在看板里看到 `src="/media/…/g001.png"`）。
 * 视频那一路（`clipOf`）一直是查的，这两条断言把数据层对齐的行为钉住。
 */
function probe({ withKeyframe }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-kf-slot-'));
  const dir = path.join(root, 'probe');
  fs.mkdirSync(path.join(dir, 'keyframes_render'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'board.json'), JSON.stringify({
    meta: { title: '关键帧槽位探针' }, shots: [], characters: [], identities: [], scenes: [], props: [],
  }));
  fs.writeFileSync(path.join(dir, 'render.plan.json'), JSON.stringify({
    units: [{ id: 'g001', keyframe: 'keyframes_render/g001.png' }],
  }));
  if (withKeyframe) fs.writeFileSync(path.join(dir, 'keyframes_render', 'g001.png'), 'png');
  return { root, name: 'probe' };
}

test('计划里写了关键帧路径、文件还不存在时，看板不当它已产出', () => {
  const p = probe({ withKeyframe: false });
  const snap = loadProject(p.root, p.name);
  assert.equal(snap.units[0].keyframe, null, '不存在的关键帧不该给出路径');
  assert.equal(snap.assets.filter((a) => a.group === '关键帧').length, 0, '不存在的关键帧不该进画廊');
});

test('关键帧文件真的存在时才给路径与画廊条目', () => {
  const p = probe({ withKeyframe: true });
  const snap = loadProject(p.root, p.name);
  assert.equal(snap.units[0].keyframe, 'keyframes_render/g001.png');
  assert.equal(snap.assets.filter((a) => a.group === '关键帧').length, 1);
});

/**
 * 连续性单元的实际稳定尾帧（`handoffs/<id>.stable-tail.png`）。
 * 用户 2026-09-23 问「这种图如果已生成了是不是也可以回显」—— 能和关键帧一样回显，
 * 但**必须查存在性**：没提出来时给 null，由前端说一句"还没提"，
 * 而不是渲染一个 404 的 <img>（那就是之前看板裂图的老毛病）。
 */
function handoffProbe({ withFrame }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-handoff-slot-'));
  const dir = path.join(root, 'probe');
  fs.mkdirSync(path.join(dir, 'handoffs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'board.json'), JSON.stringify({
    meta: { title: '尾帧槽位探针' }, shots: [], characters: [], identities: [], scenes: [], props: [],
  }));
  fs.writeFileSync(path.join(dir, 'render.plan.json'), JSON.stringify({
    units: [
      { id: 'g001', continuity: { mode: 'independent' } },
      { id: 'g002', continuity: { mode: 'reference_previous', previous_unit: 'g001' } },
    ],
  }));
  if (withFrame) fs.writeFileSync(path.join(dir, 'handoffs', 'g002.stable-tail.png'), 'png');
  return { root, name: 'probe' };
}

test('连续性单元提出尾帧后才回显；没提出、或本来就不是连续性单元都给 null', () => {
  const a = handoffProbe({ withFrame: true });
  const withFrame = loadProject(a.root, a.name);
  assert.equal(withFrame.units.find((u) => u.id === 'g002').handoffFrame, 'handoffs/g002.stable-tail.png');
  assert.equal(withFrame.units.find((u) => u.id === 'g001').handoffFrame, null, 'independent 单元没有尾帧这回事');

  const b = handoffProbe({ withFrame: false });
  const without = loadProject(b.root, b.name);
  assert.equal(without.units.find((u) => u.id === 'g002').handoffFrame, null, '还没提出尾帧 → null，不是坏路径');
});

/**
 * result.json 里 `local_path` 的历史写法：**相对仓库根**（`projects\<剧>\units\…`）。
 * `relInside` 对相对路径原样返回、不检查是否真在剧目内，于是看板拼出
 * `/media/<剧>/projects/<剧>/units/…` → 404（desk_quake 2026-09-23 实测）。
 * 修法是多候选 + 存在性校验，这条守住它。
 */
test('result.json 写「相对仓库根」的路径时，也要归一到剧目内相对路径', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-clip-rel-'));
  const dir = path.join(root, 'probe');
  fs.mkdirSync(path.join(dir, 'units'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'board.json'), JSON.stringify({
    meta: { title: '片段路径探针' }, shots: [], characters: [], identities: [], scenes: [], props: [],
  }));
  fs.writeFileSync(path.join(dir, 'render.plan.json'), JSON.stringify({ units: [{ id: 'g001' }] }));
  fs.writeFileSync(path.join(dir, 'units', 'g001.result.json'), JSON.stringify({
    files: [{ local_path: path.join('projects', 'probe', 'units', 'g001_clip_v1.mp4') }],
  }));
  fs.writeFileSync(path.join(dir, 'units', 'g001_clip_v1.mp4'), Buffer.from([0x00, 0x00, 0x00, 0x18]));

  const snap = loadProject(root, 'probe');
  assert.equal(snap.units[0].clip, 'units/g001_clip_v1.mp4', '砍掉仓库根前缀，落到剧目内相对路径');
});

test('产物实体根本不在剧目内时，clip 仍然是 null（不编造路径）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-clip-missing-'));
  const dir = path.join(root, 'probe');
  fs.mkdirSync(path.join(dir, 'units'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'board.json'), JSON.stringify({
    meta: { title: '片段缺失探针' }, shots: [], characters: [], identities: [], scenes: [], props: [],
  }));
  fs.writeFileSync(path.join(dir, 'render.plan.json'), JSON.stringify({ units: [{ id: 'g001' }] }));
  fs.writeFileSync(path.join(dir, 'units', 'g001.result.json'), JSON.stringify({
    files: [{ local_path: path.join('projects', 'probe', 'units', 'g001_clip_v1.mp4') }],
  }));

  const snap = loadProject(root, 'probe');
  assert.equal(snap.units[0].clip, null);
});
