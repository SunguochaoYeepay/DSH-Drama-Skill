/**
 * assets.mjs — 资产配方：每一种资产该用什么提示词。
 *
 * 这里全是**纯函数** —— 不联网、不烧卡、可离线断言。
 * 阶段③的验收就建在这上面：**配方对不对，不该靠人看图才判断得出来。**
 *
 * 双层参考架构（从 DramaClaw 提炼）：
 *   portrait  脸部锚点：正面朝向 / 脸占 60-70% / 纯灰底 / 素色上衣 / 禁服装细节
 *   sheet     身份图：用 portrait 当 anchor，**一次出 4 面板**，不做拼接 → 天然一致
 *             Panel1 脸部特写 / Panel2 正面全身 / Panel3 约45°三分 / Panel4 背面
 *   master    场景主图：正面环境图，**禁人、禁临时道具**（它是这个场景的风格锚）
 *   reverse   反向 180°，左右边缘必须与 master 可缝合
 *   layout    俯视平面图
 *   prop_3v   道具三视图：正/侧/背，白底，无人，**禁止可读文字**
 */

const AGE_CN = { child: '儿童', youth: '青年', middle: '中年', elder: '老年' };

/**
 * 族裔锚点 —— **代码拥有，不指望模型记得**。
 *
 * 实测教训：`face_prompt` 里没有族裔信息时（尤其剧本只写了人物性格），
 * 生图模型会默认画成白人。一个古风仙侠短剧的主角画成白人，整片就废了。
 * 这和「年龄写成『少女』导致成年角色被画成幼儿园小孩」是同一类问题：
 * **必需的外观属性必须有代码兜底，不能靠模型自觉。**
 */
const REGION_BY_LANG = { zh: '东亚人，中国人', ja: '东亚人', ko: '东亚人' };

/**
 * 风格锚点 —— 和年龄、族裔一样，**是必需属性，必须由代码拥有**。
 *
 * 踩过的坑：肖像配方里构图约束写了七条（正面/脸占 60-70%/灰底/素色上衣/禁服装细节…），
 * **风格一个字都没写**。因为怕成片色调污染锚点，我故意不带 `style_prompt` ——
 * 结果把"这是真人实拍"也一起扔了。模型手里没有任何媒介信号，
 * 对「圆脸杏眼」「五官灵动」这种词就自由发挥成了**插画脸**。
 * 一部 `style: realistic` 的写实剧里，小师妹长成了卡通人。
 *
 * 注意：这里给的是**媒介/质感**，不是色调。色调仍然归 `style_prompt`，
 * 而 `style_prompt` 依然不进肖像（锚点要中性）。
 */
const STYLE_ANCHOR = {
  realistic: '写实实拍，真人电影质感，皮肤纹理与毛孔自然真实，高清细节；不要动漫、插画、3D 渲染、卡通感',
  anime: '2D 赛璐璐动画，动画电影质感，清晰线条与平涂上色，高清细节；不要写实照片感',
  cyberpunk: '写实实拍，霓虹冷调，电影质感，皮肤纹理真实，高清细节；不要动漫、插画、卡通感',
  healing: '写实实拍，柔和自然光，温馨质感，皮肤纹理真实，高清细节；不要动漫、插画、卡通感',
  vintage: '写实实拍，复古胶片质感，轻微颗粒，皮肤纹理真实，高清细节；不要动漫、插画、卡通感',
};

export function styleAnchor(board) {
  return STYLE_ANCHOR[board.meta?.style] || STYLE_ANCHOR.realistic;
}

export function regionAnchor(board) {
  const lang = String(board.meta?.language || 'zh-CN').toLowerCase();
  const key = lang.slice(0, 2);
  const base = REGION_BY_LANG[key] || 'East Asian';
  return base;
}

/** 已经写明了族裔就别重复，免得提示词啰嗦。 */
function needsRegion(text) {
  return !/东亚|中国|亚洲|华人|汉人|East Asian|Asian/i.test(String(text || ''));
}

