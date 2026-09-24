/**
 * VOID 去字幕那层的地基：字幕带 → 像素矩形、掩码文件接线、掩码极性。
 *
 * 这个测试守着**踩过的那个坑**：VOID 的 quadmask 是「白=保留，黑=要修」，
 * 与 ComfyUI 常规相反。极性反了不会报错，只会把整帧重画成无关画面（实测过一次：
 * 全白掩码 = 原样透传、白带黑底 = 输出变成黑底小孩脸）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bandToPixels, buildVoidDesubGraph } from '../src/void-desub.mjs';
import { COMFY_PYTHON } from '../src/runtime-paths.mjs';

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

/** 一个最小的 VOID 图（只保留这套改造真正用到的节点）。 */
const minimalWorkflow = () => ({
  '167:10': {
    class_type: 'VOIDInpaintConditioning',
    inputs: { quadmask: ['167:149:75', 0], width: ['167:147', 0], height: ['167:148', 0] },
    _meta: { title: 'VOIDInpaintConditioning' },
  },
  '167:147': { class_type: 'PrimitiveInt', inputs: { value: 672 }, _meta: { title: 'Int (Width)' } },
  '167:148': { class_type: 'PrimitiveInt', inputs: { value: 384 }, _meta: { title: 'Int (Height)' } },
  '167:163': { class_type: 'PrimitiveInt', inputs: { value: 5 }, _meta: { title: 'Int (Video duration)' } },
  '167:153': { class_type: 'PrimitiveBoolean', inputs: { value: false }, _meta: { title: 'Boolean (Skip Pass 2?)' } },
  '167:6': { class_type: 'CLIPTextEncode', inputs: { text: 'x', clip: ['167:2', 0] }, _meta: { title: 'Positive Prompt' } },
  '167:149:75': { class_type: 'SAM3_Detect', inputs: {} },
});

console.log('字幕带 → 像素矩形');
{
  const r = bandToPixels({ top: 0.1, bottom: 0.3, left: 0.2, right: 0.4 }, { width: 100, height: 100 });
  check('百分比换算正确', JSON.stringify(r) === '{"x":20,"y":10,"width":20,"height":20}', JSON.stringify(r));
  const full = bandToPixels({ top: 0, bottom: 1, left: 0, right: 1 }, { width: 480, height: 864 });
  check('整幅带不出界', full.x === 0 && full.y === 0 && full.width === 480 && full.height === 864, JSON.stringify(full));
  check('bottom<=top 报错', (() => { try { bandToPixels({ top: 0.8, bottom: 0.2 }, { width: 10, height: 10 }); return false; } catch { return true; } })());
  check('right<=left 报错', (() => { try { bandToPixels({ left: 0.6, right: 0.4 }, { width: 10, height: 10 }); return false; } catch { return true; } })());
  check('越界百分比报错', (() => { try { bandToPixels({ top: -0.1 }, { width: 10, height: 10 }); return false; } catch { return true; } })());
  check('非法尺寸报错', (() => { try { bandToPixels({}, { width: 0, height: 10 }); return false; } catch { return true; } })());
}

console.log('改造工作流：接线与参数');
{
  const source = minimalWorkflow();
  const { graph, plan } = buildVoidDesubGraph({
    workflow: source,
    videoWidth: 480,
    videoHeight: 864,
    band: { top: 0.695, bottom: 0.805, left: 0.28, right: 0.72 },
    passes: 2,
    durationSeconds: 3,
    maskFileName: 'band.png',
    prompt: 'office interior',
  });

  check('quadmask 改由我们的掩码给', JSON.stringify(graph['167:10'].inputs.quadmask) === '["desub_quad",0]', JSON.stringify(graph['167:10'].inputs.quadmask));
  check('掩码走文件（LoadImageMask）', graph.desub_mask.class_type === 'LoadImageMask' && graph.desub_mask.inputs.image === 'band.png');
  check('取 red 通道（灰度 PNG 也能读）', graph.desub_mask.inputs.channel === 'red');
  check('quadmask 前处理接上', JSON.stringify(graph.desub_quad.inputs.mask) === '["desub_mask",0]');
  check('处理分辨率 = 视频原生', graph['167:147'].inputs.value === 480 && graph['167:148'].inputs.value === 864);
  check('时长写进去', graph['167:163'].inputs.value === 3);
  check('两趟 → 不跳过第 2 趟', graph['167:153'].inputs.value === false);
  check('正向提示写进去', graph['167:6'].inputs.value === 'office interior');
  check('原图没被改（只改副本）', JSON.stringify(source['167:10'].inputs.quadmask) === '["167:149:75",0]');
  check('plan 里留下像素带与接线', plan.band_px.width === 212 && plan.wired.quadmask_from === '167:10' && plan.mask_file === 'band.png', JSON.stringify(plan.band_px));
  check('缺 maskFileName 要报错', (() => {
    try { buildVoidDesubGraph({ workflow: minimalWorkflow(), videoWidth: 10, videoHeight: 10, band: {} }); return false; } catch (e) { return /maskFileName/.test(String(e.message)); }
  })());
}

