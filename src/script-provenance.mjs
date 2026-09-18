import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SCRIPT_MODEL } from './config.mjs';

export { SCRIPT_MODEL };
export const SCRIPT_RECEIPT = 'story.provenance.json';

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function receiptPath(storyPath) {
  return path.join(path.dirname(path.resolve(storyPath)), SCRIPT_RECEIPT);
}

export function makeScriptReceipt({ story, input, source, model = null, responseModel = null }) {
  if (!['bailian', 'user_supplied'].includes(source)) throw new Error(`未知剧本来源：${source}`);
  if (source === 'bailian' && (model !== SCRIPT_MODEL || responseModel !== SCRIPT_MODEL)) throw new Error(`剧本请求与响应模型都必须是 ${SCRIPT_MODEL}`);
  if (source === 'user_supplied' && model !== null) throw new Error('用户原稿不能标记模型');
  return {
    contract: 1,
    source,
    model,
    response_model: responseModel,
    input_sha256: sha256(input),
    story_sha256: sha256(story),
    recorded_at: new Date().toISOString(),
  };
}

export function requireScriptProvenance(storyPath) {
  const receiptFile = receiptPath(storyPath);
  if (!fs.existsSync(receiptFile)) {
    throw new Error(`剧本来源未登记：${receiptFile}；模型创作请用 cli/script.mjs generate，用户原稿请经用户确认后登记`);
  }
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  if (receipt.contract !== 1 || !['bailian', 'user_supplied'].includes(receipt.source)) {
    throw new Error('剧本来源票据格式无效');
  }
  if (receipt.source === 'bailian' && (receipt.model !== SCRIPT_MODEL || receipt.response_model !== SCRIPT_MODEL)) {
    throw new Error(`剧本来源模型不是 ${SCRIPT_MODEL}`);
  }
  if (receipt.source === 'user_supplied' && receipt.model !== null) {
    throw new Error('用户原稿来源票据不能声明模型');
  }
  if (receipt.story_sha256 !== sha256(fs.readFileSync(storyPath))) {
    throw new Error('剧本已变化，来源票据失效；须重新生成或由用户重新确认原稿');
  }
  if (!/^[a-f0-9]{64}$/.test(receipt.input_sha256 || '')) {
    throw new Error('剧本来源票据缺少输入哈希');
  }
  return receipt;
}
