import { describe, it, expect } from 'vitest';
import { baseTable, rotatePhase } from './WaveformTables';

// Float32Array storage truncates each coefficient to ~7 significant figures,
// so the round-trip error vs the double-precision reference is bounded by
// ~|value|·1e-7. EPS is set above that floor (1e-6) for headroom while still
// catching real algorithm regressions; the 32-harmonic tables have all
// coefficients <= 1 so this works out to ~1e-6 absolute tolerance.
const EPS = 1e-6;

function arrayCloseTo(a: Float32Array, b: Float32Array, eps = EPS): void {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) {
    expect(Math.abs(a[i] - b[i])).toBeLessThan(eps);
  }
}

describe('WaveformTables', () => {
  it('sawtooth at phase 0 matches the reference Fourier series', () => {
    const { real, imag } = baseTable('sawtooth');
    expect(real[0]).toBe(0);
    for (let k = 1; k < 33; k++) {
      expect(real[k]).toBe(0);
      const expected = (2 / (Math.PI * k)) * ((k % 2 === 1) ? 1 : -1);
      expect(Math.abs(imag[k] - expected)).toBeLessThan(EPS);
    }
  });

  it('rotatePhase by 180° on sawtooth equals base sawtooth with imag negated', () => {
    const rotated = rotatePhase(baseTable('sawtooth'), 180);
    const base = baseTable('sawtooth');
    // After 180° rotation: cos(kπ) = ±1, sin(kπ) = 0, so real' = a·(±1) and
    // imag' = b·(±1). For sawtooth (a=0), real stays 0 and imag flips sign on
    // every odd k where cos(kπ) = -1.
    for (let k = 1; k < 33; k++) {
      // expected imag = b * cos(kπ) = b * (-1)^k
      const expected = base.imag[k] * ((k % 2 === 0) ? 1 : -1);
      expect(Math.abs(rotated.imag[k] - expected)).toBeLessThan(EPS);
      expect(Math.abs(rotated.real[k])).toBeLessThan(EPS);
    }
  });

  it('rotatePhase by 360° equals rotatePhase by 0° within tolerance', () => {
    const rotated360 = rotatePhase(baseTable('square'), 360);
    const base = baseTable('square');
    arrayCloseTo(rotated360.real, base.real);
    arrayCloseTo(rotated360.imag, base.imag);
  });

  it('returns independent copies so caller mutation does not poison the cache', () => {
    const a = baseTable('sine');
    a.imag[1] = 999;
    const b = baseTable('sine');
    expect(b.imag[1]).toBe(1);
  });
});
