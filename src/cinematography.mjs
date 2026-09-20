/**
 * cinematography.mjs — 项目级摄影契约：把"画面语言"从美术风格里分出来。
 *
 * ## 为什么要有这一层
 *
 * 对标 GitHub 上几个同类 skill 之后，最确定的一条差距是：**我们的提示词里根本没有"镜头"这个维度。**
 * 美术风格（`board.meta.style_prompt`）回答的是"画成什么样"，摄影契约回答的是"用什么机器拍" ——
 * 焦段、景深、机位高度、主光方向、光质、光比、色温。这两件事混在一起的结果是：
 * 同一部剧里每一帧的脸型透视、光的方向都由模型随机选，出片看着"不像一部戏"。
 *
 * ## 三条硬规则
 *
 * 1. **契约里没写的字段，一个字都不输出。** 不静默猜默认值 ——
 *    这是 SKILL.md「不能由 Agent 静默猜默认值」的直接延伸。宁可提示词里没有这一层，
 *    也不能让代码替导演编一个 50mm 出来。
 * 2. **风格头逐字进提示词，且放在最前面。** 0xadvait/ai-video-pipeline 的做法：
 *    每个 panel prompt 共用同一段逐字前缀。改写过的前缀等于没有前缀。
 * 3. **每镜覆盖优先于契约。** 导演在 `shot.optics` / `shot.lighting_setup` 里写了就听导演的。
 *
 * 规则正本见 `references/cinematography.md`，本文件只负责确定性编译。
 */

import fs from 'node:fs';
import path from 'node:path';

export const CONTRACT_FILE = 'cinematography.json';

const LIGHTING_LABELS = {
  zh: {
    key_direction: '主光方向',
    quality: '光质',
    ratio: '光比',
    temperature: '色温',
    fill: '补光',
    rim: '轮廓光',
    practicals: '环境光源',
  },
  en: {
    key_direction: 'key light direction',
    quality: 'light quality',
    ratio: 'lighting ratio',
    temperature: 'colour temperature',
    fill: 'fill light',
    rim: 'rim light',
    practicals: 'practical lights',
  },
};

/** 光的字段按这个顺序输出，避免每次重排导致提示词无意义地变化。 */
const LIGHTING_ORDER = ['key_direction', 'quality', 'ratio', 'temperature', 'fill', 'rim', 'practicals'];

const text = (value) => {
  const s = String(value ?? '').trim();
  return s || null;
};

/**
 * 读项目级摄影契约。
 *
 * 文件不存在 → 返回 null，调用方行为与没有这一层时完全一致（向后兼容所有既有剧目）。
 * JSON 语法错误 → 抛出，因为那是人改坏了，静默吞掉等于让一份坏契约悄悄生效。
 */
