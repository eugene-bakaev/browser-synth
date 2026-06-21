import { describe, it, expect } from 'vitest';
import { DEFAULT_SNARE2_PARAMS, SNARE2_DESCRIPTORS, type Snare2EngineParams } from './snare2.js';

describe('snare2 descriptor ↔ params derivation contract', () => {
  it('DEFAULT_SNARE2_PARAMS mirrors the descriptor table exactly', () => {
    for (const d of SNARE2_DESCRIPTORS) {
      expect((DEFAULT_SNARE2_PARAMS as unknown as Record<string, number>)[d.key], d.key).toBe(d.default);
    }
    // No extra leaves beyond the table (and no missing ones).
    expect(Object.keys(DEFAULT_SNARE2_PARAMS).sort()).toEqual(
      SNARE2_DESCRIPTORS.map((d) => d.key).sort(),
    );
  });

  it('every descriptor default sits within its own [min, max]', () => {
    for (const d of SNARE2_DESCRIPTORS) {
      expect(d.min, d.key).toBeLessThanOrEqual(d.default);
      expect(d.default, d.key).toBeLessThanOrEqual(d.max);
      expect(d.min, d.key).toBeLessThan(d.max);
    }
  });

  it('the params interface and the table agree on field names', () => {
    // A compile-time check made runtime: every interface key is a descriptor key.
    const sample: Snare2EngineParams = DEFAULT_SNARE2_PARAMS;
    const keys = Object.keys(sample);
    expect(new Set(keys)).toEqual(new Set(SNARE2_DESCRIPTORS.map((d) => d.key)));
  });
});
