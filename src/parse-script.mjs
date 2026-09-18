/**
 * parse-script.mjs — 把剧本切成**行**，并判定每一行是什么。
 *
 * 这是「逐行模式」的地基。核心主张：
 *   **台词文本永远不经过 LLM 的手** —— 由这个解析器原样抠出来，
 *   所以"逐字保真"是**构造保证**，不是"求模型别改"。
 *
 * 支持真实剧本（「标准分镜版」）的行型：
 *   短剧剧本：…／风格：…／时长：…        → meta
 *   人物设定                             → meta（分节标题）
 *   大师兄：清冷靠谱、钢铁直男            → character_setting（**只出现在首个场次头之前**）
 *   第 1 集 1-1 场景：外 林间古道 清晨 人物：…  → scene_header
 *   △ 清晨林间古道，阳光穿透枝叶…        → action
 *   小师妹（语气温软）：大师兄，昨天晚上…   → dialogue
 *   小师妹 OS：我以为的负责是相守相伴…     → voiceover
 *   片尾字幕：她以为的负责是余生相守…      → card
 *   （完）/（全剧终）/（剧终）独立成行      → end_marker（不成镜，不进 action）
 */

import { parseScenes } from './parse-scenes.mjs';

const RE_OS = /^([^\s：:]{1,12})\s*(?:OS|O\.S\.|旁白|内心|独白)\s*[:：]\s*(.+)$/;
const RE_CARD = /^(片尾字幕|片头字幕|字幕|画面字幕|旁白|画外音)\s*[:：]\s*(.+)$/;
const RE_SPEAKER = /^([^\s：:【】\[\]（）()△▲]{1,12})\s*(?:[（(]([^）)]*)[）)])?\s*[:：]\s*(.+)$/;
const RE_SPEAKER_CUE = /^([^\s：:【】\[\]（）()△▲]{1,12})\s*[（(]([^）)]*)[）)]\s*$/;
const RE_META_KV = /^(短剧剧本|剧本|风格|时长|类型|题材|片名|集数|出品)\s*[:：]\s*(.*)$/;
const RE_SECTION = /^(人物设定|人物介绍|人物表|场景表|分集大纲|故事大纲)\s*[:：]?\s*$/;
// 剧本结尾标记：独立成行的（完）/（全剧终）/（剧终）等。它们不是动作，凑成一个
// 「垃圾动作镜」会被板子契约（action ≥4 字、prompt ≥12 字）拒绝，或侥幸过关污染分镜。
// 允许全角/半角括号包裹或裸写；只匹配整行，不碰正文。
const RE_END_MARK = /^(?:[（(]\s*)?(?:全剧终|剧终|完剧|the\s*end|end|完)\s*(?:[）)])?$/i;

/**
 * @returns {{lines: Array, stats: object, scenes: Array, episode_count: number}}
 */
export function parseScript(text) {
  const raw = String(text || '').split(/\r?\n/);
  const parsed = parseScenes(text);
  // 场次头所在行号（1-based），用来区分「人物设定」和「台词」
  const sceneHeaderLines = new Set(parsed.scenes.map((s) => s.line_number));
  const sceneByLine = new Map(parsed.scenes.map((s) => [s.line_number, s]));

  const lines = [];
  let seenScene = false;
  let currentScene = null;
  let pendingSpeaker = null;

  for (let i = 0; i < raw.length; i++) {
    const no = i + 1;
    const line = raw[i].trim();
    if (!line) continue;

    const base = { no, raw: line };

    if (sceneHeaderLines.has(no)) {
      pendingSpeaker = null;
      seenScene = true;
      currentScene = sceneByLine.get(no);
      lines.push({ ...base, kind: 'scene_header', scene_no: currentScene.scene_no, episode: currentScene.episode });
      continue;
    }

    if (RE_SECTION.test(line)) { lines.push({ ...base, kind: 'meta' }); continue; }

    const kv = line.match(RE_META_KV);
    if (kv && !seenScene) { lines.push({ ...base, kind: 'meta', key: kv[1], value: kv[2] }); continue; }

    if (/^[△▲]/.test(line)) {
      lines.push({ ...base, kind: 'action', text: line.replace(/^[△▲]\s*/, ''), scene_no: currentScene?.scene_no ?? null });
      continue;
    }

    const cue = seenScene && line.match(RE_SPEAKER_CUE);
    if (cue) {
      pendingSpeaker = { no, raw: line, speaker: cue[1], parenthetical: cue[2].trim() };
      continue;
    }

    if (pendingSpeaker) {
      const cueLine = pendingSpeaker;
      pendingSpeaker = null;
      lines.push({ ...cueLine, no, raw: line, cue_no: cueLine.no, kind: 'dialogue', text: line,
        scene_no: currentScene?.scene_no ?? null });
      continue;
    }

    // 人物设定：**只在首个场次头之前**，长得像台词的那些其实是设定
    if (!seenScene && RE_SPEAKER.test(line)) {
      const m = line.match(RE_SPEAKER);
      lines.push({ ...base, kind: 'character_setting', speaker: m[1], text: m[3] });
      continue;
    }

    const os = line.match(RE_OS);
    if (os) {
      lines.push({ ...base, kind: 'voiceover', speaker: os[1], text: os[2].trim(), scene_no: currentScene?.scene_no ?? null });
      continue;
    }

    const card = line.match(RE_CARD);
    if (card) {
      lines.push({ ...base, kind: 'card', label: card[1], text: card[2].trim(), scene_no: currentScene?.scene_no ?? null });
      continue;
    }

    const sp = line.match(RE_SPEAKER);
    if (sp) {
      lines.push({
        ...base,
        kind: 'dialogue',
        speaker: sp[1],
        parenthetical: (sp[2] || '').trim(),
        text: sp[3].trim(),
        scene_no: currentScene?.scene_no ?? null,
      });
      continue;
    }

    // 结尾标记（（完）/（全剧终）等）：不算动作，避免凑出垃圾镜头
    if (RE_END_MARK.test(line)) {
      lines.push({ ...base, kind: 'end_marker', scene_no: currentScene?.scene_no ?? null });
      continue;
    }

    lines.push({ ...base, kind: seenScene ? 'action' : 'other', text: line, scene_no: currentScene?.scene_no ?? null });
  }

  const stats = { total: lines.length, dialogue: 0, voiceover: 0, action: 0, card: 0, meta: 0, other: 0, scene_header: 0, character_setting: 0 };
  for (const l of lines) stats[l.kind] = (stats[l.kind] || 0) + 1;

  return { lines, stats, scenes: parsed.scenes, episode_count: parsed.episode_count };
}

/** 剧本里全部「会被念出来」的台词（含 OS），按出现顺序。 */
export function spokenLines(parsed) {
  return parsed.lines.filter((l) => l.kind === 'dialogue' || l.kind === 'voiceover');
}
