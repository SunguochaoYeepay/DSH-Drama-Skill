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
