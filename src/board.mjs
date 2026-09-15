#!/usr/bin/env node
// board.mjs — 故事 → 剧本 → 关键帧 → 视频 的分阶段流水线（零依赖）
//
//   node tools/board.mjs story     <idea.txt> [--beats 6] [--model qwen3.5:27b] [--out x.json]
//   node tools/board.mjs approve   <board.json> --stage story|shots|keyframes [--by 用户名]
//   node tools/board.mjs from-story<board.json> --shots 6 [--model qwen3.5:27b]
//   node tools/board.mjs table     <board.json> [--out x.md]      ← 给人确认的那张表
//   node tools/board.mjs validate  <board.json>
//   node tools/board.mjs render    <board.json> [--out x.md]
//   node tools/board.mjs plan      <board.json> [--out x.ps1] [--out-dir <工作区\shots>]
//
// 闸门顺序：story（看故事）→ shots（确认镜头表）→ keyframes（确认关键帧）→ rendering（出片）
// 未确认的闸门不允许下游消费：分镜表没过、plan 直接拒绝跑。
//
// 本地 Ollama 编译，无需外网。产出后立刻用同一套 schema + 语义规则自检，
// 不合格就把错误回灌给模型修一次。这是"一半段成功率"的关键。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScenes, sceneMenu } from './parse-scenes.mjs';
import { compileLiteral } from './literal.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SCHEMA_PATH = path.join(ROOT, 'schema', 'storyboard.schema.json');
const PROMPT_PATH = path.join(ROOT, 'prompts', 'story2board.md');
const STORY_PROMPT_PATH = path.join(ROOT, 'prompts', 'idea2story.md');
const OLLAMA = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'qwen3.5:27b';

// 闸门顺序（数组下标即先后）
const STAGES = ['story', 'shots', 'assets', 'keyframes', 'rendering', 'done'];
const GATE_LABEL = { story: '故事', shots: '分镜表', assets: '资产', keyframes: '关键帧', rendering: '出片', done: '成片' };
/** 需要人工点头的闸门，顺序即先后。 */
const GATES = ['story', 'shots', 'assets', 'keyframes'];

// comfy-studio 的唯一入口（见该 skill 的硬契约）
const PY = 'E:\\AI-Image\\ComfyUI-aki-v1.4\\python\\python.exe';
const GEN = 'C:\\Users\\Administrator\\.agents\\skills\\comfy-studio\\scripts\\gen.py';

const SHOT_MAX_S = 15; // H3 单条上限

// ---------------------------------------------------------------- 参数解析

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
    else out._.push(a);
  }
  return out;
}

// ------------------------------------------------------- 极简 JSON Schema 校验

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(v, want) {
  const t = typeOf(v);
  if (want === 'number') return t === 'number' || t === 'integer';
  return t === want;
}

function deepEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function validateSchema(value, schema, ptr, errors) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(value, t))) {
      errors.push(`${ptr}: 期望 ${types.join('|')}，实际 ${typeOf(value)}`);
      return;
    }
  }
  if (schema.enum && !schema.enum.some((e) => deepEqual(e, value))) {
    errors.push(`${ptr}: 只能是 ${schema.enum.map((e) => JSON.stringify(e)).join(' / ')}，实际 ${JSON.stringify(value)}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${ptr}: ${value} 小于下限 ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${ptr}: ${value} 超过上限 ${schema.maximum}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${ptr}: 太短（至少 ${schema.minLength} 字）`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${ptr}: "${value}" 不匹配 ${schema.pattern}`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${ptr}: 至少 ${schema.minItems} 项`);
    if (schema.items) value.forEach((v, i) => validateSchema(v, schema.items, `${ptr}[${i}]`, errors));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const k of schema.required || []) if (!(k in value)) errors.push(`${ptr}: 缺字段 ${k}`);
    if (schema.additionalProperties === false) {
      const allowed = Object.keys(schema.properties || {});
      for (const k of Object.keys(value)) if (!allowed.includes(k)) errors.push(`${ptr}: 不该有的字段 ${k}`);
    }
    for (const [k, sub] of Object.entries(schema.properties || {})) {
      if (k in value) validateSchema(value[k], sub, `${ptr}.${k}`, errors);
    }
  }
}

// ------------------------------------------------------ 确定性补强（不靠模型自觉）

