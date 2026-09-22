/**
 * keyframes.mjs — 按导演的设计出关键帧（本地 Qwen / 百炼 / 火山 / 绘梦）。
 *
 * ## 提示词来源：LLM 直写制（2026-09-21 起，工程拼装退役）
 *
 * 每个单元的提示词由 LLM 抽卡师按 `references/draw-specialist.md` 直写，落盘在
 * `<项目>/keyframe-prompts/<unit-id>.txt`，本工具**逐字**送进模型 —— 不再拼装、
 * 不再删减（历史上的 buildLocalPrompt / refinePrompt / 构图覆盖那条代码链已删）。
 *
 * 缺该文件直接报错（报错里会列出本次挂载的参考图与编号，照着写就行）。
 * `auditPrompt` 机器审计保留：跑在直写文件上，只报告不阻断（废机器审核的既定边界）。
 *
 * ## 参考图编号约定（写提示词时必须对齐）
 *
 * - 本地通道：图1 = 场景主图（latent 基底），图2… = 身份图（一人一张，优先 sheet）；
 * - 百炼/火山：身份图在前，场景主图在最后；
 * - 交接单元会追加上一段稳定尾帧。
 * 实际编号以每次运行打印的「参考图」行为准 —— 那行与真正挂载的图片同源。
 *
 * 用法：
 *   node cli/keyframes.mjs <board.json> --direction <render.plan.json> [--units g001,g002] [--size 2k] [--bailian-size 1024*1792] [--dry-run]
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { projectAssetFiles, unitAssets } from '../src/asset-resolver.mjs';
import { planKeyframeFiles, requireApproval, writeReviewNote } from '../src/human-gates.mjs';
import { COMFY_GEN, NODE, requireComfyPython } from '../src/runtime-paths.mjs';
import * as bailian from '../src/providers/bailian.mjs';
import * as volcengine from '../src/providers/volcengine.mjs';
import { allowedChangesList, bindHandoffKeyframe, requireHandoff } from '../src/continuity-handoff.mjs';
import { installCliErrorHandler } from '../src/cli-errors.mjs';
import { KEYFRAME_PROVIDER, KEYFRAME_IMAGE_MODEL, HUIMENG_IMAGE_MODEL, KEYFRAME_SIZE, BAILIAN_KEYFRAME_SIZE, LOCAL_IMAGE_STEPS, LOCAL_IMAGE_CFG, LOCAL_KEYFRAME_FAST, LOCAL_KEYFRAME_SIZE, LOCAL_KEYFRAME_LORA, LOCAL_KEYFRAME_STEPS, LOCAL_KEYFRAME_CFG, LOCAL_IMAGE_MODEL, LOCAL_KEYFRAME_STEPS_21, LOCAL_KEYFRAME_CFG_21 } from '../src/config.mjs';
import { aspectOf, dimensionsForAspect } from '../src/aspect.mjs';
import { refImageLimit, withHandoffReference } from '../src/keyframe-references.mjs';
import { writeGenerationRecord } from '../src/generation-records.mjs';
import { auditPrompt } from '../src/draw-specialist.mjs';
import { localStyle } from '../src/providers/comfyui.mjs';

installCliErrorHandler();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true); };
const boardArg = argv.find((x) => /board.*\.json$/i.test(x) && !x.startsWith('--'));
if (!boardArg) {
  console.error('用法：node cli/keyframes.mjs <board.json> --direction <render.plan.json> [--units g001,g002]');
  process.exit(2);
}
const BOARD_PATH = path.resolve(boardArg);
const PROJ = path.dirname(BOARD_PATH);
const DIRECTION_PATH = path.resolve(String(flag('direction', path.join(PROJ, 'render.plan.json'))));
const DEFAULT_OUT = path.join(PROJ, 'keyframes_render');
const DRY = argv.includes('--dry-run');
const SIZE = String(flag('size', KEYFRAME_SIZE));
const BAILIAN_SIZE = String(flag('bailian-size', BAILIAN_KEYFRAME_SIZE));
const ONLY = String(flag('units', '')).split(',').map((s) => s.trim()).filter(Boolean);
const PROVIDER_SETTING = String(flag('provider', KEYFRAME_PROVIDER)).toLowerCase();
const PROVIDER = PROVIDER_SETTING === 'comfyui' ? 'local' : PROVIDER_SETTING;
if (!['huimeng', 'local', 'bailian', 'volcengine'].includes(PROVIDER)) throw new Error('--provider 只能是 huimeng / local / bailian / volcengine / comfyui');
const LOCAL_GEN = COMFY_GEN;
// 只在真要走本地时才解 Python —— 没配 AIH_PYTHON 但走线上通道的用户不该被这里卡住。
const LOCAL_PY = () => requireComfyPython();
const LOCAL_OUT = path.resolve(String(flag('out-dir', path.join(PROJ, 'keyframes_local_v2'))));
// 图像模型家族：qwen21（Qwen Image 2.1，默认）/ qwen（旧 2511 链路，逃生口）。
// 两族的采样参数完全不同 —— 21 没有蒸馏 LoRA，`FAST` 三件套只对 legacy 生效。
const IMAGE_MODEL = (() => {
  const v = String(flag('image-model', LOCAL_IMAGE_MODEL)).toLowerCase();
  if (!['qwen21', 'qwen'].includes(v)) throw new Error('--image-model 只能是 qwen21 / qwen');
  return v;
})();
const IS_QWEN21 = IMAGE_MODEL === 'qwen21';
// 步数/CFG/LoRA：**用户显式给了才传**，否则交给 gen.py 自己按模式定。
// 这一点在 Lightning 档尤其要命 —— 三者必须成套，错配（8 步 LoRA 配 20 步）会糊。
const LOCAL_STEPS = flag('steps', null);
const LOCAL_CFG = flag('cfg', null);
const LOCAL_LORA = flag('lora', null);
// 🔁 关键帧默认档 = Lightning 8 步加速栈（2026-09-20 与 DramaClaw 对照实测后定，
// 见 config.mjs 注释）。给了任一手动参数就完全交还给调用方，不做半自动叠加；
// `--no-fast` 退回 20 步非蒸馏旧路径。
const MANUAL_IMAGE = LOCAL_STEPS || LOCAL_CFG || LOCAL_LORA;
// FAST（Lightning 三件套）只对 legacy 家族（--image-model qwen）有意义；
// 2.1 没有蒸馏档，`localGenArgs` 在 qwen21 分支完全不读它。
const FAST = !argv.includes('--no-fast')
  && (argv.includes('--fast') || (LOCAL_KEYFRAME_FAST && !MANUAL_IMAGE));
if (MANUAL_IMAGE && !(LOCAL_STEPS && LOCAL_CFG && LOCAL_LORA)) {
  console.error('⚠ 步数/CFG/LoRA 只给了部分：剩下的交给 gen.py 兜底，可能凑出未验证的蒸馏档');
}
const BAILIAN_MODEL = String(flag('model', KEYFRAME_IMAGE_MODEL));
const BAILIAN_OUT = path.resolve(String(flag('out-dir', path.join(PROJ, 'keyframes_bailian'))));
const VOLCENGINE_OUT = path.resolve(String(flag('out-dir', path.join(PROJ, 'keyframes_volcengine'))));

const dir = JSON.parse(fs.readFileSync(DIRECTION_PATH, 'utf8'));
const board = JSON.parse(fs.readFileSync(BOARD_PATH, 'utf8'));
const ASPECT = aspectOf(board);
/**
 * 关键帧走 gen.py 的 `edit` 分支 —— 而 edit 过去把 negative **硬编码成空串**且不接受
 * `--style`，等于成片每一帧都拿不到 `realistic` 那套负向词（「CG感，卡通，动漫」），
 * 写实剧会系统性退化成插画（no_chute 实测：身份图三连插画、肖像与主图却正常，
 * 差别只在 t2i 有这张表）。上游已让 edit 也取预设，**这里必须显式传**，
 * 与 `cli/assets.mjs` 共用 `localStyle()`，别各写一份映射。
 */
