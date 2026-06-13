import { describe, it, expect } from 'vitest';
import { DEFAULT_SYNTH2_PARAMS } from './synth2.js';
import { SYNTH2_DESCRIPTORS } from './synth2-descriptors.js';

describe('DEFAULT_SYNTH2_PARAMS', () => {
  it('mirrors the descriptor table exactly (derivation contract)', () => {
    for (const d of SYNTH2_DESCRIPTORS) {
      const [mod, field] = d.key.split('.');
      const slice = (DEFAULT_SYNTH2_PARAMS as any)[mod];
      expect(slice, d.key).toBeDefined();
      expect(slice[field], d.key).toBe(d.default);
    }
    // No extra leaves beyond the table.
    const leafCount = Object.values(DEFAULT_SYNTH2_PARAMS)
      .filter(m => m !== null && typeof m === 'object')
      .reduce((n, m) => n + Object.keys(m).length, 0);
    expect(leafCount).toBe(SYNTH2_DESCRIPTORS.length);
  });

  it('defaults mode to mono', () => {
    expect(DEFAULT_SYNTH2_PARAMS.mode).toBe('mono');
  });
});
