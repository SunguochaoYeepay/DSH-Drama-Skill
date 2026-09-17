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

function finalize(group, index, boundaryReason) {
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
    generation_duration_s: Math.min(
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

  const output = [];
  const directorOwnsUnits = Number(direction.version) >= 2;
  let group = [];
  let groupStart = 0;
  let previousSourceUnit = null;

  const flush = (reason) => {
    if (!group.length) return;
    output.push(finalize(group, output.length + 1, reason));
    group = [];
  };

  for (const unit of direction.units) {
    for (const [shotIndex, shot] of (unit.shots || []).entries()) {
      if (!(Number(shot.duration_s) > 0)) throw new Error(`${unit.id}.shots[${shotIndex}] 时长不合法`);
      const entry = { shot, sourceUnit: unit.id, sourceShot: shot.n ?? shotIndex + 1, director: unit };
      if (!group.length) {
        group = [entry];
        groupStart = Number(shot.at || 0);
        previousSourceUnit = unit.id;
        continue;
      }

      const previous = group[group.length - 1].shot;
      const candidateSeconds = shotEnd(shot) - groupStart;
      const sourceChanged = unit.id !== previousSourceUnit;
      const castChanged = castKey(shot) !== castKey(previous);
      const exceedsTarget = candidateSeconds > targetSeconds;
      const exceedsMax = candidateSeconds > maxSeconds;

      if (sourceChanged || (!directorOwnsUnits && (castChanged || exceedsTarget || exceedsMax))) {
        flush(sourceChanged ? 'director_unit' : castChanged ? 'cast_change' : 'target_window');
        group = [entry];
        groupStart = Number(shot.at || 0);
      } else {
        group.push(entry);
      }
      previousSourceUnit = unit.id;
    }
  }
  flush('end');

  // 导演契约引用的是 u1/u2；执行交接使用的是编译后的 g001/g002。
  // 在这里完成唯一一次 ID 翻译，避免执行器猜测两套编号的关系。
  const generatedBySource = new Map(output.flatMap((unit) => unit.source_units.map((source) => [source, unit.id])));
  for (const unit of output) {
    if (unit.continuity?.mode !== 'continue_previous') continue;
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
      split_on_cast_change: !directorOwnsUnits,
      director_owns_unit_boundaries: directorOwnsUnits,
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
