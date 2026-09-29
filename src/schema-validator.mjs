function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function typeMatches(value, wanted) {
  const actual = typeOf(value);
  return wanted === 'number' ? actual === 'number' || actual === 'integer' : actual === wanted;
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Minimal deterministic JSON Schema subset used by the storyboard contract. */
export function validateSchema(value, schema, pointer = '$', errors = []) {
  if (!schema || typeof schema !== 'object') return errors;
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(value, type))) {
      errors.push(`${pointer}: 期望 ${types.join('|')}，实际 ${typeOf(value)}`);
      return errors;
    }
  }
  if (schema.enum && !schema.enum.some((item) => deepEqual(item, value))) {
    errors.push(`${pointer}: 只能是 ${schema.enum.map((item) => JSON.stringify(item)).join(' / ')}，实际 ${JSON.stringify(value)}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${pointer}: ${value} 小于下限 ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${pointer}: ${value} 超过上限 ${schema.maximum}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${pointer}: 太短（至少 ${schema.minLength} 字）`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${pointer}: "${value}" 不匹配 ${schema.pattern}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${pointer}: 至少 ${schema.minItems} 项`);
    if (schema.items) value.forEach((item, index) => validateSchema(item, schema.items, `${pointer}[${index}]`, errors));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) if (!(key in value)) errors.push(`${pointer}: 缺字段 ${key}`);
    if (schema.additionalProperties === false) {
      const allowed = Object.keys(schema.properties || {});
      for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push(`${pointer}: 不该有的字段 ${key}`);
    }
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if (key in value) validateSchema(value[key], child, `${pointer}.${key}`, errors);
    }
  }
  return errors;
}
