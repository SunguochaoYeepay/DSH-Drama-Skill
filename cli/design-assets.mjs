#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { buildSceneDesign, buildCharacterDesign, designReceipt } from '../src/asset-designers.mjs';
import { installCliErrorHandler } from '../src/cli-errors.mjs';

installCliErrorHandler();
const argv = process.argv.slice(2);
const value = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; };
const boardPath = path.resolve(argv.find((x) => x.endsWith('.json') && !x.startsWith('--')) || '');
const out = path.resolve(value('out') || path.join(path.dirname(boardPath), 'asset-design.json'));
if (!boardPath || !fs.existsSync(boardPath)) throw new Error('用法：node cli/design-assets.mjs <board.json> [--out asset-design.json]');
const project = path.dirname(boardPath);
const board = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
const designs = [
  ...(board.scenes || []).map((scene) => buildSceneDesign(board, scene)),
  ...(board.identities || []).map((identity) => buildCharacterDesign(board, (board.characters || []).find((c) => c.id === identity.character), identity)),
];
const receipt = designs.map((design) => designReceipt({ design, directorPath: path.join(project, 'board.direction.json'), boardPath }));
fs.writeFileSync(out, JSON.stringify({ contract: 1, designs, receipt }, null, 2) + '\n', 'utf8');
console.log(`资产专业方案：${out}\n场景 ${designs.filter((x) => x.kind === 'scene_design').length} 个，人物造型 ${designs.filter((x) => x.kind === 'character_design').length} 个\n状态：等待导演审核，未生成图片`);
