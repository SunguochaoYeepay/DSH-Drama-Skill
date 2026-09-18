export function withHandoffReference(refs, stableFrame, provider) {
  const limit = provider === 'huimeng' ? 9 : 3;
  const combined = [{ file: stableFrame, role: 'handoff' }, ...refs];
  if (combined.length > limit) {
    throw new Error(`连续承接需要 ${combined.length} 张参考图，${provider} 上限 ${limit}；请调整构图或减少参考职责，不能静默丢掉角色`);
  }
  return combined;
}
