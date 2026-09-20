/**
 * assets.mjs — 生成资源：角色肖像 / 身份图 / 场景主图 / 道具三视图。
 *
 * ## 为什么要有这个文件
 *
 * 流程图上「资源」是正式的一个阶段，配方（`src/assets.mjs` 的 `assetPlan`）
 * 与通道（`src/providers/`）都写好了，验收方（`cli/keyframes.mjs` 的
 * `unitAssets` + 哈希资源票据）也在等 ——
 * **但中间没有生产者**：
 *
 * ```
 * assetPlan()      全工程只有 tests/assets.test.mjs 在调
 * assetProvider()  全工程零调用者
 * cli/             没有任何 assets 入口
 * ```
 *
 * 所以资源阶段一直是个孤儿：真实项目跑到这里只能手搓占位图，
 * 然后关键帧拿着占位图去锁脸。这个文件就是补上那一环。
 *
 * ## 两个不能省的设计点
 *
 * ① **依赖顺序由 `assetPlan` 保证**（肖像 → 身份图 → 场景 → 道具），
 *    身份图的参考图是肖像，所以必须串行、且按这个顺序。
 *
 * ② **参考图必须"执行时"解析**（`refsOf`），不能在跑之前取快照。
 *    `assetPlan` 把 `refsFor` 写成函数就是为这个：计划阶段肖像还没生成，
 *    提前取会拿到空引用（`src/assets.mjs` 里记过这个坑）。
 *
 * ## 闸门
 *
 * 生成前查上游（故事 + 分镜表）是否已人工确认；生成后**不自动开票** ——
 * 资源闸门要用户自己看总览再批（SKILL.md：Agent 不得代用户写人工确认票）。
 *
 * 用法：
 *   node cli/assets.mjs <board.json> [--provider local|bailian] [--only <id,...>]
 *                       [--ws <workspace>] [--n 1] [--steps 20] [--dry-run] [--skip-gate]
 */

import fs from 'node:fs';
import path from 'node:path';
import { assetPlan, refsOf } from '../src/assets.mjs';
import { projectAssetFiles } from '../src/asset-resolver.mjs';
import { provider as getProvider, assetProvider } from '../src/providers/index.mjs';
import { requireApproval, writeReviewNote } from '../src/human-gates.mjs';
import { installCliErrorHandler } from '../src/cli-errors.mjs';
import { ASSET_IMAGE_MODEL, LOCAL_IMAGE_STEPS, VOLCENGINE_IMAGE_MODEL } from '../src/config.mjs';
import { writeGenerationRecord } from '../src/generation-records.mjs';
import { readCinematography } from '../src/cinematography.mjs';
import { localStyle } from '../src/providers/comfyui.mjs';

installCliErrorHandler();

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true); };

const boardArg = argv.find((x) => /board.*\.json$/i.test(x) && !x.startsWith('--'));
if (!boardArg) {
  console.error('用法：node cli/assets.mjs <board.json> [--provider local|bailian] [--only <id,...>] [--dry-run]');
  process.exit(2);
}
const BOARD_PATH = path.resolve(boardArg);
const PROJ = path.dirname(BOARD_PATH);
const ASSET_DIR = path.join(PROJ, 'assets');
const DRY = argv.includes('--dry-run');
const SKIP_GATE = argv.includes('--skip-gate');
const ONLY = String(flag('only', '')).split(',').map((s) => s.trim()).filter(Boolean);
const N = Number(flag('n', 1)) || 1;
const STEPS = flag('steps', LOCAL_IMAGE_STEPS);
const WRITE = !argv.includes('--no-write');
const WORKSPACE = flag('ws', null);

// `--provider local` 是历史叫法（对齐 keyframes.mjs），实际通道名是 comfyui。
const PROVIDER_ARG = String(flag('provider', '')).toLowerCase();
const PROVIDER_NAME = PROVIDER_ARG === 'local' ? 'comfyui' : PROVIDER_ARG;

const board = JSON.parse(fs.readFileSync(BOARD_PATH, 'utf8'));

// 摄影契约：没有这个文件就什么都不加（`readCinematography` 返回 null），
// 老剧目的资产提示词一个字都不变。规则正本见 references/cinematography.md。
const CONTRACT = readCinematography(PROJ);
if (CONTRACT) console.log(`摄影契约：已载入 ${path.join(PROJ, 'cinematography.json')}（肖像/身份图取排除项与焦段；场景主图取全套）`);

