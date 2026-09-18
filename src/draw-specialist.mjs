/**
 * 抽卡师：把导演的静态意图编译成生图模型更容易执行的语言。
 * 这是确定性执行层，不改剧情、台词或导演单元结构。
 */
export function compileDrawPlan({ unit, shot, override = '' }) {
  const source = String(unit.keyframe_start || shot.action || '').trim()
    .replace(/^0\s*秒(?:时|时刻)?[：:，,\s]*/u, '');
  const conflicts = [];
  const lying = /躺|卧|仰面|侧躺|趴/u.test(`${source} ${override}`);
  if (lying && ['近景', '特写'].includes(shot.framing)) {
    conflicts.push('当前景别难以证明人物与床的完整空间关系；应改用中景或斜侧中景，除非只需表现脸部状态');
  }
  const prompt = [
    `关键帧起始姿态：${source}`,
    lying ? '空间几何：人物重心必须落在承托表面上；身体朝向、四肢位置和承托物的长宽方向必须一致，禁止悬空、横置或斜向穿过空间。' : '',
    conflicts.length ? `抽卡师提示：${conflicts.join('；')}` : '',
    override ? `执行层补充约束：${override}` : '',
  ].filter(Boolean).join('\n');
  return { source, conflicts, prompt };
}
