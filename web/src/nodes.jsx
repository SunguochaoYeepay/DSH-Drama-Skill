/**
 * nodes.jsx — 画布上的三种节点：阶段 / 单元 / 成片。
 *
 * 尺寸与 `graph.js` 里的常量一一对应（那边布局、这边渲染，同一套数）。
 * 节点数据里带 `project`（由 App 注入）与剧目内相对路径，缩略图走 `/media`。
 */
import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import { FileText, LayoutGrid, Clapperboard, ListOrdered, Play, ImageOff, Film } from 'lucide-react';
import { mediaUrl } from './api.js';

const STAGE_ICON = {
  story: FileText,
  direction: Clapperboard,
  assets: LayoutGrid,
  detail: ListOrdered,
};

/** 票徽标：已签=绿，未签=琥珀。`focus` 时加一圈描边（当前卡点）。 */
export function GateBadge({ label, signed, focus }) {
  return (
    <span
      className={[
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[10.5px] leading-4',
        signed ? 'border-ok/45 bg-ok/10 text-ok' : 'border-warn/45 bg-warn/10 text-warn',
        focus ? 'ring-1 ring-warn/70' : '',
      ].join(' ')}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${signed ? 'bg-ok' : 'bg-warn'}`} />
      {label}
    </span>
  );
}

function GateRow({ gates, focusKey }) {
  if (!gates?.length) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {gates.map((g) => (
        <GateBadge key={g.key} label={g.label} signed={g.signed} focus={g.key === focusKey} />
      ))}
    </div>
  );
}

/** 阶段节点：标题 + 该阶段量级 + 票。`secondary` 的是侧挂的「执行细节」（虚线、压暗）。 */
export const StageNode = memo(function StageNode({ data }) {
  const Icon = STAGE_ICON[data.key] || FileText;
  const missing = data.present === false;
  return (
    <div
      className={[
        'card flex h-full w-full flex-col gap-2 rounded-xl border bg-ink-850 px-3 py-2.5',
        data.secondary
          ? 'border-dashed border-ink-700/70 opacity-70'
          : (missing ? 'border-bad/40' : 'border-ink-700'),
      ].join(' ')}
      style={{ width: 264, height: 96 }}
    >
      {data.key !== 'story' && <Handle type="target" id="in" position={Position.Left} />}
      <div className="flex items-center gap-2">
        <Icon size={14} className={data.secondary ? 'text-ink-500' : (missing ? 'text-bad' : 'text-accent')} />
        <span className="text-[13px] font-medium">{data.title}</span>
        {missing && <span className="text-[10.5px] text-bad">缺</span>}
      </div>
      <div className="text-[11.5px] text-ink-400">{data.subtitle}</div>
      <div className="mt-auto">
        <GateRow gates={data.gates} focusKey={data.focusKey} />
        {!data.gates?.length && <div className="truncate text-[10.5px] text-ink-500">{data.file}</div>}
      </div>
      <Handle type="source" id="out" position={Position.Right} />
      {data.hasScenesHandle && <Handle type="source" id="scenes" position={Position.Bottom} />}
    </div>
  );
});

/**
 * 「集」分组条：**只有多集时才出现**，一条横带盖住这一集的场次。
 * 单集不画 —— 一层只装一件事的空壳是视觉噪音。
 */
export const EpisodeNode = memo(function EpisodeNode({ data }) {
  return (
    <div
      className="flex h-full w-full items-center gap-2 rounded-lg border border-dashed border-accent/40 bg-accent/5 px-3 text-[11.5px] text-ink-300"
      style={{ minWidth: 264, height: 34 }}
    >
      <Handle type="target" id="in" position={Position.Left} />
      <span className="font-medium text-ink-100">{data.title}</span>
      <span className="text-ink-500">{data.subtitle}</span>
      <Handle type="source" id="scenes" position={Position.Bottom} />
    </div>
  );
});

/**
 * 场次节点：一场戏一个节点，挂在该场下面的单元就是这一场要拍的东西。
 *
 * 带自己的**场景主图** —— 场景主图本来就是一场一张；项目级的「资源」节点只是清单视角，
 * 两者是同一批资产的两个看面，不是两份数据。
 */
export const SceneNode = memo(function SceneNode({ data }) {
  return (
    <div
      className="card flex h-full w-full items-center gap-3 rounded-xl border border-ink-700 bg-ink-850 px-3 py-2"
      style={{ width: 264, height: 96 }}
    >
      <Handle type="target" id="in" position={Position.Left} />
      <div className="h-[62px] w-[62px] shrink-0 overflow-hidden rounded-md bg-ink-900">
        {data.master ? (
          <img src={mediaUrl(data.project, data.master)} alt={data.title} loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-ink-600">
            <ImageOff size={16} />
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] font-medium" title={data.title}>{data.title}</div>
        <div className="mt-0.5 text-[11px] text-ink-400">{data.unitCount} 个单元</div>
      </div>
      <Handle type="source" id="units" position={Position.Bottom} />
    </div>
  );
});

/** 单元节点：关键帧缩略图 + 时长 + 关键帧票/片段票。 */
export const UnitNode = memo(function UnitNode({ data }) {
  const { project, keyframe, clip } = data;
  const has = Boolean(keyframe || clip);
  return (
    <div
      className={[
        'card flex h-full w-full flex-col overflow-hidden rounded-xl border bg-ink-850',
        has ? 'border-ink-700' : 'border-bad/40',
      ].join(' ')}
      style={{ width: 264, height: 214 }}
    >
      <Handle type="target" id="in" position={Position.Top} />
      <div className="relative h-[132px] w-full shrink-0 bg-ink-900">
        {keyframe ? (
          <img
            src={mediaUrl(project, keyframe)}
            alt={`${data.id} 关键帧`}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-ink-500">
            <ImageOff size={18} />
            <span className="text-[11px]">无关键帧</span>
          </div>
        )}
        {clip && (
          <span className="absolute bottom-1.5 right-1.5 inline-flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-[10.5px] text-ink-100">
            <Play size={10} /> 片段
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1.5 px-3 py-2">
        <div className="flex items-baseline justify-between">
          <span className="text-[13px] font-medium">{data.id}</span>
          <span className="text-[11px] text-ink-400">
            {data.shotCount} 镜 · {data.duration}
          </span>
        </div>
        <GateRow gates={data.gates} focusKey={data.focusKey} />
      </div>
      <Handle type="source" id="out" position={Position.Bottom} />
    </div>
  );
});

/** 成片节点。 */
export const FinalNode = memo(function FinalNode({ data }) {
  return (
    <div
      className={[
        'card flex h-full w-full flex-col gap-2 rounded-xl border bg-ink-850 px-3 py-2.5',
        data.present ? 'border-ok/45' : 'border-ink-700',
      ].join(' ')}
      style={{ width: 264, height: 96 }}
    >
      <Handle type="target" id="in" position={Position.Top} />
      <div className="flex items-center gap-2">
        <Film size={14} className={data.present ? 'text-ok' : 'text-ink-500'} />
        <span className="text-[13px] font-medium">{data.title}</span>
      </div>
      <div className="truncate text-[11.5px] text-ink-400">{data.subtitle}</div>
      <div className="mt-auto">
        <GateRow gates={data.gates} focusKey={data.focusKey} />
      </div>
    </div>
  );
});

export const nodeTypes = {
  stage: StageNode,
  episode: EpisodeNode,
  scene: SceneNode,
  unit: UnitNode,
  final: FinalNode,
};
