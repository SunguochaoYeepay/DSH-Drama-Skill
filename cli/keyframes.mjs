/**
 * keyframes.mjs — 按导演的设计出关键帧（绘梦 / 本地 Qwen / 百炼）。
 *
 * ## 为什么要有这个工具，而不是临时编提示词
 *
 * 第一版我是**临时手编提示词**的，结果：
 * ```
 * u2 要「中景（腰部以上）」→ 出成切在大腿
 * u3 要「特写（只有脸）」  → 出成近景，肩部入画
 * ```
 * 质检两条都判了不合格。**根因和三视图一样：景别只写了软描述，没写硬边界。**
 *
 * 所以这里把**每个景别翻译成硬约束**（下边界切在哪、不许出现什么），
 * 写在提示词最前面，而且**每条都要指名"不允许"的那一侧** ——
 * 因为模型会往两边都偏。
 *
 * ## 参考图
 *
 * 脸从**肖像**锁、服装从**身份图**锁、环境从**场景 master** 锁。
 * 绘梦不支持 base64，`huimeng.mjs` 会自动传 Cloudinary 换公开 URL。
 *
 * 用法：
 *   node cli/keyframes.mjs <board.json> --direction <render.plan.json> [--units g001,g002] [--size 2k] [--dry-run]
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { projectAssetFiles, unitAssets } from '../src/asset-resolver.mjs';
import { requireApproval, writeReviewNote } from '../src/human-gates.mjs';
import { COMFY_GEN, COMFY_PYTHON } from '../src/runtime-paths.mjs';
import { bindHandoffKeyframe, requireHandoff } from '../src/continuity-handoff.mjs';
import { installCliErrorHandler } from '../src/cli-errors.mjs';

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
const SIZE = String(flag('size', '2k'));
const ONLY = String(flag('units', '')).split(',').map((s) => s.trim()).filter(Boolean);
const PROVIDER = String(flag('provider', 'huimeng')).toLowerCase();
if (!['huimeng', 'local', 'bailian'].includes(PROVIDER)) throw new Error('--provider 只能是 huimeng / local / bailian');
const LOCAL_GEN = COMFY_GEN;
const LOCAL_PY = COMFY_PYTHON;
const LOCAL_OUT = path.resolve(String(flag('out-dir', path.join(PROJ, 'keyframes_local_v2'))));
const LOCAL_STEPS = String(flag('steps', '20'));
const LOCAL_CFG = String(flag('cfg', '4'));
const BAILIAN_MODEL = String(flag('model', 'qwen-image-3.0-pro'));
const BAILIAN_OUT = path.resolve(String(flag('out-dir', path.join(PROJ, 'keyframes_bailian'))));

/**
 * ## 景别 → 硬边界
 *
 * **软描述没用。** 第一版写「中景（腰部以上）」，出来切在大腿。
 * 所以每条都写清三件事：**上边界、下边界、以及两侧不允许出现的**。
 */
export const FRAMING = {
  远景: {
    rule: '【景别｜远景】画面以**环境为主**，人物只占很小一块（**不超过画面高度的 1/4**）。'
      + '能看到大片树林和整条古道。**不允许**人物占满画面，**不允许**能看清脸部细节。',
    en: 'extreme long shot, figures very small in a vast environment',
  },
  全景: {
    rule: '【景别｜全景】画面**必须包含人物的完整身体** —— **从头顶一直到脚底（或裙摆落地处）都在画面内**，'
      + '人物高度约占画面高度的 1/2 到 2/3，四周留出环境。'
      + '**绝不允许裁掉脚部**，**也不允许**人物小到只占一角。',
    en: 'full shot, complete body head-to-toe visible, environment around',
  },
  中景: {
    rule: '【景别｜中景】**画面下边界严格切在人物的腰部**（腰带/腰线位置），'
      + '画面里只有**头顶到腰部**这一段。'
      + '**绝不允许出现大腿或膝盖**（那就成了全景），**也绝不允许只到胸口**（那就成了近景）。',
    en: 'medium shot, framed from head down to the waist ONLY',
  },
  近景: {
    rule: '【景别｜近景】**画面只取胸部以上** —— 下边界在**胸口到腰之间、明显高于腰线**。'
      + '能看到肩膀和上胸，脸部占画面较大比例。'
      + '**绝不允许出现腰部以下**（那就成了中景），**也不允许只剩一个头**（那就成了特写）。',
    en: 'medium close-up, framed from head down to mid-chest ONLY',
  },
  特写: {
    rule: '【景别｜特写】**画面里只有脸** —— 从下巴下方一点点到头顶，**头部占满整个画面**。'
      + '**绝不允许出现肩膀或衣领**（那就不算特写），**也不允许只拍半张脸**。',
    en: 'extreme close-up, the face fills the entire frame, no shoulders visible',
  },
};

