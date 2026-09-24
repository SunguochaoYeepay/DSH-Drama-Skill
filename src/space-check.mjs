/**
 * 空间核查：把"这一镜的空间声明"和"画面上实际发生了什么"摆在一起，生成一张核查单。
 *
 * ## 为什么是"核查单"而不是"自动判定"
 *
 * 六轮实验的结论（lab/spatial/FINDINGS.md）：
 * - **能自动判的**：画面里有没有人、几个人（本地检测器在 32 张真实成片关键帧上 100% 可用）
 * - **不能自动判的**：两人是否相向、桌子是否在两人之间、朝向是否相交
 *   —— 我试过分割/骨架/多模态模型，**全都不灵**，而"自信的错答案"正是这个项目栽的那个跟头
 *     （拿"她左他右"这种表面特征当判据）。
 *
 * 所以这里只做三件事：**① 把声明摆出来 ② 把能自动判的判掉 ③ 把只能人眼判的列成待确认项。**
 * 绝不假装能判第③类。
 *
 * ## 声明放哪
 *
 * 旁挂 `space.json`，**不进 board.json / render.plan.json** —— 那两个是哈希绑定的票据产物，
 * 塞进去会让别人的旧确认失效。空间声明是"可选的、增量的"，就该长在票据之外。
 *
 * 形状：
 * ```json
 * {
 *   "scenes": { "s_restaurant": { "axis": { "name": "两人之间", "a": "她这侧", "b": "他那侧" },
 *                                "anchors": ["她席位", "他席位", "桌面中央"] } },
 *   "units": {
 *     "g001": {
 *       "camera_side": "A",
 *       "subjects": [
 *         { "id": "su_wan_dinner", "at": "她席位", "facing": "toward:gu_xing_dinner", "depth": "mid" },
 *         { "id": "gu_xing_dinner", "at": "他席位", "facing": "toward:su_wan_dinner", "depth": "mid" }
 *       ],
 *       "relations": ["隔桌相对，桌面在两人之间"],
 *       "human_review": "两人必须相向、且桌子中线在他们之间"
 *     }
 *   }
 * }
 * ```
 */

/** 机位侧：A / B / on-axis。只有这三个值。 */
const SIDES = new Set(['A', 'B', 'on-axis']);
/** 明确写出来的视线方向（越轴的真正症状在这里，不在机位侧）。 */
const EYELINES = new Set(['screen_left', 'screen_right']);

/**
 * 轴（越轴）检查。
 *
 * ## 一次更正（被真实案例打脸后改的）
 *
 * 原来这里把"相邻两镜机位侧从 A 翻到 B"一律当越轴 —— **错的**。
 * 过肩正反打（`从他的肩后拍她` / `从她的肩后拍他`）**本来就合法地跨两侧拍**：
 * 观众靠的是**视线方向的守恒**，不是机位侧的守恒。所以：
 *
 * - **机位侧翻转 → info**（只是提示"这里换边了，确认是有意的"）
 * - **同一主体在相邻两镜里视线方向翻转 → warn**（这才是越轴的症状）
 *
 * `intentional_cross: true` 对两者都生效（写明"我知道我在换边"就不吵）。
 *
 * @returns {Array<{level: string, unit: string, message: string}>}
 */
export function axisWarnings(units, space = {}) {
  const declared = space.units || {};
  const out = [];
  const list = units || [];

  const sameScene = (a, b) => !(a?.scene && b?.scene) || a.scene === b.scene;

  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1];
    const cur = list[i];
    if (!sameScene(prev, cur)) continue;
    const a = declared[prev.id] || {};
    const b = declared[cur.id] || {};
    const cross = b.intentional_cross === true || a.intentional_cross === true;

    // ① 机位侧翻转：合法（正反打），只提示
    if (SIDES.has(String(a.camera_side)) && SIDES.has(String(b.camera_side))) {
      const flipped = (a.camera_side === 'A' && b.camera_side === 'B') || (a.camera_side === 'B' && b.camera_side === 'A');
      if (flipped && !cross) {
        out.push({
          level: 'info',
          unit: cur.id,
          message: `机位换边：${prev.id} 在 ${a.camera_side} 侧 → ${cur.id} 在 ${b.camera_side} 侧。正反打这样拍是合法的，只需确认视线守恒（见下一条）。`,
        });
      }
    }

    // ② 视线方向翻转：这才是越轴的症状
    for (const sa of a.subjects || []) {
      if (!EYELINES.has(String(sa.facing))) continue;
      const sb = (b.subjects || []).find((x) => x.id === sa.id);
      if (!sb || !EYELINES.has(String(sb.facing))) continue;
      if (sa.facing === sb.facing) continue;
      if (cross) {
        out.push({ level: 'info', unit: cur.id, message: `刻意换轴：${sa.id} 的视线从 ${sa.facing} 翻到 ${sb.facing}（已声明 intentional_cross）` });
        continue;
      }
      out.push({
        level: 'warn',
        unit: cur.id,
        message: `可能越轴：${sa.id} 的视线在 ${prev.id} 是 ${sa.facing}、在 ${cur.id} 变成 ${sb.facing} —— 视线方向翻转会让观众失去方位感。若是有意的，写 intentional_cross: true。`,
      });
    }
  }
  return out;
}

