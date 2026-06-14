import { describe, it, expect } from 'vitest';
import { ClassicFilter } from './ClassicFilter.js';

const SR = 48000;

function sine(freq: number, n: number): Float32Array {
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) b[i] = Math.sin((2 * Math.PI * freq * i) / SR);
  return b;
}
// RMS of a freshly-constructed filter (type set) over a sine, skipping settling.
function rms(type: number, cutoff: number, res: number, freq: number): number {
  const f = new ClassicFilter(SR);
  f.setType(type);
  const x = sine(freq, 12000);
  let s = 0, c = 0;
  for (let i = 0; i < x.length; i++) {
    const y = f.process(x[i], cutoff, res);
    if (i >= 4000) { s += y * y; c++; }
  }
  return Math.sqrt(s / c);
}

describe('ClassicFilter', () => {
  it('type lp (0) passes lows and attenuates highs', () => {
    expect(rms(0, 800, 0.2, 100)).toBeGreaterThan(0.5);
    expect(rms(0, 800, 0.2, 8000)).toBeLessThan(0.15);
  });

  it('lp and hp differ on the same high-frequency input', () => {
    const lpHigh = rms(0, 800, 0.2, 8000);
    const hpHigh = rms(2, 800, 0.2, 8000);
    expect(hpHigh).toBeGreaterThan(lpHigh * 3);
  });

  it('type bp (1) peaks near cutoff', () => {
    expect(rms(1, 1000, 0.4, 1000)).toBeGreaterThan(rms(1, 1000, 0.4, 100));
    expect(rms(1, 1000, 0.4, 1000)).toBeGreaterThan(rms(1, 1000, 0.4, 10000));
  });

  it('setType clamps and rounds out-of-range indices', () => {
    const f = new ClassicFilter(SR);
    f.setType(-5);  expect(f.currentType).toBe(0);
    f.setType(9);   expect(f.currentType).toBe(2);
    f.setType(1.6); expect(f.currentType).toBe(2);
  });

  it('reset clears state (post-reset tick equals a fresh filter)', () => {
    const a = new ClassicFilter(SR);
    const b = new ClassicFilter(SR);
    for (let i = 0; i < 500; i++) a.process(Math.random() * 2 - 1, 1200, 0.5);
    a.reset();
    expect(a.process(0.7, 1200, 0.5)).toBeCloseTo(b.process(0.7, 1200, 0.5), 12);
  });
});
