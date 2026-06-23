import { describe, it, expect } from 'vitest';
import { DEFAULT_CLAP2_PARAMS, CLAP2_DESCRIPTORS, type Clap2EngineParams } from './clap2.js';

describe('clap2 descriptor ↔ params derivation contract', () => {
  it('DEFAULT_CLAP2_PARAMS mirrors the descriptor table exactly', () => {
    for (const d of CLAP2_DESCRIPTORS) {
      expect((DEFAULT_CLAP2_PARAMS as unknown as Record<string, number>)[d.key], d.key).toBe(d.default);
    }
    expect(Object.keys(DEFAULT_CLAP2_PARAMS).sort()).toEqual(
      CLAP2_DESCRIPTORS.map((d) => d.key).sort(),
    );
  });

  it('every descriptor default sits within its own [min, max]', () => {
    for (const d of CLAP2_DESCRIPTORS) {
      expect(d.min, d.key).toBeLessThanOrEqual(d.default);
      expect(d.default, d.key).toBeLessThanOrEqual(d.max);
      expect(d.min, d.key).toBeLessThan(d.max);
    }
  });

  it('the params interface and the table agree on field names', () => {
    const sample: Clap2EngineParams = DEFAULT_CLAP2_PARAMS;
    const keys = Object.keys(sample);
    expect(new Set(keys)).toEqual(new Set(CLAP2_DESCRIPTORS.map((d) => d.key)));
  });

  it('bursts is an integer count knob: linear, step 1, no display format', () => {
    const bursts = CLAP2_DESCRIPTORS.find((d) => d.key === 'bursts')!;
    expect(bursts.step).toBe(1);
    expect(bursts.curve ?? 'linear').toBe('linear');
    expect(bursts.format).toBeUndefined();
  });
});
