import { describe, it, expect } from 'vitest';
import { polyBLEP } from './blep';

describe('polyBLEP', () => {
  it('is zero away from the discontinuity', () => {
    expect(polyBLEP(0.5, 0.01)).toBe(0);
    expect(polyBLEP(0.02, 0.01)).toBe(0);
    expect(polyBLEP(0.97, 0.01)).toBe(0);
  });

  it('corrects toward -1 just after the wrap and +1 just before it', () => {
    expect(polyBLEP(0, 0.01)).toBeCloseTo(-1, 5);
    expect(polyBLEP(0.999999, 0.01)).toBeCloseTo(1, 2);
  });

  it('is continuous across the correction window boundary', () => {
    const dt = 0.01;
    expect(Math.abs(polyBLEP(dt * 0.999999, dt))).toBeLessThan(1e-4);
    expect(Math.abs(polyBLEP(1 - dt * 0.999999, dt))).toBeLessThan(1e-4);
  });
});
