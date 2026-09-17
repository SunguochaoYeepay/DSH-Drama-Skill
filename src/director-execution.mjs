/** Compile director-owned spatial relationships into explicit H3 instructions. */
export function compileLookAt(shot, nameOf) {
  return (shot.looks_at || []).map((relation, index) => {
    if (!relation?.who || !relation?.at) {
      throw new Error(`looks_at[${index}] 必须同时提供 who 和 at`);
    }
    if (!(shot.on_screen || []).includes(relation.who)) {
      throw new Error(`looks_at[${index}].who ${relation.who} 不在本镜 on_screen 中`);
    }
    if (!(shot.on_screen || []).includes(relation.at)) {
      throw new Error(`looks_at[${index}].at ${relation.at} 不在本镜 on_screen 中；画外目标应写进 action，而不是 looks_at`);
    }
    return {
      key: `looks_at:${index}`,
      text: `${nameOf(relation.who)}始终注视${nameOf(relation.at)}，头部、眼睛和瞳孔都明确朝向对方，全过程不看镜头`,
    };
  });
}

export function compileDirectorExecution(shot, nameOf) {
  const directives = [...compileLookAt(shot, nameOf)];
  for (const [index, emotion] of (shot.emotion_analysis || []).entries()) {
    if (!emotion?.character || !emotion?.visible_behavior || !emotion?.gaze) {
      throw new Error(`emotion_analysis[${index}] 缺 character / visible_behavior / gaze`);
    }
    const avoid = (emotion.avoid_symbols || []).filter(Boolean);
    directives.push({
      key: `emotion_analysis:${index}`,
      text: `${nameOf(emotion.character)}的可见表演：${emotion.visible_behavior}；视线：${emotion.gaze}`
        + (avoid.length ? `；禁止表现为：${avoid.join('、')}` : ''),
    });
  }
  const expected = (shot.looks_at || []).map((_, index) => `looks_at:${index}`);
  expected.push(...(shot.emotion_analysis || []).map((_, index) => `emotion_analysis:${index}`));
  const covered = new Set(directives.map((item) => item.key));
  const missing = expected.filter((key) => !covered.has(key));
  if (missing.length) throw new Error(`导演执行约束未被承接：${missing.join(', ')}`);
  return directives;
}
