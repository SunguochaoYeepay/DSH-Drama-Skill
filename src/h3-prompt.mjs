import { compileDirectorExecution } from './director-execution.mjs';
import { compileCinematography } from './cinematography.mjs';

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
  let nextSpeaker = 0;
  for (const shot of unit.shots) {
    for (const line of shot.lines || []) {
      const dialogue = lineText.get(line);
      if (dialogue && !speakerIds.has(dialogue.who)) speakerIds.set(dialogue.who, `S${++nextSpeaker}`);
    }
  }

  const appearanceOf = (identityId) => {
    const identity = (board.identities || []).find((item) => item.id === identityId);
    const characterId = identity ? identity.character : String(identityId).replace(/_default.*$/, '');
    const character = (board.characters || []).find((item) => item.id === characterId);
    return [character?.face_prompt, identity?.appearance_details].filter(Boolean).join('；');
  };

  const body = [];
  // 锁定风格头与风格排除是**全片公共前缀**，不是某一镜的属性，所以放在逐镜描述之前。
  const contractCine = compileCinematography(ctx.contract, { lang: 'en' });
  if (contractCine.header) body.push(contractCine.header);
  if (contractCine.negatives) body.push(contractCine.negatives);
  // 单元级的知情状态：它管的是「观众与角色的知情错位」，是**表演与视线**的依据，
  // 不是某一镜的属性 —— 所以放在逐镜描述之前，作为这一单元的前提。
  //
  // 为什么值得进提示词：`pot_hit`（2026-09-20）实测过 —— 没人问这一句时，调度会把
  // "观众已知、角色未知"的错位拍丢：花盆从角色身后飞上来、开场先说人再给飞机。
  // 两者的根因都是"0 秒首帧的约束改写了叙事顺序"，而这一行是把叙事顺序写进生成提示词的落点。
  const knows = clean(unit.audience_knows);
  if (knows) {
    body.push(`audience_knows（这一单元开始时观众与角色各自知道什么；用作表演与视线的依据，不是画面文字）：${knows}`);
  }
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
      ? `[Shot ${index + 1}] At ${shot.at.toFixed(2).padStart(5, '0')} seconds, the camera cuts to`
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
    for (const line of shot.lines || []) {
      const dialogue = lineText.get(line);
      if (!dialogue) { text += `（警告：第 ${line} 行没有台词原文）`; continue; }
      const speaker = speakerIds.get(dialogue.who);
      const identity = `${nameOf(dialogue.who)}${speaker ? ` (${speaker})` : ''}`;
      text += dialogue.kind === 'voiceover'
        ? ` ${identity} says in an off-screen voiceover: <d>[Chinese] ${dialogue.text}</d>，嘴唇始终完全闭合。`
        : ` ${identity}${dialogue.emotion ? `，${dialogue.emotion}` : ''}，说道：<d>[Chinese] ${dialogue.text}</d>。`;
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