/** 从提示词里抽出所有 {{identity_id}} 标记。 */
function markersIn(text) {
  const out = [];
  const re = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

/** 从提示词里抽出所有 [[prop_id]] 标记。 */
function propMarkersIn(text) {
  const out = [];
  const re = /\[\[\s*([a-z][a-z0-9_]*)\s*\]\]/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

/**
 * 把出场身份补成 {{identity_id}} 标记。
 *
 * 标记是**绑定**，不是给人读的：它告诉渲染器「这一镜用哪张身份图当参考」，
 * 渲染器拼最终提示词时会先把标记换成该身份的 appearance_details。
 * 模型经常只写名字不写标记，这里用代码兜住 —— 缺了就补在最前面。
 */
function ensureMarkers(board) {
  const injected = [];
  for (const sh of board.shots || []) {
    const already = markersIn(sh.prompt);
    const missing = [];
    for (const id of sh.cast || []) {
      if (already.includes(id)) continue;
      const ident = (board.identities || []).find((x) => x.id === id);
      if (!ident) continue;
      const ch = (board.characters || []).find((c) => c.id === ident.character);
      const label = ch ? `（${ch.name}）` : '';
      missing.push(`{{${id}}}${label}`);
    }
    if (missing.length) {
      sh.prompt = `${missing.join('、')}，${sh.prompt}`;
      injected.push(`${sh.id}: 补入身份标记 → ${missing.join('、')}`);
    }
  }
  return injected;
}

// ------------------------------------------------------------ 语义规则（契约真正落地的地方）

function validateSemantics(b) {
  const errors = [];
  const warnings = [];

  const charIds = new Set((b.characters || []).map((c) => c.id));
  const identIds = new Set((b.identities || []).map((x) => x.id));
  const propIds = new Set((b.props || []).map((p) => p.id));
  const sceneIds = new Set((b.scenes || []).map((s) => s.id));
  const shots = b.shots || [];

  // **占位符检测。** `literal` 模式不提取长相和服装，只能填"待补"。
  // 占位符不会让校验失败，但会让生图模型自己编 —— 实测：修好风格锚点之后，
  // 小师妹立刻从"插画里的古装"变成"**照片里的白衬衫灰裙子**"。这类东西必须在出图前喊出来。
  const PLACEHOLDER = /待补|TODO|XXX|占位/;
  for (const c of b.characters || []) {
    if (PLACEHOLDER.test(String(c.face_prompt || ''))) {
      warnings.push(`characters: "${c.id}" 的 face_prompt 是占位符 —— 长相会由模型自己编，出图前先填上`);
    }
  }
  for (const x of b.identities || []) {
    if (PLACEHOLDER.test(String(x.appearance_details || ''))) {
      warnings.push(`identities: "${x.id}" 的 appearance_details 是占位符 —— 服装会由模型自己编，出图前先填上`);
    }
  }

  // 脸里混进表情、服装里混进动态 —— 这两样会把「可复用的锚」降级成「一帧快照」
  const FACE_LEAK = /神情|表情|微笑|大笑|冷笑|皱眉|落泪|羞怯|娇俏|怒气|笑容|眼神/;
  const CLOTH_LEAK = /衣|袍|裙|衫|甲|靴|鞋|裤|袜|披风|腰带|配饰/;
  const MOTION_LEAK = /随风|飘动|摆动|扬起|微动|轻盈|摇曳/;
  for (const c of b.characters || []) {
    const fp = String(c.face_prompt || '');
    const fm = fp.match(FACE_LEAK);
    const cm = fp.match(CLOTH_LEAK);
    if (fm) warnings.push(`characters: "${c.id}" 的 face_prompt 混进了表情（「${fm[0]}」）—— 脸是跨全片复用的锚，不该带情绪`);
    if (cm) warnings.push(`characters: "${c.id}" 的 face_prompt 混进了服装词（「${cm[0]}」）—— 服装属于造型层`);
  }
  for (const x of b.identities || []) {
    const ad = String(x.appearance_details || '');
    const mm = ad.match(MOTION_LEAK);
    if (mm) warnings.push(`identities: "${x.id}" 的 appearance_details 混进了动态词（「${mm[0]}」）—— 服装描述应该是静态的`);
  }

  // 角色 ↔ 造型 双向一致：character.identities 与 identity.character 必须互为镜像
  for (const ident of b.identities || []) {
    if (!charIds.has(ident.character)) {
      errors.push(`identities: "${ident.id}" 的 character="${ident.character}" 不在 characters 里`);
      continue;
    }
    const ch = (b.characters || []).find((c) => c.id === ident.character);
    if (ch && !(ch.identities || []).includes(ident.id)) {
      errors.push(`characters: "${ch.id}" 的 identities 列表里缺 "${ident.id}"（必须双向一致）`);
    }
  }
  for (const ch of b.characters || []) {
    for (const id of ch.identities || []) {
      if (!identIds.has(id)) errors.push(`characters: "${ch.id}" 引用了不存在的造型 "${id}"`);
    }
    if (!(ch.identities || []).length) warnings.push(`characters: "${ch.id}" 一个造型都没有——它没法出场`);
  }

  const seenShotIds = new Set();
  for (const [i, sh] of shots.entries()) {
    const at = `shots[${i}](${sh.id})`;

    if (seenShotIds.has(sh.id)) errors.push(`${at}: 镜头 id 重复`);
    seenShotIds.add(sh.id);

    if (!sceneIds.has(sh.scene)) errors.push(`${at}: scene "${sh.scene}" 不在 scenes 里`);

    // cast 引用的是 identity（造型），不是 character（身份）
    for (const id of sh.cast || []) {
      if (!identIds.has(id)) errors.push(`${at}: cast 里的 "${id}" 不在 identities 里（镜头引用的是造型，不是角色）`);
    }
    for (const id of sh.props || []) {
      if (!propIds.has(id)) errors.push(`${at}: props 里的 "${id}" 不在 props 里`);
    }
    for (const d of sh.dialogue || []) {
      if (!(sh.cast || []).includes(d.character)) {
        errors.push(`${at}: 台词来自 "${d.character}"，但该造型不在本镜 cast 里`);
      }
    }
    if (sh.duration_s > SHOT_MAX_S) errors.push(`${at}: ${sh.duration_s}s 超过引擎上限 ${SHOT_MAX_S}s`);

    // 禁止含糊：画面必须是确定的，备选表达没法渲染
    if (/或者|二选一|或是/.test(sh.prompt)) {
      errors.push(`${at}: prompt 出现备选表达（或者 / 二选一）——画面必须是确定的`);
    }
    if (/或者|二选一/.test(sh.action)) {
      errors.push(`${at}: action 出现备选表达——动作必须是确定的`);
    }

    // 标记协议：prompt 里的标记必须来自本镜的 cast / props 菜单
    for (const id of markersIn(sh.prompt)) {
      if (!(sh.cast || []).includes(id)) {
        errors.push(`${at}: prompt 里有身份标记 {{${id}}}，但它不在本镜 cast 里`);
      }
    }
    for (const id of propMarkersIn(sh.prompt)) {
      if (!(sh.props || []).includes(id)) {
        errors.push(`${at}: prompt 里有道具标记 [[${id}]]，但它不在本镜 props 里`);
      }
    }
    const marked = markersIn(sh.prompt);
    for (const id of sh.cast || []) {
      if (!marked.includes(id)) {
        warnings.push(`${at}: cast 里的 ${id} 在 prompt 里没有 {{${id}}} 标记，绑定不明确`);
      }
    }

    // 连贯链：声明了首尾帧衔接，就得有可衔接的上一镜
    if (sh.transition && sh.transition.type === 'last_frame_first') {
      if (i === 0) errors.push(`${at}: 第一个镜头不能声明 last_frame_first`);
      else {
        const prev = shots[i - 1];
        if (!(prev.last_frame || prev.clip)) {
          warnings.push(`${at}: 声明了 last_frame_first，但上一镜 ${prev.id} 还没生成末帧，执行前需回填`);
        }
        if (prev.shot_size !== sh.shot_size) {
          warnings.push(`${at}: 上一镜「${prev.shot_size}」本镜「${sh.shot_size}」却用 last_frame_first——景别会被上一镜锁死，这里应该用 cut`);
        }
      }
    }
  }

  // 连续 last_frame_first 太长 = 整片变成一个长镜头
  let run = 0, runStart = null;
  for (const [i, sh] of shots.entries()) {
    if (i > 0 && sh.transition && sh.transition.type === 'last_frame_first') {
      if (run === 0) runStart = shots[i - 1].id;
      run++;
      if (run === 3) warnings.push(`shots: ${runStart}→${sh.id} 连续 3 个 last_frame_first，剪辑点会被吃掉，中间建议插一个 cut`);
    } else {
      run = 0;
    }
  }

  // 阶段状态不能超前于用户确认——文件里的 stage 必须是诚实的状态机
  const declared = stageIndex(b);
  const confirmed = GATES.filter((g) => b.meta?.approvals?.[g]).length;
  const needConfirm = Math.min(declared, STAGES.indexOf('rendering'));
  if (confirmed < needConfirm) {
    errors.push(`meta.stage="${b.meta?.stage}" 表示已经走到「${gateLabel(b)}」，但只确认了 ${confirmed}/${needConfirm} 个前置闸门——不能跳过用户确认`);
  }
  if (declared >= STAGES.indexOf('assets') && !shots.length) errors.push('已经过了分镜闸门，却一个镜头都没有——分镜表还没生成吧');

  // 闸门必须按顺序确认：不许先批资产再回头批分镜表
  let sawUnapproved = false;
  for (const gate of GATES) {
    if (!b.meta?.approvals?.[gate]) { sawUnapproved = true; continue; }
    if (sawUnapproved) {
      errors.push(`approvals 顺序不对：「${GATE_LABEL[gate]}」已确认，但它前面的闸门还没确认——闸门是可以跳着批的吗`);
    }
  }

  const sum = shots.reduce((a, s) => a + (Number(s.duration_s) || 0), 0);
  const declaredTotal = Number(b.meta?.total_duration_s) || 0;
  // 故事闸门时还没有镜头，此时只做预估，不校验求和
  if (shots.length && Math.abs(sum - declaredTotal) > Math.max(0.5, declaredTotal * 0.1)) {
    errors.push(`meta.total_duration_s=${declaredTotal} 与镜头求和 ${sum}s 不一致`);
  }

  const total = declaredTotal || sum;
  if (total > 180) warnings.push(`总时长 ${total}s 偏长：H3 每镜都要单独生成再拼，1 秒≈10 秒算力，建议先做 60s 以内`);

  // 没有镜头时不谈"有没有人用"，否则故事闸门会刷一堆假警告
  if (shots.length) {
    const usedScenes = new Set(shots.map((s) => s.scene));
    for (const s of b.scenes || []) if (!usedScenes.has(s.id)) warnings.push(`scenes: "${s.id}" 没有任何镜头用到`);
    const usedIdents = new Set(shots.flatMap((s) => s.cast || []));
    for (const x of b.identities || []) if (!usedIdents.has(x.id)) warnings.push(`identities: "${x.id}" 没有出场`);
    const usedProps = new Set(shots.flatMap((s) => s.props || []));
    for (const p of b.props || []) if (!usedProps.has(p.id)) warnings.push(`props: "${p.id}" 没有出场`);
  }

  // 过了资产闸门却还没出资产：不是 error（历史板子没资产也能跑），但一致性没保障
  if (stageIndex(b) > STAGES.indexOf('assets')) {
    const missing = [];
    for (const c of b.characters || []) if (!c.portrait) missing.push(`肖像 ${c.id}`);
    for (const x of b.identities || []) if (!x.sheet) missing.push(`身份图 ${x.id}`);
    for (const s of b.scenes || []) if (!s.master) missing.push(`场景主图 ${s.id}`);
    for (const p of b.props || []) if (!p.ref_image) missing.push(`道具 ${p.id}`);
    if (missing.length) {
      warnings.push(`已过资产闸门但还没出资产：${missing.join('、')}——关键帧会退化成"每次用文字重新描述"，一致性没保障`);
    }
  }

  return { errors, warnings };
}

function checkBoard(board, opts = {}) {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  const errors = [];
  validateSchema(board, schema, 'board', errors);
  const injected = opts.inject ? ensureMarkers(board) : [];

  // 语义检查**即使 schema 有错也要跑**：一次把问题报全，让模型一轮改完。
  // 早退会让它先修格式、再修内容，白烧两轮。
  let warnings = [];
  try {
    const sem = validateSemantics(board);
    errors.push(...sem.errors);
    warnings = sem.warnings;
  } catch (e) {
    errors.push(`语义检查无法进行（结构损坏到读不下去）：${e.message}`);
  }
  return { errors, warnings, injected };
}

// ------------------------------------------------------------------- 渲染

function renderMarkdown(b, srcName) {
  const L = [];
  L.push(`# ${b.meta.title}`);
  L.push('');
  L.push(`> ${b.meta.logline}`);
  L.push('');
  L.push(`**类型** ${b.meta.genre || '-'}　**画幅** ${b.meta.aspect}　**风格** ${b.meta.style}　**总时长** ${b.meta.total_duration_s}s　**镜头数** ${b.shots.length}${srcName ? `　**源** \`${srcName}\`` : ''}`);
  L.push('');
  L.push('## 角色与造型');
  L.push('');
  L.push('| 角色 id | 名字 | 年龄段 | 脸（face_prompt） | 肖像 | 造型 |');
  L.push('|---|---|---|---|---|---|');
  for (const c of b.characters) {
    const looks = (b.identities || []).filter((x) => x.character === c.id);
    const lookText = looks.map((x) => `\`${x.id}\`${x.sheet ? '✅' : ''}`).join('、') || '—';
    L.push(`| \`${c.id}\` | ${c.name} | ${c.age_group || '-'} | ${c.face_prompt} | ${c.portrait ? '✅' : '—'} | ${lookText} |`);
  }
  L.push('');
  if ((b.identities || []).length) {
    L.push('**造型明细**（服装住这一层；镜头引用的是造型 id）');
    L.push('');
    L.push('| 造型 id | 角色 | 形态 | 服装 | 身份图 |');
    L.push('|---|---|---|---|---|');
    for (const x of b.identities) L.push(`| \`${x.id}\` | ${x.character} | ${x.name} | ${x.appearance_details} | ${x.sheet ? '✅' : '—'} |`);
    L.push('');
  }
  L.push('## 场景');
  L.push('');
  L.push('| id | 场景 | 环境 | 时间 | master | reverse | layout |');
  L.push('|---|---|---|---|---|---|---|');
  for (const s of b.scenes) {
    L.push(`| \`${s.id}\` | ${s.name} | ${s.environment} | ${s.time_of_day || '-'} | ${s.master ? '✅' : '—'} | ${s.reverse_master ? '✅' : '—'} | ${s.spatial_layout ? '✅' : '—'} |`);
  }
  L.push('');
  L.push('## 分镜表');
  L.push('');
  L.push('| # | 时长 | 景别 | 运镜 | 角色 | 动作 | 衔接 |');
  L.push('|---|---|---|---|---|---|---|');
  for (const s of b.shots) {
    L.push(`| ${s.id} | ${s.duration_s}s | ${s.shot_size} | ${s.camera} | ${(s.cast || []).join('、') || '-'} | ${s.action} | ${s.transition.type} |`);
  }
  L.push('');
  L.push('## 逐镜细节');
  for (const s of b.shots) {
    L.push('');
    L.push(`### ${s.id}　${s.shot_size} / ${s.camera} / ${s.duration_s}s`);
    L.push('');
    L.push(`- **画面**：${s.prompt}`);
    L.push(`- **音效**：${s.audio}`);
    if (s.dialogue && s.dialogue.length) {
      for (const d of s.dialogue) {
        const who = (b.identities || []).find((x) => x.id === d.character);
        L.push(`- **台词**：${who ? who.name : d.character}（${d.emotion || '平静'}）${d.kind === 'voiceover' ? '（画外音）' : ''}：「${d.text}」`);
      }
    } else {
      L.push('- **台词**：无（纯画面+环境音）');
    }
    if (s.first_frame || s.last_frame || s.clip) {
      L.push(`- **素材**：首帧 ${s.first_frame || '—'}｜末帧 ${s.last_frame || '—'}｜片段 ${s.clip || '—'}`);
    }
  }
  L.push('');
  return L.join('\n');
}

