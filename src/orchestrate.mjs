/**
 * orchestrate.mjs — 编排：把分镜变成一条能拼起来的时间线。
 *
 * 四件事，全是**纯函数**（不联网、不烧卡、可离线断言）：
 *
 *   1. `speechSegments`  —— 哪几句话要配音
 *   2. `resolveDuration` —— **时长由音频反推**，不是拍脑袋写死
 *   3. `flfPlan`         —— 首尾帧怎么夹（**方向和我们原先做的相反**）
 *   4. `buildTimeline`   —— 累计时间轴 + SRT
 *
 * ## 为什么时长要由音频反推
 *
 * 我们原先的写法是"先定 5 秒，再想办法把话塞进去"。那必然对不齐：
 * 台词 45 个字要 9 秒，写 5 秒的话要么被截断，要么配音被拉快。
 * 正确顺序是**先出配音、量出秒数、再定画面时长**。
 *
 * ## 为什么首尾帧方向要反过来
 *
 * 我们原先：拿**上一镜的末帧**当本镜首帧 → 链式的，一镜废了后面全废。
 * DramaClaw：拿**下一镜的首帧**当本镜尾帧（FLF）→ 先出全部首帧，再两两夹出中间的运镜。
 * 后者不但容错，画面还真的"走到"下一镜的起点，衔接更自然。
 */

const FPS = 24;

/**
 * 音色兜底。**首选永远是 board 上 `characters[].voice` 填的 voice ID** ——
 * 这里只是"没填"时别让流程卡住的兜底，不是让模型猜音色。
 */
export const DEFAULT_VOICES = {
  female: process.env.AIH_VOICE_FEMALE || 'longhua_v3',      // 元气甜美女
  male: process.env.AIH_VOICE_MALE || 'longtian_v3',        // 磁性理智男
};

const FEMALE_HINT = /女|妹|姐|娘|妃|后|婆|姑|嫂|母|丫鬟|少女/;
const MALE_HINT = /男|兄|弟|爷|帝|王|公子|少年|大叔|师父|父亲|和尚/;

/**
 * 本地估算一句话要念多久 —— **不用调线上 TTS 去量**。
 *
 * 来历：原先 `doTts` 会调线上 cosyvoice 合成音频、ffprobe 量出秒数、写进 `duration_s`，
 * **然后把音频文件丢掉**（默认音轨用的是 H3 自己生成的人声）。
 * 等于花钱买了一次"量时长"服务。而 H3 是人声和环境音一起生成的，时长本来就该我们给它预算。
 *
 * 模型是对 **12 条真实 TTS 实测数据**做二元最小二乘拟合出来的：
 *
 *     秒 = −2.237 + 0.2359 × 字数 + 0.9753 × 停顿
 *
 *   停顿 = 句末标点 ×1 + 逗号顿号 ×0.6 + 省略号 ×1.5
 *   （停顿要单独算：「昏死？那我的衣服……是你给我穿的？」这种句子光数字数会低估 2.6 秒）
 *
 * | 模型 | 平均误差 | 最大 |
 * |---|---|---|
 * | 本模型 | **0.68s** | 1.56s |
 * | 只数字数 | 0.86s | 2.60s |
 * | 旧公式 字数/5.5 | 1.66s | — |
 *
 * **不要在这里加偏置。** 我一开始乘了 1.15 又加 0.5（怕估短），结果整片从 87 秒涨到 103 秒 ——
 * 全是没人说话的空白。而且理由本身站不住：**H3 会把人声塞进我们给的时长**，
 * 所以估短不是"截断台词"，是"H3 说快一点"；**估长才是真浪费**。呼吸余量交给调用方加一次就够。
 */
export function estimateSpeechSeconds(text) {
  const t = String(text || '');
  const chars = t.replace(/\s/g, '').length;
  if (!chars) return 0;
  const punct = (t.match(/[。！？；：]/g) || []).length
    + (t.match(/[，、]/g) || []).length * 0.6
    + (t.match(/……/g) || []).length * 1.5;
  const fit = -2.237 + 0.2359 * chars + 0.9753 * punct;
  return Math.min(15, Math.max(1.2, fit));
}

/**
 * 给角色定音色。
 * 优先级：board 上写死的 voice ID > 名字/脸描述里的性别线索 > 兜底。
 * **音色属于"必需属性"** —— 和年龄、族裔一样，不能指望模型自觉，代码得有个兜底。
 */
