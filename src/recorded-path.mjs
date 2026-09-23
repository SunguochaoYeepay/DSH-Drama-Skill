import fs from 'node:fs';
import path from 'node:path';

/**
 * 「记录下来的路径」→ 真实文件的**唯一所有者**。
 *
 * ## 为什么需要它
 *
 * 产物记录（`units/<id>.result.json` 的 `local_path`、票里的 `artifacts`）里躺着的路径
 * **有三种历史写法**，而各消费方过去各自按不同基准解析，于是同一份记录在不同地方
 * "存在"或"不存在"：
 *
 * 1. **仓库相对**（`examples/demo-show/units/x.mp4`）—— 现在的写法（`cli/unit.mjs` 就写这个）；
 * 2. **剧目相对**（`units/x.mp4`）—— 看板过去按剧目解析，CLI 按 cwd 解析；
 * 3. **本机绝对**（`E:\AI-Image\…\x.mp4`）—— 老项目搬家前的残留，或 ComfyUI 的原始输出。
 *
 * 2026-09-23 实测的坑：往 `files[]` 里插一条**剧目相对**的去字幕片段，
 * 看板认（按剧目解析）、CLI 当"不存在"过滤掉 —— 票看着"没失效"，其实那条根本没生效，
 * 指纹照旧算的是原片。同一份记录、两个答案，这种不一致迟早咬人。
 *
 * ## 规则
 *
 * 按顺序试，**第一个真实存在的**算数（都不存在返回 `null`，绝不编造）：
 *   ① 绝对路径原样（存在就用）
 *   ② 相对 → 先按**剧目目录**，再按**仓库根**，最后按**末级目录/文件名**在剧目里兜底
 *
 * 写入时请用 `recordedPathFor()` —— 统一写**仓库相对**（能写的话），
 * 这样入库文件里不会出现本机目录结构。
 */

/** 仓库根：往上找 `.git` 或 `package.json`；找不到返回 null（绝不猜）。 */
export function repoRootOf(startDir) {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 10; i += 1) {
    if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const isAbsolutePath = (p) => /^[A-Za-z]:[\\/]|^\\\\|^\//.test(String(p || ''));

/**
 * 记录路径 → **候选绝对路径**（按可信度排序，调用方逐个验存在性；也可以自己判）。
 * @returns {string[]}
 */
export function recordedPathCandidates(projectDir, recorded) {
  const s = String(recorded || '').trim();
  if (!s) return [];
  const out = [];
  const push = (p) => {
    if (!p) return;
    const abs = path.resolve(p);
    if (!out.includes(abs)) out.push(abs);
  };

  if (isAbsolutePath(s)) {
    push(s);                                   // ① 绝对路径原样
  } else {
    const norm = s.replace(/\\/g, '/').replace(/^\/+/, '');
    const repo = repoRootOf(projectDir);
    // 写作方（`cli/unit.mjs`）写的是**仓库相对**，形如 `examples/demo/units/x.mp4`。
    // 认出这个形态时**先按仓库根解释** —— 否则"剧目相对"会用错基准抢到前面
    //（`<剧目>/examples/demo/units/x.mp4` 通常不存在，但真撞上同名目录就错了）。
    const repoRelPrefix = repo ? path.relative(repo, path.resolve(projectDir)).split(path.sep).join('/') : null;
    const looksRepoRelative = repoRelPrefix && repoRelPrefix !== '' && norm.startsWith(`${repoRelPrefix}/`);
    if (looksRepoRelative && repo) push(path.resolve(repo, norm));
    push(path.resolve(projectDir, s));          // ②a 剧目相对
    if (repo) push(path.resolve(repo, s));      // ②b 仓库相对
  }
  // ③ 末级目录/文件名兜底（老项目把产物随剧目一起搬过的情况）
  const tail = `${path.basename(path.dirname(s))}/${path.basename(s)}`;
  if (tail && tail !== '/') push(path.resolve(projectDir, tail));
  return out;
}

/** 记录路径 → 第一个**真实存在**的绝对路径；都不存在给 null。 */
export function resolveRecordedPath(projectDir, recorded) {
  for (const cand of recordedPathCandidates(projectDir, recorded)) {
    if (fs.existsSync(cand)) return cand;
  }
  return null;
}

/**
 * 待写进记录的**展示路径**：能写成仓库相对就写仓库相对，写不了就原样。
 * 找不到仓库根、或路径在仓库外 → 原样返回（宁可留绝对路径，也不写一个假的相对路径）。
 */
export function recordedPathFor(projectDir, p) {
  const s = String(p || '');
  if (!s || !isAbsolutePath(s)) return s;
  const repo = repoRootOf(projectDir);
  if (!repo) return s;
  const abs = path.resolve(s);
  if (!abs.startsWith(repo + path.sep)) return s;
  return path.relative(repo, abs).split(path.sep).join('/');
}
