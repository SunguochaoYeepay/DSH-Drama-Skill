/**
 * 把导演镜头编译成模型可执行的生成单元。
 *
 * 导演决定镜头；这里不改镜头内容，只决定在哪些边界重新注入关键帧。
 */

export const DEFAULT_TARGET_SECONDS = 10;
export const MIN_GENERATION_SECONDS = 5.17;
export const MAX_GENERATION_SECONDS = 15;

function castKey(shot) {
  return [...new Set(shot.on_screen || [])].sort().join('|');
}

function shotEnd(shot) {
  return Number(shot.at || 0) + Number(shot.duration_s || 0);
}

function finalize(group, index, boundaryReason, forcedDuration = null) {
  const start = Number(group[0].shot.at || 0);
  const shots = group.map(({ shot, sourceUnit, sourceShot }, i) => {
    const copy = structuredClone(shot);
    copy.n = i + 1;
    copy.at = Number((Number(shot.at || 0) - start).toFixed(3));
    if (i === 0) {
      if (copy.cut) copy.director_cut = copy.cut;
      delete copy.cut;
    }
    copy.source = { unit: sourceUnit, shot: sourceShot };
    return copy;
  });
  const contentSeconds = Number(shotEnd(shots[shots.length - 1]).toFixed(3));
  const director = group[0].director || {};
  return {
    id: `g${String(index).padStart(3, '0')}`,
    source_units: [...new Set(group.map((x) => x.sourceUnit))],
    boundary_reason: boundaryReason,
    content_duration_s: contentSeconds,
    // 手工指定时长时不做钳制：15 秒上限是默认值，不是不得逾越的红线。
    generation_duration_s: Number.isFinite(forcedDuration) && forcedDuration > 0
      ? Number(forcedDuration)
      : Math.min(
        MAX_GENERATION_SECONDS,
        Math.max(MIN_GENERATION_SECONDS, contentSeconds),
      ),
    keyframe: `keyframes_render/g${String(index).padStart(3, '0')}.png`,
    cast: [...new Set(group.flatMap((x) => x.shot.on_screen || []))],
    ...([...(new Set(group.map((x) => x.shot.scene).filter(Boolean)))].length === 1
      ? { scene: [...(new Set(group.map((x) => x.shot.scene).filter(Boolean)))][0] }
      : {}),
    props: [...new Set(group.flatMap((x) => x.shot.props || []))],
    ...(director.why ? { why: director.why } : {}),
    ...(director.duration_reason ? { duration_reason: director.duration_reason } : {}),
    ...(director.keyframe_start ? { keyframe_start: director.keyframe_start } : {}),
    ...(director.keyframe_cast ? { keyframe_cast: [...director.keyframe_cast] } : {}),
    ...(director.action_complexity ? { action_complexity: structuredClone(director.action_complexity) } : {}),
    ...(director.end_state ? { end_state: director.end_state } : {}),
    ...(director.continuity ? { continuity: structuredClone(director.continuity) } : {}),
    shots,
  };
}

