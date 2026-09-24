import fs from 'node:fs';
import path from 'node:path';

/**
 * 解析"声明的落幅"（`cli/unit.mjs` 的 `--last-keyframe` 缺省来源）。
 *
 * ## 它是什么
 *
 * 落幅 = **画出来的**尾帧（`keyframe-prompts/<unit>.last.txt` 直写 → 生成），
 * 决定"这一镜该停在哪"。出片时它当 `--last-keyframe` → fl2v：首帧 + 落幅夹逼。
 *
 * 实测收益（lab/spatial pilot-05/06）：
 * - 落点稳定性：同一镜两次之间的 drift 波动 0.089 → 0.001
 * - 复杂运镜：相邻帧差中位 19–23 → 2.8–3.7，背景漂移 p90 79.5–94.5 → 28.5–29
 *
 * ## 与 `last_frame` 的区别（别再混）
 *
 * | 字段 | 怎么来的 | 干什么 |
 * |---|---|---|
 * | `last_frame` | 常从成片里**抽**出来 | 剪辑衔接（下一镜接这一镜的尾） |
 * | `last_keyframe` | **画**出来的 | 出片时当 fl2v 的尾帧，钉住本镜落点 |
 *
 * ## 契约
 *
 * 两级来源，**找不到就返回 null** —— 该单元退回 i2v，行为与从前一字不差
 * （不报错、不阻塞、不需要迁移老项目）：
 *
 * 1. 执行计划槽位 `units[].last_keyframe`（`compile-units` 编译期就写好的路径）
 * 2. 板子里与本次首帧对应的那一镜的 `shots[].last_keyframe`（手工声明的板子）
 *
 * @returns {string|null} 落幅的绝对路径；没有就 null
 */
export function resolveDeclaredLastKeyframe({
  unit = {},
  board = {},
  boardPath = '.',
  workspace = process.cwd(),
  firstKeyframe = null,
} = {}) {
  const projectDir = path.dirname(path.resolve(boardPath));

  const fromPlan = unit.last_keyframe ? path.resolve(projectDir, unit.last_keyframe) : null;
  if (fromPlan && fs.existsSync(fromPlan)) return fromPlan;

  if (firstKeyframe) {
    const want = path.resolve(firstKeyframe);
    const hit = (board.shots || []).find(
      (shot) => shot.last_keyframe && shot.first_frame && path.resolve(workspace, shot.first_frame) === want,
    );
    if (hit) {
      const candidate = path.resolve(workspace, hit.last_keyframe);
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  return null;
}
