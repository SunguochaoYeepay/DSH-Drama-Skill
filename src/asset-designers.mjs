import crypto from 'node:crypto';

const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function buildSceneDesign(board, scene) {
  if (!scene?.id) throw new Error('场景师缺少 scene.id');
  const style = board.meta?.style_prompt || board.meta?.style || '';
  const prompt = [
    style, scene.environment || '',
    `场景主图，${board.meta?.aspect || '需确认画幅'}，空镜。`,
    '固定空间结构、入口、窗户、家具相对位置和主光方向。',
    '画面中不出现人物、动物、临时道具、文字、水印或标注。',
  ].filter(Boolean).join(' ');
  return {
    kind: 'scene_design', scene_id: scene.id, source_scene: scene,
    anchors: { environment: scene.environment || null, aspect: board.meta?.aspect || null },
    prompt, questions: scene.environment ? [] : ['请补充场景环境描述'],
  };
}

export function buildCharacterDesign(board, character, identity) {
  if (!character?.id || !identity?.id) throw new Error('人物造型师需要 character.id 和 identity.id');
  const prompt = [
    character.face_prompt || '', identity.appearance_details || '',
    '人物身份图，锁定同一张脸、体型和造型连续性。',
    '四视图只允许视角变化，不出现文字、水印、场景或其他人物。',
  ].filter(Boolean).join(' ');
  return {
    kind: 'character_design', character_id: character.id, identity_id: identity.id,
    locked: { face: character.face_prompt || null, appearance: identity.appearance_details || null },
    prompt, questions: character.face_prompt && identity.appearance_details ? [] : ['请补齐脸部或造型描述'],
  };
}

export function designReceipt({ design, directorPath, boardPath }) {
  return { contract: 1, kind: design.kind, director_path: directorPath, board_path: boardPath, design_sha256: hash(design), status: 'director_review_pending' };
}