// `--style` 可显式覆盖（如 `--style none` 用于对照实验）。⚠ 上游预设是**成对**给的：
// `style=none` 时 positive 追加与 negative **两者皆空** —— 去掉自动追加句会同时撤掉负向防线，
// 写实剧可能退回插画风。所以默认不覆盖，覆盖只用于有意的单变量实验。
const LOCAL_STYLE = flag('style', null) || localStyle(board.meta?.style);
const SKIP_GATE = argv.includes('--skip-gate');
const approvedAssets = projectAssetFiles(board, BOARD_PATH, { workspace: flag('ws', null) });
requireApproval(PROJ, 'assets', approvedAssets, { skip: SKIP_GATE });
// 板子票（与 assets.mjs 同一条规矩）：board.json 决定场景清单与参考图来源，改了必须重新确认。
requireApproval(PROJ, 'board', [BOARD_PATH], { skip: SKIP_GATE });
// 🔁 **这张票原先绑的是 `render.plan.json`，与 `compile-units` 互斥**（2026-09-17 after_waking 复发）：
//    `compile-units.mjs:28` 要求 `direction` 票绑**导演稿** `board.direction.json`；
//    这里原先要求绑**执行计划** `--direction`。而票据只有一个 `artifact_hash` 槽位 ——
//    **签任何一个，另一个必然报「产物已变化，旧确认自动失效」**，流程在同一张票上死锁。
//
//    这条 2026-09-17 13:17 已经以"操作失误"记过一次（批成了 board.direction.json），
//    没被识别成代码缺陷，所以同一个坑原样复发。
//
//    现在机器不再反证计划来源：票就绑导演稿，与 compile-units 对齐，不再有第二套哈希。
requireApproval(PROJ, 'direction', [path.join(PROJ, 'board.direction.json')], { skip: SKIP_GATE });

