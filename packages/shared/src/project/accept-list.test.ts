import { describe, it, expect } from 'vitest';
import { pathIsWritable, indicesInRange, validatePathAndValue } from './accept-list.js';

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
    expect(indicesInRange('tracks.4.engineType')).toBe(false);
    expect(indicesInRange('tracks.99.engineType')).toBe(false);
  });

  it('rejects out-of-range step index', () => {
    expect(indicesInRange('tracks.0.steps.16.note')).toBe(false);
    expect(indicesInRange('tracks.0.steps.99.velocity')).toBe(false);
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
});
