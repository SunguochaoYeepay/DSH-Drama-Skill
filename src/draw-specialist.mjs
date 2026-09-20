/**
 * 抽卡师：把导演的静态意图编译成生图模型更容易执行的语言。
 * 这是确定性执行层，不改剧情、台词或导演单元结构。
 */
export function compileDrawPlan({ unit, shot, override = '' }) {
  const source = String(unit.keyframe_start || shot.action || '').trim()
    .replace(/^0\s*秒(?:时|时刻)?[：:，,\s]*/u, '');
  const conflicts = [];
  // 卧/趴判定拆成两条触发器，**不能共用一个正则**：
  // · onSurface（宽）——任何卧/趴/躺姿都要"重心落在承托表面"的空间几何约束，
  //   否则模型会把趴姿画成漂浮（fat_cat 2026-09-20：猫趴遮阳棚两度飘成飞天/悬空）；
  // · bed（窄，只认寝具语境）——"禁鞋禁站立"规则是卧室戏的教训，只有床/枕头/
  //   被褥/睡眠才触发。带裸「趴」字的宽正则会把趴在棚顶/桌上的镜头误判成床上躺卧，
  //   把卧室规则注入关键帧，与继承姿态打架。
  const onSurface = /躺|卧|仰面|侧躺|趴/u.test(`${source} ${override}`);
  if (onSurface && ['近景', '特写'].includes(shot.framing)) {
    conflicts.push('当前景别难以证明人物与床的完整空间关系；应改用中景或斜侧中景，除非只需表现脸部状态');
  }
  // ⚠ 这里**不再重复**「关键帧起始姿态」—— buildPrompt / buildLocalPrompt 已经说过一遍。
  // 2026-09-20 no_chute 对照实验：关键帧提示词 1300 字里景别说 3 遍、姿态说 2 遍，
  // 重复块占 40%，五连抽全废；同样的参考图与参数，130 字四句一发命中。
  // 本函数只输出它独有的增量（空间几何 / 冲突提示 / 执行层补充约束）。
  const prompt = [
    onSurface ? '空间几何：人物重心必须落在承托表面上；身体朝向、四肢位置和承托物的长宽方向必须一致，禁止悬空、横置或斜向穿过空间。' : '',
    conflicts.length ? `抽卡师提示：${conflicts.join('；')}` : '',
    override ? `执行层补充约束：${override}` : '',
  ].filter(Boolean).join('\n');
  return { source, conflicts, prompt };
}

export function compileCharacterDesign({ designs = [], unit, shot }) {
  const ids = new Set(unit.keyframe_cast || unit.cast || shot.on_screen || []);
  const relevant = designs.filter((item) => item.kind === 'character_design' && ids.has(item.identity_id));
  const keep = relevant.flatMap((item) => [item.locked?.face, item.locked?.appearance].filter(Boolean));
  const bed = /躺|床|枕头|被褥|睡眠|刚醒|睡醒/u.test(`${shot.action || ''} ${unit.keyframe_start || ''}`);
  const exclude = bed
    ? ['当前镜头不应出现鞋子、拖鞋或站立姿态；不要把身份图中的鞋履和站立姿势复制到床上躺卧镜头。']
    : [];
  return { keep, exclude, prompt: [
    keep.length ? `【人物造型师锁定】${keep.join('；')}` : '',
    exclude.length ? `【人物造型师当前镜头排除】${exclude.join('；')}` : '',
  ].filter(Boolean).join('\n') };
}
