// projectOps — every bulk project operation as pure draft-diff-dispatch.
//
// Each op computes a DRAFT of the post-op state (the pure helpers in
// project/mutations + project/preset), diffs it against live state, and
// dispatches each changed leaf through the CommandBus — the bus performs the
// actual write (and the outbound enqueue, and the audio-stream emit). Nothing
// here mutates `project` directly, which is what makes "state has exactly one
// writer" literally true.
//
// Exception: New/Open replace the whole project via bus.loadProject (one
// `replace` audio event), then enqueue the outbound leaf diff of live-vs-before
// — identical wire behavior to the old syncWholeProjectDiff.

import { toRaw } from 'vue';
import { TRACK_POOL_SIZE, type Path, type Project } from '@fiddle/shared';
import type { EngineType, Preset } from '../project';
import {
  clearTrackDraft, shiftTrackDraft, fillTrackDraft,
  applyPresetDraft, resetEnginePatchDraft, freshProject,
} from '../project';
import { diffParams, cloneEngineSlice } from '../project/paramDiff';
import { gestureEndForLeaf } from '../sync/dispatchPolicy';

// Local copy of the engine-slice key list (same duplication as preset.ts /
// storage.ts / normalize.ts / AudioEngine.ts; DRY-ing them is a separate cleanup).
const ENGINE_SLICES: EngineType[] = ['synth', 'kick', 'hat', 'snare', 'clap', 'synth2', 'kick2', 'snare2', 'hat2', 'clap2'];

export interface ProjectOpsDeps {
  project: Project;
  bus: {
    dispatchLocal(cmd: { path: Path; value: unknown; priorValue?: unknown; gestureEnd?: boolean }): void;
    loadProject(next: Project): void;
  };
  /** Outbound gate — mirrors the old emitters' `isSyncLive` guard. */
  isSyncLive: () => boolean;
  /** Outbound-only enqueue for the whole-project (New/Open) diff. */
  enqueue: (path: Path, value: unknown, priorValue: unknown, gestureEnd: boolean) => void;
  /** Bulk-load availability (live room + server capability). */
  canBulkLoad: () => boolean;
  /** Atomic whole-project send; `prior` is the pre-load clone for rollback. */
  sendLoad: (project: Project, prior: Project) => void;
}

export interface ProjectSyncSnapshot {
  bpm: number;
  tracks: {
    engineType: string; patternLength: number; enabled: boolean;
    mixer: Record<string, unknown>;
    steps: Record<string, unknown>[];
    engines: Record<string, Record<string, unknown>>;
  }[];
}

