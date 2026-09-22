/**
 * App.jsx — 看板主界面。
 *
 * 布局：顶栏（剧目 + 票状态 + 卡点提示）／左侧剧目列表／中间链路画布／右侧详情抽屉。
 * 画布由 `graph.js` 算出的节点与边驱动，点节点即换右侧内容。
 * 大图查看器（点缩略图全屏看）保留自旧页面。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ReactFlow, Background, BackgroundVariant, Controls, MiniMap, MarkerType, ReactFlowProvider, useEdgesState, useNodesState, useReactFlow } from '@xyflow/react';
import { RefreshCw, CircleAlert, Archive, Trash2, ChevronRight, RotateCcw } from 'lucide-react';
import {
  fetchProjects, fetchProject, fetchArchived, mediaUrl, isVideo,
  archiveProject, restoreProject, deleteProject,
} from './api.js';
import { buildGraph, GATE_LABELS } from './graph.js';
import { nodeTypes } from './nodes.jsx';
import DetailPanel from './DetailPanel.jsx';
import ConfirmModal from './ConfirmModal.jsx';

/** 顶栏票序（clips 单独按单元计数，不走这里）。 */
const HEAD_GATES = ['story', 'board', 'direction', 'assets', 'keyframes', 'final'];

/* ── 画布 ───────────────────────────────────────────────── */

function CanvasView({ nodes, edges, selectedId, onSelect }) {
  const { fitView } = useReactFlow();
  const [ns, setNs, onNodesChange] = useNodesState([]);
  const [es, setEs, onEdgesChange] = useEdgesState([]);

  useEffect(() => {
    setNs(nodes);
    setEs(edges);
  }, [nodes, edges, setNs, setEs]);

  useEffect(() => {
    const t = setTimeout(() => fitView({ padding: 0.16, duration: 400 }), 80);
    return () => clearTimeout(t);
  }, [nodes, fitView]);

  return (
    <ReactFlow
      nodes={ns}
      edges={es}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={(_, n) => onSelect(n.id)}
      onPaneClick={() => onSelect(null)}
      fitView
      minZoom={0.2}
      maxZoom={1.8}
      proOptions={{ hideAttribution: true }}
      defaultEdgeOptions={{ type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: 'var(--color-ink-600)' } }}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#242b32" />
      <Controls showInteractive={false} position="bottom-left" />
      <MiniMap pannable zoomable position="bottom-right" nodeColor={(n) => (n.data?.pending ? '#d99a2b' : '#3d4750')} maskColor="rgba(0,0,0,.55)" />
    </ReactFlow>
  );
}

/* ── 大图查看器 ─────────────────────────────────────────── */

function Lightbox({ project, rel, label, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  if (!rel) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex cursor-zoom-out flex-col items-center justify-center gap-3 bg-black/85 p-6"
      onClick={onClose}
    >
      {isVideo(rel)
        ? <video src={mediaUrl(project, rel)} controls autoPlay playsInline className="max-h-[82vh] max-w-[92vw] rounded-lg bg-black" />
        : <img src={mediaUrl(project, rel)} alt={label} className="max-h-[82vh] max-w-[92vw] rounded-lg" />}
      <div className="text-[12px] text-ink-400">{label} · {rel}</div>
    </div>
  );
}

/* ── 主组件 ─────────────────────────────────────────────── */