// ---------------------------------------------------------------- 闸门

if (SKIP_GATE) {
  console.error('⚠ --skip-gate：仅限调试，已跳过资源阶段的上游人工确认');
} else {
  // 板子票：场景清单、角色、造型、道具都住在 board.json 里，而它**此前全程无票** ——
  // 2026-09-20 no_chute 因此一路绿灯：场景清单把「舱门口」这个真正的叙事空间漏掉了，
  // 直到 g001 出图（门关着的飞机）才暴露。场景清单决定了全片长什么样，不该是无人复核的。
  requireApproval(PROJ, 'board', [BOARD_PATH]);
  const directionPath = path.join(PROJ, 'board.direction.json');
  requireApproval(PROJ, 'direction', [directionPath]);
}

// ---------------------------------------------------------------- 产物命名

/**
 * 资产在 board 里的相对路径。
 *
 * **命名规则必须和 board 既有槽位一致** —— 回填后关键帧直接拿这些路径当参考图，
 * 换名字不会报错，只会让下一次生成多出一份没人引用的孤儿文件。
 */
const FILE_NAME = {
  portrait: (j) => `${j.id}_portrait.png`,
  sheet: (j) => `${j.id}_sheet.png`,
  master: (j) => `${j.id}_master.png`,
  reverse_master: (j) => `${j.id}_reverse_master.png`,
  spatial_layout: (j) => `${j.id}_layout.png`,
  prop_3view: (j) => `${j.id}_ref_image.png`,
};

const relOf = (job) => `assets/${(FILE_NAME[job.kind] || ((j) => `${j.id}_${j.slot}.png`))(job)}`;

// ---------------------------------------------------------------- 通道适配

/**
 * `gen.py --style` 是**正负提示词预设**，不是换模型 —— 而且**不传会落到它自带的默认值**。
 *
 * 🔁 **2026-09-17 after_waking 实测：这就是本地资产的画面风格一直不受控的根因。**
 *    - 通道调的是显式 `t2i`，而 gen.py 的 `infer_style()` 只在 `auto` 模式下跑，
 *      所以 `args.style` **永远停在 argparse 默认值 `realistic`**，与项目声明的风格无关。
 *    - `realistic` 预设的**负向词里写着「CG感，卡通，动漫」**，正向词还会追加
 *      「写实摄影风格…生活快照般随手抓拍」。
 *    - 于是 prompt 里写多少「3D 卡通动画长片质感」都被负向条件抵消 ——
 *      改 prompt 措辞**根本无效**，因为负向条件不在我们手里。
 *
 * gen.py 的预设只有 `realistic/anime/cyberpunk/healing/vintage/none`，**没有 3D 卡通档**，
 * 所以这里只能做**投降映射**：`cartoon3d → anime`（本地 A/B 实测观感最接近）。
 * 注意 `anime` 的负向词里也含「3D渲染」，同样是妥协 —— 这是上游通道的能力边界，不是本仓能修的。
 *
 * 道具图**不跟随项目风格**：它自带「写实实拍，产品静物摄影」配方，固定走 `realistic`，
 * 免得把手机/镜子也画成卡通。
 */
function localStyleFor(job) {
  if (job.kind === 'prop_3view') return 'realistic';
  // 映射表收在 `src/providers/comfyui.mjs` 的 `localStyle()` —— 关键帧走同一张表，
  // 在这里另起一份就会两边漂移（历史教训：cartoon3d → anime 的投降映射只有一处真相）。
  return localStyle(board.meta?.style);
}

/**
 * 两个通道的参数名不一样，这一层只做翻译，不做决策：
 *   comfyui  → `ratio`
 *   bailian  → `size`
 * 传错不会报错，只会静默走通道默认画幅（本地默认 1024×576 横屏），
 * 竖屏项目会整批落错位 —— 所以这里显式映射，不留默认。
 */