// ------------------------------------------------------------------ 阶段闸门

function stageIndex(board) {
  const i = STAGES.indexOf(board.meta?.stage);
  return i < 0 ? 0 : i;
}

function gateLabel(board) {
  return GATE_LABEL[board.meta?.stage] || board.meta?.stage || '未知';
}

/**
 * 下游消费前的闸门检查。规则只有一条：**用户没点头的东西不许往下走**。
 * need='shots' 需要 story 已确认；need='rendering' 需要四个闸门全部确认。
 *
 * 这里**只看 approvals，不看 stage**。stage 是「已经产出到哪一步」的描述，
 * 而 `from-story` 恰恰是把 stage 从 story 推到 shots 的那条命令 ——
 * 拿 stage 去拦它自己，等于要求"先有分镜表才能生成分镜表"。
 * stage 与 approvals 的一致性由 validateSemantics 负责，不在这里重复。
 */
function checkGate(board, need) {
  const needIdx = STAGES.indexOf(need);
  const errs = [];
  for (const g of GATES.slice(0, needIdx)) {
    if (!board.meta?.approvals?.[g]) errs.push(`approvals.${g} 为空：「${GATE_LABEL[g]}」还没确认`);
  }
  return errs;
}

// --------------------------------------------------- 给人看的那张表（闸门视图）

function gateLine(b) {
  const ok = (g) => (b.meta?.approvals?.[g] ? '✅' : '⬜');
  const mark = (g) => {
    const idx = STAGES.indexOf(g);
    if (b.meta?.approvals?.[g]) return '✅ 已确认';
    if (stageIndex(b) === idx) return '⏳ **等你确认**';
    return '⬜ 未开始';
  };
  return [
    `**① 故事** ${mark('story')}`,
    `**② 分镜表** ${mark('shots')}`,
    `**③ 资产** ${mark('assets')}`,
    `**④ 关键帧** ${mark('keyframes')}`,
    `**⑤ 出片** ${mark('rendering')}`,
  ].join('　｜　') + `\n\n当前停在：**${gateLabel(b)}**`;
}

function dialogueText(b, s) {
  if (!s.dialogue || !s.dialogue.length) return '—';
  return s.dialogue.map((d) => {
    const who = (b.identities || []).find((x) => x.id === d.character);
    return `${who ? who.name : d.character}：「${d.text}」`;
  }).join('<br>');
}

