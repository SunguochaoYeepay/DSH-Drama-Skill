/**
 * Director stage contract.
 *
 * This is the editable, director-facing layer. It keeps scene objects in a
 * stable 3D coordinate system (X/Z ground plane, Y up) and compiles to the
 * existing spatial-plan/1 contract instead of creating a second renderer.
 */
import { compileSpatialPlan } from './spatial-plan.mjs';

const TYPES = new Set(['character', 'prop', 'camera']);
const BUILDS = new Set(['male', 'female', 'child', 'kid']);
const CURVES = new Set(['static', 'linear', 'ease']);
const clone = (value) => structuredClone(value);
const isNum = (value) => typeof value === 'number' && Number.isFinite(value);
const fail = (message) => { throw new Error(`导演台场景无效：${message}`); };

function vec3(value, label) {
  if (!value || typeof value !== 'object' || !isNum(value.x) || !isNum(value.y) || !isNum(value.z)) {
    fail(`${label} 必须是 {x,y,z} 数字坐标`);
  }
  return { x: value.x, y: value.y, z: value.z };
}

function frameRange(value, total, label) {
  if (!Array.isArray(value) || value.length !== 2 || !value.every(Number.isInteger)
      || value[0] < 1 || value[1] > total || value[0] > value[1]) fail(`${label} 帧范围非法`);
  return value;
}

function ground(position) { return [position.x, position.z]; }

function colorValue(value) {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) return value;
  return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset + 1, offset + 3), 16) / 255);
}

function objectById(scene) {
  return new Map(scene.objects.map((object) => [object.id, object]));
}

export function validateDirectorStage(scene) {
  if (!scene || typeof scene !== 'object') fail('必须是对象');
  if (scene.schema !== 'director-stage/1') fail(`schema 必须是 director-stage/1，收到：${scene.schema || '缺失'}`);
  if (!scene.scene_name) fail('scene_name 必填');
  if (!Number.isInteger(scene.total_frames) || scene.total_frames < 1) fail('total_frames 必须是正整数');
  if (![24, 30].includes(scene.fps)) fail('fps 必须是 24 或 30');
  if (!Array.isArray(scene.objects) || !scene.objects.length) fail('objects 不能为空');
  const ids = new Set();
  for (const object of scene.objects) {
    if (!object || typeof object !== 'object' || typeof object.id !== 'string' || !object.id) fail('每个对象必须有 id');
    if (ids.has(object.id)) fail(`对象 id 重复：${object.id}`);
    ids.add(object.id);
    if (!TYPES.has(object.type)) fail(`${object.id}.type 必须是 character|prop|camera`);
    vec3(object.position, `${object.id}.position`);
    if (object.type === 'character') {
      if (!BUILDS.has(object.build)) fail(`${object.id}.build 必须是 male|female|child`);
      if (!isNum(object.facing)) fail(`${object.id}.facing 必须是数字`);
      const motions = object.motions || [{ frames: [1, scene.total_frames], from: object.position, to: object.position }];
      if (!Array.isArray(motions) || !motions.length) fail(`${object.id}.motions 不能为空`);
      for (const [index, motion] of motions.entries()) {
        frameRange(motion.frames, scene.total_frames, `${object.id}.motions[${index}]`);
        if (!motion.from || !motion.to) fail(`${object.id}.motions[${index}] 必须有 from 和 to`);
        vec3(motion.from, `${object.id}.motions[${index}].from`);
        vec3(motion.to, `${object.id}.motions[${index}].to`);
        if (motion.facing !== undefined && !isNum(motion.facing)
            && motion.facing !== 'auto_move' && !(typeof motion.facing === 'string' && motion.facing.startsWith('towards:'))) {
          fail(`${object.id}.motions[${index}].facing 非法`);
        }
        if (motion.motion_curve !== undefined && !CURVES.has(motion.motion_curve)) fail(`${object.id}.motions[${index}].motion_curve 非法`);
      }
    }
    if (object.type === 'camera') {
      if (!isNum(object.fov) || object.fov < 10 || object.fov > 120) fail(`${object.id}.fov 必须在 10..120`);
      if (!object.target || (!isNum(object.target.x) && typeof object.target.ref !== 'string')) fail(`${object.id}.target 必须是坐标或对象引用`);
    }
  }
  const byId = objectById(scene);
  for (const shot of scene.shots || []) {
    if (!shot || typeof shot.id !== 'string') fail('每个 shot 必须有 id');
    if (!byId.get(shot.camera_id) || byId.get(shot.camera_id).type !== 'camera') fail(`镜头 ${shot.id} 的 camera_id 无效`);
    if (!isNum(shot.duration) || shot.duration <= 0) fail(`镜头 ${shot.id} duration 必须为正数`);
  }
  return true;
}

