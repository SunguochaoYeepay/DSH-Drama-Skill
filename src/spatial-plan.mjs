/**
 * Deterministic spatial-plan compiler.
 *
 * The spatial plan is the director-facing layer: relations and named anchors
 * are resolved into the absolute positions and clips consumed by whitebox/1.
 * It deliberately does not call Blender or infer missing intent.
 */

const EPSILON = 1e-9;
const RELATIONS = new Set(['behind', 'in_front_of', 'left_of', 'right_of', 'near']);

function fail(message) {
  throw new Error(`空间计划无效：${message}`);
}

function finiteNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} 必须是有限数字`);
  return value;
}

function vec2(value, label) {
  if (!Array.isArray(value) || value.length !== 2) fail(`${label} 必须是 [x,y]`);
  return value.map((n, index) => finiteNumber(n, `${label}[${index}]`));
}

function angleVector(angle) {
  finiteNumber(angle, 'facing');
  const radians = angle * Math.PI / 180;
  // Whitebox convention: 0° points toward +Y; Blender Z rotation uses this basis.
  return [-Math.sin(radians), Math.cos(radians)];
}

function add(a, b, scale = 1) {
  return [a[0] + b[0] * scale, a[1] + b[1] * scale];
}

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1]];
}

function distance(a, b) {
  const d = sub(a, b);
  return Math.hypot(d[0], d[1]);
}

function facingOf(entity) {
  return Number.isFinite(entity.facing) ? entity.facing : 0;
}

function relationPosition(relation, target) {
  const targetPosition = target.position;
  const forward = angleVector(facingOf(target));
  const left = [-forward[1], forward[0]];
  const distanceValue = relation.distance ?? 1;
  finiteNumber(distanceValue, `${relation.type}.distance`);
  if (distanceValue < 0) fail(`${relation.type}.distance 不能为负数`);
  if (relation.type === 'behind') return add(targetPosition, forward, -distanceValue);
  if (relation.type === 'in_front_of') return add(targetPosition, forward, distanceValue);
  if (relation.type === 'left_of') return add(targetPosition, left, distanceValue);
  if (relation.type === 'right_of') return add(targetPosition, left, -distanceValue);
  if (relation.type === 'near') {
    const offset = vec2(relation.offset || [0, distanceValue], 'near.offset');
    return add(targetPosition, offset);
  }
  fail(`不支持的关系 ${relation.type}`);
}

function clonePosition(position) {
  return [Number(position[0].toFixed(6)), Number(position[1].toFixed(6))];
}

function resolveEntities(plan) {
  if (!plan || plan.schema !== 'spatial-plan/1') fail('schema 必须是 spatial-plan/1');
  if (!Number.isInteger(plan.total_frames) || plan.total_frames < 1) fail('total_frames 必须是正整数');
  if (![24, 30].includes(plan.fps)) fail('fps 必须是 24 或 30');
  if (!Array.isArray(plan.entities) || !plan.entities.length) fail('entities 不能为空');

  const entities = new Map();
  for (const entity of plan.entities) {
    if (!entity || typeof entity !== 'object' || typeof entity.id !== 'string' || !entity.id) fail('每个 entity 必须有 id');
    if (entities.has(entity.id)) fail(`entity id 重复：${entity.id}`);
    const resolved = {
      ...entity,
      position: entity.position ? vec2(entity.position, `${entity.id}.position`) : null,
      facing: entity.facing ?? 0,
    };
    if (!(typeof resolved.facing === 'string' && resolved.facing.startsWith('towards:'))) {
      finiteNumber(resolved.facing, `${entity.id}.facing`);
    }
    entities.set(entity.id, resolved);
  }

  const relations = plan.relations || [];
  if (!Array.isArray(relations)) fail('relations 必须是数组');
  const pending = relations.map((relation) => {
    if (!RELATIONS.has(relation?.type)) fail(`关系类型非法：${relation?.type}`);
    const subject = entities.get(relation.subject);
    const target = entities.get(relation.target);
    if (!subject || !target) fail(`关系 ${relation.type} 引用了不存在的实体`);
    if (subject.id === target.id) fail(`实体不能和自己建立 ${relation.type} 关系`);
    return relation;
  });
  // Resolve chains such as A behind B, B left_of C without guessing.
  let progress = true;
  while (pending.length && progress) {
    progress = false;
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const relation = pending[i];
      const subject = entities.get(relation.subject);
      const target = entities.get(relation.target);
      if (subject.position || !target.position) continue;
      subject.position = relationPosition(relation, target);
      pending.splice(i, 1);
      progress = true;
    }
  }
  if (pending.length) {
    const unresolved = pending.map((r) => `${r.subject} ${r.type} ${r.target}`).join('、');
    fail(`关系无法解析（目标缺少位置或存在循环）：${unresolved}`);
  }

  for (const entity of entities.values()) {
    if (!entity.position) fail(`实体 ${entity.id} 缺少 position 或可解析关系`);
  }
  return entities;
}

function resolveAnchor(anchor, entities, label) {
  if (Array.isArray(anchor)) return vec2(anchor, label);
  if (typeof anchor === 'string') {
    const entity = entities.get(anchor);
    if (!entity) fail(`${label} 引用了不存在的实体 ${anchor}`);
    return [...entity.position];
  }
  if (anchor && typeof anchor === 'object' && anchor.entity) {
    const entity = entities.get(anchor.entity);
    if (!entity) fail(`${label} 引用了不存在的实体 ${anchor.entity}`);
    const offset = vec2(anchor.offset || [0, 0], `${label}.offset`);
    return add(entity.position, offset);
  }
  fail(`${label} 必须是坐标、实体 id 或 {entity, offset}`);
}

function resolveFacing(value, subject, entities, label) {
  if (value === undefined || value === 'auto_move') return value;
  if (typeof value === 'number') {
    finiteNumber(value, label);
    return value;
  }
  if (typeof value === 'string' && value.startsWith('towards:')) {
    const target = entities.get(value.slice(8));
    if (!target) fail(`${label} 指向不存在的实体 ${value.slice(8)}`);
    return value;
  }
  fail(`${label} 必须是数字、auto_move 或 towards:<id>`);
}

function compileEntity(entity, plan, entities) {
  const total = plan.total_frames;
  const base = {
    asset_id: entity.id,
    kind: entity.kind,
    asset_type: entity.asset_type || entity.type,
    ...(entity.color === undefined ? {} : { color: entity.color }),
  };
  if (entity.kind === 'prop') {
    const path = entity.path || {};
    const waypoints = (path.waypoints || []).map((point, i) => {
      const p = point.length === 3 ? point : [...vec2(point, `${entity.id}.path.waypoints[${i}]`), 0];
      return p.map((n, axis) => finiteNumber(n, `${entity.id}.path.waypoints[${i}][${axis}]`));
    });
    if (waypoints.length < 2) fail(`${entity.id}.path.waypoints 至少需要 2 个点`);
    return { ...base, path: { ...path, frame_range: path.frame_range || [1, total], waypoints } };
  }

  const motions = entity.motions || [{
    frames: [1, total], from: entity.position, to: entity.position, animation: entity.animation || 'Idle_Loop', facing: entity.facing,
  }];
  if (!Array.isArray(motions) || !motions.length) fail(`${entity.id}.motions 不能为空`);
  const clips = motions.flatMap((motion, index) => {
    if (!Array.isArray(motion.frames) || motion.frames.length !== 2) fail(`${entity.id}.motions[${index}].frames 必须是 [起,止]`);
    const [startFrame, endFrame] = motion.frames;
    if (!Number.isInteger(startFrame) || !Number.isInteger(endFrame) || startFrame < 1 || endFrame > total || startFrame > endFrame) {
      fail(`${entity.id}.motions[${index}].frames 超出范围`);
    }
    const points = motion.waypoints
      ? motion.waypoints.map((point, pointIndex) => resolveAnchor(point, entities, `${entity.id}.motions[${index}].waypoints[${pointIndex}]`))
      : [
        resolveAnchor(motion.from ?? entity.position, entities, `${entity.id}.motions[${index}].from`),
        resolveAnchor(motion.to ?? motion.from ?? entity.position, entities, `${entity.id}.motions[${index}].to`),
      ];
    if (points.length < 2) fail(`${entity.id}.motions[${index}] 至少需要两个轨迹点`);
    const span = endFrame - startFrame;
    return points.slice(0, -1).map((start, segmentIndex) => {
      const end = points[segmentIndex + 1];
      const segmentStart = segmentIndex === 0
        ? startFrame
        : startFrame + Math.floor(span * segmentIndex / (points.length - 1)) + 1;
      const segmentEnd = segmentIndex === points.length - 2
        ? endFrame
        : startFrame + Math.floor(span * (segmentIndex + 1) / (points.length - 1));
      const facing = resolveFacing(motion.facing ?? entity.facing ?? 'auto_move', { ...entity, position: start }, entities, `${entity.id}.motions[${index}].facing`);
      return {
        frame_range: [segmentStart, segmentEnd],
        animation: motion.animation || entity.animation || 'Idle_Loop',
        start_pos: clonePosition(start),
        ...(distance(start, end) > EPSILON ? { end_pos: clonePosition(end) } : {}),
        facing,
        motion_curve: motion.motion_curve || 'ease',
        blend_frames: motion.blend_frames ?? 4,
        ...(motion.phase_offset === undefined ? {} : { phase_offset: motion.phase_offset }),
      };
    });
  });
  return { ...base, clips };
}

/** Compile a spatial-plan/1 document into the existing whitebox/1 contract. */
export function compileSpatialPlan(plan) {
  const entities = resolveEntities(plan);
  const assets = [...entities.values()].map((entity) => compileEntity(entity, plan, entities));
  const result = {
    schema: 'whitebox/1',
    scene_name: plan.scene_name,
    total_frames: plan.total_frames,
    fps: plan.fps,
    stage: plan.stage,
    assets,
    camera: plan.camera,
    outputs: plan.outputs || { video: true, stills: [1, plan.total_frames], screen_coords: true },
    notes: plan.notes || '由 spatial-plan/1 确定性编译生成',
    spatial_source: 'spatial-plan/1',
  };
  for (const relation of plan.relations || []) {
    const check = relationError(plan, result, relation);
    if (!check.ok) fail(`初始关系 ${relation.subject} ${relation.type} ${relation.target} 与运动起点冲突`);
  }
  return result;
}

export function relationError(plan, resolved, relation) {
  const entities = new Map((resolved.assets || []).map((asset) => [asset.asset_id, asset]));
  const subject = entities.get(relation.subject);
  const target = entities.get(relation.target);
  if (!subject || !target) return { ok: false, error: '实体不存在' };
  const sourceEntities = new Map((plan?.entities || []).map((entity) => [entity.id, entity]));
  const sourceTarget = sourceEntities.get(relation.target);
  const expected = relationPosition(relation, {
    position: target.position || target.clips?.[0]?.start_pos,
    // Relations are authored against the director-level entity heading. A
    // clip may intentionally face elsewhere during motion and must not
    // rewrite the initial spatial relation.
    facing: sourceTarget?.facing ?? target.facing ?? target.clips?.[0]?.facing ?? 0,
  });
  const actual = subject.position || subject.clips?.[0]?.start_pos;
  const error = distance(actual, expected);
  return { ok: error <= (relation.tolerance ?? 0.1), error_m: error, expected, actual };
}
