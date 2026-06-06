import { describe, it, expect } from 'vitest';
import { deepEqual } from './snapshot-codec.js';

describe('deepEqual', () => {
  it('is true for identical primitives and structurally equal objects', () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual('a', 'a')).toBe(true);
    expect(deepEqual({ x: 1, y: [2, 3] }, { x: 1, y: [2, 3] })).toBe(true);
  });

  it('is insensitive to key order', () => {
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });

  it('is false for differing values, lengths, or key sets', () => {
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(deepEqual([1, 2], { 0: 1, 1: 2 })).toBe(false); // array vs object
    expect(deepEqual({ a: 1 }, null)).toBe(false);
  });
});
