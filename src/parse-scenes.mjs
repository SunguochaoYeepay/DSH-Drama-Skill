/**
 * parse-scenes.mjs — 场次解析：**能确定性做的，不要交给模型**。
 *
 * 剧本的场次头是高度格式化的，正则能百分之百认出来，而模型会认错、会漏、会自己编。
 * 所以先确定性解析，把结果当**菜单**交给模型，让它只能从菜单里挑（DramaClaw 的做法）。
 *
 * 支持两种真实格式：
 *   A) 复合头（「标准分镜版」常见）：
 *        第 1 集 1-1 场景：外 林间古道 清晨 人物：大师兄、小师妹
 *        △ 动作行以 △ 开头
 *        小师妹（语气温软）：台词
 *   B) 分行头：
 *        1-1　【清晨】【外】林间古道
 *        场次1 / 地点：废弃球场 / 时间：傍晚 / 【外】
 *
 * 认不出来就返回空数组 —— 由调用方决定是退回 LLM 还是报错，**这里不猜**。
 */

/** 中文数字 → 阿拉伯数字（只处理剧本里会出现的量级）。 */
function cn2num(s) {
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  const d = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  if (s === '十') return 10;
  if (s.length === 1) return d[s] ?? null;
  if (s[0] === '十') return 10 + (d[s[1]] ?? 0);
  if (s[1] === '十') return (d[s[0]] ?? 0) * 10 + (d[s[2]] ?? 0);
  return null;
}

const RE_EP_ANY = /第\s*([0-9一二三四五六七八九十]+)\s*[集话]/;
const RE_NUMBERED = /(\d{1,3})\s*[-－—.]\s*(\d{1,3})/;
const RE_SIMPLE_SCENE = /(?:第\s*([0-9一二三四五六七八九十]+)\s*场|场次\s*([0-9一二三四五六七八九十]+))/;
const RE_LABEL_SCENE = /(?:场景|地点|外景|内景)\s*[:：]\s*([内外]?)\s*/;
const RE_LABEL_PEOPLE = /人物\s*[:：]\s*([^\n]+)/;
const RE_LABEL_TIME = /(?:时间|时)\s*[:：]\s*([^\n]+)/;
const RE_TOKEN = /[【\[（(]\s*([^】\]）)]{1,10})\s*[】\]）)]/g;
// 台词行：「名字（说明）：台词」或「名字：台词」
const RE_SPEAKER = /^\s*([^\s：:【】\[\]（）()△▲]{1,12})\s*(?:[（(][^）)]*[）)]\s*)?[:：]/;

const INTERIOR = ['内', '内景', '室内', 'int', 'interior'];
const EXTERIOR = ['外', '外景', '室外', 'ext', 'exterior'];
const TIME_WORDS = ['凌晨', '清晨', '黎明', '拂晓', '早晨', '早上', '上午', '中午', '正午', '午后', '下午', '白天', '傍晚', '黄昏', '日落', '晚上', '夜晚', '深夜', '半夜', '夜', '日', '晨', '午'];
const TIME_ENUM = ['无', '清晨', '上午', '正午', '午后', '白天', '黄昏', '夜晚'];
const TIME_ALIASES = {
  卯时: '清晨', 辰时: '上午', 巳时: '上午', 午时: '正午', 未时: '午后', 申时: '午后',
  酉时: '黄昏', 戌时: '夜晚', 亥时: '夜晚', 子时: '夜晚', 丑时: '夜晚', 寅时: '清晨',
  黎明: '清晨', 拂晓: '清晨', 早晨: '清晨', 早上: '清晨', 凌晨: '清晨',
  中午: '正午', 下午: '午后', 傍晚: '黄昏', 日落: '黄昏',
  晚上: '夜晚', 夜里: '夜晚', 深夜: '夜晚', 半夜: '夜晚', 夜: '夜晚', 日: '白天', 晨: '清晨', 午: '正午',
};

function normTime(t) {
  const s = String(t || '').trim();
  if (!s) return '无';
  if (TIME_ENUM.includes(s)) return s;
  if (TIME_ALIASES[s]) return TIME_ALIASES[s];
  for (const k of Object.keys(TIME_ALIASES)) if (s.includes(k)) return TIME_ALIASES[k];
  const hit = TIME_WORDS.find((w) => s.includes(w));
  return hit ? TIME_ALIASES[hit] || '无' : '无';
}

