/**
 * 视频层实验：一镜到底 / 连续运动（业界点名的第 1 号翻车场景）。
 *
 * 两臂的唯一差别是**有没有落幅**：
 *   i2v  —— 只给首帧（我们的现状）
 *   fl2v —— 首帧 + 落幅（`cli/unit.mjs` 里那条 `--last-keyframe`，全仓库没人用）
 *
 * 主张：如果"背景变异 / 走不到位置"能靠落幅压住，那么这条杠杆就该被启用。
 *
 * 用法：
 *   node lab/spatial/run-video.mjs --arm both --shots w1_walk_left,w2_walk_right --trials 2 --run-id vid-01
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildPrompt, refsFor, loadScene } from './lib/prompt.mjs';
import { runtimePaths, LAB_DIR, REPO_ROOT } from './lib/gen.mjs';

function arg(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const SCENE_FILE = String(arg('scene', path.join(LAB_DIR, 'scene-walk.json')));
const SHOTS = String(arg('shots', '')).split(',').map((s) => s.trim()).filter(Boolean);
const ARM = String(arg('arm', 'both'));
const TRIALS = Number(arg('trials', 2));
const SEED_BASE = Number(arg('seed-base', 51000));
const RUN_ID = String(arg('run-id', `vid-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`));
const WEIGHTS = path.join(REPO_ROOT, '.tmp', 'spatial-lab', 'weights', 'yolo11n.pt');
const OUT_ROOT = path.join(REPO_ROOT, '.tmp', 'spatial-lab', RUN_ID);
const ARMS = ARM === 'both' ? ['i2v', 'fl2v'] : ARM.split(',').map((s) => s.trim());

async function runPy(script, args, timeoutMs = 20 * 60 * 1000) {
  const { requireComfyPython } = await runtimePaths();
  const py = requireComfyPython();
  return await new Promise((resolve, reject) => {
    const child = spawn(py, [path.join(LAB_DIR, 'py', script), ...args], { cwd: REPO_ROOT, windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${script} 超时`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(out) : reject(new Error(`${script} 退出码 ${code}\n${err.slice(-900)}`));
    });
  });
}

/** 调 gen.py 生成（图片或视频），产物按 mtime 挑 */
async function gen({ mode, prompt, refs = [], lastImage, outDir, ratio, style, duration, seed }) {
  const { COMFY_GEN, requireComfyPython } = await runtimePaths();
  const py = requireComfyPython();
  fs.mkdirSync(outDir, { recursive: true });
  const args = [COMFY_GEN, mode, '--prompt', prompt, '--out-dir', outDir];
  if (ratio) args.push('--ratio', ratio);
  if (style) args.push('--style', style);
  if (duration) args.push('--duration', String(duration));
  if (Number.isFinite(seed) && seed >= 0) args.push('--seed', String(seed));
  args.push('--fast');
  for (const r of refs) args.push('--image', r);
  if (lastImage) args.push('--last-image', lastImage);

  const started = Date.now();
  await new Promise((resolve, reject) => {
    const child = spawn(py, args, { cwd: REPO_ROOT, windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`生成超时：${mode}`));
    }, 20 * 60 * 1000);
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve()
        : reject(new Error(`gen.py 退出码 ${code}\n模式=${mode}\nstderr: ${err.slice(-500)}\nstdout: ${out.slice(-500)}`));
    });
  });

  const files = fs
    .readdirSync(outDir)
    .map((f) => path.join(outDir, f))
    .filter((f) => /\.(mp4|mov|png|jpe?g)$/i.test(f))
    .map((f) => ({ f, m: fs.statSync(f).mtimeMs }))
    .filter((x) => x.m >= started - 1500)
    .sort((a, b) => b.m - a.m);
  const video = files.find((x) => /\.(mp4|mov)$/i.test(x.f));
  const image = files.find((x) => /\.(png|jpe?g)$/i.test(x.f));
  return video ? video.f : image ? image.f : null;
}

function keyframeShot(scene, shot, which) {
  const part = shot[which];
  return { ...shot, landmark: part.landmark, subjects: part.subjects, prompt_extra: '画面里只有她一个人' };
}

function videoPrompt(scene, shot) {
  const parts = [];
  parts.push(`场景：${scene.scene.environment}`);
  if (!shot.camera_move || shot.camera_move === 'fixed') {
    parts.push(`${shot.camera_text}，镜头全程完全固定，不许推拉摇移、不许变焦`);
  } else {
    parts.push(`运镜：${shot.camera_text}；整个过程必须连续匀速，中途不许跳变、不许换机位、不许切换镜头`);
  }
  if (shot.action_text) parts.push(`动作：${shot.action_text}`);
  else parts.push(`动作：画面里的人从起幅位置开始走动，走到${shot.last.landmark}，然后停住不动`);
  parts.push('周围的家具、门窗、光线保持一致，画面里始终只有她一个人');
  parts.push('写实电影感，暖黄烛光');
  return parts.join('。') + '。';
}

