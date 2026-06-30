import { describe, it, expect, beforeEach } from 'vitest';
import { project } from '../stores/project';
import { replaceProject } from '../project/storage';
import { freshProject } from '../project/factory';
import { dispatchLocal } from '../composables/useSynth';
import { useCommandModel } from './commandModel';

describe('dispatchLocal (pre-connection fallback)', () => {
  beforeEach(() => { replaceProject(project, freshProject()); });

  it('writes straight to the canonical project when no bus is connected', () => {
    dispatchLocal(['bpm'], 137);
    expect(project.bpm).toBe(137);
  });

  it('writes a nested leaf', () => {
    dispatchLocal(['tracks', 0, 'patternLength'], 32);
    expect(project.tracks[0].patternLength).toBe(32);
  });
});

describe('useCommandModel', () => {
  beforeEach(() => { replaceProject(project, freshProject()); });

  it('reads the live value from the project', () => {
    const m = useCommandModel<number>(['bpm']);
    expect(m.value).toBe(project.bpm);
  });

  it('writes through dispatchLocal (no direct mutation needed)', () => {
    const m = useCommandModel<number>(['tracks', 0, 'patternLength']);
    m.value = 16;
    expect(project.tracks[0].patternLength).toBe(16);
  });

  it('accepts a lazy path thunk (for loop-bound bindings)', () => {
    let idx = 0;
    const m = useCommandModel<number>(() => ['tracks', idx, 'patternLength']);
    idx = 3;
    m.value = 8;
    expect(project.tracks[3].patternLength).toBe(8);
  });
});
