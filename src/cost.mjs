/**
 * cost.mjs — 成本账本。
 *
 * 为什么要有它：做完那部 88 秒的片子，我花了约 3.9 元，**一次账都没记** ——
 * 事后只能靠翻会话重建，还得靠估。而且重建之后才发现：
 * **其中 1.44 元（37%）是我自己的 bug 造成的重出。** 不记账，这种浪费就一直隐形。
 *
 * 原则：
 *   1. **调用当场记**，不在事后估。参数（几张图 / 几个字符）来自真实调用。
 *   2. **本地调用也记**，但金额 0 —— 要看得见工作量，不能只看得见钱。
 *   3. **价格是公示价，不是账单。** 真实账单要 `bl auth login --console` 之后 `bl usage summary`。
 *      这个账本是"我这次花了大概多少"的即时反馈，不是财务凭证。
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * 公示单价。来源：本地那份百炼模型市场数据
 * （`.agents/skills/bailian-docs-llm-wiki/models/groups/*.json`）。
 * **价格会变** —— 要用之前核对一眼，或者用 AIH_PRICE_<MODEL> 环境变量覆盖。
 */
export const PRICES = {
  // 图片：生成按张、参考图输入也按张
  'qwen-image-3.0': { kind: 'image', out: 0.18, in: 0.02 },
  'qwen-image-3.0-pro': { kind: 'image', out: 0.25, in: 0.02 },
  'qwen-image-2.0-pro': { kind: 'image', out: 0.18, in: 0.02 },
  'wan2.7-image': { kind: 'image', out: 0.18, in: 0.02 },
  // 语音：按万字符
  'cosyvoice-v3-flash': { kind: 'tts', per10k: 1 },
  'cosyvoice-v3.5-flash': { kind: 'tts', per10k: 0.8 },
  'cosyvoice-v3-plus': { kind: 'tts', per10k: 2 },
};

