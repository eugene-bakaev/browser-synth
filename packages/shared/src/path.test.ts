import { describe, it, expect } from 'vitest';
import { getDeep, setDeep } from './index.js';

describe('getDeep', () => {
  it('reads a nested leaf', () => {
    const o = { a: { b: { c: 7 } } };
    expect(getDeep(o, ['a', 'b', 'c'])).toBe(7);
  });

  it('returns undefined when an intermediate is missing (never throws)', () => {
    const o: Record<string, unknown> = { a: {} };
    expect(getDeep(o, ['a', 'x', 'y'])).toBeUndefined();
    expect(getDeep(o, ['nope'])).toBeUndefined();
  });

  it('returns undefined for the empty path', () => {
    expect(getDeep({ a: 1 }, [])).toBeUndefined();
  });

  it('is the read dual of setDeep for an existing leaf', () => {
    const o = { tracks: [{ bpm: 1 }] } as unknown as Record<string, unknown>;
    setDeep(o, ['tracks', 0, 'bpm'], 120);
    expect(getDeep(o, ['tracks', 0, 'bpm'])).toBe(120);
  });
});