const NO_TEXT = '【禁止】画面里**不许出现任何文字、字幕、水印、logo、边框、色卡**。';

const dir = JSON.parse(fs.readFileSync(DIRECTION_PATH, 'utf8'));
const board = JSON.parse(fs.readFileSync(BOARD_PATH, 'utf8'));
const SKIP_GATE = argv.includes('--skip-gate');
const approvedAssets = projectAssetFiles(board, BOARD_PATH, { workspace: flag('ws', null) });
requireApproval(PROJ, 'assets', approvedAssets, { skip: SKIP_GATE });
// 审批必须绑定本次明确传入的执行计划。不能因为项目里恰好存在一个
// board.direction.json，就拿旧导演文件的票据放行另一份 render plan。
requireApproval(PROJ, 'direction', [DIRECTION_PATH], { skip: SKIP_GATE });

/** 造型 id → 角色 id（要拿角色的肖像当脸锚点） */
const charOf = (identId) => (board.identities.find((x) => x.id === identId) || {}).character;

function buildPrompt(unit, shot) {
  const f = FRAMING[shot.framing] || { rule: `【景别｜${shot.framing}】` };
  const people = (unit.keyframe_cast || shot.on_screen || []).map((id) => {
    const cid = charOf(id);
    const c = board.characters.find((x) => x.id === cid);
    const i = board.identities.find((x) => x.id === id);
    return `${c ? c.name || c.id : cid}（${c ? c.face_prompt : ''}；服装：${i ? i.appearance_details : ''}）`;
  }).join('；');

  return [
    `【整体风格】${board.meta?.style_prompt || board.meta?.style || '与项目视觉风格一致'}。`,
    f.rule,                                    // ← 景别硬约束放最前
    `【人物】${people}`,
    `【动作起点】${unit.keyframe_start || shot.action}`,
    shot.lighting ? `【光】${shot.lighting}` : '',
    shot.camera && !/^固定/.test(shot.camera) ? `【运镜】${shot.camera}（这是一张静帧，只需体现这个机位的构图）` : '',
    NO_TEXT,
    '【一致性】角色身份外观必须与参考图完全一致；脸部或头部特征、体型、毛发/皮肤/材质、服装与配饰均不得重新设计。',
  ].filter(Boolean).join('\n');
}

function buildLocalPrompt(unit, shot, refs) {
  const f = FRAMING[shot.framing] || { rule: `景别：${shot.framing}` };
  const anchoredIds = unit.keyframe_cast || shot.on_screen || [];
  const names = anchoredIds.map((id) => {
    const cid = charOf(id);
    return (board.characters.find((x) => x.id === cid) || {}).name || cid;
  });
  const supporting = (shot.on_screen || []).filter((id) => !anchoredIds.includes(id)).map((id) => {
    const cid = charOf(id);
    const character = board.characters.find((x) => x.id === cid) || {};
    const identity = board.identities.find((x) => x.id === id) || {};
    return `${character.name || cid}（${character.face_prompt || ''}；${identity.appearance_details || ''}）`;
  });
  const species = (shot.on_screen || []).map((id) => {
    const cid = charOf(id);
    return (board.characters.find((x) => x.id === cid) || {}).species;
  });
  const scaleRule = species.includes('cat') && species.includes('mouse')
    ? '【体型比例硬约束】小老鼠的站立身高不得超过猫站立身高的五分之一；老鼠必须位于猫脚边，绝不能接近猫的腰部或胸口高度。'
    : '';
  const bindings = refs.map((r, i) => {
    if (r.role === 'handoff') return `图${i + 1}是上一段视频的实际稳定尾帧，必须继承其中的角色姿态、位置、朝向和空间关系，只能改变导演明确允许的项目`;
    if (r.role === 'scene') return `图${i + 1}是场景参考，只参考环境、光线和色调`;
    const cid = r.character;
    const name = (board.characters.find((x) => x.id === cid) || {}).name || cid;
    return `图${i + 1}是${name}的身份参考，严格保持此人的脸、发型${r.role === 'sheet' ? '和服装' : ''}`;
  });
  return [
    `请把参考图中的${names.join('和')}放进同一个镜头，整体风格严格遵循：${board.meta?.style_prompt || board.meta?.style || '项目既定视觉风格'}。${bindings.join('；')}。`,
    supporting.length
      ? `画面必须出现${names.join('和')}，还必须出现次要主体${supporting.join('；')}；不得漏掉动作起点中写明的任何主体，也不得增加其他角色。`
      : names.length > 1 ? `画面必须同时出现且只出现${names.join('和')}两个人，两个人都必须清楚可见，不得漏掉任何一人。` : '',
    `构图要求：${f.rule.replaceAll('**', '')}`,
    scaleRule,
    `画面起点：${unit.keyframe_start || shot.action}`,
    unit.continuity?.mode === 'continue_previous'
      ? `连续性交接：必须保持“${unit.continuity.handoff_state}”；只允许改变：${(unit.continuity.allowed_changes || []).join('、') || '无'}。`
      : '',
    shot.lighting ? `光线：${shot.lighting}` : '',
    '保持参考图的角色身份、体型比例和体表材质。不得重设计脸部或头部特征、毛发、皮肤、服装与配饰。',
    `【生成前最终检查】${f.rule.replaceAll('**', '')}`,
    '画面中不要出现文字、字幕、水印、logo、边框或拼图。',
  ].filter(Boolean).join('\n');
}

