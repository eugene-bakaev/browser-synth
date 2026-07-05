import { describe, it, expect, vi } from 'vitest';
import { reactive } from 'vue';
import { setDeep, type Path } from '@fiddle/shared';
import { freshProject, replaceProject, type Project } from '../project';
import { createProjectOps } from './projectOps';

// Fake bus: records dispatches AND actually writes (so live state advances the
// way the real bus's applySet does, and priors can be asserted against it).
// `canBulkLoad` defaults to false so pre-existing callers exercise the same
// leaf-diff fallback path as before the bulk-load capability existed (the bulk
// path itself is covered end-to-end in synthContext.test.ts).
function makeHarness(syncLive = true, canBulkLoad = false) {
  const project = reactive(freshProject()) as Project;
  const dispatched: { path: Path; value: unknown; priorValue: unknown; gestureEnd: boolean }[] = [];
  const enqueued: { path: Path; value: unknown; prior: unknown; gestureEnd: boolean }[] = [];
  const loadProjectSpy = vi.fn((next: Project) => replaceProject(project, next));
  const sendLoadSpy = vi.fn();
  const bus = {
    dispatchLocal(cmd: { path: Path; value: unknown; priorValue?: unknown; gestureEnd?: boolean }) {
      dispatched.push({ path: cmd.path, value: cmd.value, priorValue: cmd.priorValue, gestureEnd: cmd.gestureEnd ?? false });
      setDeep(project as unknown as Record<string, unknown>, cmd.path, cmd.value);
    },
    loadProject: loadProjectSpy,
  };
  const ops = createProjectOps({
    project,
    bus,
    isSyncLive: () => syncLive,
    enqueue: (path, value, prior, gestureEnd) => enqueued.push({ path, value, prior, gestureEnd }),
    canBulkLoad: () => canBulkLoad,
    sendLoad: sendLoadSpy,
  });
  return { project, ops, dispatched, enqueued, loadProjectSpy, sendLoadSpy };
}

describe('projectOps — steps window (Clear / Shift / Fill)', () => {
  it('clearTrack dispatches only the non-fresh leaves, with live priors, and writes state', () => {
    const { project, ops, dispatched } = makeHarness();
    project.tracks[0].steps[0].note = 'D';
    project.tracks[0].steps[0].velocity = 0.5;
    ops.clearTrack(0);
    expect(dispatched).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ['tracks', 0, 'steps', 0, 'note'], value: null, priorValue: 'D' }),
      expect.objectContaining({ path: ['tracks', 0, 'steps', 0, 'velocity'], value: 0.8, priorValue: 0.5 }),
    ]));
    expect(project.tracks[0].steps[0].note).toBeNull();
  });

  it('clearTrack on an already-fresh track dispatches nothing (C1 regression)', () => {
    const { ops, dispatched } = makeHarness();
    ops.clearTrack(0);
    expect(dispatched).toHaveLength(0);
  });

  it('clearTrack only touches the active window (steps beyond patternLength untouched)', () => {
    const { project, ops, dispatched } = makeHarness();
    project.tracks[0].patternLength = 4;
    project.tracks[0].steps[10].note = 'G';
    ops.clearTrack(0);
    expect(dispatched).toHaveLength(0);              // window 0..3 already fresh
    expect(project.tracks[0].steps[10].note).toBe('G');
  });

  it('shiftTrack left rotates the window via leaf dispatches', () => {
    const { project, ops } = makeHarness();
    project.tracks[0].patternLength = 4;
    project.tracks[0].steps[1].note = 'E';
    ops.shiftTrack(0, 'left');
    expect(project.tracks[0].steps[0].note).toBe('E');
    expect(project.tracks[0].steps[1].note).toBeNull();
  });

  it('fillTrack dispatches note/velocity/muted for the filled slots', () => {
    const { project, ops, dispatched } = makeHarness();
    project.tracks[0].patternLength = 4;
    ops.fillTrack(0, 2);
    expect(project.tracks[0].steps[0].note).toBe('C');
    expect(project.tracks[0].steps[2].note).toBe('C');
    expect(project.tracks[0].steps[1].note).toBeNull();
    expect(dispatched.some((d) => String(d.path[4]) === 'note' && d.value === 'C')).toBe(true);
  });
});