/** 行内第一个出现的时间词。 */
function timeIn(text) {
  const t = String(text || '');
  let best = null;
  let bestAt = Infinity;
  for (const w of TIME_WORDS) {
    const at = t.indexOf(w);
    if (at >= 0 && at < bestAt) { bestAt = at; best = w; }
  }
  return best ? normTime(best) : '无';
}

/**
 * 判断这一行是不是场次头，是就把字段抠出来。
 * 台词行、动作行（△）一律不算。
 */
function tryHeader(line, hasCurrent) {
  if (/^[△▲]/.test(line)) return null;
  const hasEp = RE_EP_ANY.test(line);
  const hasLabel = RE_LABEL_SCENE.test(line);
  const hasSimple = RE_SIMPLE_SCENE.test(line);
  const hasNumbered = RE_NUMBERED.test(line);
  if (!hasEp && !hasLabel && !hasSimple && !hasNumbered) return null;

  // 带场次号的才算「新场次头」。
  // 只有「地点：/场景：」标签的，只有在**场外**才是新场次 —— 否则它是场内的字段行。
  // （「场次1」下一行写「地点：废弃球场」，那是同一个场次的字段，不是第二个场次）
  const anchored = hasEp || hasSimple || /^\s*\d{1,3}\s*[-－—.]/.test(line);
  if (!anchored && (hasCurrent || !hasLabel)) return null;

  // 台词行有说话人前缀
  if (!anchored && RE_SPEAKER.test(line)) return null;

  const ep = line.match(RE_EP_ANY);
  const num = line.match(RE_NUMBERED);
  const simple = line.match(RE_SIMPLE_SCENE);
  const label = line.match(RE_LABEL_SCENE);
  const people = line.match(RE_LABEL_PEOPLE);
  const timeLabel = line.match(RE_LABEL_TIME);

  // 场景名的取法，按可靠性依次退：标签后 → 【】里 → 抠掉所有已知片段后的剩余
  let location = '';
  if (label) {
    let tail = line.slice(label.index + label[0].length);
    tail = tail.split(RE_LABEL_PEOPLE)[0];
    tail = tail.split(RE_LABEL_TIME)[0];
    tail = tail.replace(/[【\[（(][^】\]）)]*[】\]）)]/g, ' ');
    for (const w of TIME_WORDS) tail = tail.split(w).join(' ');
    location = tail.replace(/[\s　]+/g, ' ').trim();
  }
  if (!location) {
    RE_TOKEN.lastIndex = 0;
    let m;
    while ((m = RE_TOKEN.exec(line)) !== null) {
      const t = m[1].trim();
      const tl = t.toLowerCase();
      if (INTERIOR.includes(tl) || EXTERIOR.includes(tl)) continue;
      if (TIME_WORDS.some((w) => t === w || t.includes(w))) continue;
      location = t;
      break;
    }
  }
  if (!location) {
    let tail = line
      .replace(RE_EP_ANY, ' ')
      .replace(RE_SIMPLE_SCENE, ' ')
      .replace(RE_NUMBERED, ' ')
      .replace(/[【\[（(][^】\]）)]*[】\]）)]/g, ' ');
    for (const w of TIME_WORDS) tail = tail.split(w).join(' ');
    location = tail.replace(/[\s　]+/g, ' ').trim();
  }

  let ie = '无';
  if (label && label[1]) ie = label[1];
  else {
    RE_TOKEN.lastIndex = 0;
    let m;
    while ((m = RE_TOKEN.exec(line)) !== null) {
      const tl = m[1].trim().toLowerCase();
      if (INTERIOR.includes(tl)) { ie = '内'; break; }
      if (EXTERIOR.includes(tl)) { ie = '外'; break; }
    }
  }

  const time = timeLabel ? normTime(timeLabel[1]) : timeIn(line);

  return {
    episode: ep ? cn2num(ep[1]) : null,
    scene_no: simple ? cn2num(simple[1] || simple[2]) : (num ? Number(num[2]) : null),
    episode_from_header: num ? Number(num[1]) : null,
    location,
    time_of_day: time,
    interior_exterior: ie,
    characters: people ? people[1].split(/[、,，\s]+/).map((x) => x.trim()).filter(Boolean) : [],
  };
}

