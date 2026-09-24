/**
 * 空间核查：**只判机器能判的，把不能判的明确列成"待人工"。**
 *
 * 这个测试守两件事：
 * 1. 轴（越轴）这条**纯逻辑**判断是对的 —— 六轮实验里唯一"机器比人可靠"的空间结论；
 * 2. 单向朝向、人数不一致这些**真出过事**的形态能被抓出来（table_for_two 的 g001
 *    就是"两人各自看自己盘子"的翻车，声明写成单向朝向时这里应当报警）。
 */

import { axisWarnings, facingWarnings, gazeConsistencyWarnings, renderSpaceReport, unitChecklist } from '../src/space-check.mjs';

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

const unit = (id, scene = 's1') => ({ id, scene });

console.log('轴（越轴）检查');
{
  const units = [unit('g001'), unit('g002'), unit('g003')];
  // 更正过的一条：过肩正反打**合法地**跨两侧拍 —— 机位侧翻转只给 info，不当越轴
  const space = { units: { g001: { camera_side: 'A' }, g002: { camera_side: 'B' }, g003: { camera_side: 'B' } } };
  const w = axisWarnings(units, space);
  check('机位侧翻转 → info（不是告警）', w.length === 1 && w[0].level === 'info', JSON.stringify(w));

  const withOnAxis = { units: { g001: { camera_side: 'A' }, g002: { camera_side: 'on-axis' }, g003: { camera_side: 'B' } } };
  check('隔了骑轴镜 → 连 info 都没有', axisWarnings(units, withOnAxis).length === 0, JSON.stringify(axisWarnings(units, withOnAxis)));

  const intentional = { units: { g001: { camera_side: 'A' }, g002: { camera_side: 'B', intentional_cross: true }, g003: { camera_side: 'B' } } };
  check('写明 intentional_cross → 不吵', axisWarnings(units, intentional).length === 0, JSON.stringify(axisWarnings(units, intentional)));

  check('换场不算越轴', axisWarnings([unit('g001', 's1'), unit('g002', 's2')], { units: { g001: { camera_side: 'A' }, g002: { camera_side: 'B' } } }).length === 0);
  check('没声明机位侧 → 不猜', axisWarnings(units, { units: {} }).length === 0);

  // 真正的越轴症状：同一主体的视线方向在相邻两镜之间翻转
  const eye = {
    units: {
      g001: { subjects: [{ id: 'she', facing: 'screen_right' }] },
      g002: { subjects: [{ id: 'she', facing: 'screen_left' }] },
    },
  };
  const we = axisWarnings([unit('g001'), unit('g002')], eye);
  check('视线方向翻转 → 告警（这才是越轴）', we.length === 1 && we[0].level === 'warn', JSON.stringify(we));

  const eyeSame = {
    units: {
      g001: { subjects: [{ id: 'she', facing: 'screen_right' }] },
      g002: { subjects: [{ id: 'she', facing: 'screen_right' }] },
    },
  };
  check('视线方向一致 → 不告警（视线守恒）', axisWarnings([unit('g001'), unit('g002')], eyeSame).length === 0);

  const eyeIntentional = {
    units: {
      g001: { subjects: [{ id: 'she', facing: 'screen_right' }] },
      g002: { subjects: [{ id: 'she', facing: 'screen_left' }], intentional_cross: true },
    },
  };
  const wi2 = axisWarnings([unit('g001'), unit('g002')], eyeIntentional);
  check('视线翻转但声明了刻意 → 降级为 info', wi2.length === 1 && wi2[0].level === 'info', JSON.stringify(wi2));
}

console.log('朝向检查（"各看各的"就是从这儿开始的）');
{
  const space = {
    units: {
      g001: {
        subjects: [
          { id: 'she', facing: 'toward:he' },
          { id: 'he', facing: 'toward:she' },
        ],
      },
    },
  };
  check('互相朝向 → 不报警', facingWarnings({ id: 'g001' }, space).length === 0);

  const oneWay = { units: { g001: { subjects: [{ id: 'she', facing: 'toward:he' }, { id: 'he', facing: 'screen_left' }] } } };
  check('单向朝向 → 报警（容易画成各看各的）', facingWarnings({ id: 'g001' }, oneWay).length === 1, JSON.stringify(facingWarnings({ id: 'g001' }, oneWay)));

  const missing = { units: { g001: { subjects: [{ id: 'she', facing: 'toward:nobody' }] } } };
  check('朝向一个本镜不存在的人 → 报警', facingWarnings({ id: 'g001' }, missing).length === 1);
}