function refsFor(shot, unit) {
  const assetUnit = unit.keyframe_cast ? { ...unit, cast: unit.keyframe_cast } : unit;
  const assets = unitAssets(board, BOARD_PATH, assetUnit, { workspace: flag('ws', null) });
  const people = assets.people.flatMap((person) => [
    { file: person.portrait, role: 'portrait', character: person.characterId },
    { file: person.sheet, role: 'sheet', character: person.characterId },
  ]);
  if (PROVIDER === 'local' || PROVIDER === 'bailian' || PROVIDER === 'volcengine') {
    // 参考位容量按「通道 + 图像模型家族」算（`refImageLimit`）：本地 2.1 是 16 张，
    // 旧 qwen 家族与百炼/火山仍是 3 张。**场景占 1 位**，其余给角色。
    // 原先硬编码 `> 2` 是把 2.1 的能力当成了旧家族的 3 —— 见 src/keyframe-references.mjs 的来历。
    const capacity = refImageLimit(PROVIDER, IMAGE_MODEL);
    if (assets.people.length + 1 > capacity) {
      throw new Error(`${unit.id}: 参考位共 ${capacity} 个、场景占 1 个，最多只能精确锚定 ${capacity - 1} 名角色；请让导演拆分镜头`);
    }
    if (PROVIDER === 'bailian' || PROVIDER === 'volcengine') {
      return [
        ...assets.people.map((person) => ({
          file: person.sheet || person.portrait,
          role: person.sheet ? 'sheet' : 'portrait',
          character: person.characterId,
        })),
        { file: assets.sceneMaster, role: 'scene' },
      ];
    }
    // 🔁 **一个角色只给一张身份参考，且优先身份图、不要肖像**（2026-09-17 after_waking）。
    //
    // 原先是「1 人时给 [场景, 肖像, 身份图]，2 人时只给 [场景, 肖像A, 肖像B]」，两个分支都不对：
    //   · 肖像与身份图**互相矛盾**时模型随机选边。实测换性别的剧里，肖像（短发男）
    //     和身份图（长发女装）同时进来，g001 画成男孩、g002 画成"镜前男孩+镜中女孩"、
    //     g004 却又画对 —— 同一批参考图出三种结果，这就是矛盾被随机裁决的样子。
    //   · 根因是契约本身：`characters[].portrait` 挂在**角色**上，而**头发是画在肖像里的**。
    //     一个角色有多套发型不同的造型时，肖像只能匹配其中一套，其余必然冲突。
    //   · 2 人时丢掉身份图更糟：服装描述整个没了，只剩两张脸。
    //
    // 身份图（4 面板）的 Panel1 本来就是**脸部特写**，锁脸不缺依据；而服装只有身份图有。
    // 所以「优先身份图」同时锁住脸和服装，还省下一个参考位。
    // `bailian` 分支下面一直就是这么写的，这里把 local 对齐过去。
    const anchored = assets.people.map((person) => ({
      file: person.sheet || person.portrait,
      role: person.sheet ? 'sheet' : 'portrait',
      character: person.characterId,
    }));
    return [
      { file: assets.sceneMaster, role: 'scene' },
      ...anchored,
    ];
  }
  const refs = [
    ...people,
    { file: assets.sceneMaster, role: 'scene' },
    ...assets.props.map((prop) => ({ file: prop.file, role: 'prop', name: prop.name })),
  ];
  if (refs.length > 9) throw new Error(`${unit.id}: 需要 ${refs.length} 张参考图，超过通道上限 9；请让导演拆分镜头或精简资产`);
  return refs;
}