/** 闸门视图：一眼看清 4 步走到哪、下一步要确认什么。 */
function renderTable(b, srcName) {
  const L = [];
  const total = b.shots.reduce((a, s) => a + s.duration_s, 0);
  L.push(`# ${b.meta.title} · 分镜确认表`);
  L.push('');
  L.push(`> ${b.meta.logline}`);
  L.push('');
  L.push(gateLine(b));
  L.push('');

  // ① 故事
  L.push(`## ① 故事${b.meta.approvals?.story ? `　✅ 已确认（${b.meta.approvals.story.at}，by ${b.meta.approvals.story.by}）` : '　⏳ 等你确认'}`);
  L.push('');
  L.push(b.story.synopsis);
  L.push('');
  L.push('**节拍**');
  b.story.beats.forEach((x, i) => L.push(`${i + 1}. ${x.text || x}${x.purpose ? `　——　${x.purpose}` : ''}`));
  if (b.story.ending) {
    L.push('');
    L.push(`**结尾**：${b.story.ending}`);
  }
  if (b.story.tone) L.push(`**调性**：${b.story.tone}`);
  L.push('');

  // ② 分镜表
  L.push(`## ② 分镜表　${b.shots.length} 个镜头 / 共 ${total}s　${b.meta.approvals?.shots ? '✅ 已确认' : '⏳ 等你确认'}`);
  L.push('');
  L.push('| 镜号 | 时长 | 画面描述 | 景别 | 光影氛围 | 对白/旁白 | 音效 | 运镜 | 最终剪辑提示 | 状态 |');
  L.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const s of b.shots) {
    const st = s.clip ? '已出片' : s.first_frame ? '有首帧' : '待生成';
    L.push(`| ${s.id} | ${s.duration_s}s | ${s.action} | ${s.shot_size} | ${s.lighting} | ${dialogueText(b, s)} | ${s.audio} | ${s.camera} | ${s.edit_note || '—'} | ${st} |`);
  }
  L.push('');
  L.push('**角色**（所有镜头必须引用同一 id，这是防换脸的唯一手段）');
  L.push('');
  for (const c of b.characters) {
    const looks = (b.identities || []).filter((x) => x.character === c.id);
    L.push(`- \`${c.id}\`　${c.name}　${c.age_group}　${c.face_prompt}　｜　造型：${looks.map((x) => x.name).join('、') || '—'}　${c.portrait ? '（已有肖像）' : ''}`);
  }
  L.push('');
  L.push('**场景**');
  L.push('');
  for (const s of b.scenes) L.push(`- \`${s.id}\`　${s.name}　${s.environment}${s.master ? '　（已有场景主图）' : ''}`);
  L.push('');
  if (b.props && b.props.length) {
    L.push('**道具**（跨镜头出现的小物件，不做的话同一个球每镜长得不一样）');
    L.push('');
    for (const p of b.props) L.push(`- \`${p.id}\`　${p.name}　${p.description}${p.ref_image ? '　（已有道具图）' : ''}`);
    L.push('');
  }

  // ③ 关键帧
  const withFrame = b.shots.filter((s) => s.first_frame).length;
  L.push(`## ③ 关键帧　${withFrame}/${b.shots.length} 已出　${b.meta.approvals?.keyframes ? '✅ 已确认' : '⏳ 待办'}`);
  L.push('');
  L.push('每个镜头一张首帧图（用角色定妆图保持一致），确认后才开始烧算力出视频。');
  L.push('');
  L.push(`_源文件：\`${srcName || ''}\`_`);
  L.push('');
  return L.join('\n');
}

/** 只走到故事闸门时的视图：给用户读故事，不泄漏任何技术字段。 */
function renderStory(b, srcName) {
  const L = [];
  L.push(`# ${b.meta.title}`);
  L.push('');
  L.push(`> ${b.meta.logline}`);
  L.push('');
  L.push(gateLine(b));
  L.push('');
  L.push('## 故事');
  L.push('');
  L.push(b.story.synopsis);
  L.push('');
  L.push('**节拍**');
  b.story.beats.forEach((x, i) => L.push(`${i + 1}. ${x.text || x}${x.purpose ? `　——　${x.purpose}` : ''}`));
  if (b.story.ending) {
    L.push('');
    L.push(`**结尾**：${b.story.ending}`);
  }
  if (b.story.tone) L.push(`**调性**：${b.story.tone}`);
  L.push('');
  L.push(`**预估时长** ${b.meta.total_duration_s}s　**画幅** ${b.meta.aspect}　**风格** ${b.meta.style}`);
  L.push('');
  L.push(`_源文件：\`${srcName || ''}\`_`);
  L.push('');
  return L.join('\n');
}

// --------------------------------------------------------------------- plan

/**
 * 把 prompt 里的 {{造型id}} / [[道具id]] 展开成实际描述，并去掉标记。
 * 标记是**绑定**，不是给人读的 —— 渲染时它必须被换成该造型的服装描述。
 */
function expandMarkers(b, shot) {
  let text = String(shot.prompt || '');
  for (const id of markersIn(text)) {
    const x = (b.identities || []).find((v) => v.id === id);
    const ch = x ? (b.characters || []).find((c) => c.id === x.character) : null;
    const desc = x ? `${ch ? ch.name + '，' : ''}${x.appearance_details}` : id;
    text = text.split(`{{${id}}}`).join(desc);
  }
  for (const id of propMarkersIn(text)) {
    const p = (b.props || []).find((v) => v.id === id);
    text = text.split(`[[${id}]]`).join(p ? p.description : id);
  }
  return text;
}

