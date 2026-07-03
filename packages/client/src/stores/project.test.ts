import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { TRACK_POOL_SIZE } from '@fiddle/shared';
import { freshProject } from '../project';
import { useProjectStore } from './project';

describe('useProjectStore', () => {
  beforeEach(() => {
    // Phase 5: the canonical project is created inside the setup store, so a
    // fresh Pinia genuinely isolates state — no module-reset gymnastics.
    setActivePinia(createPinia());
  });

  it('starts holding a fresh project with the full track pool', () => {
    const store = useProjectStore();
    expect(store.project.tracks.length).toBe(TRACK_POOL_SIZE);
  });

  it('enabledTrackCount counts only enabled slots (4 on a fresh project)', () => {
    const store = useProjectStore();
    expect(store.enabledTrackCount).toBe(4);
  });

  it('getTrack returns the slot at the given index', () => {
    const store = useProjectStore();
    expect(store.getTrack(0)).toBe(store.project.tracks[0]);
  });

  it('loadProject replaces contents in place (stable .project identity)', () => {
    const store = useProjectStore();
    const before = store.project;
    const next = freshProject();
    next.bpm = 137;
    store.loadProject(next);
    expect(store.project).toBe(before); // same object — replaced in place
    expect(store.project.bpm).toBe(137);
  });

  it('a fresh Pinia mints an isolated project instance', () => {
    const a = useProjectStore();
    a.project.bpm = 151;
    setActivePinia(createPinia()); // a brand-new Pinia → a fresh store + project
    const b = useProjectStore();
    expect(b.project).not.toBe(a.project); // per-Pinia instance
    expect(b.project.bpm).toBe(freshProject().bpm); // isolated, not the mutated 151
  });

  it('bpm selector reflects project.bpm and updates after a mutation', () => {
    const store = useProjectStore();
    expect(store.bpm).toBe(store.project.bpm);
    store.project.bpm = 99;
    expect(store.bpm).toBe(99);
  });

  it('getTrackEngineType returns the engineType of the slot at index', () => {
    const store = useProjectStore();
    expect(store.getTrackEngineType(0)).toBe(store.project.tracks[0].engineType);
  });

  it('applySet writes a top-level leaf (bpm)', () => {
    const store = useProjectStore();
    store.applySet(['bpm'], 140);
    expect(store.project.bpm).toBe(140);
  });

  it('applySet writes a deep engine-param path in place', () => {
    const store = useProjectStore();
    const before = store.project;
    store.applySet(['tracks', 0, 'engines', 'synth', 'filterCutoff'], 1234);
    expect(store.project.tracks[0].engines.synth.filterCutoff).toBe(1234);
    expect(store.project).toBe(before); // mutates in place, identity stable
  });

  it('applySet writes an engineType change', () => {
    const store = useProjectStore();
    store.applySet(['tracks', 2, 'engineType'], 'kick2');
    expect(store.project.tracks[2].engineType).toBe('kick2');
  });
});
