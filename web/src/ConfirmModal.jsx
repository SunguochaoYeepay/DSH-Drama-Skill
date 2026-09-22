/**
 * ConfirmModal.jsx — 归档 / 删除的确认弹窗。
 *
 * 删除是**不可逆动作的前一步**（整目录移入系统回收站），所以：
 * - 顶部同时回显**中文标题**与**目录名** —— 标题会重名（实测 `no_chute` 与
 *   `no_chute_v2` 都叫《没说完的那句》），只看标题分不清删的是哪一个；
 * - 必须**逐字手打中文标题**才解锁确认按钮。比较时两侧 `trim`，与服务端
 *   `confirmMatches` 同规则（粘贴来的名字常带尾空格，不能因此卡住合法操作，
 *   但也不能让它绕过校验）。
 *
 * 服务端还会再校验一次 —— 这里只是别让人白点。
 */
import { useState } from 'react';
import { TriangleAlert, Archive } from 'lucide-react';

const same = (a, b) => String(a ?? '').trim() === String(b ?? '').trim();

export default function ConfirmModal({ kind, target, retentionDays = 7, busy, error, onCancel, onConfirm }) {
  const [typed, setTyped] = useState('');
  const isDelete = kind === 'delete';
  const ready = isDelete ? same(typed, target.title) : true;

  const submit = () => {
    if (ready && !busy) onConfirm(typed);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
      onClick={busy ? undefined : onCancel}
    >
      <div
        className="w-[460px] max-w-full rounded-lg border border-ink-700 bg-ink-900 p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-2">
          {isDelete
            ? <TriangleAlert size={16} className="mt-[2px] shrink-0 text-bad" />
            : <Archive size={16} className="mt-[2px] shrink-0 text-accent" />}
          <div className="min-w-0">
            <div className="text-[13.5px] font-medium text-ink-100">
              {isDelete ? '删除' : '归档'}《{target.title}》
            </div>
            <div className="truncate text-[11.5px] text-ink-500">目录 {target.name}</div>
          </div>
        </div>

        {isDelete ? (
          <>
            <p className="mt-3 text-[12px] leading-relaxed text-ink-300">
              整目录会移入 <span className="text-ink-100">Windows 系统回收站</span>，看板不再持有它。
              误删可以从回收站还原；回收站被清空之后就真没了。
            </p>
            <label className="mt-3 block text-[11.5px] text-ink-400">
              请输入剧目名称以确认：
              <span className="ml-1 select-all text-ink-100">{target.title}</span>
            </label>
            <input
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
              placeholder={target.title}
              spellCheck={false}
              className="mt-1.5 w-full rounded-md border border-ink-700 bg-ink-850 px-2 py-1.5 text-[12.5px] text-ink-100 outline-none placeholder:text-ink-600 focus:border-bad/70"
            />
            {typed && !ready && (
              <p className="mt-1 text-[11px] text-ink-500">和剧目名称不一致，再核一下。</p>
            )}
          </>
        ) : (
          <p className="mt-3 text-[12px] leading-relaxed text-ink-300">
            移到归档区，可在左侧「已归档」里随时恢复。
            归档满 <span className="text-ink-100">{retentionDays} 天</span> 后会自动清进系统回收站。
          </p>
        )}

        {error && <p className="mt-2 text-[11.5px] text-bad">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-md border border-ink-700 px-3 py-1.5 text-[12px] text-ink-300 hover:border-ink-600 disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!ready || busy}
            className={[
              'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium disabled:cursor-not-allowed disabled:opacity-40',
              isDelete ? 'bg-bad text-white' : 'bg-accent text-ink-950',
            ].join(' ')}
          >
            <Archive size={12} />
            {busy ? '处理中…' : (isDelete ? '确认删除' : '确认归档')}
          </button>
        </div>
      </div>
    </div>
  );
}
