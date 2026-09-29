import { normalizeImageResult } from './providers/contract.mjs';

function delay(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

async function withTimeout(promise, timeoutMs) {
  if (!timeoutMs) return promise;
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`超时（${timeoutMs}ms）`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Run one provider operation with explicit, bounded retries.
 * Retries are opt-in so existing production runs keep their current cost and
 * timing. A result with no files or a non-zero status is treated as retryable.
 */
export async function runImageJob(provider, operation, args, options = {}) {
  const retries = Math.max(0, Math.floor(Number(options.retries ?? 0)) || 0);
  const timeoutMs = Math.max(0, Number(options.timeoutMs ?? 0) || 0);
  const backoffMs = Math.max(0, Number(options.backoffMs ?? 0) || 0);
  if (!provider || typeof provider[operation] !== 'function') {
    throw new Error(`provider 不支持图片操作 ${operation}`);
  }

  const errors = [];
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    const started = Date.now();
    let result;
    try {
      const pending = Promise.resolve(provider[operation](args));
      result = await withTimeout(pending, timeoutMs);
      result = normalizeImageResult(result, { provider: provider.name, operation });
    } catch (error) {
      const message = String(error?.message || error);
      errors.push(message);
      options.onEvent?.({ run_id: options.runId, provider: provider.name, operation, attempt, status: null, ok: false, duration_ms: Date.now() - started, error: message });
      if (attempt <= retries) await delay(backoffMs);
      continue;
    }

    const failed = result.status != null && result.status !== 0 || result.files.length === 0;
    if (!failed) {
      options.onEvent?.({ run_id: options.runId, provider: provider.name, operation, attempt, status: result.status, ok: true, duration_ms: Date.now() - started });
      return { ...result, attempts: attempt, retry_errors: errors };
    }
    errors.push(result.stderr || `未产出文件（exit ${result.status}）`);
    options.onEvent?.({ run_id: options.runId, provider: provider.name, operation, attempt, status: result.status, ok: false, duration_ms: Date.now() - started, error: errors.at(-1) });
    if (attempt <= retries) await delay(backoffMs);
  }

  return {
    files: [],
    status: 1,
    attempts: retries + 1,
    retry_errors: errors,
    error: errors.at(-1) || '图片生成失败',
  };
}