// ── 本地通道真正下发给 gen.py 的 argv ───────────────────────────────────────
// 干跑与实际出图共用这一个来源，保证「看到的」就是「跑的」。
// 2026-09-20 排查"画面发黑"，根因之一正是当时看不到真正下发的参数。
function localGenArgs(unit, refs, prompt) {
  const a = [LOCAL_GEN, 'edit', '--prompt', prompt, '--ratio', ASPECT,
    '--style', LOCAL_STYLE, '--out-dir', LOCAL_OUT,
    '--result-file', path.join(LOCAL_OUT, `.${unit.id}.result.json`),
    // 家族显式下发，不依赖上游默认值（上游改默认时本仓行为不能跟着漂）。
    '--image-model', IMAGE_MODEL];
  if (IS_QWEN21) {
    // 2.1：官方档 25 步 cfg 1，**没有**蒸馏 LoRA。MANUAL 覆盖仍然逐项尊重 ——
    // 其中 --lora 上游会直接拒绝（骨架错配），那个报错是故意的，别在本仓吞掉它。
    if (MANUAL_IMAGE) {
      if (LOCAL_STEPS) a.push('--steps', String(LOCAL_STEPS));
      if (LOCAL_CFG) a.push('--cfg', String(LOCAL_CFG));
      if (LOCAL_LORA) a.push('--lora', String(LOCAL_LORA));
    } else {
      a.push('--steps', LOCAL_KEYFRAME_STEPS_21, '--cfg', LOCAL_KEYFRAME_CFG_21);
    }
  } else if (FAST) {
    // 成套下发：默认档具体用哪支 LoRA 由本仓说了算，不走上游 `--fast`
    // （那里写死的是官方 Edit-4steps）。LoRA / 步数 / CFG 三者必须配对，错配会糊。
    a.push('--steps', LOCAL_KEYFRAME_STEPS, '--cfg', LOCAL_KEYFRAME_CFG, '--lora', LOCAL_KEYFRAME_LORA);
  } else {
    if (LOCAL_STEPS) a.push('--steps', String(LOCAL_STEPS));
    else a.push('--steps', LOCAL_IMAGE_STEPS);
    if (LOCAL_CFG) a.push('--cfg', String(LOCAL_CFG));
    else a.push('--cfg', LOCAL_IMAGE_CFG);
    if (LOCAL_LORA) a.push('--lora', String(LOCAL_LORA));
  }
  // 输出尺寸：显式 --width/--height 优先，否则按 **剧目画幅** 排布默认像素
  // （edit 默认不看目标尺寸，这里必须给，否则 FluxKontextImageScale 会把输出压到 ~1MP）。
  const LW = flag('width', null), LH = flag('height', null);
  const sizeArg = (LW && LH) ? `${LW}x${LH}` : dimensionsForAspect(LOCAL_KEYFRAME_SIZE, ASPECT);
  const [outW, outH] = sizeArg.split('x');
  a.push('--width', outW, '--height', outH);
  for (const ref of refs) a.push('--image', ref.file);
  return a;
}

