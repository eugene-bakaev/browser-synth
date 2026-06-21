import { describe, it, expect } from 'vitest';
import { DEFAULT_HAT2_PARAMS, HAT2_DESCRIPTORS, type Hat2EngineParams } from './hat2.js';

describe('hat2 descriptor ↔ params derivation contract', () => {
  it('DEFAULT_HAT2_PARAMS mirrors the descriptor table exactly', () => {
    for (const d of HAT2_DESCRIPTORS) {
      expect((DEFAULT_HAT2_PARAMS as unknown as Record<string, number>)[d.key], d.key).toBe(d.default);
    }
    expect(Object.keys(DEFAULT_HAT2_PARAMS).sort()).toEqual(
      HAT2_DESCRIPTORS.map((d) => d.key).sort(),
    );
  });

  it('every descriptor default sits within its own [min, max]', () => {
    for (const d of HAT2_DESCRIPTORS) {
      expect(d.min, d.key).toBeLessThanOrEqual(d.default);
      expect(d.default, d.key).toBeLessThanOrEqual(d.max);
      expect(d.min, d.key).toBeLessThan(d.max);
    }
  });

  it('the params interface and the table agree on field names', () => {
    const sample: Hat2EngineParams = DEFAULT_HAT2_PARAMS;
    const keys = Object.keys(sample);
    expect(new Set(keys)).toEqual(new Set(HAT2_DESCRIPTORS.map((d) => d.key)));
  });
});
