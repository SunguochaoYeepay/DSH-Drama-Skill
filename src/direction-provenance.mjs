import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from './script-provenance.mjs';

export function directionReceiptPath(directionPath) {
  return `${path.resolve(directionPath)}.provenance.json`;
}

// Resource files are generated after direction approval. They are deliberately
// excluded from the director input identity; their own hashes are held by the
// assets approval ticket.
export function directorBoardView(board) {
  const volatile = new Set(['portrait', 'sheet', 'master', 'ref_image', 'first_frame', 'last_frame', 'clip']);
  const walk = (value, key = '') => {
    if (Array.isArray(value)) return value.map((item) => walk(item, key));
    if (!value || typeof value !== 'object') return value;
    const out = {};
    for (const [name, child] of Object.entries(value)) {
      if (volatile.has(name)) continue;
      if (key === 'meta' && ['approvals', 'stage', 'final_video'].includes(name)) continue;
      out[name] = walk(child, name);
    }
    return out;
  };
  return walk(board);
}

function boardIdentity(boardPath) {
  return sha256(Buffer.from(JSON.stringify(directorBoardView(JSON.parse(fs.readFileSync(boardPath, 'utf8'))))));
}

export function writeDirectionReceipt({ directionPath, boardPath, storyPath, model, responseModel, provider = 'bailian' }) {
  if (!model || model !== responseModel) throw new Error('导演请求与响应模型必须一致且非空');
  const receipt = {
    contract: 1, provider, model, response_model: responseModel,
    board_sha256: sha256(fs.readFileSync(boardPath)),
    board_identity_sha256: boardIdentity(boardPath),
    story_sha256: sha256(fs.readFileSync(storyPath)),
    direction_sha256: sha256(fs.readFileSync(directionPath)),
    recorded_at: new Date().toISOString(),
  };
  fs.writeFileSync(directionReceiptPath(directionPath), JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}

/**
 * Agent 在对话里直写导演稿的来源票 —— 与剧本的 `agent_draft` 对称。
 *
 * 与 `writeDirectionReceipt` 的唯一区别：**没有模型响应可核验**，所以
 * `model` / `response_model` 都是 `null`，作者由 `authored_by` 声明。
 * **两条来源不得互相冒充**：真的调了模型就必须走 `writeDirectionReceipt`。
 *
 * 票据只作留痕（见 `src/plan-provenance.mjs` 的「有票就记哈希，没有票也不拦」），
 * 能不能进入下一阶段仍只由人工票决定。
 */
export function writeAgentDirectionReceipt({ directionPath, boardPath, storyPath, authoredBy = 'agent' }) {
  const author = String(authoredBy || '').trim();
  if (!author) throw new Error('Agent 直写导演稿必须声明 authored_by');
  const receipt = {
    contract: 1, provider: 'agent_draft', model: null, response_model: null, authored_by: author,
    board_sha256: sha256(fs.readFileSync(boardPath)),
    board_identity_sha256: boardIdentity(boardPath),
    story_sha256: sha256(fs.readFileSync(storyPath)),
    direction_sha256: sha256(fs.readFileSync(directionPath)),
    recorded_at: new Date().toISOString(),
  };
  fs.writeFileSync(directionReceiptPath(directionPath), JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}
