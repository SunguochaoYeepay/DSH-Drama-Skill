/**
 * 试验箱编排：两臂 × 每镜 N 次 → 生成 → 度量。
 *
 * 公平性：同一 (镜, 第几次) 在两臂之间**用同一个 seed**，做配对比较。
 * 产物：.tmp/spatial-lab/<runId>/{run.json, blockout/*.png, <arm>/<shot>/trial_N/{raw.png, metrics.json, annotated.png}}
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildPrompt, refsFor, shotTargets, loadScene } from './lib/prompt.mjs';
import { generateComfy, makeDryBackend, runtimePaths, LAB_DIR, REPO_ROOT } from './lib/gen.mjs';

function arg(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const ARM = String(arg('arm', 'prompt-only'));
const SHOTS = String(arg('shots', 'g1,g2')).split(',').map((s) => s.trim()).filter(Boolean);
const TRIALS = Number(arg('trials', 3));
const DRY = Boolean(arg('dry', false));
const SEED_BASE = Number(arg('seed-base', 42000));
const RUN_ID = String(arg('run-id', `run-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`));
const DRY_SOURCE = String(arg('dry-source', path.join(REPO_ROOT, 'examples/demo-show/keyframes_local_v2/g002.png')));
const NO_DETECT = Boolean(arg('no-detect', false));
const SCENE_FILE = String(arg('scene', path.join(LAB_DIR, 'scene.json')));
// 权重固定在 .tmp 里，绝不往仓库根落文件
const WEIGHTS = path.join(REPO_ROOT, '.tmp', 'spatial-lab', 'weights', 'yolo11n.pt');

const ARMS =
  ARM === 'both'
    ? ['prompt-only', 'prompt+control']
    : ARM.split(',')
        .map((s) => s.trim())
        .filter(Boolean);
const OUT_ROOT = path.join(REPO_ROOT, '.tmp', 'spatial-lab', RUN_ID);

async function runPy(script, args) {
  const { requireComfyPython } = await runtimePaths();
  const py = requireComfyPython();
  const full = [path.join(LAB_DIR, 'py', script), ...args];
  return await new Promise((resolve, reject) => {
    const child = spawn(py, full, { cwd: REPO_ROOT, windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${script} 退出码 ${code}\n${err.slice(-900)}`))));
  });
}

function log(...a) {
  console.log(`[lab]`, ...a);
}

async function main() {
  const scene = loadScene(fs.readFileSync(SCENE_FILE, 'utf8'));
  const shots = scene.shots.filter((s) => SHOTS.includes(s.id));
  if (!shots.length) throw new Error(`没有匹配的镜：${SHOTS.join(',')}`);

  fs.mkdirSync(OUT_ROOT, { recursive: true });

  const manifest = {
    run_id: RUN_ID,
    scene: scene.id,
    scene_path: SCENE_FILE,
    arms: ARMS,
    shots: shots.map((s) => s.id),
    trials: TRIALS,
    dry: DRY,
    dry_source: DRY ? DRY_SOURCE : null,
    started_at: new Date().toISOString(),
    trials_log: [],
  };

  const [aw, ah] = String(scene.aspect || '9:16').split(':').map(Number);
  const frameH = Math.round((864 * (ah || 16)) / (aw || 9));

  for (const shot of shots) {
    const auxDir = path.join(OUT_ROOT, 'aux');

    // 控制图（只有控制臂需要）：声明 → 目标框渲染
    let blockoutPath = null;
    if (ARMS.includes('prompt+control')) {
      blockoutPath = path.join(auxDir, `${shot.id}.blockout.png`);
      await runPy('render_blockout.py', [
        '--scene', SCENE_FILE,
        '--shot', shot.id,
        '--out', blockoutPath,
        '--width', '864',
        '--height', String(frameH),
      ]);
    }

    // 站位标记图（只有标记臂需要）：在**真实空间照**上标出她的位置
    let markPath = null;
    if (ARMS.includes('prompt+mark')) {
      const subj = shot.subjects[0];
      markPath = path.join(auxDir, `${shot.id}.marked.png`);
      await runPy('mark_position.py', [
        '--base', scene.scene.master,
        '--silhouette', `${subj.u},${subj.v},${subj.h ?? 0.42}`,
        '--label', shot.id,
        '--out', markPath,
      ]);
    }

    // 场景参考图：镜头可以指定 @pano:<yaw> —— 换机位时从全景现裁那个方向的空场景照
    let sceneRefPath = null;
    const REF = String(shot.scene_ref || 'master');
    if (REF.startsWith('@pano:')) {
      const yaw = Number(REF.slice('@pano:'.length)) || 0;
      if (!scene.scene.pano) throw new Error(`镜头 ${shot.id} 要 @pano 但场景没配 pano`);
      sceneRefPath = path.join(auxDir, `${shot.id}.sceneref_yaw${yaw}.png`);
      await runPy('pano_crop.py', [
        '--pano', scene.scene.pano,
        '--yaw', String(yaw),
        '--fov', '70',
        '--width', '1024',
        '--height', '576',
        '--out', sceneRefPath,
      ]);
    }

    const targetsDir = path.join(OUT_ROOT, 'targets');
    fs.mkdirSync(targetsDir, { recursive: true });
    const targets = shotTargets(scene, shot);
    const targetsPath = path.join(targetsDir, `${shot.id}.targets.json`);
    fs.writeFileSync(targetsPath, JSON.stringify(targets, null, 2), 'utf8');

    for (const arm of ARMS) {
      for (let t = 1; t <= TRIALS; t++) {
        const seed = SEED_BASE + scene.shots.findIndex((s) => s.id === shot.id) * 100 + t;
        const dir = path.join(OUT_ROOT, arm, shot.id, `trial_${t}`);
        fs.mkdirSync(dir, { recursive: true });
        const prompt = buildPrompt(scene, shot, { arm });
        const refs = refsFor(scene, shot, { arm, blockoutPath, markPath, sceneRefPath });
        fs.writeFileSync(path.join(dir, 'prompt.txt'), prompt + '\n\nrefs:\n' + refs.join('\n') + '\n', 'utf8');

        const t0 = Date.now();
        let produced;
        if (DRY) {
          const src = fs.existsSync(DRY_SOURCE) ? DRY_SOURCE : blockoutPath;
          const r = await makeDryBackend({ sourceImage: src })({ outDir: dir, tag: `${shot.id}_${arm}_t${t}` });
          produced = r.produced;
        } else {
          const mode = refs.length ? 'edit' : 't2i';
          const r = await generateComfy({
            mode,
            prompt,
            refs,
            outDir: dir,
            ratio: scene.aspect,
            style: scene.style,
            fast: true,
            seed,
          });
          produced = r.produced;
        }
        if (!produced.length) throw new Error(`没有产出图片：${dir}`);
        const raw = path.join(dir, 'raw.png');
        fs.copyFileSync(produced[0], raw);

        const metricsPath = path.join(dir, 'metrics.json');
        const measureArgs = [
          '--image', raw,
          '--targets', targetsPath,
          '--out-png', path.join(dir, 'annotated.png'),
          '--out-json', metricsPath,
        ];
        if (NO_DETECT) measureArgs.push('--no-detect');
        else if (fs.existsSync(WEIGHTS)) measureArgs.push('--weights', WEIGHTS);
        await runPy('measure.py', measureArgs);
        const m = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
        manifest.trials_log.push({
          shot: shot.id,
          arm,
          trial: t,
          seed: DRY ? null : seed,
          ms: Date.now() - t0,
          n_expected: shot.subjects.length,
          scene_ref: REF,
          detector: m.detector,
          n_detected: m.n_detected,
          n_extra: m.n_extra,
          subject_u: m.matched && m.matched.length ? m.matched[0].u : null,
          set_mean_abs_du: m.set_mean_abs_du,
          mean_abs_du: m.mean_abs_du,
          max_abs_du: m.max_abs_du,
          ambiguous: m.ambiguous,
          order_ok: m.order_ok,
          dir: path.relative(REPO_ROOT, dir),
        });
        log(
          `${shot.id} ${arm} t${t} seed=${seed} set|du|=${m.set_mean_abs_du} mean|du|=${m.mean_abs_du} ` +
            `amb=${m.ambiguous} extra=${m.n_extra} order_ok=${m.order_ok} (${Date.now() - t0}ms)`
        );
        fs.writeFileSync(path.join(OUT_ROOT, 'run.json'), JSON.stringify(manifest, null, 2), 'utf8');
      }
    }
  }

  manifest.finished_at = new Date().toISOString();
  fs.writeFileSync(path.join(OUT_ROOT, 'run.json'), JSON.stringify(manifest, null, 2), 'utf8');
  log(`完成 → ${path.relative(REPO_ROOT, OUT_ROOT)}`);
}

main().catch((e) => {
  console.error('[lab] 失败:', e.message);
  process.exit(1);
});
