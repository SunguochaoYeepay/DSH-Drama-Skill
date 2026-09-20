#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONTRACT_FILE, readCinematography, lensMmFor, opticsBlock, lightingBlock,
  styleHeader, negativesBlock, compileCinematography, rulesBlock,
} from '../src/cinematography.mjs';
import { buildUnitPrompt } from '../src/h3-prompt.mjs';
import { portraitPrompt, sheetInstruction, masterPrompt, assetPlan } from '../src/assets.mjs';

// ---------------------------------------------------------------- 契约缺失

test('契约缺失时四层全部为空 —— 老剧目的提示词一个字都不该多', () => {
  const block = compileCinematography(null, { shot: { framing: '中景' }, framing: '中景' });
  assert.equal(block.header, null);
  assert.equal(block.negatives, null);
  assert.equal(block.optics, null);
  assert.equal(block.lighting, null);
});

test('契约是个空对象时同样什么都不输出', () => {
  const block = compileCinematography({}, { shot: {}, framing: '特写' });
  assert.equal(block.header, null);
  assert.equal(block.optics, null);
  assert.equal(block.lighting, null);
});

// ---------------------------------------------------------------- 不静默猜默认值

test('契约没写的字段一个字都不补 —— 没有 camera_height 就不出现「机位」', () => {
  const block = opticsBlock({ lens_mm: 50, depth_of_field: '浅景深' }, {}, '中景');
  assert.match(block, /50mm/);
  assert.match(block, /浅景深/);
  assert.doesNotMatch(block, /机位/);
});

test('lens_mm 表既没有当前景别也没有 default 时，不给焦段', () => {
  assert.equal(lensMmFor({ lens_mm: { 特写: 85 } }, '中景'), null);
});

// ---------------------------------------------------------------- 焦段优先级

test('焦段：每镜覆盖 > 景别映射 > 全片默认', () => {
  const contract = { lens_mm: { default: 35, 近景: 85 } };
  assert.equal(lensMmFor(contract, '中景'), 35);
  assert.equal(lensMmFor(contract, '近景'), 85);
  assert.equal(lensMmFor(contract, '特写', { optics: { lens_mm: 100 } }), 100);
});

test('lens_mm 写成单个数字时全片一个焦段', () => {
  assert.equal(lensMmFor({ lens_mm: 40 }, '特写'), 40);
});

// ---------------------------------------------------------------- 光

test('lighting_setup 逐项覆盖，未写的项仍继承契约', () => {
  const contract = { lighting: { quality: '柔和散射', temperature: '暖调 3200K' } };
  const block = lightingBlock(contract, { lighting_setup: { quality: '硬光' } });
  assert.match(block, /光质：硬光/);
  assert.match(block, /色温：暖调 3200K/);
});

test('光的字段按固定顺序输出，不随写法变化', () => {
  const a = lightingBlock({ lighting: { temperature: '暖调', quality: '柔和' } }, {});
  const b = lightingBlock({ lighting: { quality: '柔和', temperature: '暖调' } }, {});
  assert.equal(a, b);
});

// ---------------------------------------------------------------- 风格头与排除

test('风格头逐字返回，不做任何加工', () => {
  const header = '电影级写实摄影，青绿与暖阳金主色调';
  assert.equal(styleHeader({ style_header: header }), header);
  assert.equal(styleHeader({ style_header: '  ' }), null);
});

test('风格排除去重，且契约项排在调用方自带项之前', () => {
  const block = negativesBlock({ negatives: ['水彩', '线稿', '水彩'] }, ['字幕']);
  assert.equal(block, '【风格排除】不得出现：水彩、线稿、字幕。');
});

// ---------------------------------------------------------------- 读写

test('契约文件不存在返回 null；坏 JSON 必须抛而不是静默吞掉', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cine-'));
  assert.equal(readCinematography(dir), null);
  fs.writeFileSync(path.join(dir, CONTRACT_FILE), '{ 这不是 json');
  assert.throws(() => readCinematography(dir), /无法解析/);
});

test('能读回写进去的契约', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cine-'));
  fs.writeFileSync(path.join(dir, CONTRACT_FILE), JSON.stringify({ lens_mm: 85, style_header: '写实' }));
  const contract = readCinematography(dir);
  assert.equal(contract.lens_mm, 85);
  assert.equal(styleHeader(contract), '写实');
});

// ---------------------------------------------------------------- 进视频提示词

const board = {
  meta: { music: null },
  characters: [{ id: 'c1', name: '阿宁', face_prompt: '圆脸，黑色长发' }],
  identities: [{ id: 'c1_home', character: 'c1', appearance_details: '蓝色家居服' }],
};
const unit = {
  shots: [{
    at: 0,
    framing: '中景',
    camera: '固定',
    on_screen: ['c1_home'],
    facing: { c1_home: 'toward' },
    action: '阿宁听见响声，转头看向门口',
    lighting: '柔光',
    audio: '室内环境音',
    lines: [],
  }],
};
const ctx = {
  board,
  scene: { environment: '安静客厅' },
  hasFirstFrame: true,
  nameOf: () => '阿宁',
  lineText: new Map(),
};

