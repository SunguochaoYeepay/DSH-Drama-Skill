import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { makeScriptReceipt, receiptPath } from '../src/script-provenance.mjs';
import { checkBoard } from '../src/board.mjs';
import { fixture, FIXTURE } from './fixtures/index.mjs';

test('registered story plus confirmed brief creates a valid board without model calls', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-board-init-'));
  const source = JSON.parse(fs.readFileSync(fixture(FIXTURE.script), 'utf8'));
  const storyPath = path.join(project, 'story.md');
  const briefPath = path.join(project, 'brief.json');
  const boardPath = path.join(project, 'board.json');
  fs.writeFileSync(storyPath, source.story.source);
  const receipt = makeScriptReceipt({ story: source.story.source, input: source.story.source, source: 'user_supplied' });
  receipt.confirmed_by = 'fixture';
  fs.writeFileSync(receiptPath(storyPath), JSON.stringify(receipt));
  fs.writeFileSync(briefPath, JSON.stringify({ meta: { ...source.meta, project: 'fixture_project' }, story: {
    synopsis: source.story.synopsis, beats: source.story.beats,
  } }));
  const root = path.resolve(import.meta.dirname, '..');
  const command = [path.join(root, 'cli/init-board.mjs'), '--story', storyPath, '--brief', briefPath, '--out', boardPath];
  const result = spawnSync(process.execPath, command, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const board = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
  assert.equal(checkBoard(board).errors.length, 0);
  assert.equal(board.meta.project, 'fixture_project');
  assert.ok(board.shots.some((shot) => shot.dialogue.length));
  assert.equal(board.meta.approvals.story, null);
  const repeated = spawnSync(process.execPath, command, { encoding: 'utf8' });
  assert.notEqual(repeated.status, 0);
  assert.match(repeated.stderr, /拒绝覆盖/);
});
