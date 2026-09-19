import { callDirector, collectDialogueLines, collectDialogueSeconds } from './director.mjs';
import { parseScript, spokenLines } from './parse-script.mjs';
import { runStructuredChat } from './providers/bailian-chat.mjs';

const PLAN_SCHEMA = {
  name: 'director_unit_plan',
  description: '按场次规划连续生成单元',
  schema: {
    type: 'object', additionalProperties: false, required: ['version', 'units'],
    properties: { version: { type: 'integer' }, units: { type: 'array', minItems: 1, items: {
      type: 'object', additionalProperties: false, required: ['id', 'scene_nos', 'dialogue_lines', 'boundary_trigger'],
      properties: {
        id: { type: 'string' }, scene_nos: { type: 'array', items: { type: 'integer' }, minItems: 1 },
        dialogue_lines: { type: 'array', items: { type: 'integer' } },
        boundary_trigger: { type: 'string', enum: ['opening', 'scene_change', 'time_jump', 'identity_anchor', 'spatial_reset', 'state_transition_anchor', 'engine_limit'] },
      },
    } } },
  },
};
const UNIT_SCHEMA = {
  name: 'director_unit', description: '单个导演生成单元',
  schema: { type: 'object', required: ['unit'], properties: { unit: { type: 'object', additionalProperties: true } }, additionalProperties: false },
};

export function planningPrompt(basePrompt) {
  return `${basePrompt}\n\n你现在只做导演单元规划，不设计镜头。输出严格 JSON：{"version":1,"units":[{"id":"u1","source_lines":[1,2],"boundary_trigger":"opening","reason":"..."}]}。根据连续表演、场景/身份变化、高风险动作和台词完整性决定单元数量，不要为了凑数量切分。source_lines 使用剧本行号；每句台词只能归属一个单元。只交 JSON。`;
}

export function compactPlanningPrompt({ script, board }) {
  const scenes = (board.scenes || []).map((s) => `${s.scene_no}:${s.id}`).join('; ');
  const scriptText = String(script).split(/\r?\n/).map((line, i) => `${i + 1}: ${line}`).join('\n');
  const dialogueLines = spokenLines(parseScript(script)).map((line) => line.no).join(', ');
  return `你是短剧生成单元规划师。只规划连续表演边界，不设计镜头，不改剧本，不输出台词原文。\n`+
    `输出严格 JSON，且只能包含 version 和 units；每个单元包含 id、scene_nos、dialogue_lines、boundary_trigger。`+
    `根据剧情连续性决定单元数量；场景/身份变化、高风险状态转换或15秒上限才拆分，每单元最多一个高风险状态转换。`+
    `dialogue_lines 只能使用剧本中实际台词的行号，全部台词必须恰好分配一次。不要输出任何其他字段。\n`+
    `总时长：${board.meta?.total_duration_s || '未定'} 秒；场次：${scenes || '无'}；合法台词行号：${dialogueLines || '无'}。\n剧本：\n${scriptText}`;
}

export function unitPrompt(basePrompt, plan, item, previous, speechSeconds = new Map()) {
  const budgets = (item.dialogue_lines || []).map((line) => `${line}行至少${Number(speechSeconds.get(line) || 0).toFixed(2)}秒`).join('；');
  return `${basePrompt}\n\n这是分批导演任务。只设计规划中的一个生成单元，不要输出顶层 units 数组：\n${JSON.stringify(item)}\n上一单元稳定状态：${previous?.end_state || '无'}\n本单元台词硬预算：${budgets || '无台词'}。任何承载这些台词的镜头 duration_s 都必须不小于对应预算。请输出严格 JSON，形状为 {"unit":{...}}。该 unit 必须包含完整 v6 字段和 shots；规划中的 dialogue_lines 必须全部且只出现一次，lines 只能使用这些行号，不得写出台词原文；时间轴是本单元局部时间：第一个镜头 at 必须为 0，后续严格递增，最后一个镜头 at+duration_s 必须 <=15，绝对不能使用跨单元累计时间。每单元最多一个高风险状态转换。shots 的第一个镜头 n=1、at=0 且不能有 cut；每个后续镜头 n 连续递增、at 严格递增，并且必须有合法 cut（the camera cuts to）。facing 只能使用 left/right/toward/away，禁止 up/down。emotion_analysis 只能覆盖本镜 on_screen 中的角色，不能写画外角色。黑屏不要单独做空人物镜头，写进上一镜动作或转场。每个镜头必须有 framing、camera、scene、on_screen、action、emotion_analysis、lines、audio。`;
}

function validatePlan(plan, board, script) {
  plan.units.forEach((unit, index) => { if (!unit.id) unit.id = `u${index + 1}`; });
  const expected = [...collectDialogueLines(board, script.split(/\r?\n/)).keys()].sort((a, b) => a - b);
  const got = plan.units.flatMap((unit) => unit.dialogue_lines || []).sort((a, b) => a - b);
  if (got.length !== expected.length || got.some((line, i) => line !== expected[i])) {
    throw new Error(`规划台词行必须恰好覆盖 ${expected.join(',')}，实际为 ${got.join(',')}`);
  }
  if (plan.units[0]?.boundary_trigger !== 'opening') plan.units[0].boundary_trigger = 'opening';
}

export async function generateBatchedDirection({ basePrompt, board, script, run, model, maxTokens, thinking, timeoutMs }) {
  const chatRun = run || ((args) => runStructuredChat({ ...args, schema: PLAN_SCHEMA }));
  const planned = await callDirector(compactPlanningPrompt({ script, board }), { run: chatRun, model, maxTokens: Math.min(maxTokens, 3000), reasoningEffort: 'none', timeoutMs });
  if (planned.ok && planned.raw) {
    const direct = planned.raw.parsed;
    if (direct) planned.direction = direct;
  }
  if (!planned.ok) return { ok: false, stage: 'planning', ...planned };
  const plan = planned.direction;
  if (plan.version !== 1 || !Array.isArray(plan.units) || !plan.units.length) {
    return { ok: false, stage: 'planning', error: '导演单元规划格式无效', seconds: planned.seconds };
  }
  try { validatePlan(plan, board, script); } catch (error) {
    return { ok: false, stage: 'planning', error: error.message, seconds: planned.seconds };
  }
  const units = [];
  const speechSeconds = collectDialogueSeconds(board);
  let seconds = planned.seconds;
  for (const item of plan.units) {
    const previous = units.at(-1);
    const unitRun = run || ((args) => runStructuredChat({ ...args, schema: UNIT_SCHEMA }));
    const result = await callDirector(unitPrompt(basePrompt, plan, item, previous, speechSeconds), { run: unitRun, model, maxTokens, thinking, timeoutMs });
    seconds += result.seconds;
    if (!result.ok) return { ok: false, stage: item.id, ...result, seconds };
    const unit = result.direction.unit;
    if (unit) unit.id = item.id;
    if (!unit || unit.id !== item.id) return { ok: false, stage: item.id, error: `单元 ${item.id} 返回格式无效`, seconds };
    units.push(unit);
  }
  const direction = { version: 6, logline: '分批导演合并方案', units };
  return { ok: true, direction, model, responseModel: model, seconds, warnings: [], plan };
}
