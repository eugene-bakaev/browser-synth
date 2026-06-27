import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { TRACK_POOL_SIZE } from '@fiddle/shared';
import { freshProject } from '../project';
import { useProjectStore, __resetProjectStoreForTest } from './project';

describe('useProjectStore', () => {
  beforeEach(() => {
    // The canonical project is now a module-scope singleton, so a fresh Pinia
    // alone no longer resets its state — reset the shared instance explicitly.
    __resetProjectStoreForTest();
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

  it('exposes ONE module-scope canonical instance shared across Pinia instances', () => {
    const a = useProjectStore();
    a.project.bpm = 151;
    setActivePinia(createPinia()); // a brand-new Pinia → a new store wrapper
    const b = useProjectStore();
    expect(b.project).toBe(a.project); // same underlying canonical object
    expect(b.project.bpm).toBe(151);   // shared state, not a fresh copy
  });

  it('__resetProjectStoreForTest restores a fresh project in place', () => {
    const store = useProjectStore();
    store.project.bpm = 200;
    __resetProjectStoreForTest();
    expect(store.project.bpm).toBe(freshProject().bpm);
    expect(store.project.tracks.length).toBe(TRACK_POOL_SIZE);
  });
});