export function resolveVoice(board, character) {
  const v = String((character && character.voice) || '').trim();
  if (/^(long|loong)[a-z0-9_]*$/i.test(v)) return { voice: v, why: 'board 上指定的' };
  const hay = `${(character && character.name) || ''} ${(character && character.face_prompt) || ''} ${v}`;
  if (FEMALE_HINT.test(hay)) return { voice: DEFAULT_VOICES.female, why: '名字/描述里是女性线索（兜底音色）' };
  if (MALE_HINT.test(hay)) return { voice: DEFAULT_VOICES.male, why: '名字/描述里是男性线索（兜底音色）' };
  return { voice: DEFAULT_VOICES.male, why: '没有线索，用兜底男声' };
}

/**
 * 情绪 → 语速/音高。
 *
 * **为什么不用 `--instruction`**：实测 `cosyvoice-v3-flash` 不支持它（引擎报 428 InvalidParameter，
 * 那是 v3.5-flash 配克隆音色才有的功能）。而 `--rate` / `--pitch` 可用。
 *
 * 所以这里把情绪**确定性地映射**成语速音高 —— 效果不如自然语言指令，
 * 但比"悄悄把情绪丢掉"强，而且可断言。
 */
export function emotionToProsody(emotion, kind = 'spoken') {
  const t = String(emotion || '');
  let rate = 1.0;
  let pitch = 1.0;
  const why = [];
  if (kind === 'voiceover') { rate -= 0.06; pitch -= 0.02; why.push('内心独白：放慢、略压低'); }
  if (/慌|急|惊|错愕|紧张|急促/.test(t)) { rate += 0.12; pitch += 0.04; why.push('慌张：加快'); }
  else if (/羞|闷|嘟囔|局促|低/.test(t)) { rate -= 0.05; pitch -= 0.03; why.push('羞怯/闷闷：放慢、压低'); }
  else if (/平淡|冷静|正经|沉稳|一丝不苟|平静|严肃/.test(t)) { rate -= 0.04; pitch -= 0.02; why.push('冷静/正经：放慢、压平'); }
  else if (/坚定|认真|强调/.test(t)) { rate -= 0.02; pitch += 0.01; why.push('坚定：略慢、略提'); }
  else if (/无奈|失笑|无语/.test(t)) { rate -= 0.03; why.push('无奈：略慢'); }
  // 夹在服务端允许的区间里（帮助文档：0.5–2.0）
  rate = Math.min(2, Math.max(0.5, Number(rate.toFixed(2))));
  pitch = Math.min(2, Math.max(0.5, Number(pitch.toFixed(2))));
  return { rate, pitch, why: why.join('；') || '默认' };
}

/**
 * 转场决策：什么时候该用首尾帧衔接，什么时候必须硬切。
 *
 * 逐行编译器给所有镜头都写了 `cut`，于是一整片是 14 个硬切 ——
 * 这不叫"没做转场"，这叫**没做剪辑**。同场景同景别的连贯段落本来就该衔接起来。
 *
 * 规则（和 `references/prompts/story-to-board.md` 里写给模型的那条一致，只是这里由代码执行）：
 *   - 换场景 → 必须 cut（背景会跳）
 *   - 换景别 → 必须 cut（景别会被上一镜锁死）
 *   - 出场人物没有交集 → 必须 cut（多半是切到另一个视角了）
 *   - 连续衔接不要超过 2 个，否则剪辑点会被吃掉，整片变成一个长镜头
 */
export function planTransitions(board, opts = {}) {
  const maxRun = opts.maxRun ?? 2;
  const shots = board.shots || [];
  const out = [];
  let run = 0;
  for (const [i, shot] of shots.entries()) {
    const prev = i > 0 ? shots[i - 1] : null;
    let type = 'cut';
    let why = '开场，硬切进入';
    if (prev) {
      const sameScene = shot.scene === prev.scene;
      const sameSize = shot.shot_size === prev.shot_size;
      const castA = new Set(prev.cast || []);
      const overlap = (shot.cast || []).some((c) => castA.has(c));
      const bothEmpty = !(prev.cast || []).length && !(shot.cast || []).length;
      if (!sameScene) { why = `换场景（${prev.scene} → ${shot.scene}）`; }
      else if (!sameSize) { why = `换景别（${prev.shot_size} → ${shot.shot_size}），衔接会把景别锁死`; }
      else if (!overlap && !bothEmpty) { why = '出场人物没有交集，多半是切了视角'; }
      else if (run >= maxRun) { why = `已经连续 ${run} 个衔接，该给一个剪辑点了`; }
      else { type = 'last_frame_first'; why = `同场景同景别同人物，接得上（第 ${run + 1} 个）`; }
    }
    run = type === 'last_frame_first' ? run + 1 : 0;
    out.push({ shot_id: shot.id, type, why });
  }
  return out;
}

