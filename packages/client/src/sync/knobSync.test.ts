import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { ref } from 'vue';

// Partial mock of 'vue' so that inject() is interceptable inside knobSync.
// vi.spyOn(vue, 'inject') doesn't work in ESM (module namespace is non-configurable).
vi.mock('vue', async (orig) => {
  const actual = await orig<typeof import('vue')>();
  return { ...actual, inject: vi.fn() };
});

import * as vue from 'vue';
import { useKnobSync, ACTIVE_TRACK_KEY } from './knobSync';
import { SYNTH_CONTEXT } from '../app/synthContext';

// A minimal fake synth context: knobSync only touches dispatchLocal / endGesture.
const dispatchLocal = vi.fn();
const endGesture = vi.fn();
const fakeSynth = { dispatchLocal, endGesture } as unknown as ReturnType<
  typeof import('../app/synthContext').createSynthContext
>;

// Helper: run useKnobSync with a chosen active-track ref + the fake context by
// faking Vue inject for both keys knobSync reads.
function withActiveTrack<T>(idx: number | null, run: () => T): T {
  (vue.inject as Mock).mockImplementation((key: unknown, def?: unknown) => {
    if (key === ACTIVE_TRACK_KEY) return ref(idx);
    if (key === SYNTH_CONTEXT) return fakeSynth;
    return def;
  });
  try { return run(); } finally { (vue.inject as Mock).mockReset(); }
}

describe('useKnobSync set', () => {
  beforeEach(() => { dispatchLocal.mockClear(); endGesture.mockClear(); });

  it('set() dispatches to the full wire path for the active track', () => {
    const ks = withActiveTrack(2, () => useKnobSync('synth2'));
    ks.set(['env1', 'loop'], true);
    expect(dispatchLocal).toHaveBeenCalledWith(['tracks', 2, 'engines', 'synth2', 'env1', 'loop'], true);
  });

  it('set() dispatches a scalar field for the active track', () => {
    const ks = withActiveTrack(0, () => useKnobSync('kick2'));
    ks.set('tune', 88);
    expect(dispatchLocal).toHaveBeenCalledWith(['tracks', 0, 'engines', 'kick2', 'tune'], 88);
  });

  it('set() is a no-op when there is no active track', () => {
    const ks = withActiveTrack(null, () => useKnobSync('synth2'));
    ks.set('mode', 'poly');
    expect(dispatchLocal).not.toHaveBeenCalled();
  });

  it('end() flushes the full wire path via endGesture for the active track', () => {
    const ks = withActiveTrack(1, () => useKnobSync('synth'));
    ks.end('filterCutoff');
    expect(endGesture).toHaveBeenCalledWith(['tracks', 1, 'engines', 'synth', 'filterCutoff']);
  });

  it('end() is a no-op when there is no active track', () => {
    const ks = withActiveTrack(null, () => useKnobSync('synth'));
    ks.end('filterCutoff');
    expect(endGesture).not.toHaveBeenCalled();
  });
});
