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

test('assembly checks aspect and refuses an unaudible final film', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-assemble-review-'));
  const boardPath = path.join(project, 'board.json');
  const storyPath = path.join(project, 'story.md');
  const directionPath = path.join(project, 'board.direction.json');
  const planPath = path.join(project, 'render.plan.json');
  fs.writeFileSync(boardPath, JSON.stringify({ meta: { project: 'assemble_review', aspect: '16:9' } }));
  fs.writeFileSync(storyPath, 'fixture story');
  fs.writeFileSync(directionPath, JSON.stringify({ version: 6 }));
  writeDirectionReceipt({ directionPath, boardPath, storyPath, model: DIRECTOR_MODEL, responseModel: DIRECTOR_MODEL });
  const unit = { id: 'g001', content_duration_s: 1, shots: [] };
  const plan = sealPlan({ units: [unit], provenance: makePlanProvenance({ boardPath, storyPath, directionPath }) });
  fs.writeFileSync(planPath, JSON.stringify(plan));
  const clip = path.join(project, 'clip.mp4');
  const source = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip], { encoding: 'utf8' });
  assert.equal(source.status, 0, source.stderr);
  fs.mkdirSync(path.join(project, 'units'));
  fs.writeFileSync(path.join(project, 'units', 'g001.result.json'), JSON.stringify({ files: [clip] }));
  approve(project, 'clip', [clip], { id: 'g001' });
  const run = () => spawnSync(process.execPath, [path.join(root, 'cli/assemble-units.mjs'), planPath], { encoding: 'utf8' });
  const valid = run();
  assert.equal(valid.status, 0, valid.stderr);
  const film = path.join(project, 'out', 'final.mp4');
  const probed = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=width,height', '-of', 'csv=p=0', film], { encoding: 'utf8' });
  assert.equal(probed.stdout.trim(), '864,480');

  const mute = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24',
    '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip], { encoding: 'utf8' });
  assert.equal(mute.status, 0, mute.stderr);
  approve(project, 'clip', [clip], { id: 'g001' });
  const invalid = run();
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /成片机器检查失败.*没有音轨/s);
});
