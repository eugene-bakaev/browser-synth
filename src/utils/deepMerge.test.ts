import { describe, it, expect } from 'vitest';
import { deepMerge } from './deepMerge';

describe('deepMerge', () => {
  it('returns a fresh copy of defaults when overrides is undefined', () => {
    const defaults = { a: 1, b: 2 };
    const merged = deepMerge(defaults, undefined);
    expect(merged).toEqual(defaults);
    expect(merged).not.toBe(defaults);
  });

  it('returns a fresh copy of defaults when overrides is null', () => {
    expect(deepMerge({ a: 1 }, null as any)).toEqual({ a: 1 });
  });

  it('overrides primitive fields', () => {
    expect(deepMerge({ a: 1, b: 2 }, { b: 5 })).toEqual({ a: 1, b: 5 });
  });

  it('recurses into nested objects', () => {
    const defaults = { env: { a: 0.1, d: 0.2, s: 0.5, r: 0.3 } };
    const overrides = { env: { d: 0.8 } };
    expect(deepMerge(defaults, overrides)).toEqual({
      env: { a: 0.1, d: 0.8, s: 0.5, r: 0.3 },
    });
  });

  it('replaces arrays wholesale (no element-wise merge)', () => {
    const defaults = { tags: ['x', 'y', 'z'] };
    const overrides = { tags: ['a'] };
    expect(deepMerge(defaults, overrides)).toEqual({ tags: ['a'] });
  });

  it('treats null overrides as "use default"', () => {
    expect(deepMerge({ a: 1 }, { a: null })).toEqual({ a: 1 });
  });

  it('does not mutate the defaults object', () => {
    const defaults = { env: { a: 0.1 } };
    deepMerge(defaults, { env: { a: 0.5 } });
    expect(defaults.env.a).toBe(0.1);
  });

  it('does not mutate the overrides object', () => {
    const overrides = { env: { a: 0.5 } };
    deepMerge({ env: { a: 0.1, d: 0.2 } }, overrides);
    expect(overrides).toEqual({ env: { a: 0.5 } });
  });
});
