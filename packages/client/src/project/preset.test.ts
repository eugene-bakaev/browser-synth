import { describe, it, expect } from 'vitest';
import {
  makePreset,
  serializePreset,
  deserializePreset,
  applyPresetDraft,
  resetEnginePatchDraft,
  PRESET_SCHEMA_VERSION,
  type Preset,
} from './preset';
import { freshTrack } from './factory';
import { SynthEngine } from '../engine/SynthEngine';
import { KickEngine } from '../engine/KickEngine';

describe('preset — makePreset', () => {
  it('builds a Preset with schemaVersion + engineType + cloned params', () => {
    const params = { ...SynthEngine.DEFAULT_PARAMS, filterCutoff: 1234 };
    const preset = makePreset('synth', params);
    expect(preset.schemaVersion).toBe(PRESET_SCHEMA_VERSION);
    expect(preset.engineType).toBe('synth');
    expect((preset.params as typeof params).filterCutoff).toBe(1234);
  });

  it('clones params (mutating the input does not affect the preset)', () => {
    const params = { ...SynthEngine.DEFAULT_PARAMS };
    const preset = makePreset('synth', params);
    params.filterCutoff = 9999;
    expect((preset.params as typeof params).filterCutoff).toBe(SynthEngine.DEFAULT_PARAMS.filterCutoff);
  });
});

describe('preset — serialize/deserialize round-trip', () => {
  it('round-trips a synth preset', () => {
    const params = { ...SynthEngine.DEFAULT_PARAMS, filterCutoff: 1500, mode: 'poly' as const };
    const preset = makePreset('synth', params);
    const json = serializePreset(preset);
    const restored = deserializePreset(json);
    expect(restored.engineType).toBe('synth');
    expect((restored.params as typeof params).filterCutoff).toBe(1500);
    expect((restored.params as typeof params).mode).toBe('poly');
  });

  it('round-trips a kick preset', () => {
    const params = { ...KickEngine.DEFAULT_PARAMS, tune: 42 };
    const preset = makePreset('kick', params);
    const restored = deserializePreset(serializePreset(preset));
    expect(restored.engineType).toBe('kick');
    expect((restored.params as typeof params).tune).toBe(42);
  });

  it('fills missing fields from engine DEFAULT_PARAMS (forward-compat)', () => {
    const partial = JSON.stringify({
      schemaVersion: 1,
      engineType: 'synth',
      params: { filterCutoff: 1200 },
    });
    const restored = deserializePreset(partial);
    expect((restored.params as any).filterCutoff).toBe(1200);
    expect((restored.params as any).osc1Type).toBe(SynthEngine.DEFAULT_PARAMS.osc1Type);
    expect((restored.params as any).mode).toBe(SynthEngine.DEFAULT_PARAMS.mode);
  });

  it('throws on malformed JSON', () => {
    expect(() => deserializePreset('{ not json')).toThrow();
  });

  it('throws on unknown engineType', () => {
    const bad = JSON.stringify({ schemaVersion: 1, engineType: 'theremin', params: {} });
    expect(() => deserializePreset(bad)).toThrow();
  });
});

describe('preset — applyPresetDraft', () => {
  it('does not mutate the track (pure draft producer)', () => {
    const track = freshTrack();
    expect(track.engineType).toBe('synth');
    applyPresetDraft(track, makePreset('synth', { ...SynthEngine.DEFAULT_PARAMS, filterCutoff: 4444 }));
    expect(track.engineType).toBe('synth'); // engineType is dispatched separately by the caller
    expect(track.engines.synth.filterCutoff).toBe(SynthEngine.DEFAULT_PARAMS.filterCutoff);
  });

  it('returns the matching engine slice with the preset params merged over the live clone', () => {
    const track = freshTrack();
    track.engines.kick.tune = 88;
    track.engines.synth.filterCutoff = 1111;

    const draft = applyPresetDraft(track, makePreset('kick', { ...KickEngine.DEFAULT_PARAMS, tune: 22 }));
    expect((draft as { tune: number }).tune).toBe(22);
    // other engine slices on the track are untouched (the draft is scoped to
    // the preset's engineType only)
    expect(track.engines.synth.filterCutoff).toBe(1111);
  });

  it('does not touch mixer or steps', () => {
    const track = freshTrack();
    track.mixer.volume = 0.42;
    track.steps[0].note = 'C';

    applyPresetDraft(track, makePreset('hat', { decay: 0.99, tone: 5000, metallic: 0.1 } as any));
    expect(track.mixer.volume).toBe(0.42);
    expect(track.steps[0].note).toBe('C');
  });
});

describe('preset — resetEnginePatchDraft', () => {
  it('returns the active engine params reset to DEFAULT_PARAMS', () => {
    const track = freshTrack();
    track.engines.synth.filterCutoff = 1234;
    track.engines.synth.mode = 'poly';
    const draft = resetEnginePatchDraft(track) as { filterCutoff: number; mode: string };
    expect(draft.filterCutoff).toBe(SynthEngine.DEFAULT_PARAMS.filterCutoff);
    expect(draft.mode).toBe(SynthEngine.DEFAULT_PARAMS.mode);
  });

  it('does not mutate the track (pure draft producer)', () => {
    const track = freshTrack();
    track.engineType = 'kick';
    track.engines.kick.tune = 99;
    resetEnginePatchDraft(track);
    expect(track.engineType).toBe('kick');
    expect(track.engines.kick.tune).toBe(99);
  });

  it('leaves other engines on the track untouched (dense-model preservation)', () => {
    const track = freshTrack();
    track.engineType = 'synth';
    track.engines.synth.filterCutoff = 1234;
    track.engines.kick.tune = 88;
    resetEnginePatchDraft(track);
    expect(track.engines.kick.tune).toBe(88);
  });

  it('does not touch mixer or steps', () => {
    const track = freshTrack();
    track.mixer.volume = 0.42;
    track.steps[0].note = 'C';
    track.engines.synth.filterCutoff = 1234;
    resetEnginePatchDraft(track);
    expect(track.mixer.volume).toBe(0.42);
    expect(track.steps[0].note).toBe('C');
  });
});
