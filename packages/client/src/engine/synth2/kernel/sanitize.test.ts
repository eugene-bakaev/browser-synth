import { describe, it, expect } from 'vitest';
import { flushNonFinite } from './sanitize';

describe('flushNonFinite (I4 Layer 2 net)', () => {
  it('replaces NaN/Inf with 0, counts them, leaves finite samples', () => {
    const b = new Float32Array([0.5, NaN, -0.3, Infinity, -Infinity, 0.1]);
    expect(flushNonFinite(b, b.length)).toBe(3);
    // Float32Array stores values at float32 precision; compare against the
    // float32-rounded literals (Math.fround) so finite samples match exactly.
    expect(Array.from(b)).toEqual(
      [0.5, 0, -0.3, 0, 0, 0.1].map(Math.fround),
    );
  });

  it('returns 0 and is a no-op on an all-finite buffer', () => {
    const b = new Float32Array([0, 0.2, -0.2]);
    expect(flushNonFinite(b, b.length)).toBe(0);
    expect(Array.from(b)).toEqual([0, 0.2, -0.2].map(Math.fround));
  });

  it('only sweeps the first `frames` samples', () => {
    const b = new Float32Array([NaN, NaN, NaN, NaN]);
    expect(flushNonFinite(b, 2)).toBe(2);
    expect(b[2]).toBeNaN();
  });
});