function renderPlan(b, outDir) {
  const dir = outDir || String.raw`<工作区>\shots`;
  const L = [];
  L.push('# 由 board.mjs plan 生成：分镜 JSON → 生成命令清单');
  L.push('# 资产走线上（绘梦 image2 / qwen-image-3.0，要一致性），关键帧走本地（要便宜快）');
  L.push('$py = "E:\\AI-Image\\ComfyUI-aki-v1.4\\python\\python.exe"');
  L.push(`$gs = "${GEN}"`);
  L.push(`$out = "${dir}"`);
  L.push('');

  L.push('# ── 阶段 1a：角色肖像（脸部锚点）');
  L.push('# 硬约束：正面朝向 / 脸占画面 60-70% / 纯灰底 / 只穿素色上衣 / 禁服装细节、禁场景');
  L.push('# **故意不带风格圣经** —— 成片色调会把它拖进场景，就失去「锚」的意义了');
  for (const c of b.characters) {
    const p = `${c.age_group}，${c.face_prompt}。正面朝向，脸部占画面 60-70%，纯灰底，素色上衣，影棚均匀布光，不出现任何服装细节、道具和场景，禁止可读文字`;
    L.push(`& $py $gs t2i --prompt "${p}" --ratio 1:1 --out-dir $out --result-file "$env:TEMP\\cs.json"   # → ${c.id}_portrait.png`);
  }
  L.push('');

  L.push('# ── 阶段 1b：身份图（造型）—— 一次出 4 面板，不做拼接，天然一致');
  L.push('# Panel1 脸部特写 / Panel2 正面全身 / Panel3 约45°三分 / Panel4 背面');
  L.push('# 用肖像当 anchor；有 costume_image 就一起传 —— **脸取自第一张，衣取自第二张**');
  for (const x of b.identities || []) {
    const ch = (b.characters || []).find((c) => c.id === x.character);
    const p = `${ch ? ch.face_prompt + '，' : ''}${x.appearance_details}。一张 4 面板角色设定图：Panel1 脸部特写 / Panel2 正面全身 / Panel3 约45度三分 / Panel4 背面。Panel1 必须是 Panel2 头部的放大裁切，发型与领口一致，只允许视角变化`;
    const imgs = [`--image "$out\\${x.character}_portrait.png"`];
    if (x.costume_image) imgs.push(`--image "${x.costume_image}"`);
    L.push(`& $py $gs edit ${imgs.join(' ')} --prompt "${p}" --fast --out-dir $out --result-file "$env:TEMP\\cs.json"   # → ${x.id}_sheet.png`);
  }
  L.push('');

  L.push('# ── 阶段 1c：场景三件套');
  L.push('# master = 正面环境图（禁人、禁临时道具，它是这个场景的风格锚）');
  L.push('# reverse_master 的左右边缘必须与 master 的侧墙可缝合；spatial_layout = 俯视平面图');
  for (const s of b.scenes) {
    const base = `${b.meta.style_prompt ? b.meta.style_prompt + '，' : ''}${s.environment}`;
    L.push(`& $py $gs t2i --prompt "${base}，正面 160-180 度环境图，画面里没有任何人，没有任何临时道具" --ratio ${b.meta.aspect} --style ${b.meta.style} --out-dir $out --result-file "$env:TEMP\\cs.json"   # → ${s.id}_master.png`);
    L.push(`& $py $gs edit --image "$out\\${s.id}_master.png" --prompt "把镜头转到反向 180 度，其余保持一致；左右边缘要与原图的侧墙能缝合" --fast --out-dir $out --result-file "$env:TEMP\\cs.json"   # → ${s.id}_reverse.png`);
    L.push(`& $py $gs t2i --prompt "${s.environment}，俯视平面图，只用矩形表示墙体与出入口，没有任何人物" --ratio 1:1 --style ${b.meta.style} --out-dir $out --result-file "$env:TEMP\\cs.json"   # → ${s.id}_layout.png`);
  }
  L.push('');

  if ((b.props || []).length) {
    L.push('# ── 阶段 1d：道具三视图（正/侧/背），产品摄影白底，无手无人，禁止可读文字');
    for (const p of b.props) {
      L.push(`& $py $gs t2i --prompt "${p.description}，三视图：正面 / 侧面 / 背面，产品静物摄影，白底，画面里只有这一个物体，没有任何人物和场景，禁止可读文字" --ratio 1:1 --style ${b.meta.style} --out-dir $out --result-file "$env:TEMP\\cs.json"   # → ${p.id}_3view.png`);
    }
    L.push('');
  }

  L.push('# ── 阶段 2：逐镜关键帧 + 出片（串行跑，别并发提交视频任务）');
  L.push('# 关键帧默认走本地；角色不一致或构图不听话时，把同一 prompt 换到线上再出一张');
  const byScene = new Map(b.scenes.map((s) => [s.id, s]));
  b.shots.forEach((s, i) => {
    const prev = i > 0 ? b.shots[i - 1] : null;
    const scene = byScene.get(s.scene);
    const chained = prev && s.transition.type === 'last_frame_first';
    const base = expandMarkers(b, s);
    const prompt = `${base}；${scene ? scene.environment : ''}；运镜：${s.camera}；音效：${s.audio}`;
    L.push(`# ${s.id} ${s.shot_size}/${s.camera} ${s.duration_s}s${chained ? `（首帧接 ${prev.id} 末帧）` : '（硬切，需先出本镜首帧）'}　出场：${(s.cast || []).join('、') || '无'}`);
    if (chained) {
      const frame = prev.last_frame || `$out\\${prev.id}_last.jpg`;
      if (!prev.last_frame) {
        L.push(`# 从 ${prev.id} 的成片抽末帧回填 shots[${i - 1}].last_frame`);
        L.push(`# ffmpeg -sseof -0.1 -i "${prev.clip || `$out\\${prev.id}.mp4`}" -frames:v 1 "${frame}"`);
      }
      L.push(`& $py $gs i2v --image "${frame}" --prompt "${prompt}" --duration ${s.duration_s} --fast --out-dir $out --result-file "$env:TEMP\\cs.json"`);
    } else {
      const refs = (s.cast || []).map((id) => `"$out\\${id}_sheet.png"`);
      if (scene && scene.master) refs.push(`"$out\\${scene.id}_master.png"`);
      L.push(`# ① 首帧：有身份图就带参考走 edit（图生图），没有就 t2i`);
      if (refs.length) {
        L.push(`& $py $gs edit ${refs.map((r) => `--image ${r}`).join(' ')} --prompt "${prompt}" --fast --out-dir $out --result-file "$env:TEMP\\cs.json"   # → ${s.id}_first.png`);
      } else {
        L.push(`& $py $gs t2i --prompt "${prompt}" --ratio ${b.meta.aspect} --style ${b.meta.style} --out-dir $out --result-file "$env:TEMP\\cs.json"   # → ${s.id}_first.png`);
      }
      L.push(`# ② 让它动起来`);
      L.push(`& $py $gs i2v --image "$out\\${s.id}_first.png" --prompt "${prompt}" --duration ${s.duration_s} --fast --out-dir $out --result-file "$env:TEMP\\cs.json"`);
    }
    L.push(`# ↑ 出片后回填 shots[${i}].clip`);
  });
  L.push('');
  L.push('# ── 阶段 3：拼接（ffmpeg concat，按 shots[] 顺序）');
  L.push('# 台词走 TTS（miniMax / IndexTTS2），时长由音频反推，再与画面对齐');
  return L.join('\n');
}

// ---------------------------------------------------------------- from-story

function extractJson(text) {
  if (!text) throw new Error('模型返回为空');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  try { return JSON.parse(body); } catch {}
  const start = body.indexOf('{');
  if (start < 0) throw new Error('模型返回里找不到 JSON');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return JSON.parse(body.slice(start, i + 1));
  }
  throw new Error('JSON 括号不闭合');
}

async function listModels() {
  const res = await fetch(`${OLLAMA}/api/tags`);
  if (!res.ok) throw new Error(`本机 Ollama 不可用（HTTP ${res.status}）——先启动 ollama serve`);
  const data = await res.json();
  return (data.models || []).map((m) => m.name);
}

/** 本机模型随时会被增删，硬编码模型名是坑：找不到就自动降级到同族，再不行列出可选项。 */
async function ensureModel(name) {
  const models = await listModels();
  if (models.includes(name)) return name;
  const family = name.split(':')[0];
  const same = models.filter((m) => m.split(':')[0] === family);
  if (same.length) {
    process.stderr.write(`  （本机没有 ${name}，自动改用 ${same[0]}）\n`);
    return same[0];
  }
  throw new Error(`本机没有模型 ${name}，也没有同族的。现可用：\n  - ${models.join('\n  - ')}\n用 --model <名字> 指定`);
}

// qwen3 系支持 /no_think 关掉思考链，能显著省 token
function withNoThink(system, model) {
  return system + (/^qwen3[.:]/.test(model) ? '\n/no_think' : '');
}

async function ollamaChat(model, messages) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${OLLAMA}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages, stream: false, options: { temperature: 0.6, num_ctx: 16384 } }),
      });
      if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
      const data = await res.json();
      return data.message?.content || '';
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 800 * attempt));
    }
  }
  throw lastErr;
}

// ------------------------------------------------- 确定性补强：把模型产出整理成契约要求的样子

const AGE_GROUPS = ['child', 'youth', 'middle', 'elder'];

/** 节拍兜底：模型可能给字符串，契约要的是带 purpose 的对象。 */
function normalizeBeats(story) {
  const beats = (story && Array.isArray(story.beats)) ? story.beats : [];
  return beats.map((b) => (typeof b === 'string'
    ? { text: b, purpose: '未标注（待补）', emotion: '' }
    : { text: String(b && b.text || ''), purpose: String(b && b.purpose || '未标注（待补）'), emotion: String(b && b.emotion || '') }))
    .filter((b) => b.text.length >= 4);
}

