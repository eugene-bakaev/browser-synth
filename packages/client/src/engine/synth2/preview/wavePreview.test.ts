import { describe, it, expect } from 'vitest';
import { renderOscShape, renderLfoShape, PREVIEW_POINTS, PREVIEW_CYCLES } from './wavePreview';
import { Lfo } from '../kernel/Lfo';

const finite = (buf: Float32Array) => buf.every((v) => Number.isFinite(v));
const maxAbs = (buf: Float32Array) => buf.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const mean = (buf: Float32Array) => buf.reduce((s, v) => s + v, 0) / buf.length;

// Count saw "teeth": each falling edge is a run of consecutive steep-negative
// steps. A band-limited (PolyBLEP) discontinuity is anti-aliased across 1–2
// samples, so we group adjacent steep steps into one fall event rather than
// asserting a single >1.0 step (which is sensitive to sub-sample edge alignment).
const countFalls = (buf: Float32Array): number => {
  let falls = 0;
  let inFall = false;
  for (let i = 1; i < buf.length; i++) {
    const steep = buf[i] - buf[i - 1] < -0.5;
    if (steep && !inFall) falls++;
    inFall = steep;
  }
  return falls;
};

describe('renderOscShape', () => {
  it('returns PREVIEW_POINTS finite samples bounded to ~[-1,1]', () => {
    const buf = renderOscShape(0, 0.5);
    expect(buf.length).toBe(PREVIEW_POINTS);
    expect(finite(buf)).toBe(true);
    expect(maxAbs(buf)).toBeLessThanOrEqual(1.05);
  });

  it('sine (morph 0) is phase-aligned: starts ~0, rises, ~zero DC', () => {
    const buf = renderOscShape(0, 0.5);
    expect(Math.abs(buf[0])).toBeLessThan(0.05);
    expect(buf[1]).toBeGreaterThan(buf[0]);
    expect(Math.abs(mean(buf))).toBeLessThan(0.05);
  });

  it('saw (morph 2) spans the full range with exactly PREVIEW_CYCLES falls', () => {
    const buf = renderOscShape(2, 0.5);
    expect(maxAbs(buf)).toBeGreaterThan(0.9);
    expect(countFalls(buf)).toBe(PREVIEW_CYCLES);
  });

  it('pulse (morph 3) high-fraction tracks pulseWidth', () => {
    const highFrac = (pw: number) => {
      const buf = renderOscShape(3, pw);
      return buf.reduce((n, v) => n + (v > 0 ? 1 : 0), 0) / buf.length;
    };
    expect(highFrac(0.25)).toBeGreaterThan(0.15);
    expect(highFrac(0.25)).toBeLessThan(0.35);
    expect(highFrac(0.75)).toBeGreaterThan(0.65);
  });

  it('garbage params stay finite and correctly sized (hardening)', () => {
    const buf = renderOscShape(NaN, NaN);
    expect(buf.length).toBe(PREVIEW_POINTS);
    expect(finite(buf)).toBe(true);
  });

  it('is deterministic', () => {
    expect([...renderOscShape(1.4, 0.5)]).toEqual([...renderOscShape(1.4, 0.5)]);
  });
});

describe('renderLfoShape', () => {
  it('equals Lfo.wave at the same phases (single source of truth)', () => {
    const buf = renderLfoShape(2.3);
    expect(buf.length).toBe(PREVIEW_POINTS);
    for (let i = 0; i < PREVIEW_POINTS; i++) {
      const phase = ((i / PREVIEW_POINTS) * PREVIEW_CYCLES) % 1;
      expect(buf[i]).toBeCloseTo(Lfo.wave(2.3, phase), 6);
    }
  });

  it('sine (shape 0) is bounded + ~zero DC; square (shape 4) is ±1', () => {
    const sine = renderLfoShape(0);
    expect(maxAbs(sine)).toBeLessThanOrEqual(1.0001);
    expect(Math.abs(mean(sine))).toBeLessThan(0.05);
    for (const v of renderLfoShape(4)) expect(Math.abs(v)).toBeCloseTo(1, 6);
  });

  it('s&h is stepped, stable across calls, and in range', () => {
    const a = renderLfoShape(0, 's&h');
    const b = renderLfoShape(0, 's&h');
    expect(a.length).toBe(PREVIEW_POINTS);
    expect([...a]).toEqual([...b]); // fixed seed ⇒ no flicker on redraw
    for (const v of a) { expect(v).toBeLessThanOrEqual(1); expect(v).toBeGreaterThanOrEqual(-1); }
    // Stepped: at least one flat run and at least one jump across the buffer.
    let flats = 0, jumps = 0;
    for (let i = 1; i < a.length; i++) (a[i] === a[i - 1] ? flats++ : jumps++);
    expect(flats).toBeGreaterThan(0);
    expect(jumps).toBeGreaterThan(0);
  });

  it('smooth is continuous and stable across calls', () => {
    const a = renderLfoShape(0, 'smooth');
    const b = renderLfoShape(0, 'smooth');
    expect([...a]).toEqual([...b]);
    for (let i = 1; i < a.length; i++) expect(Math.abs(a[i] - a[i - 1])).toBeLessThan(0.1);
  });

  it('defaults to the off morph when mode is omitted', () => {
    expect([...renderLfoShape(2.3)]).toEqual([...renderLfoShape(2.3, 'off')]);
  });
});
