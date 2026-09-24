import { compileDirectorExecution } from './director-execution.mjs';
import { compileCinematography } from './cinematography.mjs';
import { genderOf } from './orchestrate.mjs';

const AGE_VOICE = { child: '孩童', youth: '年轻', middle: '中年', elder: '年长' };

/**
 * 说话人首现的音色描述。官方 base-en 要求每个说话人**第一次出现**时交代年龄/性别/音高，
 * 之后只用稳定 ID —— 首现没交代，模型对 S1/S2 的声音只能靠猜。
 *
 * 取值顺序：board 上 `characters[].voice` 填的**描述文本**直接用；填的是 TTS voice ID
 * （longhua_v3 之类）则跳过 —— 那是给 TTS 用的，不是给 H3 看的声线描述；
 * 否则从 age_group + 性别线索推导（线索与 TTS 兜底同一套，见 orchestrate.genderOf）。
 * 非人类角色不套人类声线：物种叫声交给外观描述自己表达，硬造「成年人声」只会误导。
 */
function voiceDescriptorOf(character) {
  if (!character) return null;
  const species = String(character.species || 'human').trim();
  if (species && species !== 'human') return null;
  const raw = String(character.voice || '').trim();
  if (raw && !/^(long|loong)[a-z0-9_]*$/i.test(raw)) return raw;
  const gender = genderOf(character);
  const age = AGE_VOICE[character.age_group] || '成年';
  return gender === 'female' ? `${age}女声`
    : gender === 'male' ? `${age}男声`
    : `${age}人声`;
}

const FACING_PHRASE = {
  left: 'facing the left side of the frame',
  right: 'facing the right side of the frame',
  toward: 'facing the camera',
  away: 'facing away from the camera',
};

const FRAMING_EN = {
  远景: 'extreme long shot',
  全景: 'wide shot',
  中景: 'medium shot',
  近景: 'medium close-up shot',
  特写: 'close-up shot',
};

const DEACT = [
  [/脸颊红意更重|脸颊绯红|双颊绯红|满脸通红/g, '双颊有一层很淡的自然红晕（不是腮红、不是妆容）'],
  // 模型会把「脸颊+红」直接画成两块腮红（实测：g001 末镜）。这里一律换成不带颜色词的生理表演，
  // 让血色的指令彻底消失，妆容归 retention_analysis 里的否定句管。
  [/[双两]?脸?颊[^，；。]{0,3}(涨红|泛红|通红|绯红|红晕|微红)|脸红/g, '脸颊绷紧'],
  [/耳尖泛红|耳尖瞬间通红|耳尖通红/g, '耳廓边缘略有一点淡红'],
  [/瞳孔骤缩|瞳孔骤然一缩/g, '双眼微微睁大'],
  [/眼神由慌乱转为认真/g, '视线从游移变为稳定'],
  [/满脸慌乱无措|满脸慌乱/g, '眉眼微蹙、嘴唇微微张开'],
  [/手足无措|局促不安/g, '双肩微微收紧'],
  [/又气又羞|又羞又急/g, '嘴唇轻抿、眉头微蹙'],
  [/一脸理所当然|神情无波/g, '表情平静'],
  [/神色坦然|神色淡然/g, '表情平静'],
  [/羞涩又坚定/g, '视线稳定、嘴唇轻抿'],
];

const LIGHT = [
  [/晨光映出慌乱眼神|慌乱眼神/g, '左前方来的低角度晨光，柔和，面部有自然的明暗过渡'],
  [/柔光贴近面部|柔光/g, '柔和的大面积散射光，面部受光均匀、阴影很浅'],
  [/脸颊红意更重/g, '侧逆光勾出发丝边缘'],
  [/光线干净，?神情无波|光线干净/g, '均匀散射光，阴影很浅'],
  [/晨光变得柔和/g, '晨光转柔，光比降低'],
  [/林间光斑落在两人衣摆上|林间光斑/g, '树影在衣摆上形成斑驳光斑'],
];

