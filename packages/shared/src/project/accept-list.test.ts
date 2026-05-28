import { describe, it, expect } from 'vitest';
import { pathIsWritable, validatePathAndValue } from './accept-list.js';

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

  it('returns true for out-of-bounds indices (server bounds-checks separately)', () => {
    // Path SHAPE is valid; ConnectionHandler (Task 8) is responsible for
    // bounds-checking the numeric segments (tracks 0..3, steps 0..15).
    expect(pathIsWritable('tracks.99.engineType')).toBe(true);
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
});
