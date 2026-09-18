import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

export function setting(name, fallback) {
  return process.env[name] || fallback;
}

export function advancedModel(name) {
  const model = setting(name, 'qwen3.8-max');
  if (model !== 'qwen3.8-max') throw new Error(`${name} 必须是已批准的高级模型 qwen3.8-max，收到 ${model}`);
  return model;
}

export const SCRIPT_MODEL = advancedModel('AIH_SCRIPT_MODEL');
export const DIRECTOR_MODEL = advancedModel('AIH_DIRECTOR_MODEL');
export const ASSET_PROVIDER = setting('AIH_ASSET_PROVIDER', 'bailian');
export const KEYFRAME_PROVIDER = setting('AIH_KEYFRAME_PROVIDER', 'bailian');
export const ASSET_IMAGE_MODEL = setting('AIH_ASSET_IMAGE_MODEL', 'qwen-image-3.0');
export const KEYFRAME_IMAGE_MODEL = setting('AIH_KEYFRAME_IMAGE_MODEL', 'qwen-image-3.0-pro');
export const HUIMENG_IMAGE_MODEL = setting('AIH_HUIMENG_IMAGE_MODEL', 'image-2-official');
export const KEYFRAME_SIZE = setting('AIH_KEYFRAME_SIZE', '2k');
export const BAILIAN_KEYFRAME_SIZE = setting('AIH_BAILIAN_KEYFRAME_SIZE', '1024*1792');
export const LOCAL_IMAGE_STEPS = setting('AIH_LOCAL_IMAGE_STEPS', '20');
export const LOCAL_IMAGE_CFG = setting('AIH_LOCAL_IMAGE_CFG', '4');
export const VIDEO_QUALITY = setting('AIH_VIDEO_QUALITY', 'normal');
export const VIDEO_PROFILE = setting('AIH_VIDEO_PROFILE', 'fast');
export const VIDEO_ATTENTION = setting('AIH_VIDEO_ATTENTION', 'vsa').toLowerCase();
if (!['sage', 'vsa'].includes(VIDEO_ATTENTION)) {
  throw new Error('AIH_VIDEO_ATTENTION 只能是 sage / vsa');
}
export const VIDEO_NORMAL_SIZE = setting('AIH_VIDEO_NORMAL_SIZE', '480x864');
export const VIDEO_HIGH_SIZE = setting('AIH_VIDEO_HIGH_SIZE', '768x1344');
export const VIDEO_TIMEOUT_SECONDS = Number(setting('AIH_VIDEO_TIMEOUT_SECONDS', '600'));
if (!Number.isInteger(VIDEO_TIMEOUT_SECONDS) || VIDEO_TIMEOUT_SECONDS < 1 || VIDEO_TIMEOUT_SECONDS > 600) {
  throw new Error('AIH_VIDEO_TIMEOUT_SECONDS 必须在 1 到 600 秒之间');
}