/** 标记展开：{{造型id}} → 该造型的服装描述；[[道具id]] → 道具外观描述。 */
export function expandMarkers(board, shot) {
  let text = String(shot.prompt || '');
  for (const m of text.matchAll(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g)) {
    const id = m[1];
    const x = (board.identities || []).find((v) => v.id === id);
    const ch = x ? (board.characters || []).find((c) => c.id === x.character) : null;
    const desc = x ? `${ch ? ch.name + '，' : ''}${x.appearance_details}` : id;
    text = text.split(`{{${id}}}`).join(desc);
  }
  for (const m of text.matchAll(/\[\[\s*([a-z][a-z0-9_]*)\s*\]\]/g)) {
    const id = m[1];
    const p = (board.props || []).find((v) => v.id === id);
    text = text.split(`[[${id}]]`).join(p ? p.description : id);
  }
  return text;
}

/** 镜头最终拼给生成模型的提示词：展开标记 + 场景 + 运镜 + 音效。 */
export function shotPrompt(board, shot) {
  const scene = (board.scenes || []).find((s) => s.id === shot.scene);
  return [
    expandMarkers(board, shot),
    scene ? scene.environment : '',
    `运镜：${shot.camera}`,
    `音效：${shot.audio}`,
  ].filter(Boolean).join('；');
}

/**
 * 说话者的稳定 ID：`(S1)` `(S2)`。
 * 官方规范：**同一个说话者跨镜头保持同一 ID**；从不出声的角色不给 ID。
 * 所以按 board 里 characters 的顺序分配，不是按出场顺序 —— 换镜头不会串。
 */
export function speakerIds(board) {
  const byIdentity = new Map();   // 造型 id → 'S1' / 'S2'
  let n = 0;
  for (const c of board.characters || []) {
    // 这个角色**在任一镜头里出过声吗**（按造型反查角色）
    const speaks = (board.shots || []).some((s) => (s.dialogue || []).some((d) => {
      const x = (board.identities || []).find((v) => v.id === d.character);
      return (x ? x.character : d.character) === c.id;
    }));
    if (!speaks) continue;
    const sid = `S${++n}`;
    // 同一角色的**所有造型**共用同一个 ID —— 换镜头不会串
    for (const x of board.identities || []) if (x.character === c.id) byIdentity.set(x.id, sid);
  }
  return byIdentity;
}

const LANG_TAG = { zh: 'Chinese', en: 'English', ja: 'Japanese', ko: 'Korean' };

/**
 * 组装 H3 的官方提示词格式。
 *
 * **这是修一个真 bug 的结果。** 原先我把台词写成散文、塞进 `overall_soundscape`：
 *
 *     overall_soundscape: 树叶沙沙声；小师妹说：「大师兄，昨天晚上，谢谢你救了我。」
 *
 * 而 MiniMax 官方指南（`docs/VIDEO_PROMPT_WRITING_GUIDE`）要求：
 *
 *   1. 台词必须在 **`integrated_multimodal_description`** 里，包成 `<d>[语言] 台词</d>`，
 *      且**逐字保留**（不翻译、不改写）
 *   2. **`overall_soundscape` 明令禁止重复台词**（那里只放环境音、动作音、非语言人声）
 *   3. 说话者要有稳定 ID `(S1)`；画外音必须用固定短语 `says in an off-screen voiceover`
 *      并紧跟一句"嘴唇不动"
 *   4. **屏上文字是"显式声明制"** —— 用引号写出来才会出现。
 *      所以**不写就不会有**；而写"不要出现字幕"这种否定句反而更容易画出来（实测过）
 *   5. I2VA 必须带对齐指令 `For the target video, at 0.00 seconds ... <Picture 1> ...`
 *
 * **字幕就是第 1、2、4 条一起造成的**：没有结构标记的裸对白文本，
 * 模型只能把"这一段文字"当成要画在画面上的东西。
 *
 * 已知偏离：官方示例的描述文字是英文，我们这边是中文（板子本来就是中文，
 * 翻译要额外过一遍模型）。**结构性标记（`<d>` / 字段名 / 对齐指令）都按官方写死了。**
 */
