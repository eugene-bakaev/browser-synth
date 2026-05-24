import { describe, it, expect } from 'vitest';
import { reconcileWithDefaults } from './storage';
import { freshProject, freshTrack } from './factory';
import { SynthEngine } from '../engine/SynthEngine';
import { KickEngine } from '../engine/KickEngine';
import { PROJECT_SCHEMA_VERSION } from './types';

describe('reconcileWithDefaults', () => {
  it('fills a missing engine slot from that engine\'s DEFAULT_PARAMS', () => {
    const p = freshProject();
    delete (p.tracks[0].engines as any).kick;
    const reconciled = reconcileWithDefaults(p);
    expect(reconciled.tracks[0].engines.kick).toEqual(KickEngine.DEFAULT_PARAMS);
  });

  it('fills a missing field in an engine slot while preserving loaded fields', () => {
    const p = freshProject();
    delete (p.tracks[0].engines.synth as any).osc1Level;
    p.tracks[0].engines.synth.osc1Coarse = 2;
    const reconciled = reconcileWithDefaults(p);
    expect(reconciled.tracks[0].engines.synth.osc1Level).toBe(SynthEngine.DEFAULT_PARAMS.osc1Level);
    expect(reconciled.tracks[0].engines.synth.osc1Coarse).toBe(2);
  });

  it('fills missing ADSR fields while preserving present ones', () => {
    const p = freshProject();
    (p.tracks[0].engines.synth.ampEnv as any) = { a: 0.5 };
    const reconciled = reconcileWithDefaults(p);
    expect(reconciled.tracks[0].engines.synth.ampEnv.a).toBe(0.5);
    expect(reconciled.tracks[0].engines.synth.ampEnv.d).toBe(SynthEngine.DEFAULT_PARAMS.ampEnv.d);
    expect(reconciled.tracks[0].engines.synth.ampEnv.s).toBe(SynthEngine.DEFAULT_PARAMS.ampEnv.s);
    expect(reconciled.tracks[0].engines.synth.ampEnv.r).toBe(SynthEngine.DEFAULT_PARAMS.ampEnv.r);
  });

  it('fills a partial mixer', () => {
    const p = freshProject();
    (p.tracks[0].mixer as any) = { volume: 0.5 };
    const reconciled = reconcileWithDefaults(p);
    expect(reconciled.tracks[0].mixer.volume).toBe(0.5);
    expect(reconciled.tracks[0].mixer.muted).toBe(false);
    expect(reconciled.tracks[0].mixer.soloed).toBe(false);
  });

  it('passes unknown extra fields through (forward-compat)', () => {
    const p = freshProject();
    (p as any).futureField = 'hello';
    const reconciled: any = reconcileWithDefaults(p);
    expect(reconciled.futureField).toBe('hello');
  });

  it('reconcileSteps: length-1 loaded → returns length 16', () => {
    const p = freshProject();
    p.tracks[0].steps = [{ ...p.tracks[0].steps[0], note: 'X' }] as any;
    const reconciled = reconcileWithDefaults(p);
    expect(reconciled.tracks[0].steps).toHaveLength(16);
    expect(reconciled.tracks[0].steps[0].note).toBe('X');
    expect(reconciled.tracks[0].steps[1].note).toBeNull();
  });

  it('reconcileSteps: length-20 loaded → returns length 16 (extras dropped)', () => {
    const p = freshProject();
    const long = Array.from({ length: 20 }, (_, i) => ({ ...freshTrack().steps[0], note: `N${i}` }));
    p.tracks[0].steps = long as any;
    const reconciled = reconcileWithDefaults(p);
    expect(reconciled.tracks[0].steps).toHaveLength(16);
    expect(reconciled.tracks[0].steps[15].note).toBe('N15');
  });

  it('reconcileSteps: non-array → returns 16 fresh defaults', () => {
    const p = freshProject();
    (p.tracks[0] as any).steps = undefined;
    const reconciled = reconcileWithDefaults(p);
    expect(reconciled.tracks[0].steps).toHaveLength(16);
    expect(reconciled.tracks[0].steps.every(s => s.note === null)).toBe(true);
  });

  it('sets schemaVersion to current', () => {
    const reconciled = reconcileWithDefaults({} as any);
    expect(reconciled.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
  });
});
