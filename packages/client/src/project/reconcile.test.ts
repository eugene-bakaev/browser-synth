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

  it('reconcileSteps: length-1 loaded → returns length 64 buffer', () => {
    const p = freshProject();
    p.tracks[0].steps = [{ ...p.tracks[0].steps[0], note: 'X' }] as any;
    const reconciled = reconcileWithDefaults(p);
    expect(reconciled.tracks[0].steps).toHaveLength(64);
    expect(reconciled.tracks[0].steps[0].note).toBe('X');
    expect(reconciled.tracks[0].steps[1].note).toBeNull();
  });

  it('reconcileSteps: length-20 loaded → returns length 64 buffer (extras preserved up to 64)', () => {
    const p = freshProject();
    const long = Array.from({ length: 20 }, (_, i) => ({ ...freshTrack().steps[0], note: `N${i}` }));
    p.tracks[0].steps = long as any;
    const reconciled = reconcileWithDefaults(p);
    expect(reconciled.tracks[0].steps).toHaveLength(64);
    expect(reconciled.tracks[0].steps[15].note).toBe('N15');
  });

  it('reconcileSteps: non-array → returns 64 fresh defaults', () => {
    const p = freshProject();
    (p.tracks[0] as any).steps = undefined;
    const reconciled = reconcileWithDefaults(p);
    expect(reconciled.tracks[0].steps).toHaveLength(64);
    expect(reconciled.tracks[0].steps.every(s => s.note === null)).toBe(true);
  });

  it('sets schemaVersion to current', () => {
    const reconciled = reconcileWithDefaults({} as any);
    expect(reconciled.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
  });

  // bpm goes through the shared coerceBpm rule (same as the sync boundary), so
  // the offline load path can't surface a blank/garbage bpm either.
  it('defaults a missing bpm to 120', () => {
    expect(reconcileWithDefaults({} as any).bpm).toBe(120);
  });

  it('defaults a NaN/non-number bpm to 120 (old typeof check let NaN through)', () => {
    expect(reconcileWithDefaults({ bpm: NaN } as any).bpm).toBe(120);
    expect(reconcileWithDefaults({ bpm: '128' } as any).bpm).toBe(120);
  });

  it('clamps and rounds an out-of-range / fractional bpm', () => {
    expect(reconcileWithDefaults({ bpm: 5000 } as any).bpm).toBe(240);
    expect(reconcileWithDefaults({ bpm: 10 } as any).bpm).toBe(40);
    expect(reconcileWithDefaults({ bpm: 128.7 } as any).bpm).toBe(129);
  });

  it('preserves a valid bpm', () => {
    expect(reconcileWithDefaults({ bpm: 140 } as any).bpm).toBe(140);
  });

  it('pads a 16-step v1 track to a 64-step buffer and defaults patternLength to 16', () => {
    const v1Track = { engineType: 'synth', engines: {}, mixer: {}, steps: Array.from({ length: 16 }, () => ({ note: 'C', octave: 4, length: 1, velocity: 0.8, muted: false })) };
    const out = reconcileWithDefaults({ schemaVersion: 1, bpm: 120, tracks: [v1Track] });
    expect(out.tracks[0].steps).toHaveLength(64);
    expect(out.tracks[0].steps[0].note).toBe('C');   // original data preserved
    expect(out.tracks[0].steps[20].note).toBe(null);  // padded with blanks
    expect(out.tracks[0].patternLength).toBe(16);     // defaulted
    expect(out.schemaVersion).toBe(2);
  });

  it('preserves an explicit patternLength when present', () => {
    const out = reconcileWithDefaults({ schemaVersion: 2, bpm: 120, tracks: [{ patternLength: 7 }] });
    expect(out.tracks[0].patternLength).toBe(7);
  });

  it('clamps an out-of-range patternLength on load (guards modulo-by-zero)', () => {
    const lo = reconcileWithDefaults({ schemaVersion: 2, bpm: 120, tracks: [{ patternLength: 0 }] });
    expect(lo.tracks[0].patternLength).toBe(1);
    const hi = reconcileWithDefaults({ schemaVersion: 2, bpm: 120, tracks: [{ patternLength: 999 }] });
    expect(hi.tracks[0].patternLength).toBe(64);
  });

  it('heals a synth2 slice missing osc.sync to false', () => {
    // Simulate a pre-I2c-1 snapshot: a synth2 track whose oscillators lack sync.
    const p = freshProject();
    const synth2 = p.tracks[0].engines.synth2 as any;
    delete synth2.osc1.sync;
    delete synth2.osc2.sync;
    delete synth2.osc3.sync;
    const healed = reconcileWithDefaults(p);
    const healedSynth2 = healed.tracks[0].engines.synth2;
    expect(healedSynth2.osc1.sync).toBe(false);
    expect(healedSynth2.osc2.sync).toBe(false);
    expect(healedSynth2.osc3.sync).toBe(false);
  });

  it('heals a synth2 slice missing filter/env2 to defaults', () => {
    // Simulate a pre-I2c-2 snapshot: a synth2 track whose params lack filter and env2.
    const p = freshProject();
    const synth2 = p.tracks[0].engines.synth2 as any;
    delete synth2.filter;
    delete synth2.env2;
    const healed = reconcileWithDefaults(p);
    const s2 = healed.tracks[0].engines.synth2;
    expect(s2.filter.type).toBe('lp');
    expect(s2.filter.cutoff).toBe(2000);
    expect(s2.filter.envAmount).toBeCloseTo(2.4, 6);
    expect(s2.env2).toEqual({
      a: 0.01, d: 0.2, s: 0.5, r: 0.5, loop: false,
      sync: false, aDiv: '1/32', dDiv: '1/8', rDiv: '1/4',
    });
  });

  it('heals a synth2 slice missing filter.morph/filter.model to defaults (I3d)', () => {
    // Simulate a pre-I3d snapshot: a synth2 filter slice that predates the morph leaves.
    const p = freshProject();
    const synth2 = p.tracks[0].engines.synth2 as any;
    delete synth2.filter.morph;
    delete synth2.filter.model;
    const healed = reconcileWithDefaults(p);
    const s2 = healed.tracks[0].engines.synth2;
    expect(s2.filter.morph).toBe(0);
    expect(s2.filter.model).toBe('classic');
  });

  describe('synth2 matrix reconcile (I3a)', () => {
    it('heals a synth2 slice missing matrix to 8 default slots', () => {
      const p = freshProject();
      const synth2 = p.tracks[0].engines.synth2 as unknown as Record<string, unknown>;
      delete synth2.matrix;
      const healed = reconcileWithDefaults(p);
      const m = healed.tracks[0].engines.synth2.matrix;
      expect(m).toHaveLength(8);
      expect(m[0]).toEqual({ source: 'none', dest: 'none', amount: 0 });
    });

    it('preserves an existing matrix route through reconcile', () => {
      const p = freshProject();
      p.tracks[0].engines.synth2.matrix[2] = { source: 'env1', dest: 'filter.cutoff', amount: 0.7 };
      const healed = reconcileWithDefaults(p);
      expect(healed.tracks[0].engines.synth2.matrix[2]).toEqual({ source: 'env1', dest: 'filter.cutoff', amount: 0.7 });
    });

    it('fresh track carries the default 8-slot matrix', () => {
      expect(freshTrack().engines.synth2.matrix).toHaveLength(8);
    });

    it('healed matrix array is not reference-shared with the input project', () => {
      const p = freshProject();
      const inputMatrix = p.tracks[0].engines.synth2.matrix;
      const healed = reconcileWithDefaults(p);
      // The healed array must be a different reference from the input
      expect(healed.tracks[0].engines.synth2.matrix).not.toBe(inputMatrix);
      // Mutating a slot on the healed result must not bleed back into the input
      (healed.tracks[0].engines.synth2.matrix[0] as any).source = 'lfo1';
      expect(inputMatrix[0].source).toBe('none');
    });
  });
});
