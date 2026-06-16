import { describe, it, expect } from 'vitest';
import { DEFAULT_SYNTH2_PARAMS } from './synth2.js';
import { SYNTH2_DESCRIPTORS, decodeBool, decodeEnum } from './synth2-descriptors.js';

describe('DEFAULT_SYNTH2_PARAMS', () => {
  it('mirrors the descriptor table exactly (derivation contract)', () => {
    for (const d of SYNTH2_DESCRIPTORS) {
      const [mod, field] = d.key.split('.');
      const slice = (DEFAULT_SYNTH2_PARAMS as any)[mod];
      expect(slice, d.key).toBeDefined();
      // bool descriptors are decoded to actual booleans; enum descriptors to their string value.
      const expected =
        d.kind === 'bool' ? decodeBool(d.default)
        : d.kind === 'enum' ? decodeEnum(d.default, d.enumValues!)
        : d.default;
      expect(slice[field], d.key).toBe(expected);
    }
    // No extra leaves beyond the table (matrix excluded — not descriptor-derived).
    const leafCount = Object.entries(DEFAULT_SYNTH2_PARAMS)
      .filter(([k, m]) => k !== 'matrix' && m !== null && typeof m === 'object')
      .reduce((n, [, m]) => n + Object.keys(m).length, 0);
    expect(leafCount).toBe(SYNTH2_DESCRIPTORS.length);
  });

  it('defaults mode to mono', () => {
    expect(DEFAULT_SYNTH2_PARAMS.mode).toBe('mono');
  });

  it('defaults each oscillator sync to false (boolean, not number)', () => {
    expect(DEFAULT_SYNTH2_PARAMS.osc1.sync).toBe(false);
    expect(DEFAULT_SYNTH2_PARAMS.osc2.sync).toBe(false);
    expect(DEFAULT_SYNTH2_PARAMS.osc3.sync).toBe(false);
    expect(typeof DEFAULT_SYNTH2_PARAMS.osc2.sync).toBe('boolean');
  });

  it('defaults the classic filter (type lp, cutoff 2000, res 0.15, envAmount 2.4)', () => {
    const f = DEFAULT_SYNTH2_PARAMS.filter;
    expect(f.type).toBe('lp');
    expect(typeof f.type).toBe('string'); // enum decoded to its value, not an index
    expect(f.cutoff).toBe(2000);
    expect(f.resonance).toBe(0.15);
    expect(f.keyTrack).toBe(0);
    expect(f.envAmount).toBeCloseTo(2.4, 6);
  });

  it('defaults env2 to the same a/d/s/r as env1, loop off', () => {
    expect(DEFAULT_SYNTH2_PARAMS.env2).toEqual({ a: 0.01, d: 0.2, s: 0.5, r: 0.5, loop: false });
  });

  it('default matrix is 8 inert slots (I3a)', () => {
    expect(DEFAULT_SYNTH2_PARAMS.matrix).toHaveLength(8);
    for (const slot of DEFAULT_SYNTH2_PARAMS.matrix) {
      expect(slot).toEqual({ source: 'none', dest: 'none', amount: 0 });
    }
  });

  it('defaults LFO1 to 5 Hz sine and LFO2 to 0.5 Hz triangle (I3b)', () => {
    expect(DEFAULT_SYNTH2_PARAMS.lfo1).toEqual({ rate: 5, shape: 0 });
    expect(DEFAULT_SYNTH2_PARAMS.lfo2).toEqual({ rate: 0.5, shape: 1 });
  });

  it('defaults env3 to a 0.2 / d 0.3 / s 0 / r 0.3, loop off (I3c)', () => {
    expect(DEFAULT_SYNTH2_PARAMS.env3).toEqual({ a: 0.2, d: 0.3, s: 0, r: 0.3, loop: false });
  });

  it('defaults env1.loop and env2.loop to false (boolean, not number) (I3c)', () => {
    expect(DEFAULT_SYNTH2_PARAMS.env1.loop).toBe(false);
    expect(DEFAULT_SYNTH2_PARAMS.env2.loop).toBe(false);
    expect(typeof DEFAULT_SYNTH2_PARAMS.env3.loop).toBe('boolean');
  });
});
