import { describe, it, expect } from 'vitest';
import { SYNTH2_DESCRIPTORS, isDiscrete, encodeBool, decodeBool } from './synth2-descriptors.js';

describe('SYNTH2_DESCRIPTORS', () => {
  it('has unique keys in <module>.<field> form', () => {
    const keys = SYNTH2_DESCRIPTORS.map(d => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toMatch(/^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*$/);
  });

  it('every default lies within [min, max]', () => {
    for (const d of SYNTH2_DESCRIPTORS) {
      expect(d.default, d.key).toBeGreaterThanOrEqual(d.min);
      expect(d.default, d.key).toBeLessThanOrEqual(d.max);
      expect(d.min, d.key).toBeLessThan(d.max);
    }
  });

  it('covers exactly the I2c-1 param set (append-only from here)', () => {
    expect(SYNTH2_DESCRIPTORS.map(d => d.key)).toEqual([
      // I1 — osc1 + env1
      'osc1.morph', 'osc1.pulseWidth', 'osc1.coarse', 'osc1.fine', 'osc1.level',
      'env1.a', 'env1.d', 'env1.s', 'env1.r',
      // I2b — osc2, osc3, noise, fm
      'osc2.morph', 'osc2.pulseWidth', 'osc2.coarse', 'osc2.fine', 'osc2.level',
      'osc3.morph', 'osc3.pulseWidth', 'osc3.coarse', 'osc3.fine', 'osc3.level',
      'noise.level', 'noise.color',
      'fm.osc2', 'fm.osc3',
      // I2c-1 — hard sync (discrete booleans)
      'osc1.sync', 'osc2.sync', 'osc3.sync',
    ]);
  });

  it('sync rows are discrete booleans, excluded from the mod matrix', () => {
    for (const key of ['osc1.sync', 'osc2.sync', 'osc3.sync']) {
      const d = SYNTH2_DESCRIPTORS.find(x => x.key === key)!;
      expect(d.kind, key).toBe('bool');
      expect(isDiscrete(d), key).toBe(true);
      expect(d.modulatable, key).toBe(false);
      expect(d.default, key).toBe(0); // false
    }
  });

  it('only the osc.sync rows are discrete; everything else is continuous', () => {
    const discreteKeys = SYNTH2_DESCRIPTORS.filter(d => isDiscrete(d)).map(d => d.key);
    expect(discreteKeys).toEqual(['osc1.sync', 'osc2.sync', 'osc3.sync']);
  });

  it('encodeBool/decodeBool round-trip', () => {
    expect(encodeBool(true)).toBe(1);
    expect(encodeBool(false)).toBe(0);
    expect(decodeBool(1)).toBe(true);
    expect(decodeBool(0)).toBe(false);
    expect(decodeBool(0.4)).toBe(false);
    expect(decodeBool(0.6)).toBe(true);
  });
});
