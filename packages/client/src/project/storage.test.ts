import { describe, it, expect, vi } from 'vitest';
import { reactive, watch, nextTick } from 'vue';
import { serializeProject, deserializeProject, replaceProject, reconcileWithDefaults } from './storage';
import { freshProject } from './factory';
import { PROJECT_SCHEMA_VERSION } from './types';
import { TRACK_POOL_SIZE } from '@fiddle/shared';

describe('serializeProject', () => {
  it('produces JSON identical to JSON.stringify(toRaw(project))', () => {
    const p = freshProject();
    p.bpm = 144;
    p.tracks[0].engines.synth.filterCutoff = 1234;
    const json = serializeProject(p);
    const parsed = JSON.parse(json);
    expect(parsed.bpm).toBe(144);
    expect(parsed.tracks[0].engines.synth.filterCutoff).toBe(1234);
    expect(parsed.schemaVersion).toBe(2);
  });

  it('strips Vue reactive proxies (uses toRaw under the hood)', () => {
    const p = reactive(freshProject());
    p.bpm = 100;
    const json = serializeProject(p);
    // If we hadn't called toRaw, JSON.stringify could leak proxy metadata or
    // throw on circular reactive structures. Spot-check the output is plain.
    const parsed = JSON.parse(json);
    expect(parsed.bpm).toBe(100);
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  });
});

