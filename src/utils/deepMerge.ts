// Deep-merge `overrides` into `defaults`. `overrides` wins for present, non-null
// fields; missing or null fields fall through to defaults. Recurses on plain
// objects only — arrays are replaced wholesale (no element-wise merge).
// Neither input is mutated.

type AnyObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is AnyObject {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function deepMerge<T>(defaults: T, overrides: any): T {
  if (overrides === null || overrides === undefined) {
    return structuredClone(defaults);
  }
  if (!isPlainObject(defaults)) {
    // primitive / array default — replace if override is non-null, else keep default
    return (overrides as unknown as T) ?? structuredClone(defaults);
  }

  const result: AnyObject = {};
  const d = defaults as unknown as AnyObject;
  const o = overrides as unknown as AnyObject;

  for (const key of Object.keys(d)) {
    const dv = d[key];
    const ov = o[key];
    if (ov === undefined || ov === null) {
      result[key] = structuredClone(dv);
    } else if (isPlainObject(dv) && isPlainObject(ov)) {
      result[key] = deepMerge(dv, ov);
    } else {
      result[key] = ov;
    }
  }

  return result as T;
}
