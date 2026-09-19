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
import path from 'node:path';
import { runVerifiedTextResponse } from './providers/bailian-responses.mjs';
import { DIRECTOR_MODEL, DIRECTOR_MAX_OUTPUT_TOKENS, BAILIAN_TEXT_TIMEOUT_SECONDS } from './config.mjs';
import { estimateSpeechSeconds } from './orchestrate.mjs';

/** FastH3 短于这个时长仍会生成约 5 秒；多切单元会把成片静默撑长。 */
export const MIN_GENERATION_SECONDS = 5.17;
/** 当前校验器要求的最低导演契约版本。 */
export const MIN_DIRECTION_VERSION = 6;

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

/** 默认用哪个模型当导演。 */
export { DIRECTOR_MODEL };

/**
 * 流式 Responses 的完成事件同时给出模型身份与最终正文；不接受 CLI 的 content-only 摘要。
 * @returns {{ok:boolean, direction?:object, raw:string, error?:string, seconds:number}}
 */
export async function callDirector(prompt, opts = {}) {
  const run = opts.run || runVerifiedTextResponse;
  const model = opts.model || DIRECTOR_MODEL;
  const messages = [
    { role: 'system', content: prompt },
    { role: 'user', content: '按上面的简报和材料，交出你的镜头设计。只交 JSON。' },
  ];
  const started = Date.now();
  let response;
  try {
    response = await run({ messages, model, maxTokens: opts.maxTokens || DIRECTOR_MAX_OUTPUT_TOKENS,
      reasoningEffort: opts.reasoningEffort || (opts.thinking ? 'xhigh' : 'low'), timeoutMs: opts.timeoutMs || BAILIAN_TEXT_TIMEOUT_SECONDS * 1000 });
  } catch (error) {
    return { ok: false, raw: '', error: String(error.message || error), seconds: Math.round((Date.now() - started) / 1000) };
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  const stdout = JSON.stringify(response);
  const responseModel = response.model || response.response?.model;
  if (responseModel !== model) return { ok: false, raw: stdout, error: `导演响应模型不匹配：${responseModel || '未报告'}，要求 ${model}`, seconds };
  if (response.status && response.status !== 'completed') {
    return { ok: false, raw: stdout, error: `导演响应未完成：${response.status}（${response.incomplete_details?.reason || response.error?.message || '原因未报告'}）`, seconds };
  }

  const text = extractText(stdout);
  const parsed = response.parsed || extractJson(text);
  if (!parsed) {
    return { ok: false, raw: stdout, error: `模型没交出可解析的 JSON。原文前 300 字：${text.slice(0, 300)}`, seconds };
  }
  return { ok: true, direction: parsed, raw: stdout, model, responseModel, seconds };
}

/** 从 Responses 完成事件的信封里剥出助手文本。 */
export function extractText(stdout) {
  try {
    const j = JSON.parse(stdout);
    if (Array.isArray(j.output)) {
      return j.output.flatMap((item) => item.type === 'message' ? item.content || [] : [])
        .filter((part) => part.type === 'output_text' && typeof part.text === 'string')
        .map((part) => part.text).join('\n').trim();
    }
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
