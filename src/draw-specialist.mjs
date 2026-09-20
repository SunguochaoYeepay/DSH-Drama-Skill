/**
 * 抽卡师：把导演的静态意图编译成生图模型更容易执行的语言。
 * 这是确定性执行层，不改剧情、台词或导演单元结构。
 *
 * ## 提示词的写法不是抽卡师的自由
 * 提交给生图模型的提示词受 `references/prompt-rules.md` 约束 —— 那是抽卡师的工作规范，
 * 不是参考资料。每次编译后必须过一遍 `auditPrompt()`，见本文件末尾。
 */

/**
 * 单条生图提示词的字数上限（中文字符数，见 references/prompt-rules.md 第五节）。
 * 350 是按"纯画面描述"定的理想值，实测 no_chute 契约措辞（光学/光的规格语言）压不进 350
 * 而画面质量并不受损（用户手工用整理版提示词出图合格，2026-09-20），放宽到 500。
 */
export const PROMPT_MAX_CHARS = 500;

// 元标签 / 组织架构：模型不需要知道"这段归谁管"，且「抽卡师」「造型师」这类词
// 在中文里能读作职业人物，有被画出来的风险。
const META_LABELS = [
  '【全片规则】', '【抽卡师', '【执行层', '【景别】', '【光】', '【镜头】', '【生成前最终检查】',
  '【人物造型师', '【参考图职责】', '【空间关系】', '【机位/构图】', '【画面截取范围】', '【禁止】',
  '抽卡师提示：', '抽卡师｜',
];

// 对模型的策略建议：模型单次采样，不会"依次尝试"。
const STRATEGY = [/依次尝试/u, /若[^。；]{0,14}则(?:可|应)/u, /优先[^。；]{0,12}其次/u, /不要为了/u];

// 空引用：引用了模型拿不到的文档。
const EMPTY_REF = [/按导演分镜/u, /与导演首帧/u, /同导演分镜/u];

// 解释性文字：在解释"为什么"，而不是说"是什么"。
const EXPLAIN = [/那就成了/u, /也就是说/u, /否则就成了/u];

// 单帧不可见的信息：运动方向、时序、前后状态。
const UNSEEN = [/恒向/u, /相对向[右左]流动/u, /尚未/u, /还没有移动/u, /此刻静止/u];

// 拼接疤痕。
const SCAR = [/。。/u, /，。/u, /\]\s*。/u];

// 正向里的否定句：否定句走负向通道，正向里念"不得出现 X"等于反复念 X。
// 白名单：禁文字与身份锚是实测有效的两条（删掉会冒字 / 脸走样），不算违规。
// 「不得让 X 一致」「不得漏掉一人」同样是否定句，只认「不得出现/不得有」会漏掉它们
// （no_chute 实测：`door_light` 那句尾巴、以及「不得漏掉任何一人」都躲过了旧正则）。
const NEGATION = [/不得(?:出现|有|让|漏|丢|超出|新增|改变)/u, /不要出现/u, /不许(?:出现|有)/u, /不应出现/u];
const NEGATION_ALLOW = [/文字|字幕|水印|logo|边框|拼图/u, /重设计脸部|参考图的角色身份/u];

/**
 * 编译后自检：提示词有没有违反 `references/prompt-rules.md`。
 *
 * 返回 `{ chars, violations }`，`violations` 每项 `{ rule, hit }`。
 * **只报告，不改写** —— 改动提示词语义是另一件事，这里先把违规摆到明面上，
 * 否则规则就只是"记在文档里"，而 `references/draw-specialist.md` 早就写过
 * 「记了却没拦住，这正是复发的定义」。
 */
export function auditPrompt(prompt) {
  const text = String(prompt || '');
  const violations = [];
  const add = (rule, hit) => violations.push({ rule, hit: String(hit).slice(0, 60) });
  const each = (re, rule) => { const m = text.match(re); if (m) add(rule, m[0]); };

  for (const label of META_LABELS) if (text.includes(label)) add('元标签/组织架构', label);
  STRATEGY.forEach((re) => each(re, '对模型的策略建议'));
  EMPTY_REF.forEach((re) => each(re, '空引用'));
  EXPLAIN.forEach((re) => each(re, '解释性文字'));
  UNSEEN.forEach((re) => each(re, '单帧不可见的信息'));
  SCAR.forEach((re) => each(re, '拼接疤痕'));

  for (const re of NEGATION) {
    for (const m of text.matchAll(new RegExp(`[^。；\\n]*${re.source}[^。；\\n]*`, 'gu'))) {
      const sentence = m[0];
      if (NEGATION_ALLOW.some((allow) => allow.test(sentence))) continue;
      add('正向里的否定句', sentence.trim().slice(0, 40));
    }
  }

  const chars = text.replace(/\s/g, '').length;
  if (chars > PROMPT_MAX_CHARS) add('超字数', `${chars} 字 > ${PROMPT_MAX_CHARS}`);
  return { chars, violations };
}