function refsFor(shot, unit) {
  const assetUnit = unit.keyframe_cast ? { ...unit, cast: unit.keyframe_cast } : unit;
  const assets = unitAssets(board, BOARD_PATH, assetUnit, { workspace: flag('ws', null) });
  const people = assets.people.flatMap((person) => [
    { file: person.portrait, role: 'portrait', character: person.characterId },
    { file: person.sheet, role: 'sheet', character: person.characterId },
  ]);
  if (PROVIDER === 'local' || PROVIDER === 'bailian') {
    if (assets.people.length > 2) {
      throw new Error(`${unit.id}: 三个参考位中需保留一个给场景，最多只能精确锚定 2 名角色；请让导演拆分镜头`);
    }
    if (PROVIDER === 'bailian') {
      return [
        ...assets.people.map((person) => ({
          file: person.sheet || person.portrait,
          role: person.sheet ? 'sheet' : 'portrait',
          character: person.characterId,
        })),
        { file: assets.sceneMaster, role: 'scene' },
      ];
    }
    const portraits = people.filter((x) => x.role === 'portrait');
    const sheets = people.filter((x) => x.role === 'sheet');
    const ordered = [
      { file: assets.sceneMaster, role: 'scene' },
      ...(portraits.length > 1 ? portraits : [...portraits, ...sheets]),
    ];
    return ordered.slice(0, 3);
  }
  const refs = [
    ...people,
    { file: assets.sceneMaster, role: 'scene' },
    ...assets.props.map((prop) => ({ file: prop.file, role: 'prop', name: prop.name })),
  ];
  if (refs.length > 9) throw new Error(`${unit.id}: 需要 ${refs.length} 张参考图，超过通道上限 9；请让导演拆分镜头或精简资产`);
  return refs;
}

// ---------------------------------------------------------------- 主流程

console.log(`\n出关键帧　共 ${dir.units.length} 个单元`);
let failures = 0;

