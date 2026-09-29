import fs from 'node:fs';
import path from 'node:path';

/** 位移类动作：必须有 end_pos（原地动作不需要）。与 references/whitebox-json.md 同步。 */
export const LOCOMOTION = new Set([
  'Walk_Loop', 'Walk_Formal_Loop', 'Jog_Fwd_Loop', 'Sprint_Loop',
  'Crouch_Fwd_Loop', 'Swim_Fwd_Loop', 'Driving_Loop', 'Push_Loop',
  'Roll_RM', 'Sword_Attack_RM',
]);

export const STAGE_PRESETS = ['room', 'valley', 'platform', 'empty'];
export const PROP_TYPES = ['jet', 'missile', 'crate', 'car', 'train'];
export const CAMERA_TYPES = ['static', 'dolly-in', 'pan-follow', 'orbit'];
export const MOTION_CURVES = ['static', 'linear', 'ease'];

const DEFAULT_MENU = {
  roles: { male: { scale: 1, gray: 0.82 }, female: { scale: 0.95, gray: 0.62 }, kid: { scale: 0.7, gray: 0.44 } },
  animations: [],
};

/** 从资产库 manifest 构建校验菜单（角色档位 + 动作清单）。 */
export function loadMenu(assetsDir) {
  const file = path.join(assetsDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    roles: manifest.roles || DEFAULT_MENU.roles,
    animations: new Set(manifest.animations || []),
  };
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isPos2 = (v) => Array.isArray(v) && v.length === 2 && v.every(isNum);
const isPos3 = (v) => Array.isArray(v) && v.length === 3 && v.every(isNum);
const isFrameRange = (v, total) => Array.isArray(v) && v.length === 2
  && v.every((n) => Number.isInteger(n)) && v[0] >= 1 && v[1] <= total && v[0] <= v[1];

/**
 * 校验一份白膜规划 JSON。返回错误字符串数组（空 = 通过）。
 * 只校验，不修改；菜单外的资产/动作一律拒绝（AI 禁止编造）。
 */
export function validateWhitebox(doc, menu = DEFAULT_MENU) {
  const errors = [];
  const err = (msg) => errors.push(msg);
  const roles = menu.roles || DEFAULT_MENU.roles;
  const animations = menu.animations instanceof Set ? menu.animations : new Set(menu.animations || []);

  if (!doc || typeof doc !== 'object') return ['文档必须是 JSON 对象'];
  if (doc.schema !== 'whitebox/1') err(`schema 必须是 "whitebox/1"，收到：${doc.schema || '缺失'}`);
  if (!doc.scene_name || typeof doc.scene_name !== 'string') err('scene_name 必填');

  const total = doc.total_frames;
  if (!Number.isInteger(total) || total < 1 || total > 10000) err(`total_frames 必须是 1..10000 的整数，收到：${total}`);
  if (![24, 30].includes(doc.fps)) err(`fps 必须是 24 或 30，收到：${doc.fps}`);
  const T = Number.isInteger(total) ? total : 10000;

  // stage
  const stage = doc.stage || {};
  if (!STAGE_PRESETS.includes(stage.preset)) err(`stage.preset 必须是 ${STAGE_PRESETS.join('|')}，收到：${stage.preset || '缺失'}`);
  let bounds = null;
  if (stage.preset === 'room') {
    if (!isPos3(stage.size) || stage.size.some((n) => n <= 0)) {
      err('room 预设必须给 size：[x宽, y深, z高]，均为正数（米）');
    } else {
      bounds = { x: stage.size[0] / 2, y: stage.size[1] / 2 };
    }
  }
  const inBounds = (p, who) => {
    if (bounds && (Math.abs(p[0]) > bounds.x || Math.abs(p[1]) > bounds.y)) {
      err(`${who} 位置 [${p}] 超出房间边界 ±[${bounds.x}, ${bounds.y}]`);
    }
  };

  // assets
  const assets = doc.assets;
  if (!Array.isArray(assets) || assets.length === 0) {
    err('assets 至少要有一个');
  } else {
    const ids = new Set();
    for (const a of assets) {
      const who = `asset ${a?.asset_id || '?'}`;
      if (!a || typeof a !== 'object') { err('asset 必须是对象'); continue; }
      if (!/^[A-Za-z][\w-]*$/.test(a.asset_id || '')) err(`${who}：asset_id 必须字母开头（字母/数字/_/-）`);
      if (ids.has(a.asset_id)) err(`asset_id 重复：${a.asset_id}`);
      ids.add(a.asset_id);

      if (a.kind === 'character') {
        if (!Object.keys(roles).includes(a.asset_type)) {
          err(`${who}：asset_type 只能从菜单选 ${Object.keys(roles).join('|')}，收到：${a.asset_type}`);
        }
        // 同档位多人时用 color 覆盖灰度，否则画面糊成一片
        if (a.color !== undefined && !(isNum(a.color) && a.color >= 0 && a.color <= 1)) {
          err(`${who}：color 灰度必须 0..1`);
        }
        if (!Array.isArray(a.clips) || a.clips.length === 0) {
          err(`${who}：character 必须有 clips`);
        } else {
          let lastEnd = 0;
          for (const c of a.clips) {
            const cw = `${who} 的 clip`;
            if (!isFrameRange(c.frame_range, T)) { err(`${cw}：frame_range 必须是 [起,止] 且在 1..${T} 内`); continue; }
            if (c.frame_range[0] <= lastEnd) err(`${cw}：帧区间 [${c.frame_range}] 与前一段重叠`);
            lastEnd = c.frame_range[1];
            if (!animations.has(c.animation)) err(`${cw}：动画 "${c.animation}" 不在菜单里（禁止编造）`);
            if (!isPos2(c.start_pos)) err(`${cw}：start_pos 必填 [x, y]`);
            else inBounds(c.start_pos, cw);
            if (LOCOMOTION.has(c.animation)) {
              if (!isPos2(c.end_pos)) err(`${cw}：位移类动作 ${c.animation} 必须有 end_pos`);
              else inBounds(c.end_pos, cw);
            }
            if (c.facing === undefined) {
              err(`${cw}：facing 必填（auto_move | towards:<id> | 角度）`);
            } else if (!(c.facing === 'auto_move' || (typeof c.facing === 'string' && c.facing.startsWith('towards:')) || (isNum(c.facing) && c.facing >= 0 && c.facing <= 360))) {
              err(`${cw}：facing 非法：${JSON.stringify(c.facing)}`);
            }
            if (c.motion_curve !== undefined && !MOTION_CURVES.includes(c.motion_curve)) {
              err(`${cw}：motion_curve 必须是 ${MOTION_CURVES.join('|')}`);
            }
            const blend = c.blend_frames ?? 4;
            if (!Number.isInteger(blend) || blend < 3 || blend > 12) {
              err(`${cw}：blend_frames 必须 3..12（防姿态瞬移，0 过渡会被拒）`);
            }
            // 相位错开（可选）：同一动作挂多人时避免整齐划一
            if (c.phase_offset !== undefined && !(isNum(c.phase_offset) && c.phase_offset >= 0 && c.phase_offset < 1)) {
              err(`${cw}：phase_offset 必须是 0..1（不含 1）`);
            }
          }
        }
      } else if (a.kind === 'prop') {
        if (!PROP_TYPES.includes(a.asset_type)) {
          err(`${who}：prop asset_type 必须是内置基本体 ${PROP_TYPES.join('|')}，收到：${a.asset_type}`);
        }
        const p = a.path;
        if (!p || typeof p !== 'object') {
          err(`${who}：prop 必须有 path（刚体轨迹）`);
        } else {
          if (!isFrameRange(p.frame_range, T)) err(`${who}：path.frame_range 非法`);
          if (!Array.isArray(p.waypoints) || p.waypoints.length < 2 || !p.waypoints.every(isPos3)) {
            err(`${who}：path.waypoints 至少 2 个 [x,y,z]`);
          } else {
            for (const w of p.waypoints) {
              if (w[2] < 0) err(`${who}：waypoint [${w}] 穿地（z<0）`);
              if (bounds && (Math.abs(w[0]) > bounds.x || Math.abs(w[1]) > bounds.y)) err(`${who}：waypoint [${w}] 出墙`);
            }
          }
          if (p.motion_curve !== undefined && !MOTION_CURVES.includes(p.motion_curve)) {
            err(`${who}：path.motion_curve 必须是 ${MOTION_CURVES.join('|')}`);
          }
        }
        if (a.color !== undefined && !(isNum(a.color) && a.color >= 0 && a.color <= 1)) {
          err(`${who}：color 灰度必须 0..1`);
        }
      } else {
        err(`${who}：kind 必须是 character | prop，收到：${a.kind || '缺失'}`);
      }
    }

    // facing towards 引用检查（需要全集 id）
    for (const a of assets || []) {
      for (const c of a.clips || []) {
        if (typeof c.facing === 'string' && c.facing.startsWith('towards:')) {
          const ref = c.facing.slice(8);
          if (!ids.has(ref)) err(`${a.asset_id} 的 clip：facing towards:${ref} 指向不存在的 asset`);
        }
      }
    }

    // camera
    const cam = doc.camera;
    if (!cam || typeof cam !== 'object') {
      err('camera 必填');
    } else {
      if (!CAMERA_TYPES.includes(cam.type)) err(`camera.type 必须是 ${CAMERA_TYPES.join('|')}，收到：${cam.type || '缺失'}`);
      if (['pan-follow', 'orbit'].includes(cam.type)) {
        if (!cam.track) err(`camera.type=${cam.type} 必须给 track（注视的 asset_id）`);
        else if (!ids.has(cam.track)) err(`camera.track 指向不存在的 asset：${cam.track}`);
      }
      // 固定注视点（不跟踪资产时用）：[x, y] 或 [x, y, z]
      if (cam.look_at !== undefined) {
        const ok = Array.isArray(cam.look_at) && (cam.look_at.length === 2 || cam.look_at.length === 3)
          && cam.look_at.every(isNum);
        if (!ok) err('camera.look_at 必须是 [x, y] 或 [x, y, z]');
      }
      if (!Array.isArray(cam.keys) || cam.keys.length === 0) {
        err('camera.keys 至少 1 个');
      } else {
        if (cam.type !== 'static' && cam.keys.length < 2) err(`camera.type=${cam.type} 至少 2 个 key`);
        let lastF = 0; let lastAngle = null;
        for (const k of cam.keys) {
          if (!Number.isInteger(k.frame) || k.frame < 1 || k.frame > T) err(`camera key：frame 必须 1..${T} 的整数`);
          if (k.frame <= lastF) err(`camera key：frame 必须升序（${k.frame} 在 ${lastF} 之后）`);
          lastF = k.frame;
          if (!(isNum(k.dist) && k.dist > 0)) err(`camera key@${k.frame}：dist 必须为正`);
          if (!(isNum(k.height) && k.height >= 0)) err(`camera key@${k.frame}：height 必须 >= 0`);
          if (!(isNum(k.angle) && k.angle >= 0 && k.angle <= 360)) err(`camera key@${k.frame}：angle 必须 0..360`);
          if (!(isNum(k.fov) && k.fov >= 10 && k.fov <= 120)) err(`camera key@${k.frame}：fov 必须 10..120`);
          if (cam.type === 'orbit' && lastAngle !== null && isNum(k.angle) && k.angle <= lastAngle) {
            err(`camera key@${k.frame}：orbit 的 angle 必须单调递增`);
          }
          lastAngle = isNum(k.angle) ? k.angle : lastAngle;
        }
      }
      if (cam.shake !== undefined) {
        if (!isFrameRange(cam.shake.frame_range, T) || !(isNum(cam.shake.amp) && cam.shake.amp > 0)) {
          err('camera.shake 需要合法 frame_range 与正数 amp');
        }
      }
    }
  }

  // outputs
  const out = doc.outputs || {};
  const stills = out.stills ?? [];
  if (!Array.isArray(stills) || !stills.every((f) => Number.isInteger(f) && f >= 1 && f <= T)) {
    err(`outputs.stills 帧号必须都在 1..${T} 内`);
  }

  return errors;
}

/** 便捷入口：校验不通过时抛出聚合错误（中文，逐条列出）。 */
export function assertWhitebox(doc, menu) {
  const errors = validateWhitebox(doc, menu);
  if (errors.length) throw new Error(`白膜 JSON 校验未通过（${errors.length} 条）：\n- ${errors.join('\n- ')}`);
}