function replaceAll(text, rules) {
  let out = String(text || '');
  for (const [pattern, replacement] of rules) out = out.replace(pattern, replacement);
  return out;
}

function clean(text) {
  return String(text || '').replace(/[。．.]+$/, '').trim();
}

/**
 * 「叙述说话」的词表 —— 出现在**带台词的镜头**的 `action` 或 `visible_behavior` 里就会出事。
 *
 * 2026-09-24 `divorce_standoff` g002 实测：`shot.action` 写的是
 * 「他一把拍在桌沿上……；**他连喊三声好，最后压着声音说出离婚**」，
 * 它被逐字拼进 H3 提示词（还在 `summary:` 里出现第二次），结果 **H3 把这段叙述念了出来** ——
 * 音频里多了一句本不该存在的"台词"。台词原文只该走 `<d>…</d>` 那一段；
 * `action` 里的"谁说了什么、怎么说的"既多余、又会被当成台词。
 *
 * 所以这里只**报告**（和 `auditPrompt` 一样不阻断）：写到就该改写法，而不是祈祷抽卡。
 * 判据刻意保守 —— 只看带台词的镜头；命中词表即提醒，宁可误报也不漏报。
 */
const SPEECH_NARRATION = /(说|喊|念|道|问|答|接话|回击|出声|开口|台词|质问|低语|嘟囔|絮语)/;

/** @returns {Array<{shot:number, field:string, word:string, text:string}>} */
export function narrationWarnings(unit) {
  const out = [];
  for (const shot of unit?.shots || []) {
    if (!(shot.lines || []).length) continue;      // 只有带台词的镜头才会被当成台词
    const fields = [['action', shot.action]];
    for (const e of shot.emotion_analysis || []) fields.push([`visible_behavior(${e.character})`, e.visible_behavior]);
    for (const [field, text] of fields) {
      const hit = SPEECH_NARRATION.exec(String(text || ''));
      if (hit) out.push({ shot: shot.n, field, word: hit[0], text: String(text || '') });
    }
  }
  return out;
}

/** 官方切镜时间戳格式：MM:SS.mmm（如 00:03.500）。 */
function mmss(t) {  const total = Math.max(0, Number(t) || 0);
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
}

