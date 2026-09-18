import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSceneDesign, buildCharacterDesign, designReceipt } from '../src/asset-designers.mjs';

const board = { meta: { aspect: '9:16', style_prompt: '写实电影' } };
test('场景师只编译空间提示词并标记缺失信息', () => {
  const design = buildSceneDesign(board, { id: 's1', environment: '清晨厨房，木桌靠窗' });
  assert.equal(design.kind, 'scene_design');
  assert.match(design.prompt, /空镜/);
  assert.deepEqual(design.questions, []);
  assert.deepEqual(buildSceneDesign(board, { id: 's2' }).questions, ['请补充场景环境描述']);
});

test('人物造型师分离身份与造型并拒绝静默补全', () => {
  const design = buildCharacterDesign(board, { id: 'c1', face_prompt: '成年女性，短发' }, { id: 'i1', appearance_details: '米色风衣，淡妆' });
  assert.equal(design.character_id, 'c1');
  assert.equal(design.identity_id, 'i1');
  assert.match(design.prompt, /四视图/);
  assert.deepEqual(buildCharacterDesign(board, { id: 'c1' }, { id: 'i1' }).questions, ['请补齐脸部或造型描述']);
  assert.equal(designReceipt({ design, directorPath: 'board.direction.json', boardPath: 'board.json' }).status, 'director_review_pending');
});