/** 自由文本年龄 → 受控枚举。含糊的年龄等于把年龄交给模型抽签。 */
function ageGroupOf(text) {
  const t = String(text || '');
  const arabic = t.match(/(\d+)\s*岁/);
  let n = arabic ? Number(arabic[1]) : null;
  if (n === null) {
    const cn = t.match(/([一二三四五六七八九十]+)\s*岁/);
    if (cn) {
      const d = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
      const s = cn[1];
      n = s.length === 1 ? d[s]
        : s[0] === '十' ? 10 + (d[s[1]] || 0)
          : (d[s[0]] || 0) * 10 + (d[s[2]] || 0);
    }
  }
  if (n !== null && Number.isFinite(n)) {
    if (n <= 12) return 'child';
    if (n <= 30) return 'youth';
    if (n <= 55) return 'middle';
    return 'elder';
  }
  if (/幼|童|孩|稚/.test(t)) return 'child';
  if (/老|翁|妪|年迈|暮年/.test(t)) return 'elder';
  if (/中年/.test(t)) return 'middle';
  return 'youth';
}

const TIME_ENUM = ['无', '清晨', '上午', '正午', '午后', '白天', '黄昏', '夜晚'];
const TIME_ALIASES = {
  卯时: '清晨', 辰时: '上午', 巳时: '上午', 午时: '正午', 未时: '午后', 申时: '午后',
  酉时: '黄昏', 戌时: '夜晚', 亥时: '夜晚', 子时: '夜晚', 丑时: '夜晚', 寅时: '清晨',
  黎明: '清晨', 拂晓: '清晨', 早晨: '清晨', 早上: '清晨', 中午: '正午', 下午: '午后',
  傍晚: '黄昏', 日落: '黄昏', 晚上: '夜晚', 夜里: '夜晚', 深夜: '夜晚', 半夜: '夜晚',
};

/** 时间词归一：别让「卯时」「傍晚」这种写法把受控词表撑破。 */
function normalizeTimeOfDay(value) {
  const t = String(value || '').trim();
  if (TIME_ENUM.includes(t)) return t;
  if (TIME_ALIASES[t]) return TIME_ALIASES[t];
  for (const k of Object.keys(TIME_ALIASES)) if (t.includes(k)) return TIME_ALIASES[k];
  if (/晨|早/.test(t)) return '清晨';
  if (/午后|下午/.test(t)) return '午后';
  if (/午/.test(t)) return '正午';
  if (/昏|夕|暮/.test(t)) return '黄昏';
  if (/夜|晚/.test(t)) return '夜晚';
  return '无';
}

/**
 * 把模型产出的角色/造型整理成契约要求的样子。
 *
 * **不指望模型记得「双向一致」这种结构性约束** —— 那是代码的事。这里做四件：
 *   1. 每个角色至少有一个造型（没有就按它的服装描述造一个默认造型）
 *   2. `characters[].identities` 与 `identities[].character` 互为镜像
 *   3. 镜头手滑写了 `characters`（角色 id）→ 映射成 `cast`（造型 id）
 *   4. `age_group` 写成自由文本的 → 归一成枚举
 */
function normalizeIdentities(board) {
  const notes = [];
  board.identities = board.identities || [];
  board.props = board.props || [];
  board.characters = board.characters || [];

  const charIds = new Set(board.characters.map((c) => c.id));

  // 造型挂的角色必须存在（模型常把角色「名字」当 id 用）
  for (const x of board.identities) {
    if (charIds.has(x.character)) continue;
    const byName = board.characters.find((c) => c.name === x.character || c.id === x.character);
    if (byName) {
      notes.push(`identities: "${x.id}" 的 character 从 "${x.character}" 修正为 "${byName.id}"`);
      x.character = byName.id;
    }
  }

  for (const c of board.characters) {
    const raw = c.age_group;
    c.age_group = AGE_GROUPS.includes(raw) ? raw : ageGroupOf(raw || c.age || '');
    if (raw && c.age_group !== raw) notes.push(`characters: ${c.id} age_group「${raw}」→「${c.age_group}」`);
    delete c.age;

    if (!c.face_prompt) {
      c.face_prompt = c.appearance || `${c.name}的面部特征（待补）`;
      notes.push(`characters: ${c.id} 缺 face_prompt，用 appearance 顶上`);
    }
    delete c.appearance;
    if ('wardrobe' in c) {
      // 旧字段漏进来：把服装挪去造型层
      const owned = board.identities.find((x) => x.character === c.id);
      if (owned && !owned.appearance_details) owned.appearance_details = c.wardrobe;
      delete c.wardrobe;
    }
    if ('ref_image' in c) {
      const owned = board.identities.find((x) => x.character === c.id);
      if (owned && !owned.sheet) owned.sheet = c.ref_image;
      delete c.ref_image;
    }

    let owned = board.identities.filter((x) => x.character === c.id);
    if (!owned.length) {
      const ident = {
        id: `${c.id}_default`,
        character: c.id,
        name: '默认造型',
        appearance_details: `${c.name}的默认服装（待补）`,
        costume_image: null,
        sheet: null,
        reference_images: [],
        voice_ref: null,
      };
      board.identities.push(ident);
      owned = [ident];
      notes.push(`characters: ${c.id} 一个造型都没有，补了 ${ident.id}`);
    }
    c.identities = owned.map((x) => x.id);
  }

  // 丢掉挂不上角色的孤儿造型
  const before = board.identities.length;
  board.identities = board.identities.filter((x) => charIds.has(x.character));
  if (board.identities.length !== before) notes.push(`identities: 丢掉 ${before - board.identities.length} 个挂不上角色的造型`);

  // 场次时间词归一
  for (const s of board.scenes || []) {
    const raw = s.time_of_day;
    s.time_of_day = normalizeTimeOfDay(raw);
    if (raw && s.time_of_day !== raw) notes.push(`scenes: ${s.id} time_of_day「${raw}」→「${s.time_of_day}」`);
  }

  // 镜头：characters → cast
  const firstIdentity = new Map();
  for (const c of board.characters) {
    const owned = board.identities.filter((x) => x.character === c.id);
    if (owned.length) firstIdentity.set(c.id, owned[0].id);
  }
  const identIds = new Set(board.identities.map((x) => x.id));
  for (const sh of board.shots || []) {
    if (Array.isArray(sh.characters) && !sh.cast) {
      sh.cast = sh.characters.map((cid) => firstIdentity.get(cid) || cid);
      notes.push(`${sh.id}: characters → cast`);
    }
    delete sh.characters;
    sh.cast = sh.cast || [];
    sh.props = sh.props || [];
    for (const d of sh.dialogue || []) {
      if (!identIds.has(d.character) && firstIdentity.has(d.character)) d.character = firstIdentity.get(d.character);
      d.kind = d.kind || 'spoken';
    }
  }
  return notes;
}