console.log('单镜核查条目');
{
  const space = {
    units: {
      g001: {
        camera_side: 'A',
        subjects: [{ id: 'she', at: '她席位', facing: 'toward:he' }, { id: 'he', at: '他席位' }],
        relations: ['隔桌相对'],
        human_review: '两人必须隔桌相向',
      },
    },
  };
  const okCase = unitChecklist({ id: 'g001' }, space, { present: true, n_person: 2 });
  check('人数一致 → count_ok', okCase.auto.count_ok === true, JSON.stringify(okCase.auto));
  check('把"相向"列进待人工确认（不假装能自动判）', okCase.human.some((h) => /相向/.test(h)), JSON.stringify(okCase.human));
  check('朝向对方也进待确认', okCase.human.some((h) => /朝向 he/.test(h)));

  const bad = unitChecklist({ id: 'g001' }, space, { present: true, n_person: 1 });
  check('人数不一致 → count_ok=false', bad.auto.count_ok === false);
  const empty = unitChecklist({ id: 'g001' }, space, { present: false, n_person: 0 });
  check('画面里没人 → present=false', empty.auto.present === false);

  const undeclared = unitChecklist({ id: 'g009' }, space, null);
  check('未声明的镜 → declared 为 null', undeclared.declared === null);
}

console.log('核查单渲染');
{
  const md = renderSpaceReport({
    project: 'demo',
    checklists: [
      { unit: 'g001', scene: 's1', declared: { camera_side: 'A', subjects: ['she@她席位'], relations: ['隔桌相对'] }, auto: { present: true, detected: 2, expected: 1, count_ok: false }, human: ['两人必须隔桌相向'], verified: { by: 'agent-visual', result: 'fail', note: '实际并排同侧' } },
      { unit: 'g002', scene: 's1', declared: null, auto: {}, human: [] },
    ],
    warnings: [{ level: 'warn', unit: 'g002', message: '可能越轴' }],
  });
  check('渲染出告警段', /可能越轴/.test(md));
  check('渲染出"未声明"', /没有任何声明可供核对/.test(md));
  check('渲染出人数不一致', /✗ 不一致/.test(md));
  check('渲染出人工核对结论', /❌ \*\*与声明不符\*\*/.test(md) && /实际并排同侧/.test(md));
  check('渲染出待确认清单', /- \[ \] 两人必须隔桌相向/.test(md));
}

console.log('视线一致性（人看方向，机器查一致性）');
{
  const g = (space) => gazeConsistencyWarnings({ id: 'g003' }, { units: { g003: space } });

  // 同一镜内两人同向：物理上意味着没在看对方
  const sameShot = {
    shots: [
      { n: 1, camera_side: 'A', subjects: [{ id: 'he', facing: 'screen_left' }, { id: 'she', facing: 'screen_left' }] },
    ],
  };
  check('同一镜内两人同向 → 告警', g(sameShot).some((w) => w.level === 'warn' && /同一班公交|没有在看对方/.test(w.message)), JSON.stringify(g(sameShot), null, 0));

  // g003 的真实形态：跨内部镜、同机位侧、两人同向
  const crossShotSameSide = {
    shots: [
      { n: 2, camera_side: 'A', subjects: [{ id: 'he', facing: 'screen_left' }] },
      { n: 3, camera_side: 'A', subjects: [{ id: 'she', facing: 'toward_lens' }], observed: { she: 'screen_left' } },
    ],
  };
  const w1 = g(crossShotSameSide);
  check('跨内部镜·同机位侧·同向 → 告警（g003 就是这个）', w1.length === 1 && /没有在看对方/.test(w1[0].message), JSON.stringify(w1));

  // 合法正反打：两侧机位，方向相同是正常的
  const crossShotDiffSide = {
    shots: [
      { n: 2, camera_side: 'A', subjects: [{ id: 'he', facing: 'screen_left' }] },
      { n: 3, camera_side: 'B', subjects: [{ id: 'she', facing: 'screen_left' }] },
    ],
  };
  check('跨内部镜但机位不同侧 → 不告警（合法正反打）', g(crossShotDiffSide).length === 0, JSON.stringify(g(crossShotDiffSide)));

  // 反向：一个朝左一个朝右 = 在看对方
  const opposite = {
    shots: [
      { n: 2, camera_side: 'A', subjects: [{ id: 'he', facing: 'screen_left' }] },
      { n: 3, camera_side: 'A', subjects: [{ id: 'she', facing: 'screen_right' }] },
    ],
  };
  check('两人方向相反 → 不告警（这才是对视）', g(opposite).length === 0, JSON.stringify(g(opposite)));

  // 朝镜头 = 看着镜头那一侧的人，不是"屏方向"，不该参与同向判断
  const lens = {
    shots: [
      { n: 2, camera_side: 'A', subjects: [{ id: 'he', facing: 'toward_lens' }] },
      { n: 3, camera_side: 'A', subjects: [{ id: 'she', facing: 'toward_lens' }] },
    ],
  };
  check('两人都朝镜头 → 不告警（g001 的形态，正确）', g(lens).length === 0, JSON.stringify(g(lens)));

  check('没有 shots 声明 → 不猜', gazeConsistencyWarnings({ id: 'g001' }, { units: { g001: { camera_side: 'A' } } }).length === 0);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
