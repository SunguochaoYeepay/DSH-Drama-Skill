/**
 * score.mjs — 候选池的逐维打分。
 *
 * 判据抄自 DramaClaw：**face_score ≥ 7 AND clothing_score ≥ 7 且无 critical 才算过**。
 * 为什么是这两个维度 —— 因为这两样正是"同一个角色是不是同一个人"的全部内容。
 *
 * **打分跑本地**（`qwen3.5:27b` 带 vision）。理由：
 *   - 免费，可以反复抽
 *   - 打分是"看一眼给个数"，不需要最强的模型
 *   - 候选池动辄几十张，调线上会烧钱
 *
 * 三个纯函数（`buildScorePrompt` / `parseScore` / `pickBest`）可离线断言，
 * 只有 `scoreFile` 需要真的调模型。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { WINGET_PACKAGES } from './runtime-paths.mjs';

const OLLAMA = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
export const SCORE_MODEL = process.env.AIH_SCORE_MODEL || 'qwen3.5:27b';

const FFMPEG = (() => {
  const base = WINGET_PACKAGES;
  try {
    for (const dir of fs.readdirSync(base)) {
      if (!dir.startsWith('Gyan.FFmpeg_')) continue;
      const c = path.join(base, dir, 'ffmpeg-7.1.1-full_build', 'bin', 'ffmpeg.exe');
      if (fs.existsSync(c)) return c;
    }
  } catch { /* 退回 PATH */ }
  return 'ffmpeg';
})();

// ---------------------------------------------------------------- 纯函数

/**
 * 逐维打分的提示词。
 * **必须点名维度并要求 JSON** —— 自由文本没法自动比较，"感觉还行"不是判据。
 */
export function buildScorePrompt(kind, expect = {}) {
  const common = [
    '',
    '只输出一个 JSON 对象，不要解释、不要 Markdown 围栏。',
    '打分范围 0-10，10 是完美。**评分要敢给低分**：看得出问题就给 3 分以下，别一路给高分。',
  ].join('\n');

  let body;
  if (kind === 'portrait') {
    body = [
      '这是一张角色肖像（用作脸部锚点）。请逐项检查并打分：',
      '',
      `【应该长这样】${expect.face || '（未给）'}`,
      '',
      '检查项：',
      '- face_score：像不像描述的那个人',
      '- region_ok：是否为东亚人外貌',
      '- front_ok：是否为正面朝向（不是侧脸、不是低头）',
      '- plain_bg_ok：背景是否纯净（没有场景、没有道具）',
      '- has_baked_text：画面里有没有文字',
      '- critical：有没有致命问题（族裔不对、半身以下入画、背景是场景、画面崩坏）',
      '- note：一句话',
      '',
      'JSON 字段：face_score, region_ok(布尔), front_ok(布尔), plain_bg_ok(布尔), has_baked_text(布尔), critical(字符串或空), note',
    ].join('\n');
  } else if (kind === 'identity') {
    body = [
      '这是一张角色设定图（多面板）。请逐项检查并打分：',
      '',
      `【应该长这样】角色：${expect.face || '（未给）'}`,
      `【应该穿这样】服装：${expect.costume || '（未给）'}`,
      '',
      '检查项：',
      '- panels：数一数有几个面板',
      '- face_score：各面板里的**脸**是不是同一个人（脸型/五官/发型一致）',
      '- clothing_score：各面板里的**服装**是不是同一套，且是否符合上面的服装描述',
      '- region_ok：是否为东亚人外貌',
      '- has_baked_text：画面里有没有把说明文字烧进图像（水印/标题/参数表）',
      '- critical：有没有致命问题（缺面板、明显崩坏、性别错误、**穿着现代服装**）',
      '- note：一句话',
      '',
      'JSON 字段：panels(数字), face_score, clothing_score, region_ok(布尔), has_baked_text(布尔), critical(字符串或空), note',
    ].join('\n');
  } else if (kind === 'keyframe') {
    body = [
      '这是一张影视分镜的关键帧。请逐项检查并打分：',
      '',
      `【这一镜要拍的】${expect.action || '（未给）'}`,
      `【景别】${expect.shot_size || '（未给）'}　【运镜】${expect.camera || '（未给）'}`,
      `【出场人物】${expect.cast || '（未给）'}`,
      '',
      '检查项：',
      '- face_score：出场的每个人是不是"同一个人"（对比参考图的长相）',
      '- clothing_score：服装是否与设定一致',
      '- framing_score：景别与构图是否符合上面的要求',
      '- action_match：画面是否真的在表现上面那件事（而不是拍了别的东西）',
      '- critical：有没有致命问题（缺人、多出人来、明显崩坏、画面里出现文字）',
      '- note：一句话',
      '',
      'JSON 字段：face_score, clothing_score, framing_score, action_match(布尔), critical(字符串或空), note',
    ].join('\n');
  } else {
    body = [
      '这是一张场景环境图。请逐项检查并打分：',
      '',
      `【应该是哪里】${expect.environment || '（未给）'}`,
      '',
      '检查项：',
      '- match_score：像不像描述的那个地方',
      '- empty_ok：该禁人的场景里，画面上有没有出现人',
      '- has_baked_text：有没有把文字烧进画面',
      '- critical：有没有致命问题',
      '- note：一句话',
      '',
      'JSON 字段：match_score, empty_ok(布尔), has_baked_text(布尔), critical(字符串或空), note',
    ].join('\n');
  }
  return body + common;
}