async function ideaToStory(idea, opts) {
  const system = withNoThink(fs.readFileSync(STORY_PROMPT_PATH, 'utf8'), opts.model);
  const scene = [
    `请把下面这段素材写成一个故事，节拍数约 ${opts.beats} 条。`,
    '',
    '素材：',
    idea,
  ].join('\n');

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: scene },
  ];

  let board;
  for (let round = 0; round <= opts.retries; round++) {
    const t0 = Date.now();
    const text = await ollamaChat(opts.model, messages);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    try {
      const raw = extractJson(text);
      board = {
        meta: {
          ...raw.meta,
          aspect: raw.meta?.aspect || opts.ratio,
          style: raw.meta?.style || opts.style,
          language: raw.meta?.language || 'zh-CN',
          created_by: opts.model,
          stage: 'story',
          // 闸门票位由代码兜住，不指望模型知道我们有几个闸门
          approvals: { story: null, shots: null, assets: null, keyframes: null },
        },
        story: { ...raw.story, beats: normalizeBeats(raw.story), source: idea },
        props: [],
        characters: [],
        identities: [],
        scenes: [],
        shots: [],
      };
    } catch (e) {
      if (round === opts.retries) throw new Error(`第 ${round + 1} 轮 JSON 解析失败：${e.message}`);
      messages.push({ role: 'assistant', content: text });
      messages.push({ role: 'user', content: '上面不是合法 JSON。只输出一个 JSON 对象（只要 meta 和 story 两个键），不要任何解释。' });
      process.stderr.write(`  第 ${round + 1} 轮：JSON 解析失败，重试\n`);
      continue;
    }
    const { errors, warnings } = checkBoard(board);
    process.stderr.write(`  第 ${round + 1} 轮（${secs}s）：${errors.length} error / ${warnings.length} warning\n`);
    if (!errors.length) return { board, warnings, rounds: round + 1 };
    if (round === opts.retries) return { board, warnings, rounds: round + 1, errors };
    messages.push({ role: 'assistant', content: text });
    messages.push({
      role: 'user',
      content: `这份 JSON 没通过校验，逐条修好，只输出修好的完整 JSON：\n${errors.map((e) => `- ${e}`).join('\n')}`,
    });
  }
}

/** 用户确认过的故事与元信息不许被模型改写，这里强制带过来。 */
function carryMeta(input, generated, model) {
  const keep = ['title', 'logline', 'genre', 'language', 'aspect', 'style'];
  const meta = { ...generated };
  for (const k of keep) if (input?.[k] !== undefined) meta[k] = input[k];
  meta.created_by = model;
  meta.stage = 'shots';
  meta.approvals = { story: input?.approvals?.story || null, shots: null, assets: null, keyframes: null };
  return meta;
}

async function fromStory(input, opts) {
  const system = withNoThink(fs.readFileSync(PROMPT_PATH, 'utf8'), opts.model);

  // 剧本的场次头是格式化的 —— 先用正则**确定性**解析，再把结果当菜单交给模型。
  // 能确定性做的事不要交给模型：它会认错、会漏、会自己编一个场景出来。
  let sceneHint = '';
  if (input.story && input.story.source) {
    const parsed = parseScenes(input.story.source);
    if (parsed.looks_like_screenplay) {
      const menu = sceneMenu(parsed);
      sceneHint = [
        '',
        '【场次菜单】剧本的场次头已被确定性解析出来。**你必须从这份菜单里选场景，不要自己编**：',
        JSON.stringify(menu, null, 2),
        '每个 scene 的 id 用菜单里的 id；`name` 用 location；`time_of_day` 直接沿用菜单值；',
        '`environment` 由你按剧本描写补全（同一场景的镜头必须逐字一致）。',
      ].join('\n');
      process.stderr.write(`  场次正则解析：${parsed.scenes.length} 场 / ${parsed.episode_count} 集\n`);
    }
  }

  const scene = [
    `请把下面这个已经确认过的故事编译成 ${opts.shots} 个镜头的分镜表。`,
    opts.extra ? `额外要求：${opts.extra}` : '',
    sceneHint,
    '',
    '【已确认的故事】以下 story 与 meta 必须原样带进输出，一个字都不许改：',
    JSON.stringify({ meta: { ...input.meta, approvals: undefined, stage: undefined }, story: input.story }, null, 2),
    input.story && input.story.source
      ? '\n【原剧本】`story.source` 是原始素材，里面的台词必须**原样搬进 `dialogue`** —— '
        + '不许改写、不许合并、不许漏掉任何一句，也不许自己编新台词。'
        + '内心独白/旁白（原文里的 OS）用 `"kind": "voiceover"`，开口说话用 `"kind": "spoken"`。'
        + '台词在哪个镜头发，由你按原文顺序安排。'
      : '',
  ].filter(Boolean).join('\n');

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: scene },
  ];

  let board;
  for (let round = 0; round <= opts.retries; round++) {
    const t0 = Date.now();
    const text = await ollamaChat(opts.model, messages);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    try {
      const raw = extractJson(text);
      // story 与 meta 以输入为准，模型只负责 人物/造型/场景/道具/镜头
      board = {
        meta: carryMeta(input.meta, raw.meta, opts.model),
        story: input.story,
        characters: raw.characters || [],
        identities: raw.identities || [],
        scenes: raw.scenes || [],
        props: raw.props || [],
        shots: raw.shots || [],
      };
      for (const note of normalizeIdentities(board)) process.stderr.write(`    · ${note}\n`);
    } catch (e) {
      if (round === opts.retries) throw new Error(`第 ${round + 1} 轮 JSON 解析失败：${e.message}`);
      messages.push({ role: 'assistant', content: text });
      messages.push({ role: 'user', content: `上面不是合法 JSON。只输出一个 JSON 对象，不要任何解释。` });
      process.stderr.write(`  第 ${round + 1} 轮：JSON 解析失败，重试\n`);
      continue;
    }
    const { errors, warnings, injected } = checkBoard(board, { inject: true });
    process.stderr.write(`  第 ${round + 1} 轮（${secs}s）：${errors.length} error / ${warnings.length} warning\n`);
    for (const note of injected) process.stderr.write(`    · ${note}\n`);
    if (!errors.length) return { board, warnings, rounds: round + 1 };
    if (round === opts.retries) {
      process.stderr.write('  仍有 error：\n' + errors.map((e) => `    - ${e}`).join('\n') + '\n');
      return { board, warnings, rounds: round + 1, errors };
    }
    messages.push({ role: 'assistant', content: JSON.stringify(board) });
    messages.push({
      role: 'user',
      content: `这份 JSON 没通过校验，逐条修好，其余字段保持不变，只输出修好的完整 JSON：\n${errors.map((e) => `- ${e}`).join('\n')}`,
    });
  }
}

// --------------------------------------------------------------------- main