export function h3Prompt(board, shot) {
  const scene = (board.scenes || []).find((s) => s.id === shot.scene);
  const sids = speakerIds(board);
  const lang = LANG_TAG[board.meta?.language] || 'Chinese';

  // ---- Part One：I2VA 的对齐指令（官方固定句式，必须原样） ----
  const parts = ['For the target video, at 0.00 seconds into the target video, '
    + '<Picture 1> (from [Shot 1]) is fully referenced.'];

  // ---- Part Two 之一：integrated_multimodal_description（看得见 + 听得见的时间线） ----
  const body = ['[Shot 1]'];
  // shot.prompt 里已经含「造型 + 景别 + 运镜」，别再单独加一遍（会重复）
  body.push(expandMarkers(board, shot));
  if (scene?.environment) body.push(scene.environment);

  // **台词只放这里**，包进 <d>。说话者身份/语气/动作写在 <d> 外面。
  for (const d of shot.dialogue || []) {
    const x = (board.identities || []).find((v) => v.id === d.character);
    const ch = x ? (board.characters || []).find((c) => c.id === x.character) : null;
    const name = ch ? ch.name : d.character;
    const sid = sids.get(d.character);
    const id = sid ? ` (${sid})` : '';
    const delivery = d.emotion ? `，${d.emotion}` : '';
    body.push(d.kind === 'voiceover'
      // 官方固定短语；且必须紧跟一句"嘴唇不动"
      ? `${name}${id} says in an off-screen voiceover: <d>[${lang}] ${d.text}</d>，嘴唇始终完全闭合`
      : `${name}${id}${delivery}，说道：<d>[${lang}] ${d.text}</d>`);
  }
  parts.push('integrated_multimodal_description: ' + body.filter(Boolean).join(' '));

  // ---- Part Two 之二：overall_soundscape（**只写环境音**，官方禁止重复台词） ----
  parts.push('overall_soundscape: ' + (shot.audio || 'Ambient environmental sound matching the scene.'));

  // ---- Part Two 之三：non_diegetic_music ----
  parts.push('non_diegetic_music: ' + (board.meta?.music || 'N/A'));

  return parts.join('\n\n');
}


/**
 * 角色肖像（脸部锚点）。
 * **故意不带风格圣经** —— 成片色调会把它拖进场景，就失去「锚」的意义了。
 * **故意不写服装** —— 服装属于造型层；写进来会让这张脸只适配一套衣服。
 */
export function portraitPrompt(board, character) {
  const region = needsRegion(character.face_prompt) ? regionAnchor(board) : '';
  return [
    styleAnchor(board),
    AGE_CN[character.age_group] || '青年',
    region,
    character.face_prompt,
    '正面朝向，脸部占画面 60-70%，纯灰底，只穿素色上衣',
    '影棚均匀布光，肩部以上，不出现任何服装细节、道具、场景和文字',
  ].filter(Boolean).join('，');
}

/**
 * 身份图（造型）的编辑指令：**一次出 4 面板**。
 * 用 portrait 当 anchor（图1），有 costume_image 就作 图2 —— 脸取自图1，衣取自图2。
 */
export function sheetInstruction(board, identity) {
  const ch = (board.characters || []).find((c) => c.id === identity.character);
  const region = ch && needsRegion(ch.face_prompt) ? regionAnchor(board) : '';
  return [
    `${styleAnchor(board)}，`,
    region ? `${region}，` : '',
    ch ? `${ch.face_prompt}，` : '',
    identity.appearance_details,
    '。一张 4 面板角色设定图：Panel1 脸部特写 / Panel2 正面全身 / Panel3 约 45 度三分 / Panel4 背面。',
    'Panel1 必须是 Panel2 头部的放大裁切，四个面板的发型、领口、服装完全一致，**只允许视角变化**',
    // 实测教训：肖像参考图身上那件"素色上衣"会被一并继承过去，
    // 导致 4 个面板里只有脸是对的、身上还是 T 恤。参考图只该用来锁脸。
    '**参考图只用于锁定长相（脸型、五官、发型）；参考图里的衣着必须完全忽略，'
    + '四个面板的服装以上面那段服装描述为准**',
    // 另一条实测教训：模型会自作主张加上"角色设定图 / 年龄 / 门派 / 服装配色"那套排版文字。
    // 那张图要当参考图喂给关键帧，**烧进去的字会跟着污染画面**。
    '**画面里不许出现任何文字、标题、标注、参数表、色卡或排版元素**，只有角色本身',
  ].join('');
}

/**
 * 身份图的参考图顺序：**图1 = 肖像（脸）**，图2 = 服装参考图（可选）。
 * 「脸取自第一张，衣取自第二张」—— 有服装参考图时，它优先于文字描述。
 */