export function readCinematography(projectDir, { file = CONTRACT_FILE } = {}) {
  if (!projectDir) return null;
  const target = path.resolve(projectDir, file);
  if (!fs.existsSync(target)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (error) {
    throw new Error(`摄影契约无法解析：${target} —— ${error.message}`);
  }
  return parsed && typeof parsed === 'object' ? parsed : null;
}

/**
 * 焦段：每镜覆盖 > 按景别映射 > 全片默认 > 不给。
 *
 * `lens_mm` 可以是数字（全片一个焦段），也可以是对象（按景别给，配 `default` 兜底）。
 * 对象里既没有当前景别也没有 `default` 时返回 null —— 不给就是不给。
 */
export function lensMmFor(contract, framing, shot) {
  const override = shot?.optics?.lens_mm;
  if (override != null && override !== '') return override;
  const table = contract?.lens_mm;
  if (table == null) return null;
  if (typeof table === 'number') return table;
  if (typeof table !== 'object') return null;
  if (framing && table[framing] != null) return table[framing];
  return table.default ?? null;
}

/** 镜头光学层。焦段、景深、机位高度，缺哪项就不写哪项。 */
export function opticsBlock(contract, shot, framing, lang = 'zh') {
  const mm = lensMmFor(contract, framing, shot);
  const parts = [];
  if (mm != null) parts.push(lang === 'en' ? `${mm}mm lens` : `${mm}mm`);
  const source = shot?.optics || {};
  const depth = text(source.depth_of_field) ?? text(contract?.depth_of_field);
  const height = text(source.camera_height) ?? text(contract?.camera_height);
  if (depth) parts.push(depth);
  if (height) parts.push(lang === 'en' ? `camera at ${height}` : `机位${height}`);
  if (!parts.length) return null;
  return lang === 'en'
    ? `Lens and framing: ${parts.join('. ')}.`
    : `【镜头】${parts.join('；')}`;
}

/** 结构化光。契约作基线，每镜 `lighting_setup` 逐项覆盖。 */
export function lightingBlock(contract, shot, lang = 'zh') {
  const setup = shot?.lighting_setup || {};
  const base = contract?.lighting || {};
  const labels = LIGHTING_LABELS[lang] || LIGHTING_LABELS.zh;
  const parts = [];
  // 英文提示词里用半角冒号，中文提示词里用全角 —— 标签已经是英文，配全角冒号很别扭。
  const sep = lang === 'en' ? ': ' : '：';
  for (const key of LIGHTING_ORDER) {
    const value = text(setup[key]) ?? text(base[key]);
    if (value) parts.push(`${labels[key]}${sep}${value}`);
  }
  if (!parts.length) return null;
  return lang === 'en'
    ? `Lighting: ${parts.join('; ')}.`
    : `【光】${parts.join('；')}`;
}

/**
 * 锁定风格头 —— 逐字，不做任何加工。
 *
 * 它是全片所有视觉提示词的公共前缀，作用是压住模型往"插画 / 水彩 / 日系动画"方向漂。
 * 0xadvait 实测过：不给 strict negatives，GPT-Image-2 会随场景内容漂向插画风。
 */
export function styleHeader(contract) {
  return text(contract?.style_header);
}

/** 负面清单。契约的 `negatives` 加调用方自带项，去重后拼成一句。 */
export function negativesBlock(contract, extra = [], lang = 'zh') {
  const list = [...(Array.isArray(contract?.negatives) ? contract.negatives : []), ...extra]
    .map((item) => String(item ?? '').trim())
    .filter(Boolean);
  if (!list.length) return null;
  const unique = [...new Set(list)];
  return lang === 'en'
    ? `Style negatives: NEVER ${unique.join(', NEVER ')}.`
    : `【风格排除】不得出现：${unique.join('、')}。`;
}

// ---------------------------------------------------------------- 全片物理规则

/**
 * 全片物理与连续性规则 —— 对标 `0xadvait/ai-video-pipeline` 的 `CRITICAL SHADOW RULE`。
 *
 * 那一招的精髓不是"写了条影子规则"，而是**规则全局生效 + 单镜可以翻转**：
 * 影子全片都投向主光反方向，唯独某一镜要逆光，就在那一镜写 `SHADOW OVERRIDE:`。
 * 没有 override 语法的话，要么规则不敢写死（每帧都自己发挥），
 * 要么写了死规则后被特殊情况逼着去改全片契约。
 *
 * 契约里的形态：
 *
 * ```jsonc
 * "rules": [
 *   { "id": "shadow", "text": "所有影子必须投向主光的反方向，方向与长度全片一致" },
 *   { "id": "scale",  "text": "老鼠站立身高不得超过猫的五分之一，且必须位于猫脚边" }
 * ]
 * ```
 *
 * 每镜覆盖（导演稿 `shot.rule_overrides`）：
 *
 * ```jsonc
 * "rule_overrides": { "shadow": "本镜例外：人物背光站立，影子投向镜头方向" }
 * ```
 *
 * **空字符串 = 本镜不适用这条**（不是"沿用原文"）。要关掉某条规则就给空串，
 * 和「契约里没写的字段不输出」同一条纪律：不给内容就是不给。
 *
 * 规则**不进资产**。资产的参考板与空镜没有卡司，"老鼠不得超过猫的五分之一"
 * 这种句子写进空镜提示词，等于给模型递了一份"要画什么"的词表 ——
 * `masterPrompt` 里那只腾空跳起的橘猫就是这么来的。
 */
export function rulesBlock(contract, shot, lang = 'zh') {
  const rules = Array.isArray(contract?.rules) ? contract.rules : [];
  const overrides = shot?.rule_overrides || {};
  const kept = [];
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') continue;
    const id = text(rule.id);
    // 没有 id 的规则不能被覆盖，也就不是一条"可被翻转的规则" —— 跳过而不是原样输出。
    if (!id) continue;
    const override = overrides[id];
    if (override === false || override === null) continue;
    const body = override == null ? text(rule.text) : text(override);
    if (!body) continue;
    kept.push({ id, body });
  }
  if (!kept.length) return null;
  const lines = kept.map((rule) => (lang === 'en' ? `- ${rule.id}: ${rule.body}` : `· ${rule.id}：${rule.body}`));
  return lang === 'en'
    ? `Global rules:\n${lines.join('\n')}`
    : `【全片规则】\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------- 资产层

/**
 * **哪一类资产吃哪几层，由代码拥有** —— 和 `isHuman()` / `FRAMING` 同一条规矩：
 * 必需的结构性判断不能指望模型或使用者自觉。契约只拥有「这几层说什么」，
 * 契约里没写就一项都不输出。
 *
 * 判据只有一条：**这张图是"锚"还是"画面"**。
 *
 * | 资产 | header | negatives | optics | lighting | 为什么 |
 * |---|---|---|---|---|---|
 * | portrait 肖像 | ✗ | ✓ | ✓ | ✗ | 锚点。色调与光一旦进去，它就把全片基调锁死在脸上 —— 换场就不对。但媒介必须锁（画成插画脸 = 整片废），焦段必须锁（24mm 拍脸和 85mm 拍脸不是一个人） |
 * | sheet 身份图 | ✗ | ✓ | ✓ | ✗ | 同上，它是肖像的延伸锚点 |
 * | master 场景主图 | ✓ | ✓ | ✓ | ✓ | **画面**。这才是全片的风格锚与光锚，关键帧全部以它为环境基准 |
 * | prop_3view 道具 | ✗ | ✗ | ✗ | ✗ | 自带"写实产品静物摄影"配方。把卡通片的全片风格头套到手机/镜子上是错的 |
 * | reverse_master / spatial_layout | ✗ | ✗ | ✗ | ✗ | 前者是主图的编辑产物，风格由参考图继承；后者是工程图，不是画面 |
 */
const ASSET_LAYERS = {
  portrait: { header: false, negatives: true, optics: true, lighting: false },
  sheet: { header: false, negatives: true, optics: true, lighting: false },
  master: { header: true, negatives: true, optics: true, lighting: true },
};

/**
 * 资产种类 → 景别，用于复用同一张 `lens_mm` 表。
 *
 * 一部戏的焦段语言只有一张表，资产不该另起一套 —— 肖像就是特写，
 * 身份图是全身就是全景，场景主图是定场就是远景。这样「85mm 拍脸」这条
 * 在肖像和特写关键帧上是同一个数，不会自相矛盾。
 */
const ASSET_FRAMING = { portrait: '特写', sheet: '全景', master: '远景' };

/**
 * 资产的摄影层。
 *
 * 每类资产可在 `contract.assets.<kind>` 里覆盖（结构与 shot 一致：
 * `optics.lens_mm`、`lighting_setup.*`）。契约里没有 `assets` 就全走全片值。
 */
export function assetCinematography(contract, kind, lang = 'zh') {
  const empty = { header: null, negatives: null, optics: null, lighting: null };
  const layers = ASSET_LAYERS[kind];
  if (!contract || !layers) return empty;
  const override = contract.assets?.[kind] || {};
  return {
    header: layers.header ? styleHeader(contract) : null,
    negatives: layers.negatives ? negativesBlock(contract, [], lang) : null,
    optics: layers.optics ? opticsBlock(contract, override, ASSET_FRAMING[kind] ?? null, lang) : null,
    lighting: layers.lighting ? lightingBlock(contract, override, lang) : null,
  };
}

/** 一次性拿到全部四层，供提示词编译器按顺序拼装。 */
export function compileCinematography(contract, { shot, framing, lang = 'zh', extraNegatives = [] } = {}) {
  return {
    header: styleHeader(contract),
    negatives: negativesBlock(contract, extraNegatives, lang),
    rules: rulesBlock(contract, shot, lang),
    optics: opticsBlock(contract, shot, framing, lang),
    lighting: lightingBlock(contract, shot, lang),
  };
}
