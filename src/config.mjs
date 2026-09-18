import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

export function setting(name, fallback) {
  return process.env[name] || fallback;
}

export function advancedModel(name, allowed = ['qwen3.8-max']) {
  const model = setting(name, 'qwen3.8-max');
  if (!allowed.includes(model)) throw new Error(`${name} 必须是已批准的高级模型 ${allowed.join(' / ')}，收到 ${model}`);
  return model;
}

export const SCRIPT_MODEL = advancedModel('AIH_SCRIPT_MODEL');
export const DIRECTOR_MODEL = advancedModel('AIH_DIRECTOR_MODEL', ['qwen3.8-max', 'glm-5.2']);
function positiveInteger(name, fallback) {
  const value = Number(setting(name, fallback));
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} 必须是正整数`);
  return value;
}
export const SCRIPT_MAX_OUTPUT_TOKENS = positiveInteger('AIH_SCRIPT_MAX_OUTPUT_TOKENS', '6000');
export const DIRECTOR_MAX_OUTPUT_TOKENS = positiveInteger('AIH_DIRECTOR_MAX_OUTPUT_TOKENS', '12000');
export const BAILIAN_TEXT_TIMEOUT_SECONDS = positiveInteger('AIH_BAILIAN_TEXT_TIMEOUT_SECONDS', '600');
export const ASSET_PROVIDER = setting('AIH_ASSET_PROVIDER', 'bailian');
export const KEYFRAME_PROVIDER = setting('AIH_KEYFRAME_PROVIDER', 'bailian');
export const VOLCENGINE_IMAGE_MODEL = setting('AIH_VOLCENGINE_IMAGE_MODEL', 'doubao-seedream-4-5-251128');
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
