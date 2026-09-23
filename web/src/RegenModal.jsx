/**
 * RegenModal.jsx — 「重出」工作台（用户 2026-09-23 要的弹窗流程）。
 *
 * 一个单元的**关键帧**或**视频片段**不满意时，原来得回终端：改直写提示词、
 * 拼一条 `node cli/keyframes.mjs …` / `node cli/unit.mjs …`。现在在这一个弹窗里走完：
 *
 *   改提示词 → 保存并重出 → 看新产物（不满意就再改再出）→ 满意 → 签署
 *
 * 两种产物的差别（都在这里显式写出来，别靠猜）：
 * | | 关键帧 | 视频片段 |
 * |---|---|---|
 * | CLI | `cli/keyframes.mjs --units <单元>` | `cli/unit.mjs --unit <单元>` |
 * | 提示词 | `keyframe-prompts/<单元>.txt` | `units/.<单元>.prompt.txt` |
 * | 票 | **整批一张**（绑定计划里全部关键帧） | **每单元一张**（`--id <单元>`） |
 * | 自检 | CLI 审计 ≤500 字 | 无此限制（视频提示词本来就上千字） |
 *
 * 三条边界（和服务端一起守）：
 * 1. **提示词只写一个文件**（上表那两个之一），别的项目文件一个字不碰；
 * 2. **重出只跑这一个单元**，同一时刻只允许一个任务；
 * 3. **签署 ≠ 看板签票**：点它只是把用户明确的「通过」转交给唯一所有者
 *    `cli/review-gate.mjs` 执行 —— 看板里没有任何写 `review.approvals.json` 的代码路径。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { mediaUrl, isVideo, startRegenerate, fetchRegenerate, savePrompt, signStage } from './api.js';

/** CLI 的关键帧提示词自检上限（`auditPrompt`）：超过它，重出一定会被拒。 */
const PROMPT_AUDIT_LIMIT = 500;

/**
 * 把 CLI 那几句"机制话"翻成人话 + 给出下一步命令。
 *
 * 这些都是**真踩过的**：看板里点重出，报的是 CLI 的原文（比如「交接凭证不属于当前项目或单元」），
 * 但人真正需要知道的是"为什么"和"那我该怎么办"。
 */
function hintFor(text) {
  const t = String(text || '');
  if (/交接凭证不属于当前项目或单元/.test(t)) {
    return {
      why: '这份交接凭证是**另一个路径**下签发的 —— 当前剧目多半是从别处复制过来的副本。',
      fix: 'node cli/prepare-handoff.mjs --plan <剧目>/render.plan.json --unit <单元>（在副本里重跑一次交接准备，凭证就绑到当前路径）',
    };
  }
  if (/缺少实际尾帧交接凭证/.test(t)) {
    return {
      why: '上一段还没生成、或还没人工确认，尾帧交接凭证建不起来。',
      fix: '先把上一段的视频生成并签片段票，再回来重出这一段。',
    };
  }
  if (/人工闸门未通过|旧确认自动失效/.test(t)) {
    return {
      why: '上游产物的票已失效（产物改过，或换了目录/副本）。',
      fix: 'node cli/review-gate.mjs approve --project <剧目> --stage assets（按提示里的阶段补签上游）',
    };
  }
  if (/实际使用的关键帧与连续性交接凭证不一致/.test(t)) {
    return {
      why: '关键帧换过了，但交接凭证里还绑着旧那张。',
      fix: '先重出这一格的关键帧并签票，再重出视频。',
    };
  }
  return null;
}

/** 两种产物的呈现口径。 */
const KINDS = {
  keyframe: {
    title: '重出关键帧',
    promptLabel: '关键帧提示词',
    promptFile: (unit) => `keyframe-prompts/${unit}.txt`,
    previewLabel: '这一格现在的图',
    estimate: '本机 ComfyUI 约 20–35 秒',
    auditLimit: PROMPT_AUDIT_LIMIT,
    signStage: 'keyframes',
    signTitle: '满意就签署关键帧票',
    signNote: (n) => `关键帧票绑的是**计划里全部 ${n} 格**的图，签一次覆盖全批；`,
  },
  clip: {
    title: '重出视频片段',
    promptLabel: '视频提示词',
    promptFile: (unit) => `units/.${unit}.prompt.txt`,
    previewLabel: '这一段现在的视频',
    estimate: '本机 ComfyUI 约 50–75 秒',
    auditLimit: 0,               // 视频提示词没有 500 字这条自检
    signStage: 'clip',
    signTitle: '满意就签这一段的片段票',
    signNote: () => '片段票是**每单元一张**，只签这一段；',
  },
};