/** The single production owner for FastH3 unit prompts. */
export function buildUnitPrompt(unit, ctx) {
  const { nameOf, lineText, board, scene } = ctx;
  const refs = ctx.refs || [];
  const usingRefs = refs.length > 0;
  const parts = [];

  if (usingRefs) {
    const definitions = refs.map((ref, index) => {
      const tag = `<Picture ${index + 1}>`;
      if (ref.role === 'keyframe') return `${tag} is the target shot's own first frame — copy its composition, camera angle, lighting and colour exactly.`;
      const who = ref.who ? nameOf(ref.who) : 'the subject';
      if (ref.role === 'face') return `${tag} is ${who}'s face reference — the face, hairstyle, hair ornaments and skin must match it exactly.`;
      if (ref.role === 'prop') return `${tag} is the reference for the prop ${who} — preserve its shape, material, colour and markings exactly.`;
      return `${tag} is ${who}'s costume reference — the cut, layers, colour and sash must match it exactly.`;
    });
    parts.push(`subject_definitions: ${definitions.join(' ')}`);
    // summary 也是逐字取 shot.action，同样要过去夸张词表（漏了它等于没堵）。
    const summary = unit.shots.map((shot) => String(shot.action || '').trim()).filter(Boolean).join(' ');
    parts.push('summary: ' + (summary ? replaceAll(summary, DEACT) : 'A continuous multi-shot scene.'));
    parts.push('retention_analysis: '
      + 'Preserve every subject\'s facial structure, eyebrow shape, eye shape, lip shape and skin tone exactly as in the reference pictures. '
      + '**Do not change anyone\'s hairstyle, and do not add or remove hair ornaments or ribbons.** '
      // 实验 B：原来这里写的是「a faint real flush on the cheeks is allowed, but never render it as
      // blush, rouge, lipstick or any other makeup, and never darken or redden the lips」。
      // 本意是否定，实测却压不住腮红 —— 反倒像是递了一份「妆」的词表给模型。
      // 现改为纯正向的复现约束，整段不含任何妆/色词汇。
      + 'Skin and lips must stay exactly as they are in the reference pictures — nothing added, nothing removed. '
      + 'Keep each character\'s costume identical to its reference. '
      + 'Do not merge subjects, do not introduce anyone who is not listed above, and do not create a slideshow.');
  } else if (ctx.hasFirstFrame) {
    parts.push('For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.');
  }

  const speakerIds = new Map();
  const voiceAnnounced = new Set();
  let nextSpeaker = 0;
  for (const shot of unit.shots) {
    for (const line of shot.lines || []) {
      const dialogue = lineText.get(line);
      if (dialogue && !speakerIds.has(dialogue.who)) speakerIds.set(dialogue.who, `S${++nextSpeaker}`);
    }
  }

  const characterOf = (identityId) => {
    const identity = (board.identities || []).find((item) => item.id === identityId);
    const characterId = identity ? identity.character : String(identityId).replace(/_default.*$/, '');
    return (board.characters || []).find((item) => item.id === characterId) || null;
  };
  const appearanceOf = (identityId) => {
    const identity = (board.identities || []).find((item) => item.id === identityId);
    const character = characterOf(identityId);
    return [character?.face_prompt, identity?.appearance_details].filter(Boolean).join('；');
  };

  const body = [];
  // 锁定风格头与风格排除是**全片公共前缀**，不是某一镜的属性，所以放在逐镜描述之前。
  const contractCine = compileCinematography(ctx.contract, { lang: 'en' });
  if (contractCine.header) body.push(contractCine.header);
  if (contractCine.negatives) body.push(contractCine.negatives);
  // ---------------------------------------------------------------- audience_knows **不进提示词**
  //
  // 它曾经被当成一行普通中文叙述塞在这里（`integrated_multimodal_description` 的最前面）。
  // 2026-09-24 `divorce_standoff` 实测：**H3 把这行旁白念了出来** —— g003 那一段没有台词，
  // 音频里却有明显人声（2.0s 处峰值 -12.1 dB、高频 -29.8 dB）；用户直接听出来了。
  // 同一部剧里 `shot.action` 的中文叙述也被念过（并在另一版里漏成画面字幕）。
  // 教训是同一个：**这个字段是 H3 拿来读"片子在讲什么"的通道，写进去的中文白话会被当旁白。**
  //
  // 那为什么当初写进来？注释引的是 `pot_hit`（2026-09-20）"没人问这一句时，
  // **调度**会把知情错位拍丢"。注意那是**导演层**的问题：调度已经由 `keyframe_start`、
  // `action`、`gaze`、`visible_behavior`、`facing` 承载了。把白话塞进生成提示词是推断，
  // 不是实测 —— 而实测反例有两个。
  //
  // 所以：`audience_knows` 留在**导演稿**里当纪律与人工审阅项（见
  // `references/director/schema.md` 与导演闸门），**不再进任何生成提示词**。
  for (const [index, shot] of unit.shots.entries()) {
    const action = replaceAll(clean(shot.action), DEACT);
    const faces = Object.entries(shot.facing || {})
      .filter(([, facing]) => facing !== 'away' || !/前行|走|背影/.test(action))
      .filter(([, facing]) => !(facing === 'right' && /右侧/.test(action)))
      .filter(([, facing]) => !(facing === 'left' && /左侧/.test(action)))
      .map(([id, facing]) => `${(shot.on_screen || []).length === 1 ? '' : `${nameOf(id)} `}${FACING_PHRASE[facing] || ''}`.trim())
      .filter(Boolean)
      .join('，');
    // 导演执行约束同样要过去夸张词表：visible_behavior 里的「脸颊泛红」以前是直接进提示词的。
    const directives = replaceAll(compileDirectorExecution(shot, nameOf).map((item) => item.text).join('；'), DEACT);
    const camera = shot.camera && !/^固定/.test(shot.camera) ? `，摄影机${clean(shot.camera)}` : '';
    const segment = [];
    segment.push(index > 0
      ? `[Shot ${index + 1}] At ${mmss(shot.at)}, the camera cuts to`
      : '[Shot 1]');
    segment.push(`a ${FRAMING_EN[shot.framing] || shot.framing}`);
    const people = (shot.on_screen || []).map(nameOf).join('与');
    if (people) segment.push(`of ${people}`);
    const looks = (shot.on_screen || []).map(appearanceOf).filter(Boolean).join('；');
    // 镜头与光是**每镜**属性，所以进这一镜的描述，而不是全片前缀。
    const shotCine = compileCinematography(ctx.contract, { shot, framing: shot.framing, lang: 'en' });
    const middle = [faces, directives, looks, action + camera, shotCine.optics, shotCine.lighting, replaceAll(clean(shot.lighting), LIGHT)].filter(Boolean).join('，');
    if (middle) segment.push(`—— ${middle}`);
    let text = segment.join(' ') + '。';
    // 全片规则每镜都要带（否则这一镜就不受约束），但**按本镜的覆盖取值** ——
    // 所以它跟 optics / lighting 一样是每镜属性，不是全片前缀。
    if (shotCine.rules) text += `\n${shotCine.rules}`;
    const lineSpeakers = new Set();
    for (const line of shot.lines || []) {
      const dialogue = lineText.get(line);
      if (!dialogue) { text += `（警告：第 ${line} 行没有台词原文）`; continue; }
      lineSpeakers.add(dialogue.who);
      const speaker = speakerIds.get(dialogue.who);
      // 官方 base-en：说话人**首现**交代音色（年龄/性别），之后只用稳定 ID。
      let voiceNote = '';
      if (speaker && !voiceAnnounced.has(dialogue.who)) {
        voiceAnnounced.add(dialogue.who);
        const descriptor = voiceDescriptorOf(characterOf(dialogue.who));
        if (descriptor) voiceNote = `，${descriptor}`;
      }
      const identity = `${nameOf(dialogue.who)}${speaker ? ` (${speaker}${voiceNote})` : ''}`;
      text += dialogue.kind === 'voiceover'
        ? ` ${identity} says in an off-screen voiceover: <d>[Chinese] ${dialogue.text}</d>，嘴唇始终完全闭合。`
        : ` ${identity}${dialogue.emotion ? `，${dialogue.emotion}` : ''}，说道：<d>[Chinese] ${dialogue.text}</d>。`;
    }
    // 口型落脸兜底（外部实证 3 次里 2 次口型落在不说话者的正脸上，明写闭合后 3/3 全对）：
    // H3 会把口型给画面里最显眼的正脸。本镜只要有人开口，其余画内角色一律明写嘴唇闭合
    // —— 不说话者交代的优先级高于"最显眼的正脸"。画外音说话者若在画内，其台词自带闭合句。
    if (lineSpeakers.size) {
      const silent = (shot.on_screen || []).filter((id) => !lineSpeakers.has(id));
      if (silent.length) text += `（${silent.map(nameOf).join('与')}不出声，嘴唇保持完全闭合。）`;
    }
    body.push(text);
  }

  parts.push(`${usingRefs ? 'detailed_description' : 'integrated_multimodal_description'}: ${body.join('\n')}`);
  const ambience = unit.shots.map((shot) => shot.audio).filter(Boolean);
  parts.push('overall_soundscape: ' + (ambience.length
    ? [...new Set(ambience)].join(' ')
    : (scene?.environment ? `${scene.environment}的环境音` : 'Ambient environmental sound matching the scene.')));
  parts.push('non_diegetic_music: ' + (board.meta?.music || 'N/A'));
  if (unit.shots.some((shot) => (shot.lines || []).length)) {
    parts.push('on_screen_text: none. No subtitles, no captions, no text overlays of any kind.');
  }
  return parts.join('\n\n');
}
