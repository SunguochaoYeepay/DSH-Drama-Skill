/**
 * App.jsx — 看板主界面。
 *
 * 布局：顶栏（剧目 + 票状态 + 卡点提示）／左侧剧目列表／中间链路画布／右侧详情抽屉。
 * 画布由 `graph.js` 算出的节点与边驱动，点节点即换右侧内容。
 * 大图查看器（点缩略图全屏看）保留自旧页面。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ReactFlow, Background, BackgroundVariant, Controls, MiniMap, MarkerType, ReactFlowProvider, useEdgesState, useNodesState, useReactFlow } from '@xyflow/react';
import { RefreshCw, CircleAlert } from 'lucide-react';
import { fetchProjects, fetchProject, mediaUrl, isVideo } from './api.js';
import { buildGraph, GATE_LABELS } from './graph.js';
import { nodeTypes } from './nodes.jsx';
import DetailPanel from './DetailPanel.jsx';

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
  const [name, setName] = useState('');
  const [snapshot, setSnapshot] = useState(null);
  const [selected, setSelected] = useState(null);
  const [lightbox, setLightbox] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const loadList = useCallback(async () => {
    try {
      const list = await fetchProjects();
      setProjects(list);
      setError('');
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => { loadList(); }, [loadList]);

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
        <nav className="w-[212px] shrink-0 overflow-y-auto border-r border-ink-800 bg-ink-900/60 px-2 py-2">
          <div className="px-2 pb-1.5 text-[11px] text-ink-500">剧目 · {projects.length}</div>
          {projects.map((p) => (
            <button
              key={p.name}
              type="button"
              onClick={() => load(p.name)}
              className={[
                'mb-0.5 block w-full rounded-md px-2 py-1.5 text-left',
                p.name === name ? 'bg-ink-800' : 'hover:bg-ink-850',
              ].join(' ')}
            >
              <div className={`truncate text-[12.5px] ${p.name === name ? 'text-ink-100' : 'text-ink-200'}`}>{p.title}</div>
              <div className="truncate text-[10.5px] text-ink-500">{p.name}</div>
            </button>
          ))}
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
    </div>
  );
}
