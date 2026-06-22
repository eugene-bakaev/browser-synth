import { describe, it, expect } from 'vitest';
import {
  SYNTH2_DESCRIPTORS, KICK2_DESCRIPTORS, SNARE2_DESCRIPTORS, HAT2_DESCRIPTORS,
} from './index.js';

const ALL = [
  ['synth2', SYNTH2_DESCRIPTORS],
  ['kick2', KICK2_DESCRIPTORS],
  ['snare2', SNARE2_DESCRIPTORS],
  ['hat2', HAT2_DESCRIPTORS],
] as const;

describe('knob curve assignments', () => {
  it('exp/invexp are only declared on strictly-positive ranges', () => {
    for (const [name, table] of ALL) {
      for (const d of table) {
        if (d.curve === 'exp' || d.curve === 'invexp') {
          expect(d.min, `${name}.${d.key} min must be > 0`).toBeGreaterThan(0);
          expect(d.max, `${name}.${d.key} max must be > min`).toBeGreaterThan(d.min);
        }
      }
    }
  });

  it('the expected synth2 params carry exp, and resonance carries s', () => {
    const curveOf = new Map(SYNTH2_DESCRIPTORS.map(d => [d.key, d.curve]));
    for (const k of [
      'filter.cutoff',
      'env1.a', 'env1.d', 'env1.r',
      'env2.a', 'env2.d', 'env2.r',
      'env3.a', 'env3.d', 'env3.r',
      'lfo1.rate', 'lfo2.rate',
    ]) {
      expect(curveOf.get(k), `${k} should be exp`).toBe('exp');
    }
    expect(curveOf.get('filter.resonance')).toBe('s');
  });

  it('the expected drum freq/time params carry exp', () => {
    const has = (table: readonly { key: string; curve?: string }[], key: string) =>
      table.find(d => d.key === key)?.curve;
    expect(has(KICK2_DESCRIPTORS, 'tune')).toBe('exp');
    expect(has(KICK2_DESCRIPTORS, 'pitchDecay')).toBe('exp');
    expect(has(KICK2_DESCRIPTORS, 'decay')).toBe('exp');
    expect(has(SNARE2_DESCRIPTORS, 'tune')).toBe('exp');
    expect(has(SNARE2_DESCRIPTORS, 'bodyDecay')).toBe('exp');
    expect(has(SNARE2_DESCRIPTORS, 'noiseDecay')).toBe('exp');
    expect(has(SNARE2_DESCRIPTORS, 'tone')).toBe('exp');
    expect(has(HAT2_DESCRIPTORS, 'tone')).toBe('exp');
    expect(has(HAT2_DESCRIPTORS, 'decay')).toBe('exp');
    expect(has(HAT2_DESCRIPTORS, 'hpf')).toBe('exp');
  });
});
