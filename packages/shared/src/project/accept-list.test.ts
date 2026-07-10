import { describe, it, expect } from 'vitest';
import { pathIsWritable, indicesInRange, validatePathAndValue } from './accept-list.js';
import { SYNTH2_DESCRIPTORS, decodeBool, decodeEnum } from '../engines/index.js';

describe('pathIsWritable', () => {
  it('allows top-level bpm', () => {
    expect(pathIsWritable('bpm')).toBe(true);
  });

  it('allows nested synth ADSR leaf', () => {
    expect(pathIsWritable('tracks.0.engines.synth.filterEnv.a')).toBe(true);
  });

  it('allows step velocity', () => {
    expect(pathIsWritable('tracks.0.steps.7.velocity')).toBe(true);
  });

  it('rejects schemaVersion writes', () => {
    expect(pathIsWritable('schemaVersion')).toBe(false);
  });

  it('rejects whole-object writes (e.g. tracks.0.engines.synth)', () => {
    expect(pathIsWritable('tracks.0.engines.synth')).toBe(false);
  });

  it('returns true for out-of-bounds indices (shape-only; indicesInRange bounds-checks)', () => {
    // Path SHAPE is valid; the numeric range is enforced separately by
    // indicesInRange (and folded into validatePathAndValue).
    expect(pathIsWritable('tracks.99.engineType')).toBe(true);
  });
});

describe('indicesInRange', () => {
  it('accepts in-range track + step indices', () => {
    expect(indicesInRange('tracks.0.engineType')).toBe(true);
    expect(indicesInRange('tracks.3.mixer.volume')).toBe(true);
    expect(indicesInRange('tracks.2.steps.15.note')).toBe(true);
    expect(indicesInRange('bpm')).toBe(true);
  });

  it('rejects out-of-range track index', () => {
    expect(indicesInRange('tracks.32.engineType')).toBe(false);
    expect(indicesInRange('tracks.99.engineType')).toBe(false);
  });

  it('rejects out-of-range step index', () => {
    expect(indicesInRange('tracks.0.steps.64.note')).toBe(false);
    expect(indicesInRange('tracks.0.steps.99.velocity')).toBe(false);
  });

  it('allows step indices up to 63', () => {
    expect(indicesInRange('tracks.0.steps.63.note')).toBe(true);
    expect(indicesInRange('tracks.0.steps.64.note')).toBe(false);
  });
});

