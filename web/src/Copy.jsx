/**
 * Copy.jsx — 复制按钮与「可复制文本框」。
 *
 * 为什么单独一个文件：看板是**只读**的，人看中了剧本某一句、某条提示词，
 * 要能原样搬走（贴进 CLI、贴进提示词文件、贴给别的模型）。复制是详情页的
 * 通用能力，不该在每个视图里各写一遍。
 *
 * 两条实现约定：
 * 1. 优先 Clipboard API；失败（权限/非安全上下文）退回 textarea + execCommand。
 * 2. 复制**纯文本**——界面上的角色名高亮、行号是渲染产物，不能混进剪贴板，
 *    所以 `CopyBlock` 一律拿原始字符串，不读 DOM。
 */
import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';

/** 写剪贴板。成功 true，失败 false（界面显示「复制失败」）。 */
export async function copyText(text) {
  const s = String(text ?? '');
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(s);
      return true;
    }
  } catch { /* 权限被拒就走兜底 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/**
 * 复制按钮。点后 1.2 秒变「已复制」，失败显示「失败」——
 * 剪贴板是浏览器外的东西，成败必须让人看见，不能默默无声。
 */
export function CopyButton({ text, label = '复制', title, className = '' }) {
  const [state, setState] = useState('idle');
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  const onClick = async (e) => {
    e.stopPropagation();                 // 别把外层（缩略图、卡片）的点击也带上
    const ok = await copyText(text);
    setState(ok ? 'ok' : 'fail');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 1200);
  };

  const tone = state === 'ok'
    ? 'border-ok/45 bg-ok/10 text-ok'
    : state === 'fail'
      ? 'border-bad/45 bg-bad/10 text-bad'
      : 'border-ink-700 text-ink-400 hover:border-accent/60 hover:text-ink-100';

  return (
    <button
      type="button"
      onClick={onClick}
      title={title || `复制（${String(text ?? '').length} 字）`}
      className={`inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10.5px] transition ${tone} ${className}`}
    >
      {state === 'ok' ? <Check size={11} /> : <Copy size={11} />}
      {state === 'ok' ? '已复制' : state === 'fail' ? '失败' : label}
    </button>
  );
}

/**
 * 可复制文本框：右上角常驻一个复制按钮，正文原样换行、可滚动。
 * `children` 给了就用它渲染（比如剧本要带行号/高亮），否则渲染纯文本 `text`。
 */
export function CopyBlock({ text, children, className = '', label = '复制' }) {
  const empty = !String(text ?? '').trim();
  return (
    <div className={`relative rounded-lg border border-ink-700/70 bg-ink-900/60 ${className}`}>
      <div className="absolute right-1.5 top-1.5 z-10">
        <CopyButton text={text} label={label} />
      </div>
      <div className="max-h-[320px] overflow-auto px-3 py-2 pr-16 text-[12px] leading-relaxed">
        {empty
          ? <span className="text-ink-500">（没有内容）</span>
          : (children ?? <span className="whitespace-pre-wrap break-words">{text}</span>)}
      </div>
    </div>
  );
}