function providerArgsFor(p, job, outDir, images) {
  const ratio = job.size || '1:1';
  if (p.name === 'comfyui') {
    const common = { ratio, n: N, outDir, prefix: job.id };
    if (STEPS) common.steps = Number(STEPS);
    // `--style` 对 t2i 与 edit **都要传**（2026-09-20 修）。
    //
    // 旧代码是 `if (job.mode !== 'edit')` —— 因为当时 gen.py 的 edit 分支把 negative
    // 硬编码成空串、压根不接 style。后果是身份图（edit）拿到空负向条件，写实剧被系统性
    // 画成插画。上游已让 edit 也取画质预设，**身份图与关键帧从此和肖像/主图同一套防线**。
    // 别再把这个判断加回去 —— 加回去等于把插画化原样恢复。
    common.style = localStyleFor(job);
    return job.mode === 'edit'
      ? { ...common, images, instruction: job.instruction }
      : { ...common, prompt: job.prompt };
  }
  const common = { size: ratio, n: N, outDir, prefix: job.id, model: p.name === 'volcengine' ? VOLCENGINE_IMAGE_MODEL : ASSET_IMAGE_MODEL };
  return job.mode === 'edit'
    ? { ...common, images, instruction: job.instruction }
    : { ...common, prompt: job.prompt };
}

function callProvider(p, job, outDir, images) {
  const args = providerArgsFor(p, job, outDir, images);
  return job.mode === 'edit'
    ? p.edit(args)
    : p.generate(args);
}

// ---------------------------------------------------------------- 主流程

const plan = assetPlan(board, { sceneExtras: argv.includes('--with-scene-extras'), contract: CONTRACT });
const jobs = ONLY.length
  ? plan.filter((j) => ONLY.includes(j.id) || ONLY.includes(`${j.kind}:${j.id}`))
  : plan;

if (!jobs.length) {
  console.error(ONLY.length ? `✗ --only 没有匹配到任何资产：${ONLY.join(',')}` : '✗ 这份 board 里没有任何要生成的资产');
  process.exit(2);
}

const p = PROVIDER_NAME ? getProvider(PROVIDER_NAME) : assetProvider();
const label = p.name === 'comfyui' ? '本地 ComfyUI（零成本）' : p.name === 'volcengine' ? '火山方舟 Seedream（付费）' : '百炼线上（付费）';

console.log(`\n出资源　共 ${jobs.length} 项　通道：${label}${DRY ? '　【干跑】' : ''}`);
if (SKIP_GATE) console.log('⚠ --skip-gate 已生效：未校验上游闸门');

if (DRY) {
  for (const job of jobs) {
    console.log(`\n${'─'.repeat(68)}`);
    console.log(`  【${job.kind}】${job.id}　${job.mode === 'generate' ? '文生图' : '图生图'}　${job.size}　→ ${relOf(job)}`);
    console.log(`  为什么：${job.why}`);
    const refs = refsOf(job);
    if (job.mode === 'edit') console.log(`  参考图：${refs.length ? refs.join('、') : '（缺失！肖像还没生成？）'}`);
    // 干跑打印的是**真正会交给通道的那份参数**（同一函数算出来的），不是复述变量，
    // 否则无法证明 steps / ratio / style 真的传下去了。
    const shown = Object.entries(providerArgsFor(p, job, ASSET_DIR, refs))
      .filter(([k]) => k !== 'prompt' && k !== 'instruction')
      .map(([k, v]) => (k === 'images' ? `images=${v.length}张` : `${k}=${k === 'outDir' ? path.relative(PROJ, v) || '.' : v}`));
    console.log(`  通道参数：${shown.join('  ')}`);
    console.log(`  ${job.mode === 'edit' ? job.instruction : job.prompt}`);
  }
  console.log(`\n干跑结束，未调用任何通道、未写任何文件。`);
  process.exit(0);
}

fs.mkdirSync(ASSET_DIR, { recursive: true });

let failed = 0;
const produced = [];