/** 从模型回复里抠 JSON（它有时会包一层解释或围栏）。 */
export function parseScore(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : raw;
  try { return JSON.parse(body); } catch { /* 往下抠花括号 */ }
  const start = body.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
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

/** DramaClaw 的判据：**脸和服装都 ≥ 7，且没有 critical**。 */
export const PASS_FACE = 7;
export const PASS_CLOTHING = 7;

export function passes(score, kind = 'keyframe') {
  if (!score) return false;
  if (score.critical) return false;
  if (kind === 'identity') {
    if (Number(score.panels) < 4) return false;
    if (score.has_baked_text) return false;
  }
  if (kind === 'portrait') {
    // 肖像的硬条件：族裔对、正面、背景干净 —— 这三条不满足，这张脸没法当锚
    if (score.region_ok === false) return false;
    if (score.front_ok === false) return false;
    if (score.plain_bg_ok === false) return false;
    if (score.has_baked_text) return false;
  }
  const face = Number(score.face_score ?? score.match_score ?? 0);
  const cloth = Number(score.clothing_score ?? 10);   // 场景/肖像没有服装维度
  return face >= PASS_FACE && cloth >= PASS_CLOTHING;
}

/**
 * 从候选里挑最好的。**不只看总分** —— 先按"过不过"分组，过的里面再比总分。
 * 全部不过时返回分最高的那个并标明 `provisional`（DramaClaw 的做法：别让流程卡死，
 * 但要让人知道这是勉强用的）。
 */
export function pickBest(candidates, kind = 'keyframe') {
  const scored = candidates.map((c) => {
    const s = c.score || {};
    const face = Number(s.face_score ?? s.match_score ?? 0);
    const cloth = Number(s.clothing_score ?? 10);
    const framing = Number(s.framing_score ?? 10);
    return { ...c, _face: face, _cloth: cloth, _total: face + cloth + framing, _pass: passes(s, kind) };
  });
  const ok = scored.filter((c) => c._pass);
  const pool = ok.length ? ok : scored;
  pool.sort((a, b) => b._total - a._total);
  const best = pool[0];
  return best ? { ...best, provisional: !best._pass } : null;
}

// ---------------------------------------------------------------- 要 I/O 的部分

/** 缩图：2688×1536 直喂要 97 秒，缩到 768 边长快一个数量级，而打分不需要那么大。 */
function downscale(file, maxEdge = 768) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-s-'));
  const out = path.join(dir, 'small.jpg');
  const ok = spawnSync(FFMPEG, [
    '-y', '-i', file,
    '-vf', `scale='min(${maxEdge},iw)':'min(${maxEdge},ih)':force_original_aspect_ratio=decrease`,
    '-frames:v', '1', '-q:v', '3', out,
  ], { stdio: 'ignore' }).status === 0;
  return ok && fs.existsSync(out) ? { file: out, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) } : { file, cleanup: () => {} };
}

/**
 * 给一张图打分。
 * @returns {{ok: boolean, score: object|null, seconds: number, error?: string}}
 */
export async function scoreFile(imagePath, prompt, opts = {}) {
  const model = opts.model || SCORE_MODEL;
  const { file, cleanup } = downscale(imagePath, opts.maxEdge || 768);
  const t0 = Date.now();
  try {
    const b64 = fs.readFileSync(file).toString('base64');
    const res = await fetch(`${OLLAMA}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        format: 'json',
        options: { temperature: 0 },
        messages: [{ role: 'user', content: prompt, images: [b64] }],
      }),
      signal: AbortSignal.timeout(opts.timeoutMs || 420000),
    });
    if (!res.ok) return { ok: false, score: null, seconds: (Date.now() - t0) / 1000, error: `HTTP ${res.status}` };
    const j = await res.json();
    const score = parseScore(j.message && j.message.content);
    return { ok: Boolean(score), score, seconds: (Date.now() - t0) / 1000 };
  } catch (e) {
    return { ok: false, score: null, seconds: (Date.now() - t0) / 1000, error: e.message };
  } finally {
    cleanup();
  }
}
