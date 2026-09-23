/**
 * RegenModal.jsx — 「重出关键帧」工作台（用户 2026-09-23 要的弹窗流程）。
 *
 * 一个单元的关键帧不满意时，原来得回终端：改 `keyframe-prompts/<单元>.txt`、
 * 拼一条 `node cli/keyframes.mjs …`。现在在这一个弹窗里走完：
 *
 *   改提示词 → 保存并重出 → 看新图（不满意就再改再出）→ 满意 → 签署
 *
 * 三条边界（和服务端一起守）：
 * 1. **提示词只写一个文件**：`keyframe-prompts/<单元>.txt`，别的项目文件一个字不碰；
 * 2. **重出只跑这一个单元**（`--units <单元>`），同一时刻只允许一个任务；
 * 3. **签署 ≠ 看板签票**：点它只是把用户明确的「通过」转交给唯一所有者
 *    `cli/review-gate.mjs` 执行 —— 看板里没有任何写 `review.approvals.json` 的代码路径。
 *    另外关键帧票**不是每格一张**，它绑的是计划里全部关键帧：签一次覆盖全批，
 *    所以确认按钮上把这句话摆明。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { mediaUrl, startRegenerate, fetchRegenerate, saveKeyframePrompt, signStage } from './api.js';

/** CLI 的提示词自检上限（`auditPrompt`）：超过它，重出一定会被拒。 */
const PROMPT_AUDIT_LIMIT = 500;

export default function RegenModal({ project, unit, frameCount = 1, onClose, onRefresh, onOpen }) {
  const [text, setText] = useState(unit.keyframePrompt || '');
  const [version, setVersion] = useState(() => Date.now());   // 换图后用它打破浏览器缓存
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

  // 跑着的时候每 2 秒问一次；一结束就刷新快照与图片
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
      await saveKeyframePrompt(project, unit.id, text);
      const r = await startRegenerate(project, unit.id);
      setJob({ id: r.jobId, state: 'running', log: '', durationMs: 0 });
    } catch (e) {
      setError(e.message || '重出起不来');
    } finally {
      setBusy(false);
    }
  }, [project, unit.id, text]);

  const doSign = async () => {
    setBusy(true); setError('');
    try {
      const r = await signStage(project, 'keyframes');
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
  const tooLong = chars > PROMPT_AUDIT_LIMIT;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
      onClick={busy ? undefined : onClose}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
    >
      <div
        className="flex max-h-[88vh] w-[860px] max-w-full flex-col rounded-lg border border-ink-700 bg-ink-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 border-b border-ink-800 px-4 py-2.5">
          <span className="text-[13.5px] font-medium">重出关键帧 · {unit.id}</span>
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
              <span className="text-[12px] text-ink-300">关键帧提示词</span>
              <span className={`text-[11px] ${tooLong ? 'text-bad' : 'text-ink-500'}`}>
                {chars} 字{tooLong ? `（超过 CLI 自检上限 ${PROMPT_AUDIT_LIMIT}，重出会被拒）` : ''}
              </span>
              <button
                type="button"
                onClick={() => setText(unit.keyframePrompt || '')}
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
              placeholder={`还没有 keyframe-prompts/${unit.id}.txt —— 在这里写下这一格要什么，点「保存并重出」`}
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
              <span className="text-[11px] text-ink-500">
                只重抽这一个单元；本机 ComfyUI 约 20–35 秒
              </span>
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
                  </>
                )}
              </div>
            ) : null}
          </div>

          {/* 右：结果图 + 签署 */}
          <div className="flex min-h-0 flex-col">
            <div className="mb-1 flex items-baseline gap-2">
              <span className="text-[12px] text-ink-300">这一格现在的图</span>
              <span className="text-[11px] text-ink-500">{unit.keyframe || '还没有关键帧'}</span>
            </div>
            <div className="flex min-h-[260px] flex-1 items-center justify-center rounded-md border border-ink-700 bg-ink-950 p-2">
              {unit.keyframe ? (
                <button type="button" onClick={() => onOpen(unit.keyframe, `${unit.id} 关键帧`)} className="block">
                  <img
                    src={`${mediaUrl(project, unit.keyframe)}?v=${version}`}
                    alt={`${unit.id} 关键帧`}
                    className="max-h-[46vh] max-w-full rounded"
                  />
                </button>
              ) : (
                <span className="text-[12px] text-ink-500">还没出图 —— 左边写好提示词，点「保存并重出」</span>
              )}
            </div>
            <div className="mt-1 text-[11px] text-ink-500">点图看大图（也可以下载自己对比）</div>

            <div className="mt-3 rounded-md border border-ink-700/70 bg-ink-900/60 p-2.5">
              <div className="text-[11.5px] text-ink-300">满意就签署关键帧票</div>
              <div className="mt-0.5 text-[11px] text-ink-500">
                关键帧票绑的是**计划里全部 {frameCount} 格**的图，签一次覆盖全批；
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
                    确认签署（覆盖全部 {frameCount} 格）
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
                  满意，签关键帧票
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
