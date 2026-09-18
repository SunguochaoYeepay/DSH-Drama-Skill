import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from './script-provenance.mjs';
import { DIRECTOR_MODEL } from './config.mjs';

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

export function writeDirectionReceipt({ directionPath, boardPath, storyPath, model, responseModel }) {
  if (model !== DIRECTOR_MODEL || responseModel !== DIRECTOR_MODEL) throw new Error('导演模型来源不能核验');
  const receipt = {
    contract: 1, provider: 'bailian', model, response_model: responseModel,
    board_sha256: sha256(fs.readFileSync(boardPath)),
    board_identity_sha256: boardIdentity(boardPath),
    story_sha256: sha256(fs.readFileSync(storyPath)),
    direction_sha256: sha256(fs.readFileSync(directionPath)),
    recorded_at: new Date().toISOString(),
  };
  fs.writeFileSync(directionReceiptPath(directionPath), JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}

export function requireDirectionProvenance({ directionPath, boardPath, storyPath }) {
  const file = directionReceiptPath(directionPath);
  if (!fs.existsSync(file)) throw new Error(`导演来源未登记：${file}；旧导演稿不能倒填，请重新调用高级模型`);
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (receipt.contract !== 1 || receipt.provider !== 'bailian' || receipt.model !== DIRECTOR_MODEL || receipt.response_model !== DIRECTOR_MODEL) {
    throw new Error('导演来源模型不是已批准的高级模型');
  }
  if (receipt.board_identity_sha256) {
    if (receipt.board_identity_sha256 !== boardIdentity(boardPath)) throw new Error('导演来源票据失效：board 语义内容已变化');
  } else if (receipt.board_sha256 !== sha256(fs.readFileSync(boardPath))) {
    // One-time compatibility path for receipts created before resource fields
    // were separated from the director input. Keep the old hash for audit.
    receipt.board_identity_sha256 = boardIdentity(boardPath);
    receipt.migrated_at = new Date().toISOString();
    receipt.migration = 'legacy-full-board-hash-to-director-input-identity';
    fs.writeFileSync(file, JSON.stringify(receipt, null, 2) + '\n');
  }
  for (const [name, target] of [['story', storyPath], ['direction', directionPath]]) {
    if (receipt[`${name}_sha256`] !== sha256(fs.readFileSync(target))) throw new Error(`导演来源票据失效：${name} 已变化`);
  }
  return receipt;
}