describe('deserializeProject', () => {
  it('round-trips through serializeProject', () => {
    const p = freshProject();
    p.bpm = 99;
    p.tracks[1].engines.kick.tune = 70;
    const restored = deserializeProject(serializeProject(p));
    expect(restored.bpm).toBe(99);
    expect(restored.tracks[1].engines.kick.tune).toBe(70);
  });

  it('fills missing fields via the reconciler', () => {
    const partial = JSON.stringify({
      schemaVersion: 1,
      bpm: 130,
      tracks: [{}, {}, {}, {}],
    });
    const restored = deserializeProject(partial);
    expect(restored.tracks[0].engines.synth).toBeDefined();
    expect(restored.tracks[0].steps).toHaveLength(64);
  });

  it('returns freshProject (with warn) on malformed JSON', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const restored = deserializeProject('{not json');
    expect(restored.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('throws for an unknown future schemaVersion', () => {
    const future = JSON.stringify({ schemaVersion: 99, bpm: 100, tracks: [] });
    expect(() => deserializeProject(future)).toThrowError(/Unknown project schemaVersion: 99/);
  });
});

describe('replaceProject', () => {
  it('preserves the target reactive proxy identity (=== before and after)', () => {
    const target = reactive(freshProject());
    const targetTrack0 = target.tracks[0];
    const targetEngines0Synth = target.tracks[0].engines.synth;
    const targetMixer0 = target.tracks[0].mixer;
    const targetStep0 = target.tracks[0].steps[0];

    const source = freshProject();
    source.bpm = 99;
    source.tracks[0].engines.synth.filterCutoff = 4321;

    replaceProject(target, source);

    expect(target.tracks[0]).toBe(targetTrack0);
    expect(target.tracks[0].engines.synth).toBe(targetEngines0Synth);
    expect(target.tracks[0].mixer).toBe(targetMixer0);
    expect(target.tracks[0].steps[0]).toBe(targetStep0);
  });

  it('mutates top-level fields (schemaVersion, bpm)', () => {
    const target = reactive(freshProject());
    const source = freshProject();
    source.bpm = 77;
    replaceProject(target, source);
    expect(target.bpm).toBe(77);
    expect(target.schemaVersion).toBe(2);
  });

  it('mutates engine slot fields without rebinding the slot object', () => {
    const target = reactive(freshProject());
    const synthRef = target.tracks[0].engines.synth;
    const source = freshProject();
    source.tracks[0].engines.synth.filterCutoff = 1234;
    replaceProject(target, source);
    expect(target.tracks[0].engines.synth).toBe(synthRef);
    expect(target.tracks[0].engines.synth.filterCutoff).toBe(1234);
  });

  it('mutates mixer + engineType per track', () => {
    const target = reactive(freshProject());
    const source = freshProject();
    source.tracks[2].engineType = 'kick';
    source.tracks[2].mixer.volume = 0.25;
    replaceProject(target, source);
    expect(target.tracks[2].engineType).toBe('kick');
    expect(target.tracks[2].mixer.volume).toBe(0.25);
  });

  it('mutates each step in place (preserves step proxy identity)', () => {
    const target = reactive(freshProject());
    const step5Ref = target.tracks[0].steps[5];
    const source = freshProject();
    source.tracks[0].steps[5].note = 'C';
    source.tracks[0].steps[5].velocity = 0.42;
    replaceProject(target, source);
    expect(target.tracks[0].steps[5]).toBe(step5Ref);
    expect(target.tracks[0].steps[5].note).toBe('C');
    expect(target.tracks[0].steps[5].velocity).toBe(0.42);
  });

  it('fires the deep watcher (Vue picks up the mutations)', async () => {
    const target = reactive(freshProject());
    const fired = vi.fn();
    watch(target, fired, { deep: true });

    const source = freshProject();
    source.bpm = 88;
    replaceProject(target, source);

    await nextTick();
    expect(fired).toHaveBeenCalled();
  });

  it('replaceProject copies trackOrder in place (array identity preserved)', () => {
    const target = freshProject();
    const before = target.trackOrder;
    const source = freshProject();
    source.trackOrder = [...source.trackOrder].reverse();
    replaceProject(target, source);
    expect(target.trackOrder).toEqual(source.trackOrder);
    expect(target.trackOrder).toBe(before); // same array object, contents replaced
  });
});

describe('reconcileWithDefaults — legacy playMode compat', () => {
  it('translates track.playMode === "chord" into track.engines.synth.mode === "poly"', () => {
    const legacy = {
      schemaVersion: 1,
      bpm: 120,
      tracks: [
        { playMode: 'chord' },
        { playMode: 'mono' },
        { playMode: 'chord' },
        {},  // no playMode at all
      ],
    };
    const out = reconcileWithDefaults(legacy);
    expect(out.tracks[0].engines.synth.mode).toBe('poly');
    expect(out.tracks[1].engines.synth.mode).toBe('mono');
    expect(out.tracks[2].engines.synth.mode).toBe('poly');
    expect(out.tracks[3].engines.synth.mode).toBe('mono');
  });

  it('drops the legacy playMode field from the reconciled track', () => {
    const legacy = {
      schemaVersion: 1,
      tracks: [{ playMode: 'chord' }, {}, {}, {}],
    };
    const out = reconcileWithDefaults(legacy) as unknown as { tracks: any[] };
    expect('playMode' in out.tracks[0]).toBe(false);
  });
});

describe('reconcileWithDefaults — synth2 mode heal', () => {
  it('heals a synth2 slice missing mode to mono', () => {
    const loaded = {
      schemaVersion: 2,
      bpm: 120,
      tracks: [{ engineType: 'synth2', engines: { synth2: { osc1: { morph: 1 } } } }],
    };
    const out = reconcileWithDefaults(loaded);
    expect(out.tracks[0].engines.synth2.mode).toBe('mono');
  });
});

describe('track pool reconcile', () => {
  it('reconcileWithDefaults pads a 4-track save to 32 slots, first 4 enabled', () => {
    const legacy = { schemaVersion: 2, bpm: 120, tracks: [{}, {}, {}, {}] };
    const out = reconcileWithDefaults(legacy);
    expect(out.tracks).toHaveLength(TRACK_POOL_SIZE);
    expect(out.tracks.slice(0, 4).every(t => t.enabled)).toBe(true);
    expect(out.tracks.slice(4).every(t => t.enabled === false)).toBe(true);
  });

  it('replaceProject copies enabled across all slots', () => {
    const target = freshProject();
    const source = freshProject();
    source.tracks[4].enabled = true;   // an added track
    source.tracks[0].enabled = false;  // a removed default
    replaceProject(target, source);
    expect(target.tracks[4].enabled).toBe(true);
    expect(target.tracks[0].enabled).toBe(false);
  });
});

describe('track name at the offline boundary', () => {
  it('reconcileWithDefaults fills a missing name with the empty string', () => {
    const p = freshProject();
    delete (p.tracks[0] as { name?: string }).name;
    const out = reconcileWithDefaults(JSON.parse(JSON.stringify(p)));
    expect(out.tracks[0].name).toBe('');
  });

  it('reconcileWithDefaults keeps a stored name', () => {
    const p = freshProject();
    p.tracks[1].name = 'Bassline';
    const out = reconcileWithDefaults(JSON.parse(JSON.stringify(p)));
    expect(out.tracks[1].name).toBe('Bassline');
  });

  it('replaceProject copies name across slots', () => {
    const target = freshProject();
    const source = freshProject();
    source.tracks[3].name = 'Perc';
    replaceProject(target, source);
    expect(target.tracks[3].name).toBe('Perc');
    expect(target.tracks[0].name).toBe('');
  });
});
