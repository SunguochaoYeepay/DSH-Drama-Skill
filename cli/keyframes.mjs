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
 *   node cli/keyframes.mjs <board.json> --direction <render.plan.json> [--units g001,g002] [--size 2k] [--bailian-size 1024*1792] [--dry-run]
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { projectAssetFiles, unitAssets } from '../src/asset-resolver.mjs';
import { planKeyframeFiles, requireApproval, writeReviewNote } from '../src/human-gates.mjs';
import { COMFY_GEN, COMFY_PYTHON, NODE } from '../src/runtime-paths.mjs';
import * as bailian from '../src/providers/bailian.mjs';
import * as volcengine from '../src/providers/volcengine.mjs';
import { bindHandoffKeyframe, requireHandoff } from '../src/continuity-handoff.mjs';
import { installCliErrorHandler } from '../src/cli-errors.mjs';
import { KEYFRAME_PROVIDER, KEYFRAME_IMAGE_MODEL, HUIMENG_IMAGE_MODEL, KEYFRAME_SIZE, BAILIAN_KEYFRAME_SIZE, LOCAL_IMAGE_STEPS, LOCAL_IMAGE_CFG, LOCAL_KEYFRAME_FAST, LOCAL_KEYFRAME_SIZE } from '../src/config.mjs';
import { aspectOf, dimensionsForAspect } from '../src/aspect.mjs';
import { withHandoffReference } from '../src/keyframe-references.mjs';
import { writeGenerationRecord } from '../src/generation-records.mjs';
import { readKeyframeOverride } from '../src/keyframe-overrides.mjs';
import { compileCharacterDesign, compileDrawPlan, auditPrompt, refinePrompt } from '../src/draw-specialist.mjs';
import { readCinematography, compileCinematography } from '../src/cinematography.mjs';
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
const LOCAL_PY = COMFY_PYTHON;
const LOCAL_OUT = path.resolve(String(flag('out-dir', path.join(PROJ, 'keyframes_local_v2'))));
// 步数/CFG：**用户显式给了才传**，否则交给 gen.py 自己按模式定。
// 这一点在 Lightning 档尤其要命 —— `--fast` 内部是「4 步 LoRA + cfg 1.0」，
// 再显式塞一个 20 步/ cfg4 进去就成了没验证过的混合档（见 providers/comfyui.mjs 的纪律）。
const LOCAL_STEPS = flag('steps', null);
const LOCAL_CFG = flag('cfg', null);
// 🔁 关键帧默认档 = Lightning 加速栈（2026-09-20 与 DramaClaw 对照实测）。
// 20 步非蒸馏路径下画面系统性发灰/发黑，是工程债不是模型问题。`--no-fast` 退回旧路径。
const FAST = !argv.includes('--no-fast')
  && (argv.includes('--fast') || (LOCAL_KEYFRAME_FAST && !LOCAL_STEPS && !LOCAL_CFG));
const BAILIAN_MODEL = String(flag('model', KEYFRAME_IMAGE_MODEL));
const BAILIAN_OUT = path.resolve(String(flag('out-dir', path.join(PROJ, 'keyframes_bailian'))));
const VOLCENGINE_OUT = path.resolve(String(flag('out-dir', path.join(PROJ, 'keyframes_volcengine'))));

function staticKeyframeStart(unit, shot) {
  const text = String(unit.keyframe_start || shot.action || '').trim();
  return text.replace(/^0\s*秒(?:时|时刻)?[：:，,\s]*/u, '');
}

function applyCompositionOverride(prompt, override) {
  if (!/构图覆盖|斜侧中景|中景/u.test(override)) return prompt;
  return prompt.split('\n')
    .filter((line) => !line.startsWith('构图要求：'))
    .join('\n');
}

