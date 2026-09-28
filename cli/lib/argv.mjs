/**
 * CLI 参数解析的唯一所有者（2026-09-28 收编）。
 *
 * 此前 30+ 处私有实现散在 cli/*.mjs，三种语义并存且同名不同义
 * （有的 `flag` 缺值回退 fallback，有的 `flag` 缺值返回 true）——
 * 同一张脸两套规矩，正是"一个规则两个所有者"的标准裂缝。
 *
 * 三种语义按**缺值时的行为**命名，调用方按自己要的行为选：
 *
 * | 函数     | flag 缺失 | 值缺失（flag 在最后或下一个是 --） | 典型用途 |
 * |----------|-----------|------------------------------------|----------|
 * | `value`  | fallback  | `undefined`（裸取，调用方兜底）    | 位置参数式的必填项 |
 * | `flag`   | fallback  | fallback（严格回退，含 -- 防护）   | 有默认值的选项 |
 * | `opt`    | fallback  | `true`（布尔开关语义）             | `--dry` 这类可带值可裸用的开关 |
 *
 * `has` 只判存在不取值。位置参数（`argv.find(...)`）各 CLI 自定，不归这里。
 */

export function makeArgs(argv = process.argv.slice(2)) {
  const at = (name) => argv.indexOf(`--${name}`);

  /** 裸取：flag 在而值缺 → undefined。 */
  const value = (name, fallback = null) => {
    const i = at(name);
    return i >= 0 ? argv[i + 1] : fallback;
  };

  /** 严格：值缺、为空串或下一个是 flag → 回退 fallback。 */
  const flag = (name, fallback = null) => {
    const i = at(name);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
  };

  /** 宽松：值缺或下一个参数是 flag → true（布尔开关）。 */
  const opt = (name, fallback = null) => {
    const i = at(name);
    if (i < 0) return fallback;
    const v = argv[i + 1];
    return v !== undefined && !v.startsWith('--') ? v : true;
  };

  const has = (name) => argv.includes(`--${name}`);

  return { value, flag, opt, has, argv };
}