export function sheetRefs(board, identity) {
  const ch = (board.characters || []).find((c) => c.id === identity.character);
  const refs = [];
  if (ch && ch.portrait) refs.push(ch.portrait);
  if (identity.costume_image) refs.push(identity.costume_image);
  return refs;
}

/**
 * 场景主图：**禁人、禁临时道具** —— 它是这个场景的风格锚。
 * 这里**带风格圣经** —— 场景要的就是成片色调。
 */
export function masterPrompt(board, scene) {
  return [
    styleAnchor(board),
    board.meta?.style_prompt || '',
    scene.environment,
    '正面 160-180 度环境图，画面里没有任何人，没有任何临时道具，没有文字',
  ].filter(Boolean).join('，');
}

/** 反向场景图：左右边缘必须与主图可缝合，否则换轴就穿帮。 */
export function reverseInstruction(scene) {
  return [
    `把镜头转到反向 180 度，其余保持一致：${scene.environment}`,
    '左右边缘必须与第一张图的侧墙对齐、可无缝缝合，画面里没有任何人',
  ].join('，');
}

/** 俯视平面图：只准矩形，不许画得花。 */
export function layoutPrompt(board, scene) {
  return [
    scene.environment,
    '俯视平面图，只用矩形表示墙体与出入口，标注方位，没有任何人物和装饰细节',
  ].join('，');
}

/** 道具三视图：白底、无人、禁字 —— 有字就会被当成真字贴到成片里。 */
export function propPrompt(prop) {
  return [
    '写实实拍，产品静物摄影，高清细节；不要动漫、插画、3D 渲染感',
    prop.description,
    '三视图：正面 / 侧面 / 背面，产品静物摄影，纯白背景',
    '画面里只有这一个物体，没有任何人物、场景和可读文字',
  ].join('，');
}

// ---------------------------------------------------------------- 资产计划

/**
 * 把一份 board 展开成「要生成哪些资产」的清单。
 * 顺序即依赖顺序：肖像 → 身份图 → 场景 → 道具。
 *
 * 注意 `refsFor` 是**函数不是数组**：依赖产物在这一趟里才被写回 board，
 * 计划阶段就取快照会拿到空引用（实测踩过：肖像刚生成完，身份图却说"缺参考图"）。
 * **引用必须执行时才解析。**
 */
export function assetPlan(board, opts = {}) {
  const plan = [];
  for (const c of board.characters || []) {
    plan.push({
      kind: 'portrait', id: c.id, slot: 'portrait',
      mode: 'generate', prompt: portraitPrompt(board, c),
      size: '1:1', target: c,
      why: '脸部锚点：跨全片复用，所以要中性、要正面、要不带服装',
    });
  }
  for (const x of board.identities || []) {
    plan.push({
      kind: 'sheet', id: x.id, slot: 'sheet',
      mode: 'edit', instruction: sheetInstruction(board, x),
      refsFor: () => sheetRefs(board, x),
      // **身份图固定 16:9，不跟片子画幅走。** 它是参考图、不是画面：
      // 4 个面板横排需要横向空间，竖屏塞 4 个面板每个都太小。
      // 真正跟画幅走的是关键帧和片段。
      size: '16:9', target: x,
      why: '身份图：一次出 4 面板，不做拼接 → 天然一致',
    });
  }
  for (const s of board.scenes || []) {
    plan.push({
      kind: 'master', id: s.id, slot: 'master',
      mode: 'generate', prompt: masterPrompt(board, s), size: board.meta?.aspect || '16:9', target: s,
      why: '场景风格锚：禁人禁临时道具，这样它才只描述"这个地方"',
    });
    // **这两个默认不生成了。**
    // 全工程里它们只有「定义 / 面板显示 / 日志计数 / 迁移置空」四处引用，
    // **没有任何一处拿它们去生成关键帧**（`keyframeRefs()` 只读 sheet + scene.master）。
    // 7 张资产里 2 张是死重，白花 0.36 元还不参与任何画面。
    // 真要接的时候（多机位、锁空间结构）再开 `--with-scene-extras`。
    if (opts.sceneExtras) {
      plan.push({
        kind: 'reverse_master', id: s.id, slot: 'reverse_master',
        mode: 'edit', instruction: reverseInstruction(s),
        refsFor: () => (s.master ? [s.master] : []), size: board.meta?.aspect || '16:9', target: s,
        why: '反向轴：边缘要能与主图缝合，否则换轴就穿帮',
      });
      plan.push({
        kind: 'spatial_layout', id: s.id, slot: 'spatial_layout',
        mode: 'generate', prompt: layoutPrompt(board, s), size: '1:1', target: s,
        why: '俯视平面图：锁定空间结构，让人物走位不飘',
      });
    }
  }
  for (const p of board.props || []) {
    plan.push({
      kind: 'prop_3view', id: p.id, slot: 'ref_image',
      mode: 'generate', prompt: propPrompt(p), size: '1:1', target: p,
      why: '道具三视图：不做它，同一把剑在不同镜头里长得不一样',
    });
  }
  return plan;
}