export default function RegenModal({ project, unit, kind = 'keyframe', frameCount = 1, onClose, onRefresh, onOpen }) {
  const K = KINDS[kind] || KINDS.keyframe;
  const initialPrompt = kind === 'clip' ? (unit.videoPrompt || '') : (unit.keyframePrompt || '');
  const previewRel = kind === 'clip' ? unit.clip : unit.keyframe;

  const [text, setText] = useState(initialPrompt);
  const [version, setVersion] = useState(() => Date.now());   // 换产物后用它打破浏览器缓存
  const [job, setJob] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmSign, setConfirmSign] = useState(false);
  const [signed, setSigned] = useState(null);
  const alive = useRef(true);

  useEffect(() => () => { alive.current = false; }, []);

  // 打开时先接上"正在跑的那个任务"（比如上次关掉弹窗、任务还在后台跑）
  useEffect(() => {
    fetchRegenerate()
      .then((j) => { if (alive.current && j?.state === 'running' && j.unit === unit.id) setJob(j); })
      .catch(() => { /* 没有任务就是 404，正常 */ });
  }, [unit.id]);

  // 跑着的时候每 2 秒问一次；一结束就刷新快照与产物
  useEffect(() => {
    if (!job || job.state !== 'running') return undefined;
    const timer = setInterval(async () => {
      try {
        const v = await fetchRegenerate(job.id);
        if (!alive.current) return;
        setJob(v);
        if (v.state !== 'running') {
          if (v.state === 'done') setVersion(Date.now());
          onRefresh?.();
        }
      } catch { /* 网络抖一下就下一轮 */ }
    }, 2000);
    return () => clearInterval(timer);
  }, [job, onRefresh]);

  const run = useCallback(async () => {
    setBusy(true); setError(''); setSigned(null); setConfirmSign(false);
    try {
      await savePrompt(project, unit.id, kind, text);
      const r = await startRegenerate(project, unit.id, kind);
      setJob({ id: r.jobId, state: 'running', log: '', durationMs: 0 });
    } catch (e) {
      setError(e.message || '重出起不来');
    } finally {
      setBusy(false);
    }
  }, [project, unit.id, kind, text]);

  const doSign = async () => {
    setBusy(true); setError('');
    try {
      const r = await signStage(project, K.signStage, kind === 'clip' ? unit.id : undefined);
      setSigned({ at: new Date().toLocaleTimeString(), output: r.output });
      setConfirmSign(false);
      onRefresh?.();
    } catch (e) {
      setError(e.message || '签署失败');
    } finally {
      setBusy(false);
    }
  };

  const running = job?.state === 'running';
  const lastLine = String(job?.log || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
  const chars = text.trim().length;
  const tooLong = K.auditLimit > 0 && chars > K.auditLimit;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
      onClick={busy ? undefined : onClose}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
    >
      <div
        className="flex max-h-[88vh] w-[880px] max-w-full flex-col rounded-lg border border-ink-700 bg-ink-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 border-b border-ink-800 px-4 py-2.5">
          <span className="text-[13.5px] font-medium">{K.title} · {unit.id}</span>
          <span className="truncate text-[11.5px] text-ink-500">{project}</span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded p-1 text-ink-500 hover:bg-ink-850 hover:text-ink-200"
            title="关闭（后台任务不会被中断）"
          >
            ✕
          </button>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-2 gap-3 overflow-y-auto p-4">
          {/* 左：提示词 */}
          <div className="flex min-h-0 flex-col">
            <div className="mb-1 flex items-baseline gap-2">
              <span className="text-[12px] text-ink-300">{K.promptLabel}</span>
              <span className={`text-[11px] ${tooLong ? 'text-bad' : 'text-ink-500'}`}>
                {chars} 字{tooLong ? `（超过 CLI 自检上限 ${K.auditLimit}，重出会被拒）` : ''}
              </span>
              <button
                type="button"
                onClick={() => setText(initialPrompt)}
                className="ml-auto rounded border border-ink-700 px-1.5 py-px text-[11px] text-ink-400 hover:text-ink-200"
                title="丢掉改动，回到文件里现在的内容"
              >
                恢复原文
              </button>
            </div>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              spellCheck={false}
              className="min-h-[260px] flex-1 resize-y rounded-md border border-ink-700 bg-ink-850 p-2 text-[12px] leading-relaxed text-ink-100 outline-none focus:border-accent"
              placeholder={`还没有 ${K.promptFile(unit.id)} —— 在这里写下这一段要什么，点「保存并重出」`}
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={run}
                disabled={busy || running || !chars}
                className={[
                  'rounded-md px-3 py-1.5 text-[12.5px] font-medium transition',
                  busy || running || !chars
                    ? 'bg-ink-800 text-ink-500'
                    : 'bg-accent text-ink-950 hover:brightness-110',
                ].join(' ')}
              >
                {running ? '重出中…' : '保存并重出'}
              </button>
              <span className="text-[11px] text-ink-500">只重抽这一个单元；{K.estimate}</span>
            </div>
            {error ? <div className="mt-2 text-[11.5px] text-bad">{error}</div> : null}
            {job ? (
              <div className="mt-2 space-y-1">
                {running ? (
                  <div className="text-[11.5px] text-ink-400">
                    {((job.durationMs || 0) / 1000).toFixed(0)} 秒…　{lastLine || '（等待模型）'}
                  </div>
                ) : job.state === 'done' ? (
                  <div className="text-[11.5px] text-ok">✓ 重出完成（{(job.durationMs / 1000).toFixed(1)} 秒）</div>
                ) : (
                  <>
                    <div className="text-[11.5px] text-bad">✗ 重出失败（退出码 {job.exitCode ?? '—'}）</div>
                    {lastLine ? (
                      <div className="break-all rounded border border-bad/40 bg-bad/5 px-2 py-1 font-mono text-[11px] text-bad">
                        {lastLine}
                      </div>
                    ) : null}
                    {(() => {
                      const h = hintFor(job.log);
                      return h ? (
                        <div className="rounded border border-warn/40 bg-warn/5 px-2 py-1.5 text-[11.5px] text-warn">
                          <div>{h.why}</div>
                          <div className="mt-0.5 break-all font-mono text-[11px] text-ink-300">{h.fix}</div>
                        </div>
                      ) : null;
                    })()}
                  </>
                )}
              </div>
            ) : null}
          </div>

          {/* 右：结果 + 签署 */}
          <div className="flex min-h-0 flex-col">
            <div className="mb-1 flex items-baseline gap-2">
              <span className="text-[12px] text-ink-300">{K.previewLabel}</span>
              <span className="truncate text-[11px] text-ink-500">{previewRel || '还没有产物'}</span>
            </div>
            <div className="flex min-h-[260px] flex-1 items-center justify-center rounded-md border border-ink-700 bg-ink-950 p-2">
              {previewRel ? (
                <button type="button" onClick={() => onOpen(previewRel, `${unit.id} ${K.promptLabel}`)} className="block">
                  {isVideo(previewRel) ? (
                    <video
                      src={`${mediaUrl(project, previewRel)}#t=0.1`}
                      preload="metadata"
                      muted
                      playsInline
                      className="max-h-[46vh] max-w-full rounded"
                    />
                  ) : (
                    <img
                      src={`${mediaUrl(project, previewRel)}?v=${version}`}
                      alt={`${unit.id} ${K.promptLabel}`}
                      className="max-h-[46vh] max-w-full rounded"
                    />
                  )}
                </button>
              ) : (
                <span className="text-[12px] text-ink-500">
                  还没有产物 —— 左边写好提示词，点「保存并重出」
                </span>
              )}
            </div>
            <div className="mt-1 text-[11px] text-ink-500">
              {isVideo(previewRel) ? '点它开灯箱播放（详情里不内联播放）' : '点它看大图'}
            </div>

            <div className="mt-3 rounded-md border border-ink-700/70 bg-ink-900/60 p-2.5">
              <div className="text-[11.5px] text-ink-300">{K.signTitle}</div>
              <div className="mt-0.5 text-[11px] text-ink-500">
                {K.signNote(frameCount)}
                票由 <span className="font-mono">cli/review-gate.mjs</span> 落笔，看板自己不改 approvals 文件。
              </div>
              {signed ? (
                <div className="mt-2 text-[11.5px] text-ok">✓ 已签署（{signed.at}）</div>
              ) : confirmSign ? (
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={doSign}
                    disabled={busy}
                    className="rounded-md bg-warn px-2.5 py-1 text-[12px] font-medium text-ink-950 hover:brightness-110 disabled:opacity-50"
                  >
                    {kind === 'clip' ? `确认签署（只签 ${unit.id}）` : `确认签署（覆盖全部 ${frameCount} 格）`}
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
                  disabled={busy}
                  className="mt-2 rounded-md border border-ok/50 bg-ok/10 px-2.5 py-1 text-[12px] text-ok hover:bg-ok/20 disabled:opacity-50"
                >
                  {kind === 'clip' ? '满意，签这一段的片段票' : '满意，签关键帧票'}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
