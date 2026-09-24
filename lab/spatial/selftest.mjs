/**
 * 试验箱自检：**完全离线、确定性、不调模型**。全绿才允许跑真实验。
 *
 * 覆盖四件事：
 *   1. 提示词两臂的差别（控制句只应出现在控制臂）
 *   2. 控制图渲染器能出图，且两镜不同
 *   3. 度量数学正确：注入已知框 → |Δu|≈0；把前后序调反 → order_ok=false
 *   4. 编排链路能端到端跑通（dry 后端，不占 GPU）
 *
 * 用法：node lab/spatial/selftest.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildPrompt, loadScene, refsFor, shotTargets } from './lib/prompt.mjs';
import { runtimePaths, LAB_DIR, REPO_ROOT } from './lib/gen.mjs';

const SELF = path.join(REPO_ROOT, '.tmp', 'spatial-lab', 'selftest');
const SCENE_PATH = path.join(LAB_DIR, 'scene.json');

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function runPy(script, args) {
  const { requireComfyPython } = await runtimePaths();
  const py = requireComfyPython();
  return await new Promise((resolve, reject) => {
    const child = spawn(py, [path.join(LAB_DIR, 'py', script), ...args], { cwd: REPO_ROOT, windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${script} 退出码 ${code}\n${err.slice(-700)}`))));
  });
}

/** 造一个中心落在 (u,v)、相对高度 h 的框 */
function boxFor(u, v, h, W, H) {
  const bh = h * H;
  const bw = bh * 0.6;
  const cx = u * W;
  const cy = v * H;
  return [cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2];
}

function nodeRun(args, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: REPO_ROOT, windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('子进程超时'));
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(out) : reject(new Error(`退出码 ${code}\n${err.slice(-700)}`));
    });
  });
}

async function main() {
  fs.mkdirSync(SELF, { recursive: true });
  const scene = loadScene(fs.readFileSync(SCENE_PATH, 'utf8'));
  const g1 = scene.shots.find((s) => s.id === 'g1');
  const g2 = scene.shots.find((s) => s.id === 'g2');

  console.log('1) 提示词两臂');
  const pOnly = buildPrompt(scene, g1, { arm: 'prompt-only' });
  const pCtrl = buildPrompt(scene, g1, { arm: 'prompt+control' });
  check('基线臂不含控制句', !pOnly.includes('空间示意图'));
  check('控制臂含控制句', pCtrl.includes('空间示意图'));
  check('两臂都写出位置声明', pOnly.includes('x=0.66') && pCtrl.includes('x=0.66'));
  check('两臂都写出前后关系', pOnly.includes('前后遮挡关系必须是'));
  check('基线臂参考图不含控制图', !refsFor(scene, g1, { arm: 'prompt-only', blockoutPath: 'X.png' }).includes('X.png'));
  check('控制臂参考图含控制图', refsFor(scene, g1, { arm: 'prompt+control', blockoutPath: 'X.png' }).includes('X.png'));

  console.log('2) 控制图渲染器');
  const b1 = path.join(SELF, 'bo_g1.png');
  const b2 = path.join(SELF, 'bo_g2.png');
  await runPy('render_blockout.py', ['--scene', SCENE_PATH, '--shot', 'g1', '--out', b1, '--width', '864', '--height', '1536']);
  await runPy('render_blockout.py', ['--scene', SCENE_PATH, '--shot', 'g2', '--out', b2, '--width', '864', '--height', '1536']);
  check('g1 控制图已生成', fs.existsSync(b1));
  check('g2 控制图已生成', fs.existsSync(b2));
  check('两镜控制图不同（站位确实变了）', fs.readFileSync(b1).length !== fs.readFileSync(b2).length || !fs.readFileSync(b1).equals(fs.readFileSync(b2)));

  console.log('3) 度量数学（注入已知框）');
  const W = 864;
  const H = 1536;
  const targets = shotTargets(scene, g1);
  const targetsPath = path.join(SELF, 'g1.targets.json');
  fs.writeFileSync(targetsPath, JSON.stringify(targets, null, 2), 'utf8');

  const boxesGood = [
    boxFor(0.22, 0.46, 0.2, W, H), // driver  far
    boxFor(0.66, 0.52, 0.3, W, H), // passenger mid
    boxFor(0.42, 0.74, 0.45, W, H), // stranger near
  ];
  const mGood = path.join(SELF, 'm_good.json');
  await runPy('measure.py', ['--image', b1, '--targets', targetsPath, '--boxes', JSON.stringify(boxesGood), '--out-json', mGood]);
  const good = JSON.parse(fs.readFileSync(mGood, 'utf8'));
  check('三个主体全部匹配上', good.matched.length === 3, `matched=${good.matched.length}`);
  check('|Δu| 接近 0（框就在声明位置）', good.mean_abs_du != null && good.mean_abs_du < 0.002, `mean|Δu|=${good.mean_abs_du}`);
  check('前后序判定为正确', good.order_ok === true, `violations=${JSON.stringify(good.order_violations)}`);

  const boxesBad = [
    boxFor(0.22, 0.46, 0.45, W, H), // driver 被画成最近 —— 与声明相反
    boxFor(0.66, 0.52, 0.3, W, H),
    boxFor(0.42, 0.74, 0.2, W, H), // stranger 被画成最远
  ];
  const mBad = path.join(SELF, 'm_bad.json');
  await runPy('measure.py', ['--image', b1, '--targets', targetsPath, '--boxes', JSON.stringify(boxesBad), '--out-json', mBad]);
  const bad = JSON.parse(fs.readFileSync(mBad, 'utf8'));
  check('前后序被打反时能报出来', bad.order_ok === false && bad.order_violations.length > 0, `violations=${JSON.stringify(bad.order_violations)}`);
  check('打反不影响 |Δu|（两个指标互相独立）', bad.mean_abs_du != null && bad.mean_abs_du < 0.002, `mean|Δu|=${bad.mean_abs_du}`);

  console.log('4) 编排链路（dry，不占 GPU）');
  const runId = 'selftest-dry';
  const runDir = path.join(REPO_ROOT, '.tmp', 'spatial-lab', runId);
  fs.rmSync(runDir, { recursive: true, force: true });
  await nodeRun(['lab/spatial/run.mjs', '--arm', 'both', '--shots', 'g1', '--trials', '1', '--dry', '--no-detect', '--run-id', runId]);
  const runJson = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
  check('run.json 落了两个臂各一次', (runJson.trials_log || []).length === 2, `n=${(runJson.trials_log || []).length}`);
  check('每次都产出了 metrics.json', runJson.trials_log.every((t) => fs.existsSync(path.join(REPO_ROOT, t.dir, 'metrics.json'))));
  check('每次都产出了标注图', runJson.trials_log.every((t) => fs.existsSync(path.join(REPO_ROOT, t.dir, 'annotated.png'))));
  check('dry 模式如实标注为未检测', runJson.trials_log.every((t) => t.detector === 'disabled'));

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error('[selftest] 失败:', e.message);
  process.exit(1);
});
