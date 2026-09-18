/**
 * director.mjs — 「导演」这一步：把剧本交给一个 AI 导演，让他做镜头设计。
 *
 * ## 为什么要有「导演」这个角色
 *
 * 原来我打算写一套硬规则（只变距离就运镜、180 度线、节拍划分…）让代码自己排镜头。
 * **但规则能判"对不对"，判不了"好不好"**：
 *
 *   规则能说  ：只变距离别切                              → 对
 *   规则说不出：她说完「你果然是个木头」之后那半秒沉默，
 *              值得切到她脸上                            → 这是品味
 *
 * **品味要判断力，判断力得由「导演」做。**
 *
 * 而且**硬规则会限制他** —— 写成条款，他就只能在条款内活动，
 * 永远做不出条款没想到的东西。所以关系是：
 *
 *   **BRIEF.md 告诉他"什么是专业的"**（职业素养，不是条款）
 *   **这里校验"什么是不允许的"**（技术底线，尤其台词）
 *
 * ## 职责边界
 *
 *   台词        → ❌ 代码搬运（逐字保真，导演一个字都不许碰）
 *   镜头设计     → ✅ 导演（切在哪、景别、运镜、构图、光、朝向）
 *   ≤15s / 画幅 → ❌ 校验器（他可能忘，但不该被限制住创作）
 *
 * ## 死线
 *
 * **导演的输出里出现任何一句台词原文 → 直接报错。**
 * 台词用行号引用，原文由 `literal.mjs` 逐字搬。这事天生做不到"差不多对"。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runBailian } from './bailian-cli.mjs';
import { DIRECTOR_MODEL } from './config.mjs';
import { estimateSpeechSeconds } from './orchestrate.mjs';

/** 生成单元的上限（H3 的硬约束）。 */
export const MAX_UNIT_SECONDS = 15;
/** FastH3 短于这个时长仍会生成约 5 秒；多切单元会把成片静默撑长。 */
export const MIN_GENERATION_SECONDS = 5.17;
/** 契约总时长允许少量节奏余量，但不允许导演把短片扩成另一种片长。 */
export const MAX_DURATION_EXPANSION_RATIO = 1.1;
/** 当前校验器要求的最低导演契约版本。 */
export const MIN_DIRECTION_VERSION = 6;
/** 合法景别。 */
export const FRAMINGS = ['远景', '全景', '中景', '近景', '特写'];
/** H3 认的切镜用词。 */
export const CUT_PHRASES = [
  'the camera cuts to',
  'the shot cuts to',
  'the shot transitions to',
  'the shot changes to',
  'the shot switches to',
];
/** 朝向。 */
export const FACINGS = ['left', 'right', 'toward', 'away'];
/** H3 容易丢失中间状态的不可逆动作类型。 */
export const HIGH_RISK_EVENT_TYPES = [
  'multi_actor_contact',
  'possession_change',
  'appearance_or_disappearance',
  'large_displacement',
  'transformation',
  'spatial_reconfiguration',
];
export const ACTION_COMPLEXITY_LEVELS = ['low', 'medium', 'high'];
export const ACTION_STRATEGIES = ['none', 'single_transition', 'simplified_staging'];

// ---------------------------------------------------------------- 校验

/**
 * 校验导演交出来的东西。**纯函数**，可以离线断言。
 *
 * @param {object} dir 导演的输出
 * @param {object} ctx { board, script } —— 板子和剧本原文（用于核对台词与人物）
 * @returns {{ok:boolean, errors:string[], warnings:string[]}}
 */