async function main() {
  const scene = loadScene(fs.readFileSync(SCENE_FILE, 'utf8'));
  const shots = SHOTS.length ? scene.shots.filter((s) => SHOTS.includes(s.id)) : scene.shots;
  fs.mkdirSync(OUT_ROOT, { recursive: true });

  const manifest = {
    run_id: RUN_ID,
    scene: scene.id,
    scene_path: SCENE_FILE,
    arms: ARMS,
    shots: shots.map((s) => s.id),
    trials: TRIALS,
    started_at: new Date().toISOString(),
    keyframes: {},
    trials_log: [],
  };

  for (const shot of shots) {
    const aux = path.join(OUT_ROOT, 'aux', shot.id);
    const kf = {};
    for (const which of ['first', 'last']) {
      const out = path.join(aux, `${which}.png`);
      if (!fs.existsSync(out)) {
        const synth = keyframeShot(scene, shot, which);
        await gen({
          mode: 'edit',
          prompt: buildPrompt(scene, synth, { arm: 'prompt-only' }),
          refs: refsFor(scene, synth, { arm: 'prompt-only' }),
          outDir: aux,
          ratio: scene.aspect,
          style: scene.style,
          seed: 50000 + (which === 'last' ? 1 : 0),
        });
        const made = fs
          .readdirSync(aux)
          .map((f) => path.join(aux, f))
          .filter((f) => /\.(png|jpe?g)$/i.test(f))
          .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
        if (made && made !== out) fs.copyFileSync(made, out);
      }
      kf[which] = out;
    }
    manifest.keyframes[shot.id] = kf;
    console.log(`[lab] 关键帧就绪 ${shot.id}: first=${path.basename(kf.first)} last=${path.basename(kf.last)}`);

    const vprompt = videoPrompt(scene, shot);
    fs.writeFileSync(path.join(aux, 'video_prompt.txt'), vprompt + '\n', 'utf8');

    for (const arm of ARMS) {
      for (let t = 1; t <= TRIALS; t++) {
        const seed = SEED_BASE + shots.findIndex((s) => s.id === shot.id) * 100 + t;
        const dir = path.join(OUT_ROOT, arm, shot.id, `trial_${t}`);
        fs.mkdirSync(dir, { recursive: true });
        const clip = await gen({
          mode: 'i2v',
          prompt: vprompt,
          refs: [kf.first], // i2v 的首帧必须走 --image
          lastImage: arm === 'fl2v' ? kf.last : undefined,
          outDir: dir,
          duration: shot.duration_s,
          style: scene.style,
          seed,
        });
        if (!clip) throw new Error(`没有产出视频：${dir}`);
        const raw = path.join(dir, 'raw.mp4');
        if (clip !== raw) fs.copyFileSync(clip, raw);

        const metricsPath = path.join(dir, 'metrics.json');
        await runPy('video_probe.py', [
          '--video', raw,
          '--weights', fs.existsSync(WEIGHTS) ? WEIGHTS : 'yolo11n.pt',
          '--out-json', metricsPath,
          '--out-strip', path.join(dir, 'strip.png'),
        ]);
        const m = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
        manifest.trials_log.push({
          shot: shot.id,
          arm,
          trial: t,
          seed,
          presence_rate: m.presence_rate,
          u_first: m.u_first,
          u_last: m.u_last,
          drift: m.drift,
          span: m.span,
          bg_change: m.bg_change,
          expected_drift: Math.round((shot.last.subjects[0].u - shot.first.subjects[0].u) * 1000) / 1000,
          dir: path.relative(REPO_ROOT, dir),
        });
        console.log(
          `[lab] ${shot.id} ${arm} t${t} presence=${m.presence_rate} drift=${m.drift} (期望 ${manifest.trials_log.at(-1).expected_drift}) 背景变化=${m.bg_change}`
        );
        fs.writeFileSync(path.join(OUT_ROOT, 'run.json'), JSON.stringify(manifest, null, 2), 'utf8');
      }
    }
  }
  manifest.finished_at = new Date().toISOString();
  fs.writeFileSync(path.join(OUT_ROOT, 'run.json'), JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`[lab] 完成 → ${path.relative(REPO_ROOT, OUT_ROOT)}`);
}

main().catch((e) => {
  console.error('[lab] 失败:', e.message);
  process.exit(1);
});
