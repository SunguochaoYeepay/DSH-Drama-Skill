import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeDirectionReceipt } from '../src/direction-provenance.mjs';
import { makePlanProvenance, sealPlan } from '../src/plan-provenance.mjs';
import { approve } from '../src/human-gates.mjs';
import { DIRECTOR_MODEL } from '../src/config.mjs';

const root = path.resolve(import.meta.dirname, '..');

/** 生成一段定音量正弦音轨的测试片。 */
function makeClip(file, volume) {
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24',
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=44100,volume=${volume}`,
    '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

/** ebur128 测综合响度（LUFS）。逐时刻行里也有 I:，只认 Summary 段的最终值。 */
function integratedLufs(file) {
  const r = spawnSync('ffmpeg', ['-v', 'info', '-i', file, '-af', 'ebur128', '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  assert.equal(r.status, 0, r.stderr);
  const summary = r.stderr.slice(r.stderr.lastIndexOf('Summary:'));
  const m = summary.match(/I:\s*(-?[\d.]+) LUFS/);
  assert.ok(m, `ebur128 没报综合响度：${summary.slice(0, 500)}`);
  return Number(m[1]);
}

test('assembly scales clips to the project aspect and evens out loudness', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-assemble-review-'));
  const boardPath = path.join(project, 'board.json');
  const storyPath = path.join(project, 'story.md');
  const directionPath = path.join(project, 'board.direction.json');
  const planPath = path.join(project, 'render.plan.json');
  fs.writeFileSync(boardPath, JSON.stringify({ meta: { project: 'assemble_review', aspect: '16:9' } }));
  fs.writeFileSync(storyPath, 'fixture story');
  fs.writeFileSync(directionPath, JSON.stringify({ version: 6 }));
  writeDirectionReceipt({ directionPath, boardPath, storyPath, model: DIRECTOR_MODEL, responseModel: DIRECTOR_MODEL });
  const units = [
    { id: 'g001', content_duration_s: 2, shots: [] },
    { id: 'g002', content_duration_s: 2, shots: [] },
  ];
  const plan = sealPlan({ units, provenance: makePlanProvenance({ boardPath, storyPath, directionPath }) });
  fs.writeFileSync(planPath, JSON.stringify(plan));
  fs.mkdirSync(path.join(project, 'units'));
  // 两段素材原始响度差 ~20 dB：一个接近满幅、一个压到 0.06。
  makeClip(path.join(project, 'clip_loud.mp4'), '1.0');
  makeClip(path.join(project, 'clip_quiet.mp4'), '0.06');
  fs.writeFileSync(path.join(project, 'units', 'g001.result.json'),
    JSON.stringify({ files: [path.join(project, 'clip_loud.mp4')] }));
  fs.writeFileSync(path.join(project, 'units', 'g002.result.json'),
    JSON.stringify({ files: [path.join(project, 'clip_quiet.mp4')] }));
  approve(project, 'clip', [path.join(project, 'clip_loud.mp4')], { id: 'g001' });
  approve(project, 'clip', [path.join(project, 'clip_quiet.mp4')], { id: 'g002' });

  const before = Math.abs(integratedLufs(path.join(project, 'clip_loud.mp4'))
    - integratedLufs(path.join(project, 'clip_quiet.mp4')));
  assert.ok(before > 10, `夹具响度差应大于 10 LU 才有说服力，实测 ${before}`);

  const run = () => spawnSync(process.execPath, [path.join(root, 'cli/assemble-units.mjs'), planPath], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const valid = run();
  assert.equal(valid.status, 0, valid.stderr);

  const film = path.join(project, 'out', 'final.mp4');
  const probed = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=width,height', '-of', 'csv=p=0', film], { encoding: 'utf8' });
  assert.equal(probed.stdout.trim(), '864,480');
  // 成片不再做机器检查：能不能用由人在终审时判断，代码不拦。

  // 行为断言：两遍式 loudnorm 后，转码段的综合响度差必须收窄到 3 LU 以内
  // （原始差 >10 LU；不归一的话这差值会原样进成片接缝）。
  const segA = integratedLufs(path.join(project, '.tmp', 'assemble', '001_g001.mp4'));
  const segB = integratedLufs(path.join(project, '.tmp', 'assemble', '002_g002.mp4'));
  assert.ok(Math.abs(segA - segB) <= 3, `归一后段间响度差 ${Math.abs(segA - segB)} LU（${segA} / ${segB}），超过 3 LU`);
});