// ---------------------------------------------------------------- 最终整理

/**
 * **为什么自检之外还要有这一步**（2026-09-20 no_chute 的教训）：
 *
 * `auditPrompt()` 只报警。报警不接执行链等于没做 —— 那一轮自检每次尽职地列出 20 项违规，
 * 提示词然后原样送进 ComfyUI，连抽 8 张全废，最后靠人把 1445 字手写成 341 字才出对图。
 * 抽卡师是提示词的主人，**它交出去的必须是整理后的成品，不是"附一份体检报告的原件"**。
 *
 * ## 边界：只做确定性剥离
 *
 * 删得掉的必须是**固定模式**：元标签、模板句、重复块、单帧不可见的信息。
 * 语义层改写（「不得出现伞包」→「她背的是一只瘪小包」）机器判不出，
 * 靠契约/导演稿提供画面化措辞，本函数不猜。
 */

/** 整行丢弃：整体与画面无关，或已在别处说过一遍。 */
const DROP_LINES = [
  { id: '元标签段', re: /^【(?:全片规则|景别|空间关系|机位\/构图|人物造型师|执行层|禁止)】/u },
  // `【抽卡师｜执行层执行编译】` 里「｜」后面还有字，上面那条要求「】」紧跟在词后，匹配不到。
  { id: '元标签段', re: /^【抽卡师[^】]*】/u },
  { id: '正向排除项', re: /^【风格排除】/u },
  { id: '与【光】重复', re: /^光线[：:]/u },
];

/** 行首标签剥离：标签是我们的组织架构，正文才是画面。 */
const STRIP_PREFIX = [
  /^【镜头】/u, /^【光】/u, /^关键帧起始姿态：/u, /^【画面截取范围】/u,
  /^·\s*[A-Za-z_]+[：:]/u,   // 规则行的 `· door_light：` —— id 是给人和 override 用的
];

const matchesAny = (sentence, list) => list.some((re) => re.test(sentence));

/**
 * 两级删除噪声：先按句（。；）切，整句命中就丢；否则按子句（，）切，只丢命中的那一截。
 *
 * 两级都是必要的：
 * · 只按「，」切会丢不干净 ——「不得让人脸与门外天空亮度一致」是 `door_light` 的最后一截，
 *   整句丢会连"半剪影"一起丢；
 * · **只按「；」切会丢过头**（2026-09-20 实测）：「她背上是一只体积小的日常双肩包，肩带细、
 *   包身瘪。教练尚未转身…」——句号不是切分符时，这一整段算一句，命中「尚未」被整段删掉，
 *   **全片笑点"她背的是瘪小包"就这么没了**。所以句号必须是切分符。
 */
function dropNoisyClauses(line, dropped) {
  const kept = [];
  // 切分保留标点，所以每句自带结尾符 —— 拼回去用空串，再用一次 join('；') 会变出「；；」。
  for (const sentence of line.split(/(?<=[。；])/u).map((s) => s.trim()).filter(Boolean)) {
    if (/^[。；]+$/u.test(sentence)) continue;   // 拼接疤痕（原文里的「。。」）留下的空句
    if (matchesAny(sentence, STRATEGY) || matchesAny(sentence, EXPLAIN)
      || matchesAny(sentence, UNSEEN) || matchesAny(sentence, EMPTY_REF)) {
      dropped.push(`[噪声句] ${sentence.slice(0, 36)}`);
      continue;
    }
    const tail = /[。；]$/u.test(sentence) ? sentence.slice(-1) : '。';
    const parts = sentence.split(/，/u).map((x) => x.trim()).filter(Boolean).filter((part) => {
      if (matchesAny(part, NEGATION) && !matchesAny(part, NEGATION_ALLOW)) {
        dropped.push(`[否定子句] ${part.slice(0, 36)}`);
        return false;
      }
      return true;
    });
    if (!parts.length) continue;
    // 句尾那一截被删掉时标点也跟着没了 —— 补回原来的那个，否则两句会粘在一起。
    const joined = parts.join('，');
    kept.push(/[。；]$/u.test(joined) ? joined : joined + tail);
  }
  return kept.join('');
}

/**
 * 整理成送生图模型的那一版。
 *
 * `visualFraming` 用来替换掉那 152 字的景别硬边界块（解释性文字占一半），
 * 由调用方按景别给一句画面陈述。删掉的每一条都进 `dropped` —— 删了什么必须可审计。
 */