describe('projectOps — preset / init patch', () => {
  it('applyPreset dispatches engineType FIRST (discrete, old-engine prior), then only changed params', () => {
    const { project, ops, dispatched } = makeHarness();
    const defaultCutoff = project.tracks[0].engines.synth.filterCutoff;
    ops.applyPreset(0, {
      schemaVersion: 1,
      engineType: 'synth',
      params: { ...project.tracks[0].engines.synth, filterCutoff: 4242 },
    } as never);
    expect(dispatched[0]).toEqual(expect.objectContaining({
      path: ['tracks', 0, 'engineType'], value: 'synth', gestureEnd: true,
    }));
    const cutoffOp = dispatched.find((d) => String(d.path[4]) === 'filterCutoff');
    expect(cutoffOp).toEqual(expect.objectContaining({ value: 4242, priorValue: defaultCutoff }));
    // unchanged params produce no ops:
    expect(dispatched.filter((d) => d.path[2] === 'engines')).toHaveLength(1);
    expect(project.tracks[0].engines.synth.filterCutoff).toBe(4242);
  });

  it('applyPreset drills a synth2 matrix change to per-slot leaf ops (I3a)', () => {
    const { project, ops, dispatched } = makeHarness();
    const params = JSON.parse(JSON.stringify(project.tracks[0].engines.synth2));
    params.matrix = params.matrix.map((slot: Record<string, unknown>) => ({ ...slot }));
    params.matrix[0].amount = 0.77;
    ops.applyPreset(0, { schemaVersion: 1, engineType: 'synth2', params } as never);
    const matrixOps = dispatched.filter((d) => d.path[4] === 'matrix');
    expect(matrixOps).toEqual([expect.objectContaining({
      path: ['tracks', 0, 'engines', 'synth2', 'matrix', 0, 'amount'], value: 0.77,
    })]);
    // never a whole-slot or whole-matrix write:
    expect(dispatched.some((d) => d.path[4] === 'matrix' && d.path.length < 7)).toBe(false);
  });

  it('initPatch dispatches the edited params back to defaults', () => {
    const { project, ops, dispatched } = makeHarness();
    const defaultCutoff = project.tracks[0].engines.synth.filterCutoff;
    project.tracks[0].engines.synth.filterCutoff = 9999;
    ops.initPatch(0);
    expect(dispatched).toEqual([expect.objectContaining({
      path: ['tracks', 0, 'engines', 'synth', 'filterCutoff'], value: defaultCutoff, priorValue: 9999,
    })]);
  });
});

describe('projectOps — whole-project (New / Open)', () => {
  it('newProject loads a fresh project and enqueues the outbound diff of prior edits (M3)', () => {
    const { project, ops, enqueued, loadProjectSpy } = makeHarness();
    project.bpm = 155;
    project.tracks[0].steps[0].note = 'A';
    ops.newProject();
    expect(loadProjectSpy).toHaveBeenCalledTimes(1);
    expect(project.bpm).not.toBe(155);
    expect(enqueued.some((e) => e.path[0] === 'bpm' && e.prior === 155)).toBe(true);
    expect(enqueued.some((e) => String(e.path[4]) === 'note' && e.prior === 'A')).toBe(true);
  });

  it('newProject when sync is not live loads WITHOUT enqueueing anything', () => {
    const { project, ops, enqueued, loadProjectSpy } = makeHarness(false);
    project.bpm = 155;
    ops.newProject();
    expect(loadProjectSpy).toHaveBeenCalledTimes(1);
    expect(enqueued).toHaveLength(0);
  });

  it('openProject loads the given project and enqueues engine-param + matrix diffs (Open/New coverage)', () => {
    const { project, ops, enqueued } = makeHarness();
    const loaded = freshProject();
    loaded.tracks[0].engines.synth.filterCutoff = 1234;
    loaded.tracks[0].engines.synth2.matrix[0].amount = 0.42;
    ops.openProject(loaded);
    expect(project.tracks[0].engines.synth.filterCutoff).toBe(1234);
    expect(enqueued.some((e) => String(e.path[4]) === 'filterCutoff' && e.value === 1234)).toBe(true);
    expect(enqueued.some((e) => e.path[4] === 'matrix' && e.value === 0.42)).toBe(true);
  });
});