/** 把决策写回板子。 */
export function applyTransitions(board, opts = {}) {
  const plan = planTransitions(board, opts);
  const byId = new Map(plan.map((p) => [p.shot_id, p]));
  let changed = 0;
  for (const shot of board.shots || []) {
    const want = byId.get(shot.id);
    if (!want) continue;
    const cur = (shot.transition && shot.transition.type) || 'cut';
    if (cur !== want.type) changed++;
    shot.transition = { type: want.type, note: want.why };
  }
  return { plan, changed };
}

/**
 * 画幅判据 —— **拿产物去核对契约**。
 *
 * 来历：连续三层比例问题，全都是"没人核对产物"造成的：
 *
 *   ① `meta.aspect` 继承了 16:9，从没被当成一道题问过
 *   ② 线上通道的 `size` 没传，静默走了默认 `'16:9'`，再被裁成竖屏（扔掉 68% 像素）
 *   ③ H3 只能输出 32 的倍数，1080 不可达 → 实际 1088，而配置里做了两次缩放
 *
 * 三次都是**静默失败**：产出照旧，只是形状不对。而之所以一个都没被抓到，
 * 是因为整套检查（闸门 / validate / 成本账本 / 审阅图）都在回答
 * **"该不该继续"**，没有一条在回答 **"成品符不符合声明"**。
 * 更糟的是 `normalizeSize` 用 `force_original_aspect_ratio=increase,crop=` ——
 * 不匹配时不是报错，是**裁掉多余部分替它擦屁股**；审阅图又把所有图缩成同一尺寸，
 * **正好把比例差抹平**。
 *
 * @param {string} aspect 形如 '9:16' / '16:9' / '1:1'
 * @returns {number|null} 宽/高；解析不出来返回 null
 */
