#!/usr/bin/env node
/**
 * 导演稿的 **Agent 直写登记入口** —— 与 `cli/script.mjs register-agent` 对称。
 *
 * 草稿由对话里的 Agent 按 `references/director/brief.md` + `references/director/schema.md`
 * 的契约写出；这里只做三件事：**校验是合法 JSON → 落到项目 → 留来源票**，不调任何模型。
 *
 * 为什么需要它：纯本地跑时没有可调的高级导演模型，而来源留痕不能因此丢。
 * 票据记 `provider: agent_draft` / `model: null` / `authored_by`，**不得冒充模型产物**。
 *
 * 用法：
 *   node cli/register-direction.mjs <board.json> --input <导演稿草稿.json>
 *        [--out board.direction.json] [--story story.md] [--authored-by <标识>]
 *        [--skip-gate]（**仅限调试**，跳过剧本人工确认）
 *   `--out` 与 `--input` 相同时只补票据，不搬文件。
 *
 * 与 `cli/direct.mjs` 一样**先查剧本人工票**：导演稿基于剧本，剧本没确认就写导演稿等于白干。
 */
import fs from 'node:fs';
import path from 'node:path';
import { installCliErrorHandler } from '../src/cli-errors.mjs';
import { requireApproval } from '../src/human-gates.mjs';
import { writeAgentDirectionReceipt } from '../src/direction-provenance.mjs';

installCliErrorHandler();

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? null : argv[i + 1];
};
const boardArg = argv.find((x) => /board\.json$/i.test(x) && !x.startsWith('--'));
const inputArg = flag('input');
if (!boardArg || !inputArg) {
  console.error('用法：node cli/register-direction.mjs <board.json> --input <导演稿草稿.json> [--out board.direction.json] [--story story.md] [--authored-by <标识>]');
  process.exit(2);
}

const boardPath = path.resolve(boardArg);
const projectDir = path.dirname(boardPath);
const storyPath = path.resolve(flag('story') || path.join(projectDir, 'story.md'));
const output = path.resolve(flag('out') || path.join(projectDir, 'board.direction.json'));
const inputPath = path.resolve(inputArg);

if (!fs.existsSync(boardPath)) throw new Error(`找不到板子：${boardPath}`);
if (!fs.existsSync(storyPath)) throw new Error(`找不到剧本：${storyPath}`);
if (!fs.existsSync(inputPath)) throw new Error(`找不到导演稿草稿：${inputPath}`);

// 与 cli/direct.mjs 对齐：剧本未经人工确认，不得进入导演阶段。
requireApproval(projectDir, 'story', [storyPath], { skip: argv.includes('--skip-gate') });

const raw = fs.readFileSync(inputPath, 'utf8');
let direction;
try {
  direction = JSON.parse(raw);
} catch (error) {
  throw new Error(`导演稿草稿不是合法 JSON：${error.message}`);
}
if (!direction || typeof direction !== 'object' || Array.isArray(direction)) {
  throw new Error('导演稿草稿必须是 JSON 对象');
}
if (!Array.isArray(direction.units) || !direction.units.length) {
  throw new Error('导演稿草稿必须含非空的 units 数组');
}

fs.mkdirSync(path.dirname(output), { recursive: true });
if (path.resolve(output) !== inputPath) {
  fs.writeFileSync(output, JSON.stringify(direction, null, 2) + '\n', 'utf8');
}

// 契约要求每个单元写清「这一单元开始时，观众知道什么、角色知道什么」（`audience_knows`）。
//
// **只提示、不阻断** —— 这是刻意的：本工程已取消机器契约校验，「唯一把关的是人工审阅」。
// 硬性必填会把闸门重新搬回机器手里，而这里真正要的只是**让缺项在登记这一刻被看见** ——
// 悬念与因果在文本上读不出来，它唯一的落点就是导演稿的这一个字段。
const missingKnows = (direction.units || [])
  .map((u, i) => (!String(u?.audience_knows || '').trim() ? (u?.id || `units[${i}]`) : null))
  .filter(Boolean);
