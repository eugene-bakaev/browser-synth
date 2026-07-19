import { describe, expect, it } from 'vitest';
import { modDepth } from './moddepth';

const sine = (n: number, stepS: number, freq: number, amp: number, offset = 0, slope = 0) =>
  Array.from({ length: n }, (_, i) => offset + slope * i + amp * Math.sin(2 * Math.PI * freq * i * stepS));

describe('modDepth', () => {
  it('recovers amplitude and rate of a clean sine series', () => {
    const r = modDepth(sine(400, 0.005, 5, 3, 100), 0.005); // 2s of 5Hz, amp 3
    expect(r.depth).toBeGreaterThan(2.4);
    expect(r.depth).toBeLessThan(3.3);
    expect(r.rateHz).toBeGreaterThan(4.5);
    expect(r.rateHz).toBeLessThan(5.5);
  });
  it('detrends: a pure ramp has ~zero depth', () => {
    const r = modDepth(sine(400, 0.005, 0, 0, 10, 0.05), 0.005);
    expect(r.depth).not.toBeNull();
    expect(r.depth!).toBeLessThan(0.02);
  });
  it('tolerates interspersed nulls', () => {
    const s = sine(400, 0.005, 5, 3, 100).map((v, i) => (i % 7 === 0 ? null : v));
    const r = modDepth(s, 0.005);
    expect(r.depth).toBeGreaterThan(2.2);
  });
  it('returns nulls for fewer than 8 valid points', () => {
    expect(modDepth([1, 2, null, 3], 0.01)).toEqual({ depth: null, rateHz: null });
  });
});