// ---------------------------------------------------------------- 主流程

console.log(`\n出关键帧　共 ${dir.units.length} 个单元`);
let failures = 0;

const trims = [];
for (const unit of dir.units) {
  if (ONLY.length && !ONLY.includes(unit.id)) continue;
  let handoff = null;
  if (['reference_previous', 'continue_previous'].includes(unit.continuity?.mode)) {
    if (!ONLY.length) throw new Error(`${unit.id}: 依赖前段的单元禁止随整批提前生成关键帧；请在上一段通过后用 --units ${unit.id} 单独生成`);
    handoff = requireHandoff(PROJ, unit, { requireKeyframe: false });
    requireApproval(PROJ, 'handoff', [handoff.stable_frame], { id: unit.id, skip: SKIP_GATE });
  }
  const shot = unit.shots[0];
  let refs = refsFor(shot, unit);
  if (handoff) refs = withHandoffReference(refs, handoff.stable_frame, PROVIDER, { imageModel: IMAGE_MODEL });
  // 参考图表：与真正挂载的图片同源（refsFor / withHandoffReference 的产物）。
  // LLM 抽卡师写提示词时的「图N=职责」编号必须对齐这一行 —— 看到的就是跑的。
  const REF_ROLE_LABEL = {
    handoff: '上一段实际稳定尾帧（继承姿态与空间状态）',
    scene: '场景参考（环境、光线、色调）',
    portrait: '人物脸部参考',
    sheet: '人物身份参考（脸、发型、服装）',
    prop: '道具参考',
  };
  const refTable = refs.map((r, i) => `图${i + 1}=${REF_ROLE_LABEL[r.role] || r.role}${r.name ? `（${r.name}）` : ''} ${path.basename(r.file)}`).join('；');
  // ── 提示词来源：LLM 直写文件（2026-09-21 起，工程拼装退役）──────────────
  // 直写文件逐字送模型：没有拼装、没有删减。缺文件是硬错误 —— 提示词不存在就没有
  // 什么可跑的，静默回退工程拼装等于让「废弃」永远不生效。
  const promptFile = path.join(PROJ, 'keyframe-prompts', `${unit.id}.txt`);
  if (!fs.existsSync(promptFile)) {
    throw new Error([
      `${unit.id}: 缺少 LLM 直写提示词 keyframe-prompts/${unit.id}.txt`,
      '工程拼装已于 2026-09-21 退役，本工具不再代写提示词。请按 references/draw-specialist.md 直写后重跑。',
      `本次将挂载的参考图（提示词里的图N 编号必须与此一致）：${refTable}`,
    ].join('\n'));
  }
  const modelPrompt = fs.readFileSync(promptFile, 'utf8').trim();
  const out = PROVIDER === 'local'
    ? path.join(LOCAL_OUT, `${unit.id}.png`)
    : PROVIDER === 'bailian'
    ? path.join(BAILIAN_OUT, `${unit.id}.png`)
    : PROVIDER === 'volcengine'
    ? path.join(VOLCENGINE_OUT, `${unit.id}.png`)
    : unit.keyframe
    ? path.resolve(PROJ, unit.keyframe)
    : path.join(DEFAULT_OUT, `${unit.id}.png`);
  fs.mkdirSync(path.dirname(out), { recursive: true });

  console.log(`\n${'─'.repeat(68)}`);
  console.log(`  【${unit.id}】${shot.framing}　参考图 ${refs.length} 张：${refTable}`);
  console.log(`  ── LLM 直写提示词（keyframe-prompts/${unit.id}.txt，逐字送模型）`);
  console.log(modelPrompt.split('\n').map((l) => '    ' + l).join('\n'));
  // 机器审计跑在直写文件上 —— 送进模型的是它，要审的也是它。只报告不阻断（废机器审核的边界）。
  const audit = auditPrompt(modelPrompt);
  if (audit.violations.length) {
    console.log(`    ⚠ 提示词自检：${audit.chars} 字，${audit.violations.length} 项违规（见 references/prompt-rules.md）`);
    for (const v of audit.violations) console.log(`      · [${v.rule}] ${v.hit}`);
  } else {
    console.log(`    ✓ 提示词自检通过：${audit.chars} 字`);
  }
  trims.push({ id: unit.id, file: path.relative(PROJ, promptFile), chars: audit.chars, violations: audit.violations.map((v) => `[${v.rule}] ${v.hit}`) });
  if (DRY) {
    if (PROVIDER === 'local') {
      const argv = localGenArgs(unit, refs, modelPrompt).slice(1);
      // 提示词整段已在上面打印过，这里用占位符，免得同一段话再铺一遍
      const shown = argv.map((v, i) => (argv[i - 1] === '--prompt'
        ? `<${modelPrompt.length} 字>`
        : (String(v).includes(' ') ? `"${v}"` : v)));
      console.log(`    gen.py argv（实际下发）：${shown.join(' ')}`);
    } else {
      console.log(`    通道：${PROVIDER}（非本地通道，不走 gen.py）`);
    }
    continue;
  }

  let r;
  let got = false;
  let secs = '?';
  let txt = '';
  if (PROVIDER === 'local') {
    const resultFile = path.join(LOCAL_OUT, `.${unit.id}.result.json`);
    // 与干跑同源：真正跑的就是刚才打印的那一串
    const a = localGenArgs(unit, refs, modelPrompt);
    const started = Date.now();
    r = spawnSync(LOCAL_PY(), a, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 900000 });
    secs = String(Math.round((Date.now() - started) / 1000));
    txt = String(r.stdout || '') + String(r.stderr || '');
    try {
      const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
      const produced = result.local_files && result.local_files[0];
      if (result.ok && produced && fs.existsSync(produced)) {
        fs.copyFileSync(produced, out);
        got = true;
      }
    } catch { /* 报错统一在下面显示 */ }
  } else if (PROVIDER === 'bailian' || PROVIDER === 'volcengine') {
    const channelOut = PROVIDER === 'bailian' ? BAILIAN_OUT : VOLCENGINE_OUT;
    const requestOut = path.join(channelOut, 'raw', unit.id);
    fs.mkdirSync(requestOut, { recursive: true });
    const requestDir = path.join(requestOut, '_request');
    fs.mkdirSync(requestDir, { recursive: true });
    // 走 `providers/bailian.mjs`，它内部直连 CLI（**不是** `bl.ps1`，本机 PowerShell 起不了外部进程）。
    // 这里不再自己拼 PS 脚本 —— 通道只该有一个所有者，否则两边会各自漂移。
    const started = Date.now();
    const channel = PROVIDER === 'bailian' ? bailian : volcengine;
    const res = await channel.edit({
      images: refs.map((ref) => ref.file),
      instruction: modelPrompt,
      size: PROVIDER === 'bailian' ? dimensionsForAspect(BAILIAN_SIZE, ASPECT, '*') : '2K',
      n: 1,
      outDir: requestOut,
      prefix: unit.id,
      model: PROVIDER === 'bailian' ? BAILIAN_MODEL : undefined,
      timeoutMs: 360000,
    });
    secs = String(Math.round((Date.now() - started) / 1000));
    txt = String(res.stdout || '') + String(res.stderr || '') + String(res.error || '');
    // `_request/` 留档：这一镜当时到底发了什么。正文 + 实际 argv 各存一份。
    fs.writeFileSync(path.join(requestDir, 'prompt.txt'), modelPrompt, 'utf8');
    fs.writeFileSync(path.join(requestDir, 'command.json'), JSON.stringify({ provider: PROVIDER, model: res.json?.model || null }, null, 2) + '\n', 'utf8');
    const produced = res.files[0];
    if (res.status === 0 && produced && fs.existsSync(produced)) {
      fs.copyFileSync(produced, out);
      got = true;
    }
  } else {
    // 同样送 `modelPrompt`：抽卡师整理不该只对本地/百炼通道成立。
    const a = ['cli/huimeng.mjs', '--prompt', modelPrompt, '--ratio', ASPECT, '--resolution', SIZE,
      '--model', HUIMENG_IMAGE_MODEL];
    for (const ref of refs) a.push('--ref', ref.file);
    a.push('--out', out);
    r = spawnSync(NODE, a, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 900000, cwd: ROOT });
    txt = String(r.stdout || '') + String(r.stderr || '');
    got = /✓/.test(txt) && fs.existsSync(out);
    secs = (txt.match(/用时 (\d+) 秒/) || [])[1] || '?';
  }
  if (!got) failures++;
  else {
    // **计划槽位是契约，不是可选项。**
    //
    // `generation-plan.mjs` 给每个单元声明了 `unit.keyframe`，而下一环
    // （`cli/unit.mjs`）和关键帧票据**都只认它**。通道目录各写各的
    // （local → keyframes_local_v2、bailian → keyframes_bailian），
    // 于是产物和票绑在通道目录、下一环去计划槽位取图 —— 两边永远对不上，
    // 实测报「关键帧 产物已变化，旧确认自动失效」，这一环永远开不了。
    //
    // 所以：通道目录从今天起只是**草稿区**，生成成功后必须落到计划槽位。
    const slot = unit.keyframe ? path.resolve(PROJ, unit.keyframe) : null;
    if (slot && path.resolve(slot) !== path.resolve(out)) {
      fs.mkdirSync(path.dirname(slot), { recursive: true });
      fs.copyFileSync(out, slot);
    }
    if (handoff) bindHandoffKeyframe(PROJ, unit, out);
  }
  console.log(`    ${got ? '✓' : '✗'} ${got ? `${(fs.statSync(out).size / 1048576).toFixed(2)} MB　${secs} 秒` : txt.slice(0, 200)}`);
}
if (failures) {
  console.error(`\n✗ ${failures} 个关键帧生成失败`);
  process.exitCode = 1;
} else {
  const generated = planKeyframeFiles(PROJ, dir);
  const generationRecord = writeGenerationRecord(PROJ, 'keyframes', {
    provider: PROVIDER,
    model: PROVIDER === 'local' ? `local-comfyui/${IMAGE_MODEL}` : PROVIDER === 'bailian' ? BAILIAN_MODEL : PROVIDER === 'volcengine' ? process.env.AIH_VOLCENGINE_IMAGE_MODEL : HUIMENG_IMAGE_MODEL,
    requested_provider: PROVIDER_SETTING || null,
    artifacts: generated,
    plan: DIRECTION_PATH,
    // 2026-09-21 LLM 直写制：记录每个单元实际使用的直写提示词文件，
    // 替代旧的 execution_overrides（构图覆盖机制随工程拼装一同退役）。
    prompt_files: dir.units
      .filter((unit) => !ONLY.length || ONLY.includes(unit.id))
      .map((unit) => `keyframe-prompts/${unit.id}.txt`),
  });
  const note = writeReviewNote(PROJ, 'keyframes', [
    '# 关键帧人工审阅', '',
    '机器检查只能判定是否可送审。请逐张查看人物身份、体型比例、构图、动作起点和场景连续性。', '',
    ...generated.map((f) => `- ${path.basename(f)}: ${f}`), '',
    // 直写制留档：审图时要能对上「模型到底收到了什么」—— 提示词不再由代码生成，
    // 它就是 keyframe-prompts/ 下的直写文件本身，审它=审送模型的东西。
    '## 送模型的提示词（LLM 直写文件，逐字送模型）', '',
    ...trims.map((t) => [
      `- **${t.id}**：${t.file}，送模型 ${t.chars} 字${t.violations.length ? `，⚠ ${t.violations.join('；')}` : '，自检通过'}`,
    ]).flat(), '',
    `生成记录：${generationRecord}`,
    `确认命令：node cli/review-gate.mjs approve --project "${PROJ}" --stage keyframes --plan "${DIRECTION_PATH}"`,
  ]);
  console.log('\n关键帧绝对路径（请直接打开并逐张确认）：');
  for (const file of generated) console.log(`  · ${path.resolve(file)}`);
  console.log(`\n完成。等待人工审阅：${note}`);
}