function executionShotSpec(shot, override) {
  const camera = shot.camera || '固定机位';
  // 覆盖启用时：**覆盖文本本身就是画面截取范围**，并显式声明优先于默认构图规则。
  // 没有覆盖时这一整行不输出（见下面 capture 处的注释）。
  //
  // ⚠ 这里曾经硬编码过一段床戏取景（「画面从床头的斜侧方向取景…完整看到床头板、枕头…床尾方向」），
  // 于是**任何非床戏场景一旦用覆盖，就会被注入「床头板、枕头、床尾」**。
  // 覆盖是通用机制，不能只对一个剧目成立 —— 2026-09-20 在 pot_hit（老楼楼道口）实测踩到：
  // 楼道口的双人关键帧需要压构图，却拿到一段床戏描述，只能放弃覆盖这条路。
  return [
    `【景别】${shot.framing || '未指定'}`,
    // 无覆盖时**不再复述景别规则**：正式描述区的「构图要求：」已经说过一遍，
    // 这里再说就是第三遍。只有覆盖文本才需要这一行（覆盖优先于默认构图）。
    override ? `【画面截取范围】${override}` : '',
    `【机位/构图】${camera}；${override
      ? '执行层覆盖优先：上面那段覆盖文本优先于任何默认构图规则。'
      : '按导演分镜的景别与构图执行，不自行改变人物位置。'}`,
    '【空间关系】画面中的人物、承托物、道具与空间关系必须与导演首帧状态一致；不得新增人物、重复人物或改变头脚方向。',
  ].filter(Boolean).join('\n');
}

/**
 * ## 景别 → 硬边界
 *
 * **软描述没用。** 第一版写「中景（腰部以上）」，出来切在大腿。
 * 所以每条都写清三件事：**上边界、下边界、以及两侧不允许出现的**。
 */
export const FRAMING = {
  远景: {
    // `visual` 是送生图模型的那一版：只有画面，没有解释。
    // `rule` 保留给打印版（人要看出判据）与英文通道。
    visual: '远景，人物在环境里只占很小一块，看不清脸部细节',
    rule: '【景别｜远景】画面以**环境为主**，人物只占很小一块（**不超过画面高度的 1/4**）。'
      + '能看到大片树林和整条古道。**不允许**人物占满画面，**不允许**能看清脸部细节。',
    en: 'extreme long shot, figures very small in a vast environment',
  },
  全景: {
    visual: '全景，人物从头顶到脚底完整在画面内',
    rule: '【景别｜全景】画面**必须包含人物的完整身体** —— **从头顶一直到脚底（或裙摆落地处）都在画面内**，'
      + '人物高度约占画面高度的 1/2 到 2/3，四周留出环境。'
      + '**绝不允许裁掉脚部**，**也不允许**人物小到只占一角。',
    en: 'full shot, complete body head-to-toe visible, environment around',
  },
  中景: {
    visual: '中景，画面下边界切在人物的腰部',
    // 竖幅双人中景本身可行；只有当人物间距、两侧留白、身体完整度和腰部下边界
    // 同时被锁死时才可能互斥。允许侧边裁切是一种候选构图，不是普遍定律。
    rule: '【景别｜中景】**画面下边界严格切在人物的腰部**（腰带/腰线位置），'
      + '画面里只有**头顶到腰部**这一段。'
      + '**绝不允许出现大腿或膝盖**（那就成了全景），**也绝不允许只到胸口**（那就成了近景）。'
      + '若人物间距和留白导致构图拥挤，可缩短人物间距、改为前后错位，或允许外侧肩臂轻微出画；'
      + '不得为了保留所有横向留白而把下边界放到大腿。',
    en: 'medium shot, framed from head down to the waist ONLY; subjects may be cropped at the left and right frame edges, but never extend below the waist',
  },
  近景: {
    visual: '近景，画面只取胸部以上',
    rule: '【景别｜近景】**画面只取胸部以上** —— 下边界在**胸口到腰之间、明显高于腰线**。'
      + '能看到肩膀和上胸，脸部占画面较大比例。'
      + '**绝不允许出现腰部以下**（那就成了中景），**也不允许只剩一个头**（那就成了特写）。',
    en: 'medium close-up, framed from head down to mid-chest ONLY',
  },
  特写: {
    visual: '特写，画面里只有脸',
    rule: '【景别｜特写】**画面里只有脸** —— 从下巴下方一点点到头顶，**头部占满整个画面**。'
      + '**绝不允许出现肩膀或衣领**（那就不算特写），**也不允许只拍半张脸**。',
    en: 'extreme close-up, the face fills the entire frame, no shoulders visible',
  },
};