console.log('改造工作流：一趟与报错');
{
  const one = buildVoidDesubGraph({
    workflow: minimalWorkflow(), videoWidth: 480, videoHeight: 864,
    band: { top: 0.7, bottom: 0.8 }, passes: 1, maskFileName: 'band.png',
  });
  check('一趟 → 跳过第 2 趟', one.graph['167:153'].inputs.value === true);
  check('不传时长就不动它', one.graph['167:163'].inputs.value === 5);

  const broken = minimalWorkflow();
  delete broken['167:153'];
  check('缺节点要报清楚', (() => {
    try {
      buildVoidDesubGraph({ workflow: broken, videoWidth: 10, videoHeight: 10, band: {}, maskFileName: 'b.png' });
      return false;
    } catch (e) {
      return /Skip Pass 2/.test(String(e.message));
    }
  })());
}

console.log('掩码生成脚本（极性由它负责）');
{
  if (!COMFY_PYTHON || !fs.existsSync(COMFY_PYTHON)) {
    console.log('  ⚠ 没有 ComfyUI python，跳过这一节（不判失败）');
  } else {
    const out = path.join(os.tmpdir(), `aih-band-${process.pid}.png`);
    const r = spawnSync(COMFY_PYTHON, [
      path.join(ROOT, 'tools', 'band_mask.py'),
      '--size', '100x100', '--top', '0.2', '--bottom', '0.4', '--left', '0.1', '--right', '0.3',
      '--out', out,
    ], { encoding: 'utf8' });
    let j = null;
    try { j = JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch { j = null; }
    check('脚本跑通并输出 JSON', r.status === 0 && j && j.band_px, String(r.stderr || '').slice(0, 200));
    if (j) {
      check('几何正确（x10 y20 w20 h20）', j.band_px.x === 10 && j.band_px.y === 20 && j.band_px.width === 20 && j.band_px.height === 20, JSON.stringify(j.band_px));
      check('极性写明（黑=要修）', j.polarity === 'black=repair, white=keep');
      check('黑占约 4%（20×20 / 100×100）', Math.abs(j.black_ratio - 0.04) < 0.005, String(j.black_ratio));
      check('掩码文件真的写出来了', fs.existsSync(out) && fs.statSync(out).size > 0);
    }
    check('越界参数被拒绝', spawnSync(COMFY_PYTHON, [path.join(ROOT, 'tools', 'band_mask.py'), '--size', '100x100', '--top', '0.9', '--bottom', '0.1', '--out', out], { encoding: 'utf8' }).status !== 0);
    fs.rmSync(out, { force: true });

    // 真正的那个带：Python 画的矩形必须和 Node 算的**逐像素相同**（差 1 像素就是画错地方）
    const realOut = path.join(os.tmpdir(), `aih-band-real-${process.pid}.png`);
    const realBand = { top: 0.695, bottom: 0.805, left: 0.28, right: 0.72 };
    const rr = spawnSync(COMFY_PYTHON, [
      path.join(ROOT, 'tools', 'band_mask.py'),
      '--size', '480x864',
      '--top', String(realBand.top), '--bottom', String(realBand.bottom),
      '--left', String(realBand.left), '--right', String(realBand.right),
      '--out', realOut,
    ], { encoding: 'utf8' });
    let rj = null;
    try { rj = JSON.parse(String(rr.stdout).trim().split('\n').pop()); } catch { rj = null; }
    const mine = bandToPixels(realBand, { width: 480, height: 864 });
    check('Python 与 Node 算出同一个矩形', Boolean(rj) && JSON.stringify(rj.band_px) === JSON.stringify(mine),
      `${JSON.stringify(rj && rj.band_px)} vs ${JSON.stringify(mine)}`);
    fs.rmSync(realOut, { force: true });
  }
}

console.log('带 → 像素：三处算法必须给出同一个矩形');
{
  // 掩码是 band_mask.py 画的、核查是 rectOf 量的、图里写的是 bandToPixels 算的。
  // 三者只要有一个取整方式不同，"修的带"和"量的带"就错开 1 像素 —— 静默的错。
  const rectOf = (await import('../src/video-diff.mjs')).rectOf;
  const bands = [
    { top: 0.695, bottom: 0.805, left: 0.28, right: 0.72 },
    { top: 0, bottom: 1, left: 0, right: 1 },
    { top: 0.71, bottom: 0.87, left: 0.1, right: 0.9 },
    { top: 0.333, bottom: 0.667, left: 0.123, right: 0.987 },
  ];
  let same = true;
  let detail = '';
  for (const band of bands) {
    for (const [w, h] of [[480, 864], [768, 1344], [100, 100], [1920, 1080]]) {
      const a = JSON.stringify(bandToPixels(band, { width: w, height: h }));
      const b = JSON.stringify(rectOf(band, w, h));
      if (a !== b) { same = false; detail = `${w}x${h} ${JSON.stringify(band)}: ${a} vs ${b}`; }
    }
  }
  check('bandToPixels === rectOf（含整数倍与含零带）', same, detail);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
