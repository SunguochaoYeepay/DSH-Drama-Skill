#!/usr/bin/env node
/**
 * 生成白膜驱动工作流：workflows/h3-fun-whitebox.json
 *
 * 从官方模板 video_minimax_h3_fun_controlnet_union.json 改造，四处改动：
 *   1) control_video 从「SDPose 画的骨架图(704)」改接「白膜原始帧(700:692)」
 *      —— 官方示例走骨架是因为它喂真人视频；白膜是灰模胶囊人，
 *         RT-DETR 检 person 检不出来，照抄骨架链在我们的场景里直接失效。
 *   2) 加 4 个 LoadImage 接 ref_images.ref_image_0..3（锁身份，官方模板里一根没接）
 *   3) 16:9 → 9:16 竖屏，时长 7.3s（→175 帧，白膜 168 帧，差 7 帧）
 *   4) 提示词换成我们的 r2v 六段结构（references/video-h3.md:109）
 *
 * 骨架链（700:671/672/673/674/677/678/704）**保留但不再被消费**——
 * ComfyUI 按输出反推执行，孤儿节点不会跑。留着是为了以后能一行切回去。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SRC = 'C:/Users/Administrator/Downloads/video_minimax_h3_fun_controlnet_union.json';
const OUT = path.join(ROOT, 'workflows', 'h3-fun-whitebox.json');
const PROMPT = path.join(import.meta.dirname, 'prompt.txt');
const ASSETS = path.join(ROOT, 'projects', 'divorce_standoff_v2', 'assets');

const graph = JSON.parse(fs.readFileSync(SRC, 'utf8'));

// ── 1) 控制信号改接白膜原始帧 ────────────────────────────────────
graph['172'].inputs.control_video = ['700:692', 0];

// ── 2) 参考图：陈默(Picture 1,2) 林晓(Picture 3,4) ───────────────
// 挂图顺序即 <Picture N> 编号契约，改顺序必须同步改提示词。
const REFS = [
  ['200', 'chen_mo_portrait.png'],   // <Picture 1>
  ['201', 'chen_mo_default.png'],    // <Picture 2>
  ['202', 'lin_xiao_portrait.png'],  // <Picture 3>
  ['203', 'lin_xiao_default.png'],   // <Picture 4>
];
REFS.forEach(([id, file], i) => {
  if (!fs.existsSync(path.join(ASSETS, file))) throw new Error(`参考图不存在：${file}`);
  graph[id] = { class_type: 'LoadImage', inputs: { image: file, upload: 'image' } };
  // autogrow 输入名是「父名.子名」且下标 0 起（vendor/comfy-studio/graphs.py:940 有踩坑记录）
  graph['136'].inputs[`ref_images.ref_image_${i}`] = [id, 0];
});

// ── 3) 画幅与时长 ───────────────────────────────────────────────
graph['115'].inputs.aspect_ratio = '9:16 (Portrait Widescreen)';
graph['132'].inputs.value = 7.3;   // → max(5,round(7.3*24)) = 175 → 175%17=5 → +0 → 175 帧
graph['146'].inputs.value = false; // false = 20 步全量（true 才切 turbo 4 步）

// ── 4) 提示词 ───────────────────────────────────────────────────
const prompt = fs.readFileSync(PROMPT, 'utf8').trim();
if (!prompt.startsWith('[reference generation]')) throw new Error('提示词缺 [reference generation] 前缀');
graph['138'].inputs.value = prompt;

// ── 5) 固定种子：三档 strength 对照必须同 seed，否则变量不止一个 ──
graph['129'].inputs.noise_seed = 20260928001;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(graph, null, 2) + '\n', 'utf8');

console.log(`已生成 ${path.relative(ROOT, OUT)}（${Object.keys(graph).length} 节点）`);
console.log(`  控制信号  172.control_video ← 700:692（白膜原始帧）`);
console.log(`  参考图    200..203 → 136.ref_images.ref_image_0..3`);
console.log(`  画幅      ${graph['115'].inputs.aspect_ratio} @ ${graph['115'].inputs.megapixels}MP`);
console.log(`  帧数      175（白膜 168 → 末尾 7 帧会由 _fit_frames 重复末帧）`);
console.log(`  步数      ${graph['143'].inputs.value}（switch=${graph['146'].inputs.value ? 'turbo 4' : '全量'}）`);
console.log(`  种子      ${graph['129'].inputs.noise_seed}（三档共用）`);
console.log(`  提示词    ${prompt.split('\n').length} 行 / ${prompt.length} 字符`);
