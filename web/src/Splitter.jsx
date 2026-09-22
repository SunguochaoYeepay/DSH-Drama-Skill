/**
 * Splitter.jsx — 可拖动的列宽分隔条（左导航 / 画布 / 右详情 三栏用）。
 *
 * 拖动逻辑放在这里而不是各栏内部：三栏共享一条规则（画布再窄也得留 360px），
 * 分开写就会各留各的、互相挤没。
 *
 * 用法：父组件持有 `{left, right}` 两个宽度，把 `onResize(side, deltaX)` 传进来；
 * 本组件只负责「把指针位移翻译成宽度变化」和视觉反馈，不持有宽度本身。
 */
import { useEffect, useRef, useState } from 'react';

/** 拖动时给 <body> 挂的类：全窗口变 col-resize 光标、禁止选中文字。 */
const RESIZING = 'kanban-resizing';

export default function Splitter({ side, onResize, onReset, title }) {
  const [active, setActive] = useState(false);
  const start = useRef(0);

  // 卸載 / 中途中断也要把 body 上的类摘掉，否则整个页面会卡在拖动光标里
  useEffect(() => () => document.body.classList.remove(RESIZING), []);

  useEffect(() => {
    if (!active) return undefined;
    const onMove = (e) => onResize(side, e.clientX - start.current);
    const onUp = () => {
      setActive(false);
      document.body.classList.remove(RESIZING);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [active, side, onResize]);

  const onPointerDown = (e) => {
    start.current = e.clientX;
    setActive(true);
    document.body.classList.add(RESIZING);
    onStart?.(side);          // 让父组件记下按下那一刻的宽度（位移都从它起算）
    e.preventDefault();
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      title={title || '拖动调整列宽（双击复位）'}
      onPointerDown={onPointerDown}
      onDoubleClick={onReset}
      className={`relative z-10 w-[5px] shrink-0 cursor-col-resize transition-colors ${active ? 'bg-accent' : 'bg-ink-800 hover:bg-accent/60'}`}
    >
      {/* 加宽命中区：5px 太窄不好抓，视觉仍是细线 */}
      <span className="absolute inset-y-0 -left-1.5 -right-1.5" />
    </div>
  );
}
