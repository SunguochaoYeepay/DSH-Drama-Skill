/**
 * direction-shots.mjs — 把**导演的设计**编译回 `board.shots[]`。
 *
 * ## 为什么要有这一步
 *
 * `board.mjs direct` 交完设计之后，自己打印的是：
 *
 * > 下一步：把设计编译成分镜表（**还没实现**）
 *
 * 于是工程里长期同时存在两套镜头：
 *
 * ```
 *   board.shots            ← literal 的机械分组（"idx<=2 就全景、缓慢前推"）
 *   board.direction.json   ← 导演真正排的生成单元与切点
 * ```
 *
 * 关键帧、`table`、`validate`、成片自检读的**全是 `board.shots`** ——
 * 也就是说**导演的活儿一直没进过契约**。这个模块把它接上。
 *
 * ## 粒度：**一个 board shot = 一个生成单元**
 *
 * 导演交的是「4 个单元，每个单元里可以切多刀」。旧逐镜流程不认识"单元"概念，
 * 正式流程因此改为 `compile-units` → `keyframes` → `unit`。
 *
 * 所以这里**按单元物化**（不是按单元内部的镜）：一个单元出一张 0 秒关键帧、出一次生成，
 * 这正是 H3 的能力边界。单元内部的切点不丢 —— 它们在 `render.plan.json` 的
 * `shots[]` 里（`cli/unit.mjs` 据此拼多镜提示词），摘要也写进 `edit_note` 供人审阅。
 * 反过来按"单元内部的镜"物化会变成 8 个 shot，关键帧和生成次数都会翻倍，
 * 与导演的设计**正好相反**。
 */

import { parseScript } from './parse-script.mjs';

/** 剧本行号 → 这一行是什么（台词文本从这里来，**不经过模型**）。 */
function scriptIndex(script) {
  const parsed = parseScript(script);
  const byLine = new Map();
  for (const l of parsed.lines) byLine.set(l.no, l);
  return { parsed, byLine };
}

/** 说话人名字 → 出场造型 id（和 literal 的 castOf 同一套规则）。 */
function speakerMap(board) {
  const byName = new Map();
  for (const c of board.characters || []) {
    const first = (c.identities || [])[0];
    if (c.name && first) byName.set(c.name, first);
  }
  return byName;
}

function round3(n) {
  return Number(Number(n).toFixed(3));
}

/**
 * 一个生成单元的实际时长 = 单元内**最后一镜的结束时刻**。
 *
 * ⚠ 不能读 `unit.content_duration_s` —— 那是 `render.plan.json`（compile-units 的产物）
 * 才有的字段；`direct` 交的 `board.direction.json` 里只有 `shots[].at` 和 `duration_s`。
 * 读不到就退化成"只算第一镜"，实测把 30s 的片子算成 15.2s。
 */
function unitSeconds(unitShots) {
  return Math.max(...unitShots.map((s) => Number(s.at || 0) + Number(s.duration_s || 0)));
}

/**
 * 把导演的设计写进 board.shots。
 *
 * @param {object} board      当前板子（需要 meta / characters / identities / scenes）
 * @param {object} direction  导演交的 JSON（version 2：units[].shots[]）
 * @param {string} script     剧本原文（台词行号的唯一事实源）
 * @returns {{board: object, report: object, warnings: string[]}}
 */