function targetPoint(target, byId) {
  if (target?.ref) {
    const object = byId.get(target.ref);
    if (!object) fail(`机位 target 引用不存在：${target.ref}`);
    return [object.position.x, object.position.z];
  }
  return [target.x, target.z];
}

function compileCharacter(object, scene) {
  const motions = object.motions || [{ frames: [1, scene.total_frames], from: object.position, to: object.position }];
  return {
    id: object.id,
    kind: 'character',
    type: object.build === 'child' ? 'kid' : object.build,
    position: ground(object.position),
    color: colorValue(object.color),
    motions: motions.map((motion) => ({
      frames: motion.frames,
      from: ground(motion.from),
      to: ground(motion.to),
      animation: motion.animation || object.action || 'Idle_Loop',
      facing: motion.facing ?? object.facing,
      motion_curve: motion.motion_curve || 'ease',
      blend_frames: motion.blend_frames ?? 4,
      ...(motion.waypoints ? { waypoints: motion.waypoints.map((point) => ground(point)) } : {}),
    })),
  };
}

export function compileDirectorStage(scene, { shotId = null } = {}) {
  validateDirectorStage(scene);
  const byId = objectById(scene);
  const shot = shotId ? (scene.shots || []).find((item) => item.id === shotId) : null;
  if (shotId && !shot) fail(`找不到镜头：${shotId}`);
  const state = shot?.object_states || {};
  const objects = scene.objects.map((object) => {
    const snapshot = state[object.id] || {};
    const source = { ...object, ...snapshot, position: snapshot.position || object.position };
    if (object.type === 'character') return compileCharacter(source, scene);
    if (object.type === 'prop') {
      const p = source.position;
      return { id: object.id, kind: 'prop', type: object.asset_type || object.kind || 'crate', position: [p.x, p.z], color: colorValue(object.color),
        path: source.path || { frame_range: [1, scene.total_frames], waypoints: [[p.x, p.z, p.y], [p.x, p.z, p.y]], motion_curve: 'linear' } };
    }
    return null;
  }).filter(Boolean);
  const camera = byId.get(shot?.camera_id || scene.active_camera_id || scene.objects.find((o) => o.type === 'camera')?.id);
  if (!camera) fail('场景必须有机位');
  const target = camera.target?.ref ? targetPoint(camera.target, byId) : targetPoint(camera.target, byId);
  const result = {
    schema: 'spatial-plan/1', scene_name: shot ? `${scene.scene_name}-${shot.id}` : scene.scene_name,
    total_frames: scene.total_frames, fps: scene.fps, stage: scene.stage, entities: objects,
    camera: { type: camera.camera_type || 'static', framing: camera.framing || '', camera_side: camera.camera_side || 'front',
      readable_action: camera.readable_action || '', must_show: camera.must_show || [], look_at: target,
      keys: camera.keys || [{ frame: 1, angle: camera.angle || 270, dist: camera.distance || 7.5, height: camera.height || 1.8, fov: camera.fov }] },
    outputs: scene.outputs || { video: true, stills: [1, scene.total_frames], screen_coords: true },
    notes: scene.notes || '由 director-stage/1 编译',
  };
  return compileSpatialPlan(result);
}

export function createDirectorStage(scene_name, options = {}) {
  return { schema: 'director-stage/1', scene_name, total_frames: options.total_frames || 96, fps: options.fps || 24,
    stage: options.stage || { preset: 'room', size: [8, 8, 3.2] }, objects: [], shots: [],
    active_camera_id: null, outputs: { video: true, stills: [1, options.total_frames || 96], screen_coords: true } };
}
