/**
 * Summarize detector output without treating unavailable detection as success.
 * The CLI owns process exit codes; this module owns the decision rules.
 */
export function summarizePresence(results = [], expectedCount = null) {
  const checked = results.length;
  const unavailable = results.filter((item) => item?.present == null);
  const detected = results.filter((item) => item?.present != null);
  const missing = detected.filter((item) => item.present === false);
  const countOf = (item) => item?.n_person_effective ?? item?.n_person;
  const countMismatches = expectedCount == null
    ? []
    : detected.filter((item) => countOf(item) !== expectedCount);
  return {
    checked,
    detector_ok: detected.length,
    detector_unavailable: unavailable,
    missing_subject: missing,
    count_mismatches: countMismatches,
    present_rate: detected.length ? (detected.filter((item) => item.present).length / detected.length) : null,
    ok: checked > 0 && unavailable.length === 0 && missing.length === 0,
  };
}

/**
 * presence.py 的 stdout 可能先被第三方库写入 WARNING，再写 JSON。
 * 从所有候选起点尝试解析，取最后一个带 results 的 JSON 文档。
 */
export function parsePresenceJson(stdout) {
  const text = String(stdout || '').trim();
  for (let i = text.lastIndexOf('{'); i >= 0; i = text.lastIndexOf('{', i - 1)) {
    try {
      const value = JSON.parse(text.slice(i));
      if (value && Array.isArray(value.results)) return value;
    } catch { /* 外层对象从更早的 { 开始 */ }
  }
  throw new Error('检测器没有输出有效 JSON');
}