export function refinePrompt(prompt, { visualFraming = null } = {}) {
  const dropped = [];
  const out = [];

  for (const rawLine of String(prompt || '').split('\n')) {
    let line = rawLine.trim();
    if (!line) continue;

    const drop = DROP_LINES.find((rule) => rule.re.test(line));
    if (drop) { dropped.push(`[${drop.id}] ${line.slice(0, 36)}`); continue; }

    if (/^构图要求：/u.test(line)) {
      dropped.push(`[景别硬边界块 ${line.length} 字] ${line.slice(0, 24)}…`);
      if (visualFraming) out.push(visualFraming);
      continue;
    }

    for (const re of STRIP_PREFIX) line = line.replace(re, '').trim();
    line = dropNoisyClauses(line, dropped);
    if (!line) continue;
    out.push(line);
  }

  const seen = new Set();
  const unique = out.filter((line) => {
    if (seen.has(line)) { dropped.push(`[重复行] ${line.slice(0, 30)}`); return false; }
    seen.add(line);
    return true;
  });

  const text = unique
    .map((line) => line.replace(/；+$/u, '。'))   // 句尾那一截被删后会剩下悬空分号
    .map((line) => (/[。！？；]$/u.test(line) ? line : `${line}。`))
    .join('\n')
    .replace(/。。+/gu, '。')
    .replace(/。；/gu, '。')     // 句已完结又跟一个分号
    .replace(/；；+/gu, '；')
    .trim();
  return { text, dropped };
}
export function compileDrawPlan({ unit, shot, override = '' }) {
  const source = String(unit.keyframe_start || shot.action || '').trim()
    .replace(/^0\s*秒(?:时|时刻)?[：:，,\s]*/u, '');
  const conflicts = [];
  // 卧/趴判定拆成两条触发器，**不能共用一个正则**：
  // · onSurface（宽）——任何卧/趴/躺姿都要"重心落在承托表面"的空间几何约束，
  //   否则模型会把趴姿画成漂浮（fat_cat 2026-09-20：猫趴遮阳棚两度飘成飞天/悬空）；
  // · bed（窄，只认寝具语境）——"禁鞋禁站立"规则是卧室戏的教训，只有床/枕头/
  //   被褥/睡眠才触发。带裸「趴」字的宽正则会把趴在棚顶/桌上的镜头误判成床上躺卧，
  //   把卧室规则注入关键帧，与继承姿态打架。
  const onSurface = /躺|卧|仰面|侧躺|趴/u.test(`${source} ${override}`);
  if (onSurface && ['近景', '特写'].includes(shot.framing)) {
    conflicts.push('当前景别难以证明人物与床的完整空间关系；应改用中景或斜侧中景，除非只需表现脸部状态');
  }
  // ⚠ 这里**不再重复**「关键帧起始姿态」—— buildPrompt / buildLocalPrompt 已经说过一遍。
  // 2026-09-20 no_chute 对照实验：关键帧提示词 1300 字里景别说 3 遍、姿态说 2 遍，
  // 重复块占 40%，五连抽全废；同样的参考图与参数，130 字四句一发命中。
  // 本函数只输出它独有的增量（空间几何 / 冲突提示）。
  //
  // ⚠ 覆盖文本**不要在这里再拼一遍**（2026-09-20 no_chute 干跑实测）：
  // `executionShotSpec()` 已把 override 放进【画面截取范围】，这里再拼一次就是同一段话出现两次，
  // 正好是上面那条注释要治的病。抽卡师不复述上游 —— 需要 override 参与判定时（如 onSurface）
  // 直接读它，不要输出它。
  const prompt = [
    onSurface ? '空间几何：人物重心必须落在承托表面上；身体朝向、四肢位置和承托物的长宽方向必须一致，禁止悬空、横置或斜向穿过空间。' : '',
    conflicts.length ? `抽卡师提示：${conflicts.join('；')}` : '',
  ].filter(Boolean).join('\n');
  return { source, conflicts, prompt };
}

export function compileCharacterDesign({ designs = [], unit, shot }) {
  const ids = new Set(unit.keyframe_cast || unit.cast || shot.on_screen || []);
  const relevant = designs.filter((item) => item.kind === 'character_design' && ids.has(item.identity_id));
  const keep = relevant.flatMap((item) => [item.locked?.face, item.locked?.appearance].filter(Boolean));
  const bed = /躺|床|枕头|被褥|睡眠|刚醒|睡醒/u.test(`${shot.action || ''} ${unit.keyframe_start || ''}`);
  const exclude = bed
    ? ['当前镜头不应出现鞋子、拖鞋或站立姿态；不要把身份图中的鞋履和站立姿势复制到床上躺卧镜头。']
    : [];
  return { keep, exclude, prompt: [
    keep.length ? `【人物造型师锁定】${keep.join('；')}` : '',
    exclude.length ? `【人物造型师当前镜头排除】${exclude.join('；')}` : '',
  ].filter(Boolean).join('\n') };
}
