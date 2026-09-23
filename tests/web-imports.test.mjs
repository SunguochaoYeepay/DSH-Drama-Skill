import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 前端不许出现"**调用了却没 import**"的本仓库函数（2026-09-23）。
 *
 * 这个错**犯过两次**，两次都只有用户点到那个按钮时才炸：
 * 1. `videoLog(...)` 漏 import → 打包出裸引用、页面崩溃；
 * 2. `signStage(...)` 漏 import → 点「确认签署成片票」直接 `signStage is not defined`。
 *
 * 为什么构建与语法检查都拦不住：JSX 里的裸标识符在打包时**不报错**（当成全局查找）。
 * 而"点了才有事"的按钮，我们（agent）为了不越权（例如不替用户签票）恰恰**不会点** ——
 * 盲区就是这么形成的。所以这条判据要能自动抓它。
 *
 * ## 判据（故意做窄，宁少报不误报）
 *
 * 对每个 `web/src/*.{js,jsx}`：凡是出现"**本仓库某模块导出的名字 + 左括号**"
 * （即像函数调用，且前面不是 `.`，排除属性访问），该名字就必须在本文件里
 * import 进来、或本地定义。
 *
 * 为什么只认"名字("：字符串/注释里出现的裸名字（比如文档里写一句 `signStage`）
 * 不该判违规；而"调用形态"基本只出现在真代码里。第一版想先剥注释与字符串再扫，
 * 结果正则剥模板串时吞掉了一万字符 —— **假绿的守卫比没有守卫更糟**，所以宁可用窄判据。
 */

const WEB = path.join(process.cwd(), 'web', 'src');

/** 收集一个模块 export 出来的名字。 */
function exportedNames(src) {
  const names = new Set();
  const push = (n) => { if (n) names.add(n); };
  for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) push(m[1]);
  for (const m of src.matchAll(/export\s+(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) push(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) push(name);
    }
  }
  return [...names].filter((n) => n !== 'default');
}

/** 本文件 import 进来或本地定义的名字（不需要精确作用域：这些是模块级工具函数）。 */
function boundNames(src) {
  const out = new Set();
  for (const m of src.matchAll(/import\s+([^;]+?)\s+from\s*['"][^'"]+['"]/g)) {
    const clause = m[1];
    const braces = clause.match(/\{([^}]*)\}/);
    if (braces) {
      for (const part of braces[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop().trim();
        if (name) out.add(name);
      }
    }
    const def = clause.replace(/\{[^}]*\}/, '').replace(/,/g, '').trim();
    if (def) out.add(def);
  }
  for (const m of src.matchAll(/(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  return out;
}

test('web/src：调用了本仓库导出的函数，就必须 import 或本地定义', () => {
  const files = fs.readdirSync(WEB).filter((f) => /\.(js|jsx)$/.test(f));
  const owner = new Map();
  for (const f of files) {
    if (f === 'main.jsx') continue;
    for (const n of exportedNames(fs.readFileSync(path.join(WEB, f), 'utf8'))) if (!owner.has(n)) owner.set(n, f);
  }
  assert.ok(owner.size > 10, `收集到的导出名太少（${owner.size}），检查解析逻辑`);

  const problems = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(WEB, f), 'utf8');
    const bound = boundNames(src);
    for (const [name, from] of owner) {
      if (bound.has(name)) continue;
      // 调用形态：前面不是 . （排除 obj.name( )，也不是名字的一部分
      const called = new RegExp(`(?<![\\w$.])${name}\\s*\\(`).test(src);
      if (called) problems.push(`${f}: 调用了 ${name}(...)（由 ${from} 导出）却没有 import / 本地定义`);
    }
  }
  assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
});