export function validateDirection(dir, ctx = {}) {
  const errors = [];
  const warnings = [];
  const board = ctx.board || {};
  const script = ctx.script || '';

  if (!dir || typeof dir !== 'object') return { ok: false, errors: ['导演没交出对象'], warnings };
  if (!Array.isArray(dir.units) || !dir.units.length) {
    return { ok: false, errors: ['units 为空'], warnings };
  }

  const version = Number(dir.version);
  if (!Number.isFinite(version) || version < MIN_DIRECTION_VERSION) {
    errors.push(`version 必须至少是 ${MIN_DIRECTION_VERSION}（当前 ${String(dir.version)}）`);
  }

  const validIds = new Set([
    ...(board.identities || []).map((x) => x.id),
    ...(board.characters || []).map((c) => c.id),
  ]);
  const validSceneIds = new Set((board.scenes || []).map((scene) => scene.id));
  const validPropIds = new Set((board.props || []).map((prop) => prop.id));

  // 剧本里所有台词行 → 行号到文本
  const scriptLines = script.split(/\r?\n/);
  const dialogueLines = collectDialogueLines(board, scriptLines);
  const dialogueSeconds = collectDialogueSeconds(board);
  const v2 = version >= 2;
  const v3 = version >= 3;
  const v4 = version >= 4;
  const v5 = version >= 5;
  const v6 = version >= 6;

  const assignedLines = [];
  const unitIds = new Set();

  for (const [ui, unit] of dir.units.entries()) {
    const at = `units[${ui}]`;
    if (!unit || typeof unit !== 'object') { errors.push(`${at}: 不是对象`); continue; }
    if (!unit.id) errors.push(`${at}: 缺 id`);
    else if (unitIds.has(unit.id)) errors.push(`${at}: id "${unit.id}" 重复`);
    else unitIds.add(unit.id);
    if (v2) {
      if (!unit.why || !String(unit.why).trim()) errors.push(`${at}: v2 缺 why（为什么这样分生成单元）`);
      if (!unit.duration_reason || !String(unit.duration_reason).trim()) errors.push(`${at}: v2 缺 duration_reason（为什么是这个时长）`);
      if (!unit.keyframe_start || !String(unit.keyframe_start).trim()) errors.push(`${at}: v2 缺 keyframe_start（0 秒首帧状态）`);
    }
    if (v3) {
      const allowed = ui === 0
        ? ['opening']
        : ['scene_change', 'time_jump', 'identity_anchor', 'spatial_reset', 'state_transition_anchor', 'engine_limit'];
      if (!allowed.includes(unit.boundary_trigger)) {
        errors.push(`${at}: boundary_trigger "${unit.boundary_trigger || ''}" 不合法；可用 ${allowed.join('/')}`);
      }
      const unitCast = new Set((unit.shots || []).flatMap((shot) => shot.on_screen || []));
      if (!Array.isArray(unit.keyframe_cast) || !unit.keyframe_cast.length) {
        errors.push(`${at}: v3 缺 keyframe_cast（0 秒关键帧需要身份锚定的角色）`);
      } else {
        if (unit.keyframe_cast.length > 2) errors.push(`${at}: keyframe_cast 最多 2 名角色（本地 Qwen 还需要 1 个场景参考位）`);
        for (const id of unit.keyframe_cast) {
          if (!unitCast.has(id)) errors.push(`${at}: keyframe_cast 里的 "${id}" 不在本单元 on_screen 中`);
        }
        // 名字搜索只能发现一部分可疑遗漏：别名、代词、同名普通词都会造成漏报或误报。
        // 因此这里只给 warning，不能把字符串命中冒充完整的首帧人物结构证明。
        if (typeof unit.keyframe_start === 'string') {
          const anchoredCharacters = new Set(unit.keyframe_cast.map((id) => {
            const identity = (board.identities || []).find((x) => x.id === id);
            return identity ? identity.character : id;
          }));
          for (const character of board.characters || []) {
            if (anchoredCharacters.has(character.id)) continue;
            const name = String(character.name || '').trim();
            if (name && unit.keyframe_start.includes(name)) {
              warnings.push(`${at}: keyframe_start 可能出现了未被锚定的角色「${name}」——`
                + `他会被模型画进来却没有参考图，服装只能由模型自己编。`
                + `要么把该角色的造型加进 keyframe_cast，要么把他从首帧描述里删掉。`);
            }
          }
        }
      }
    }
    if (v4) {
      const complexity = unit.action_complexity;
      if (!complexity || typeof complexity !== 'object' || Array.isArray(complexity)) {
        errors.push(`${at}: v4 缺 action_complexity（H3 动作复杂度分析）`);
      } else {
        if (!ACTION_COMPLEXITY_LEVELS.includes(complexity.level)) {
          errors.push(`${at}: action_complexity.level "${complexity.level || ''}" 不合法`);
        }
        if (!ACTION_STRATEGIES.includes(complexity.strategy)) {
          errors.push(`${at}: action_complexity.strategy "${complexity.strategy || ''}" 不合法`);
        }
        if (!Array.isArray(complexity.high_risk_events)) {
          errors.push(`${at}: action_complexity.high_risk_events 必须是数组`);
        } else {
          for (const [ei, event] of complexity.high_risk_events.entries()) {
            const eat = `${at}.action_complexity.high_risk_events[${ei}]`;
            if (!event || typeof event !== 'object') { errors.push(`${eat}: 不是对象`); continue; }
            if (!HIGH_RISK_EVENT_TYPES.includes(event.type)) {
              errors.push(`${eat}: type "${event.type || ''}" 不合法`);
            }
            if (!event.description || !String(event.description).trim()) errors.push(`${eat}: 缺 description`);
            if (typeof event.at_s !== 'number' || event.at_s < 0) errors.push(`${eat}: at_s 必须是非负数`);
          }
          if (complexity.high_risk_events.length > 1) {
            errors.push(
              `${at}: 同一生成单元声明了 ${complexity.high_risk_events.length} 个高风险状态转换；`
              + 'FastH3 只允许一个。请简化表演，或用 state_transition_anchor 拆成多个单元',
            );
          }
          if (complexity.high_risk_events.length === 0 && complexity.strategy !== 'none') {
            errors.push(`${at}: 没有高风险状态转换时 strategy 必须是 none`);
          }
          if (complexity.high_risk_events.length === 1 && complexity.strategy === 'none') {
            errors.push(`${at}: 有高风险状态转换时必须声明 single_transition 或 simplified_staging`);
          }
        }
      }
    }
    if (v6) {
      if (!unit.end_state || !String(unit.end_state).trim()) errors.push(`${at}: v6 缺 end_state（本单元实际应停在哪个稳定状态）`);
      const continuity = unit.continuity;
      if (!continuity || typeof continuity !== 'object' || Array.isArray(continuity)) {
        errors.push(`${at}: v6 缺 continuity`);
      } else if (ui === 0) {
        if (continuity.mode !== 'independent') errors.push(`${at}: 第一单元 continuity.mode 必须是 independent`);
      } else if (!['independent', 'continue_previous'].includes(continuity.mode)) {
        errors.push(`${at}: continuity.mode 必须是 independent 或 continue_previous`);
      } else if (continuity.mode === 'continue_previous') {
        const previousId = dir.units[ui - 1]?.id;
        if (continuity.previous_unit !== previousId) errors.push(`${at}: continuity.previous_unit 必须是紧邻上一单元 ${previousId}`);
        if (!continuity.handoff_state || !String(continuity.handoff_state).trim()) errors.push(`${at}: 连续单元缺 handoff_state`);
        if (continuity.deferred_keyframe !== true) errors.push(`${at}: 连续单元必须 deferred_keyframe=true，等待上一段实际稳定尾帧`);
        if (!Array.isArray(continuity.allowed_changes)) errors.push(`${at}: continuity.allowed_changes 必须是数组`);
      }
    }
    if (!Array.isArray(unit.shots) || !unit.shots.length) { errors.push(`${at}: shots 为空`); continue; }

    let prevAt = -1;
    let prevDuration = 0;

    for (const [si, shot] of unit.shots.entries()) {
      const sat = `${at}.shots[${si}]`;

      // --- n：从 1 开始，连续不跳号
      if (shot.n !== si + 1) errors.push(`${sat}: n 应该是 ${si + 1}，实际 ${shot.n}`);

      // --- at：第 1 镜为 0，之后严格递增
      if (typeof shot.at !== 'number') errors.push(`${sat}: at 不是数字`);
      else if (si === 0 && shot.at !== 0) errors.push(`${sat}: 第 1 镜的 at 必须是 0，实际 ${shot.at}`);
      else if (si > 0 && shot.at <= prevAt) errors.push(`${sat}: at(${shot.at}) 必须大于上一镜(${prevAt})`);

      // --- duration_s
      if (typeof shot.duration_s !== 'number' || shot.duration_s <= 0) {
        errors.push(`${sat}: duration_s 必须是正数`);
      }
      const end = (shot.at || 0) + (shot.duration_s || 0);
      if (end > MAX_UNIT_SECONDS + 1e-6) {
        errors.push(`${sat}: 结束于 ${end.toFixed(2)}s，超过单元上限 ${MAX_UNIT_SECONDS}s`);
      }

      // --- framing
      if (!FRAMINGS.includes(shot.framing)) {
        errors.push(`${sat}: framing "${shot.framing}" 不在 ${FRAMINGS.join('/')}`);
      }

      // --- camera 必填（运镜是导演的核心工具，不写等于没设计）
      if (!shot.camera || !String(shot.camera).trim()) errors.push(`${sat}: 缺 camera（运镜）`);

      // --- scene / props：资源只能从板子契约取，执行器不按项目名或人物猜
      if (!shot.scene) {
        if (validSceneIds.size > 1) errors.push(`${sat}: 多场景项目必须显式写 scene`);
      } else if (!validSceneIds.has(shot.scene)) {
        errors.push(`${sat}: scene "${shot.scene}" 不在板子里`);
      }
      if (shot.props !== undefined) {
        if (!Array.isArray(shot.props)) errors.push(`${sat}: props 必须是道具 id 数组`);
        else for (const propId of shot.props) {
          if (!validPropIds.has(propId)) errors.push(`${sat}: props 里的 "${propId}" 不在板子里`);
        }
      }

      // --- on_screen
      if (!Array.isArray(shot.on_screen) || !shot.on_screen.length) {
        errors.push(`${sat}: on_screen 为空（画面里至少得有个人或东西）`);
      } else {
        for (const id of shot.on_screen) {
          if (!validIds.has(id)) errors.push(`${sat}: on_screen 里的 "${id}" 不在板子里`);
        }
      }

      // --- action 必填（画面发生什么）
      if (!shot.action || !String(shot.action).trim()) errors.push(`${sat}: 缺 action（画面发生什么）`);

      // v5：情绪必须从剧情事实推导成可观察表演，不能用含义模糊的视觉符号代替。
      if (v5) {
        if (!Array.isArray(shot.emotion_analysis) || !shot.emotion_analysis.length) {
          errors.push(`${sat}: v5 缺 emotion_analysis（逐角色客观情绪分析）`);
        } else {
          const seenEmotion = new Set();
          for (const [ei, emotion] of shot.emotion_analysis.entries()) {
            const eat = `${sat}.emotion_analysis[${ei}]`;
            if (!emotion || typeof emotion !== 'object') { errors.push(`${eat}: 不是对象`); continue; }
            if (!(shot.on_screen || []).includes(emotion.character)) errors.push(`${eat}: character "${emotion.character || ''}" 不在本镜 on_screen 中`);
            if (seenEmotion.has(emotion.character)) errors.push(`${eat}: character "${emotion.character}" 重复`);
            seenEmotion.add(emotion.character);
            for (const field of ['cause', 'internal_state', 'visible_behavior', 'gaze']) {
              if (!emotion[field] || !String(emotion[field]).trim()) errors.push(`${eat}: 缺 ${field}`);
            }
            if (!Array.isArray(emotion.avoid_symbols) || !emotion.avoid_symbols.length
              || emotion.avoid_symbols.some((item) => !String(item).trim())) {
              errors.push(`${eat}: avoid_symbols 必须是非空字符串数组`);
            }
          }
          for (const id of shot.on_screen || []) {
            if (!seenEmotion.has(id)) errors.push(`${sat}: emotion_analysis 漏了出场角色 "${id}"`);
          }
        }
      }

      // --- cut：n≥2 必须有且用词合法；第 1 镜不能有
      if (si === 0) {
        if (shot.cut) warnings.push(`${sat}: 第 1 镜不该有 cut`);
      } else {
        if (!shot.cut) errors.push(`${sat}: n≥2 必须写 cut`);
        else if (!CUT_PHRASES.includes(String(shot.cut).trim())) {
          errors.push(`${sat}: cut "${shot.cut}" 不是 H3 认的用词`);
        }
      }

      // --- facing
      if (shot.facing !== undefined) {
        if (typeof shot.facing !== 'object' || Array.isArray(shot.facing)) {
          errors.push(`${sat}: facing 应该是对象 {"<id>":"left|right|toward|away"}`);
        } else {
          for (const [who, dir2] of Object.entries(shot.facing)) {
            if (!validIds.has(who)) errors.push(`${sat}: facing 里的 "${who}" 不在板子里`);
            if (!FACINGS.includes(dir2)) errors.push(`${sat}: facing["${who}"]="${dir2}" 不合法`);
          }
        }
      }

      // --- lines：行号，必须是剧本里真有台词的行
      if (shot.lines !== undefined) {
        if (!Array.isArray(shot.lines)) { errors.push(`${sat}: lines 应该是数组`); }
        else {
          for (const ln of shot.lines) {
            if (!Number.isInteger(ln)) { errors.push(`${sat}: lines 里 " ${ln}" 不是整数行号`); continue; }
            if (!dialogueLines.has(ln)) {
              errors.push(`${sat}: lines 里的第 ${ln} 行在剧本里不是台词行`);
            } else {
              assignedLines.push(ln);
            }
          }
        }
      }

      // 台词能否在镜头里说完是生成前就能判断的技术底线。
      // 导演仍决定节奏和留白，但不能交出短于最低口播时间的镜头。
      const speechSeconds = (shot.lines || []).reduce((sum, ln) => sum + (dialogueSeconds.get(ln) || 0), 0);
      if (v2 && speechSeconds > 0 && Number(shot.duration_s) + 1e-6 < speechSeconds) {
        errors.push(`${sat}: 台词最低需要 ${speechSeconds.toFixed(2)}s，镜头只有 ${Number(shot.duration_s).toFixed(2)}s`);
      }

      prevAt = shot.at || 0;
      prevDuration = shot.duration_s || 0;
    }

    // --- 单元总长
    const last = unit.shots[unit.shots.length - 1];
    const total = (last.at || 0) + (last.duration_s || 0);
    if (total > MAX_UNIT_SECONDS + 1e-6) {
      errors.push(`${at}: 单元总长 ${total.toFixed(2)}s 超过 ${MAX_UNIT_SECONDS}s`);
    }
    if (total > MAX_UNIT_SECONDS * 0.98) {
      warnings.push(`${at}: 单元总长 ${total.toFixed(2)}s 已经贴着 15s 上限，没有余量`);
    }
    if (v4 && Array.isArray(unit.action_complexity?.high_risk_events)) {
      for (const [ei, event] of unit.action_complexity.high_risk_events.entries()) {
        if (typeof event?.at_s === 'number' && event.at_s > total + 1e-6) {
          errors.push(`${at}.action_complexity.high_risk_events[${ei}]: at_s ${event.at_s} 超过单元总长 ${total.toFixed(2)}s`);
        }
      }
    }
    void prevDuration;
  }

  // 关键帧/生成单元不是免费的剪辑点：H3 每个单元至少产出约 5 秒。
  const targetSeconds = Number(board.meta?.total_duration_s || 0);
  if (v3 && targetSeconds > 0) {
    const unitSeconds = dir.units.map((unit) => {
      const last = unit.shots?.[unit.shots.length - 1];
      return last ? Number(last.at || 0) + Number(last.duration_s || 0) : 0;
    });
    const contentSeconds = unitSeconds.reduce((sum, n) => sum + n, 0);
    const deliverySeconds = unitSeconds.reduce((sum, n) => sum + Math.max(MIN_GENERATION_SECONDS, n), 0);
    const limit = targetSeconds * MAX_DURATION_EXPANSION_RATIO;
    if (contentSeconds > limit + 1e-6) {
      errors.push(`导演内容总长 ${contentSeconds.toFixed(2)}s 超过契约目标 ${targetSeconds.toFixed(2)}s 的 10% 余量`);
    }
    if (deliverySeconds > limit + 1e-6) {
      errors.push(
        `预计交付时长 ${deliverySeconds.toFixed(2)}s 超过契约目标 ${targetSeconds.toFixed(2)}s 的 10% 余量；`
        + `当前 ${dir.units.length} 个生成单元，每个至少 ${MIN_GENERATION_SECONDS}s，请合并连续表演段，减少不必要关键帧`,
      );
    }
  }

  // ---- 台词必须一条不漏、一条不重
  if (dialogueLines.size) {
    const seen = new Map();
    for (const ln of assignedLines) seen.set(ln, (seen.get(ln) || 0) + 1);
    const missing = [...dialogueLines.keys()].filter((ln) => !seen.has(ln));
    const dup = [...seen.entries()].filter(([, n]) => n > 1).map(([ln]) => ln);
    if (missing.length) errors.push(`台词漏了 ${missing.length} 句：第 ${missing.join('、')} 行`);
    if (dup.length) errors.push(`台词被放了多次：第 ${dup.join('、')} 行`);
  }

  // ---- ⌛ 死线：导演不许写出台词原文
  const leaked = findDialogueLeak(dir, dialogueLines);
  if (leaked.length) {
    errors.push(
      `**导演写出了台词原文** —— 这是死线。第 ${leaked.join('、')} 行的台词出现在输出里。`
      + ` 台词只能用行号引用，原文由代码逐字搬。`,
    );
  }

  // ---- 正反打朝向（软检查，只警告）
  const reverseIssues = checkReverseFacing(dir);
  warnings.push(...reverseIssues);

  return { ok: errors.length === 0, errors, warnings };
}

