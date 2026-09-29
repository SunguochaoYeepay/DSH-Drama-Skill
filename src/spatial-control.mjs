/**
 * Decide when a director unit needs a deterministic whitebox layout.
 *
 * The draw specialist owns visual language. This module owns the hand-off to
 * the spatial planner; it never asks an image model to solve world position.
 */

const RELATION_WORDS = /面对面|相向|互相|相距|前后|左右|身后|面前|旁边|绕过|穿过|走到|跑到|靠近|远离|围着|座位|站在|坐在/u;
const MOTION_WORDS = /走|跑|奔跑|移动|转身|走近|走向|挥手|打招呼|递给|拿起|放下|坐下|起身/u;

const ROLE_COLORS = [
  [0.12, 0.42, 0.95],
  [0.95, 0.35, 0.12],
  [0.55, 0.18, 0.85],
  [0.16, 0.72, 0.42],
];

function textOf(unit, shot) {
  return [
    unit?.keyframe_start,
    unit?.end_state,
    ...(unit?.shots || []).map((item) => `${item.action || ''} ${item.keyframe_start || ''}`),
    shot?.action,
  ].filter(Boolean).join(' ');
}

function castOf(unit, shot) {
  return [...new Set([
    ...(unit?.keyframe_cast || []),
    ...(shot?.on_screen || []),
  ])];
}

function propIdsOf(unit, shot) {
  return [...new Set([...(unit?.props || []), ...(shot?.props || [])])];
}

/** Return a deterministic routing decision for the draw/whitebox hand-off. */
export function analyzeSpatialControl({ unit = {}, shot = {} } = {}) {
  const cast = castOf(unit, shot);
  const text = textOf(unit, shot);
  const explicit = unit.spatial_control?.required ?? shot.spatial_control?.required;
  const reasons = [];
  if (cast.length >= 2) reasons.push('multi_subject');
  if (RELATION_WORDS.test(text)) reasons.push('spatial_relation');
  if (MOTION_WORDS.test(text)) reasons.push('directed_motion');
  if ((shot.looks_at || []).length) reasons.push('look_target');
  if ((unit.action_complexity?.high_risk_events || []).some((event) =>
    ['large_displacement', 'spatial_reconfiguration', 'multi_actor_contact'].includes(event?.type))) {
    reasons.push('high_risk_spatial_event');
  }

  const required = explicit === false ? false : explicit === true
    ? true
    // Two people with a relation or directed action need an actual layout.
    : cast.length >= 2 && reasons.some((reason) => reason !== 'multi_subject');
  return {
    required,
    mode: required ? 'whitebox' : 'prompt_only',
    reasons: [...new Set(reasons)],
    cast,
    confidence: explicit === undefined ? 'inferred' : 'declared',
  };
}

function roleFor(board, identityId) {
  const identity = (board?.identities || []).find((item) => item.id === identityId);
  const character = identity && (board?.characters || []).find((item) => item.id === identity.character);
  const value = `${character?.gender || ''} ${character?.age_group || ''}`.toLowerCase();
  if (/kid|child|儿童|小孩|幼/u.test(value)) return 'kid';
  if (/female|woman|girl|女/u.test(value)) return 'female';
  return 'male';
}

function durationFrames(unit, shot, fps) {
  const seconds = Number(unit?.shots?.reduce((sum, item) => sum + Number(item.duration_s || 0), 0)
    || shot?.duration_s || 4);
  return Math.max(1, Math.round(seconds * fps));
}

function defaultEntity(identityId, index, board, totalFrames, control) {
  const distance = Number(control.distance_m ?? 2);
  if (!(distance > 0)) throw new Error('spatial_control.distance_m 必须是正数');
  const half = distance / 2;
  const positions = [[-half, 0], [half, 0]];
  if (index > 1) throw new Error('自动面对面布局最多支持两名角色；三人以上请提供 spatial_control.entities');
  const position = positions[index];
  return {
    id: identityId,
    kind: 'character',
    type: roleFor(board, identityId),
    color: ROLE_COLORS[index % ROLE_COLORS.length],
    position,
    facing: index === 0 ? 90 : 270,
    motions: [{
      frames: [1, totalFrames],
      from: position,
      to: position,
      animation: control.animation || 'Idle_Talking_Loop',
      facing: index === 0 ? 90 : 270,
    }],
  };
}

/**
 * Build a spatial-plan/1 document for a unit.
 *
 * Explicit `spatial_control.entities` is preferred. The face_to_face preset is
 * intentionally small and deterministic so a simple two-person scene can be
 * tested without an LLM inventing coordinates.
 */
export function buildSpatialPlanForUnit({ unit, shot = unit?.shots?.[0] || {}, board = {}, fps = 24 } = {}) {
  const decision = analyzeSpatialControl({ unit, shot });
  if (!decision.required) throw new Error(`${unit?.id || 'unit'} 不需要白膜：空间控制判定为 prompt_only`);
  const control = unit.spatial_control || {};
  const totalFrames = durationFrames(unit, shot, fps);
  const cast = decision.cast;
  const propIds = propIdsOf(unit, shot);
  const dogProp = propIds.find((id) => {
    const prop = (board.props || []).find((item) => item.id === id);
    return /dog|puppy|小狗|狗/u.test(`${id} ${prop?.name || ''} ${prop?.asset_type || ''}`);
  });
  const dogRequested = /小狗|小犬|幼犬|puppy|dog/u.test(textOf(unit, shot)) || control.layout === 'face_to_face_with_center_dog';
  const assumptions = [];
  if (cast.length === 2 && control.distance_m === undefined) assumptions.push('distance_m=2');
  let entities = Array.isArray(control.entities) && control.entities.length
    ? structuredClone(control.entities)
    : cast.map((id, index) => defaultEntity(id, index, board, totalFrames, control));
  if (dogRequested && !control.entities) {
    if (cast.length !== 2) throw new Error('“两人中间小狗”自动布局需要恰好两名人物');
    const dogId = dogProp || control.dog_id || 'DOG';
    entities.push({
      id: dogId,
      kind: 'prop',
      type: 'dog',
      asset_type: 'dog',
      color: [0.72, 0.48, 0.22],
      position: [0, 0],
      facing: 0,
      path: { waypoints: [[0, 0, 0], [0, 0, 0]], frame_range: [1, totalFrames] },
    });
  }
  const mustShow = entities.map((entity) => entity.id);
  const camera = control.camera || {
    type: 'static',
    framing: `${shot.framing || '全景'} ${cast.length}人同框`,
    camera_side: 'front',
    readable_action: shot.action || unit.keyframe_start || '人物关系清楚',
    must_show: mustShow,
    look_at: [0, 0, 1],
    keys: [{ frame: 1, angle: 180, dist: 6.5, height: 1.7, fov: 45 }],
  };
  return {
    schema: 'spatial-plan/1',
    scene_name: control.scene_name || `${unit.id || 'unit'}_whitebox`,
    total_frames: totalFrames,
    fps,
    stage: control.stage || { preset: 'room', size: [8, 8, 3.2] },
    entities,
    relations: control.relations || [],
    camera,
    outputs: { video: true, stills: [1, totalFrames], screen_coords: true },
    notes: `由导演单元 ${unit.id || 'unknown'} 的空间控制生成；${decision.reasons.join('、') || '显式白膜要求'}`,
    spatial_control: { ...decision, assumptions, ...(dogRequested ? { center_dog: true } : {}) },
  };
}
