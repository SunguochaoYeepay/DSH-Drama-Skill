/**
 * literal.mjs — 逐行模式：**台词一个字都不许改**。
 *
 * 和「自由编译」的根本差别：那一种是把剧本丢给模型"写一版分镜"，模型顺手就改写了台词；
 * 这一种是**代码切行、代码分组、代码搬运台词**，模型只被允许润色画面描述。
 *
 *   「逐字保真」在这里是**构造保证**，不是"求模型别改"。
 *
 * 分工：
 *   代码负责：切行 / 分组分镜 / 台词原文 / 出场造型 / 时长估算
 *   模型负责（可选）：润色 prompt、补 audio、选景别运镜
 *   —— 模型**永远拿不到**改台词的权限，因为它压根不负责输出台词。
 */

import { parseScript, spokenLines } from './parse-script.mjs';

const SHOT_MAX_S = 15;
/** 中文口播速度：约 5.5 字/秒。用来估时长，不用来裁文本。 */
const CHARS_PER_SEC = 5.5;

const LIGHT_BY_TIME = {
  清晨: '柔和晨光斜射，空气通透',
  上午: '明亮散射光',
  正午: '顶光，高对比',
  午后: '偏暖侧光',
  白天: '均匀自然光',
  黄昏: '暖金逆光，长影',
  夜晚: '低照度冷光，暗部层次',
  无: '自然光',
};

/** 台词时长估算：说话长度 + 一个呼吸的余量。 */
function estimateDuration(lines) {
  let sec = 0;
  for (const l of lines) {
    if (l.kind === 'dialogue' || l.kind === 'voiceover') {
      sec += l.text.length / CHARS_PER_SEC + 1;
    }
  }
  if (!sec) sec = 3;                        // 纯动作镜
  return Math.min(SHOT_MAX_S, Math.max(1, Math.round(sec)));
}

/** 从动作描述里抠一个具体的声音事件 —— H3 的电平跟着内容走，写虚的等于写静音。 */
function soundFrom(text, scene) {
  const t = String(text || '');
  const hit = t.match(/[^，。；]*?(?:沙沙|作响|声|响|鸣|哗|咚|砰|哒)[^，。；]*/);
  if (hit) return hit[0].replace(/^[，。；、]/, '').trim();
  if (/林|树|山/.test(scene?.location || '') || /林|树/.test(t)) return '树叶摩擦的沙沙声与踩在石板路上的脚步声';
  return '环境底噪与衣料摩擦声';
}

/**
 * 让缺失的角色/造型自动补出来 —— 剧本是唯一事实源，它提到的人必须存在。
 * @returns {{characters: Array, identities: Array, byName: Map}}
 */
function ensureCast(board, parsed) {
  const characters = board.characters || [];
  const identities = board.identities || [];
  const byName = new Map();

  const link = (ch) => {
    let owned = identities.filter((x) => x.character === ch.id);
    if (!owned.length) {
      const ident = {
        id: `${ch.id}_default`,
        character: ch.id,
        name: '默认造型',
        appearance_details: `${ch.name}的服装（待补）`,
        costume_image: null, sheet: null, reference_images: [], voice_ref: null,
      };
      identities.push(ident);
      owned = [ident];
    }
    ch.identities = owned.map((x) => x.id);
    byName.set(ch.name, ch);
    return ch;
  };
  for (const ch of characters) link(ch);

  const slug = (name) => `c_${String(name).replace(/[^A-Za-z0-9\u4e00-\u9fa5]/g, '')}`.slice(0, 24)
    .replace(/[\u4e00-\u9fa5]/g, (c) => c.codePointAt(0).toString(16));

  // 剧本「人物设定」段落里出现的人
  for (const l of parsed.lines) {
    if (l.kind !== 'character_setting') continue;
    if (byName.has(l.speaker)) continue;
    const ch = {
      id: slug(l.speaker), name: l.speaker, age_group: 'youth',
      // 注意：剧本的「人物设定」写的是**性格**（清冷靠谱、钢铁直男），不是长相。
      // 所以这里只留占位，长相交给面部描述那一层 —— 族裔由 assets.mjs 的锚点兜底。
      face_prompt: `${l.speaker}的面部特征（待补）`,
      portrait: null, voice: '', identities: [],
    };
    characters.push(ch);
    link(ch);
  }
  // 说过话的人
  for (const l of spokenLines(parsed)) {
    if (byName.has(l.speaker)) continue;
    const ch = { id: slug(l.speaker), name: l.speaker, age_group: 'youth', face_prompt: `${l.speaker}的面部特征（待补）`, portrait: null, voice: '', identities: [] };
    characters.push(ch);
    link(ch);
  }
  return { characters, identities, byName };
}

/**
 * 逐行编译。
 * @param {object} board  至少要有 meta / story（story.source 是剧本原文）
 * @param {object} opts   { annotate?: (shots, ctx) => Promise<void> }
 */
