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
 * （2026-09-23 唯一的例外是「重出图片」：它可以**产出新图**，但依旧不碰票 ——
 *   图变了那张关键帧票自然失效，要人重新签。）
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { mediaUrl, isVideo, videoLog } from './api.js';
import { directorUnitOf, fmtSec } from './graph.js';
import { CopyBlock, CopyButton } from './Copy.jsx';
import RegenModal from './RegenModal.jsx';

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

/**
 * 「重出」按钮：打开 RegenModal 那个工作台（改提示词 → 重出 → 看新产物 → 满意就签）。
 *
 * 弹窗自己负责提示词写入、任务轮询与签署；这里只是入口。关键帧与视频共用它，
 * 差别（CLI、提示词落点、票的口径）都在弹窗里按 `kind` 写明。
 * 看板里**没有任何写 review.approvals.json 的代码路径** —— 签是把用户明确的「通过」
 * 转交给唯一所有者 `cli/review-gate.mjs` 执行。
 */
function RegenButton({ onClick, label = '重出图片…', hint = '改提示词 → 重出 → 看新图 → 满意就签（只重抽当前这一格）' }) {
  return (
    <Section title="重出">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onClick}
          className="rounded-md border border-accent/60 bg-accent/10 px-2.5 py-1 text-[12px] text-ink-100 transition hover:bg-accent/20"
        >
          {label}
        </button>
        <span className="text-[11px] text-ink-500">{hint}</span>
      </div>
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

/**
 * 缩略图按钮：点击开灯箱。
 *
 * `big`（详情里那一张）**按原始比例铺，但只占四分之一宽**：不裁不拉伸，高度由比例和 `max-h` 兜住 ——
 * 竖图（9:16 关键帧）就该是竖的，不能截成一条横向通屏（用户 2026-09-23 明确要求）。
 * 它只是**缩略图**，而且高度很占版面：先占一半宽、再缩到四分之一（用户同日两次要求缩一半）。
 * 看大图/看视频去点灯箱。
 * 非 `big`（资源画廊的网格）保持等高裁切：网格要整齐，那儿的裁切是预期的。
 */
function Thumb({ project, rel, label, onOpen, big = false }) {
  const media = `block ${big ? 'max-h-[32vh] max-w-full' : 'h-full w-full object-cover'}`;
  return (
    <button
      type="button"
      onClick={() => onOpen(rel, label)}
      className={[
        'group overflow-hidden rounded-lg border border-ink-700/70 bg-ink-900 text-left transition hover:border-accent/60',
        big ? 'flex w-1/4 items-center justify-center' : 'h-[92px] w-full',
      ].join(' ')}
      title={`${label} · ${rel}（点击放大）`}
    >
      {isVideo(rel) ? (
        <video src={`${mediaUrl(project, rel)}#t=0.1`} preload="metadata" muted playsInline {...videoLog('缩略图', rel)} className={media} />
      ) : (
        <img src={mediaUrl(project, rel)} alt={label} loading="lazy" className={media} />
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
          {(shot.lines || []).map((ln) => {
            // 行号解不出正文 = 剧本里没有这一行（剧本改过、行号对不上）。
            // 这不是"程序取不到"，是**数据不一致的信号**，所以照实说清楚，并且不给能跳的假按钮。
            const resolved = ln.text !== null && ln.text !== undefined;
            return (
              <div key={ln.n} className="text-[12px] text-ink-200">
                {resolved ? (
                  <button
                    type="button"
                    onClick={() => onJumpLine(ln.n)}
                    className="mr-1 rounded bg-accent/15 px-1 py-px font-mono text-[10.5px] text-accent hover:bg-accent/25"
                    title="跳到剧本该行"
                  >
                    L{ln.n}
                  </button>
                ) : (
                  <span className="mr-1 rounded bg-warn/15 px-1 py-px font-mono text-[10.5px] text-warn">L{ln.n}</span>
                )}
                {resolved ? `「${ln.text}」` : (
                  <span
                    className="text-warn"
                    title={`导演稿引用了剧本第 ${ln.n} 行，但剧本里没有这一行 —— 剧本改过、行号对不上，把导演稿重出一遍即可。`}
                  >
                    （剧本里没有第 {ln.n} 行：剧本改过，行号对不上，重出导演稿即可）
                  </span>
                )}
              </div>
            );
          })}
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
        {/* 编号对齐：导演稿用 u1/u2…，计划与画布用 g001/g002… —— **两套编号**。
            这里以计划单元号（g00x）为主标签、把导演号挂在后面，看板与画布才对得上
            （用户 2026-09-23：「这里我对不上」就是这个）。*/}
        <div className="flex flex-wrap gap-1.5">
          {dirUnits.map((u) => {
            const planUnit = (snapshot.plan?.units || []).find((p) => (p.source_units || []).includes(u.id));
            return (
              <button
                key={u.id}
                type="button"
                onClick={() => setOpen(u.id)}
                title={planUnit ? `计划单元 ${planUnit.id} ← 导演单元 ${u.id}` : `导演单元 ${u.id}（计划里没有对应单元）`}
                className={[
                  'rounded-md border px-2 py-0.5 text-[11.5px]',
                  u.id === current.id ? 'border-warn/60 bg-warn/10 text-ink-100' : 'border-ink-700 text-ink-400 hover:text-ink-200',
                ].join(' ')}
              >
                {planUnit ? <span className="font-medium">{planUnit.id}</span> : u.id}
                <span className="ml-1 text-[10px] text-ink-500">{u.id}</span>
              </button>
            );
          })}
        </div>
      </Section>
      {/* 「为什么放一起 / 时长理由 / 观众已知」是导演的**过程说明**，不是给人审的产物 ——
          用户 2026-09-23 明确划掉。它们仍留在导演稿文件里（机器要用：切分理由、时长依据），
          只是不上这个页面。 */}
      <Section title="首帧状态">
        {current.keyframe_start
          ? <Box className="max-h-40 overflow-auto" copy={current.keyframe_start}>{current.keyframe_start}</Box>
          : <Box className="text-ink-500">—</Box>}
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

/* ── ④ 单元（关键帧 + 片段） ───────────────────────────── */

/**
 * 一行「参考媒体」：小图/小视频回显 + 类型 + 名称 + 路径；点击开灯箱（大图/大视频）。
 * 关键帧页的「用到的资源」和视频页的「本段视频用的参考」共用同一条呈现。
 */
function MediaRow({ project, kind, name, path, onOpen }) {
  const video = path ? isVideo(path) : false;
  return (
    <div className="flex items-center gap-2 rounded-md border border-ink-700/70 bg-ink-900/50 px-2 py-1">
      <button
        type="button"
        disabled={!path}
        onClick={() => path && onOpen && onOpen(path, `${kind} · ${name}`)}
        title={path ? `${path}（点击放大）` : '这一项还没出图'}
        className={[
          'h-10 w-10 shrink-0 overflow-hidden rounded border bg-ink-900',
          path ? 'border-ink-700 hover:border-accent/60' : 'border-dashed border-ink-700',
        ].join(' ')}
      >
        {!path ? (
          <span className="flex h-full w-full items-center justify-center text-[10px] text-ink-500">未出</span>
        ) : video ? (
          <video src={`${mediaUrl(project, path)}#t=0.1`} preload="metadata" muted playsInline className="h-full w-full object-cover" />
        ) : (
          <img src={mediaUrl(project, path)} alt={name} loading="lazy" className="h-full w-full object-cover" />
        )}
      </button>
      <span className="shrink-0 rounded bg-ink-800 px-1.5 py-px text-[10.5px] text-ink-300">{kind}</span>
      <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-200" title={name}>{name}</span>
      <span className="shrink-0 font-mono text-[10.5px] text-ink-500">{path || '未出图'}</span>
    </div>
  );
}

/**
 * 一个单元「用到的资源」：场景主图 + 出场身份图 + 道具图 + 连续性单元的稳定尾帧。
 *
 * 这是**按板子与计划推导出来的"这张图由哪些既有资产锚定"**，不是运行时实际挂载清单 ——
 * 实际挂载顺序由 `cli/keyframes.mjs` 在终端打印（本地通道：图1 场景 / 图2 身份 /
 * 交接单元把上一段尾帧排在最前）。呈现它的用途是：不满意那张图时，一眼看出该改提示词、
 * 还是该重出某个资产。
 */
function UnitResources({ snapshot, unit, board, onOpen }) {
  const planUnit = (snapshot.plan?.units || []).find((u) => u.id === unit.id) || {};
  const scene = (board.scenes || []).find((s) => s.id === (unit.scene || planUnit.scene));
  const cast = unit.cast?.length ? unit.cast : (planUnit.cast || []);
  const idents = cast
    .map((id) => (board.identities || []).find((x) => x.id === id) || (board.characters || []).find((x) => x.id === id))
    .filter(Boolean);
  const props = (planUnit.props || [])
    .map((id) => (board.props || []).find((p) => p.id === id))
    .filter(Boolean);
  const handoffMode = planUnit.continuity?.mode;
  const isHandoffUnit = ['reference_previous', 'continue_previous'].includes(handoffMode);
  const rows = [
    scene && { key: `scene:${scene.id}`, kind: '场景', name: scene.name || scene.id, path: scene.master },
    ...idents.map((x) => ({ key: `id:${x.id}`, kind: '身份', name: x.name || x.id, path: x.sheet })),
    ...props.map((p) => ({ key: `prop:${p.id}`, kind: '道具', name: p.name || p.id, path: p.ref_image })),
    // 实际稳定尾帧（只有真提出来了才有路径；数据层查过存在性）
    unit.handoffFrame && { key: `handoff:${unit.id}`, kind: '尾帧', name: '上一段实际稳定尾帧', path: unit.handoffFrame },
  ].filter(Boolean);
  return (
    <Section title="用到的资源" right={`${rows.length} 项`}>
      {rows.length ? (
        <div className="space-y-1">
          {rows.map((r) => (
            <MediaRow key={r.key} project={snapshot.name} kind={r.kind} name={r.name} path={r.path} onOpen={onOpen} />
          ))}
        </div>
      ) : <Box className="text-ink-500">没有推导出参考资产</Box>}
      {isHandoffUnit && !unit.handoffFrame ? (
        <div className="mt-2 rounded-md border border-warn/40 bg-warn/5 px-2 py-1 text-[11.5px] text-warn">
          连续性单元：首帧要参考上一段的实际稳定尾帧，但**还没提出来** ——
          跑 `node cli/prepare-handoff.mjs --plan render.plan.json --unit {unit.id}` 并确认后才有图。
        </div>
      ) : null}
    </Section>
  );
}

/**
 * 一段视频「用到的参考」：FastH3 的 i2v **只吃一张首帧**（就是这一单元的关键帧）——
 * 场景、身份、道具都已经锚在那一帧里，所以这里只列首帧，不重复列一遍资产
 * （列了会让人以为视频通道另吃了那几张图）。
 */
function ClipRefs({ snapshot, unit, onOpen }) {
  return (
    <Section title="本段视频用的参考" right={unit.keyframe ? '首帧 1 张' : '首帧未出'}>
      <MediaRow
        project={snapshot.name}
        kind="首帧"
        name={`${unit.id} 关键帧`}
        path={unit.keyframe}
        onOpen={onOpen}
      />
    </Section>
  );
}

/** 单元内部的分组页签（用户 2026-09-23：单元详情里按 tab 分组）。 */
const UNIT_TABS = [
  { key: 'info', label: '基本信息' },
  { key: 'keyframe', label: '关键帧' },
  { key: 'clip', label: '视频' },
];

function UnitView({ snapshot, project, board, unitId, onOpen, onJumpLine, onRefresh }) {
  const unit = (snapshot.units || []).find((u) => u.id === unitId);
  const dirUnit = directorUnitOf(snapshot, unitId);
  const [sub, setSub] = useState('info');
  // 视频页底部那层：提示词 / 镜头（默认提示词）
  const [clipTab, setClipTab] = useState('prompt');
  // 重出工作台弹窗：null 关着，'keyframe' / 'clip' 决定重出哪种产物
  const [regenKind, setRegenKind] = useState(null);
  if (!unit) return <Box className="text-ink-500">找不到单元 {unitId}</Box>;
  const clips = snapshot.gates?.clips?.perUnit?.[unitId];
  return (
    <>
      <div className="mb-3 flex flex-wrap gap-1 border-b border-ink-800 pb-2">
        {UNIT_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setSub(t.key)}
            className={[
              'inline-flex items-baseline gap-1 rounded-md border px-2 py-0.5 text-[11.5px] transition',
              sub === t.key ? 'border-accent/60 bg-accent/10 text-ink-100' : 'border-ink-700 text-ink-400 hover:text-ink-200',
            ].join(' ')}
          >
            {t.label}
            {t.key === 'keyframe' ? (
              <span className={unit.keyframe ? 'text-[10px] text-ok' : 'text-[10px] text-warn'}>{unit.keyframe ? '已出' : '未出'}</span>
            ) : null}
            {t.key === 'clip' ? (
              <span className={unit.clip ? 'text-[10px] text-ok' : 'text-[10px] text-warn'}>{unit.clip ? '已出' : '未出'}</span>
            ) : null}
          </button>
        ))}
      </div>
      {sub === 'info' && (
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
        </>
      )}

      {sub === 'keyframe' && (
        <>
          <Section title="关键帧">
            {unit.keyframe
              ? <Thumb project={project} rel={unit.keyframe} label={`${unitId} 关键帧`} onOpen={onOpen} big />
              : <Box className="text-bad">无关键帧</Box>}
          </Section>
          <UnitResources snapshot={snapshot} unit={unit} board={board} onOpen={onOpen} />
          <PromptSection
            title="关键帧提示词"
            text={unit.keyframePrompt}
            missing={`还没有 keyframe-prompts/${unitId}.txt（直写制：这个文件逐字送模型，改它就是改下一张图）`}
          />
          <RegenButton onClick={() => setRegenKind('keyframe')} />
        </>
      )}

      {sub === 'clip' && (
        <>
          <Section title="视频片段" right={unit.clip ? '点击在弹层里播放' : '未生成'}>
            {/* 详情里不内联播放（用户 2026-09-23）：点一下开**灯箱**，和参考图同一个弹层 */}
            {unit.clip ? (
              <Thumb project={project} rel={unit.clip} label={`${unitId} 片段`} onOpen={onOpen} big />
            ) : (
              <Box className="text-ink-500">这个单元还没有视频片段</Box>
            )}
          </Section>
          <ClipRefs snapshot={snapshot} unit={unit} onOpen={onOpen} />
          <RegenButton
            onClick={() => setRegenKind('clip')}
            label="重出这一段…"
            hint="改视频提示词 → 重出 → 看新片段 → 满意就签这一段的片段票（只重抽这一段）"
          />

          {/* 提示词与镜头描述分两个小页签，**默认提示词**（用户 2026-09-23）。
              一段视频的提示词常常上千字，和镜头卡片挤在一起要滚很久。 */}
          <div className="mb-3 flex gap-1 border-b border-ink-800 pb-2">
            {[
              { key: 'prompt', label: '视频提示词' },
              { key: 'shots', label: `这一段的镜头${dirUnit ? ` · ${(dirUnit.shots || []).length} 镜` : ''}` },
            ].map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setClipTab(t.key)}
                className={[
                  'rounded-md border px-2 py-0.5 text-[11.5px] transition',
                  clipTab === t.key ? 'border-accent/60 bg-accent/10 text-ink-100' : 'border-ink-700 text-ink-400 hover:text-ink-200',
                ].join(' ')}
              >
                {t.label}
              </button>
            ))}
          </div>

          {clipTab === 'prompt' ? (
            <PromptSection
              title="视频提示词"
              text={unit.videoPrompt}
              missing={`还没有 units/.${unitId}.prompt.txt`}
            />
          ) : dirUnit ? (
            <Section title="这一段的镜头" right={`${(dirUnit.shots || []).length} 镜 · 导演单元 ${dirUnit.id}`}>
              <div className="space-y-2">
                {(dirUnit.shots || []).map((s) => (
                  <ShotCard key={s.n} shot={s} board={board} onJumpLine={onJumpLine} />
                ))}
              </div>
            </Section>
          ) : <Box className="text-ink-500">没有对应到导演单元，读不到镜头描述</Box>}
        </>
      )}

      {/* 重出工作台：**挂在 UnitView 顶层**，关键帧页与视频页共用同一个弹窗
          （之前放在关键帧分支里，视频页点按钮只会设状态、弹窗不出现 —— 实测踩过）。 */}
      {regenKind ? (
        <RegenModal
          project={project}
          unit={unit}
          kind={regenKind}
          frameCount={(snapshot.units || []).filter((u) => u.keyframe).length || (snapshot.units || []).length}
          onClose={() => setRegenKind(null)}
          onRefresh={onRefresh}
          onOpen={onOpen}
        />
      ) : null}
    </>
  );
}