/** 从剧本里收集"台词行"：行号 → 原文。 */
export function collectDialogueLines(board, scriptLines) {
  const map = new Map();
  // 优先用板子上的 dialogue（那是 literal 解析过的，最准）
  for (const s of board.shots || []) {
    for (const ln of s.source_lines || []) {
      for (const d of s.dialogue || []) {
        if (scriptLines[ln - 1] && scriptLines[ln - 1].includes(d.text)) map.set(ln, d.text);
      }
    }
  }
  // 板子上没有的，用行文特征兜底：`角色（情绪）：台词`
  if (!map.size) {
    scriptLines.forEach((raw, i) => {
      const m = String(raw).match(/^\s*[^\s（(]{1,12}\s*(?:[（(][^）)]*[）)])?\s*[:：]\s*(.+?)\s*$/);
      if (m && m[1] && !/^△/.test(raw)) map.set(i + 1, m[1]);
    });
  }
  return map;
}

/** 剧本行号 → 台词最低口播时间。 */
export function collectDialogueSeconds(board) {
  const map = new Map();
  for (const shot of board.shots || []) {
    for (const ln of shot.source_lines || []) {
      for (const d of shot.dialogue || []) {
        if (d.text) map.set(ln, estimateSpeechSeconds(d.text));
      }
    }
  }
  return map;
}

