/**
 * DetailPanel.jsx — 右侧详情抽屉：点画布上的节点，这里给出该节点的全部实际产物。
 *
 * 覆盖旧页面（原生 HTML 版）的五个视图，功能一个不减：
 *   ① 剧本（全文 + 行号，可跳行）  ② 导演稿 / 生成计划
 *   ③ 资源画廊（肖像/身份图/场景/道具）  ④ 关键帧与视频片段  ⑤ 成片
 * 另有：票状态、角色名高亮、缩略图点开大图。
 * （「文件就位」四个勾 2026-09-23 按用户要求去掉：它把"文件在不在"摊在每个剧目头上，
 *   而看板真正要说的是"卡在哪道票上" —— 那件事由票徽标和卡点负责。）
 *
 * 只读 —— 没有任何写票入口。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { mediaUrl, isVideo, videoLog } from './api.js';
import { directorUnitOf, fmtSec } from './graph.js';
import { CopyBlock, CopyButton } from './Copy.jsx';

/** `asset-design.json` 的设计类型 → 中文名。 */
const KIND_LABEL = {
  scene_design: '场景图',
  character_design: '角色图',
  prop_design: '道具图',
};

/* ── 小组件 ─────────────────────────────────────────────── */

function Section({ title, right, children }) {
  return (
    <section className="mt-4 first:mt-0">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="shrink-0 text-[12px] font-medium text-ink-300">{title}</h3>
        <span className="text-[11px] text-ink-500">{right}</span>
      </div>
      {children}
    </section>
  );
}

function KV({ label, children }) {
  return (
    <div className="grid grid-cols-[92px_1fr] gap-2 py-1">
      <span className="text-[11.5px] text-ink-500">{label}</span>
      <span className="min-w-0 text-[12px] break-words">{children ?? '—'}</span>
    </div>
  );
}

/** 文本块。传了 `copy` 就在右上角挂一个复制按钮（复制的是**原文**，不是渲染后的 DOM）。 */
function Box({ children, className = '', copy }) {
  return (
    <div className="relative">
      {copy ? (
        <div className="absolute right-1.5 top-1.5 z-10">
          <CopyButton text={copy} />
        </div>
      ) : null}
      <div className={`rounded-lg border border-ink-700/70 bg-ink-900/60 px-3 py-2 text-[12px] leading-relaxed ${copy ? 'pr-14' : ''} ${className}`}>
        {children}
      </div>
    </div>
  );
}

/** 提示词区块：正文可复制，右上角标字数。 */
function PromptSection({ title, text, missing, right }) {
  return (
    <Section title={title} right={text ? `${text.length} 字` : (right || '未写')}>
      {text
        ? <CopyBlock text={text} />
        : <Box className="text-ink-500">{missing}</Box>}
    </Section>
  );
}

/* ── 名称 / 文本工具 ───────────────────────────────────── */

/** 身份 id 或角色 id → 中文名。 */
function nameOf(board, id) {
  const ch = (board.characters || []).find((c) => c.id === id);
  if (ch) return ch.name || ch.id;
  const ident = (board.identities || []).find((x) => x.id === id);
  if (ident) {
    const owner = (board.characters || []).find((c) => c.id === ident.character);
    const look = ident.name && ident.name !== '默认造型' ? `·${ident.name}` : '';
    return (owner?.name || ident.character || id) + look;
  }
  return id;
}

/** 把文本里的角色名/妆造名标出来（与旧页面 highlightNames 同规则）。 */
function highlightNames(board, text) {
  const s = String(text ?? '');
  if (!s) return '—';
  const names = new Set();
  for (const c of board.characters || []) if (c.name) names.add(c.name);
  for (const x of board.identities || []) if (x.name && x.name !== '默认造型') names.add(x.name);
  const list = [...names].sort((a, b) => b.length - a.length);
  if (!list.length) return s;
  const hit = new Set(list);
  let out = [s];
  for (const n of list) {
    const next = [];
    for (const piece of out) {
      if (typeof piece !== 'string') { next.push(piece); continue; }
      let rest = piece;
      let i;
      while ((i = rest.indexOf(n)) >= 0) {
        if (i > 0) next.push(rest.slice(0, i));
        next.push(<span key={`${n}-${next.length}`} className="rounded bg-accent/15 px-0.5 text-ink-100">{n}</span>);
        rest = rest.slice(i + n.length);
      }
      if (rest) next.push(rest);
    }
    out = next;
  }
  return out.length ? out : (hit.size ? s : s);
}

