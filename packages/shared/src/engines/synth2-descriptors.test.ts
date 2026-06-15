import { describe, it, expect } from 'vitest';
import {
  SYNTH2_DESCRIPTORS, isDiscrete, encodeBool, decodeBool, encodeEnum, decodeEnum,
  MOD_SOURCES, MOD_DESTS,
} from './synth2-descriptors.js';

// The complete set of discrete (non-continuous) descriptor keys. Continuous
// rows are everything else. Update this when appending discrete params.
const DISCRETE_KEYS = ['osc1.sync', 'osc2.sync', 'osc3.sync', 'filter.type'];

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

  it('covers exactly the I3b param set (append-only from here)', () => {
    expect(SYNTH2_DESCRIPTORS.map(d => d.key)).toEqual([
      'osc1.morph', 'osc1.pulseWidth', 'osc1.coarse', 'osc1.fine', 'osc1.level',
      'env1.a', 'env1.d', 'env1.s', 'env1.r',
      'osc2.morph', 'osc2.pulseWidth', 'osc2.coarse', 'osc2.fine', 'osc2.level',
      'osc3.morph', 'osc3.pulseWidth', 'osc3.coarse', 'osc3.fine', 'osc3.level',
      'noise.level', 'noise.color',
      'fm.osc2', 'fm.osc3',
      'osc1.sync', 'osc2.sync', 'osc3.sync',
      'env2.a', 'env2.d', 'env2.s', 'env2.r',
      'filter.cutoff', 'filter.resonance', 'filter.keyTrack', 'filter.envAmount', 'filter.type',
      'lfo1.rate', 'lfo1.shape', 'lfo2.rate', 'lfo2.shape',
    ]);
  });

  it('discrete rows are exactly DISCRETE_KEYS; everything else is continuous', () => {
    const discrete = SYNTH2_DESCRIPTORS.filter(isDiscrete).map(d => d.key);
    expect(discrete.sort()).toEqual([...DISCRETE_KEYS].sort());
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

  it('filter.type is the first enum descriptor (lp/bp/hp, not a mod dest)', () => {
    const d = SYNTH2_DESCRIPTORS.find(x => x.key === 'filter.type')!;
    expect(d.kind).toBe('enum');
    expect(d.enumValues).toEqual(['lp', 'bp', 'hp']);
    expect(isDiscrete(d)).toBe(true);
    expect(d.modulatable).toBe(false);
    expect(d.default).toBe(0);
  });

  it('every enum descriptor declares a non-empty enumValues set', () => {
    // Guards the SYNTH2_ENUM_VALUES derivation (and decodeEnum's clamp) against a
    // future kind:'enum' row that forgets its values — which would silently drop
    // from the map and decode to undefined.
    for (const d of SYNTH2_DESCRIPTORS.filter(x => x.kind === 'enum')) {
      expect(d.enumValues, d.key).toBeDefined();
      expect(d.enumValues!.length, d.key).toBeGreaterThan(0);
    }
  });

  it('filter.envAmount is continuous but NOT a mod destination (hardwired depth)', () => {
    const d = SYNTH2_DESCRIPTORS.find(x => x.key === 'filter.envAmount')!;
    expect(isDiscrete(d)).toBe(false);
    expect(d.modulatable).toBe(false);
    expect(d.min).toBe(-4);
    expect(d.max).toBe(4);
  });

  it('encodeBool/decodeBool round-trip', () => {
    expect(encodeBool(true)).toBe(1);
    expect(encodeBool(false)).toBe(0);
    expect(decodeBool(1)).toBe(true);
    expect(decodeBool(0)).toBe(false);
    expect(decodeBool(0.4)).toBe(false);
    expect(decodeBool(0.6)).toBe(true);
  });

  it('encodeEnum/decodeEnum round-trip by index', () => {
    const v = ['lp', 'bp', 'hp'] as const;
    expect(encodeEnum('lp', v)).toBe(0);
    expect(encodeEnum('bp', v)).toBe(1);
    expect(encodeEnum('hp', v)).toBe(2);
    expect(encodeEnum('nope', v)).toBe(0);
    expect(decodeEnum(0, v)).toBe('lp');
    expect(decodeEnum(2, v)).toBe('hp');
    expect(decodeEnum(1.6, v)).toBe('hp');
    expect(decodeEnum(9, v)).toBe('hp');
    expect(decodeEnum(-3, v)).toBe('lp');
  });
});

describe('mod matrix enums (I3a)', () => {
  it('MOD_SOURCES is the fixed, append-only source list', () => {
    // Order is the wire encoding for matrix[*].source AND the sources[] index.
    expect(MOD_SOURCES).toEqual(['none', 'lfo1', 'lfo2', 'env1', 'env2', 'env3', 'velocity', 'noise']);
  });

  it('MOD_DESTS is none + every modulatable descriptor key, in descriptor order', () => {
    const expected = ['none', ...SYNTH2_DESCRIPTORS.filter(d => d.modulatable).map(d => d.key)];
    expect(MOD_DESTS).toEqual(expected);
  });

  it('discrete + hardwired params are NOT matrix destinations', () => {
    // sync toggles, filter.type (enum), filter.envAmount (modulatable:false) excluded.
    for (const key of ['osc1.sync', 'osc2.sync', 'osc3.sync', 'filter.type', 'filter.envAmount']) {
      expect(MOD_DESTS).not.toContain(key);
    }
  });
});

describe('LFO descriptor rows (I3b)', () => {
  it('appends exactly four LFO rows at the tail (append-only)', () => {
    const tail = SYNTH2_DESCRIPTORS.slice(-4).map(d => d.key);
    expect(tail).toEqual(['lfo1.rate', 'lfo1.shape', 'lfo2.rate', 'lfo2.shape']);
  });

  it('LFO rate is exponential ±4 oct, shape is linear full-range, both modulatable', () => {
    const byKey = Object.fromEntries(SYNTH2_DESCRIPTORS.map(d => [d.key, d]));
    for (const k of ['lfo1.rate', 'lfo2.rate']) {
      expect(byKey[k].min).toBe(0.01);
      expect(byKey[k].max).toBe(2000);
      expect(byKey[k].taper).toBe('expOctaves');
      expect(byKey[k].modScale).toBe(4);
      expect(byKey[k].modulatable).toBe(true);
    }
    for (const k of ['lfo1.shape', 'lfo2.shape']) {
      expect(byKey[k].min).toBe(0);
      expect(byKey[k].max).toBe(4);
      expect(byKey[k].taper).toBe('linear');
      expect(byKey[k].modScale).toBe(1);
      expect(byKey[k].modulatable).toBe(true);
    }
    expect(byKey['lfo1.rate'].default).toBe(5);
    expect(byKey['lfo1.shape'].default).toBe(0);
    expect(byKey['lfo2.rate'].default).toBe(0.5);
    expect(byKey['lfo2.shape'].default).toBe(1);
  });

  it('makes the LFO rate/shape keys modulation destinations (derived MOD_DESTS)', () => {
    for (const k of ['lfo1.rate', 'lfo1.shape', 'lfo2.rate', 'lfo2.shape']) {
      expect(MOD_DESTS).toContain(k);
    }
  });

  it('leaves MOD_SOURCES untouched (lfo1/lfo2 already existed inert)', () => {
    expect(MOD_SOURCES).toEqual(['none', 'lfo1', 'lfo2', 'env1', 'env2', 'env3', 'velocity', 'noise']);
  });
});