/** 在导演的输出里找台词原文（去掉行号字段后比对）。 */
export function findDialogueLeak(dir, dialogueLines, minLen = 4) {
  const hits = [];
  const texts = JSON.stringify(dir);
  for (const [ln, text] of dialogueLines) {
    const t = String(text).trim();
    if (t.length < minLen) continue;                 // 太短的会误报（比如「好。」）
    if (texts.includes(t)) hits.push(ln);
  }
  return hits;
}

/**
 * 正反打朝向（180 度线）—— **只警告，不报错**。
 *
 * ## 我第一版写反了，记在这里
 *
 * 第一版警告的是「**同一个人**连续两镜朝同一边」。跑真实数据时它报了 5 次错 ——
 * **而导演是对的，校验器是错的。**
 *
 * 因为对话戏的正反打就是这个样子：
 *
 * ```
 * 她的每一个镜头   都朝 right（朝向他）
 * 他的每一个镜头   都朝 left （朝向她）
 * ```
 *
 * **同一个人在所有镜头里朝同一方向，两个人互为反向** —— 这正是 180 度线正确的形态。
 * 把它当错误报，等于把对的说成错的。
 *
 * ## 正确的判据
 *
 * 看**相邻两镜里的两个不同的人**：他们在互相看（或者都看着对方），
 * 那么其中一个朝左、另一个就必须朝右。**两个人都朝同一边 = 在看第三个东西。**
 */
