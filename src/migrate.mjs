#!/usr/bin/env node
/**
 * migrate.mjs — 把旧契约的板子迁到新契约（身份 / 造型分离）。
 *
 *   node src/migrate.mjs <旧 board.json> [--out 新 board.json]
 *
 * 迁移规则：
 *   characters[].appearance  → face_prompt（脸）
 *   characters[].wardrobe    → 新建一个 identity 的 appearance_details（服装）
 *   characters[].ref_image   → portrait（旧版那张是定妆照，当肖像用）
 *   characters[].age（自由文本） → age_group（受控枚举）
 *   scenes[].ref_image       → master
 *   story.beats（字符串）     → { text, purpose, emotion }
 *   shots[].characters       → cast（角色 id 映射到 <角色>_default）
 *   shots[].prompt           → 补 {{identity_id}} 标记
 *
 * 迁移是**有损**的：purpose 只能填占位符，因为旧版根本没记。迁完要人工或重编补上。
 */

import fs from 'node:fs';
import path from 'node:path';
import { ageGroupOf } from './board.mjs';

const argv = process.argv.slice(2);
const src = argv.find((a) => !a.startsWith('--'));
if (!src) {
  console.error('用法：node src/migrate.mjs <旧 board.json> [--out 新 board.json]');
  process.exit(2);
}
const outIdx = argv.indexOf('--out');
const out = outIdx >= 0 ? argv[outIdx + 1] : null;

const old = JSON.parse(fs.readFileSync(src, 'utf8'));
const board = structuredClone(old);

// ---- characters → 身份层；wardrobe 抽成 identities ----
board.identities = [];
for (const c of board.characters || []) {
  const identId = `${c.id}_default`;
  board.identities.push({
    id: identId,
    character: c.id,
    name: '默认造型',
    appearance_details: c.wardrobe || `${c.name}的默认服装（迁移自旧版，需补全）`,
    costume_image: null,
    sheet: c.ref_image || null,
    reference_images: [],
    voice_ref: null,
  });
  const { appearance, wardrobe, ref_image, age, ...rest } = c;
  board.characters[board.characters.indexOf(c)] = {
    ...rest,
    age_group: ageGroupOf(age),
    face_prompt: appearance || `${c.name}的面部特征（迁移自旧版，需补全）`,
    portrait: ref_image || null,
    identities: [identId],
  };
}

// ---- scenes: ref_image → master ----
for (const s of board.scenes || []) {
  if ('ref_image' in s) {
    s.master = s.ref_image;
    delete s.ref_image;
  }
  s.reverse_master = s.reverse_master ?? null;
  s.spatial_layout = s.spatial_layout ?? null;
  if (!s.time_of_day) s.time_of_day = '无';
}

// ---- story.beats: 字符串 → 对象 ----
if (Array.isArray(board.story?.beats)) {
  board.story.beats = board.story.beats.map((b) =>
    typeof b === 'string'
      ? { text: b, purpose: '未标注（迁移自旧版）', emotion: '' }
      : b,
  );
}

// ---- shots: characters → cast；prompt 补标记 ----
const castMap = new Map((board.identities || []).map((x) => [x.character, x.id]));
for (const sh of board.shots || []) {
  const cast = (sh.characters || []).map((cid) => castMap.get(cid) || cid);
  delete sh.characters;
  sh.cast = cast;
  sh.props = sh.props || [];
  // 声明的落幅（画出来的尾帧）。缺省为空 = 该镜仍走 i2v，行为与从前一致。
  sh.last_keyframe = sh.last_keyframe ?? null;
  for (const d of sh.dialogue || []) {
    d.character = castMap.get(d.character) || d.character;
    d.kind = d.kind || 'spoken';
  }
  // 补标记：cast 里没被标记的，补在最前面
  const missing = cast.filter((id) => !String(sh.prompt || '').includes(`{{${id}}}`));
  if (missing.length) sh.prompt = `${missing.map((id) => `{{${id}}}`).join('、')}，${sh.prompt}`;
}

// ---- meta ----
board.meta.music = board.meta.music ?? null;
board.meta.style_prompt = board.meta.style_prompt ?? null;

const target = out || src.replace(/\.json$/i, '.v2.json');
fs.writeFileSync(target, JSON.stringify(board, null, 2) + '\n');
console.log(`已迁移 → ${target}`);
console.log(`  角色 ${board.characters.length}　造型 ${board.identities.length}　场景 ${board.scenes.length}　道具 ${(board.props || []).length}　镜头 ${board.shots.length}`);