export function compileGenerationPlan(direction, opts = {}) {
  const targetSeconds = Number(opts.targetSeconds ?? DEFAULT_TARGET_SECONDS);
  const maxSeconds = Number(opts.maxSeconds ?? MAX_GENERATION_SECONDS);
  if (!direction || !Array.isArray(direction.units)) throw new Error('direction.units 不是数组');
  if (!(targetSeconds > 0 && maxSeconds >= targetSeconds)) throw new Error('生成时长参数不合法');

  const entries = [];
  for (const unit of direction.units) {
    for (const [shotIndex, shot] of (unit.shots || []).entries()) {
      if (!(Number(shot.duration_s) > 0)) throw new Error(`${unit.id}.shots[${shotIndex}] 时长不合法`);
      entries.push({ shot, sourceUnit: unit.id, sourceShot: shot.n ?? shotIndex + 1, director: unit });
    }
  }

  const output = [];
  const directorOwnsUnits = Number(direction.version) >= 2;
  const push = (group, reason, forcedDuration = null) => {
    if (!group.length) return;
    output.push(finalize(group, output.length + 1, reason, forcedDuration));
  };

  // 手工边界：由 --units 指定哪些导演单元合并成一个生成单元，并可直写生成时长。
  const manual = Array.isArray(opts.groups) && opts.groups.length ? opts.groups : null;
  if (manual) {
    const byUnit = new Map();
    for (const entry of entries) {
      if (!byUnit.has(entry.sourceUnit)) byUnit.set(entry.sourceUnit, []);
      byUnit.get(entry.sourceUnit).push(entry);
    }
    const claimed = new Set();
    for (const spec of manual) {
      const group = [];
      for (const unitId of spec.source_units || []) {
        // 引用不存在的导演单元若静默走空数组，会生成一个没有镜头的空生成单元 ——
        // 手工边界的承诺是"不静默丢镜头"，所以这里必须报错而不是兜底。
        if (!byUnit.has(unitId)) throw new Error(`手工边界引用了导演稿里不存在的单元：${unitId}`);
        group.push(...byUnit.get(unitId));
        claimed.add(unitId);
      }
      if (!group.length) throw new Error(`手工边界有分组没指定任何导演单元：${JSON.stringify(spec)}`);
      push(group, 'manual', Number(spec.generation_duration_s) || null);
    }
    // 手工边界没提到的导演单元各自成组，不静默丢镜头。
    for (const entry of entries) {
      if (claimed.has(entry.sourceUnit)) continue;
      claimed.add(entry.sourceUnit);
      push(byUnit.get(entry.sourceUnit), 'manual_leftover');
    }
  } else {
    let group = [];
    let groupStart = 0;
    let previousSourceUnit = null;
    for (const entry of entries) {
      if (!group.length) {
        group = [entry];
        groupStart = Number(entry.shot.at || 0);
        previousSourceUnit = entry.sourceUnit;
        continue;
      }
      const previous = group[group.length - 1].shot;
      const candidateSeconds = shotEnd(entry.shot) - groupStart;
      const sourceChanged = entry.sourceUnit !== previousSourceUnit;
      const castChanged = castKey(entry.shot) !== castKey(previous);
      const exceedsTarget = candidateSeconds > targetSeconds;
      const exceedsMax = candidateSeconds > maxSeconds;
      if (sourceChanged || (!directorOwnsUnits && (castChanged || exceedsTarget || exceedsMax))) {
        push(group, sourceChanged ? 'director_unit' : castChanged ? 'cast_change' : 'target_window');
        group = [entry];
        groupStart = Number(entry.shot.at || 0);
      } else {
        group.push(entry);
      }
      previousSourceUnit = entry.sourceUnit;
    }
    push(group, 'end');
  }

  // 导演契约引用的是 u1/u2；执行交接使用的是编译后的 g001/g002。
  // 在这里完成唯一一次 ID 翻译，避免执行器猜测两套编号的关系。
  // 两种交接模式都要翻译：`reference_previous`（继承上一段画面作参考）和
  // `continue_previous`（连状态一起延续）。只翻译 continue_previous 的话，
  // reference_previous 单元的 previous_unit 会一直停在 u1/u2，
  // 执行器按 g001/g002 找产物就永远找不到 —— 交接凭证根本建不起来。
  const HANDOFF_MODES = ['continue_previous', 'reference_previous'];
  const generatedBySource = new Map(output.flatMap((unit) => unit.source_units.map((source) => [source, unit.id])));
  for (const unit of output) {
    if (!HANDOFF_MODES.includes(unit.continuity?.mode)) continue;
    const generatedPrevious = generatedBySource.get(unit.continuity.previous_unit);
    if (!generatedPrevious) throw new Error(`${unit.id}: 找不到导演交接来源 ${unit.continuity.previous_unit} 对应的生成单元`);
    unit.continuity.previous_source_unit = unit.continuity.previous_unit;
    unit.continuity.previous_unit = generatedPrevious;
  }

  return {
    version: 1,
    source_logline: direction.logline || '',
    policy: {
      target_seconds: targetSeconds,
      max_seconds: maxSeconds,
      min_generation_seconds: MIN_GENERATION_SECONDS,
      split_on_cast_change: manual ? false : !directorOwnsUnits,
      director_owns_unit_boundaries: manual ? false : directorOwnsUnits,
      manual_boundaries: Boolean(manual),
      preserves_director_shots: true,
    },
    units: output,
    totals: {
      content_duration_s: Number(output.reduce((sum, unit) => sum + unit.content_duration_s, 0).toFixed(3)),
      projected_delivery_duration_s: Number(output.reduce((sum, unit) => sum + unit.generation_duration_s, 0).toFixed(3)),
      keyframe_count: output.length,
    },
  };
}