export function checkReverseFacing(dir) {
  const warnings = [];
  const shots = [];
  for (const u of dir.units || []) for (const s of u.shots || []) shots.push(s);

  const opposite = (x, y) =>
    (x === 'left' && y === 'right') || (x === 'right' && y === 'left');

  for (let i = 0; i + 1 < shots.length; i++) {
    const a = shots[i];
    const b = shots[i + 1];
    const fa = a.facing || {};
    const fb = b.facing || {};
    const whoA = Object.keys(fa);
    const whoB = Object.keys(fb);

    // 只关心「这一镜里有谁」和「下一镜里有谁」——不同的人之间才谈得上视线关系
    for (const p of whoA) {
      for (const q of whoB) {
        if (p === q) continue;                     // 同一个人，不适用
        const x = fa[p];
        const y = fb[q];
        // 两人都做出"朝某侧"的姿态，却朝同一边 → 观众会以为在看画外
        if ((x === 'left' || x === 'right') && x === y) {
          warnings.push(
            `镜头 ${a.n}→${b.n}：「${p}」和「${q}」都朝 ${x} —— 如果他们是互相看的，`
            + '观众会以为两人都在看画外（180 度线）；如果他们确实都在看别处，忽略这条',
          );
        }
        // 一人朝侧、另一人 toward（面朝镜头）也值得提一句
        if (opposite(x, y)) continue;
      }
    }
  }
  return warnings;
}

