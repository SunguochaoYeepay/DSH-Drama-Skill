#!/usr/bin/env node
/**
 * 从已验证的人物白膜 H3 工作流派生刚体场景版本。
 *
 * 刚体场景不应携带人物参考图：控制视频负责空间与运动，提示词负责
 * 飞机、导弹和山谷的外观。这样不会把人物身份约束误套到道具上。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SRC = path.join(ROOT, 'workflows', 'h3-fun-whitebox.json');
const OUT = path.join(ROOT, 'workflows', 'h3-fun-jet.json');
const CONTROL = path.join(ROOT, 'lab', 'whitebox', 'out', 'whitebox', 'jet_valley_static', 'jet_valley.mp4');

const graph = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const refNode = graph['136'];
if (!refNode || refNode.class_type !== 'MiniMaxH3ReferenceToVideo') {
  throw new Error('基础 H3 工作流缺少参考转视频节点 136');
}

// 参考图输入是可选的；删除连接与 LoadImage 节点，避免人物身份污染刚体镜头。
for (const key of Object.keys(refNode.inputs)) {
  if (key.startsWith('ref_images.')) delete refNode.inputs[key];
}
for (const id of ['200', '201', '202', '203']) delete graph[id];

graph['132'].inputs.value = 7.0;
graph['129'].inputs.noise_seed = 20260929002;
graph['138'].inputs.value = `[reference generation]\n\nsummary: Stylized cinematic aerial chase through a grey mountain valley. A blue fighter jet flies forward along the valley direction. Three small missiles launch one after another, each following the same forward direction with clear spacing and distinct red, yellow, and orange markings. Preserve the exact spatial layout and timing from the control video.\n\ndetailed_description:\n[0s-2.0s] Wide side view of the valley. The blue fighter jet enters and advances steadily along the valley, nose pointing in its travel direction.\n[2.0s-3.7s] The first red missile launches from behind the jet and moves forward along the same valley direction.\n[3.7s-5.0s] The second yellow missile launches, visibly separated from the first and still following the jet.\n[5.0s-7.0s] The third orange missile launches. Keep the jet and all missiles readable in the same wide frame; no teleporting, reversing, or camera-follow that cancels screen motion.\n\nCamera: fixed wide side camera, stable valley background, all four moving objects remain inside the frame.\n\noverall_soundscape: jet engine rumble, three distinct missile launch whooshes, wind through the valley.`;

graph['174'].inputs.file = path.basename(CONTROL);
graph['174'].inputs['video-preview'] = '';
graph['707'].inputs.filename_prefix = 'video/jet_h3';

fs.writeFileSync(OUT, JSON.stringify(graph, null, 2) + '\n', 'utf8');
console.log(`已生成 ${path.relative(ROOT, OUT)}`);
console.log(`  控制视频  ${path.relative(ROOT, CONTROL)}`);
console.log('  参考图    无（刚体场景）');
console.log('  时长      7.0s / 168 帧控制信号');