if (missingKnows.length) {
  console.warn(`⚠ ${missingKnows.length} 个单元没写 audience_knows（观众/角色各自知道什么）：${missingKnows.join('、')}`);
  console.warn('  它是「意外有没有来路、悬念成不成立」唯一的落点，契约见 references/director/schema.md 的 units[] 字段表。');
}

// ── 镜头落错场景的启发式警告（2026-09-20 no_chute 事故）──────────────────────
//
// 事故：u1 的镜头内容是「敞开的机舱门洞内两人并排站着」，但 `shot.scene` 写的是
// `altitude_ext`（高空、从机外看飞机）。板子只校验 `scene` id 存不存在，不校验语义，
// 于是这一路绿灯走到出图：关键帧的基底图取的是「机外看飞机、门洞是暗的」那张，
// 与「门洞最亮、人在门洞里」的要求正好相反 —— 结果画面是一架**门关着的飞机**。
//
// 根因是**场景清单里没有「舱门口」这个空间**，导演只能从已有清单里挑（`schema.md:118`
// 明令"不能由执行器猜"），挑错了也没有任何提示。机器判不出语义，但**字面线索判得出**：
// 镜头描述里写到的空间实体，若在该场景的环境描述里一个字都没有，就该让人去核对。
//
// ⚠ 这是**启发式，不是判定**：词表是通用的空间名词（不是某个剧目的专属措辞），
// 命中只意味着"值得看一眼"。它抓不到"相近但错"（`altitude_ext` 也写了"舱门敞开着"），
// 真正的防线是立项时把空间拆对 —— 见 SKILL.md 故事三问的第 4 问。
const SPACE_WORDS = [
  '门口', '门洞', '门框', '舱门', '跳板', '舱壁', '蒙皮', '肋条', '舷窗', '机翼', '螺旋桨',
  '楼梯', '楼道', '走廊', '台阶', '天台', '屋顶', '阳台', '窗台', '院子',
  '地板', '天花板', '桌面', '沙发', '床', '柜台', '收银台', '书架', '讲台', '看台',
  '马路', '人行道', '天桥', '河堤', '沙滩', '甲板', '驾驶座', '后排',
];
const board = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
const envOf = new Map((board.scenes || []).map((s) => [s.id, `${s.name || ''}${s.environment || ''}`]));
const offScene = [];
for (const unit of direction.units || []) {
  for (const shot of unit.shots || []) {
    const env = envOf.get(shot.scene);
    if (!env) continue;                       // scene 不存在由下游（asset-resolver）报错
    const text = `${shot.action || ''}${shot.keyframe_start || ''}${unit.keyframe_start || ''}`;
    const missing = SPACE_WORDS.filter((w) => text.includes(w) && !env.includes(w));
    if (missing.length) offScene.push(`${unit.id}（场景 ${shot.scene}）：镜头写到了「${missing.join('、')}」，但 ${shot.scene} 的环境描述里没有它`);
  }
}
if (offScene.length) {
  console.warn(`⚠ ${offScene.length} 个镜头可能落错场景（场景清单见 board.json）：`);
  for (const line of offScene) console.warn(`  · ${line}`);
  console.warn('  判据只是字面：镜头里的空间实体在该场景描述里完全没出现。请确认它真的属于这个场景，而不是因为清单里缺这个空间才被就近安放的。');
}

const receipt = writeAgentDirectionReceipt({
  directionPath: output, boardPath, storyPath, authoredBy: flag('authored-by') || 'agent',
});
console.log(`导演稿：${output}\n单元素数：${direction.units.length}\n来源：Agent 直写（${receipt.authored_by}）\n票据：${output}.provenance.json\n提示：登记不等于确认，进入下一阶段仍需 review-gate --stage direction 的人工票`);