/**
 * 解析剧本场次。
 * @returns {{scenes: Array, episode_count: number, looks_like_screenplay: boolean, dialogue_lines: number}}
 */
export function parseScenes(text) {
  const lines = String(text || '').split(/\r?\n/);
  const scenes = [];
  let episode = null;
  let current = null;
  const push = () => { if (current) scenes.push(current); current = null; };

  let dialogueLines = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // 单独一行的「第N集」只设集号 —— 集不是场次，别给它开一个空场
    const epOnly = line.match(RE_EP_ANY);
    if (epOnly && line.replace(RE_EP_ANY, '').replace(/[\s　:：\-—]+/g, '') === '') {
      episode = cn2num(epOnly[1]);
      continue;
    }

    const head = tryHeader(line, current !== null);
    if (head) {
      push();
      current = {
        header_line: line,
        episode: head.episode_from_header || head.episode || episode,
        scene_no: head.scene_no ?? null,
        location: head.location || '',
        time_of_day: head.time_of_day || '无',
        interior_exterior: head.interior_exterior || '无',
        line_number: i + 1,
        characters: [...head.characters],
      };
      if (head.episode) episode = head.episode;
      continue;
    }

    // 台词行计数（用来判断"这是不是剧本"）
    if (!/^[△▲]/.test(line) && RE_SPEAKER.test(line)) dialogueLines++;

    if (!current) continue;

    // 场次内的补充标记行：地点：/ 时间：/ 纯【】标记行
    const lm = line.match(/^\s*(?:地点|场景)\s*[:：]\s*(.+?)\s*$/);
    if (lm) { if (!current.location) current.location = lm[1]; continue; }
    const tmv = line.match(/^\s*(?:时间|时)\s*[:：]\s*(.+?)\s*$/);
    if (tmv) { if (current.time_of_day === '无') current.time_of_day = normTime(tmv[1]); continue; }
    if (/^[【\[（(]/.test(line) && !RE_SPEAKER.test(line)) {
      RE_TOKEN.lastIndex = 0;
      let m;
      while ((m = RE_TOKEN.exec(line)) !== null) {
        const tl = m[1].trim().toLowerCase();
        if (current.interior_exterior === '无' && INTERIOR.includes(tl)) current.interior_exterior = '内';
        else if (current.interior_exterior === '无' && EXTERIOR.includes(tl)) current.interior_exterior = '外';
        else if (current.time_of_day === '无') {
          const t = normTime(m[1].trim());
          if (t !== '无') current.time_of_day = t;
        }
      }
    }
  }
  push();

  // 回填每场的出场人物（头里没写人物：的时候）
  for (const [k, sc] of scenes.entries()) {
    if (sc.characters.length) continue;
    const start = sc.line_number;
    const end = k + 1 < scenes.length ? scenes[k + 1].line_number - 1 : lines.length;
    const names = new Set();
    for (let i = start; i < end; i++) {
      const l = lines[i].trim();
      if (/^[△▲]/.test(l)) continue;
      const m = l.match(RE_SPEAKER);
      const n = m && m[1];
      if (n && n.length <= 8 && !/^(场景|地点|时间|内景|外景|旁白|字幕|第.*集|风格|时长|人物设定)$/.test(n)) names.add(n);
    }
    sc.characters = [...names];
  }

  // 「像不像剧本」：有场次头，**或者**台词行够密
  const looksLike = scenes.length > 0 || dialogueLines >= 5;

  return {
    scenes,
    episode_count: new Set(scenes.map((s) => s.episode).filter((x) => x != null)).size,
    looks_like_screenplay: looksLike,
    dialogue_lines: dialogueLines,
  };
}

/** 把解析结果压成给模型看的「场景菜单」。 */
export function sceneMenu(parsed) {
  return parsed.scenes.map((s, i) => ({
    id: `scene_${String(i + 1).padStart(2, '0')}`,
    source_line: s.header_line,
    location: s.location,
    time_of_day: s.time_of_day,
    interior_exterior: s.interior_exterior,
    characters: s.characters,
  }));
}
