import fs from 'node:fs';
import path from 'node:path';

/**
 * 跑「现成的 ComfyUI API 工作流」。
 *
 * ## 为什么需要它
 *
 * `vendor/comfy-studio/gen.py` 只会**自己拼图**（t2i / edit / i2v / music），
 * 没有"读一个工作流文件、换掉输入视频、跑完取回产物"的入口。
 * 而本机那批 utility 工作流（SeedVR2 放大 / VOID 修复 / SAM3 遮罩 / SDPose 姿态 /
 * DepthAnything3 深度 / 补帧）**全是 API prompt 格式** —— 只要能读能做参数替换能取产物，
 * 它们就变成我们流水线上的一等能力。
 *
 * 与 `gen.py` 的关系：**只读复用它的入口逻辑（POST /prompt），不复制也不改它**。
 * 这个模块不认识任何具体工作流的语义，只做四件事：加载、改参、跑、取回。
 */

export const DEFAULT_URL = 'http://127.0.0.1:8188';

export function comfyUrl() {
  return String(process.env.COMFYUI_URL || DEFAULT_URL).replace(/\/+$/, '');
}

export function loadWorkflow(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const graph = JSON.parse(raw);
  if (Array.isArray(graph.nodes)) {
    throw new Error('这是 ComfyUI 的 UI 格式工作流（有 nodes 数组）；本模块只吃 API prompt 格式（按节点 id 索引）');
  }
  return graph;
}

/** `true/false/null/数字` 还原成字面量，其余按字符串 —— 免得 --set 出来的全是字符串。 */
export function coerce(value) {
  const s = String(value);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d*\.\d+$/.test(s)) return Number(s);
  return s;
}

export function setInput(graph, nodeId, name, value) {
  const node = graph[String(nodeId)];
  if (!node) throw new Error(`工作流里没有节点 ${nodeId}（有的：${Object.keys(graph).slice(0, 12).join(', ')}…）`);
  if (!node.inputs || !(name in node.inputs)) {
    throw new Error(`节点 ${nodeId}（${node.class_type}）没有输入 ${name}；它有：${Object.keys(node.inputs || {}).join(', ')}`);
  }
  node.inputs[name] = value;
  return { nodeId, classType: node.class_type, name, value };
}

/** `--set 114:100.text=小雨` / `--set 114:101.individual_masks=true` */
export function applySets(graph, sets = []) {
  return sets.map((s) => {
    const m = /^([^.]+)\.([^=]+)=(.*)$/.exec(s);
    if (!m) throw new Error(`--set 格式应为 <节点id>.<输入名>=<值>，收到：${s}`);
    return setInput(graph, m[1], m[2], coerce(m[3]));
  });
}

/** 把所有 LoadVideo 的 file 指到刚上传的那个文件名上。 */
export function patchVideoInputs(graph, fileName) {
  const patched = [];
  for (const [id, node] of Object.entries(graph)) {
    if (node.class_type === 'LoadVideo' && node.inputs && 'file' in node.inputs) {
      node.inputs.file = fileName;
      patched.push(id);
    }
  }
  if (!patched.length) throw new Error('这个工作流里没有 LoadVideo 节点');
  return patched;
}

/**
 * 往图里**加一个节点**。
 *
 * 为什么需要：有些输入是 `forceInput`（必须由节点给，不能当控件填）——
 * 例如 `SAM3_Detect.positive_coords`（点提示）就是。要给它值，就得加一个
 * 输出 STRING 的节点（`PrimitiveString`）再接过去。
 */
export function addNode(graph, id, classType, inputs = {}) {
  const key = String(id);
  if (graph[key]) throw new Error(`节点 ${key} 已经存在，不能覆盖`);
  graph[key] = { class_type: classType, inputs: { ...inputs }, _meta: { title: `注入：${classType}` } };
  return graph[key];
}

/** 把 `node.input` 接到 `sourceId` 的第 slot 个输出上。 */
export function linkInput(graph, nodeId, inputName, sourceId, slot = 0) {
  const node = graph[String(nodeId)];
  if (!node) throw new Error(`工作流里没有节点 ${nodeId}`);
  if (!graph[String(sourceId)]) throw new Error(`要接的源节点 ${sourceId} 不存在`);
  node.inputs[inputName] = [String(sourceId), Number(slot)];
  return { nodeId: String(nodeId), inputName, from: String(sourceId), slot: Number(slot) };
}

/** 上传本地视频到 ComfyUI 的 input/（LoadVideo 认的是那里的文件名）。 */
export async function uploadVideo(localFile, baseUrl = comfyUrl()) {
  if (!fs.existsSync(localFile)) throw new Error(`视频不存在：${localFile}`);
  const buf = fs.readFileSync(localFile);
  const fd = new FormData();
  fd.append('image', new Blob([buf]), path.basename(localFile));
  fd.append('type', 'input');
  fd.append('overwrite', 'true');
  const res = await fetch(`${baseUrl}/upload/image`, { method: 'POST', body: fd });
  const text = await res.text();
  if (!res.ok) throw new Error(`上传失败 HTTP ${res.status}: ${text.slice(0, 300)}`);
  const j = JSON.parse(text);
  return j.name || j.filename;
}

/** 提交并等它跑完。返回 {prompt_id, history, seconds}。 */
export async function runGraph(graph, { baseUrl = comfyUrl(), timeoutMs = 30 * 60 * 1000, pollMs = 2000 } = {}) {
  const res = await fetch(`${baseUrl}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: graph, client_id: 'aih-utility' }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ComfyUI 拒绝了工作流（HTTP ${res.status}）：${text.slice(0, 600)}`);
  const { prompt_id: promptId, node_errors: nodeErrors } = JSON.parse(text);
  if (nodeErrors && Object.keys(nodeErrors).length) {
    console.log(`  ⚠ 节点报错：${JSON.stringify(nodeErrors).slice(0, 400)}`);
  }
  const started = Date.now();
  for (;;) {
    if (Date.now() - started > timeoutMs) throw new Error(`等待超时（${Math.round(timeoutMs / 1000)}s），prompt_id=${promptId}`);
    await new Promise((r) => setTimeout(r, pollMs));
    const h = await fetch(`${baseUrl}/history/${promptId}`).then((r) => r.json());
    if (h[promptId]) return { promptId, history: h[promptId], seconds: Math.round((Date.now() - started) / 1000) };
  }
}

const OUT_KEYS = { images: 'image', gifs: 'image', videos: 'video', audio: 'audio' };

export function collectOutputs(history) {
  const out = [];
  for (const [nodeId, val] of Object.entries(history.outputs || {})) {
    for (const [key, kind] of Object.entries(OUT_KEYS)) {
      for (const item of val[key] || []) out.push({ nodeId, kind, ...item });
    }
  }
  return out;
}

export async function downloadOutputs(items, outDir, baseUrl = comfyUrl()) {
  fs.mkdirSync(outDir, { recursive: true });
  const saved = [];
  for (const it of items) {
    const q = new URLSearchParams({ filename: it.filename, subfolder: it.subfolder || '', type: it.type || 'output' });
    const res = await fetch(`${baseUrl}/view?${q}`);
    if (!res.ok) continue;
    const dst = path.join(outDir, it.filename);
    fs.writeFileSync(dst, Buffer.from(await res.arrayBuffer()));
    saved.push(dst);
  }
  return saved;
}