/**
 * 紧景别遇到多人、宽间距和大量留白时更容易发生约束冲突。
 * 允许侧边裁切只是兜底选项，优先由构图关系解决。
 */
const TIGHT_FRAMINGS = new Set(['中景', '近景', '特写']);

const NO_TEXT = '【禁止】画面里**不许出现任何文字、字幕、水印、logo、边框、色卡**。';

const dir = JSON.parse(fs.readFileSync(DIRECTION_PATH, 'utf8'));
const board = JSON.parse(fs.readFileSync(BOARD_PATH, 'utf8'));
// 摄影契约为可选：老剧目没有这个文件，行为与今天完全一致，不会凭空多出一层。
const CINE = readCinematography(PROJ);
const assetDesignPath = path.join(PROJ, 'asset-design.json');
const assetDesign = fs.existsSync(assetDesignPath) ? JSON.parse(fs.readFileSync(assetDesignPath, 'utf8')) : { designs: [] };
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

/** 造型 id → 角色 id（要拿角色的肖像当脸锚点） */
const charOf = (identId) => (board.identities.find((x) => x.id === identId) || {}).character;

function buildPrompt(unit, shot, cine) {
  const f = FRAMING[shot.framing] || { rule: `【景别｜${shot.framing}】` };
  // 关键帧是**单帧静态图**：`still: true` 让标了 `still: false` 的规则（运动方向、时序）不进提示词。
  const cineBlock = compileCinematography(cine, { shot, framing: shot.framing, still: true });
  const people = (unit.keyframe_cast || shot.on_screen || []).map((id) => {
    const cid = charOf(id);
    const c = board.characters.find((x) => x.id === cid);
    const i = board.identities.find((x) => x.id === id);
    return `${c ? c.name || c.id : cid}（${c ? c.face_prompt : ''}；服装：${i ? i.appearance_details : ''}）`;
  }).join('；');

  return [
    cineBlock.header,                          // ← 锁定风格头永远在最前，逐字不改
    cineBlock.negatives,
    cineBlock.rules,                           // ← 全片物理规则（本镜可翻转）
    cineBlock.optics,
    `【整体风格】${board.meta?.style_prompt || board.meta?.style || '与项目视觉风格一致'}。`,
    f.rule,                                    // ← 景别硬约束紧跟其后
    `【人物】${people}`,
    `【关键帧起始姿态】${staticKeyframeStart(unit, shot)}`,
    cineBlock.lighting,
    shot.lighting ? `【光】${shot.lighting}` : '',
    shot.camera && !/^固定/.test(shot.camera) ? `【运镜】${shot.camera}（这是一张静帧，只需体现这个机位的构图）` : '',
    NO_TEXT,
    '【一致性】角色身份外观必须与参考图完全一致；脸部或头部特征、体型、毛发/皮肤/材质、服装与配饰均不得重新设计。',
  ].filter(Boolean).join('\n');
}

