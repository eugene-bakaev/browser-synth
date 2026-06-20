import { describe, it, expect } from 'vitest';
import { Noise } from './Noise';

// The exact xorshift32 white stream Noise draws from — lets us assert the white
// anchor (color 0.5) is reproduced bit-for-bit.
function whiteStream(seed: number): () => number {
  let state = (seed | 0) || 0x9e3779b9;
  return () => {
    let x = state;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    state = x >>> 0;
    return (state / 0xffffffff) * 2 - 1;
  };
}

// Root-mean-square energy of `n` samples at a fixed color.
function rmsOf(noise: Noise, color: number, n = 100_000): number {
  let sumsq = 0;
  for (let i = 0; i < n; i++) { const v = noise.next(color); sumsq += v * v; }
  return Math.sqrt(sumsq / n);
}

// Mean absolute sample-to-sample difference — a cheap high-frequency-energy proxy.
function hfOf(noise: Noise, color: number, n = 100_000): number {
  let prev = 0, acc = 0;
  for (let i = 0; i < n; i++) { const v = noise.next(color); acc += Math.abs(v - prev); prev = v; }
  return acc / n;
}

describe('Noise', () => {
  it('is deterministic for a given seed and color', () => {
    const a = new Noise(12345), b = new Noise(12345);
    for (let i = 0; i < 100; i++) expect(a.next(0.7)).toBe(b.next(0.7));
  });

  it('different seeds diverge', () => {
    const a = new Noise(1), b = new Noise(2);
    let same = 0;
    for (let i = 0; i < 100; i++) if (a.next(0.5) === b.next(0.5)) same++;
    expect(same).toBeLessThan(5);
  });

  it('color 0.5 is white: reproduces the raw xorshift stream bit-for-bit', () => {
    const n = new Noise(2024);
    const w = whiteStream(2024);
    for (let i = 0; i < 1000; i++) expect(n.next(0.5)).toBe(w());
  });

  it('white (0.5) stays within [-1, 1] and is roughly zero-mean', () => {
    const n = new Noise(99);
    let sum = 0, max = 0;
    for (let i = 0; i < 10000; i++) { const v = n.next(0.5); sum += v; max = Math.max(max, Math.abs(v)); }
    expect(max).toBeLessThanOrEqual(1);
    expect(Math.abs(sum / 10000)).toBeLessThan(0.05);
  });

  it('spectral slope rises monotonically: brown < pink < white < blue < violet', () => {
    // High-frequency energy must increase across the color axis. Fresh instance
    // per anchor so warm-up is identical.
    const hf = [0, 0.25, 0.5, 0.75, 1].map(c => hfOf(new Noise(7), c));
    for (let i = 1; i < hf.length; i++) expect(hf[i]).toBeGreaterThan(hf[i - 1]);
  });

  it('all anchors are loudness-matched to white (RMS within 15%)', () => {
    // This is the calibration oracle for PINK/BROWN/BLUE/VIOLET_GAIN.
    const whiteRms = rmsOf(new Noise(11), 0.5);
    for (const c of [0, 0.25, 0.5, 0.75, 1]) {
      const r = rmsOf(new Noise(11), c);
      expect(Math.abs(r / whiteRms - 1), `color ${c}`).toBeLessThan(0.15);
    }
  });

  it('morphs continuously: HF is non-decreasing across a fine color sweep', () => {
    // The symmetric crossfade is C0-continuous, so brightness must rise smoothly
    // with no dip at the anchor joins (0.25 / 0.5 / 0.75). Small negative tolerance
    // absorbs sampling noise.
    const grid = Array.from({ length: 11 }, (_, i) => i / 10); // 0, 0.1, … 1.0
    const hf = grid.map(c => hfOf(new Noise(7), c));
    for (let i = 1; i < hf.length; i++) {
      expect(hf[i] - hf[i - 1], `join ${grid[i - 1]}→${grid[i]}`).toBeGreaterThan(-0.01);
    }
  });

  it('clamps out-of-range and non-finite color (never emits NaN)', () => {
    const n = new Noise(5);
    for (let i = 0; i < 100; i++) {
      expect(Number.isFinite(n.next(-1))).toBe(true);
      expect(Number.isFinite(n.next(2))).toBe(true);
      expect(Number.isFinite(n.next(NaN))).toBe(true);
    }
  });
});
