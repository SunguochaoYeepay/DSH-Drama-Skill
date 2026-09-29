import fs from 'node:fs';
import path from 'node:path';
import { approvalStatus, requireApproval } from './human-gates.mjs';

/**
 * 白膜在闸门里的接线（2026-09-29 第 4 步）。
 *
 * ## 粒度
 * **一个编译单元 = 一份白膜规划 JSON = 一段白膜视频**。跟 clip 一票对一段，
 * 复用 `src/human-gates.mjs` 现成的哈希绑定，不另起一套。
 *
 * ## 绑什么、为什么
 * 白膜票绑**规划 JSON 的字节**（改一个坐标，票立刻废 —— 防"确认 A 交付 B"）；
 * clip 票除视频外再绑**白膜视频 + 规划 JSON**（追加在 `result.json` 的 `files[]` 末尾，
 * 与落幅同一条机制），于是「白膜换了但视频没重出」也会被抓出来。
 *
 * ## 单一所有者
 * 白膜产物落在哪只在这里定义 —— `cli/whitebox.mjs` 的默认输出目录必须与
 * {@link whiteboxOutDir} 一致，否则票会绑到一个不存在的文件上。
 */
export const WHITEBOX_STAGE = 'whitebox';

/** 单元的默认白膜规划文件名：`<剧目>/units/<单元 id>.whitebox.json`。 */
export function whiteboxPlanPath(projectDir, unit) {
  const declared = unit?.whitebox;
  if (declared) return path.resolve(projectDir, declared);
  return path.join(projectDir, 'units', `${unit?.id}.whitebox.json`);
}

/**
 * 白膜渲染输出目录：**规划文件所在目录**下的 `out/whitebox/<scene_name>`。
 * 与 `cli/whitebox.mjs` 的 `--out` 缺省值同规则（两处不一致票就废在空气上）。
 */
export function whiteboxOutDir(planPath, sceneName = 'unnamed') {
  return path.join(path.dirname(path.resolve(planPath)), 'out', 'whitebox', sceneName);
}

/** 白膜视频路径（读规划里的 scene_name 才能定文件名；读不到就当没有白膜）。 */
export function whiteboxVideoPath(projectDir, unit) {
  const planPath = whiteboxPlanPath(projectDir, unit);
  if (!fs.existsSync(planPath)) return null;
  try {
    const doc = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    return path.join(whiteboxOutDir(planPath, doc.scene_name || 'unnamed'), `${doc.scene_name || 'unnamed'}.mp4`);
  } catch {
    return null;
  }
}

/** 这个单元当前存在的白膜产物（规划 JSON 在前，视频在后）：票绑的就是这两样。 */
export function whiteboxArtifactFiles(projectDir, unit) {
  const files = [];
  const planPath = whiteboxPlanPath(projectDir, unit);
  if (fs.existsSync(planPath)) files.push(planPath);
  const video = whiteboxVideoPath(projectDir, unit);
  if (video && fs.existsSync(video)) files.push(video);
  return files;
}

/** 这个单元有没有白膜（决定闸门要不要管它）。 */
export function hasWhitebox(projectDir, unit) {
  return fs.existsSync(whiteboxPlanPath(projectDir, unit));
}

/**
 * 出片前的白膜闸门：**没有白膜就不设闸**（老剧目零影响）。
 * 有白膜则必须已人工确认规划 JSON —— 白膜是这一镜的空间/时序来源，没确认就出片，
 * 等于拿一份没人看过的走位去烧 5 分钟。
 */
export function requireWhiteboxApproval(projectDir, unit, { skip = false } = {}) {
  const files = whiteboxArtifactFiles(projectDir, unit);
  if (!files.length) return;
  requireApproval(projectDir, WHITEBOX_STAGE, files, { id: unit.id, skip });
}

/**
 * 把白膜产物并入单元的产物清单（**追加在末尾**），返回是否真的加了东西。
 *
 * clip 票绑 `result.json` 的 `files[]` 全部 ⇒ 白膜规划 JSON 或白膜视频变一个字节，
 * 这一段的人工确认自动作废（防「确认了 A 白膜、出的是 B 白膜的片」）。
 * 追加在末尾是硬要求：`assemble-units` 取 `files[0]` 当输入片段，视频必须稳坐首位。
 * 抽成函数是为了**可测** —— 否则这段只有真出一次片（5 分钟烧卡）才走得到。
 */
export function appendWhiteboxArtifacts(projectDir, unit, result) {
  if (!result || !Array.isArray(result.files)) return false;
  let appended = false;
  for (const file of whiteboxArtifactFiles(projectDir, unit)) {
    if (!result.files.includes(file)) {
      result.files.push(file);
      appended = true;
    }
  }
  return appended;
}

/** 白膜票的当前状态（给 `review-gate status` 与诊断用）。 */
export function whiteboxApprovalStatus(projectDir, unit) {
  const files = whiteboxArtifactFiles(projectDir, unit);
  if (!files.length) return { ok: false, reason: '这个单元没有白膜' };
  return approvalStatus(projectDir, WHITEBOX_STAGE, files, unit.id);
}
