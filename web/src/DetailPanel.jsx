/**
 * DetailPanel.jsx — 右侧详情抽屉：点画布上的节点，这里给出该节点的全部实际产物。
 *
 * 覆盖旧页面（原生 HTML 版）的五个视图，功能一个不减：
 *   ① 剧本（全文 + 行号，可跳行）  ② 导演稿 / 生成计划
 *   ③ 资源画廊（肖像/身份图/场景/道具）  ④ 关键帧与视频片段  ⑤ 成片
 * 另有：文件就位、票状态、角色名高亮、缩略图点开大图。
 *
 * 只读 —— 没有任何写票入口。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { mediaUrl, isVideo } from './api.js';
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
  const files = snapshot.files || {};
  return (
    <>
      <Section title="文件就位">
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-ink-400">
          {Object.entries(files).map(([f, ok]) => (
            <span key={f} className={ok ? '' : 'text-bad'}>
              {f} {ok ? '✓' : '—'}
            </span>
          ))}
        </div>
      </Section>
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

function UnitView({ snapshot, project, board, unitId, onOpen, onJumpLine }) {
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
        <KV label="场景">{unit.scene ? nameOf(board, unit.scene) : '—'}</KV>
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
      <Section title="关键帧">
        {unit.keyframe
          ? <Thumb project={project} rel={unit.keyframe} label={`${unitId} 关键帧`} onOpen={onOpen} big />
          : <Box className="text-bad">无关键帧</Box>}
      </Section>
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
        title="关键帧提示词"
        text={unit.keyframePrompt}
        missing={`还没有 keyframe-prompts/${unitId}.txt（LLM 直写制：这个文件逐字送模型）`}
      />
      <PromptSection
        title="视频提示词"
        text={unit.videoPrompt}
        missing={`还没有 units/.${unitId}.prompt.txt`}
      />
      {unit.audienceKnows && <Section title="观众已知"><Box copy={unit.audienceKnows}>{unit.audienceKnows}</Box></Section>}
      {unit.why && <Section title="切分理由"><Box copy={unit.why}>{unit.why}</Box></Section>}
      {dirUnit && (
        <Section title={`镜头（导演单元 ${dirUnit.id}）`} right={`${(dirUnit.shots || []).length} 镜`}>
          <div className="space-y-2">
            {(dirUnit.shots || []).map((s) => (
              <ShotCard key={s.n} shot={s} board={board} onJumpLine={onJumpLine} />
            ))}
          </div>
        </Section>
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

/* ── 主组件 ─────────────────────────────────────────────── */

export default function DetailPanel({ snapshot, project, selected, width = 560, onOpen }) {
  const [view, setView] = useState(null);   // {kind:'story', line} —— 从镜头跳剧本时用
  useEffect(() => { setView(null); }, [selected]);

  const board = snapshot?.board || {};
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
  const jumpUnitId = node.startsWith('unit:') ? node.slice(5) : null;

  const goStory = (line) => setView({ kind: 'story', line });

  const title = node === 'final' ? '成片'
    : node.startsWith('unit:') ? `单元 ${node.slice(5)}`
    : { 'stage:story': '剧本', 'stage:board': '板子', 'stage:direction': '导演稿', 'stage:plan': '生成计划' }[node] || node;

  return (
    <aside style={{ width }} className="flex h-full shrink-0 flex-col border-l border-ink-800 bg-ink-900">
      <header className="flex items-center gap-2 border-b border-ink-800 px-4 py-2.5">
        <h2 className="text-[13px] font-medium">{title}</h2>
        {hitLines?.size ? <span className="text-[11px] text-ink-500">涉及剧本 {hitLines.size} 行</span> : null}
        {view && (
          <button type="button" onClick={() => setView(null)} className="ml-auto rounded border border-ink-700 px-2 py-0.5 text-[11px] text-ink-300 hover:border-accent/60">
            返回
          </button>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {view?.kind === 'story' || node === 'stage:story' ? (
          <StoryView snapshot={snapshot} hitLines={hitLines} jumpLine={jumpLine} />
        ) : node === 'stage:board' ? (
          <>
            <Section title="板子">
              <KV label="片名">{snapshot.title}</KV>
              <KV label="一句话">{snapshot.logline || '—'}</KV>
              <KV label="画幅 / 风格">{[snapshot.aspect, snapshot.style].filter(Boolean).join(' · ') || '—'}</KV>
              <KV label="镜头">{`${(board.shots || []).length} 镜 · 共 ${fmtSec((board.shots || []).reduce((n, s) => n + (Number(s.duration_s) || 0), 0))}`}</KV>
            </Section>
            <Section title="资源" right={`${(snapshot.assets || []).filter((a) => a.tab === 1).length} 项`}>
              <Gallery snapshot={snapshot} project={project} onOpen={onOpen} />
            </Section>
            <Section title="图提示词" right={`${(snapshot.assetPrompts || []).length} 条`}>
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
            <Section title="分镜" right={`${(board.shots || []).length} 镜`}>
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
          </>
        ) : node === 'stage:direction' ? (
          <DirectionView snapshot={snapshot} board={board} jumpUnitId={null} onJumpLine={goStory} />
        ) : node === 'stage:plan' ? (
          <>
            <PlanView snapshot={snapshot} onPickUnit={(id) => onOpen(`unit:${id}`)} />
          </>
        ) : node.startsWith('unit:') ? (
          <UnitView snapshot={snapshot} project={project} board={board} unitId={node.slice(5)} onOpen={onOpen} onJumpLine={goStory} />
        ) : (
          <FinalView snapshot={snapshot} project={project} />
        )}
      </div>
    </aside>
  );
}
