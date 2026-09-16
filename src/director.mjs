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
import { spawnSync } from 'node:child_process';

/** 生成单元的上限（H3 的硬约束）。 */
export const MAX_UNIT_SECONDS = 15;
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

  const validIds = new Set([
    ...(board.identities || []).map((x) => x.id),
    ...(board.characters || []).map((c) => c.id),
  ]);

  // 剧本里所有台词行 → 行号到文本
  const scriptLines = script.split(/\r?\n/);
  const dialogueLines = collectDialogueLines(board, scriptLines);

  const assignedLines = [];
  const unitIds = new Set();

  for (const [ui, unit] of dir.units.entries()) {
    const at = `units[${ui}]`;
    if (!unit || typeof unit !== 'object') { errors.push(`${at}: 不是对象`); continue; }
    if (!unit.id) errors.push(`${at}: 缺 id`);
    else if (unitIds.has(unit.id)) errors.push(`${at}: id "${unit.id}" 重复`);
    else unitIds.add(unit.id);
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
    void prevDuration;
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

  const dialogueIndex = [...collectDialogueLines(board, script.split(/\r?\n/))]
    .map(([ln]) => `  第 ${ln} 行`).join('\n');

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

${board.meta?.aspect || '9:16'}　竖屏

---

# 现在交你的设计

按 \`schema.md\` 的格式交 JSON。**只交 JSON，不要解释文字。**
再提醒一次：**你没有资格写台词 —— 只用行号指。**
`;
}

/** 读导演简报的正本。 */
export function readBrief(projectRoot) {
  const p = path.join(projectRoot, 'director', 'BRIEF.md');
  const q = path.join(projectRoot, 'director', 'schema.md');
  if (!fs.existsSync(p)) throw new Error(`找不到导演简报：${p}`);
  return fs.readFileSync(p, 'utf8') + '\n\n---\n\n' + (fs.existsSync(q) ? fs.readFileSync(q, 'utf8') : '');
}

// ---------------------------------------------------------------- 调用导演

/** 默认用哪个模型当导演。`bl text chat` 的默认就是它，这里写死一份好记录。 */
export const DIRECTOR_MODEL = process.env.AIH_DIRECTOR_MODEL || 'qwen3.8-max';

/**
 * 请导演做设计。
 *
 * **走 `bl text chat --messages-file`** —— 简报很长（含剧本全文），
 * 而且这台机器的 PowerShell 5.1 **会吃掉命令行参数里的引号**，
 * 所以一律"写临时文件 → 传文件路径"，绝不把长文本拼进命令行。
 *
 * @returns {{ok:boolean, direction?:object, raw:string, error?:string, seconds:number}}
 */
export function callDirector(prompt, opts = {}) {
  const spawn = opts.spawn || spawnSync;
  const model = opts.model || DIRECTOR_MODEL;
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
    '--timeout', String(opts.requestTimeoutSec || 600), '--stream'];
  // **默认不思考** —— 一次 8000 字简报 + thinking + 16000 tokens，网络层会先超时。
  // 镜头设计要的是判断，不是长推理链；需要时用 --thinking 显式打开。
  if (opts.thinking === true) args.push('--enable-thinking');

  const r = spawn('bl', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs, shell: true });
  try { fs.unlinkSync(msgFile); } catch { /* 无所谓 */ }

  const seconds = Math.round((Date.now() - started) / 1000);
  const stdout = String(r.stdout || '');
  const stderr = String(r.stderr || '');

  if (r.status !== 0 && !stdout.trim()) {
    return { ok: false, raw: stdout, error: `bl 退出码 ${r.status}：${stderr.slice(0, 300)}`, seconds };
  }

  // `--output json` 的响应体结构可能变，所以**层层剥**：先找 choices/message，再找里面第一段 JSON
  const text = extractText(stdout);
  const parsed = extractJson(text);
  if (!parsed) {
    return { ok: false, raw: stdout, error: `模型没交出可解析的 JSON。原文前 300 字：${text.slice(0, 300)}`, seconds };
  }
  return { ok: true, direction: parsed, raw: stdout, seconds };
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

