import { describe, it, expect } from 'vitest';
import { SvfCore } from './SvfCore.js';

const SR = 48000;

function sine(freq: number, n: number): Float32Array {
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) b[i] = Math.sin((2 * Math.PI * freq * i) / SR);
  return b;
}
// RMS of one SVF output over a sine input, skipping the settling transient.
function outRms(out: 'low' | 'band' | 'high', cutoff: number, res: number, freq: number): number {
  const svf = new SvfCore(SR);
  const x = sine(freq, 12000);
  let s = 0, c = 0;
  for (let i = 0; i < x.length; i++) {
    svf.tick(x[i], cutoff, res);
    if (i >= 4000) { s += svf[out] * svf[out]; c++; }
  }
  return Math.sqrt(s / c);
}

describe('SvfCore', () => {
  it('silence in → silence out', () => {
    const svf = new SvfCore(SR);
    for (let i = 0; i < 256; i++) {
      svf.tick(0, 1000, 0.2);
      expect(svf.low).toBe(0);
      expect(svf.band).toBe(0);
      expect(svf.high).toBe(0);
    }
  });

  it('lowpass passes lows and attenuates highs', () => {
    const lowPass = outRms('low', 800, 0.2, 100);
    const highRej = outRms('low', 800, 0.2, 8000);
    expect(lowPass).toBeGreaterThan(0.5);
    expect(highRej).toBeLessThan(lowPass * 0.25);
  });

  it('highpass passes highs and attenuates lows', () => {
    const highPass = outRms('high', 800, 0.2, 8000);
    const lowRej = outRms('high', 800, 0.2, 100);
    expect(highPass).toBeGreaterThan(0.5);
    expect(lowRej).toBeLessThan(highPass * 0.25);
  });

  it('bandpass peaks near cutoff', () => {
    const atCut = outRms('band', 1000, 0.4, 1000);
    const below = outRms('band', 1000, 0.4, 100);
    const above = outRms('band', 1000, 0.4, 10000);
    expect(atCut).toBeGreaterThan(below);
    expect(atCut).toBeGreaterThan(above);
  });

  it('stays finite and bounded sweeping cutoff at high resonance', () => {
    const svf = new SvfCore(SR);
    const n = 16384;
    for (let i = 0; i < n; i++) {
      const cutoff = 40 + (i / n) * 18000;
      const x = Math.sin((2 * Math.PI * 300 * i) / SR);
      svf.tick(x, cutoff, 0.95);
      expect(Number.isFinite(svf.low)).toBe(true);
      expect(Math.abs(svf.low)).toBeLessThan(20);
    }
  });
});
