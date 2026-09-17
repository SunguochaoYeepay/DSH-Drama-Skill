import fs from 'node:fs';
import path from 'node:path';

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function resolveAssetPath(boardPath, ref, workspace = null) {
  if (!ref) return null;
  if (path.isAbsolute(ref)) return fs.existsSync(ref) ? path.normalize(ref) : null;

  const boardDir = path.dirname(path.resolve(boardPath));
  const candidates = [
    workspace ? path.resolve(workspace, ref) : null,
    path.resolve(boardDir, ref),
  ];
  let cursor = boardDir;
  while (true) {
    candidates.push(path.resolve(cursor, ref));
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return unique(candidates).find((candidate) => fs.existsSync(candidate)) || null;
}

export function identityContext(board, identityId) {
  const identity = (board.identities || []).find((item) => item.id === identityId);
  if (!identity) throw new Error(`造型 ${identityId} 不在 board.identities 中`);
  const character = (board.characters || []).find((item) => item.id === identity.character);
  if (!character) throw new Error(`造型 ${identityId} 引用了不存在的角色 ${identity.character}`);
  return { identity, character };
}

function sourceShotsForUnit(board, unit) {
  const wantedLines = new Set((unit.shots || []).flatMap((shot) => shot.lines || []));
  if (!wantedLines.size) return [];
  return (board.shots || []).filter((shot) =>
    (shot.source_lines || []).some((line) => wantedLines.has(line)));
}

export function sceneIdForUnit(board, unit) {
  const explicit = unique([
    unit.scene,
    ...(unit.shots || []).map((shot) => shot.scene),
  ]);
  if (explicit.length > 1) throw new Error(`${unit.id}: 一个生成单元跨越多个场景：${explicit.join(', ')}`);
  if (explicit.length === 1) return explicit[0];

  const inferred = unique(sourceShotsForUnit(board, unit).map((shot) => shot.scene));
  if (inferred.length > 1) throw new Error(`${unit.id}: 源台词落在多个场景，导演必须显式给 scene`);
  if (inferred.length === 1) return inferred[0];
  if ((board.scenes || []).length === 1) return board.scenes[0].id;
  throw new Error(`${unit.id}: 无法确定场景；多场景项目必须在导演镜头中提供 scene`);
}

export function propIdsForUnit(board, unit) {
  const explicit = unique([
    ...(unit.props || []),
    ...(unit.shots || []).flatMap((shot) => shot.props || []),
  ]);
  if (explicit.length) return explicit;
  return unique(sourceShotsForUnit(board, unit).flatMap((shot) => shot.props || []));
}

function requiredPath(boardPath, ref, label, workspace) {
  const file = resolveAssetPath(boardPath, ref, workspace);
  if (!file) throw new Error(`${label}缺少可用文件：${ref || '未填写'}`);
  return file;
}

/** Files that define the project's approved visual identities and environment. */
export function projectAssetFiles(board, boardPath, opts = {}) {
  const workspace = opts.workspace || null;
  return unique([
    ...(board.characters || []).map((item) => requiredPath(
      boardPath, item.portrait, `角色 ${item.name || item.id} 的肖像`, workspace)),
    ...(board.identities || []).map((item) => requiredPath(
      boardPath, item.sheet, `造型 ${item.name || item.id} 的身份图`, workspace)),
    ...(board.scenes || []).map((item) => requiredPath(
      boardPath, item.master, `场景 ${item.name || item.id} 的主图`, workspace)),
    ...(board.props || []).map((item) => requiredPath(
      boardPath, item.ref_image, `道具 ${item.name || item.id} 的参考图`, workspace)),
  ]);
}

export function unitAssets(board, boardPath, unit, opts = {}) {
  const workspace = opts.workspace || null;
  const cast = unique(unit.cast || (unit.shots || []).flatMap((shot) => shot.on_screen || []));
  const people = cast.map((identityId) => {
    const { identity, character } = identityContext(board, identityId);
    return {
      identityId,
      characterId: character.id,
      name: character.name || character.id,
      portrait: requiredPath(boardPath, character.portrait, `角色 ${character.name || character.id} 的肖像`, workspace),
      sheet: requiredPath(boardPath, identity.sheet, `造型 ${identity.name || identity.id} 的身份图`, workspace),
    };
  });

  const sceneId = sceneIdForUnit(board, unit);
  const scene = (board.scenes || []).find((item) => item.id === sceneId);
  if (!scene) throw new Error(`${unit.id}: 场景 ${sceneId} 不在 board.scenes 中`);
  const sceneMaster = requiredPath(boardPath, scene.master, `场景 ${scene.name || scene.id} 的主图`, workspace);

  const props = propIdsForUnit(board, unit).map((propId) => {
    const prop = (board.props || []).find((item) => item.id === propId);
    if (!prop) throw new Error(`${unit.id}: 道具 ${propId} 不在 board.props 中`);
    return {
      id: prop.id,
      name: prop.name || prop.id,
      file: requiredPath(boardPath, prop.ref_image, `道具 ${prop.name || prop.id} 的参考图`, workspace),
    };
  });

  return { cast, people, scene, sceneMaster, props };
}