// ---------------------------------------------------------------- 简报拼装

/**
 * 把「导演简报 + 输入材料」拼成给模型的 prompt。
 *
 * **简报是职业素养，不是条款** —— 所以原文给，不压缩成规则列表。
 */
export function buildBrief({ briefText, board, script, projectRoot }) {
  const lines = script.split(/\r?\n/).map((l, i) => `${String(i + 1).padStart(4)}: ${l}`).join('\n');

  const people = (board.identities || []).map((x) => {
    const ch = (board.characters || []).find((c) => c.id === x.character);
    return `- ${x.id}　${ch ? ch.name : x.character}　长相：${ch ? ch.face_prompt : '?'}　服装：${x.appearance_details}`;
  }).join('\n');

  const scenes = (board.scenes || []).map((s) =>
    `- ${s.id}　${s.name || ''}　${s.environment}　时段：${s.time_of_day || '未定'}`).join('\n');

  const props = (board.props || []).length
    ? (board.props || []).map((p) => `- ${p.id}　${p.name || ''}　${p.description}`).join('\n')
    : '（无）';

  const secondsByLine = collectDialogueSeconds(board);
  const dialogueIndex = [...collectDialogueLines(board, script.split(/\r?\n/))]
    .map(([ln]) => `  第 ${ln} 行　最低口播 ${Number(secondsByLine.get(ln) || 0).toFixed(2)} 秒`).join('\n');

  return `${briefText}

---

# 本片的输入材料

## 剧本（带行号，台词行号以这里为准）

\`\`\`
${lines}
\`\`\`

## 人物与造型（\`on_screen\` / \`facing\` 只能用这些 id）

${people || '（无）'}

## 场景

${scenes || '（无）'}

## 道具

${props}

## 台词行号清单（你必须把每一行都安排进某一镜，且只安排一次）

${dialogueIndex || '（本片没有台词）'}

## 本片画幅

${board.meta?.aspect || '未设置'}　按本片实际画幅设计构图，不假设竖屏

## 交付时长硬预算

契约目标：${Number(board.meta?.total_duration_s || 0) || '未声明'} 秒。
每个生成单元至少按 ${MIN_GENERATION_SECONDS} 秒计入预计交付时长；内容总长与预计交付总长均不得超过目标的 10% 余量。

---

# 现在交你的设计

按附带的 \`schema.md\` 当前格式交 JSON。**只交 JSON，不要解释文字。**
再提醒一次：**你没有资格写台词 —— 只用行号指。**
`;
}