function Thumb({ project, rel, label, onOpen, big = false }) {
  const h = big ? 'h-[150px]' : 'h-[92px]';
  return (
    <button
      type="button"
      onClick={() => onOpen(rel, label)}
      className={`group w-full overflow-hidden rounded-lg border border-ink-700/70 bg-ink-900 text-left transition hover:border-accent/60 ${h}`}
      title={`${label} · ${rel}`}
    >
      {isVideo(rel) ? (
        <video src={`${mediaUrl(project, rel)}#t=0.1`} preload="metadata" muted playsInline {...videoLog('缩略图', rel)} className="h-full w-full object-cover" />
      ) : (
        <img src={mediaUrl(project, rel)} alt={label} loading="lazy" className="h-full w-full object-cover" />
      )}
    </button>
  );
}

/* ── ① 剧本 ─────────────────────────────────────────────── */

function StoryView({ snapshot, hitLines, jumpLine }) {
  const lines = String(snapshot.story || '').split(/\r?\n/);
  const refs = useRef({});
  useEffect(() => {
    if (jumpLine && refs.current[jumpLine]) {
      refs.current[jumpLine].scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [jumpLine]);
  return (
    <>
      <Section
        title="剧本全文"
        right={snapshot.story
          ? <span className="flex items-center gap-2">{lines.length} 行<CopyButton text={snapshot.story} label="复制全文" /></span>
          : ''}
      >
        {snapshot.story ? (
          <div className="max-h-[calc(100vh-260px)] overflow-auto rounded-lg border border-ink-700/70 bg-ink-900/60 px-3 py-2 text-[12px] leading-relaxed">
            {lines.map((t, i) => {
              const no = i + 1;
              return (
                <div
                  key={no}
                  ref={(el) => { refs.current[no] = el; }}
                  className={`story-line ${hitLines?.has(no) ? 'hit' : ''}`}
                >
                  <b>{no}</b>
                  <span className="whitespace-pre-wrap break-words">{t || '\u00a0'}</span>
                </div>
              );
            })}
          </div>
        ) : (
          <Box className="text-ink-500">没有读到剧本（story.md 缺失，板子里也没有 story.source）</Box>
        )}
      </Section>
    </>
  );
}

/* ── ③ 资源画廊 ─────────────────────────────────────────── */

function Gallery({ snapshot, project, onOpen }) {
  const items = (snapshot.assets || []).filter((a) => a.tab === 1 && a.path);
  if (!items.length) return <Box className="text-ink-500">这一页在本剧目里没有对应产物。</Box>;
  const groups = [...new Set(items.map((a) => a.group))];
  return (
    <div className="space-y-3">
      {groups.map((g) => (
        <div key={g}>
          <div className="mb-1.5 text-[11.5px] text-ink-500">{g}</div>
          <div className="grid grid-cols-3 gap-2">
            {items.filter((a) => a.group === g).map((a) => (
              <div key={a.key}>
                <Thumb project={project} rel={a.path} label={`${a.group} ${a.label}`} onOpen={onOpen} />
                <div className="mt-1 truncate text-[10.5px] text-ink-400" title={a.label}>{a.label}</div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── ② 导演稿 ──────────────────────────────────────────── */

function ShotCard({ shot, board, onJumpLine }) {
  const emotion = shot.emotion_analysis || [];
  return (
    <div className="rounded-lg border border-ink-700/70 bg-ink-900/50 p-2.5">
      <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2 text-[11.5px] text-ink-400">
        <span className="text-[12px] font-medium text-ink-100">镜 {shot.n ?? '—'}</span>
        <span>{Number(shot.at || 0).toFixed(2)}s</span>
        <span className="text-ink-600">→</span>
        <span>{Number(shot.duration_s || 0).toFixed(2)}s</span>
        {shot.framing && <span className="rounded bg-ink-800 px-1.5 py-px">{shot.framing}</span>}
        {shot.camera && <span className="rounded bg-ink-800 px-1.5 py-px">{shot.camera}</span>}
        {shot.cut && <span className="rounded bg-ink-800 px-1.5 py-px">{shot.cut}</span>}
      </div>
      <div className="text-[12px] leading-relaxed">{highlightNames(board, shot.action)}</div>
      {!!(shot.lines || []).length && (
        <div className="mt-1.5 space-y-0.5">
          {(shot.lines || []).map((ln) => (
            <div key={ln.n} className="text-[12px] text-ink-200">
              <button
                type="button"
                onClick={() => onJumpLine(ln.n)}
                className="mr-1 rounded bg-accent/15 px-1 py-px font-mono text-[10.5px] text-accent hover:bg-accent/25"
                title="跳到剧本该行"
              >
                L{ln.n}
              </button>
              {ln.text === null || ln.text === undefined
                ? <span className="text-bad">（剧本第 {ln.n} 行取不到）</span>
                : `「${ln.text}」`}
            </div>
          ))}
        </div>
      )}
      {!!emotion.length && (
        <div className="mt-1.5 space-y-0.5 border-t border-ink-800 pt-1.5">
          {emotion.map((e, i) => (
            <div key={i} className="text-[11.5px] text-ink-400">
              <span className="text-ink-300">{nameOf(board, e.character)}</span>
              {' · '}
              {[e.internal_state, e.visible_behavior, e.gaze].filter(Boolean).join(' · ') || '—'}
            </div>
          ))}
        </div>
      )}
      {shot.audio && <div className="mt-1.5 text-[11.5px] text-ink-500">音效：{shot.audio}</div>}
    </div>
  );
}

function DirectionView({ snapshot, board, jumpUnitId, onJumpLine }) {
  const dirUnits = snapshot.directionUnits || [];
  const [open, setOpen] = useState(jumpUnitId || null);
  useEffect(() => { setOpen(jumpUnitId || null); }, [jumpUnitId]);
  const current = dirUnits.find((u) => u.id === open) || dirUnits[0];
  if (!dirUnits.length) return <Box className="text-ink-500">没读到 board.direction.json</Box>;
  return (
    <>
      <Section title="单元" right={`${dirUnits.length} 个`}>
        <div className="flex flex-wrap gap-1.5">
          {dirUnits.map((u) => (
            <button
              key={u.id}
              type="button"
              onClick={() => setOpen(u.id)}
              className={[
                'rounded-md border px-2 py-0.5 text-[11.5px]',
                u.id === current.id ? 'border-warn/60 bg-warn/10 text-ink-100' : 'border-ink-700 text-ink-400 hover:text-ink-200',
              ].join(' ')}
            >
              {u.id}
            </button>
          ))}
        </div>
      </Section>
      <Section title={`单元 ${current.id}`} right={`${(current.shots || []).length} 镜`}>
        <KV label="首帧状态">{current.keyframe_start ? <Box className="max-h-40 overflow-auto" copy={current.keyframe_start}>{current.keyframe_start}</Box> : '—'}</KV>
        <KV label="为什么放一起"><Box copy={current.why}>{current.why || '—'}</Box></KV>
        <KV label="时长理由"><Box copy={current.duration_reason}>{current.duration_reason || '—'}</Box></KV>
        {current.audience_knows && <KV label="观众已知"><Box copy={current.audience_knows}>{current.audience_knows}</Box></KV>}
      </Section>
      <Section title="镜头">
        <div className="space-y-2">
          {(current.shots || []).map((s) => (
            <ShotCard key={s.n} shot={s} board={board} onJumpLine={onJumpLine} />
          ))}
        </div>
      </Section>
    </>
  );
}

/* ── 生成计划 ──────────────────────────────────────────── */

function PlanView({ snapshot, onPickUnit }) {
  const plan = snapshot.plan;
  const units = snapshot.units || [];
  if (!plan) return <Box className="text-ink-500">没读到 render.plan.json</Box>;
  const totals = plan.totals || {};
  const policy = plan.policy || {};
  return (
    <>
      <Section title="总计">
        <KV label="内容时长">{fmtSec(totals.content_duration_s)}</KV>
        <KV label="交付时长">{fmtSec(totals.projected_delivery_duration_s)}</KV>
        <KV label="关键帧数">{totals.keyframe_count ?? '—'}</KV>
      </Section>
      <Section title="切分策略">
        <KV label="目标时长">{policy.target_seconds != null ? `${policy.target_seconds}s` : '—'}</KV>
        <KV label="上限">{policy.max_seconds != null ? `${policy.max_seconds}s` : '—'}</KV>
        <KV label="最小时长">{policy.min_generation_seconds != null ? `${policy.min_generation_seconds}s` : '—'}</KV>
        <KV label="手工切分">{policy.manual_boundaries ? '是' : '否'}</KV>
        <KV label="按换人切分">{policy.split_on_cast_change ? '是' : '否'}</KV>
      </Section>
      <Section title="单元" right={`${units.length} 个`}>
        <div className="space-y-1">
          {units.map((u) => (
            <button
              key={u.id}
              type="button"
              onClick={() => onPickUnit(u.id)}
              className="grid w-full grid-cols-[64px_1fr_54px] items-baseline gap-2 rounded-md border border-ink-700/70 px-2 py-1 text-left text-[11.5px] hover:border-accent/50"
            >
              <span className="font-medium text-ink-100">{u.id}</span>
              <span className="truncate text-ink-400">{u.shotCount} 镜{u.scene ? ` · ${u.scene}` : ''}</span>
              <span className="text-right text-ink-300">{fmtSec(u.contentDuration)}</span>
            </button>
          ))}
        </div>
      </Section>
    </>
  );
}

/* ── ④ 单元（关键帧 + 片段） ───────────────────────────── */

/**
 * 一个单元「用到的资源」：场景主图 + 出场身份图 + 道具图，另附连续性单元的尾帧说明。
 *
 * 这是**按板子与计划推导出来的"这张图由哪些既有资产锚定"**，不是运行时实际挂载清单 ——
 * 实际挂载顺序由 `cli/keyframes.mjs` 在终端打印（本地通道：图1 场景 / 图2 身份 /
 * 交接单元把上一段尾帧排在最前）。呈现它的用途是：不满意那张图时，一眼看出该改提示词、
 * 还是该重出某个资产。
 */
function UnitResources({ snapshot, unit, board }) {
  const planUnit = (snapshot.plan?.units || []).find((u) => u.id === unit.id) || {};
  const scene = (board.scenes || []).find((s) => s.id === (unit.scene || planUnit.scene));
  const cast = unit.cast?.length ? unit.cast : (planUnit.cast || []);
  const idents = cast
    .map((id) => (board.identities || []).find((x) => x.id === id) || (board.characters || []).find((x) => x.id === id))
    .filter(Boolean);
  const props = (planUnit.props || [])
    .map((id) => (board.props || []).find((p) => p.id === id))
    .filter(Boolean);
  const handoff = planUnit.continuity && planUnit.continuity.mode !== 'independent';
  const rows = [
    scene && { key: `scene:${scene.id}`, kind: '场景', name: scene.name || scene.id, path: scene.master },
    ...idents.map((x) => ({ key: `id:${x.id}`, kind: '身份', name: x.name || x.id, path: x.sheet })),
    ...props.map((p) => ({ key: `prop:${p.id}`, kind: '道具', name: p.name || p.id, path: p.ref_image })),
  ].filter(Boolean);
  return (
    <Section title="用到的资源" right={`${rows.length} 项`}>
      {rows.length ? (
        <div className="space-y-1">
          {rows.map((r) => (
            <div key={r.key} className="flex items-center gap-2 rounded-md border border-ink-700/70 bg-ink-900/50 px-2 py-1">
              <span className="shrink-0 rounded bg-ink-800 px-1.5 py-px text-[10.5px] text-ink-300">{r.kind}</span>
              <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-200" title={r.name}>{r.name}</span>
              <span className="shrink-0 font-mono text-[10.5px] text-ink-500">{r.path || '未出图'}</span>
            </div>
          ))}
        </div>
      ) : <Box className="text-ink-500">没有推导出参考资产</Box>}
      {handoff ? (
        <div className="mt-2 rounded-md border border-warn/40 bg-warn/5 px-2 py-1 text-[11.5px] text-warn">
          连续性单元：首帧另参考上一段稳定尾帧 <span className="font-mono">handoffs/{unit.id}.stable-tail.png</span>
        </div>
      ) : null}
    </Section>
  );
}

function UnitView({ snapshot, project, board, unitId, onOpen, onJumpLine, focus = 'all' }) {
  const unit = (snapshot.units || []).find((u) => u.id === unitId);
  const dirUnit = directorUnitOf(snapshot, unitId);
  const [play, setPlay] = useState(false);
  useEffect(() => { setPlay(false); }, [unitId]);
  if (!unit) return <Box className="text-ink-500">找不到单元 {unitId}</Box>;
  const clips = snapshot.gates?.clips?.perUnit?.[unitId];
  return (
    <>
      <Section title="基本">
        <KV label="内容时长">{fmtSec(unit.contentDuration)}</KV>
        <KV label="生成时长">{fmtSec(unit.generationDuration)}</KV>
        <KV label="镜头数">{unit.shotCount ?? '—'}</KV>
        <KV label="场景">{(board.scenes || []).find((s) => s.id === unit.scene)?.name || unit.scene || '—'}</KV>
        <KV label="出场">{unit.cast?.length ? unit.cast.map((c) => nameOf(board, c)).join('、') : '—'}</KV>
        <KV label="导演单元">{dirUnit ? dirUnit.id : '—'}</KV>
        <KV label="票">
          <span className={snapshot.gates?.keyframes?.signed ? 'text-ok' : 'text-warn'}>
            关键帧{snapshot.gates?.keyframes?.signed ? '已签' : '待签'}
          </span>
          <span className="text-ink-600"> · </span>
          <span className={clips ? 'text-ok' : 'text-warn'}>片段{clips ? '已签' : '待签'}</span>
        </KV>
      </Section>
      {unit.audienceKnows && <Section title="观众已知"><Box copy={unit.audienceKnows}>{unit.audienceKnows}</Box></Section>}
      {unit.why && <Section title="切分理由"><Box copy={unit.why}>{unit.why}</Box></Section>}

      {(focus === 'all' || focus === 'keyframe') && (
        <>
          <Section title="关键帧">
            {unit.keyframe
              ? <Thumb project={project} rel={unit.keyframe} label={`${unitId} 关键帧`} onOpen={onOpen} big />
              : <Box className="text-bad">无关键帧</Box>}
          </Section>
          <UnitResources snapshot={snapshot} unit={unit} board={board} />
          <PromptSection
            title="关键帧提示词"
            text={unit.keyframePrompt}
            missing={`还没有 keyframe-prompts/${unitId}.txt（直写制：这个文件逐字送模型，改它就是改下一张图）`}
          />
        </>
      )}

      {(focus === 'all' || focus === 'clip') && (
        <>
          <Section title="视频片段" right={unit.clip ? '' : '未生成'}>
            {unit.clip ? (
              play ? (
                <video src={mediaUrl(project, unit.clip)} controls autoPlay playsInline {...videoLog('片段', unit.clip)} className="w-full rounded-lg bg-black" />
              ) : (
                <button type="button" onClick={() => setPlay(true)} className="block w-full">
                  <Thumb project={project} rel={unit.clip} label={`${unitId} 片段`} onOpen={onOpen} big />
                </button>
              )
            ) : (
              <Box className="text-ink-500">这个单元还没有视频片段</Box>
            )}
          </Section>
          <PromptSection
            title="视频提示词"
            text={unit.videoPrompt}
            missing={`还没有 units/.${unitId}.prompt.txt`}
          />
          {dirUnit && (
            <Section title="这一段的镜头" right={`${(dirUnit.shots || []).length} 镜 · 导演单元 ${dirUnit.id}`}>
              <div className="space-y-2">
                {(dirUnit.shots || []).map((s) => (
                  <ShotCard key={s.n} shot={s} board={board} onJumpLine={onJumpLine} />
                ))}
              </div>
            </Section>
          )}
        </>
      )}
    </>
  );
}

/* ── ⑤ 成片 ─────────────────────────────────────────────── */

function FinalView({ snapshot, project }) {
  if (!snapshot.finalRel) return <Box className="text-ink-500">还没有成片（约定路径：out/final.mp4）</Box>;
  return (
    <Section title="成片" right={snapshot.finalRel}>
      <video src={mediaUrl(project, snapshot.finalRel)} controls playsInline {...videoLog('成片', snapshot.finalRel)} className="w-full rounded-lg bg-black" />
    </Section>
  );
}

/* ── 主组件：**按"决策物"组织呈现** ─────────────────────────
 * 用户关注的是六件事：剧本 / 导演稿 / 资源 / 关键帧 / 视频 / 成片。
 * 「板子」与「生成计划」属于执行逻辑（编译产物、单元切分与时长钳制），
 * 折进底部的「执行细节」，不再占据主视线。
 * 画布上的节点点击依旧有效：它只负责把页签切到对应的那一件，并定位到具体单元。
 */

const TABS = [
  { key: 'story', label: '剧本' },
  { key: 'direction', label: '导演稿' },
  { key: 'assets', label: '资源' },
  { key: 'unit', label: '单元' },
  { key: 'final', label: '成片' },
  { key: 'detail', label: '执行细节' },
];

/** 画布节点 → 页签。资源节点承载"板子票 + 资源票"，所以它落到资源页；执行细节落到执行细节页。 */
function tabOfNode(node) {
  if (!node) return 'story';
  if (node === 'stage:assets' || node === 'stage:board') return 'assets';
  if (node === 'stage:direction') return 'direction';
  if (node === 'stage:detail' || node === 'stage:plan') return 'detail';
  if (node === 'final') return 'final';
  if (node.startsWith('unit:')) return 'unit';
  return 'story';
}

export default function DetailPanel({ snapshot, project, selected, width = 560, onOpen }) {
  const [view, setView] = useState(null);   // {kind:'story', line} —— 从镜头跳剧本时用
  const [tab, setTab] = useState(() => tabOfNode(selected));
  const [unitId, setUnitId] = useState(null);
  useEffect(() => { setView(null); }, [selected]);

  // 画布点节点 → 切页签 + 定位单元（点击优先于上一次的手动选择）
  useEffect(() => {
    if (!selected) return;
    setTab(tabOfNode(selected));
    if (selected.startsWith('unit:')) setUnitId(selected.slice(5));
  }, [selected]);

  const board = snapshot?.board || {};
  const units = snapshot?.units || [];
  const currentUnitId = unitId || units[0]?.id || null;
  const node = selected || 'stage:story';

  const hitLines = useMemo(() => {
    if (node.startsWith('unit:')) {
      const d = directorUnitOf(snapshot, node.slice(5));
      const set = new Set();
      for (const s of d?.shots || []) for (const ln of s.lines || []) set.add(ln.n);
      return set;
    }
    if (node === 'stage:direction') {
      const set = new Set();
      for (const u of snapshot?.directionUnits || []) for (const s of u.shots || []) for (const ln of s.lines || []) set.add(ln.n);
      return set;
    }
    return null;
  }, [node, snapshot]);

  const jumpLine = view?.line ?? null;

  const goStory = (line) => { setTab('story'); setView({ kind: 'story', line }); };

  // 页签上的小计数：一眼看出哪一件还没做完（不替代票徽标，只是导航提示）
  const assetCount = (snapshot?.assets || []).filter((a) => a.tab === 1).length;
  const kfDone = units.filter((u) => u.keyframe).length;
  const clipDone = units.filter((u) => u.clip).length;
  const tabHint = {
    assets: assetCount ? String(assetCount) : '—',
    // 单元页里关键帧与视频都在，所以这一个提示把两件事一起报（原来是两个页签各报一个）
    unit: units.length ? `帧 ${kfDone}/${units.length} · 片 ${clipDone}/${units.length}` : '—',
    final: snapshot?.finalRel ? '✓' : '—',
  };
  const title = TABS.find((t) => t.key === tab)?.label || tab;

  return (
    <aside style={{ width }} className="flex h-full shrink-0 flex-col border-l border-ink-800 bg-ink-900">
      <header className="flex items-center gap-2 px-4 pt-2.5">
        <h2 className="text-[13px] font-medium">{title}</h2>
        <span className="truncate text-[11px] text-ink-500" title={snapshot?.title}>{snapshot?.title || project}</span>
        {hitLines?.size ? <span className="shrink-0 text-[11px] text-ink-500">剧本 {hitLines.size} 行</span> : null}
        {view && (
          <button type="button" onClick={() => setView(null)} className="ml-auto shrink-0 rounded border border-ink-700 px-2 py-0.5 text-[11px] text-ink-300 hover:border-accent/60">
            返回剧本
          </button>
        )}
      </header>
      <div className="flex flex-wrap gap-1 border-b border-ink-800 px-3 pb-2 pt-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => { setTab(t.key); setView(null); }}
            className={[
              'inline-flex items-baseline gap-1 rounded-md border px-2 py-0.5 text-[11.5px] transition',
              tab === t.key ? 'border-accent/60 bg-accent/10 text-ink-100' : 'border-ink-700 text-ink-400 hover:text-ink-200',
              t.key === 'detail' ? 'ml-auto opacity-75' : '',
            ].join(' ')}
          >
            {t.label}
            {tabHint[t.key] ? <span className="text-[10px] text-ink-500">{tabHint[t.key]}</span> : null}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {view?.kind === 'story' || tab === 'story' ? (
          <StoryView snapshot={snapshot} hitLines={hitLines} jumpLine={jumpLine} />
        ) : tab === 'direction' ? (
          <DirectionView snapshot={snapshot} board={board} jumpUnitId={currentUnitId} onJumpLine={goStory} />
        ) : tab === 'assets' ? (
          <>
            <Section title="资源清单" right="板子里的决策物">
              <div className="space-y-1">
                {(board.characters || []).map((c) => (
                  <AssetRow key={`c:${c.id}`} kind="角色" name={c.name || c.id} id={c.id} path={c.portrait} />
                ))}
                {(board.identities || []).map((x) => (
                  <AssetRow key={`i:${x.id}`} kind="造型" name={x.name || x.id} id={x.id} path={x.sheet} />
                ))}
                {(board.scenes || []).map((s) => (
                  <AssetRow key={`s:${s.id}`} kind="场景" name={s.name || s.id} id={s.id} path={s.master} />
                ))}
                {(board.props || []).map((p) => (
                  <AssetRow key={`p:${p.id}`} kind="道具" name={p.name || p.id} id={p.id} path={p.ref_image} />
                ))}
              </div>
            </Section>
            <Section title="资源图" right={`${assetCount} 项`}>
              <Gallery snapshot={snapshot} project={project} onOpen={onOpen} />
            </Section>
            <Section title="生图提示词" right={`${(snapshot.assetPrompts || []).length} 条`}>
              {(snapshot.assetPrompts || []).length ? (
                <div className="space-y-2">
                  {(snapshot.assetPrompts || []).map((p, i) => (
                    <div key={`${p.kind}-${p.id}-${i}`}>
                      <div className="mb-1 flex items-baseline gap-2">
                        <span className="shrink-0 rounded bg-ink-800 px-1.5 py-px text-[10.5px] text-ink-300">
                          {KIND_LABEL[p.kind] || p.kind}
                        </span>
                        <span className="truncate text-[11.5px] text-ink-300" title={p.label}>{p.label}</span>
                      </div>
                      <CopyBlock text={p.text} />
                    </div>
                  ))}
                </div>
              ) : (
                <Box className="text-ink-500">没有 asset-design.json 的设计提示词（场景图 / 角色图）</Box>
              )}
            </Section>
          </>
        ) : tab === 'unit' ? (
          <>
            {units.length > 1 && (
              <div className="mb-3 flex flex-wrap gap-1">
                {units.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => setUnitId(u.id)}
                    className={[
                      'rounded-md border px-2 py-0.5 text-[11.5px]',
                      u.id === currentUnitId ? 'border-accent/60 bg-accent/10 text-ink-100' : 'border-ink-700 text-ink-400 hover:text-ink-200',
                    ].join(' ')}
                  >
                    {u.id}
                    <span className="ml-1 text-[10px] text-ink-500">{u.keyframe ? '帧✓' : '帧—'} {u.clip ? '片✓' : '片—'}</span>
                  </button>
                ))}
              </div>
            )}
            {currentUnitId ? (
              // focus='all'：单元页里关键帧与视频都在（用户 2026-09-23：不要拆成两个页签）
              <UnitView
                snapshot={snapshot}
                project={project}
                board={board}
                unitId={currentUnitId}
                onOpen={onOpen}
                onJumpLine={goStory}
                focus="all"
              />
            ) : <Box className="text-ink-500">这个剧目还没有生成计划（所以没有单元）</Box>}
          </>
        ) : tab === 'detail' ? (
          <>
            <Section title="板子 · 编译产物" right="执行细节，不是决策物">
              <KV label="片名">{snapshot.title}</KV>
              <KV label="一句话">{snapshot.logline || '—'}</KV>
              <KV label="画幅 / 风格">{[snapshot.aspect, snapshot.style].filter(Boolean).join(' · ') || '—'}</KV>
              <KV label="索引镜头">{`${(board.shots || []).length} 镜 · 共 ${fmtSec((board.shots || []).reduce((n, s) => n + (Number(s.duration_s) || 0), 0))}`}</KV>
            </Section>
            <Section title="板子编译出的索引镜头" right={`${(board.shots || []).length} 镜`}>
              <div className="space-y-2">
                {(board.shots || []).map((s) => (
                  <div key={s.id} className="rounded-lg border border-ink-700/70 bg-ink-900/50 p-2.5">
                    <div className="mb-1 flex flex-wrap items-baseline gap-x-2 text-[11.5px] text-ink-400">
                      <span className="text-[12px] font-medium text-ink-100">{s.id}</span>
                      <span>{fmtSec(s.duration_s)}</span>
                      {s.shot_size && <span className="rounded bg-ink-800 px-1.5 py-px">{s.shot_size}</span>}
                      {s.camera && <span className="rounded bg-ink-800 px-1.5 py-px">{s.camera}</span>}
                      {!!(s.source_lines || []).length && (
                        <span className="font-mono text-[10.5px] text-ink-500">
                          剧本 {(s.source_lines || []).map((n) => `L${n}`).join(',')}
                        </span>
                      )}
                    </div>
                    <div className="text-[12px] leading-relaxed">{highlightNames(board, s.action)}</div>
                    {!!(s.dialogue || []).length && (
                      <div className="mt-1 space-y-0.5">
                        {(s.dialogue || []).map((d, i) => (
                          <div key={i} className="text-[12px] text-ink-200">
                            <span className="text-ink-300">{nameOf(board, d.character)}</span>：{d.text}
                            {d.emotion && <span className="text-[11px] text-ink-500">（{d.emotion}）</span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </Section>
            <PlanView snapshot={snapshot} onPickUnit={(id) => { setTab('unit'); setUnitId(id); }} />
          </>
        ) : (
          <FinalView snapshot={snapshot} project={project} />
        )}
      </div>
    </aside>
  );
}

/**
 * 资源清单的一行：类型 + 名字 + id + 有没有出图。
 *
 * 这一节是**决策物**（用户在板子票上确认过的那份清单），与「资源图」「生图提示词」
 * 放在同一页，方便"看到不满意的图 → 找到它的提示词 → 手工改词重抽"这条动线。
 */
function AssetRow({ kind, name, id, path }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-ink-700/70 bg-ink-900/50 px-2 py-1 text-[11.5px]">
      <span className="shrink-0 rounded bg-ink-800 px-1.5 py-px text-[10.5px] text-ink-300">{kind}</span>
      <span className="min-w-0 flex-1 truncate text-ink-200" title={name}>{name}</span>
      <span className="shrink-0 font-mono text-[10.5px] text-ink-500">{id}</span>
      <span className={path ? 'shrink-0 text-ok' : 'shrink-0 text-warn'}>{path ? '已出图' : '未出图'}</span>
    </div>
  );
}