/** 只声明了单向的关系（A 朝向 B，但 B 没朝向 A）时提醒一句 —— 这正是"各看各的"那种翻车。 */
export function facingWarnings(unit, space = {}) {
  const subjects = space.units?.[unit.id]?.subjects || [];
  const out = [];
  for (const s of subjects) {
    const m = /^toward:(.+)$/.exec(String(s.facing || ''));
    if (!m) continue;
    const otherId = m[1];
    const other = subjects.find((x) => x.id === otherId);
    if (!other) {
      out.push({ level: 'warn', unit: unit.id, message: `${s.id} 声明朝向 ${otherId}，但这一镜的主体里没有 ${otherId}` });
    } else if (String(other.facing || '') !== `toward:${s.id}`) {
      out.push({ level: 'warn', unit: unit.id, message: `${s.id} 朝向 ${otherId}，但 ${otherId} 的朝向是「${other.facing || '未声明'}」—— 单向朝向容易画成"各看各的"` });
    }
  }
  return out;
}

/** 把单元内**每个内部镜头**的视线方向摊平：`[{n, subject, dir, camera_side}]`。
 *  取 `observed`（人看着画面记下来的实际方向）优先于 `facing`（声明的意图）——
 *  因为这一层要判的是"画面里实际朝哪"，而不是"我们希望它朝哪"。 */
export function perShotGazes(unit, space = {}) {
  const decl = space.units?.[unit.id];
  if (!decl || !Array.isArray(decl.shots)) return [];
  const out = [];
  for (const shot of decl.shots) {
    for (const s of shot.subjects || []) {
      const dir = shot.observed?.[s.id] ?? s.facing;
      if (!EYELINES.has(String(dir))) continue;
      out.push({ n: shot.n, subject: s.id, dir: String(dir), camera_side: shot.camera_side ?? decl.camera_side ?? null });
    }
  }
  return out;
}

/**
 * 视线一致性：**人看方向，机器查一致性。**
 *
 * 两条纯逻辑规则（都不需要看画面）：
 *
 * 1. **同一镜内**两个对谈者都朝同一屏方向（都 screen_left 或都 screen_right）
 *    → 物理上意味着两人没在看对方 ✗
 * 2. **跨内部镜头**：两个人在**各自**的特写里，若两镜**机位在同一侧**，
 *    他们的视线方向应当**相反**；同向 → 告警 ✗
 *    （table_for_two 的 g003 就是栽在这条上：他的近景朝画面左、她的近景也朝画面左）
 *
 * ⚠ 为什么不让机器直接判方向：分割/骨架/多模态我都试过，全不灵，
 * 会给出"自信的错答案"。所以方向由人记录（`observed`），机器只做这里的推理。
 */
export function gazeConsistencyWarnings(unit, space = {}) {
  const gazes = perShotGazes(unit, space);
  const out = [];
  const dirWord = (d) => (d === 'screen_left' ? '画面左' : '画面右');

  // ① 同一镜内同向
  const byShot = new Map();
  for (const g of gazes) {
    if (!byShot.has(g.n)) byShot.set(g.n, []);
    byShot.get(g.n).push(g);
  }
  for (const [n, list] of byShot) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (list[i].dir !== list[j].dir) continue;
        out.push({
          level: 'warn',
          unit: unit.id,
          message: `镜 ${n} 内 ${list[i].subject} 与 ${list[j].subject} 都朝${dirWord(list[i].dir)} —— 对谈里两人应当朝相反方向，否则像在看同一班公交`,
        });
      }
    }
  }

  // ② 跨内部镜头、同机位侧、同向
  for (let i = 0; i < gazes.length; i++) {
    for (let j = i + 1; j < gazes.length; j++) {
      const a = gazes[i];
      const b = gazes[j];
      if (a.subject === b.subject) continue;      // 同一个人换镜：那是"视线是否守恒"的另一条规则
      if (a.n === b.n) continue;                  // 同一镜已在 ① 里判过
      if (a.camera_side !== b.camera_side) continue; // 跨轴的正反打：两侧机位，方向本可以相同
      if (a.dir !== b.dir) continue;
      out.push({
        level: 'warn',
        unit: unit.id,
        message: `镜 ${a.n} 的 ${a.subject} 与镜 ${b.n} 的 ${b.subject} 都朝${dirWord(a.dir)}，且两镜机位同在 ${a.camera_side ?? '同一'} 侧 —— 这意味着两人没有在看对方`,
      });
    }
  }
  return out;
}

/**
 * 单镜核查条目：声明 → 自动结论 → 待人工确认。
 *
 * @param {object} unit 计划单元
 * @param {object} space 旁挂声明
 * @param {{n_person: number|null, present: boolean|null}|null} probe 该镜主图的人检测结果
 */