/** 读导演简报的正本。 */
export function readBrief(projectRoot) {
  const p = path.join(projectRoot, 'references', 'director', 'brief.md');
  const q = path.join(projectRoot, 'references', 'director', 'schema.md');
  if (!fs.existsSync(p)) throw new Error(`找不到导演简报：${p}`);
  if (!fs.existsSync(q)) throw new Error(`找不到导演输出格式：${q}`);
  return fs.readFileSync(p, 'utf8') + '\n\n---\n\n' + fs.readFileSync(q, 'utf8');
}

// ---------------------------------------------------------------- 调用导演

/** 默认用哪个模型当导演。`bl text chat` 的默认就是它，这里写死一份好记录。 */
export { DIRECTOR_MODEL };

/**
 * 请导演做设计。
 *
 * **走 `bl text chat --messages-file`** —— 简报很长（含剧本全文），
 * 而且这台机器的 PowerShell 5.1 **会吃掉命令行参数里的引号**，
 * 所以一律"写临时文件 → 传文件路径"，绝不把长文本拼进命令行。
 *
 * **必须经 `runBailian()` 直连，不能 `spawn('bl', …, { shell: true })`。**
 * PATH 上的 `bl` 是 `%APPDATA%\npm\bl.ps1`（PowerShell 包装器），而本机 PowerShell
 * 起不了外部进程 —— 走它会退化成「静默无产出」，实测表现为等满超时、
 * 错误信息只有「bl 退出码 null」、stderr 为空。图片通道早已改用 `runBailian`，
 * 导演通道曾漏改（详见 `references/troubleshooting.md` 的「CLI 通道调用失败」）。
 *
 * @returns {{ok:boolean, direction?:object, raw:string, error?:string, seconds:number}}
 */
