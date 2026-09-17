/**
 * 用**本地 ollama** 的视觉模型看一张图 —— 0 成本。
 *
 * ## 为什么要这条
 *
 * 质检要"看"很多张图（资产 5 张 + 关键帧 N 张 + 每个片段抽几帧）。
 * 走线上 `bl vision describe` 是能用的（`qwen3-vl-plus` 质量不错，也确实
 * 抓到了我肉眼漏掉的崩坏），**但那是按量计费的**。
 *
 * 这台机器上 ollama 装着 91.6 GB 模型，其中 **4 个带视觉**：
 * `qwen3.5:27b` / `gemma4:26b` / `huihui_ai/gemma-4-abliterated:e4b` / `qwen36-unc`。
 *
 * **所以先试本地。本地不行再上线上。**
 *
 * ## 怎么调
 *
 * ollama 的 `/api/generate` 支持 `images: [base64]`。图片要 base64（不要 data: 前缀）。
 */

import fs from 'node:fs';

const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';

/** ollama 在跑吗。 */
export async function ollamaUp() {
  try {
    const r = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(4000) });
    return r.ok;
  } catch { return false; }
}

/**
 * 本地视觉模型看一张图。
 *
 * @param {string} file      图片路径
 * @param {object} opts      { focus: string[], extra: string, model: string }
 * @returns {Promise<{ok:boolean, text:string, seconds:number}>}
 */
export async function lookLocal(file, { focus = [], extra = '', model = 'qwen3.5:27b' } = {}) {
  const lines = [
    '你是一个严格的质量检查员。请仔细看这张画面，然后按下面的问题逐条回答。',
    '',
    '要求：每条都要说出你实际看到的，不要笼统地说"正常""没问题"；',
    '拿不准就直说拿不准；有问题要指出具体在画面哪个位置、是什么样。',
    '',
    '逐条回答：',
    ...focus.map((f, i) => `${i + 1}. ${f}`),
  ];
  if (extra) lines.push('', `额外关注：${extra}`);
  lines.push('', '最后用一行给出结论，格式：结论：通过 或 结论：有问题 —— <一句话>。');

  const t0 = Date.now();
  const r = await fetch(`${OLLAMA}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt: lines.join('\n'),
      images: [fs.readFileSync(file).toString('base64')],
      stream: false,
      options: { temperature: 0.2, num_predict: 2048 },
    }),
    signal: AbortSignal.timeout(600000),
  });
  const seconds = (Date.now() - t0) / 1000;
  if (!r.ok) return { ok: false, text: `ollama HTTP ${r.status}`, seconds };
  const j = await r.json();
  return { ok: true, text: String(j.response || '').trim(), seconds };
}

// ---------------------------------------------------------------- CLI

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const argv = process.argv.slice(2);
  const f = argv.find((a) => !a.startsWith('--'));
  const model = (() => { const i = argv.indexOf('--model'); return i >= 0 ? argv[i + 1] : 'qwen3.5:27b'; })();
  const want = (() => { const i = argv.indexOf('--want'); return i >= 0 ? argv[i + 1] : ''; })();
  if (!f) { console.error('用法：node cli/look-local.mjs <图> [--model qwen3.5:27b] [--want "它应该是什么"]'); process.exit(2); }

  const up = await ollamaUp();
  if (!up) { console.error('✗ ollama 没跑。启动：ollama serve'); process.exit(2); }

  const focus = [
    '【景别】这张画的是什么景别（远景/全景/中景/近景/特写）？',
    '  全景=能看到完整的人+环境；中景=**切在腰部**；近景=**只取胸部以上**；特写=**只有脸，头部占满**。',
    '【文字】画面里有没有任何文字、水印、字幕？',
    '【崩坏】手、脸、边缘有没有明显坏掉？',
  ];
  console.log(`\n本地视觉：${model}\n看图：${f}`);
  if (want) console.log(`它应该是：${want}`);
  console.log('─'.repeat(66));
  const r = await lookLocal(f, { focus, extra: want ? `它应该是【${want}】` : '', model });
  console.log(r.text);
  console.log('─'.repeat(66));
  console.log(`耗时 ${r.seconds.toFixed(1)} 秒　（本地，0 成本）`);
}
