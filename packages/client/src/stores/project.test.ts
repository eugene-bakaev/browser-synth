import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { TRACK_POOL_SIZE } from '@fiddle/shared';
import { freshProject } from '../project';
import { useProjectStore } from './project';

describe('useProjectStore', () => {
  beforeEach(() => {
    // One fresh Pinia per test — the isolation pattern that replaces the
    // resetModules()/disposeSynth() dance used by the legacy useSynth tests.
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
});
