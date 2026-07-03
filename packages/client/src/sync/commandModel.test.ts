import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { reactive } from 'vue';
import { freshProject, type Project } from '../project';

// Partial mock of 'vue' so inject() is interceptable inside useCommandModel.
// (Same ESM-safe pattern as knobSync.test.)
vi.mock('vue', async (orig) => {
  const actual = await orig<typeof import('vue')>();
  return { ...actual, inject: vi.fn() };
});

import * as vue from 'vue';
import { useCommandModel } from './commandModel';
import { SYNTH_CONTEXT } from '../app/synthContext';

describe('useCommandModel', () => {
  let project: Project;
  let dispatchLocal: Mock;

  beforeEach(() => {
    project = reactive(freshProject()) as Project;
    dispatchLocal = vi.fn();
    // Minimal fake context: useCommandModel only reads .project and calls .dispatchLocal.
    const fakeSynth = { project, dispatchLocal, endGesture: vi.fn() };
    (vue.inject as Mock).mockImplementation((key: unknown) => (key === SYNTH_CONTEXT ? fakeSynth : undefined));
  });

  it('reads the live value from the project', () => {
    const m = useCommandModel<number>(['bpm']);
    expect(m.value).toBe(project.bpm);
  });

  it('writes through dispatchLocal with the resolved path + value', () => {
    const m = useCommandModel<number>(['tracks', 0, 'patternLength']);
    m.value = 16;
    expect(dispatchLocal).toHaveBeenCalledWith(['tracks', 0, 'patternLength'], 16);
  });

  it('accepts a lazy path thunk (for loop-bound bindings)', () => {
    let idx = 0;
    const m = useCommandModel<number>(() => ['tracks', idx, 'patternLength']);
    idx = 3;
    m.value = 8;
    expect(dispatchLocal).toHaveBeenCalledWith(['tracks', 3, 'patternLength'], 8);
  });
});
