import { describe, it, expect } from 'vitest';
import { polyBLEP } from './polyblep';

describe('polyBLEP', () => {
  it('returns -1 at the rising-edge sample (t=0, beginning of step)', () => {
    // At the exact step location, the BLEP polynomial cancels the +1 the
    // naive oscillator would output, then ramps up smoothly over dt samples.
    expect(polyBLEP(0, 0.01)).toBeCloseTo(-1, 10);
  });

  it('returns 0 mid-period (well away from either edge)', () => {
    // The correction window is only ±dt around each step. At phase 0.5 with
    // dt 0.01, we're nowhere near the rising (0) or falling (1) edge.
    expect(polyBLEP(0.5, 0.01)).toBe(0);
  });

  it('joins zero continuously at the rising-edge window boundary (t=dt)', () => {
    // The two branches must agree at t=dt to avoid a discontinuity. The
    // strict inequality (t < dt) hands the boundary sample to the zero
    // branch; verify the polynomial would have returned ~0 there too.
    const dt = 0.01;
    // Polynomial form: at t=dt, t/dt=1 → 1+1-1-1=0.
    expect(polyBLEP(dt - 1e-12, dt)).toBeCloseTo(0, 6);
    expect(polyBLEP(dt, dt)).toBe(0);
  });

  it('joins zero continuously at the falling-edge window boundary (t=1-dt)', () => {
    const dt = 0.01;
    // Symmetric to the rising-edge case. At t=1-dt, (t-1)/dt=-1 → 1-1-1+1=0.
    expect(polyBLEP(1 - dt + 1e-12, dt)).toBeCloseTo(0, 6);
    expect(polyBLEP(1 - dt, dt)).toBe(0);
  });

  it('produces no NaN or Infinity across the full (phase, dt) operating range', () => {
    // Operating range: dt ∈ (0, 0.5] (fundamental up to Nyquist/2 in extreme
    // cases), phase ∈ [0, 1). If either branch ever divides by zero or
    // returns Inf/NaN, real-time audio glitches. Sweep densely.
    for (let dtIdx = 1; dtIdx <= 100; dtIdx++) {
      const dt = dtIdx * 0.005; // 0.005 .. 0.5
      for (let pIdx = 0; pIdx < 200; pIdx++) {
        const phase = pIdx / 200; // 0 .. 0.995
        const v = polyBLEP(phase, dt);
        expect(Number.isFinite(v)).toBe(true);
      }
    }
  });
});
