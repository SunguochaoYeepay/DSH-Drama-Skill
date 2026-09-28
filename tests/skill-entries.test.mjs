/**
 * SKILL.md 的入口清单与真实文件的一致性。
 *
 * ## 守什么
 *
 * 2026-09-28 手工体检时发现：`cli/init-board.mjs`（立项建板）在 README 里有、SKILL.md 里没有；
 * 流程图上明晃晃写着「去除错误硬字幕」这一步，而 `subcheck / desub / band-diff / record-clip`
 * 四个入口一个都没登记；09-24 收编的 `cli/utility.mjs` 也一直没进清单。
 * **入口清单是纯手工维护的，代码加了它不会自己长出来** —— 于是补了这条测试：
 *
 * 1. SKILL.md 里写到的每个脚本都必须真有这个文件（改名/删了会立刻红，不留死链）；
 * 2. 阶段路由表里链接的每份 reference 都必须存在；
 * 3. `cli/` 下每个入口要么在 SKILL.md 里被提到，要么在下面的豁免名单里**写明理由** ——
 *    新加一个 CLI 就必须当场决定：它是主流程（登记进清单）还是旁支（进名单说明理由）。
 *
 * 判据是「清单和代码今天还对不对得上」，不是「文档好不好看」。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const skill = fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8');

/** 不进 SKILL.md 常用入口的旁支 —— 每一条都要写清为什么可以不登记。 */
const EXEMPT = {
  'animatic.mjs': '预览动画，属诊断工具（README 有，不是主流程）',
  'huimeng.mjs': '绘梦通道的执行后端，由 cli/keyframes.mjs 调，不给人直接调',
  'inspect.mjs': '诊断工具（README 有，不是主流程）',
  'kanban.mjs': '看板启动器（README 有，属工具不是流水线）',
  'look-local.mjs': '旁支入口：本地 ollama 看图，0 成本可选',
  'migrate-plan.mjs': '历史计划迁移专用，不属于普通新项目流程',
  'wait-ready.mjs': '等 ComfyUI 就绪的诊断工具',
};

test('SKILL.md 里写到的脚本都真实存在（改名或删了立刻红）', () => {
  const mentioned = [...skill.matchAll(/(?:node\s+)?((?:cli|src)\/[\w.-]+\.mjs)/g)].map((m) => m[1]);
  const uniq = [...new Set(mentioned)];
  assert.ok(uniq.length >= 10, `应提到不少入口，实际只解析到 ${uniq.length} 个`);
  const missing = uniq.filter((rel) => !fs.existsSync(path.join(root, rel)));
  assert.deepEqual(missing, [], `SKILL.md 提到了不存在的文件：${missing.join('、')}`);
});

test('阶段路由里点到的 reference 都存在（不留死链）', () => {
  // 路由表用反引号写路径，正文里偶尔用链接 —— 两种写法都要抓。
  const linked = [...skill.matchAll(/\]\((references\/[^)]+?)\)/g)].map((m) => m[1]);
  const quoted = [...skill.matchAll(/`(references\/[^`]+?)`/g)].map((m) => m[1]);
  // `references/art/<style>.md` 这类是"按题材取值"的占位写法，不是一个真文件 —— 不参与存在性判断。
  const uniq = [...new Set([...linked, ...quoted])].filter((rel) => !rel.includes('<'));
  assert.ok(uniq.length >= 8, `路由表应点到多份 reference，实际 ${uniq.length} 份`);
  const missing = uniq.filter((rel) => !fs.existsSync(path.join(root, rel)));
  assert.deepEqual(missing, [], `SKILL.md 链接了不存在的 reference：${missing.join('、')}`);
});

test('cli/ 下每个入口要么登记、要么在豁免名单里写明理由', () => {
  const files = fs.readdirSync(path.join(root, 'cli')).filter((f) => f.endsWith('.mjs'));
  const notMentioned = files.filter((f) => !skill.includes(`cli/${f}`));
  const unexplained = notMentioned.filter((f) => !EXEMPT[f]);
  assert.deepEqual(
    unexplained,
    [],
    `这些入口 SKILL.md 完全没提，也没在测试里豁免：${unexplained.join('、')}\n` +
      '→ 主流程的请登记进 SKILL.md 的「常用入口」；确定是旁支的请写进 EXEMPT 并说明理由。',
  );

  // 豁免名单本身也要诚实：列着的理由不能是空的，也不能豁免一个已经被登记的文件（那说明名单该清理）
  for (const [file, why] of Object.entries(EXEMPT)) {
    assert.ok(why && why.length > 4, `${file} 的豁免理由不能为空`);
    assert.ok(fs.existsSync(path.join(root, 'cli', file)), `豁免的 ${file} 已不存在，该从名单里删掉`);
  }
  const stale = Object.keys(EXEMPT).filter((f) => skill.includes(`cli/${f}`));
  assert.deepEqual(stale, [], `这些已在 SKILL.md 里登记，不该还躺在豁免名单里：${stale.join('、')}`);
});

test('核心流程的每个阶段都有对应入口登记在常用入口里', () => {
  // 「核心流程」那段列的是阶段；这里钉住的是：阶段名 → 至少有一个入口被登记。
  // 少一个阶段 = 新人照着 SKILL 跑会卡住（这正是 09-28 发现的那类漂移）。
  const required = [
    ['立项建板', 'cli/init-board.mjs'],
    ['剧本登记', 'cli/script.mjs'],
    ['导演登记', 'cli/register-direction.mjs'],
    ['编译单元', 'cli/compile-units.mjs'],
    ['资产', 'cli/assets.mjs'],
    ['关键帧', 'cli/keyframes.mjs'],
    ['出片', 'cli/unit.mjs'],
    ['人工票', 'cli/review-gate.mjs'],
    ['合成', 'cli/assemble-units.mjs'],
    ['去字幕', 'cli/desub.mjs'],
    ['去字幕前自检', 'cli/subcheck.mjs'],
    ['去字幕后记账', 'cli/record-clip.mjs'],
    ['带内/带外核查', 'cli/band-diff.mjs'],
    ['空间核查', 'cli/space-check.mjs'],
    ['依赖自检', 'cli/doctor.mjs'],
  ];
  const missing = required.filter(([, rel]) => !skill.includes(rel)).map(([stage]) => stage);
  assert.deepEqual(missing, [], `这些阶段在 SKILL.md 里没有入口：${missing.join('、')}`);
});

console.log('skill-entries: 4/4 passed');
