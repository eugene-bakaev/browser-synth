import { describe, it, expect } from 'vitest';
import {
  SYNTH2_DESCRIPTORS, isDiscrete, encodeBool, decodeBool, encodeEnum, decodeEnum,
  MOD_SOURCES, MOD_DESTS, SYNTH2_ENUM_VALUES,
} from './synth2-descriptors.js';
import { LFO_SYNC_LABELS } from './lfo-sync.js';
import { ENV_SYNC_LABELS } from './env-sync.js';

// The complete set of discrete (non-continuous) descriptor keys. Continuous
// rows are everything else. Update this when appending discrete params.
const DISCRETE_KEYS = ['osc1.sync', 'osc2.sync', 'osc3.sync', 'filter.type', 'env1.loop', 'env2.loop', 'env3.loop', 'filter.model', 'lfo1.sync', 'lfo1.div', 'lfo2.sync', 'lfo2.div', 'env1.sync', 'env1.aDiv', 'env1.dDiv', 'env1.rDiv', 'env2.sync', 'env2.aDiv', 'env2.dDiv', 'env2.rDiv', 'env3.sync', 'env3.aDiv', 'env3.dDiv', 'env3.rDiv'];

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

  it('noise.color is a continuous 0..1 color morph defaulting to white (0.5)', () => {
    // White lives at the center now (was the old lowpass-open default of 1).
    const d = SYNTH2_DESCRIPTORS.find(x => x.key === 'noise.color')!;
    expect(d.min).toBe(0);
    expect(d.max).toBe(1);
    expect(d.default).toBe(0.5);
    expect(d.taper).toBe('linear');
    expect(d.modulatable).toBe(true);
    expect(d.modScale).toBe(1);
    expect(d.kind).toBeUndefined(); // continuous, still a mod destination
  });

  it('covers exactly the I3d param set (append-only from here)', () => {
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
      'env3.a', 'env3.d', 'env3.s', 'env3.r',
      'env1.loop', 'env2.loop', 'env3.loop',
      'filter.morph', 'filter.model',
      'filter.drive',
      'lfo1.sync', 'lfo1.div', 'lfo2.sync', 'lfo2.div',
      'env1.sync', 'env1.aDiv', 'env1.dDiv', 'env1.rDiv',
      'env2.sync', 'env2.aDiv', 'env2.dDiv', 'env2.rDiv',
      'env3.sync', 'env3.aDiv', 'env3.dDiv', 'env3.rDiv',
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
  it('keeps the four LFO rows consecutive in table order (I3b)', () => {
    const i = SYNTH2_DESCRIPTORS.findIndex(d => d.key === 'lfo1.rate');
    expect(SYNTH2_DESCRIPTORS.slice(i, i + 4).map(d => d.key))
      .toEqual(['lfo1.rate', 'lfo1.shape', 'lfo2.rate', 'lfo2.shape']);
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

describe('env3 + loop descriptor rows (I3c)', () => {
  const byKey = Object.fromEntries(SYNTH2_DESCRIPTORS.map(d => [d.key, d]));

  it('appends the seven I3c rows consecutively (append-only)', () => {
    const i = SYNTH2_DESCRIPTORS.findIndex(d => d.key === 'env3.a');
    const i3c = SYNTH2_DESCRIPTORS.slice(i, i + 7).map(d => d.key);
    expect(i3c).toEqual([
      'env3.a', 'env3.d', 'env3.s', 'env3.r', 'env1.loop', 'env2.loop', 'env3.loop',
    ]);
  });

  it('env3 a/d/s/r mirror env1/env2 (continuous, modulatable, expOctaves times)', () => {
    expect(byKey['env3.a']).toMatchObject({ min: 0.001, max: 10, default: 0.2, taper: 'expOctaves', modulatable: true, modScale: 4 });
    expect(byKey['env3.d']).toMatchObject({ default: 0.3, taper: 'expOctaves', modulatable: true });
    expect(byKey['env3.s']).toMatchObject({ min: 0, max: 1, default: 0, taper: 'linear', modulatable: true, modScale: 1 });
    expect(byKey['env3.r']).toMatchObject({ default: 0.3, taper: 'expOctaves', modulatable: true });
    for (const k of ['env3.a', 'env3.d', 'env3.s', 'env3.r']) {
      expect(byKey[k].kind, k).toBeUndefined(); // continuous
    }
  });

  it('loop rows are discrete booleans, default off, excluded from the mod matrix', () => {
    for (const k of ['env1.loop', 'env2.loop', 'env3.loop']) {
      const d = byKey[k];
      expect(d.kind, k).toBe('bool');
      expect(isDiscrete(d), k).toBe(true);
      expect(d.modulatable, k).toBe(false);
      expect(d.default, k).toBe(0); // false
    }
  });

  it('MOD_SOURCES is unchanged (env3 was always present; now live)', () => {
    expect(MOD_SOURCES).toEqual(['none', 'lfo1', 'lfo2', 'env1', 'env2', 'env3', 'velocity', 'noise']);
  });

  it('MOD_DESTS gains the four env3 keys but NOT the loop bools', () => {
    for (const k of ['env3.a', 'env3.d', 'env3.s', 'env3.r']) expect(MOD_DESTS).toContain(k);
    for (const k of ['env1.loop', 'env2.loop', 'env3.loop']) expect(MOD_DESTS).not.toContain(k);
  });
});

describe('morph filter descriptor rows (I3d)', () => {
  const byKey = Object.fromEntries(SYNTH2_DESCRIPTORS.map(d => [d.key, d]));

  it('filter.morph is a continuous 0..2 modulatable blend (auto mod dest)', () => {
    expect(byKey['filter.morph']).toMatchObject({
      min: 0, max: 2, default: 0, taper: 'linear', modulatable: true, modScale: 1,
    });
    expect(byKey['filter.morph'].kind).toBeUndefined();
    expect(MOD_DESTS).toContain('filter.morph');
  });

  it('filter.model is the second enum (classic/morph), not a mod dest', () => {
    const d = byKey['filter.model'];
    expect(d.kind).toBe('enum');
    expect(d.enumValues).toEqual(['classic', 'morph']);
    expect(d.modulatable).toBe(false);
    expect(SYNTH2_ENUM_VALUES['filter.model']).toEqual(['classic', 'morph']);
    expect(MOD_DESTS).not.toContain('filter.model');
  });

  it('filter.drive is a continuous 0..1 modulatable saturation (auto mod dest), default 0', () => {
    expect(byKey['filter.drive']).toMatchObject({
      min: 0, max: 1, default: 0, taper: 'linear', modulatable: true, modScale: 1,
    });
    expect(byKey['filter.drive'].kind).toBeUndefined();
    expect(MOD_DESTS).toContain('filter.drive');
  });
});

describe('envelope tempo-sync descriptor rows (step divisions, 2026-07-08)', () => {
  it('envelope div rows: bool + three ENV_SYNC_LABELS enums per envelope, defaults 1/2 / 2 / 4 steps', () => {
    for (const env of ['env1', 'env2', 'env3']) {
      const sync = SYNTH2_DESCRIPTORS.find(d => d.key === `${env}.sync`)!;
      expect(sync.kind, sync.key).toBe('bool');
      expect(sync.default, sync.key).toBe(0); // off
      expect(sync.modulatable, sync.key).toBe(false);
      const stageDefaults = { aDiv: '1/2', dDiv: '2', rDiv: '4' } as const;
      for (const [field, label] of Object.entries(stageDefaults)) {
        const d = SYNTH2_DESCRIPTORS.find(x => x.key === `${env}.${field}`)!;
        expect(d.kind, d.key).toBe('enum');
        expect(d.enumValues, d.key).toBe(ENV_SYNC_LABELS);
        expect(d.min, d.key).toBe(0);
        expect(d.max, d.key).toBe(ENV_SYNC_LABELS.length - 1);
        expect(d.default, d.key).toBe(ENV_SYNC_LABELS.indexOf(label));
        expect(d.modulatable, d.key).toBe(false);
      }
    }
  });

  it('LFO div rows keep the note-division vocabulary (two vocabularies stay separate)', () => {
    for (const key of ['lfo1.div', 'lfo2.div']) {
      expect(SYNTH2_DESCRIPTORS.find(d => d.key === key)!.enumValues).toBe(LFO_SYNC_LABELS);
    }
  });
});
