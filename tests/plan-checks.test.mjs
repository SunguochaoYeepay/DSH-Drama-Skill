/**
 * 计划级"静默失败"检查。
 *
 * 这两个检查来自**真事**，不是假想：
 *   · table_for_two 的 g001 是唯一没有 keyframe-prompts/g001.last.txt 的单元 →
 *     它静默退回 i2v，没有任何提示；而 i2v 与 fl2v 的差别实测很大
 *     （相邻帧差中位 23.2 → 6.2、背景漂移 p90 130 → 50.5），失败的那一镜恰好就是它。
 *   · 同项目的看板把 3 个道具列在「用到的资源」里，而本地通道**一张道具都不下发** →
 *     连写代码的我都被误导，往"道具锚点"上找了半天原因。
 *
 * 这个测试守的是：**检查不许悄悄改变生成行为，只许把话说明白。**
 */

import { channelPassesProps, lastKeyframeAdvice, referenceAdvice } from '../src/plan-checks.mjs';

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

console.log('落幅检查');
{
  check(
    '有落幅 → 不吵',
    lastKeyframeAdvice({ unitId: 'g001', hasLastKeyframe: true, planDeclaresSlot: true, hasLastPromptFile: true }) === null,
  );

  const a = lastKeyframeAdvice({ unitId: 'g001', hasLastKeyframe: false, planDeclaresSlot: true, hasLastPromptFile: false });
  check('计划要落幅但没直写文件 → 警告', /^⚠/.test(String(a)) && /last\.txt/.test(String(a)), String(a));

  const b = lastKeyframeAdvice({ unitId: 'g001', hasLastKeyframe: false, planDeclaresSlot: true, hasLastPromptFile: true });
  check('有直写但落幅没生成 → 警告并指向 --with-last', /^⚠/.test(String(b)) && /--with-last/.test(String(b)), String(b));

  const c = lastKeyframeAdvice({ unitId: 'g001', hasLastKeyframe: false, planDeclaresSlot: false, hasLastPromptFile: false });
  check('项目本来不用落幅 → 只说事实（不制造噪音）', /^ℹ/.test(String(c)) && /i2v/.test(String(c)), String(c));
}

console.log('参考图/道具检查');
{
  check('没声明道具 → 不说话', referenceAdvice({ unitId: 'g001', channel: 'local', refCount: 3, declaredProps: [] }) === null);

  const a = referenceAdvice({ unitId: 'g001', channel: 'local', refCount: 3, declaredProps: ['p1', 'p2', 'p3'] });
  check('本地通道 + 道具 → 明说"不进参考图"', /不进参考图/.test(String(a)) && /3 张/.test(String(a)), String(a));

  const b = referenceAdvice({ unitId: 'g001', channel: 'huimeng', refCount: 6, declaredProps: ['p1'] });
  check('绘梦通道 + 道具 → 说明会一并下发', /一并下发/.test(String(b)), String(b));

  check('只有绘梦通道传道具', channelPassesProps('huimeng') === true);
  check('本地通道不传道具', channelPassesProps('local') === false);
  check('百炼通道不传道具', channelPassesProps('bailian') === false);
  check('火山通道不传道具', channelPassesProps('volcengine') === false);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