/** 查单价；环境变量 AIH_PRICE_<模型名大写去点> 可覆盖。 */
export function priceFor(model, env = process.env) {
  const key = `AIH_PRICE_${String(model).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  if (env[key] !== undefined) {
    const n = Number(env[key]);
    if (Number.isFinite(n)) return { kind: 'flat', flat: n, source: `env:${key}` };
  }
  const p = PRICES[model];
  return p ? { ...p, source: '公示价' } : null;
}

/** 单次调用的金额。**纯函数**，可以离线断言。 */
export function costOf({ op, model, units = 1, inputRefs = 0, chars = 0 }, env = process.env) {
  const p = priceFor(model, env);
  if (!p) return { cny: 0, unknown: true, why: `没有 ${model} 的单价` };
  if (p.kind === 'image') {
    return { cny: Number((units * p.out + inputRefs * p.in).toFixed(4)), unknown: false, why: `${units}×${p.out} + ${inputRefs}×${p.in}` };
  }
  if (p.kind === 'tts') {
    return { cny: Number((chars / 10000 * p.per10k).toFixed(4)), unknown: false, why: `${chars}字符 × ${p.per10k}/万` };
  }
  if (p.kind === 'flat') {
    return { cny: Number((units * p.flat).toFixed(4)), unknown: false, why: `${units}×${p.flat}` };
  }
  return { cny: 0, unknown: true, why: `不认识的计费类型 ${p.kind}` };
}

// ---------------------------------------------------------------- 账本实例

/**
 * 全局账本。编排入口启动时 `attach()` 一次，通道在每次调用后 `add()`。
 * 没 attach 时是空操作 —— 单独调通道做实验不会报错，也不会乱写文件。
 */
class Ledger {
  constructor() {
    this.entries = [];
    this.file = null;
    this.ctx = {};
    this.enabled = false;
  }

  attach(file, ctx = {}) {
    this.file = file;
    this.ctx = ctx;
    this.enabled = true;
    if (file && fs.existsSync(file)) {
      try { this.entries = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { this.entries = []; }
      if (!Array.isArray(this.entries)) this.entries = [];
    }
    return this;
  }

  /** 记一笔。`op` 形如 image.generate / image.edit / speech.synthesize。 */
  add(entry) {
    if (!this.enabled) return null;
    const { cny, unknown, why } = costOf(entry);
    const row = {
      at: new Date().toISOString(),
      board: this.ctx.board ? path.basename(this.ctx.board) : null,
      run: this.ctx.run || null,          // 首轮 / 重出 / 测试
      provider: entry.provider || 'unknown',
      op: entry.op,
      model: entry.model || '',
      units: entry.units ?? 1,
      input_refs: entry.inputRefs ?? 0,
      chars: entry.chars ?? 0,
      cny,
      price_unknown: unknown || undefined,
      why: unknown ? why : undefined,
      note: entry.note || '',
    };
    this.entries.push(row);
    this.save();
    return row;
  }

  save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.entries, null, 2) + '\n');
    } catch { /* 记账失败不该弄崩生产 */ }
  }

  /** 本次进程新增的条目（用来打"这一趟花了多少"）。 */
  since(mark) { return this.entries.slice(mark); }
  mark() { return this.entries.length; }
}

export const ledger = new Ledger();

// ---------------------------------------------------------------- 汇总

/** 按运行轮次 + 模型汇总。纯函数。 */
export function summarize(entries) {
  const byModel = new Map();
  const byRun = new Map();
  let total = 0;
  let unknown = 0;
  for (const e of entries) {
    total += e.cny || 0;
    if (e.price_unknown) unknown++;
    const m = byModel.get(e.model) || { model: e.model, op: e.op, units: 0, input_refs: 0, chars: 0, cny: 0, calls: 0 };
    m.units += e.units || 0; m.input_refs += e.input_refs || 0; m.chars += e.chars || 0;
    m.cny += e.cny || 0; m.calls += 1;
    byModel.set(e.model, m);
    const r = e.run || '未标注';
    byRun.set(r, Number(((byRun.get(r) || 0) + (e.cny || 0)).toFixed(4)));
  }
  return {
    total: Number(total.toFixed(4)),
    unknown_prices: unknown,
    calls: entries.length,
    by_model: [...byModel.values()].map((m) => ({ ...m, cny: Number(m.cny.toFixed(4)) })),
    by_run: [...byRun.entries()].map(([run, cny]) => ({ run, cny })),
  };
}

/** 打成给人看的表。 */
export function formatSummary(s) {
  const L = [];
  L.push('成本（公示价估算，不是账单；真实账单需 bl auth login --console → bl usage summary）');
  L.push('');
  L.push('  模型                    调用   张数  参考  字符      金额');
  L.push('  ' + '─'.repeat(62));
  for (const m of s.by_model.sort((a, b) => b.cny - a.cny)) {
    L.push(`  ${String(m.model).padEnd(22)} ${String(m.calls).padStart(4)} ${String(m.units).padStart(6)} ${String(m.input_refs).padStart(5)} ${String(m.chars).padStart(6)}  ${m.cny.toFixed(3).padStart(8)} 元`);
  }
  L.push('  ' + '─'.repeat(62));
  L.push(`  ${'合计'.padEnd(22)} ${String(s.calls).padStart(4)}${' '.repeat(20)}  ${s.total.toFixed(3).padStart(8)} 元`);
  if (s.by_run.length > 1) {
    L.push('');
    L.push('  按轮次：');
    for (const r of s.by_run.sort((a, b) => b.cny - a.cny)) L.push(`    ${String(r.run).padEnd(12)} ${r.cny.toFixed(3).padStart(7)} 元`);
  }
  if (s.unknown_prices) L.push(`\n  ⚠ ${s.unknown_prices} 次调用没有单价，金额按 0 计 —— 别信这个合计`);
  return L.join('\n');
}