for (const job of jobs) {
  const rel = relOf(job);
  const target = path.join(PROJ, rel);
  const refs = job.mode === 'edit' ? refsOf(job) : [];

  console.log(`\n${'─'.repeat(68)}`);
  console.log(`  【${job.kind}】${job.id}　${job.mode === 'edit' ? `图生图（参考 ${refs.length} 张）` : '文生图'}　${job.size}　→ ${rel}`);
  if (job.mode === 'edit' && !refs.length) {
    // 身份图拿不到肖像 = 这组造型没有脸部锚点，等于白生成。
    console.log(`    ✗ 缺少参考图：身份图必须用肖像当锚点。先跑肖像（--only ${job.id} 之前先生成对应 character）`);
    failed++;
    continue;
  }
  for (const r of refs) {
    console.log(`      参考：${r}${fs.existsSync(path.resolve(PROJ, r)) ? '' : '　（不存在！）'}`);
  }

  const started = Date.now();
  let r;
  try {
    r = await callProvider(p, job, ASSET_DIR, refs.map((x) => path.resolve(PROJ, x)));
  } catch (e) {
    console.log(`    ✗ 通道报错：${String(e.message || e).split('\n')[0]}`);
    failed++;
    continue;
  }
  const secs = Math.round((Date.now() - started) / 1000);

  const files = (r.files || []).filter((f) => f && fs.existsSync(f));
  if (!files.length) {
    console.log(`    ✗ 未产出文件（exit ${r.status}）${r.stderr ? `：${String(r.stderr).split('\n')[0].slice(0, 160)}` : ''}`);
    failed++;
    continue;
  }

  // 通道自己起的文件名不可控（本地是时间戳、线上是 hash），统一改名成 board 认的名字。
  // n>1 时候选图保留成 `<name>_c2.png` 这样，方便人工挑一张顶替。
  const ext = path.extname(files[0]) || '.png';
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(files[0], target);
  for (const [i, extra] of files.slice(1).entries()) {
    fs.copyFileSync(extra, target.replace(/\.png$/i, `_c${i + 2}${ext}`));
  }

  // 回填 —— 引用只在**这里**才写回 board，后面的 job 和关键帧都靠它。
  job.target[job.slot] = rel;
  produced.push(rel);

  const kb = (fs.statSync(target).size / 1024).toFixed(0);
  console.log(`    ✓ ${rel}　${kb} KB　${secs} 秒${files.length > 1 ? `　（另存 ${files.length - 1} 张候选）` : ''}`);
}

// ---------------------------------------------------------------- 落盘与送审

if (WRITE && produced.length) {
  fs.writeFileSync(BOARD_PATH, `${JSON.stringify(board, null, 2)}\n`, 'utf8');
  console.log(`\n已回填 ${produced.length} 个资产槽位 → ${path.basename(BOARD_PATH)}`);
}

if (failed) {
  console.error(`\n✗ ${failed} 项资产生成失败`);
  process.exitCode = 1;
} else {
  let all;
  try {
    all = projectAssetFiles(board, BOARD_PATH, { workspace: WORKSPACE });
  } catch (error) {
    if (!ONLY.length) throw error;
    console.log(`\n部分资源已生成，但整组资源尚未齐全，暂不能送审：${error.message}`);
    console.log('继续补齐其余资源；只有完整资源集合才能写入人工确认票。');
    process.exit(0);
  }

  console.log(`\n资源总览（请逐张核对身份、造型、场景、文字污染）：`);
  for (const f of all) console.log(`  · ${path.resolve(f)}`);

  const generationRecord = writeGenerationRecord(PROJ, 'assets', {
    provider: p.name,
    model: p.name === 'comfyui' ? 'local-comfyui' : ASSET_IMAGE_MODEL,
    requested_provider: PROVIDER_ARG || null,
    artifacts: all,
  });

  // 票据不代写。资源闸门要用户自己看总览再批 —— 这是 SKILL.md 的硬规矩。
  const assetsDir = ASSET_DIR;
  const workspaceArg = WORKSPACE ? ` --ws "${path.resolve(String(WORKSPACE))}"` : '';
  const approveCommand = `node cli/review-gate.mjs approve --project "${PROJ}" --stage assets${workspaceArg}`;
  const note = writeReviewNote(PROJ, 'assets', [
    '# 资源人工审阅', '',
    ...all.map((file) => `- ${file}`), '',
    '请逐张查看原图，确认人物身份、造型、体型比例、场景、道具和文字污染。', '',
    `确认命令：${approveCommand}`,
    `生成记录：${generationRecord}`,
  ]);
  console.log(`\n下一步：打开原图人工确认；确认票会绑定以上 ${all.length} 个文件的哈希`);
  console.log(`  ${approveCommand}`);
  console.log(`  node cli/keyframes.mjs "${BOARD_PATH}" --direction <render.plan.json> --provider local`);
  console.log(`  审阅单：${note}`);
  console.log(`\n资产目录：${assetsDir}`);
}
