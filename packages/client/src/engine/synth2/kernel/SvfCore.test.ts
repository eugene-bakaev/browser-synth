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

function noiseBuf(n: number): Float32Array {
  const b = new Float32Array(n); let s = 22222;
  for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; b[i] = (s / 0x3fffffff) - 1; }
  return b;
}

// The ORIGINAL linear SvfCore math (pre-self-oscillation), recomputed here as an
// independent oracle to prove res<=0.9 + drive=0 is bit-unchanged.
function refLinearLow(input: Float32Array, cutoff: number, res: number): number[] {
  let ic1 = 0, ic2 = 0; const out: number[] = [];
  const fc = Math.min(Math.max(cutoff, 20), SR * 0.45);
  const g = Math.tan((Math.PI * fc) / SR);
  const k = 1 / (0.5 + res * 9.5);
  const a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2;
  for (let i = 0; i < input.length; i++) {
    const v3 = input[i] - ic2;
    const v1 = a1 * ic1 + a2 * v3;
    const v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2;
    if (ic1 < 1e-25 && ic1 > -1e-25) ic1 = 0;
    if (ic2 < 1e-25 && ic2 > -1e-25) ic2 = 0;
    out.push(v2);
  }
  return out;
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

  it('flushes to exact zero after the signal goes silent (no denormal tail)', () => {
    const svf = new SvfCore(SR);
    // Excite, then feed silence at the highest NON-oscillating resonance (0.9 —
    // longest ring / slowest decay below the self-oscillation zone, worst case
    // for reaching exact zero). res>0.9 now self-oscillates by design.
    for (let i = 0; i < 2000; i++) svf.tick(Math.sin((2 * Math.PI * 220 * i) / SR), 1000, 0.9);
    let zeroed = false;
    for (let i = 0; i < SR; i++) { // up to 1s of silence
      svf.tick(0, 1000, 0.9);
      if (svf.low === 0 && svf.band === 0 && svf.high === 0) { zeroed = true; break; }
    }
    expect(zeroed).toBe(true);
  });
});

describe('SvfCore self-oscillation (2026-06-20)', () => {
  it('res<=0.9 with drive 0 is bit-identical to the original linear SVF', () => {
    const x = noiseBuf(4000);
    for (const res of [0, 0.15, 0.5, 0.9]) {
      const ref = refLinearLow(x, 1200, res);
      const svf = new SvfCore(SR);
      for (let i = 0; i < x.length; i++) {
        svf.tick(x[i], 1200, res); // drive defaults 0
        expect(svf.low, `res ${res} sample ${i}`).toBe(ref[i]); // EXACT
      }
    }
  });

  it('self-oscillates at res=1 from silence: sustains and stays bounded', () => {
    const svf = new SvfCore(SR); svf.reset();
    let s = 0, c = 0, peak = 0;
    const N = SR; // 1s of pure silence
    for (let i = 0; i < N; i++) {
      svf.tick(0, 1000, 1.0);
      if (i > SR * 0.5) { s += svf.low * svf.low; c++; if (Math.abs(svf.low) > peak) peak = Math.abs(svf.low); }
    }
    const rms = Math.sqrt(s / c);
    expect(rms).toBeGreaterThan(0.01);   // didn't die
    expect(peak).toBeLessThan(10);        // didn't blow up
    expect(Number.isFinite(rms)).toBe(true);
  });

  it('does NOT self-oscillate at moderate resonance (rings then decays)', () => {
    const svf = new SvfCore(SR); svf.reset();
    for (let i = 0; i < 2000; i++) svf.tick(Math.sin((2 * Math.PI * 300 * i) / SR), 1000, 0.5);
    let maxAfter = 0;
    for (let i = 0; i < SR; i++) { svf.tick(0, 1000, 0.5); if (i > SR * 0.5 && Math.abs(svf.low) > maxAfter) maxAfter = Math.abs(svf.low); }
    expect(maxAfter).toBeLessThan(1e-6); // decayed to ~0
  });

  it('oscillation frequency tracks the cutoff (in tune, within 30 cents)', () => {
    for (const cutoff of [110, 262, 440]) {
      const svf = new SvfCore(SR); svf.reset();
      for (let i = 0; i < SR; i++) svf.tick(0, cutoff, 1.0); // settle 1s
      let prev = 0, crossings = 0; const M = SR; // measure 1s
      for (let i = 0; i < M; i++) { svf.tick(0, cutoff, 1.0); const y = svf.low; if (prev <= 0 && y > 0) crossings++; prev = y; }
      const measuredHz = crossings / (M / SR);
      const cents = 1200 * Math.log2(measuredHz / cutoff);
      expect(Math.abs(cents), `cutoff ${cutoff} → ${measuredHz}Hz`).toBeLessThan(30);
    }
  });

  it('starts oscillating from pure silence within ~200ms', () => {
    const svf = new SvfCore(SR); svf.reset();
    let firstAudible = -1;
    for (let i = 0; i < SR; i++) { svf.tick(0, 1000, 1.0); if (firstAudible < 0 && Math.abs(svf.low) > 0.05) firstAudible = i; }
    expect(firstAudible).toBeGreaterThanOrEqual(0);
    expect(firstAudible).toBeLessThan(SR * 0.2);
  });

  // Drive's harmonic *character* is a deferred sound-design experiment (decided
  // 2026-06-20): the tanh(D*x)/D feedback saturator self-regulates the limit
  // cycle back toward a clean sine, so raising `drive` does not yet add audible
  // grit (see spec §5.2 note). For now `drive` is only required to keep the
  // self-oscillation finite and bounded across its whole range — we assert that
  // safety property, not harmonic richness.
  it('drive keeps the self-oscillation bounded and finite across its range (character deferred)', () => {
    for (const drive of [0, 0.5, 1]) {
      const svf = new SvfCore(SR); svf.reset();
      let s = 0, peak = 0; const M = SR;
      for (let i = 0; i < 2 * M; i++) {
        svf.tick(0, 1000, 1.0, drive);
        if (i >= M) { const y = svf.low; s += y * y; if (Math.abs(y) > peak) peak = Math.abs(y); }
      }
      const rms = Math.sqrt(s / M);
      expect(peak, `drive ${drive}`).toBeLessThan(10); // bounded
      expect(Number.isFinite(rms), `drive ${drive}`).toBe(true);
    }
  });

  it('stays finite with NaN input / extreme finite cutoff at res=1, drive=1', () => {
    const svf = new SvfCore(SR); svf.reset();
    for (let i = 0; i < 2000; i++) {
      svf.tick(i % 7 === 0 ? NaN : 0, i % 3 ? 1e9 : -5, 1.0, 1);
      expect(Number.isFinite(svf.low)).toBe(true);
      expect(Number.isFinite(svf.band)).toBe(true);
      expect(Number.isFinite(svf.high)).toBe(true);
    }
  });
});
