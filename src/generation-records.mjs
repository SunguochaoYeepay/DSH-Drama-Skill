import fs from 'node:fs';
import path from 'node:path';

export function generationRecordPath(projectDir, stage) {
  return path.join(projectDir, 'reviews', `${stage}.generation.json`);
}

export function writeGenerationRecord(projectDir, stage, details) {
  const file = generationRecordPath(projectDir, stage);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const record = { version: 1, stage, at: new Date().toISOString(), ...details };
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return file;
}

export function readGenerationRecord(projectDir, stage) {
  const file = generationRecordPath(projectDir, stage);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}
