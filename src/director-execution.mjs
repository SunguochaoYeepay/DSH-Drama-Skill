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
    // avoid_symbols 是导演的负例分析，不能原样塞进生成提示词。仅把已知类别
    // 编译成不复述禁词的正向边界；未知项保留在导演稿中供 QA / 人工审阅。
    const boundaries = [];
    for (const symbol of emotion.avoid_symbols || []) {
      const value = String(symbol || '');
      if (/笑|嘴角上扬|咧嘴/.test(value)) boundaries.push('嘴角形态服从上述可见表演，不额外改变情绪方向');
      else if (/星星眼|爱心眼|瞳孔.*形/.test(value)) boundaries.push('眼睛保持自然解剖结构，瞳孔形态稳定');
      else if (/崇拜|迷恋|花痴/.test(value)) boundaries.push('视线只执行上述注视目标与强度');
      else if (/卖萌|歪头|撒娇/.test(value)) boundaries.push('头颈姿态只执行上述可见动作');
    }
    directives.push({
      key: `emotion_analysis:${index}`,
      text: `${nameOf(emotion.character)}的可见表演：${emotion.visible_behavior}；视线：${emotion.gaze}`
        + (boundaries.length ? `；表演边界：${[...new Set(boundaries)].join('；')}` : ''),
    });
  }
  const expected = (shot.looks_at || []).map((_, index) => `looks_at:${index}`);
  expected.push(...(shot.emotion_analysis || []).map((_, index) => `emotion_analysis:${index}`));
  const covered = new Set(directives.map((item) => item.key));
  const missing = expected.filter((key) => !covered.has(key));
  if (missing.length) throw new Error(`导演执行约束未被承接：${missing.join(', ')}`);
  return directives;
}
