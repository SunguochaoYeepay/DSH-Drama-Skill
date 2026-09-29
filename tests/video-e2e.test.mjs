import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommand, runNode } from './helpers/spawn.mjs';
import { FFMPEG } from '../src/runtime-paths.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const GATE = path.join(ROOT, 'cli', 'review-gate.mjs');
const ASSEMBLE = path.join(ROOT, 'cli', 'assemble-units.mjs');

function makeClip(file) {
  const r = runCommand(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '1', '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

test('视频 E2E：片段票 → 合成 → final 票，产物变化会让旧票失效', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-video-e2e-'));
  const units = path.join(project, 'units');
  fs.mkdirSync(units, { recursive: true });
  fs.writeFileSync(path.join(project, 'board.json'), JSON.stringify({ meta: { project: 'video-e2e', aspect: '16:9' } }));
  const plan = path.join(project, 'render.plan.json');
  fs.writeFileSync(plan, JSON.stringify({ version: 1, units: [{ id: 'g001', content_duration_s: 1, shots: [] }] }));
  const clip = path.join(project, 'clip.mp4');
  makeClip(clip);
  fs.writeFileSync(path.join(units, 'g001.result.json'), JSON.stringify({ files: [clip] }));
  const run = (script, args) => runNode([script, ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

  const approvedClip = run(GATE, ['approve', '--project', project, '--stage', 'clip', '--id', 'g001', '--artifacts', clip, '--by', 'E2E']);
  assert.equal(approvedClip.status, 0, approvedClip.stderr || approvedClip.stdout);
  const assembled = run(ASSEMBLE, [plan, '--out', path.join(project, 'out', 'final.mp4')]);
  assert.equal(assembled.status, 0, assembled.stderr || assembled.stdout);
  const final = path.join(project, 'out', 'final.mp4');
  assert.ok(fs.existsSync(final));
  const approvedFinal = run(GATE, ['approve', '--project', project, '--stage', 'final', '--artifacts', final, '--by', 'E2E']);
  assert.equal(approvedFinal.status, 0, approvedFinal.stderr || approvedFinal.stdout);

  fs.appendFileSync(clip, 'changed');
  const stale = run(GATE, ['status', '--project', project, '--stage', 'clip', '--id', 'g001', '--artifacts', clip]);
  assert.notEqual(stale.status, 0);
  assert.match(stale.stdout + stale.stderr, /变化|失效|不一致/);
  fs.rmSync(project, { recursive: true, force: true });
});
