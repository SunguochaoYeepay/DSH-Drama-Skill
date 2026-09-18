export function aspectOf(board) {
  const aspect = board.meta?.aspect;
  if (!['9:16', '16:9', '1:1'].includes(aspect)) throw new Error(`不支持的项目画幅：${aspect || '未设置'}`);
  return aspect;
}

export function dimensionsForAspect(size, aspect, separator = 'x') {
  const parts = String(size).split(separator).map(Number);
  if (parts.length !== 2 || parts.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new Error(`尺寸必须是正整数宽高：${size}`);
  }
  const [short, long] = parts.sort((a, b) => a - b);
  const [width, height] = aspect === '16:9' ? [long, short]
    : aspect === '1:1' ? [short, short] : [short, long];
  return `${width}${separator}${height}`;
}