export default function App() {
  const [projects, setProjects] = useState([]);
  const [archived, setArchived] = useState([]);
  const [retentionDays, setRetentionDays] = useState(7);
  const [showArchived, setShowArchived] = useState(false);
  const [name, setName] = useState('');
  const [snapshot, setSnapshot] = useState(null);
  const [selected, setSelected] = useState(null);
  const [lightbox, setLightbox] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // 管理动作（归档 / 恢复 / 删除）—— 它们不是闸门动作，柜门票仍然只读
  const [pending, setPending] = useState(null);   // {kind:'archive'|'delete', name, title, archived?}
  const [acting, setActing] = useState(false);
  const [actError, setActError] = useState('');
  const [notice, setNotice] = useState('');

  /** 拉主线清单 + 归档清单；返回主线清单（调用方要拿它判断当前剧目还在不在）。 */
  const loadList = useCallback(async () => {
    try {
      const [list, arch] = await Promise.all([fetchProjects(), fetchArchived()]);
      setProjects(list);
      setArchived(arch.archived);
      setRetentionDays(arch.retentionDays);
      setError('');
      return list;
    } catch (e) {
      setError(e.message);
      return null;
    }
  }, []);

  useEffect(() => { loadList(); }, [loadList]);

  // 提示条自散（4 秒）
  useEffect(() => {
    if (!notice) return undefined;
    const t = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  const load = useCallback(async (n) => {
    setName(n);
    setSelected(null);
    const q = new URLSearchParams(window.location.search);
    if (n) q.set('p', n); else q.delete('p');
    window.history.replaceState(null, '', q.toString() ? `/?${q}` : '/');
    setBusy(true);
    try {
      const snap = await fetchProject(n);
      setSnapshot(snap);
      setError('');
    } catch (e) {
      setSnapshot(null);
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }, []);

  // 深链：`?p=<剧目名>` 打开某剧目；`?node=unit:g003` 直接选中某节点
  // （刷新、分享都落在同一个画面上）。只认首次挂载的 URL —— 之后由 load() 维护 p。
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const want = q.get('p');
    const node = q.get('node');
    if (want) {
      load(want);
      if (node) setSelected(node);
    }
  }, [load]);

  const graph = useMemo(() => {
    if (!snapshot) return { nodes: [], edges: [], info: {} };
    const g = buildGraph(snapshot);
    return {
      ...g,
      nodes: g.nodes.map((n) => ({
        ...n,
        selected: n.id === selected,
        data: { ...n.data, project: snapshot.name, focusKey: g.info.frontier },
      })),
    };
  }, [snapshot, selected]);

  /**
   * 执行管理动作：成功后刷新两份清单；若当前打开的剧目已不在主线（被归档或被删），
   * 顺手把画布清掉 —— 别留一个指向不存在剧目的画面。
   */
  const runAction = useCallback(async (fn, okText) => {
    setActing(true);
    setActError('');
    try {
      await fn();
      const list = await loadList();
      if (name && !(list || []).some((p) => p.name === name)) {
        setName('');
        setSnapshot(null);
        setSelected(null);
        window.history.replaceState(null, '', '/');
      }
      setPending(null);
      setNotice(okText);
    } catch (e) {
      setActError(e.message);        // 就地显示在弹窗里，让人能改了确认名再试
    } finally {
      setActing(false);
    }
  }, [loadList, name]);

  const confirmAction = useCallback((typed) => {
    if (!pending) return;
    const { kind, name: n, title, archived: isArchived } = pending;
    if (kind === 'archive') {
      runAction(() => archiveProject(n), `《${title}》已归档，在左侧「已归档」里可以恢复`);
    } else if (kind === 'delete') {
      // 确认名由人**逐字手打**；服务端还会再校验一次
      runAction(() => deleteProject(n, typed, Boolean(isArchived)), `《${title}》已移入系统回收站`);
    }
  }, [pending, runAction]);

  const openMedia = useCallback((rel, label) => setLightbox({ rel, label }), []);

  const meta = snapshot ? [
    `${(snapshot.board?.shots || []).length} 镜`,
    `${(snapshot.units || []).length} 单元`,
    snapshot.aspect, snapshot.style,
  ].filter(Boolean).join(' · ') : '';

  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 border-b border-ink-800 bg-ink-900">
        <div className="flex items-center gap-3 px-4 py-2.5">
          <select
            value={name}
            onChange={(e) => (e.target.value ? load(e.target.value) : (setName(''), setSnapshot(null)))}
            className="rounded-md border border-ink-700 bg-ink-850 px-2 py-1 text-[12.5px] text-ink-100 outline-none focus:border-accent"
            title="选择剧目"
          >
            <option value="">（选择剧目）</option>
            {projects.map((p) => (
              <option key={p.name} value={p.name}>
                {p.title === p.name ? p.name : `${p.title} · ${p.name}`}
              </option>
            ))}
          </select>

          <span className="text-[14px] font-medium">{snapshot ? snapshot.title : '分镜看板'}</span>
          {snapshot && <span className="text-[11.5px] text-ink-500">{meta}</span>}

          {snapshot && (
            <div className="ml-2 flex flex-wrap items-center gap-1.5">
              {HEAD_GATES.map((k) => {
                const g = snapshot.gates?.[k];
                const signed = Boolean(g?.signed);
                return (
                  <span
                    key={k}
                    className={`inline-flex items-center gap-1 rounded-full border px-2 py-[1px] text-[11px] ${signed ? 'border-ok/45 bg-ok/10 text-ok' : 'border-ink-700 text-ink-400'}`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${signed ? 'bg-ok' : 'bg-ink-600'}`} />
                    {GATE_LABELS[k]}
                  </span>
                );
              })}
              {snapshot.gates?.clips?.total > 0 && (
                <span
                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-[1px] text-[11px] ${
                    snapshot.gates.clips.signed ? 'border-ok/45 bg-ok/10 text-ok' : 'border-warn/45 bg-warn/10 text-warn'
                  }`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${snapshot.gates.clips.signed ? 'bg-ok' : 'bg-warn'}`} />
                  片段票 {snapshot.gates.clips.signedCount}/{snapshot.gates.clips.total}
                </span>
              )}
            </div>
          )}

          <div className="ml-auto flex items-center gap-3">
            {graph.info?.frontier && (
              <span className="inline-flex items-center gap-1 text-[11.5px] text-warn">
                <CircleAlert size={13} />
                卡点：{GATE_LABELS[graph.info.frontier]}
              </span>
            )}
            {!graph.info?.frontier && graph.info?.nextStage && (
              <span className="text-[11.5px] text-ink-400">下一步：{GATE_LABELS[graph.info.nextStage]}待产出</span>
            )}
            {snapshot && !graph.info?.frontier && !graph.info?.nextStage && (
              <span className="text-[11.5px] text-ok">全阶段已签</span>
            )}
            <button
              type="button"
              onClick={() => (name ? load(name) : loadList())}
              className="inline-flex items-center gap-1 rounded-md border border-ink-700 px-2 py-1 text-[11.5px] text-ink-300 hover:border-accent/60"
              title="重新读取"
            >
              <RefreshCw size={12} className={busy ? 'animate-spin' : ''} /> 刷新
            </button>
          </div>
        </div>
        {snapshot?.logline && (
          <p className="truncate px-4 pb-2 text-[11.5px] text-ink-400" title={snapshot.logline}>{snapshot.logline}</p>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        <nav className="w-[236px] shrink-0 overflow-y-auto border-r border-ink-800 bg-ink-900/60 px-2 py-2">
          <div className="px-2 pb-1.5 text-[11px] text-ink-500">剧目 · {projects.length}</div>
          {projects.map((p) => (
            <div
              key={p.name}
              className={[
                'mb-0.5 flex items-center rounded-md',
                p.name === name ? 'bg-ink-800' : 'hover:bg-ink-850',
              ].join(' ')}
            >
              <button
                type="button"
                onClick={() => load(p.name)}
                className="min-w-0 flex-1 px-2 py-1.5 text-left"
              >
                <div className={`truncate text-[12.5px] ${p.name === name ? 'text-ink-100' : 'text-ink-200'}`}>{p.title}</div>
                <div className="truncate text-[10.5px] text-ink-500">{p.name}</div>
              </button>
              <div className="flex shrink-0 items-center gap-0.5 pr-1.5">
                <button
                  type="button"
                  title="归档（可恢复，满 7 天自动清理）"
                  onClick={() => { setActError(''); setPending({ kind: 'archive', name: p.name, title: p.title }); }}
                  className="rounded p-1 text-ink-600 hover:bg-ink-800 hover:text-ink-200"
                >
                  <Archive size={13} />
                </button>
                <button
                  type="button"
                  title="删除（移入系统回收站，要填中文名确认）"
                  onClick={() => { setActError(''); setPending({ kind: 'delete', name: p.name, title: p.title }); }}
                  className="rounded p-1 text-ink-600 hover:bg-ink-800 hover:text-bad"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}

          {archived.length > 0 && (
            <div className="mt-3 border-t border-ink-800 pt-2">
              <button
                type="button"
                onClick={() => setShowArchived((v) => !v)}
                className="flex w-full items-center gap-1 rounded px-2 py-1 text-[11px] text-ink-400 hover:bg-ink-850"
              >
                <ChevronRight size={11} className={`transition ${showArchived ? 'rotate-90' : ''}`} />
                已归档 · {archived.length}
                <span className="ml-auto text-[10px] text-ink-600">{retentionDays} 天自动清理</span>
              </button>
              {showArchived && archived.map((a) => (
                <div key={a.name} className="mb-0.5 rounded-md px-2 py-1.5 hover:bg-ink-850">
                  <div className="truncate text-[12px] text-ink-300">{a.title}</div>
                  <div className="flex items-center gap-1">
                    <span className={`truncate text-[10.5px] ${a.expired ? 'text-bad' : 'text-ink-500'}`}>
                      {a.expired ? '已到清理期' : `${a.daysLeft} 天后自动清理`}
                    </span>
                    <button
                      type="button"
                      title="恢复回主线"
                      onClick={() => runAction(() => restoreProject(a.name), `《${a.title}》已恢复到主线`)}
                      className="ml-auto inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10.5px] text-ink-400 hover:bg-ink-800 hover:text-ok"
                    >
                      <RotateCcw size={10} /> 恢复
                    </button>
                    <button
                      type="button"
                      title="删除（移入系统回收站）"
                      onClick={() => { setActError(''); setPending({ kind: 'delete', name: a.name, title: a.title, archived: true }); }}
                      className="rounded p-0.5 text-ink-600 hover:bg-ink-800 hover:text-bad"
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </nav>

        <main className="relative min-w-0 flex-1">
          {error ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-[12.5px] text-bad">{error}</div>
          ) : !snapshot ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-ink-500">
              <p className="text-[12.5px]">选一个剧目开始。</p>
              <p className="text-[11.5px]">画布 = 阶段与单元链路；点任意节点看该节点的实际产物。</p>
            </div>
          ) : (
            <ReactFlowProvider>
              <CanvasView nodes={graph.nodes} edges={graph.edges} selectedId={selected} onSelect={setSelected} />
            </ReactFlowProvider>
          )}
        </main>

        {snapshot && (
          <DetailPanel snapshot={snapshot} project={snapshot.name} selected={selected} onOpen={openMedia} />
        )}
      </div>

      {lightbox && <Lightbox project={name} rel={lightbox.rel} label={lightbox.label} onClose={() => setLightbox(null)} />}

      {pending && (
        <ConfirmModal
          kind={pending.kind}
          target={pending}
          retentionDays={retentionDays}
          busy={acting}
          error={actError}
          onCancel={() => { if (!acting) { setPending(null); setActError(''); } }}
          onConfirm={confirmAction}
        />
      )}

      {notice && (
        <div className="pointer-events-none fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-md border border-ok/40 bg-ink-900 px-3 py-1.5 text-[12px] text-ok shadow-xl">
          {notice}
        </div>
      )}
    </div>
  );
}
