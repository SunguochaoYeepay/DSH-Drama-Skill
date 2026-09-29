import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function executionLogPath(projectDir) {
  return path.join(projectDir, 'reviews', 'execution.jsonl');
}

export function writeExecutionEvent(projectDir, event = {}) {
  const row = {
    at: new Date().toISOString(),
    run_id: event.run_id || crypto.randomUUID(),
    provider: event.provider || 'unknown',
    operation: event.operation || 'unknown',
    attempt: Number(event.attempt) || 1,
    status: event.status ?? null,
    duration_ms: Number(event.duration_ms) || 0,
    ok: Boolean(event.ok),
    ...(event.error ? { error: String(event.error).slice(0, 1000) } : {}),
  };
  const file = executionLogPath(projectDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
  return file;
}

export function readExecutionEvents(projectDir) {
  const file = executionLogPath(projectDir);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}
