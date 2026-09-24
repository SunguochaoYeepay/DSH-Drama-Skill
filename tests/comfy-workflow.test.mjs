/**
 * 跑「现成 ComfyUI API 工作流」那层的地基：加载、改参、视频输入替换、产物收集。
 *
 * 为什么要有测试：这批 utility（SeedVR2 / VOID / SAM3 / SDPose / DA3 / 补帧）
 * 是本机模型能变成流水线能力的关键接口，**它错了会静默跑错工作流**，
 * 而跑一次要几分钟到十几分钟 —— 不能让错误拖到那时候才暴露。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addNode, applySets, coerce, collectOutputs, linkInput, loadWorkflow, patchVideoInputs, setInput } from '../src/comfy-workflow.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

console.log('工作流入参：类型还原');
{
  check('true/false → 布尔', coerce('true') === true && coerce('false') === false);
  check('null → null', coerce('null') === null);
  check('整数/小数 → 数字', coerce('2') === 2 && coerce('0.5') === 0.5);
  check('其余 → 字符串', coerce('person') === 'person' && coerce('小雨') === '小雨');
}

console.log('工作流入参：改参与报错');
{
  const g = { '114:100': { class_type: 'CLIPTextEncode', inputs: { text: 'unicorn', clip: ['x', 1] } } };
  const applied = applySets(g, ['114:100.text=person', '114:100.text=小雨'].slice(0, 1));
  check('按 节点.输入=值 改参', g['114:100'].inputs.text === 'person', JSON.stringify(applied));
  check('不存在的节点要报错', (() => { try { applySets(g, ['999.text=x']); return false; } catch { return true; } })());
  check('不存在的输入要报错', (() => { try { applySets(g, ['114:100.nope=1']); return false; } catch { return true; } })());
  check('格式不对要报错', (() => { try { applySets(g, ['没等号']); return false; } catch { return true; } })());
  check('setInput 返回改了什么', setInput(g, '114:100', 'text', 'x').classType === 'CLIPTextEncode');
}

console.log('工作流入参：视频输入替换');
{
  const g = {
    a: { class_type: 'LoadVideo', inputs: { file: 'old.mp4', 'video-preview': '' } },
    b: { class_type: 'GetVideoComponents', inputs: { video: ['a', 0] } },
  };
  check('写出所有 LoadVideo 节点 id', JSON.stringify(patchVideoInputs(g, 'new.mp4')) === '["a"]');
  check('file 被替换', g.a.inputs.file === 'new.mp4');
  check('没有 LoadVideo 时明确报错', (() => {
    try { patchVideoInputs({ b: { class_type: 'KSampler', inputs: {} } }, 'x.mp4'); return false; } catch { return true; }
  })());
}

console.log('工作流入参：只吃 API 格式');
{
  // 真造一个 UI 格式的样本（有 nodes 数组），别拿无关 JSON 充数
  const tmp = path.join(os.tmpdir(), `aih-ui-format-${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ nodes: [{ id: 1, type: 'LoadVideo' }], links: [] }), 'utf8');
  check('UI 格式（有 nodes 数组）被明确拒绝', (() => {
    try {
      loadWorkflow(tmp);
      return false;
    } catch (e) {
      return /UI 格式/.test(String(e.message));
    }
  })());
  fs.rmSync(tmp, { force: true });
  check('API 格式能正常加载', (() => {
    const p = path.join(os.tmpdir(), `aih-api-format-${process.pid}.json`);
    fs.writeFileSync(p, JSON.stringify({ 1: { class_type: 'LoadVideo', inputs: { file: 'x.mp4' } } }), 'utf8');
    const ok = loadWorkflow(p)['1'].class_type === 'LoadVideo';
    fs.rmSync(p, { force: true });
    return ok;
  })());
}

console.log('工作流入参：产物收集');
{
  const history = {
    outputs: {
      '95': { images: [{ filename: 'a.png', subfolder: '', type: 'temp' }] },
      '66:76': { videos: [{ filename: 'out.mp4', subfolder: 'video', type: 'output' }], images: [] },
      '114:101': {},
    },
  };
  const out = collectOutputs(history);
  check('图片与视频都收上来', out.length === 2, JSON.stringify(out.map((o) => o.filename)));
  check('带上类型与来源节点', out[0].kind === 'image' && out[0].nodeId === '95' && out[1].kind === 'video');
  check('空输出不算', !out.some((o) => o.nodeId === '114:101'));
}

console.log('工作流入参：加节点与接线（forceInput 的前提）');
{
  const g = { '114:101': { class_type: 'SAM3_Detect', inputs: { threshold: 0.5 } } };
  addNode(g, 'pt', 'PrimitiveString', { value: '[{"x":240,"y":644}]' });
  check('加节点成功且带初值', g.pt.class_type === 'PrimitiveString' && g.pt.inputs.value.includes('240'));
  check('重复 id 要报错', (() => { try { addNode(g, 'pt', 'PrimitiveString'); return false; } catch { return true; } })());
  const l = linkInput(g, '114:101', 'positive_coords', 'pt', 0);
  check('接线写成 [节点id, slot]', JSON.stringify(g['114:101'].inputs.positive_coords) === '["pt",0]', JSON.stringify(l));
  check('接不存在的源节点要报错', (() => { try { linkInput(g, '114:101', 'positive_coords', 'nope'); return false; } catch { return true; } })());
  check('接不存在的目标节点要报错', (() => { try { linkInput(g, 'nope', 'x', 'pt'); return false; } catch { return true; } })());
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
