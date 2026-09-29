import { compileSpatialPlan } from './spatial-plan.mjs';

const DEG = Math.PI / 180;

function id(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[^A-Za-z]+/, 's_') || 'scene';
}

function positionAt(asset, frame) {
  if (asset.kind === 'prop') return asset.path.waypoints[0];
  let clip = asset.clips[0];
  for (const candidate of asset.clips) if (candidate.frame_range[0] <= frame) clip = candidate;
  const [f0, f1] = clip.frame_range;
  const p0 = clip.start_pos;
  const p1 = clip.end_pos || p0;
  const t = frame <= f0 ? 0 : frame >= f1 ? 1 : (frame - f0) / (f1 - f0);
  return [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t];
}

function facingAt(asset, clip, frame, assets) {
  const value = clip.facing;
  const start = clip.start_pos;
  const end = clip.end_pos || start;
  if (value === 'auto_move') return Math.atan2(-(end[0] - start[0]), end[1] - start[1]);
  if (typeof value === 'number') return value * DEG;
  if (typeof value === 'string' && value.startsWith('towards:')) {
    const target = assets.get(value.slice(8));
    if (!target) throw new Error(`towards 目标不存在：${value}`);
    const here = positionAt(asset, frame);
    const there = positionAt(target, frame);
    return Math.atan2(-(there[0] - here[0]), there[1] - here[1]);
  }
  return 0;
}

function keyframesForAsset(asset, assets) {
  const tracks = [];
  if (asset.kind === 'prop') return tracks;
  for (let i = 0; i < asset.clips.length; i += 1) {
    const clip = asset.clips[i];
    const [f0, f1] = clip.frame_range;
    const p0 = clip.start_pos;
    const p1 = clip.end_pos || p0;
    const z0 = facingAt(asset, clip, f0, assets);
    const z1 = facingAt(asset, clip, f1, assets);
    tracks.push(
      { id: `${asset.asset_id}_loc_x_${i}`, targetEntityId: asset.asset_id, property: 'location.x', keyframes: [{ frame: f0, value: p0[0] }, { frame: f1, value: p1[0] }] },
      { id: `${asset.asset_id}_loc_y_${i}`, targetEntityId: asset.asset_id, property: 'location.y', keyframes: [{ frame: f0, value: p0[1] }, { frame: f1, value: p1[1] }] },
      { id: `${asset.asset_id}_rot_z_${i}`, targetEntityId: asset.asset_id, property: 'rotationEuler.z', keyframes: [{ frame: f0, value: z0 }, { frame: f1, value: z1 }] },
    );
  }
  return tracks;
}

function generatorFor(asset) {
  if (asset.kind === 'character') {
    const height = asset.asset_type === 'kid' ? 1.25 : asset.asset_type === 'female' ? 1.7 : 1.8;
    return { shape: 'rounded_box', size: [0.45, 0.35, height], bevel: 0.08 };
  }
  if (asset.asset_type === 'table') return { shape: 'rounded_box', size: [2.8, 1.6, 1.1], bevel: 0.04 };
  if (asset.asset_type === 'chair') return { shape: 'rounded_box', size: [0.7, 0.7, 1.0], bevel: 0.04 };
  return { shape: 'cube', size: [0.7, 0.7, 0.7] };
}

export function compileDeepBlendScene(plan) {
  const whitebox = compileSpatialPlan(plan);
  const assets = new Map(whitebox.assets.map((asset) => [asset.asset_id, asset]));
  const entities = whitebox.assets.map((asset) => {
    const p = asset.kind === 'prop' ? asset.path.waypoints[0] : asset.clips[0].start_pos;
    const height = asset.kind === 'character' ? (asset.asset_type === 'kid' ? 1.25 : 1.75) : (asset.asset_type === 'table' ? 1.1 : 0.7);
    return {
      id: id(asset.asset_id), type: 'generator', generator: generatorFor(asset),
      materialId: `mat_${id(asset.asset_id)}`,
      transform: { location: [p[0], p[1], height / 2], rotationEuler: [0, 0, 0] },
      tags: [asset.kind, asset.asset_type, 'whitebox'],
    };
  });
  const materials = whitebox.assets.map((asset) => ({
    id: `mat_${id(asset.asset_id)}`, shader: 'principled',
    parameters: { baseColor: [...(Array.isArray(asset.color) ? asset.color : [asset.color ?? 0.5, asset.color ?? 0.5, asset.color ?? 0.5]), 1], roughness: 0.8 },
  }));
  const camera = plan.camera;
  const key = camera.keys[0];
  const target = camera.track ? positionAt(assets.get(camera.track), key.frame) : (camera.look_at || [0, 0, 1]);
  const az = key.angle * DEG;
  const cameraId = 'cam_main';
  const cameras = [{ id: cameraId, role: 'active-camera', lens: 36, transform: { location: [target[0] + key.dist * Math.cos(az), target[1] + key.dist * Math.sin(az), key.height] }, targetPoint: [target[0], target[1], target[2] ?? 1.2] }];
  return {
    schemaVersion: 'deepblend.scene/v1',
    project: { id: id(plan.scene_name), title: plan.scene_name, goal: plan.notes || '由 spatial-plan/1 编译的白膜空间预演', units: 'metric', fps: plan.fps, frameStart: 1, frameEnd: plan.total_frames, aspectRatio: '9:16', activeCamera: cameraId },
    entities, materials, cameras,
    lights: [{ id: 'key', type: 'area', energy: 800, size: 5, transform: { location: [2, -3, 5] } }],
    animationTracks: whitebox.assets.flatMap((asset) => keyframesForAsset(asset, assets)),
    shots: [{ id: 'shot_main', cameraId, frameRange: [1, plan.total_frames], description: [plan.camera.framing, plan.camera.readable_action, plan.notes].filter(Boolean).join('；') }],
    renderProfiles: { preview: { engine: 'eevee', resolution: [640, 360], samples: 16 }, final: { engine: 'eevee', resolution: [1080, 1920], samples: 64 } },
    world: { color: [0.12, 0.12, 0.12, 1], strength: 0.5 },
  };
}