export function createProjectOps(deps: ProjectOpsDeps) {
  const { project, bus } = deps;

  const dispatch = (path: Path, value: unknown, priorValue: unknown): void => {
    bus.dispatchLocal({ path, value, priorValue, gestureEnd: gestureEndForLeaf(String(path[path.length - 1])) });
  };

  // Diff draft vs live at `prefix` and dispatch each changed leaf. Nested
  // objects are drilled one level (the accept-list forbids whole-object
  // writes); arrays (synth2.matrix) are skipped here and drilled per-slot by
  // dispatchMatrixDiff. Priors come from live (pre-write) state.
  function dispatchDiff(
    prefix: Path,
    draft: Record<string, unknown>,
    live: Record<string, unknown>,
  ): void {
    const changed = diffParams(draft, live);
    if (!changed) return;
    for (const [key, value] of Object.entries(changed)) {
      if (Array.isArray(value)) continue;
      if (value !== null && typeof value === 'object') {
        const liveNested = (live[key] ?? {}) as Record<string, unknown>;
        const draftNested = value as Record<string, unknown>;
        for (const subKey of Object.keys(draftNested)) {
          if (liveNested[subKey] === draftNested[subKey]) continue;
          dispatch([...prefix, key, subKey], draftNested[subKey], liveNested[subKey]);
        }
      } else {
        dispatch([...prefix, key], value, live[key]);
      }
    }
  }

  // synth2 mod matrix: per-slot per-field leaf dispatches (arrays are skipped
  // by dispatchDiff so a whole-slot object write can never be emitted).
  function dispatchMatrixDiff(
    trackIdx: number,
    draft: Record<string, unknown>,
    live: Record<string, unknown>,
  ): void {
    const draftM = (draft as { matrix?: Record<string, unknown>[] }).matrix;
    const liveM = (live as { matrix?: Record<string, unknown>[] }).matrix;
    if (!draftM || !liveM) return;
    for (let s = 0; s < draftM.length; s++) {
      for (const field of ['source', 'dest', 'amount'] as const) {
        const d = draftM[s]?.[field]; const l = liveM[s]?.[field];
        if (d === l) continue;
        dispatch(['tracks', trackIdx, 'engines', 'synth2', 'matrix', s, field], d, l);
      }
    }
  }

  function dispatchStepsWindow(trackId: number, draft: readonly Record<string, unknown>[]): void {
    const live = project.tracks[trackId].steps;
    for (let j = 0; j < draft.length; j++) {
      dispatchDiff(
        ['tracks', trackId, 'steps', j],
        draft[j],
        live[j] as unknown as Record<string, unknown>,
      );
    }
  }

  // ---- whole-project outbound diff (New/Open) — moved from useSynth ----

  function snapshotProjectForSync(): ProjectSyncSnapshot {
    return {
      bpm: project.bpm,
      tracks: project.tracks.map((t) => ({
        engineType: t.engineType,
        patternLength: t.patternLength,
        enabled: t.enabled,
        mixer: { ...t.mixer } as unknown as Record<string, unknown>,
        steps: t.steps.map((s) => ({ ...s }) as unknown as Record<string, unknown>),
        engines: Object.fromEntries(
          ENGINE_SLICES.map((slice) => [
            slice,
            cloneEngineSlice(t.engines[slice] as unknown as Record<string, unknown>),
          ]),
        ),
      })),
    };
  }

  // Enqueue-only leaf diff (state is already replaced wholesale by loadProject;
  // re-dispatching would be thousands of redundant writes — see the spec).
  function enqueueLeafDiff(
    prefix: Path,
    changed: Record<string, unknown>,
    oldObj: Record<string, unknown> | undefined,
  ): void {
    for (const [key, value] of Object.entries(changed)) {
      if (Array.isArray(value)) continue;
      if (value !== null && typeof value === 'object') {
        const oldNested = (oldObj?.[key] ?? {}) as Record<string, unknown>;
        const newNested = value as Record<string, unknown>;
        for (const subKey of Object.keys(newNested)) {
          if (oldNested[subKey] === newNested[subKey]) continue;
          deps.enqueue([...prefix, key, subKey], newNested[subKey], oldNested[subKey], gestureEndForLeaf(subKey));
        }
      } else {
        deps.enqueue([...prefix, key], value, oldObj?.[key], gestureEndForLeaf(key));
      }
    }
  }

  function enqueueMatrixDiff(
    trackIdx: number,
    newSlice: Record<string, unknown>,
    oldSlice: Record<string, unknown>,
  ): void {
    const newM = (newSlice as { matrix?: Record<string, unknown>[] }).matrix;
    const oldM = (oldSlice as { matrix?: Record<string, unknown>[] }).matrix;
    if (!newM || !oldM) return;
    for (let s = 0; s < newM.length; s++) {
      for (const field of ['source', 'dest', 'amount'] as const) {
        const a = newM[s]?.[field]; const o = oldM[s]?.[field];
        if (a === o) continue;
        deps.enqueue(['tracks', trackIdx, 'engines', 'synth2', 'matrix', s, field], a, o, gestureEndForLeaf(field));
      }
    }
  }

  function enqueueWholeProjectDiff(before: ProjectSyncSnapshot): void {
    if (project.bpm !== before.bpm) deps.enqueue(['bpm'], project.bpm, before.bpm, gestureEndForLeaf('bpm'));
    for (let i = 0; i < TRACK_POOL_SIZE; i++) {
      const t = project.tracks[i]; const b = before.tracks[i];
      const headNew = { engineType: t.engineType, patternLength: t.patternLength, enabled: t.enabled } as Record<string, unknown>;
      const headOld = { engineType: b.engineType, patternLength: b.patternLength, enabled: b.enabled } as Record<string, unknown>;
      const headChanged = diffParams(headNew, headOld);
      if (headChanged) enqueueLeafDiff(['tracks', i], headChanged, headOld);
      const mixChanged = diffParams(t.mixer as unknown as Record<string, unknown>, b.mixer);
      if (mixChanged) enqueueLeafDiff(['tracks', i, 'mixer'], mixChanged, b.mixer);
      for (let j = 0; j < t.steps.length; j++) {
        const sc = diffParams(t.steps[j] as unknown as Record<string, unknown>, b.steps[j]);
        if (sc) enqueueLeafDiff(['tracks', i, 'steps', j], sc, b.steps[j]);
      }
      for (const slice of ENGINE_SLICES) {
        const ec = diffParams(t.engines[slice] as unknown as Record<string, unknown>, b.engines[slice]);
        if (ec) enqueueLeafDiff(['tracks', i, 'engines', slice], ec, b.engines[slice]);
      }
      enqueueMatrixDiff(i, t.engines.synth2 as unknown as Record<string, unknown>, b.engines.synth2);
    }
  }

  function loadAndSyncWholeProject(next: Project): void {
    const live = deps.isSyncLive();
    const bulk = live && deps.canBulkLoad();
    // prior = full-Project deep clone of pre-load live state, for nack/timeout
    // rollback. toRaw strips Vue proxies (same pattern as serializeProject).
    const prior = bulk ? (structuredClone(toRaw(project)) as Project) : null;
    const before = live && !bulk ? snapshotProjectForSync() : null;
    bus.loadProject(next);
    if (bulk) deps.sendLoad(next, prior!);            // one atomic message
    else if (before) enqueueWholeProjectDiff(before); // fallback: old servers
    // offline/solo (neither): unchanged local-only behavior
  }

  // ---- the public ops ----

  return {
    clearTrack(trackId: number): void {
      dispatchStepsWindow(trackId, clearTrackDraft(project.tracks[trackId].patternLength) as unknown as Record<string, unknown>[]);
    },
    shiftTrack(trackId: number, direction: 'left' | 'right'): void {
      const t = project.tracks[trackId];
      dispatchStepsWindow(trackId, shiftTrackDraft(t.steps, direction, t.patternLength) as unknown as Record<string, unknown>[]);
    },
    fillTrack(trackId: number, interval: number): void {
      const t = project.tracks[trackId];
      dispatchStepsWindow(trackId, fillTrackDraft(t.steps, interval, t.patternLength) as unknown as Record<string, unknown>[]);
    },
    applyPreset(trackId: number, preset: Preset): void {
      const t = project.tracks[trackId];
      // engineType FIRST so the swap syncs with the correct prior (the OLD engine);
      // the draft depends only on the slice, so ordering is safe.
      dispatch(['tracks', trackId, 'engineType'], preset.engineType, t.engineType);
      const live = t.engines[preset.engineType] as unknown as Record<string, unknown>;
      const draft = applyPresetDraft(t, preset);
      dispatchDiff(['tracks', trackId, 'engines', preset.engineType], draft, live);
      if (preset.engineType === 'synth2') dispatchMatrixDiff(trackId, draft, live);
    },
    initPatch(trackId: number): void {
      const t = project.tracks[trackId];
      const live = t.engines[t.engineType] as unknown as Record<string, unknown>;
      const draft = resetEnginePatchDraft(t);
      dispatchDiff(['tracks', trackId, 'engines', t.engineType], draft, live);
      if (t.engineType === 'synth2') dispatchMatrixDiff(trackId, draft, live);
    },
    newProject(): void { loadAndSyncWholeProject(freshProject()); },
    openProject(loaded: Project): void { loadAndSyncWholeProject(loaded); },
  };
}

export type ProjectOps = ReturnType<typeof createProjectOps>;
