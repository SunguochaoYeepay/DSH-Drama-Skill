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
  // 卡通3D：萌宠/合家欢题材的媒介锚点。
  // 注意它给的是**渲染媒介**（3D 渲染管线 + 毛发/材质质感），不是"可爱"这种形容词 ——
  // 和 realistic/anime 一样，色调仍然归 meta.style_prompt，这里只管"这是哪种画面"。
  cartoon3d: '3D 卡通动画电影质感，三维渲染，圆润饱满的造型，柔软蓬松的毛发，柔和通透的光影；不要写实照片感、不要真人皮肤纹理、不要 2D 平涂与赛璐璐描线',
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
 * 这个角色是人类吗？
 *
 * **缺省是 human** —— 老板子没有 species 字段，行为必须一字不变。
 *
 * 为什么需要这个判断：族裔锚点、人类年龄档、以及肖像里那条「只穿素色上衣」，
 * 是**为人类写实剧写的**。把 `东亚人，中国人` 和「只穿素色无花纹的上衣（领口可见即可）」
 * 注入到一只猫的肖像提示词里（实测），等于在要求模型把它画成**拟人化或穿衣服的角色** ——
 * 而萌宠短剧要的是四足真猫。和"年龄/族裔/风格"一样：**属性必需，就必须有代码拥有者。**
 */
export function isHuman(ch) {
  return !ch || !ch.species || ch.species === 'human';
}

/**
 * 角色肖像（脸部锚点）。
 * **故意不带风格圣经** —— 成片色调会把它拖进场景，就失去「锚」的意义了。
 * **故意不写服装** —— 服装属于造型层；写进来会让这张脸只适配一套衣服。
 */
export function portraitPrompt(board, character) {
  const human = isHuman(character);
  const region = human && needsRegion(character.face_prompt) ? regionAnchor(board) : '';
  return [
    styleAnchor(board),
    human ? (AGE_CN[character.age_group] || '青年') : '',
    region,
    character.face_prompt,
    // ---- 构图规则写死（同 sheetInstruction 的理由：模型不替你守版面）----
    human
      ? '【构图】**正方形画幅**，正面朝向，**脸部占画面 60-70%**，肩部以上，头顶留少量空隙，左右对称居中。'
      // 非人类这条改成**硬边界**：实测「头部占画面 60-70%」这种软描述压不住，
      // 出成了一张全身坐姿（头只占约 35-40%），锁不住五官。
      // 和 cli/keyframes.mjs 的景别同一条教训：**必须写清两侧不允许出现什么**。
      : '【构图｜硬约束】**正方形画幅**。**画面里只有头部与颈部** —— 下巴以下只保留少量胸口，'
        + '画面下边界切在胸口上方、**明显高于肩线**。头部（含两只耳朵）占画面总高度约 60-70%，'
        + '正面朝向、左右对称居中，头顶留少量空隙。'
        + '**绝不允许出现前爪、身体、尾巴，也不允许出现坐姿或站姿的全身。**',
    '【背景】**纯中性灰底**，平坦无渐变、无场景、无道具、无阴影。',
    human
      ? '【服装】只穿**素色无花纹的上衣**（领口可见即可）；**不出现任何服装细节** —— 不要戏服、纹样、腰带、配饰。'
        + '**上衣必须是完全纯色的** —— 不要碎花、不要图案、不要印花、不要条纹、不要格子、不要蕾丝、不要刺绣。'
        + '**画面下边界必须切在锁骨上方**，画面里只有头部与颈部，**颈部和肩以下不允许出现任何衣物**。'
      : '【体表】**四足动物，不穿任何衣物、不佩戴任何配饰**，不拟人化、不直立；只有自然的毛发与体表特征。',
    '【禁止】画面里不许出现任何文字、水印、边框、色卡、标注，也不许出现道具和场景。',
  ].filter(Boolean).join('，');
}

/**
 * 身份图（造型）的编辑指令：**一次出 4 面板**。
 * 用 portrait 当 anchor（图1），有 costume_image 就作 图2 —— 脸取自图1，衣取自图2。
 *
 * ## ⚠ 版面必须写死，否则模型自己乱排
 *
 * 第一版只写了「4 个面板分别是什么」，**没写怎么排** —— 结果：
 * · 画幅用了 1:1，4 格排不下 → 排成「上二下一大」
 * · 有的格子人很大、有的很小
 * · 背景一格白一格灰
 *
 * **模型不会替你守版面。** 所以这里把**画幅、方向、等宽等高、留白、居中、背景**
 * 全部显式写出来，一条都不省。
 */
