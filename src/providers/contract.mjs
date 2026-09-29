/**
 * Provider contract shared by every image backend.
 *
 * A provider may expose extra operations (speech, dryRun, etc.), but image
 * stages only depend on `name`, `generate`, and `edit`. Keeping this check at
 * the registry boundary prevents a partially loaded adapter from failing much
 * later inside a CLI run.
 */
export const IMAGE_OPERATIONS = ['generate', 'edit'];

export function assertImageProvider(provider, expectedName = null) {
  if (!provider || typeof provider !== 'object') throw new TypeError('provider 必须是对象');
  if (typeof provider.name !== 'string' || !provider.name.trim()) {
    throw new TypeError('provider.name 必须是非空字符串');
  }
  if (expectedName && provider.name !== expectedName) {
    throw new Error(`provider 名称不匹配：注册为 ${expectedName}，实际是 ${provider.name}`);
  }
  for (const operation of IMAGE_OPERATIONS) {
    if (typeof provider[operation] !== 'function') {
      throw new TypeError(`provider ${provider.name} 缺少 ${operation}() 实现`);
    }
  }
  return provider;
}

/**
 * 验证并归一图片生成结果。
 * 适配器可以携带额外字段，但核心层只依赖这组稳定字段。
 */
export function normalizeImageResult(result, { provider = 'unknown', operation = 'image' } = {}) {
  if (!result || typeof result !== 'object') {
    throw new TypeError(`${provider}.${operation} 必须返回对象`);
  }
  const files = Array.isArray(result.files) ? result.files.filter((file) => typeof file === 'string' && file) : [];
  const status = result.status == null ? null : Number(result.status);
  if (status !== null && !Number.isInteger(status)) {
    throw new TypeError(`${provider}.${operation} 的 status 必须是整数或 null`);
  }
  return { ...result, files, status };
}

export function providerCapabilities(provider) {
  assertImageProvider(provider);
  return {
    name: provider.name,
    image: true,
    edit: true,
    speech: typeof provider.speak === 'function',
    dryRun: typeof provider.dryRun === 'function',
  };
}

export function withImageContract(provider) {
  assertImageProvider(provider);
  return {
    ...provider,
    async generate(...args) {
      return normalizeImageResult(await provider.generate(...args), {
        provider: provider.name,
        operation: 'generate',
      });
    },
    async edit(...args) {
      return normalizeImageResult(await provider.edit(...args), {
        provider: provider.name,
        operation: 'edit',
      });
    },
  };
}
