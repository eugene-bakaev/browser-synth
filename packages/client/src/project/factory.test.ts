import { describe, it, expect } from 'vitest';
import { freshProject, freshTrack, freshStep } from './factory';
import { PROJECT_SCHEMA_VERSION } from './types';
import { SynthEngine } from '../engine/SynthEngine';
import { KickEngine } from '../engine/KickEngine';
import { HatEngine } from '../engine/HatEngine';
import { SnareEngine } from '../engine/SnareEngine';
import { ClapEngine } from '../engine/ClapEngine';

describe('freshStep', () => {
  it('matches the canonical default Step shape', () => {
    expect(freshStep()).toEqual({
      note: null, octave: 4, length: 1, velocity: 0.8,
      muted: false, isChord: false, chordType: 'maj',
    });
  });

  it('returns a fresh object each call (no reference sharing)', () => {
    expect(freshStep()).not.toBe(freshStep());
  });
});

describe('freshTrack', () => {
  it('defaults to synth engineType', () => {
    const t = freshTrack();
    expect(t.engineType).toBe('synth');
  });

  it('populates all 5 engine slots from each engine\'s DEFAULT_PARAMS', () => {
    const t = freshTrack();
    expect(t.engines.synth).toEqual(SynthEngine.DEFAULT_PARAMS);
    expect(t.engines.kick).toEqual(KickEngine.DEFAULT_PARAMS);
    expect(t.engines.hat).toEqual(HatEngine.DEFAULT_PARAMS);
    expect(t.engines.snare).toEqual(SnareEngine.DEFAULT_PARAMS);
    expect(t.engines.clap).toEqual(ClapEngine.DEFAULT_PARAMS);
  });

  it('deep-clones engine defaults (no reference sharing across tracks)', () => {
    const a = freshTrack();
    const b = freshTrack();
    a.engines.synth.filterEnv.a = 0.99;
    expect(b.engines.synth.filterEnv.a).toBe(SynthEngine.DEFAULT_PARAMS.filterEnv.a);
  });

  it('has 16 fresh steps', () => {
    const t = freshTrack();
    expect(t.steps).toHaveLength(16);
    for (const s of t.steps) {
      expect(s).toEqual(freshStep());
    }
  });

  it('mixer is a fresh copy of DEFAULT_MIXER_STATE', () => {
    const t = freshTrack();
    expect(t.mixer.volume).toBe(0.9);
    expect(t.mixer.muted).toBe(false);
    expect(t.mixer.soloed).toBe(false);
  });

  it('freshTrack synth defaults include mode = mono', () => {
    const t = freshTrack();
    expect(t.engines.synth.mode).toBe('mono');
  });
});

describe('freshProject', () => {
  it('uses the current schemaVersion', () => {
    expect(freshProject().schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
  });

  it('starts at 120 bpm with 4 tracks', () => {
    const p = freshProject();
    expect(p.bpm).toBe(120);
    expect(p.tracks).toHaveLength(4);
  });

  it('tracks are independent (mutating one does not affect another)', () => {
    const p = freshProject();
    p.tracks[0].engines.synth.osc1Coarse = 7;
    expect(p.tracks[1].engines.synth.osc1Coarse).toBe(SynthEngine.DEFAULT_PARAMS.osc1Coarse);
  });
});