test('摄影契约进视频提示词：风格头在逐镜描述之前，镜头与光进本镜', () => {
  const contract = {
    style_header: '电影级写实摄影',
    negatives: ['水彩'],
    lens_mm: { default: 35, 中景: 50 },
    lighting: { quality: '柔和散射' },
  };
  const prompt = buildUnitPrompt(unit, { ...ctx, refs: [], contract });
  const body = prompt.split('integrated_multimodal_description:')[1].trim();
  // 风格头必须是逐镜描述的第一行 —— 改写过的前缀等于没有前缀。
  assert.ok(body.startsWith('电影级写实摄影'), `风格头没在最前：${body.slice(0, 40)}`);
  assert.match(body, /Style negatives: NEVER 水彩\./);
  assert.match(body, /Lens and framing: 50mm lens/);
  assert.match(body, /light quality: 柔和散射/);
});

test('没有契约时视频提示词保持原样，不出现任何摄影层措辞', () => {
  const prompt = buildUnitPrompt(unit, { ...ctx, refs: [] });
  assert.doesNotMatch(prompt, /Lens and framing/);
  assert.doesNotMatch(prompt, /Style negatives/);
  assert.doesNotMatch(prompt, /Lighting: /);
});

test('每镜 optics 覆盖在视频提示词里也生效', () => {
  const contract = { lens_mm: { default: 35 } };
  const override = structuredClone(unit);
  override.shots[0].optics = { lens_mm: 135, depth_of_field: '极浅景深' };
  const prompt = buildUnitPrompt(override, { ...ctx, refs: [], contract });
  assert.match(prompt, /135mm lens/);
  assert.match(prompt, /极浅景深/);
  // 不能只写 /35mm lens/ —— "135mm lens" 里同样含这个子串，那样断言会假红。
  assert.doesNotMatch(prompt, /Lens and framing: 35mm/);
});

// ---------------------------------------------------------------- 进资产

const assetBoard = {
  meta: { style: 'realistic', style_prompt: '清晨暖光，木质家具', aspect: '16:9' },
  characters: [{ id: 'c1', name: '阿宁', face_prompt: '圆脸，黑色长发', age_group: 'youth' }],
  identities: [{ id: 'c1_home', character: 'c1', appearance_details: '蓝色家居服' }],
  scenes: [{ id: 's1', name: '客厅', environment: '安静的客厅，木质地板' }],
  props: [{ id: 'p1', name: '手机', description: '黑色直板手机' }],
};

const contract = {
  style_header: '电影级写实摄影，青绿与暖阳金主色调',
  negatives: ['水彩', '线稿'],
  lens_mm: { default: 35, 特写: 85, 全景: 50, 远景: 24 },
  lighting: { key_direction: '左上方 45 度', temperature: '暖调 3200K' },
};

test('没有契约时资产提示词一个字都不变', () => {
  const ch = assetBoard.characters[0];
  const x = assetBoard.identities[0];
  const s = assetBoard.scenes[0];
  assert.equal(portraitPrompt(assetBoard, ch, null), portraitPrompt(assetBoard, ch));
  assert.equal(sheetInstruction(assetBoard, x, null), sheetInstruction(assetBoard, x));
  assert.equal(masterPrompt(assetBoard, s, null), masterPrompt(assetBoard, s));
  assert.doesNotMatch(portraitPrompt(assetBoard, ch), /风格排除/);
});

test('肖像吃排除项与焦段，但绝不进风格头与光 —— 锚点必须中性', () => {
  const p = portraitPrompt(assetBoard, assetBoard.characters[0], contract);
  assert.match(p, /【风格排除】不得出现：水彩、线稿。/);
  assert.match(p, /【镜头】85mm/);       // 肖像＝特写
  assert.doesNotMatch(p, /电影级写实摄影/);
  assert.doesNotMatch(p, /主光方向/);
});

test('身份图同样只吃排除项与焦段，且焦段按"全景"取', () => {
  const ins = sheetInstruction(assetBoard, assetBoard.identities[0], contract);
  assert.match(ins, /【风格排除】不得出现：水彩、线稿。/);
  assert.match(ins, /【镜头】50mm/);
  assert.doesNotMatch(ins, /暖阳金主色调/);
});

test('场景主图是画面不是锚 —— 风格头、排除项、焦段、光全吃', () => {
  const m = masterPrompt(assetBoard, assetBoard.scenes[0], contract);
  assert.ok(m.startsWith('电影级写实摄影'), `风格头没在最前：${m.slice(0, 40)}`);
  assert.match(m, /不得出现：水彩、线稿。/);
  assert.match(m, /【镜头】24mm/);       // 场景主图＝远景
  assert.match(m, /主光方向：左上方 45 度/);
  assert.match(m, /色温：暖调 3200K/);
});