for (const unit of dir.units) {
  if (ONLY.length && !ONLY.includes(unit.id)) continue;
  let handoff = null;
  if (unit.continuity?.mode === 'continue_previous') {
    if (!ONLY.length) throw new Error(`${unit.id}: 连续单元禁止随整批提前生成关键帧；请在上一段通过后用 --units ${unit.id} 单独生成`);
    handoff = requireHandoff(PROJ, unit, { requireKeyframe: false });
    requireApproval(PROJ, 'handoff', [handoff.stable_frame], { id: unit.id, skip: SKIP_GATE });
  }
  const shot = unit.shots[0];
  let refs = refsFor(shot, unit);
  if (handoff) refs = [{ file: handoff.stable_frame, role: 'handoff' }, ...refs].slice(0, PROVIDER === 'huimeng' ? 9 : 3);
  const refGuide = PROVIDER === 'local' || PROVIDER === 'bailian'
    ? `【参考图职责】${refs.map((r, i) => `图${i + 1}=${r.role === 'handoff' ? '上一段实际稳定尾帧，必须继承姿态与空间状态' : r.role === 'scene' ? '场景与构图环境' : r.role === 'portrait' ? '人物脸部' : r.role === 'prop' ? `道具${r.name || ''}` : '人物服装与身份'}`).join('；')}`
    : '';
  const prompt = PROVIDER === 'local' || PROVIDER === 'bailian'
    ? buildLocalPrompt(unit, shot, refs)
    : [refGuide, buildPrompt(unit, shot)].filter(Boolean).join('\n');
  const out = PROVIDER === 'local'
    ? path.join(LOCAL_OUT, `${unit.id}.png`)
    : PROVIDER === 'bailian'
    ? path.join(BAILIAN_OUT, `${unit.id}.png`)
    : unit.keyframe
    ? path.resolve(PROJ, unit.keyframe)
    : path.join(DEFAULT_OUT, `${unit.id}.png`);
  fs.mkdirSync(path.dirname(out), { recursive: true });

  console.log(`\n${'─'.repeat(68)}`);
  console.log(`  【${unit.id}】${shot.framing}　参考图 ${refs.length} 张`);
  console.log(prompt.split('\n').map((l) => '    ' + l).join('\n'));
  if (DRY) continue;

  let r;
  let got = false;
  let secs = '?';
  let txt = '';
  if (PROVIDER === 'local') {
    const resultFile = path.join(LOCAL_OUT, `.${unit.id}.result.json`);
    const a = [LOCAL_GEN, 'edit', '--prompt', prompt, '--ratio', '9:16', '--steps', LOCAL_STEPS, '--cfg', LOCAL_CFG,
      '--out-dir', LOCAL_OUT, '--result-file', resultFile];
    for (const ref of refs) a.push('--image', ref.file);
    const started = Date.now();
    r = spawnSync(LOCAL_PY, a, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 900000 });
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
  } else if (PROVIDER === 'bailian') {
    const requestOut = path.join(BAILIAN_OUT, 'raw', unit.id);
    fs.mkdirSync(requestOut, { recursive: true });
    const requestDir = path.join(requestOut, '_request');
    fs.mkdirSync(requestDir, { recursive: true });
    const promptFile = path.join(requestDir, 'prompt.txt');
    const scriptFile = path.join(requestDir, 'run.ps1');
    fs.writeFileSync(promptFile, prompt, 'utf8');
    const ps = (value) => `'${String(value).replaceAll("'", "''")}'`;
    const blScript = path.join(process.env.APPDATA || '', 'npm', 'bl.ps1');
    const imageArgs = refs.map((ref) => `--image ${ps(ref.file)}`).join(' ');
    fs.writeFileSync(scriptFile, [
      `$ErrorActionPreference = 'Stop'`,
      `$prompt = Get-Content -Raw -Encoding UTF8 ${ps(promptFile)}`,
      `& ${ps(blScript)} image edit ${imageArgs} --prompt $prompt --model ${ps(BAILIAN_MODEL)}`
        + ` --size '1024*1792' --n 1 --watermark false --out-dir ${ps(requestOut)}`
        + ` --out-prefix ${ps(unit.id)} --output json --timeout 300`,
    ].join('\n'), 'utf8');
    const started = Date.now();
    r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptFile], {
      encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 360000,
    });
    secs = String(Math.round((Date.now() - started) / 1000));
    txt = String(r.stdout || '') + String(r.stderr || '') + String(r.error || '');
    const produced = fs.readdirSync(requestOut)
      .map((name) => path.join(requestOut, name))
      .filter((file) => {
        const stat = fs.statSync(file);
        return stat.isFile() && /\.(?:png|jpe?g|webp)$/i.test(file) && stat.mtimeMs >= started - 1000;
      })
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    if (r.status === 0 && produced) {
      fs.copyFileSync(produced, out);
      got = true;
    }
  } else {
    const a = ['cli/huimeng.mjs', '--prompt', prompt, '--ratio', '9:16', '--resolution', SIZE,
      '--model', 'image-2-official'];
    for (const ref of refs) a.push('--ref', ref.file);
    a.push('--out', out);
    r = spawnSync('node', a, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 900000, cwd: ROOT });
    txt = String(r.stdout || '') + String(r.stderr || '');
    got = /✓/.test(txt) && fs.existsSync(out);
    secs = (txt.match(/用时 (\d+) 秒/) || [])[1] || '?';
  }
  if (!got) failures++;
  else if (handoff) bindHandoffKeyframe(PROJ, unit, out);
  console.log(`    ${got ? '✓' : '✗'} ${got ? `${(fs.statSync(out).size / 1048576).toFixed(2)} MB　${secs} 秒` : txt.slice(0, 200)}`);
}
if (failures) {
  console.error(`\n✗ ${failures} 个关键帧生成失败`);
  process.exitCode = 1;
} else {
  const generated = dir.units.filter((u) => !ONLY.length || ONLY.includes(u.id)).map((u) => {
    const candidate = PROVIDER === 'local' ? path.join(LOCAL_OUT, `${u.id}.png`) : PROVIDER === 'bailian' ? path.join(BAILIAN_OUT, `${u.id}.png`) : u.keyframe ? path.resolve(PROJ, u.keyframe) : path.join(DEFAULT_OUT, `${u.id}.png`);
    return candidate;
  }).filter(fs.existsSync);
  const note = writeReviewNote(PROJ, 'keyframes', [
    '# 关键帧人工审阅', '',
    '机器检查只能判定是否可送审。请逐张查看人物身份、体型比例、构图、动作起点和场景连续性。', '',
    ...generated.map((f) => `- ${path.basename(f)}: ${f}`), '',
    `确认命令：node cli/review-gate.mjs approve --project "${PROJ}" --stage keyframes --artifacts "${generated.join(',')}"`,
  ]);
  console.log(`\n完成。等待人工审阅：${note}`);
}