/* ── ⑤ 成片 ─────────────────────────────────────────────── */

/**
 * 成片页：看一眼 → 满意就签成片票。
 *
 * 与关键帧/片段同一套口径：看板**不写任何 approvals 文件**，点「签署」只是把用户明确的
 * 「通过」转交给唯一所有者 `cli/review-gate.mjs`（这里还会带上 `--artifacts out/final.mp4`，
 * 因为 review-gate 对 final 没有默认产物）。两步确认，避免误点。
 */
function FinalView({ snapshot, project, onOpen, onRefresh }) {
  const [confirmSign, setConfirmSign] = useState(false);
  const [signed, setSigned] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!snapshot.finalRel) return <Box className="text-ink-500">还没有成片（约定路径：out/final.mp4）</Box>;

  const sign = async () => {
    setBusy(true); setError('');
    try {
      const r = await signStage(project, 'final');
      setSigned({ at: new Date().toLocaleTimeString(), output: r.output });
      setConfirmSign(false);
      onRefresh?.();
    } catch (e) {
      setError(e.message || '签署失败');
    } finally {
      setBusy(false);
    }
  };

  const gate = snapshot.gates?.final;
  return (
    <>
      <Section title="成片" right="点击在弹层里播放">
        {/* 与片段一致：详情里不内联播放，点开灯箱看 */}
        <Thumb project={project} rel={snapshot.finalRel} label="成片" onOpen={onOpen} big />
      </Section>
      <Section title="成片票" right={gate?.signed ? '已签' : '未签'}>
        <div className="text-[11.5px] text-ink-400">
          {gate?.signed
            ? <>已人工确认{gate.by ? `（${gate.by}）` : ''}{gate.at ? ` · ${gate.at}` : ''}</>
            : '看过成片、觉得可以，就签这张票；签了它就是交付版本。'}
        </div>
        {error ? <Box className="mt-2 text-bad">{error}</Box> : null}
        {signed ? (
          <div className="mt-2 text-[11.5px] text-ok">✓ 已签署（{signed.at}）</div>
        ) : confirmSign ? (
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={sign}
              disabled={busy}
              className="rounded-md bg-warn px-2.5 py-1 text-[12px] font-medium text-ink-950 hover:brightness-110 disabled:opacity-50"
            >
              确认签署成片票
            </button>
            <button
              type="button"
              onClick={() => setConfirmSign(false)}
              className="rounded-md border border-ink-700 px-2 py-1 text-[12px] text-ink-300"
            >
              再想想
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmSign(true)}
            disabled={busy || Boolean(gate?.signed)}
            className="mt-2 rounded-md border border-ok/50 bg-ok/10 px-2.5 py-1 text-[12px] text-ok hover:bg-ok/20 disabled:opacity-40"
          >
            {gate?.signed ? '这张票已经签过了' : '看过成片，签成片票'}
          </button>
        )}
      </Section>
    </>
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
];

