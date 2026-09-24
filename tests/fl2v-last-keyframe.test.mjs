/**
 * fl2v 落幅：把"这一镜停在哪"从提示词的祈祷变成**硬约束**。
 *
 * 来历：`cli/unit.mjs` 早就能用 `--last-keyframe` 走 fl2v，但没有任何东西生产落幅，
 * 这条杠杆一直睡着。试验箱（lab/spatial/pilot-05/06）量出来的收益：
 *   · 落点波动 0.089 → 0.001（同一镜两次之间的 drift 差）
 *   · 复杂运镜的相邻帧差 19–23 → 2.8–3.7；背景漂移 p90 79.5–94.5 → 28.5–29
 *
 * 这个测试守的是**接线**：声明落幅 → 计划选 fl2v；没声明 → 行为与从前一字不差。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { flfPlan } from '../src/orchestrate.mjs';
import { compileGenerationPlan } from '../src/generation-plan.mjs';
import { resolveDeclaredLastKeyframe } from '../src/last-keyframe.mjs';

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

console.log('fl2v 落幅：计划选 fl2v');
{
  const board = {
    shots: [
      { id: 'g001', first_frame: 'keyframes_render/g001.png', last_keyframe: 'keyframes_render/g001_last.png', transition: { type: 'cut' } },
    ],
  };
  const [p] = flfPlan(board);
  check('声明了落幅 → mode=fl2v', p.mode === 'fl2v', `mode=${p.mode}`);
  check('last 用的是声明的落幅', p.last === 'keyframes_render/g001_last.png', `last=${p.last}`);
  check('理由里点明"落幅"', /落幅/.test(p.why), p.why);
}

console.log('fl2v 落幅：没声明就一如今日（i2v）');
{
  const board = { shots: [{ id: 'g001', first_frame: 'keyframes_render/g001.png', transition: { type: 'cut' } }] };
  const [p] = flfPlan(board);
  check('没有落幅 → 仍是 i2v', p.mode === 'i2v', `mode=${p.mode}`);
  check('last 为空', p.last === null, `last=${p.last}`);
}

console.log('fl2v 落幅：不破坏原有的"衔接夹逼"分支');
{
  const board = {
    shots: [
      { id: 'g001', first_frame: 'a.png', transition: { type: 'last_frame_first' } },
      { id: 'g002', first_frame: 'b.png', transition: { type: 'cut' } },
    ],
  };
  const [p] = flfPlan(board);
  check('衔接镜仍能夹逼出 fl2v', p.mode === 'fl2v', `mode=${p.mode}`);
  check('夹逼取的是下一镜首帧', p.last === 'b.png', `last=${p.last}`);
}

console.log('fl2v 落幅：执行计划槽位');
{
  const direction = {
    version: 2,
    units: [
      {
        id: 'u1',
        shots: [
          {
            n: 1, at: 0, duration_s: 5, framing: '中景', camera: '固定不动',
            scene: 's1', on_screen: ['i_a'], action: '她站着', emotion_analysis: [], lines: [], audio: '环境音',
            transition: { type: 'cut' },
          },
        ],
      },
    ],
  };
  const plan = compileGenerationPlan(direction, { targetSeconds: 12, maxSeconds: 15 });
  check('计划声明了 last_keyframe 槽位', Boolean(plan.units[0]?.last_keyframe), JSON.stringify(plan.units[0]?.last_keyframe));
  check('槽位与 keyframe 同构（_last 后缀）', /g001_last\.png$/.test(String(plan.units[0]?.last_keyframe || '')), String(plan.units[0]?.last_keyframe));
  check('落幅槽位与首帧槽位不同', plan.units[0]?.last_keyframe !== plan.units[0]?.keyframe);
}

console.log('fl2v 落幅：schema 承认这个字段');{
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schema', 'storyboard.schema.json'), 'utf8'));
  const shotProps = schema?.properties?.shots?.items?.properties || {};
  check('shots[].last_keyframe 在 schema 里', Boolean(shotProps.last_keyframe), Object.keys(shotProps).filter((k) => /last/.test(k)).join(','));
  check('类型是 string|null', JSON.stringify(shotProps.last_keyframe?.type) === '["string","null"]', JSON.stringify(shotProps.last_keyframe?.type));
  check('描述里说明它与 last_frame 的区别', /last_frame/.test(String(shotProps.last_keyframe?.description || '')));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
