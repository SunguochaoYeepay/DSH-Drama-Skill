import fs from 'node:fs';
import path from 'node:path';

export function keyframeOverridesPath(projectDir) {
  return path.join(projectDir, 'reviews', 'keyframe-overrides.json');
}

export function readKeyframeOverride(projectDir, unitId) {
  const file = keyframeOverridesPath(projectDir);
  if (!fs.existsSync(file)) return '';
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const value = data?.units?.[unitId];
  return typeof value === 'string' ? value.trim() : '';
}