describe('validatePathAndValue', () => {
  it('accepts a valid bpm value', () => {
    expect(validatePathAndValue('bpm', 130)).toEqual({ ok: true });
  });

  it('rejects bpm out of range with value.invalid', () => {
    const r = validatePathAndValue('bpm', 9999);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('value.invalid');
  });

  it('accepts a valid filterCutoff', () => {
    expect(validatePathAndValue('tracks.0.engines.synth.filterCutoff', 1234)).toEqual({ ok: true });
  });

  it('accepts a valid filterEnv.a (NOT filterEnv.attack)', () => {
    expect(validatePathAndValue('tracks.2.engines.synth.filterEnv.a', 0.05)).toEqual({ ok: true });
  });

  it('accepts a valid step velocity', () => {
    expect(validatePathAndValue('tracks.1.steps.3.velocity', 0.7)).toEqual({ ok: true });
  });

  it('rejects schemaVersion writes with path.invalid', () => {
    const r = validatePathAndValue('schemaVersion', 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('path.invalid');
  });

  it('rejects an unknown engineType value with value.invalid', () => {
    const r = validatePathAndValue('tracks.0.engineType', 'theremin');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('value.invalid');
  });

  it('rejects an out-of-range track index with path.invalid', () => {
    const r = validatePathAndValue('tracks.99.engineType', 'synth');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('path.invalid');
  });

  it('rejects an out-of-range step index with path.invalid', () => {
    const r = validatePathAndValue('tracks.0.steps.99.note', 'C');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('path.invalid');
  });

  it('accepts a writable patternLength path with an in-range value', () => {
    expect(validatePathAndValue('tracks.0.patternLength', 32)).toEqual({ ok: true });
  });

  it('rejects patternLength out of range (both bounds) with value.invalid', () => {
    for (const bad of [65, 0, 1.5]) {
      const r = validatePathAndValue('tracks.0.patternLength', bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('value.invalid');
    }
  });
});

describe('synth2 accept-list (generated from descriptors)', () => {
  it('every descriptor key is a writable, validating path', () => {
    for (const d of SYNTH2_DESCRIPTORS) {
      const path = `tracks.0.engines.synth2.${d.key}`;
      expect(pathIsWritable(path), path).toBe(true);
      if (d.kind === 'bool') {
        // bool leaves accept true/false and reject numbers (spec §6.6 — encoded
        // on the wire as booleans, not 0/1).
        expect(validatePathAndValue(path, decodeBool(d.default)), path).toEqual({ ok: true });
        const bad = validatePathAndValue(path, d.max + 1); // a number — not boolean
        expect(bad.ok, path).toBe(false);
        if (!bad.ok) expect(bad.code).toBe('value.invalid');
      } else if (d.kind === 'enum') {
        // enum leaves accept a string from enumValues and reject numbers or
        // unknown strings (spec §6.6 — block stores the index, wire carries
        // the decoded string).
        const validStr = decodeEnum(d.default, d.enumValues!);
        expect(validatePathAndValue(path, validStr), path).toEqual({ ok: true });
        const badNum = validatePathAndValue(path, d.default); // numeric index — rejected
        expect(badNum.ok, path).toBe(false);
        if (!badNum.ok) expect(badNum.code).toBe('value.invalid');
      } else {
        expect(validatePathAndValue(path, d.default), path).toEqual({ ok: true });
        const over = validatePathAndValue(path, d.max + 1);
        expect(over.ok, path).toBe(false);
        if (!over.ok) expect(over.code).toBe('value.invalid');
      }
    }
  });

  it('rejects unknown synth2 paths and whole-module writes', () => {
    expect(pathIsWritable('tracks.0.engines.synth2.osc1.unknown')).toBe(false);
    expect(pathIsWritable('tracks.0.engines.synth2.osc1')).toBe(false);
    expect(pathIsWritable('tracks.0.engines.synth2')).toBe(false);
  });

  it('allows synth2 mode and validates its value', () => {
    expect(pathIsWritable('tracks.0.engines.synth2.mode')).toBe(true);
    expect(validatePathAndValue('tracks.0.engines.synth2.mode', 'mono')).toEqual({ ok: true });
    expect(validatePathAndValue('tracks.0.engines.synth2.mode', 'poly')).toEqual({ ok: true });
    const bad = validatePathAndValue('tracks.0.engines.synth2.mode', 'chord');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe('value.invalid');
  });

  it('accepts synth2 env3 leaves and the env loop booleans (I3c)', () => {
    expect(pathIsWritable('tracks.0.engines.synth2.env3.a')).toBe(true);
    expect(validatePathAndValue('tracks.0.engines.synth2.env3.a', 1.5)).toEqual({ ok: true });
    expect(pathIsWritable('tracks.0.engines.synth2.env3.loop')).toBe(true);
    expect(validatePathAndValue('tracks.0.engines.synth2.env1.loop', true)).toEqual({ ok: true });
    // a number at a loop (bool) leaf is rejected (spec §6.6 — booleans on the wire)
    expect(validatePathAndValue('tracks.0.engines.synth2.env2.loop', 1).ok).toBe(false);
  });
});

describe('synth2 osc.sync wire validation', () => {
  it('accepts a boolean at engines.synth2.osc2.sync', () => {
    const path = 'tracks.0.engines.synth2.osc2.sync';
    expect(pathIsWritable(path)).toBe(true);
    expect(validatePathAndValue(path, true).ok).toBe(true);
    expect(validatePathAndValue(path, false).ok).toBe(true);
  });

  it('rejects a non-boolean at engines.synth2.osc2.sync', () => {
    const path = 'tracks.0.engines.synth2.osc2.sync';
    const r = validatePathAndValue(path, 1);
    expect(r.ok).toBe(false);
  });

  it('accepts osc1.sync and osc3.sync paths too', () => {
    expect(pathIsWritable('tracks.0.engines.synth2.osc1.sync')).toBe(true);
    expect(pathIsWritable('tracks.0.engines.synth2.osc3.sync')).toBe(true);
  });
});

describe('synth2 filter wire validation', () => {
  it('accepts an enum string at engines.synth2.filter.type', () => {
    const path = 'tracks.0.engines.synth2.filter.type';
    expect(pathIsWritable(path)).toBe(true);
    expect(validatePathAndValue(path, 'lp').ok).toBe(true);
    expect(validatePathAndValue(path, 'hp').ok).toBe(true);
  });

  it('rejects a number / unknown string at filter.type', () => {
    const path = 'tracks.0.engines.synth2.filter.type';
    expect(validatePathAndValue(path, 1).ok).toBe(false);
    expect(validatePathAndValue(path, 'moog').ok).toBe(false);
  });

  it('round-trips numeric filter + env2 leaves', () => {
    expect(validatePathAndValue('tracks.0.engines.synth2.filter.cutoff', 2000).ok).toBe(true);
    expect(validatePathAndValue('tracks.0.engines.synth2.filter.cutoff', 99999).ok).toBe(false);
    expect(validatePathAndValue('tracks.0.engines.synth2.filter.envAmount', -4).ok).toBe(true);
    expect(validatePathAndValue('tracks.0.engines.synth2.env2.a', 0.5).ok).toBe(true);
  });

  it('round-trips filter.morph and filter.model (I3d)', () => {
    expect(pathIsWritable('tracks.0.engines.synth2.filter.morph')).toBe(true);
    expect(validatePathAndValue('tracks.0.engines.synth2.filter.morph', 2).ok).toBe(true);
    expect(validatePathAndValue('tracks.0.engines.synth2.filter.morph', 3).ok).toBe(false);

    const path = 'tracks.0.engines.synth2.filter.model';
    expect(pathIsWritable(path)).toBe(true);
    expect(validatePathAndValue(path, 'classic').ok).toBe(true);
    expect(validatePathAndValue(path, 'morph').ok).toBe(true);
    expect(validatePathAndValue(path, 1).ok).toBe(false);
    expect(validatePathAndValue(path, 'moog').ok).toBe(false);
  });

  it('accepts the synth2 filter.drive leaf and validates its 0..1 range (self-osc)', () => {
    expect(pathIsWritable('tracks.0.engines.synth2.filter.drive')).toBe(true);
    expect(validatePathAndValue('tracks.0.engines.synth2.filter.drive', 0.5)).toEqual({ ok: true });
    expect(validatePathAndValue('tracks.0.engines.synth2.filter.drive', 1.5).ok).toBe(false);
  });
});

describe('synth2 matrix accept-list (I3a)', () => {
  it('accepts valid matrix leaf writes', () => {
    expect(validatePathAndValue('tracks.0.engines.synth2.matrix.0.source', 'env1').ok).toBe(true);
    expect(validatePathAndValue('tracks.0.engines.synth2.matrix.7.dest', 'filter.cutoff').ok).toBe(true);
    expect(validatePathAndValue('tracks.0.engines.synth2.matrix.3.amount', -0.5).ok).toBe(true);
  });

  it('rejects an out-of-range slot index', () => {
    const r = validatePathAndValue('tracks.0.engines.synth2.matrix.8.amount', 0.5);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('path.invalid');
  });

  it('rejects a bad matrix value', () => {
    expect(validatePathAndValue('tracks.0.engines.synth2.matrix.0.source', 'nope').ok).toBe(false);
    expect(validatePathAndValue('tracks.0.engines.synth2.matrix.0.amount', 2).ok).toBe(false);
    // filter.type is a discrete (enum) param, excluded from MOD_DESTS.
    expect(validatePathAndValue('tracks.0.engines.synth2.matrix.0.dest', 'filter.type').ok).toBe(false);
  });

  it('forbids a whole-slot object write (leaves only)', () => {
    expect(pathIsWritable('tracks.0.engines.synth2.matrix.0')).toBe(false);
  });
});

describe('synth2 LFO accept-list (I3b)', () => {
  it('accepts in-range lfo leaves and rejects out-of-range / bad paths', () => {
    expect(pathIsWritable('tracks.0.engines.synth2.lfo1.rate')).toBe(true);
    expect(pathIsWritable('tracks.0.engines.synth2.lfo2.shape')).toBe(true);
    expect(validatePathAndValue('tracks.0.engines.synth2.lfo1.rate', 12).ok).toBe(true);
    expect(validatePathAndValue('tracks.0.engines.synth2.lfo1.rate', 9000).ok).toBe(false);
    expect(validatePathAndValue('tracks.0.engines.synth2.lfo2.shape', 2).ok).toBe(true);
    expect(validatePathAndValue('tracks.0.engines.synth2.lfo2.shape', 5).ok).toBe(false);
  });
});

describe('enabled flag path', () => {
  it('tracks.<i>.enabled is writable and accepts a boolean', () => {
    expect(validatePathAndValue('tracks.5.enabled', true)).toEqual({ ok: true });
  });

  it('rejects a non-boolean enabled value', () => {
    expect(validatePathAndValue('tracks.5.enabled', 'yes').ok).toBe(false);
  });

  it('allows track indices up to 31 and rejects 32', () => {
    expect(indicesInRange('tracks.31.enabled')).toBe(true);
    expect(indicesInRange('tracks.32.enabled')).toBe(false);
  });
});

describe('tracks.*.name', () => {
  it('is writable and validates strings (including empty)', () => {
    expect(validatePathAndValue('tracks.3.name', 'Bassline')).toEqual({ ok: true });
    expect(validatePathAndValue('tracks.0.name', '')).toEqual({ ok: true });
  });

  it('nacks overlong and non-string values', () => {
    expect(validatePathAndValue('tracks.0.name', 'x'.repeat(25)))
      .toMatchObject({ ok: false, code: 'value.invalid' });
    expect(validatePathAndValue('tracks.0.name', 42))
      .toMatchObject({ ok: false, code: 'value.invalid' });
  });

  it('still rejects out-of-range track indices', () => {
    expect(validatePathAndValue('tracks.99.name', 'x'))
      .toMatchObject({ ok: false, code: 'path.invalid' });
  });
});
