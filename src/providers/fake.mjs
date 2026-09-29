import fs from 'node:fs';
import path from 'node:path';

/** Deterministic provider used only by offline E2E tests. */
export const name = 'fake';

function write({ outDir, prefix }) {
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${prefix}.png`);
  fs.writeFileSync(file, `fake-image:${prefix}\n`, 'utf8');
  return { files: [file], status: 0, json: { provider: name, deterministic: true } };
}

export async function generate(args) { return write(args); }
export async function edit(args) { return write(args); }