export function aspectRatioOf(aspect) {
  const m = String(aspect || '').match(/^\s*(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return (a > 0 && b > 0) ? a / b : null;
}

/**
 * 产物的实际宽高比是否匹配声明。
 *
 * **容差默认 2%** —— 这个数不是拍脑袋，是量出来的：
 *
 * | 来源 | 实际 | 比例 | 偏离 9:16 |
 * |---|---|---|---|
 * | 标准 | 1080×1920 | 0.5625 | 0.00% |
 * | H3 的 32 倍数对齐 | 1088×1920 | 0.5667 | **0.74%** |
 * | 线上 API 的 "9:16" | 1536×2688 | 0.5714 | **1.59%** |
 * | 线上 API 的 "16:9"（错的那个） | 2688×1536 | 1.7500 | **211%** |
 * | H3 节点默认（错的那个） | 864×480 | 1.8000 | **220%** |
 *
 * 所以 2% 能放过两个通道各自的取整约定，**同时把真正的比例错误（差两个数量级）拦死**。
 *
 * @returns {{ok:boolean, got:number, want:number, diff:number, why?:string}}
 */
export function aspectMatches(w, h, aspect, tol = 0.02) {
  const want = aspectRatioOf(aspect);
  if (!want) return { ok: false, got: 0, want: 0, diff: Infinity, why: `画幅 "${aspect}" 解析不出来` };
  if (!w || !h) return { ok: false, got: 0, want, diff: Infinity, why: '量不到尺寸' };
  const got = w / h;
  const diff = Math.abs(got - want) / want;
  return { ok: diff <= tol, got, want, diff, why: diff <= tol ? undefined : `实际 ${w}×${h}（比例 ${got.toFixed(4)}）≠ 声明 ${aspect}（${want.toFixed(4)}）` };
}

/** H3 的帧数必须落在 17k+5 网格上（这是引擎约束，不是我们挑的）。 */export function snapFrames(frames) {
  const k = Math.max(0, Math.round((frames - 5) / 17));
  return 17 * k + 5;
}

/** 秒 → 落在 17k+5 网格上的帧数。 */
export function framesFor(seconds) {
  return snapFrames(Math.max(1, Math.round(seconds * FPS)));
}

/**
 * 逐镜配音清单。一句台词一个片段 —— 一次合成多句会导致"哪句配哪镜"说不清。
 * OS（内心独白）单独标出来，配音时要换气口和语气。
 */
export function speechSegments(board) {
  const out = [];
  for (const shot of board.shots || []) {
    for (const [i, d] of (shot.dialogue || []).entries()) {
      const ident = (board.identities || []).find((x) => x.id === d.character);
      const ch = ident ? (board.characters || []).find((c) => c.id === ident.character) : null;
      const { voice, why } = ch ? resolveVoice(board, ch) : { voice: '', why: '角色不存在' };
      out.push({
        shot_id: shot.id,
        index: i,
        character: d.character,
        name: ch ? ch.name : d.character,
        text: d.text,                                   // ← 原文，一个字节都不动
        kind: d.kind || 'spoken',
        emotion: d.emotion || '',
        voice,
        voice_why: why,
      });
    }
  }
  return out;
}

/** 一个片段该多久：说完这句话 + 一口气的余量。 */
export function durationForSpeech(audioSeconds, opts = {}) {
  const pad = opts.pad ?? 0.6;          // 说话前后各留一点，别贴着脸切
  const min = opts.min ?? 1.5;
  const max = opts.max ?? 15;           // H3 单镜上限
  const s = Number(audioSeconds) || 0;
  return Math.min(max, Math.max(min, s + pad));
}

/**
 * 首尾帧计划。**方向：本镜的尾帧 = 下一镜的首帧。**
 *
 * 能这么做的前提是**全部首帧先生成完**（我们确实全出了）——
 * 于是它比链式传递容错得多：某一镜重抽不会连累后面。
 *
 * @returns {Array<{shot_id, mode, first, last, why}>}
 */
export function flfPlan(board) {
  const shots = board.shots || [];
  return shots.map((shot, i) => {
    const next = shots[i + 1];
    const chained = shot.transition && shot.transition.type === 'last_frame_first';
    const first = shot.first_frame || null;
    const last = shot.last_frame || (chained && next ? next.first_frame : null) || null;

    let mode = 'i2v';
    let why = '本镜自己的首帧起步';
    if (chained && first && last) {
      mode = 'fl2v';
      why = `首尾帧夹逼：从本镜首帧走到下一镜 ${next.id} 的首帧`;
    } else if (chained && first && !last) {
      why = `声明了衔接，但下一镜 ${next ? next.id : '（无）'} 还没有首帧 —— 退回单帧起步`;
    } else if (!first) {
      mode = 't2v';
      why = '本镜还没有首帧，只能文生视频';
    }
    return { shot_id: shot.id, mode, first, last, why };
  });
}

/** 把秒数格式化成 SRT 时间戳 `HH:MM:SS,mmm`。 */
export function srtTime(seconds) {
  const t = Math.max(0, seconds);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const ms = Math.round((t - Math.floor(t)) * 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(ms, 3)}`;
}

/**
 * 累计时间轴 + SRT。
 *
 * 时长来自 `durations`（通常是配音实测秒数）；没给的镜用镜头自己声明的 `duration_s`。
 * **整条时间线的总长 = 各镜时长之和** —— 这就是"成片时长 = 音频时长之和"的由来。
 */
export function buildTimeline(board, durations = {}, opts = {}) {
  const fps = opts.fps || FPS;
  let t = 0;
  const entries = [];
  for (const shot of board.shots || []) {
    const raw = durations[shot.id] ?? shot.duration_s ?? 3;
    // 落到帧网格上，免得累积出不存在的半帧
    const frames = framesFor(raw);
    const seconds = frames / fps;
    const start = t;
    t += seconds;

    for (const d of shot.dialogue || []) {
      const ident = (board.identities || []).find((x) => x.id === d.character);
      const ch = ident ? (board.characters || []).find((c) => c.id === ident.character) : null;
      entries.push({
        shot_id: shot.id,
        speaker: ch ? ch.name : d.character,
        text: d.text,
        kind: d.kind || 'spoken',
        start,
        end: t,
        seconds,
        frames,
      });
    }
    // 没有台词的镜头也要占时间轴，否则字幕会整体前移
    if (!(shot.dialogue || []).length) {
      entries.push({ shot_id: shot.id, speaker: '', text: '', kind: 'none', start, end: t, seconds, frames });
    }
  }
  return { total_seconds: t, total_frames: Math.round(t * fps), entries, srt: toSrt(entries) };
}

/** 只把有台词的条目写成 SRT —— 空条目写进去会变成一段莫名其妙的空字幕。 */
export function toSrt(entries) {
  return entries
    .filter((e) => e.kind !== 'none' && String(e.text || '').trim())
    .map((e, i) => {
      const label = e.kind === 'voiceover' ? `${e.speaker}（画外音）` : e.speaker;
      return `${i + 1}\n${srtTime(e.start)} --> ${srtTime(e.end)}\n${label}：${e.text}\n`;
    })
    .join('\n');
}