/**
 * 画布节点 → 页签。资源节点承载"板子票 + 资源票"，所以它落到资源页。
 * 老的深链 `stage:detail`（执行细节，2026-09-23 已撤）与 `stage:plan` 落到**单元页**：
 * 执行细节不再有页面，但老链接不该白屏。
 */
function tabOfNode(node) {
  if (!node) return 'story';
  if (node === 'stage:assets' || node === 'stage:board') return 'assets';
  if (node === 'stage:direction') return 'direction';
  if (node === 'stage:detail' || node === 'stage:plan') return 'unit';
  if (node === 'final') return 'final';
  if (node.startsWith('unit:')) return 'unit';
  return 'story';
}

export default function DetailPanel({ snapshot, project, selected, width = 560, onOpen, onRefresh }) {
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
              // 单元内部再分页签：基本信息 / 关键帧 / 视频（用户 2026-09-23）
              <UnitView
                snapshot={snapshot}
                project={project}
                board={board}
                unitId={currentUnitId}
                onOpen={onOpen}
                onJumpLine={goStory}
                onRefresh={onRefresh}
              />
            ) : <Box className="text-ink-500">这个剧目还没有生成计划（所以没有单元）</Box>}
          </>
        ) : (
          <FinalView snapshot={snapshot} project={project} onOpen={onOpen} onRefresh={onRefresh} />
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