export function unitChecklist(unit, space = {}, probe = null) {
  const decl = space.units?.[unit.id] || null;
  const declared = decl
    ? {
        camera_side: decl.camera_side ?? '未声明',
        subjects: (decl.subjects || []).map((s) => `${s.id}@${s.at || '?'}${s.facing ? `/${s.facing}` : ''}${s.depth ? `/${s.depth}` : ''}`),
        relations: decl.relations || [],
      }
    : null;

  const declaredCount = decl?.subjects?.length ?? null;
  const auto = {
    present: probe ? probe.present : null,
    detected: probe ? probe.n_person : null,
    expected: declaredCount,
    count_ok: probe && declaredCount != null ? probe.n_person === declaredCount : null,
  };

  const human = [];
  if (decl?.human_review) human.push(decl.human_review);
  const relations = decl?.relations || [];
  if (relations.length) human.push(...relations.map((r) => `核对：${r}`));
  for (const s of decl?.subjects || []) {
    if (String(s.facing || '').startsWith('toward:')) {
      human.push(`核对：${s.id} 的脸是否真的朝向 ${String(s.facing).slice(7)}`);
    }
  }
  if (decl?.subjects?.some((s) => s.depth)) {
    human.push('核对：前后层次（谁在前、谁被谁挡）是否与声明一致');
  }

  // 逐内部镜头：声明到什么程度，就核到什么程度（单元级声明管不了内部切镜的视线方向）
  const shots = (decl?.shots || []).map((s) => {
    const list = (s.subjects || []).map((x) => ({
      id: x.id,
      declared: x.facing ?? null,
      observed: s.observed?.[x.id] ?? null,
    }));
    if (list.length) {
      human.push(
        `镜 ${s.n}（机位 ${s.camera_side ?? decl.camera_side ?? '未声明'}）：核对 ` +
          list.map((x) => `${x.id} 是否朝「${x.declared || '未声明'}」${x.observed ? `（记录到的实际方向：${x.observed}）` : ''}`).join('；'),
      );
    }
    return { n: s.n, camera_side: s.camera_side ?? decl?.camera_side ?? null, subjects: list, note: s.note || null };
  });

  return { unit: unit.id, scene: unit.scene ?? null, declared, auto, human, shots };
}

/** 生成 markdown 核查单。 */
export function renderSpaceReport({ project, checklists, warnings }) {
  const L = [];
  L.push('# 空间核查单');
  L.push('');
  L.push(`项目：\`${project}\``);
  L.push('');
  L.push('> 自动只判两件：**画里有没有人**、**人数对不对**。');
  L.push('> 「两人是否相向 / 桌子是否在两人之间」这类**只能人眼判**——我试过分割、骨架、多模态模型，全都不灵，');
  L.push('> 而"自信的错答案"正是这个项目栽过的跟头。所以下面把它们列成**待确认**，不假装判过。');
  L.push('');
  if (warnings.length) {
    L.push('## 告警（纯逻辑，机器可信）');
    L.push('');
    for (const w of warnings) L.push(`- ${w.level === 'warn' ? '⚠' : 'ℹ'} **${w.unit}** ${w.message}`);
    L.push('');
  }
  L.push('## 逐镜');
  L.push('');
  for (const c of checklists) {
    L.push(`### ${c.unit}${c.scene ? `（场 ${c.scene}）` : ''}`);
    if (!c.declared) {
      L.push('');
      L.push('未在 `space.json` 里声明空间 —— 这一镜的空间关系**没有任何声明可供核对**。');
      L.push('');
      continue;
    }
    L.push('');
    L.push(`- 机位侧：**${c.declared.camera_side}**`);
    if (c.declared.subjects.length) L.push(`- 主体：${c.declared.subjects.join('；')}`);
    L.push(
      `- 自动：检出 ${c.auto.detected ?? '—'} 人` +
        (c.auto.expected != null ? `（声明 ${c.auto.expected} 人${c.auto.count_ok === true ? ' ✓' : c.auto.count_ok === false ? ' ✗ 不一致' : ''}）` : '') +
        (c.auto.present === false ? '　**画面里没人 ✗**' : ''),
    );
    if (c.shots?.length) {
      L.push(`- 逐内部镜头（${c.shots.length} 个）：`);
      for (const s of c.shots) {
        const who = s.subjects.map((x) => `${x.id}${x.declared ? `→${x.declared}` : ''}${x.observed ? `（实测 ${x.observed}）` : ''}`).join('；');
        L.push(`  - 镜 ${s.n}［机位 ${s.camera_side ?? '未声明'}］${who}${s.note ? `　${s.note}` : ''}`);
      }
    }
    if (c.human.length) {
      L.push('- 待人工确认：');
      for (const h of c.human) L.push(`  - [ ] ${h}`);
    }
    if (c.verified) {
      L.push(
        `- **已核对（${c.verified.by || '人'}）**：${c.verified.result === 'pass' ? '✅ 符合声明' : c.verified.result === 'fail' ? '❌ **与声明不符**' : '⚠ 存疑'}${c.verified.note ? ` —— ${c.verified.note}` : ''}`,
      );
    }
    L.push('');
  }
  return L.join('\n') + '\n';
}