export function sheetInstruction(board, identity) {
  const ch = (board.characters || []).find((c) => c.id === identity.character);
  const human = isHuman(ch);
  const region = ch && human && needsRegion(ch.face_prompt) ? regionAnchor(board) : '';
  return [
    `${styleAnchor(board)}，`,
    region ? `${region}，` : '',
    ch ? `${ch.face_prompt}，` : '',
    identity.appearance_details,
    '。',
    // ---- 版面：这是最容易漏、也最容易被模型乱来的部分 ----
    '一张 4 面板角色设定图。',
    '【版面】**横构图 16:9**。画面被**等分成从左到右一排四个格子（Panel1 Panel2 Panel3 Panel4）**，',
    '**只有一行，绝不换行、绝不 2×2、绝不上下堆叠**。四格**宽度完全相同、高度完全相同**。',
    '【每格内容】Panel1＝脸部特写（头部占满该格，下巴到头顶）；',
    'Panel2＝正面全身（**脚底和头顶都在格子内，不裁切**）；',
    'Panel3＝约 45 度侧身全身；Panel4＝背面全身。',
    `【站位】每一格里的${human ? '人物' : '角色'}都**水平居中、脚踩同一条水平线、头顶留同样的空隙**，四格人物高度一致。`,
    '【背景】**四格背景统一为纯浅灰色**，平坦无场景、无道具、无阴影投射。',
    // ---- 一致性 ----
    human
      ? '【一致性】Panel1 到 Panel4 是同一个人的同一套服装、同一发型、同一光线、同一画风，**只允许视角变化**。'
      : '【一致性】Panel1 到 Panel4 是**同一只角色的同一身毛色与斑纹**、同一体型、同一光线、同一画风，**只允许视角变化**。',
    'Panel1 必须是 Panel2 头部的放大，五官、发型、领口完全对得上。',
    // 实测教训：肖像参考图身上那件"素色上衣"会被一并继承过去，
    // 导致 4 个面板里只有脸是对的、身上还是 T 恤。参考图只该用来锁脸。
    human
      ? '**参考图只用于锁定长相（脸型、五官、发型）；参考图里的衣着必须完全忽略，'
        + '四个面板的服装以上面那段服装描述为准**'
      : '**参考图只用于锁定长相（脸型、五官、毛色与斑纹）；参考图里出现的任何衣着都必须完全忽略，'
        + '四个面板的体表以上面那段描述为准；角色是四足动物，不穿衣、不拟人化**',
    // 另一条实测教训：模型会自作主张加上"角色设定图 / 年龄 / 门派 / 服装配色"那套排版文字。
    // 那张图要当参考图喂给关键帧，**烧进去的字会跟着污染画面**。
    '【禁止】**画面里不许出现任何文字、数字、标题、标注、色标、参数表、分隔线、边框或水印**，'
    + '也不许出现场景、道具、其他人物 —— 只有这四个格子里的同一个角色。',
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
    // **必须写成"动物"而不只是"人"。** 实测：只写「没有任何人」时，
    // 一部猫片出的场景主图正中是一只腾空跳起的橘猫 —— 因为"猫不是人"，
    // 那条否定式根本没管住它。而场景主图是空镜、要喂给全部关键帧，
    // 这只猫会跟着污染每一张关键帧。否定式必须**把卡司整个类别都覆盖到**。
    // **正向陈述 > 否定式。** 实测：写「没有任何人」时猫片出了一只跳起的橘猫；
    // 扩成「没有任何动物」后，本地 Qwen 仍然把猫画成主体 —— 而且场景描述里
    // 那个「猫零食」的「猫」字本身就是诱因（SKILL 早记过：否定词写在"要画什么"
    // 那一段里会被当成内容）。所以这里先给**正向的画面定义**，再补否定。
    //
    // **但场景类型不能被写死在这一段里。** 上一版是
    // 「纯室内环境空镜：画面里只有房间本身 —— 家具、地面、灯光与陈设」，
    // 那是从一部室内猫片提炼的规则；写死之后户外场景会收到
    // 「午后海滨木栈道、海面反光…**纯室内环境空镜**：画面里只有房间本身」——
    // 自相矛盾的指令（干跑实测直接暴露）。**场景是什么类型归 `scene.environment` 拥有**，
    // 这里只负责"空镜"这一件事，措辞必须对室内/户外/自然景都成立。
    '**纯环境空镜**：画面里只有这个场景本身 —— 地面、周围固定的建筑或自然景物、'
    + '光线与固定陈设，'
    + '看不到任何一个角色：没有人物、没有动物、没有宠物（**一个都不出现**），'
    + '没有任何临时道具，没有文字',
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

/**
 * 关键帧的身份参考图：**紧景别用肖像，宽景别用身份图**。
 *
 * ## 这条是"部分有效"，别当成景别的解法
 *
 * 起因：4 张关键帧里 3 张的景别出成了全身（要「近景：只取胸部以上」，出来整只连脚）。
 * 当时的假设是「身份图是 4 面板全身，模型照抄参考图」。
 *
 * 两次**单变量**实验的结果：
 *
 * | 实验 | 改了什么 | 结果 |
 * |---|---|---|
 * | ① | 近景改用肖像（+ 场景主图） | 主体明显变大，**仍是全身** |
 * | ② | 再把场景主图也去掉（只剩肖像） | **没有任何改善**，仍全身 |
 *
 * **所以"参考图决定景别"这个假设是错的**（②把它否掉了）。
 * 肖像参考只带来"主体更大"这一点边际收益，不是景别的开关。
 *
 * 真正的阻塞更像**指令结构**：景别是开头一句话，后面跟着整个角色的长相/体表描述
 * （连尾巴、体型都写了）加整个房间的环境描述 —— 描述"全身上下"的文字压过"只取胸部以上"。
 * 这条和 `FRAMING` 上面那段注释记的是同一个坑，只是"挪到最前面"并不够。
 *
 * 这个函数暂时保留按景别选图（②没证明它有害，①显示略有帮助），
 * **但不要拿它当景别问题的答案**。
 *
 * @returns {{refs: string[], series: Array}}
 */
const TIGHT_FRAMING = new Set(['特写', '近景', '中景']);

/** 关键帧的参考图：身份参考（按景别选肖像/身份图）+ 场景主图（顺序即「图 N」）。 */
export function keyframeRefs(board, shot) {
  const refs = [];
  const series = [];
  const tight = TIGHT_FRAMING.has(shot.shot_size);
  for (const id of shot.cast || []) {
    const x = (board.identities || []).find((v) => v.id === id);
    if (!x) continue;
    const ch = (board.characters || []).find((c) => c.id === x.character) || {};
    const usePortrait = Boolean(tight && ch.portrait);
    const file = usePortrait ? ch.portrait : (x.sheet || ch.portrait);
    if (!file) continue;
    refs.push(file);
    // 标签带上角色名 —— 多个人物时原来全是造型名（三个「居家」），模型分不清图几是谁。
    // `kind` 是给代码用的：**别再靠 label 的字符串前缀判断它是不是卡司参考** ——
    // 之前 `label.startsWith('造型')` 就因为改了标签措辞而静默丢掉整段绑定说明。
    const who = ch.name ? `${ch.name}·${x.name || x.id}` : (x.name || x.id);
    series.push({
      kind: 'cast',
      label: `造型「${who}」·${usePortrait ? '肖像·脸部锚点' : '身份图·全身'}`,
      index: refs.length,
    });
  }
  // 场景主图是**一张全屋宽景**，它同样在把画面往宽里拉。
  // 紧到「特写/近景」时不再喂它 —— 环境与光已经在指令文字里（scene.environment + lighting），
  // 而参考图给的是"构图"这个语义，宽景参考和"只取胸部以上"是直接冲突的。
  const VERY_TIGHT = new Set(['特写', '近景']);
  const scene = (board.scenes || []).find((s) => s.id === shot.scene);
  if (scene && scene.master && !VERY_TIGHT.has(shot.shot_size)) {
    refs.push(scene.master);
    series.push({ kind: 'scene', label: `场景「${scene.name}」`, index: refs.length });
  }
  for (const id of shot.props || []) {
    const p = (board.props || []).find((v) => v.id === id);
    if (p && p.ref_image) { refs.push(p.ref_image); series.push({ kind: 'prop', label: `道具「${p.name}」`, index: refs.length }); }
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
  // 按 `kind` 找卡司参考，**不按 label 的字符串前缀**（改措辞就会静默丢绑定说明）
  const looks = series.filter((s) => s.kind === 'cast');
  const who = looks.map((s) => `图${s.index}`);

  const parts = [];
  // ① **景别放最前**，且展开成明确范围
  parts.push(FRAMING[shot.shot_size] || `${shot.shot_size}：按要求取景`);

  // ② 指定哪张参考图对应谁 —— 不说的话模型会自己猜谁是谁
  if (who.length) {
    // 卡司是动物时，「人」「服装」是错的词：实测指令里写着
    // 「画面里的**人**以图1为准，长相与**服装**保持完全一致」，而对象是四足无衣的老鼠。
    const allHuman = (shot.cast || []).every((id) => {
      const x = (board.identities || []).find((v) => v.id === id);
      const c = x ? (board.characters || []).find((v) => v.id === x.character) : null;
      return isHuman(c);
    });
    parts.push(allHuman
      ? `画面里的人以${who.join('、')}为准，长相与服装保持完全一致（${looks.map((s) => s.label).join('、')}）`
      : `画面里的角色以${who.join('、')}为准，长相与体表（毛色、斑纹、体型）保持完全一致（${looks.map((s) => s.label).join('、')}）`);
  }

  // ③ 造型 + 运镜 + 动作（`shot.prompt` 里本来就有景别和运镜，**不要再加一遍**，会重复）
  parts.push(expandMarkers(board, shot));

  if (scene) parts.push(scene.environment);
  if (shot.lighting) parts.push(shot.lighting);
  // ④ 风格锚 —— 不然一张写实一张插画，剪在一起就露馅
  parts.push(styleAnchor(board));
  return parts.filter(Boolean).join('。');
}
