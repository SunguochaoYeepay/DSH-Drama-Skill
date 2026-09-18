import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from './script-provenance.mjs';
import { DIRECTOR_MODEL } from './config.mjs';

export function directionReceiptPath(directionPath) {
  return `${path.resolve(directionPath)}.provenance.json`;
}

export function writeDirectionReceipt({ directionPath, boardPath, storyPath, model, responseModel }) {
  if (model !== DIRECTOR_MODEL || responseModel !== DIRECTOR_MODEL) throw new Error('导演模型来源不能核验');
  const receipt = {
    contract: 1, provider: 'bailian', model, response_model: responseModel,
    board_sha256: sha256(fs.readFileSync(boardPath)),
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
  for (const [name, target] of [['board', boardPath], ['story', storyPath], ['direction', directionPath]]) {
    if (receipt[`${name}_sha256`] !== sha256(fs.readFileSync(target))) throw new Error(`导演来源票据失效：${name} 已变化`);
  }
  return receipt;
}