export function callDirector(prompt, opts = {}) {
  // 注入点保留：测试可以传一个假的 run 来断言参数拼装，不必真调线上。
  const run = opts.run || runBailian;
  const model = opts.model || DIRECTOR_MODEL;
  if (model !== DIRECTOR_MODEL) throw new Error(`导演必须使用已批准的高级模型 ${DIRECTOR_MODEL}`);
  const timeoutMs = opts.timeoutMs || 600000;
  const tmp = opts.tmpDir || os.tmpdir();

  const msgFile = path.join(tmp, `director-msg-${Date.now()}.json`);
  fs.writeFileSync(msgFile, JSON.stringify([
    { role: 'system', content: prompt },
    { role: 'user', content: '按上面的简报和材料，交出你的镜头设计。只交 JSON。' },
  ]), 'utf8');

  const started = Date.now();
  // **`--timeout` 必须显式给。** bl 的默认超时撑不住「8000 字简报 + thinking + 16000 tokens」，
  // 实测直接 `Request timed out`（code 5）—— 跟当初 `bl image` 那个坑是同一个。
  const args = ['text', 'chat', '--model', model, '--messages-file', msgFile,
    '--max-tokens', String(opts.maxTokens || 6000), '--output', 'json',
    '--timeout', String(opts.requestTimeoutSec || 600)];
  // **默认不思考** —— 一次 8000 字简报 + thinking + 16000 tokens，网络层会先超时。
  // 镜头设计要的是判断，不是长推理链；需要时用 --thinking 显式打开。
  if (opts.thinking === true) args.push('--enable-thinking');

  const r = run(args, { timeoutMs });
  try { fs.unlinkSync(msgFile); } catch { /* 无所谓 */ }

  const seconds = Math.round((Date.now() - started) / 1000);
  const stdout = String(r.stdout || '');
  const stderr = String(r.stderr || '');

  if (r.status !== 0) {
    // `status` 为 null 是 spawn 层失败（起不来 / 超时），`error` 里有真正原因，
    // 不能只报「退出码 null」——那会把人引向"模型没回答"，而实际是进程根本没起来。
    const why = r.error ? `（${r.error.code || 'spawn 失败'}：${String(r.error.message || r.error).slice(0, 160)}）` : '';
    return { ok: false, raw: stdout, error: `bl 退出码 ${r.status}${why}：${stderr.slice(0, 300)}`, seconds };
  }

  let response;
  try { response = JSON.parse(stdout); } catch { return { ok: false, raw: stdout, error: '导演响应不是可核验的 JSON', seconds }; }
  const responseModel = response.model || response.response?.model;
  if (responseModel !== model) return { ok: false, raw: stdout, error: `导演响应模型不匹配：${responseModel || '未报告'}，要求 ${model}`, seconds };

  // `--output json` 的响应体结构可能变，所以**层层剥**：先找 choices/message，再找里面第一段 JSON
  const text = extractText(stdout);
  const parsed = extractJson(text);
  if (!parsed) {
    return { ok: false, raw: stdout, error: `模型没交出可解析的 JSON。原文前 300 字：${text.slice(0, 300)}`, seconds };
  }
  return { ok: true, direction: parsed, raw: stdout, model, responseModel, seconds };
}

/** 从 `bl --output json` 的响应里剥出助手文本。 */
export function extractText(stdout) {
  try {
    const j = JSON.parse(stdout);
    const c = j.choices?.[0];
    if (c) return String(c.message?.content ?? c.text ?? '').trim();
    if (j.output?.text) return String(j.output.text).trim();
    if (typeof j.text === 'string') return j.text.trim();
    if (typeof j.content === 'string') return j.content.trim();
  } catch { /* 不是纯 JSON，往下走 */ }
  return String(stdout || '').trim();
}

/** 从模型回复里抠出第一段完整 JSON（容忍 ```json 围栏和前后废话）。 */
export function extractJson(text) {
  const s = String(text || '');
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : s;
  // 从第一个 { 开始做括号配对，找到第一段完整的
  const start = body.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(body.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}
