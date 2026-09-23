import crypto from 'node:crypto';
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

/**
 * 修订时**旧票的归档位**：`story.provenance.v<N>.json`。
 *
 * 为什么归档而不是覆盖：剧本改一个字，来源票的 `story_sha256` 就对不上，
 * 下游的人门票全部失效。此前没有修订入口，只能手删票重建 —— 于是**修订史整个丢失**，
 * 谁也答不出"这版剧本改了什么、从哪版改来"。归档让链条可回溯。
 */
export function archiveReceiptPath(storyPath, revision) {
  return path.join(path.dirname(path.resolve(storyPath)), `story.provenance.v${revision || 1}.json`);
}

/**
 * 剧本来源票据。
 *
 * 三种来源互斥，**任何一种都不得冒充另一种**：
 *   - `bailian`       模型产物：必须记录请求与响应模型，且两者一致。
 *   - `user_supplied` 用户原稿：不得声明模型，且必须有 `--confirmed-by` 人工确认。
 *   - `agent_draft`   Agent 在对话里直写：同样不得声明模型，由 `drafted_by` 留痕。
 *
 * `agent_draft` 绑定的是**对话**而不是模型响应 —— 它没有可核验的响应体，
 * 所以票据里 `model` / `response_model` 一律为 null，改一个字就重新登记。
 */
export function makeScriptReceipt({ story, input, source, model = null, responseModel = null, draftedBy = null }) {
  if (!['bailian', 'user_supplied', 'agent_draft'].includes(source)) throw new Error(`未知剧本来源：${source}`);
  if (source === 'bailian' && (!model || model !== responseModel)) throw new Error('剧本请求与响应模型必须一致且非空');
  if (source === 'user_supplied' && model !== null) throw new Error('用户原稿不能标记模型');
  if (source === 'agent_draft') {
    if (model !== null || responseModel !== null) throw new Error('Agent 直写稿不能标记模型');
    if (!draftedBy) throw new Error('Agent 直写稿必须声明 drafted_by');
  }
  return {
    contract: 1,
    source,
    model,
    response_model: responseModel,
    ...(source === 'agent_draft' ? { drafted_by: draftedBy } : {}),
    input_sha256: sha256(input),
    story_sha256: sha256(story),
    recorded_at: new Date().toISOString(),
  };
}