test('道具不吃任何摄影层 —— 它自带写实产品静物配方', () => {
  const withContract = assetPlan(assetBoard, { contract });
  const prop = withContract.find((j) => j.kind === 'prop_3view');
  assert.doesNotMatch(prop.prompt, /风格排除/);
  assert.doesNotMatch(prop.prompt, /【镜头】/);
  assert.doesNotMatch(prop.prompt, /电影级写实摄影/);
});

test('每类资产可在 contract.assets.<kind> 里覆盖镜头', () => {
  const override = { ...contract, assets: { portrait: { optics: { lens_mm: 105, depth_of_field: '极浅景深' } } } };
  const p = portraitPrompt(assetBoard, assetBoard.characters[0], override);
  assert.match(p, /105mm/);
  assert.match(p, /极浅景深/);
  // 只覆盖 portrait，sheet 仍走全片表
  assert.match(sheetInstruction(assetBoard, assetBoard.identities[0], override), /【镜头】50mm/);
});

// ---------------------------------------------------------------- 全片物理规则

test('契约没写 rules 时提示词里不出现任何规则层', () => {
  assert.equal(rulesBlock({ style_header: '写实' }), null);
  assert.equal(compileCinematography({ lens_mm: 50 }, { shot: {} }).rules, null);
  assert.doesNotMatch(buildUnitPrompt(unit, { ...ctx, refs: [], contract: { lens_mm: 50 } }), /Global rules/);
});

test('全片规则每镜都带，格式是「Global rules: - id: 文本」', () => {
  const contract = { rules: [{ id: 'shadow', text: '所有影子投向主光反方向' }] };
  const prompt = buildUnitPrompt(unit, { ...ctx, refs: [], contract });
  assert.match(prompt, /Global rules:\n- shadow: 所有影子投向主光反方向/);
});

test('本镜覆盖只翻转本镜，下一镜照旧拿契约原文', () => {
  const contract = { rules: [{ id: 'shadow', text: '所有影子投向主光反方向' }] };
  const two = structuredClone(unit);
  two.shots.push({ ...two.shots[0], at: 4, framing: '近景', rule_overrides: { shadow: '本镜例外：影子投向镜头方向' } });
  const prompt = buildUnitPrompt(two, { ...ctx, refs: [], contract });
  const [first, second] = prompt.split('[Shot 2]');
  assert.match(first, /- shadow: 所有影子投向主光反方向/);
  assert.match(second, /- shadow: 本镜例外：影子投向镜头方向/);
  assert.doesNotMatch(second, /所有影子投向主光反方向/);
});

test('覆盖写成空串 = 本镜不适用这条，其余条仍在', () => {
  const contract = {
    rules: [
      { id: 'shadow', text: '所有影子投向主光反方向' },
      { id: 'scale', text: '老鼠不得超过猫的五分之一' },
    ],
  };
  const block = rulesBlock(contract, { rule_overrides: { shadow: '' } });
  assert.doesNotMatch(block, /shadow/);
  assert.match(block, /scale：老鼠不得超过猫的五分之一/);
});

test('没有 id 的规则会被跳过 —— 不能被覆盖的就不是可翻转的规则', () => {
  const block = rulesBlock({ rules: [{ text: '没有 id 的规则' }, { id: 'ok', text: '有 id' }] }, {});
  assert.doesNotMatch(block, /没有 id 的规则/);
  assert.match(block, /· ok：有 id/);
});

test('规则不进资产 —— 空镜提示词里出现卡司词等于给模型递词表', () => {
  const contract = {
    style_header: '写实',
    rules: [{ id: 'scale', text: '老鼠不得超过猫的五分之一' }],
  };
  assert.doesNotMatch(masterPrompt(assetBoard, assetBoard.scenes[0], contract), /老鼠/);
  assert.doesNotMatch(portraitPrompt(assetBoard, assetBoard.characters[0], contract), /老鼠/);
});

// 只守住**接缝**：摄影层自带句号，直接进「，」拼接会造出「。，」。
// 正文里原有的「。，」（比如肖像构图那条规则本身就以句号收尾）是另一件事，不在本轮范围。
test('摄影层与正文的接缝不出现「。，」', () => {
  const seam = /不得出现：水彩、线稿。，/;
  assert.doesNotMatch(portraitPrompt(assetBoard, assetBoard.characters[0], contract), seam);
  assert.doesNotMatch(sheetInstruction(assetBoard, assetBoard.identities[0], contract), seam);
  assert.doesNotMatch(masterPrompt(assetBoard, assetBoard.scenes[0], contract), seam);
});
