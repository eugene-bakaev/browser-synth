import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { ref } from 'vue';

// Stub the module the composable writes through, so we assert the path/value
// without a live command bus. (knobSync imports dispatchLocal from useSynth.)
vi.mock('../composables/useSynth', () => ({
  dispatchLocal: vi.fn(),
  endGesture: vi.fn(),
}));

// Partial mock of 'vue' so that inject() is interceptable inside knobSync.
// vi.spyOn(vue, 'inject') doesn't work in ESM (module namespace is non-configurable).
vi.mock('vue', async (orig) => {
  const actual = await orig<typeof import('vue')>();
  return { ...actual, inject: vi.fn() };
});

import * as vue from 'vue';
import { dispatchLocal } from '../composables/useSynth';
import { useKnobSync, ACTIVE_TRACK_KEY } from './knobSync';

// Helper: run useKnobSync with a chosen active-track ref by faking Vue inject.
function withActiveTrack<T>(idx: number | null, run: () => T): T {
  (vue.inject as Mock).mockImplementation((key: unknown, def?: unknown) => {
    if (key === ACTIVE_TRACK_KEY) return ref(idx);
    return def;
  });
  try { return run(); } finally { (vue.inject as Mock).mockReset(); }
}

describe('useKnobSync set', () => {
  beforeEach(() => { (dispatchLocal as unknown as ReturnType<typeof vi.fn>).mockClear(); });

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
});
