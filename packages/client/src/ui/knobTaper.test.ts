import { describe, it, expect } from 'vitest';
import { posToValue, valueToPos } from './knobTaper';
import type { KnobCurve } from '@fiddle/shared';

const CURVES: KnobCurve[] = ['linear', 'exp', 'invexp', 's'];
// Only strictly-positive ranges for exp/invexp; linear/s also fine here.
const RANGES: [number, number][] = [[20, 20000], [0.001, 10], [0.01, 2000], [30, 120]];

describe('knobTaper', () => {
  it('endpoints map to min/max (and back) for every curve and range', () => {
    for (const c of CURVES) for (const [min, max] of RANGES) {
      expect(posToValue(c, 0, min, max)).toBeCloseTo(min, 6);
      expect(posToValue(c, 1, min, max)).toBeCloseTo(max, 6);
      expect(valueToPos(c, min, min, max)).toBeCloseTo(0, 6);
      expect(valueToPos(c, max, min, max)).toBeCloseTo(1, 6);
    }
  });

  it('posToValue ∘ valueToPos is identity (round-trip) for every curve', () => {
    for (const c of CURVES) for (const [min, max] of RANGES) {
      for (let i = 0; i <= 10; i++) {
        const v = min + ((max - min) * i) / 10;
        expect(posToValue(c, valueToPos(c, v, min, max), min, max)).toBeCloseTo(v, 4);
      }
    }
  });

  it('is monotonically increasing in pos for every curve', () => {
    for (const c of CURVES) for (const [min, max] of RANGES) {
      let prev = -Infinity;
      for (let i = 0; i <= 20; i++) {
        const v = posToValue(c, i / 20, min, max);
        expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = v;
      }
    }
  });

  it('exp midpoint is the geometric mean (632 on 20..20000)', () => {
    expect(posToValue('exp', 0.5, 20, 20000)).toBeCloseTo(Math.sqrt(20 * 20000), 0);
  });

  it('linear midpoint is the arithmetic mean; s midpoint is the centre', () => {
    expect(posToValue('linear', 0.5, 0, 100)).toBeCloseTo(50, 6);
    expect(posToValue('s', 0.5, 0, 100)).toBeCloseTo(50, 6);
  });

  it('exp gives the low end real travel (200 Hz sits past 1/3 of the dial)', () => {
    expect(valueToPos('exp', 200, 20, 20000)).toBeGreaterThan(0.33);
    // linear buries the same value in the bottom ~1% of travel:
    expect(valueToPos('linear', 200, 20, 20000)).toBeLessThan(0.01);
  });

  it('exp/invexp on a non-positive range fall back to linear (no NaN)', () => {
    expect(posToValue('exp', 0.5, 0, 1)).toBeCloseTo(0.5, 6);
    expect(posToValue('invexp', 0.5, 0, 1)).toBeCloseTo(0.5, 6);
    expect(Number.isFinite(posToValue('exp', 0.5, -10, 10))).toBe(true);
  });

  it('non-finite / out-of-range input never throws or returns NaN', () => {
    expect(Number.isFinite(posToValue('exp', NaN, 20, 20000))).toBe(true);
    expect(valueToPos('exp', NaN, 20, 20000)).toBe(0);
    expect(valueToPos('exp', 1e9, 20, 20000)).toBeCloseTo(1, 6); // clamped
    expect(valueToPos('exp', -5, 20, 20000)).toBeCloseTo(0, 6);  // clamped
  });

  it('non-finite min/max and extreme ratios never produce NaN', () => {
    expect(Number.isFinite(posToValue('linear', 0.5, NaN, 100))).toBe(true);
    expect(Number.isFinite(posToValue('exp', 0.5, NaN, 100))).toBe(true);
    expect(Number.isFinite(posToValue('exp', 0.5, 1e-300, 1e300))).toBe(true);
    expect(Number.isFinite(valueToPos('exp', 1, 1e-300, 1e300))).toBe(true);
  });
});