/** 取一项资产的参考图（**执行时**解析，不是计划时）。 */
export function refsOf(job) {
  return (typeof job.refsFor === 'function' ? job.refsFor() : (job.refs || [])).filter(Boolean);
}

/** 关键帧的参考图：身份图 + 场景主图（顺序即「图 N」）。 */
export function keyframeRefs(board, shot) {
  const refs = [];
  const series = [];
  for (const id of shot.cast || []) {
    const x = (board.identities || []).find((v) => v.id === id);
    if (x && x.sheet) { refs.push(x.sheet); series.push({ label: `造型「${x.name}」`, index: refs.length }); }
  }
  const scene = (board.scenes || []).find((s) => s.id === shot.scene);
  if (scene && scene.master) { refs.push(scene.master); series.push({ label: `场景「${scene.name}」`, index: refs.length }); }
  for (const id of shot.props || []) {
    const p = (board.props || []).find((v) => v.id === id);
    if (p && p.ref_image) { refs.push(p.ref_image); series.push({ label: `道具「${p.name}」`, index: refs.length }); }
  }
  const MAX = 3;   // Qwen-Image-Edit 上限 3 张
  return { refs: refs.slice(0, MAX), series: series.filter((s) => s.index <= MAX) };
}

/** 关键帧的编辑指令（图生图走这条）。 */
/**
 * 把景别展开成**明确的取景范围**。
 *
 * 踩过的坑：只写「近景」两个字、夹在一大段服装描述中间，模型会按整段读，
 * 服装描述压过景别 —— 结果 `近景` 出成了**全身站像**。
 * 所以景别要放在最前面，并且**用肯定句说清楚取到哪里、哪里不要出现**。
 */
const FRAMING = {
  远景: '远景（extreme wide shot）：人物在画面中很小，以环境为主',
  全景: '全景（wide shot）：人物全身入画，从头顶到脚底都在画面内',
  中景: '中景（medium shot）：取景到腰部或膝盖以上，**画面里不出现脚**',
  近景: '近景（medium close-up shot）：**只取胸部以上**，脸占画面三分之一以上，**绝对不出现腰部以下**',
  特写: '特写（close-up shot）：只取脸部或某个局部，其余全在画外',
};

export function keyframeInstruction(board, shot, series) {
  const scene = (board.scenes || []).find((s) => s.id === shot.scene);
  const looks = series.filter((s) => s.label.startsWith('造型'));
  const who = looks.map((s) => `图${s.index}`);

  const parts = [];
  // ① **景别放最前**，且展开成明确范围
  parts.push(FRAMING[shot.shot_size] || `${shot.shot_size}：按要求取景`);

  // ② 指定哪张参考图对应谁 —— 不说的话模型会自己猜谁是谁
  if (who.length) {
    parts.push(`画面里的人以${who.join('、')}为准，长相与服装保持完全一致（${looks.map((s) => s.label).join('、')}）`);
  }

  // ③ 造型 + 运镜 + 动作（`shot.prompt` 里本来就有景别和运镜，**不要再加一遍**，会重复）
  parts.push(expandMarkers(board, shot));

  if (scene) parts.push(scene.environment);
  if (shot.lighting) parts.push(shot.lighting);
  // ④ 风格锚 —— 不然一张写实一张插画，剪在一起就露馅
  parts.push(styleAnchor(board));
  return parts.filter(Boolean).join('。');
}