export function applyDirection(board, direction, script) {
  const warnings = [];
  if (!direction || !Array.isArray(direction.units)) throw new Error('direction.units 不是数组');
  if (!script) throw new Error('applyDirection 需要剧本原文（台词只能从原文搬）');

  const { byLine } = scriptIndex(script);
  const speakers = speakerMap(board);
  const sceneId = (board.scenes || [])[0]?.id || null;
  if (!sceneId) throw new Error('板子里一个场景都没有，无从落位');

  const shots = [];
  const usedLines = [];

  for (const unit of direction.units) {
    const unitShots = unit.shots || [];
    if (!unitShots.length) { warnings.push(`${unit.id}：没有镜头，跳过`); continue; }

    const first = unitShots[0];
    const cast = [...new Set(unitShots.flatMap((s) => s.on_screen || []))];

    // ---- 台词：只认行号，原文从剧本搬 ----
    const dialogue = [];
    const lines = [];
    for (const s of unitShots) {
      for (const ln of s.lines || []) {
        const src = byLine.get(ln);
        if (!src) { warnings.push(`${unit.id} 第${s.n}镜：剧本没有第 ${ln} 行`); continue; }
        if (src.kind !== 'dialogue' && src.kind !== 'voiceover') {
          warnings.push(`${unit.id} 第${s.n}镜：第 ${ln} 行不是台词（${src.kind}），按台词引用了`);
        }
        const ident = speakers.get(src.speaker);
        if (!ident) { warnings.push(`${unit.id} 第${s.n}镜：剧本第 ${ln} 行的说话人「${src.speaker}」在板子里找不到造型`); continue; }
        if (!cast.includes(ident)) cast.push(ident);
        dialogue.push({
          character: ident,
          text: src.text,
          emotion: src.parenthetical || (src.kind === 'voiceover' ? '内心独白' : ''),
          kind: src.kind === 'voiceover' ? 'voiceover' : 'spoken',
        });
        lines.push(ln);
        usedLines.push(ln);
      }
    }

    // ---- 画面：一个单元一张首帧，所以 action/prompt 取"0 秒那一刻" + 单元里发生了什么 ----
    const startState = String(unit.keyframe_start || '').trim();
    const actionText = unitShots.length === 1
      ? first.action
      : `${startState ? startState + '；随后 ' : ''}${unitShots.map((s) => s.action).filter(Boolean).join(' → ')}`;

    const marks = cast.map((c) => `{{${c}}}`).join('、');
    const prompt = [marks, first.action, `${first.framing}，${first.camera}`].filter(Boolean).join('，');

    // 单元内部的切点摘要 —— 按单元物化会把它压掉，这里留成可见的审阅信息
    const cutSheet = unitShots
      .map((s) => `${Number(s.at || 0).toFixed(1)}s ${s.framing}`)
      .join(' / ');

    shots.push({
      id: `s${String(shots.length + 1).padStart(2, '0')}`,
      scene: sceneId,
      cast,
      props: [],
      source_lines: [...new Set(lines)].sort((a, b) => a - b),
      duration_s: Math.min(15, Math.max(1, round3(unitSeconds(unitShots)))),
      shot_size: first.framing,
      lighting: first.lighting || '沿用场景默认光',
      camera: first.camera,
      action: actionText,
      prompt,
      audio: [...new Set(unitShots.map((s) => s.audio).filter(Boolean))].join('；') || '环境底噪',
      dialogue,
      edit_note: `导演单元 ${unit.id}（${unitShots.length} 镜：${cutSheet}）`,
      transition: { type: 'cut' },
      first_frame: null,
      last_frame: null,
      clip: null,
    });
  }

  // ---- 台词覆盖核对：剧本每一句都必须被某一单元认领，且只认领一次 ----
  const allSpoken = [...byLine.values()]
    .filter((l) => l.kind === 'dialogue' || l.kind === 'voiceover')
    .map((l) => l.no);
  const dup = usedLines.filter((n, i) => usedLines.indexOf(n) !== i);
  const missing = allSpoken.filter((n) => !usedLines.includes(n));
  if (missing.length) warnings.push(`剧本第 ${missing.join('、')} 行的台词没有任何单元认领`);
  if (dup.length) warnings.push(`剧本第 ${[...new Set(dup)].join('、')} 行的台词被认领了不止一次`);

  const next = {
    ...board,
    meta: { ...board.meta, stage: 'shots', total_duration_s: round3(shots.reduce((a, s) => a + s.duration_s, 0)) },
    shots,
  };

  return {
    board: next,
    warnings,
    report: {
      units: direction.units.length,
      shots: shots.length,
      spoken: allSpoken.length,
      claimed: new Set(usedLines).size,
      total_duration_s: next.meta.total_duration_s,
    },
  };
}