function die(msg) { process.stderr.write(msg + '\n'); process.exit(1); }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];

  // ── 闸门 1：故事 ────────────────────────────────────────────────
  if (cmd === 'story') {
    const file = args._[1];
    if (!file) die('用法：story <idea.txt> [--beats 6] [--model qwen3.5:27b] [--ratio 16:9] [--style realistic] [--out x.json]');
    if (!fs.existsSync(file)) die(`找不到素材文件：${file}`);
    const opts = {
      beats: Number(args.beats) || 6,
      model: typeof args.model === 'string' ? args.model : DEFAULT_MODEL,
      ratio: typeof args.ratio === 'string' ? args.ratio : '16:9',
      style: typeof args.style === 'string' ? args.style : 'realistic',
      retries: args.retries === undefined ? 1 : Number(args.retries),
    };
    opts.model = await ensureModel(opts.model);
    process.stderr.write(`→ ${opts.model} 写故事中（节拍≈${opts.beats}）…\n`);
    const { board, warnings, rounds, errors } = await ideaToStory(fs.readFileSync(file, 'utf8'), opts);
    // 默认写到「当前工作区」的 story2video/examples/，而不是 skill 自己的目录里
    const out = typeof args.out === 'string'
      ? args.out
      : path.join(process.cwd(), 'story2video', 'examples', path.basename(file).replace(/\.[^.]+$/, '') + '.storyboard.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(board, null, 2) + '\n');
    process.stderr.write(`${errors ? '⚠' : '✓'} 已写出 ${out}（${rounds} 轮，${board.story?.beats?.length || 0} 个节拍）\n`);
    for (const w of warnings) process.stderr.write(`  warning: ${w}\n`);
    process.stdout.write(out + '\n');
    if (errors) process.exitCode = 2;
    return;
  }

  // ── 人工确认：放行一个闸门 ──────────────────────────────────────
  if (cmd === 'approve') {
    const file = args._[1];
    const stage = typeof args.stage === 'string' ? args.stage : '';
    if (!file || !GATES.includes(stage)) {
      die('用法：approve <board.json> --stage story|shots|assets|keyframes [--by 用户名]');
    }
    const board = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (board.meta.approvals[stage]) {
      console.log(`「${GATE_LABEL[stage]}」此前已确认（${board.meta.approvals[stage].at}），跳过`);
      return;
    }
    const before = checkBoard(board);
    board.meta.approvals[stage] = {
      at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      by: typeof args.by === 'string' ? args.by : 'user',
    };
    board.meta.stage = GATES.find((g) => !board.meta.approvals[g]) || 'rendering';

    // 判定标准是「确认之后必须变干净」，不是「确认前必须干净」——
    // "缺前面那张票"这类错误，恰恰只能靠这次确认来修。
    const after = checkBoard(board);
    if (after.errors.length) {
      for (const e of before.errors) console.log(`  确认前就有：${e}`);
      for (const e of after.errors) console.log(`ERROR    ${e}`);
      die(`确认后仍有 ${after.errors.length} 个错误，没有写回——不能把带病的东西放行到下一阶段`);
    }
    fs.writeFileSync(file, JSON.stringify(board, null, 2) + '\n');
    process.stdout.write(`✅ 已确认「${GATE_LABEL[stage]}」 → 当前闸门：${gateLabel(board)}\n`);
    return;
  }

  // ── 闸门 2：分镜表 ──────────────────────────────────────────────
  if (cmd === 'from-story') {
    const file = args._[1];
    if (!file) die('用法：from-story <board.json> [--shots 6] [--model qwen3.5:27b] [--retries 1] [--force]');
    if (!fs.existsSync(file)) die(`找不到分镜文件：${file}`);
    const input = JSON.parse(fs.readFileSync(file, 'utf8'));
    const gateErrs = checkGate(input, 'shots');
    if (gateErrs.length && !args.force) {
      for (const e of gateErrs) console.log(`拦住：${e}`);
      console.log('\n先让用户确认故事：node tools/board.mjs approve ' + file + ' --stage story');
      process.exitCode = 3;
      return;
    }
    const opts = {
      shots: Number(args.shots) || 6,
      model: typeof args.model === 'string' ? args.model : DEFAULT_MODEL,
      retries: args.retries === undefined ? 1 : Number(args.retries),
      extra: typeof args.extra === 'string' ? args.extra : '',
    };
    opts.model = await ensureModel(opts.model);
    process.stderr.write(`→ ${opts.model} 编译分镜中（镜头数≈${opts.shots}，最多 ${opts.retries + 1} 轮）…\n`);
    const { board, warnings, rounds, errors } = await fromStory(input, opts);
    fs.writeFileSync(file, JSON.stringify(board, null, 2) + '\n');
    process.stderr.write(`${errors ? '⚠' : '✓'} 已写出 ${file}（${rounds} 轮，${board.shots?.length || 0} 镜，${board.meta?.total_duration_s || '?'}s）\n`);
    for (const w of warnings) process.stderr.write(`  warning: ${w}\n`);
    process.stdout.write(file + '\n');
    if (errors) process.exitCode = 2;
    return;
  }

  // ── 闸门 2（逐行模式）：剧本 → 分镜。**台词由代码搬运，模型碰不到** ──────
  // 和 from-story 的差别：那一种让模型"写一版分镜"，它会顺手改写台词；
  // 这一种是代码切行、代码分组、代码搬台词，逐字保真因此是构造保证。
  if (cmd === 'literal') {
    const file = args._[1];
    if (!file) die('用法：literal <board.json> [--force]');
    if (!fs.existsSync(file)) die(`找不到分镜文件：${file}`);
    const input = JSON.parse(fs.readFileSync(file, 'utf8'));
    const gateErrs = checkGate(input, 'shots');
    if (gateErrs.length && !args.force) {
      for (const e of gateErrs) console.log(`拦住：${e}`);
      console.log('\n先让用户确认故事：node src/board.mjs approve ' + file + ' --stage story');
      process.exitCode = 3;
      return;
    }
    const { board, report } = await compileLiteral(input);
    fs.writeFileSync(file, JSON.stringify(board, null, 2) + '\n');
    process.stderr.write(
      `✓ 逐行编译：剧本 ${report.source_lines} 行 → ${report.shots} 镜 / ${board.meta.total_duration_s}s\n`
      + `  台词 ${report.source_spoken} 句 → 产出 ${report.dialogue} 句，逐字保真 ${report.verbatim ? '✓' : '✗'}\n`
      + `  角色 ${board.characters.length}　造型 ${board.identities.length}　场景 ${board.scenes.length}\n`,
    );
    const { errors, warnings } = checkBoard(board);
    for (const w of warnings) process.stderr.write(`  warning: ${w}\n`);
    if (errors.length) {
      for (const e of errors) process.stderr.write(`  ERROR: ${e}\n`);
      process.exitCode = 2;
    }
    process.stdout.write(file + '\n');
    return;
  }

  // ── 给人看的那张表 ─────────────────────────────────────────────
  if (cmd === 'table' || cmd === 'render') {
    const file = args._[1];
    if (!file) die('用法：table <board.json> [--story] [--out x.md]');
    const board = JSON.parse(fs.readFileSync(file, 'utf8'));
    const name = path.basename(file);
    const md = (cmd === 'table' && !args.story) ? renderTable(board, name) : (cmd === 'render' ? renderMarkdown(board, name) : renderStory(board, name));
    const out = typeof args.out === 'string' ? args.out : file.replace(/\.json$/, cmd === 'render' ? '.md' : '.table.md');
    fs.writeFileSync(out, md);
    console.log(out);
    return;
  }

  if (cmd === 'validate') {
    const file = args._[1];
    if (!file) die('用法：validate <board.json>');
    const board = JSON.parse(fs.readFileSync(file, 'utf8'));
    const { errors, warnings } = checkBoard(board);
    for (const w of warnings) console.log(`warning  ${w}`);
    for (const e of errors) console.log(`ERROR    ${e}`);
    console.log(errors.length ? `\n✗ ${errors.length} 个错误，${warnings.length} 个警告` : `\n✓ 通过（${warnings.length} 个警告）　当前闸门：${gateLabel(board)}`);
    if (errors.length) process.exitCode = 1;
    return;
  }

  if (cmd === 'plan') {
    const file = args._[1];
    if (!file) die('用法：plan <board.json> [--out x.ps1] [--out-dir <工作区\\shots>]');
    const board = JSON.parse(fs.readFileSync(file, 'utf8'));
    const gateErrs = checkGate(board, 'rendering');
    if (gateErrs.length && !args.force) {
      for (const e of gateErrs) console.log(`拦住：${e}`);
      console.log(`\n当前闸门：${gateLabel(board)}。三步确认都做完才会放行。`);
      process.exitCode = 3;
      return;
    }
    const script = renderPlan(board, typeof args['out-dir'] === 'string' ? args['out-dir'] : '');
    const out = typeof args.out === 'string' ? args.out : file.replace(/\.json$/, '.plan.ps1');
    fs.writeFileSync(out, script);
    console.log(out);
    return;
  }

  die('用法：board.mjs <story|approve|from-story|literal|table|validate|render|plan> …');
}

// 只有直接执行时才跑 CLI —— 被 import 时（测试用）不跑
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main().catch((e) => die('失败：' + (e && e.stack ? e.stack : e)));

export { checkBoard, validateSemantics, ensureMarkers, normalizeIdentities, normalizeBeats, normalizeTimeOfDay, ageGroupOf, checkGate, parseArgs };
