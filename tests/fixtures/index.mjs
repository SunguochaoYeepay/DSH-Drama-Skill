/**
 * 夹具入口 —— **仓库内的测试输入，随代码保存**。
 *
 * ## 为什么必须是仓库内的
 *
 * 这些是**测试输入**，不是运行项目的媒体产物。两类的生命周期完全不同：
 *
 * - 运行产物（图片/视频/音频）跟着**剧目目录**走，会随工作区迁移、改名、归档而失效；
 * - 测试输入必须钉在**代码旁边**，否则换台机器、换个工作区就红一片。
 *
 * 来历：这四个测试原先默认读 `E:/AI-Tool/DeepSeek/story2video/examples/…`，
 * 工作区改成 `projects/<剧目>/` 之后就集体 ENOENT。
 * **把默认路径换成"另一个现存的绝对路径"只是重新绑一次会继续变的外部目录** ——
 * 正确做法是让夹具进仓库。
 *
 * ## 路径规则只有一个所有者
 *
 * 就是本文件。测试不要自己拼 `'fixtures/xxx.json'`，也不要写绝对路径。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));

/** 有名字的夹具清单。加新夹具时在这里登记，不要在测试里散落字符串。 */
export const FIXTURE = {
  /** 带剧本原文的板子：`story.source` 里有行号、台词、动作行。literal 测试的输入。 */
  script: 'dashixiong-source.json',
  /** 逐行编译后的板子：2 角色 / 2 造型 / 1 场景 / 14 镜 / 12 句台词。资产与编排测试的输入。 */
  board: 'dashixiong-board.json',
};

/** 取一个夹具的绝对路径；不存在就抛可读错误，而不是让调用方吃 ENOENT 栈。 */
export function fixture(name) {
  const file = path.join(DIR, name);
  if (!fs.existsSync(file)) {
    throw new Error(
      `夹具不存在：${file}\n`
      + '测试输入必须随代码保存（见 tests/fixtures/README.md）。'
      + '不要改回指向外部工作区的绝对路径 —— 那会随工作区迁移再次失效。',
    );
  }
  return file;
}

/**
 * 夹具路径 = **命令行参数优先**，否则用仓库内默认。
 *
 * 命令行覆盖的用途是"拿一部真实剧目的板子跑同一个测试"，
 * 不是用来在日常回归里绕开夹具。
 *
 * @param {string[]} argv `process.argv`
 * @param {number} index 位置参数的槽位（通常是 2）
 * @param {string} name `FIXTURE` 里的名字
 */
export function fixtureOrArg(argv, index, name) {
  const arg = (argv || [])[index];
  if (arg && !arg.startsWith('--')) return path.resolve(arg);
  return fixture(name);
}