export async function compileLiteral(board, opts = {}) {
  const source = board.story?.source;
  if (!source) throw new Error('逐行模式需要 story.source（剧本原文）');

  const parsed = parseScript(source);
  const { characters, identities, byName } = ensureCast(board, parsed);
  const sceneCast = new Map((board.scene_cast || []).map((x) => [`${x.scene_no}:${x.speaker}`, x.identity]));
  const identityIds = new Set(identities.map((x) => x.id));
  for (const [key, identity] of sceneCast) {
    if (!identityIds.has(identity)) throw new Error(`场次角色映射引用了不存在的造型：${key} -> ${identity}`);
  }
  // 同一剧本说话人可在不同场次对应不同身份；显式映射优先于名字匹配。
  for (const [key, identity] of sceneCast) {
    const speaker = key.slice(key.indexOf(':') + 1);
    const ident = identities.find((x) => x.id === identity);
    const ch = ident && characters.find((x) => x.id === ident.character);
    if (ch) byName.set(speaker, ch);
  }
  const mappedSpeakers = new Set([...sceneCast.keys()].map((key) => key.slice(key.indexOf(':') + 1)));
  const mappedCharacterIds = new Set([...sceneCast.values()].map((identity) => identities.find((x) => x.id === identity)?.character).filter(Boolean));
  for (let i = characters.length - 1; i >= 0; i -= 1) {
    if (characters[i].id.startsWith('c_') && mappedSpeakers.has(characters[i].name)) {
      const removed = characters.splice(i, 1)[0];
      for (let j = identities.length - 1; j >= 0; j -= 1) if (identities[j].character === removed.id) identities.splice(j, 1);
    }
  }
  const castOf = (name) => {
    const ch = byName.get(name);
    if (!ch) return null;
    return (ch.identities && ch.identities[0]) || null;
  };

  // 场景映射：剧本里的场次号 → board.scenes 的 id
  const sceneList = board.scenes && board.scenes.length ? board.scenes : [];
  const sceneIdOf = (sceneNo, location) => {
    const byNo = sceneList.find((s) => s.scene_no === sceneNo);
    if (byNo) return byNo.id;
    const byName_ = sceneList.find((s) => s.name === location || s.name === location?.trim());
    if (byName_) return byName_.id;
    return null;
  };
  const sceneByNo = new Map(sceneList.map((s) => [s.scene_no, s]));
  // 若 board 里一个场景都没有，按剧本场次现造。
  // `environment` 用**这一场的第一个动作行**（它通常在描写环境），并在角色名出现处截断 ——
  // 环境描述里不该混进人物的动作。
  if (!sceneList.length) {
    const firstAction = (no) => parsed.lines.find((l) => l.kind === 'action' && l.scene_no === no);
    const names = [...new Set(parsed.lines.filter((l) => l.kind === 'character_setting').map((l) => l.speaker))];
    const trimAtName = (text) => {
      let cut = text.length;
      for (const n of names) {
        const at = text.indexOf(n);
        if (at > 0 && at < cut) cut = at;
      }
      return text.slice(0, cut).replace(/[，,、；;]\s*$/, '').trim();
    };
    for (const [i, s] of parsed.scenes.entries()) {
      const act = firstAction(s.scene_no);
      let env = act ? trimAtName(act.text) : '';
      const time = s.time_of_day && s.time_of_day !== '无' ? s.time_of_day : '';
      if (env && time && !env.includes(time)) env = `${time}${env}`;
      if (env && s.location && !env.includes(s.location)) env = `${s.location}，${env}`;
      if (!env) env = `${time}${s.location}`.trim() || `场景${i + 1}的环境（待补）`;
      if (env.length < 6) env = `${env}，环境待补`;
      sceneList.push({
        id: `scene_${String(i + 1).padStart(2, '0')}`,
        name: s.location || `${time}场景${i + 1}`,
        environment: env,
        time_of_day: s.time_of_day || '无',
        scene_no: s.scene_no,
        master: null, reverse_master: null, spatial_layout: null,
      });
    }
  }
  // Brief 提供的场景若未写 scene_no，只允许按明确的剧本顺序补齐一次，随后即冻结映射。
  for (const [i, s] of parsed.scenes.entries()) {
    if (sceneList[i] && sceneList[i].scene_no == null) sceneList[i].scene_no = s.scene_no;
  }
  for (const s of parsed.scenes) {
    if (s.scene_no == null || !sceneList.some((x) => x.scene_no === s.scene_no)) {
      throw new Error(`剧本场次 ${s.scene_no ?? '?'} 没有明确对应的 Brief 场景`);
    }
  }
  const castOfAt = (name, sceneNo) => sceneCast.get(`${sceneNo}:${name}`) || castOf(name);

  // ---- 分组：动作行攒着，遇到台词就合成一镜 ----
  const shots = [];
  let buffer = [];          // 攒着的动作行
  let sceneNo = parsed.scenes[0]?.scene_no ?? null;
  let location = parsed.scenes[0]?.location || '';
  let idx = 0;

  const flush = (dialogueLine) => {
    if (!buffer.length && !dialogueLine) return;
    idx += 1;
    const id = `s${String(idx).padStart(2, '0')}`;
    const scene = parsed.scenes.find((s) => s.scene_no === sceneNo) || parsed.scenes[0];
    const lines = dialogueLine ? [...buffer, dialogueLine] : [...buffer];

    const cast = [];
    if (dialogueLine) {
      const cid = castOfAt(dialogueLine.speaker, sceneNo);
      if (cid) cast.push(cid);
    }
    // 动作里提到谁，谁就出场（按名字匹配）
    const actionText = buffer.map((b) => b.text).join(' ');
    for (const [name, ch] of byName) {
      if (name && actionText.includes(name)) {
        const cid = castOfAt(name, sceneNo) || (ch.identities && ch.identities[0]);
        if (cid && !cast.includes(cid)) cast.push(cid);
      }
    }

    const dialogue = dialogueLine
      ? [{
        character: castOfAt(dialogueLine.speaker, sceneNo) || dialogueLine.speaker,
        text: dialogueLine.text,                       // ← 原文，未经任何模型
        emotion: dialogueLine.parenthetical || (dialogueLine.kind === 'voiceover' ? '内心独白' : ''),
        kind: dialogueLine.kind === 'voiceover' ? 'voiceover' : 'spoken',
      }]
      : [];

    const size = dialogueLine
      ? (cast.length > 1 ? '中景' : '近景')
      : (idx <= 2 ? '全景' : '中景');
    const camera = dialogueLine
      ? (cast.length > 1 ? '左右轻微横移' : '固定镜头')
      : (idx <= 2 ? '缓慢前推' : '缓慢横移');

    const marks = cast.map((c) => `{{${c}}}`).join('、');
    const prompt = [
      marks,
      actionText,
      dialogueLine ? `${size}，${camera}` : `${size}，${camera}`,
    ].filter(Boolean).join('，');

    shots.push({
      id,
      scene: sceneIdOf(sceneNo, location),
      cast,
      props: [],
      duration_s: estimateDuration(lines),
      shot_size: size,
      lighting: LIGHT_BY_TIME[scene?.time_of_day] || LIGHT_BY_TIME['无'],
      camera,
      action: actionText || (dialogueLine ? `${dialogueLine.speaker}开口说话` : `${scene?.location || '场景'}的空镜`),
      prompt,
      audio: soundFrom(actionText, scene),
      dialogue,
      edit_note: dialogueLine ? '台词镜' : '动作镜',
      transition: { type: 'cut' },
      first_frame: null, last_frame: null, clip: null,
      // 溯源：这一镜是从剧本哪几行来的
      source_lines: lines.map((l) => l.no),
    });
    buffer = [];
  };

  for (const l of parsed.lines) {
    switch (l.kind) {
      case 'scene_header':
        flush(null);
        sceneNo = l.scene_no ?? sceneNo;
        location = parsed.scenes.find((s) => s.scene_no === sceneNo)?.location || location;
        break;
      case 'action':
        buffer.push(l);
        // 纯动作别攒太长，否则一镜吃掉一整段
        if (buffer.length >= 2) flush(null);
        break;
      case 'dialogue':
      case 'voiceover':
        flush(l);
        break;
      case 'card':
        flush(null);
        idx += 1;
        shots.push({
          id: `s${String(idx).padStart(2, '0')}`,
          scene: sceneIdOf(sceneNo, location),
          cast: [], props: [],
          duration_s: Math.min(SHOT_MAX_S, Math.max(2, Math.round(l.text.length / CHARS_PER_SEC))),
          shot_size: '全景', lighting: LIGHT_BY_TIME['无'],
          camera: '缓慢拉远',
          action: `片尾字幕浮现：${l.text}`,
          prompt: `片尾字幕全文浮现于画面，${l.text}`,
          audio: '配乐收尾，环境声渐弱',
          dialogue: [],
          edit_note: '片尾字幕',
          transition: { type: 'cut' },
          first_frame: null, last_frame: null, clip: null,
          source_lines: [l.no],
        });
        break;
      default:
        break;   // meta / character_setting 不成镜
    }
  }
  flush(null);

  const totalSeconds = shots.reduce((a, s) => a + s.duration_s, 0);
  const out = {
    meta: {
      ...board.meta,
      stage: 'shots',
      total_duration_s: totalSeconds,
      approvals: { story: board.meta?.approvals?.story || null, shots: null, assets: null, keyframes: null },
    },
    story: board.story,
    characters,
    identities,
    scenes: sceneList,
    props: board.props || [],
    shots,
  };

  if (typeof opts.annotate === 'function') {
    await opts.annotate(out.shots, { parsed, characters, identities, scenes: sceneList });
  }

  // 校验台词保真（构造上就该成立，这里断言一遍，是给未来改代码的人上的保险）
  const src = spokenLines(parsed).map((l) => l.text);
  const got = shots.flatMap((s) => (s.dialogue || []).map((d) => d.text));
  const report = {
    source_lines: parsed.lines.length,
    source_spoken: src.length,
    shots: shots.length,
    dialogue: got.length,
    verbatim: src.length === got.length && src.every((t, i) => t === got[i]),
    parsed,
  };
  return { board: out, report };
}