function buildLocalPrompt(unit, shot, refs, cine) {
  const f = FRAMING[shot.framing] || { rule: `景别：${shot.framing}` };
  // 关键帧是**单帧静态图**：`still: true` 让标了 `still: false` 的规则（运动方向、时序）不进提示词。
  const cineBlock = compileCinematography(cine, { shot, framing: shot.framing, still: true });
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
    cineBlock.header,                          // ← 锁定风格头永远在最前，逐字不改
    cineBlock.negatives,
    cineBlock.rules,                           // ← 全片物理规则（本镜可翻转）
    cineBlock.optics,
    `请把参考图中的${names.join('和')}放进同一个镜头，整体风格严格遵循：${board.meta?.style_prompt || board.meta?.style || '项目既定视觉风格'}。${bindings.join('；')}。`,
    supporting.length
      ? `画面必须出现${names.join('和')}，还必须出现次要主体${supporting.join('；')}；不得漏掉动作起点中写明的任何主体，也不得增加其他角色。`
      : names.length > 1
        ? `画面必须同时出现且只出现${names.join('和')}两个人，不得漏掉任何一人。`
          // 紧景别多人构图可能拥挤，给模型一组有序的可行解，避免约束冲突时随机妥协。
          + (TIGHT_FRAMINGS.has(shot.framing)
            ? '两人的脸都必须清楚可辨；构图拥挤时，依次尝试缩短人物间距、前后错位、轻微侧边裁切，'
              + '不要为了保留横向留白而放松景别。'
            : '两个人都必须清楚可见。')
        : '',
    `构图要求：${f.rule.replaceAll('**', '')}`,
    scaleRule,
    `关键帧起始姿态：${staticKeyframeStart(unit, shot)}`,
    unit.continuity?.mode === 'continue_previous'
      ? `连续性交接：必须保持“${unit.continuity.handoff_state}”；只允许改变：${(unit.continuity.allowed_changes || []).join('、') || '无'}。`
      : '',
    cineBlock.lighting,
    shot.lighting ? `光线：${shot.lighting}` : '',
    '保持参考图的角色身份、体型比例和体表材质。不得重设计脸部或头部特征、毛发、皮肤、服装与配饰。',
    // ⚠ 这里曾经还有一行「【生成前最终检查】${f.rule}」，与上面「构图要求：」逐字重复。
    // 2026-09-20 对照实验：景别规则说三遍（构图要求 / 生成前检查 / 抽卡师截取范围）
    // 不会让它更被遵守，只会把「两个人」「伞包」这类关键实体的字面权重稀释掉 —— 五连抽全废。
    // 景别**只说一次**：正式描述区的「构图要求：」，执行层不再复述。
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
  if (PROVIDER === 'local' || PROVIDER === 'bailian' || PROVIDER === 'volcengine') {
    if (assets.people.length > 2) {
      throw new Error(`${unit.id}: 三个参考位中需保留一个给场景，最多只能精确锚定 2 名角色；请让导演拆分镜头`);
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

// ---------------------------------------------------------------- 主流程

console.log(`\n出关键帧　共 ${dir.units.length} 个单元`);
let failures = 0;

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
  if (handoff) refs = withHandoffReference(refs, handoff.stable_frame, PROVIDER);
  const refGuide = PROVIDER === 'local' || PROVIDER === 'bailian' || PROVIDER === 'volcengine'
    ? `【参考图职责】${refs.map((r, i) => `图${i + 1}=${r.role === 'handoff' ? '上一段实际稳定尾帧，必须继承姿态与空间状态' : r.role === 'scene' ? '场景与构图环境' : r.role === 'portrait' ? '人物脸部' : r.role === 'prop' ? `道具${r.name || ''}` : '人物服装与身份'}`).join('；')}`
    : '';
  const prompt = PROVIDER === 'local' || PROVIDER === 'bailian' || PROVIDER === 'volcengine'
    ? buildLocalPrompt(unit, shot, refs, CINE)
    : [refGuide, buildPrompt(unit, shot, CINE)].filter(Boolean).join('\n');
  const override = readKeyframeOverride(PROJ, unit.id);
  const drawPlan = compileDrawPlan({ unit, shot, override });
  const characterDesign = compileCharacterDesign({ designs: assetDesign.designs || [], unit, shot });
  const normalizedPrompt = applyCompositionOverride(prompt, override);
  const finalPrompt = `${normalizedPrompt}\n\n【抽卡师｜执行层执行编译】\n${executionShotSpec(shot, override)}\n${characterDesign.prompt}\n${drawPlan.prompt}`;
  // 抽卡师最终整理。**送进生图模型的是 modelPrompt，不是 finalPrompt** ——
  // 自检只报警不改写的话，规则就是纸上的（no_chute 连抽 8 张全废那次正是如此）。
  const refined = refinePrompt(finalPrompt, { visualFraming: FRAMING[shot.framing]?.visual || null });
  const modelPrompt = refined.text;
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
  console.log(`  【${unit.id}】${shot.framing}　参考图 ${refs.length} 张`);
  console.log('  ── 工程版（审计用，不送模型）');
  console.log(finalPrompt.split('\n').map((l) => '    ' + l).join('\n'));
  for (const conflict of drawPlan.conflicts) console.log(`    warning: 抽卡师发现约束冲突：${conflict}`);
  console.log('  ── 抽卡师整理后 → 送生图模型');
  console.log(modelPrompt.split('\n').map((l) => '    ' + l).join('\n'));
  if (refined.dropped.length) {
    console.log(`    抽卡师删掉 ${refined.dropped.length} 处：`);
    for (const item of refined.dropped) console.log(`      - ${item}`);
  }
  // 提示词自检跑在**整理后**这一版上 —— 送进模型的是它，要审的也是它。
  const audit = auditPrompt(modelPrompt);
  if (audit.violations.length) {
    console.log(`    ⚠ 提示词自检：${audit.chars} 字，${audit.violations.length} 项违规（见 references/prompt-rules.md）`);
    for (const v of audit.violations) console.log(`      · [${v.rule}] ${v.hit}`);
  } else {
    console.log(`    ✓ 提示词自检通过：${audit.chars} 字`);
  }
  if (DRY) continue;

  let r;
  let got = false;
  let secs = '?';
  let txt = '';
  if (PROVIDER === 'local') {
    const resultFile = path.join(LOCAL_OUT, `.${unit.id}.result.json`);
    const a = [LOCAL_GEN, 'edit', '--prompt', modelPrompt, '--ratio', ASPECT,
      '--style', LOCAL_STYLE, '--out-dir', LOCAL_OUT, '--result-file', resultFile];
    if (LOCAL_STEPS) a.push('--steps', String(LOCAL_STEPS));
    else if (!FAST) a.push('--steps', LOCAL_IMAGE_STEPS);
    if (LOCAL_CFG) a.push('--cfg', String(LOCAL_CFG));
    else if (!FAST) a.push('--cfg', LOCAL_IMAGE_CFG);
    // `--fast` = Lightning 4 步 LoRA + cfg 1.0（上游同配 ModelSamplingAuraFlow shift=3 + CFGNorm）。
    if (FAST) a.push('--fast');
    // 输出尺寸：显式 --width/--height 优先，否则按 **剧目画幅** 排布默认像素
    // （edit 默认不看目标尺寸，这里必须给，否则 FluxKontextImageScale 会把输出压到 ~1MP）。
    const LW = flag('width', null), LH = flag('height', null);
    const sizeArg = (LW && LH) ? `${LW}x${LH}` : dimensionsForAspect(LOCAL_KEYFRAME_SIZE, ASPECT);
    const [outW, outH] = sizeArg.split('x');
    a.push('--width', outW, '--height', outH);
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
    model: PROVIDER === 'local' ? 'local-comfyui' : PROVIDER === 'bailian' ? BAILIAN_MODEL : PROVIDER === 'volcengine' ? process.env.AIH_VOLCENGINE_IMAGE_MODEL : HUIMENG_IMAGE_MODEL,
    requested_provider: PROVIDER_SETTING || null,
    artifacts: generated,
    plan: DIRECTION_PATH,
    execution_overrides: dir.units
      .filter((unit) => readKeyframeOverride(PROJ, unit.id))
      .map((unit) => unit.id),
  });
  const note = writeReviewNote(PROJ, 'keyframes', [
    '# 关键帧人工审阅', '',
    '机器检查只能判定是否可送审。请逐张查看人物身份、体型比例、构图、动作起点和场景连续性。', '',
    ...generated.map((f) => `- ${path.basename(f)}: ${f}`), '',
    `生成记录：${generationRecord}`,
    `确认命令：node cli/review-gate.mjs approve --project "${PROJ}" --stage keyframes --plan "${DIRECTION_PATH}"`,
  ]);
  console.log('\n关键帧绝对路径（请直接打开并逐张确认）：');
  for (const file of generated) console.log(`  · ${path.resolve(file)}`);
  console.log(`\n完成。等待人工审阅：${note}`);
}
