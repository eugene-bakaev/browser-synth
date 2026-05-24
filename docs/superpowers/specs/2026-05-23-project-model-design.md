# Project Model Design — A3 + F1 (foundation + persistence)

**Branch:** `feature/project-model` (not merging to `main` until explicit approval)
**Date:** 2026-05-23
**Status:** Design approved, ready for implementation planning.
**Supersedes:** A3 and the persistence half of F1 in `docs/CODE_REVIEW.md`.

---

## 1. Goals & non-goals

### Goals (in scope for this branch)

- **A3:** Refactor `TrackState` into a single, tagged shape (`ProjectTrack`) where the active engine is discriminated by `engineType` and per-engine params live in a dense `engines` map.
- **Project model:** Introduce a `Project` type as the single source of truth for all user-state (tracks, bpm, steps, mixer, engine config). Pure JSON-serializable.
- **Persistence:** localStorage auto-save (debounced) + restore on page load. Single project doc, no picker.
- **Schema versioning:** `schemaVersion: 1` field + migration registry stub.
- **Sequencer refactor:** Sequencer becomes a pure ticker — drops `tracks`, `bpm`, and the `clearTrack`/`shiftTrack`/`fillTrack` helpers. Track-mutation helpers move to a new `src/project/mutations.ts` module.

### Non-goals (deferred to later branches)

- Named preset UI (save/load/rename per-engine snapshots).
- Multi-project picker UI (list, switch, rename, delete).
- Any networking code: WebSocket transport, sync protocol, presence, conflict resolution.
- Multi-user UX or session management.

### Design constraints (forward-looking, *not* implementation requirements)

The state shape must not paint us into a corner for future multi-user collaborative use:

- **JSON-serializable end-to-end** — no class instances in project state, no Vue proxies on the wire.
- **Diff-friendly** — every user-visible edit (knob turn, step toggle, engine swap, BPM change) should be a single-field JSON-Patch op against the project tree. Stable paths, no array shuffling.
- **Schema-versioned** — `schemaVersion` field on the project root so a future migration step can adapt old saves.
- **Strict project/runtime split** — playback state (`isPlaying`, `currentStep`), audio graph state, and per-user UI focus (`activeTrackIndex`) are NOT part of the project.

These constraints inform the shape decisions below. They do not require any networking code in this branch.

---

## 2. Type shapes

All types live in `src/project/types.ts`.

```ts
import type { SynthEngineParams } from '../engine/SynthEngine';
import type { KickEngineParams }  from '../engine/KickEngine';
import type { HatEngineParams }   from '../engine/HatEngine';
import type { SnareEngineParams } from '../engine/SnareEngine';
import type { ClapEngineParams }  from '../engine/ClapEngine';
import type { Step } from '../sequencer/Sequencer';

// MixerState, EngineType, DEFAULT_MIXER_STATE move here from useSynth.ts —
// see §5. The Project shape is where these primitives canonically live now.
export type EngineType = 'synth' | 'kick' | 'hat' | 'snare' | 'clap';

export interface MixerState {
  volume: number;       // slider 0..1; log mapping happens in useSynth (U4)
  muted: boolean;
  soloed: boolean;
}

export const DEFAULT_MIXER_STATE: MixerState = {
  volume: 0.9,          // unity in the U4 dB curve
  muted: false,
  soloed: false,
};

export const PROJECT_SCHEMA_VERSION = 1 as const;

export interface Project {
  schemaVersion: 1;
  bpm: number;
  tracks: [ProjectTrack, ProjectTrack, ProjectTrack, ProjectTrack];
}

export interface ProjectTrack {
  engineType: EngineType;
  engines: EngineParamsMap;
  mixer: MixerState;
  playMode: 'mono' | 'chord';
  steps: Step[];  // length 16
}

export interface EngineParamsMap {
  synth: SynthEngineParams;
  kick: KickEngineParams;
  hat: HatEngineParams;
  snare: SnareEngineParams;
  clap: ClapEngineParams;
}

// Type-safe accessor: returns the active engine's params, narrowed by engineType.
export function activeParams<T extends EngineType>(
  track: ProjectTrack & { engineType: T }
): EngineParamsMap[T] {
  return track.engines[track.engineType] as EngineParamsMap[T];
}
```

**Why the dense `engines` map (all 5 engine slots always populated):**

- **Single-op engine-type swap:** `{ op: 'replace', path: '/tracks/2/engineType', value: 'kick' }`. The kick params are already in `engines.kick` — no payload move. Critical for future diff transport.
- **Stable Vue object identity:** the track's shape never changes regardless of `engineType`, so reactive watchers and child component bindings never need re-wiring.
- **Track-level operations stay atomic:** clearing or copying a whole track is one op on `/tracks/i` — no two-tree consistency window.
- **Cost is negligible:** ~4KB per project total. Bandwidth wins from small *diffs*, not small full docs.

Rejected alternatives:
- Sparse `enginesByType: Partial<Record<...>>` — saves ~1KB per project but adds null-checks at every access site and produces a two-op diff on first engine-type swap. Not worth it at this scale.
- True discriminated union (shape varies by `engineType`) — strictest type narrowing but: (a) Vue reactivity churns on shape change, (b) cross-type diffs become full-payload replacements rather than one-field ops.

**Constructing fresh state** (in `src/project/factory.ts`):

```ts
export function freshProject(): Project {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    bpm: 120,
    tracks: [0, 1, 2, 3].map(() => freshTrack()) as Project['tracks'],
  };
}

export function freshTrack(): ProjectTrack {
  return {
    engineType: 'synth',
    engines: {
      synth: structuredClone(SynthEngine.DEFAULT_PARAMS),
      kick:  structuredClone(KickEngine.DEFAULT_PARAMS),
      hat:   structuredClone(HatEngine.DEFAULT_PARAMS),
      snare: structuredClone(SnareEngine.DEFAULT_PARAMS),
      clap:  structuredClone(ClapEngine.DEFAULT_PARAMS),
    },
    mixer: { ...DEFAULT_MIXER_STATE },
    playMode: 'mono',
    steps: Array.from({ length: 16 }, () => freshStep()),
  };
}

export function freshStep(): Step {
  return {
    note: null, octave: 4, length: 1, velocity: 0.8,
    muted: false, isChord: false, chordType: 'maj',
  };
}
```

`structuredClone` is required (carried over from D7 in `ARCHITECTURE.md`) — nested ADSR objects in `DEFAULT_PARAMS` must not be shared by reference across tracks.

**Diff profile** (forward-looking; not implemented in this branch):

| User action | JSON-Patch op |
|---|---|
| Knob turn | `replace /tracks/2/engines/synth/filterCutoff` |
| Step note set | `replace /tracks/2/steps/5/note` |
| Engine swap | `replace /tracks/2/engineType` |
| BPM change | `replace /bpm` |
| Mute toggle | `replace /tracks/2/mixer/muted` |
| Clear track | `replace /tracks/2/steps` (or 16 step-ops, batched) |

Every edit is one logical op against a stable path. No add/remove ops in normal use.

---

## 3. Module layout

New directory `src/project/`:

```
src/project/
├── types.ts        # Project, ProjectTrack, EngineParamsMap, PROJECT_SCHEMA_VERSION, activeParams
├── factory.ts      # freshProject(), freshTrack(), freshStep()
├── mutations.ts    # clearTrack(), shiftTrack(), fillTrack() — pure ops over a ProjectTrack
├── migrations.ts   # migrateToLatest(raw) — versioned schema entry point
├── storage.ts      # loadProject(), installAutoSave() — localStorage + debounced observer
└── index.ts        # public re-exports
```

Public surface (`src/project/index.ts`):

```ts
export type { Project, ProjectTrack, EngineParamsMap } from './types';
export { PROJECT_SCHEMA_VERSION, activeParams } from './types';
export { freshProject, freshTrack, freshStep } from './factory';
export { clearTrack, shiftTrack, fillTrack } from './mutations';
export { loadProject, installAutoSave } from './storage';
```

`migrations.ts` is internal-only (called by `loadProject`).

---

## 4. Sequencer refactor

`src/sequencer/Sequencer.ts` becomes a pure ticker. **Drops:**

- `tracks` field (and its initialization)
- `bpm` field
- `clearTrack`, `shiftTrack`, `fillTrack` methods (moved to `src/project/mutations.ts`)

**Keeps:**

- `isPlaying` field (runtime state, not in Project)
- `internals` markRaw'd scheduler state (post-A5, unchanged)
- `start()`, `stop()` (new `start()` signature below)

**New `start()` signature:**

```ts
class Sequencer {
  isPlaying = false;
  private internals: SchedulerInternals = markRaw({ /* unchanged */ });

  start(
    ctx: AudioContext,
    getBpm: () => number,                                 // read each tick for live BPM changes
    onStep: (stepIndex: number, time: number) => void
  ): void {
    // unchanged scheduler logic, but reads getBpm() instead of this.bpm
  }

  stop(): void { /* unchanged */ }
}
```

The BPM rebase logic (post-fix-10, D6) stays — it just reads `getBpm()` once per tick and compares to `internals.lastBpm`.

**`Step` interface stays in `src/sequencer/Sequencer.ts`** for now (move to project module not needed; the type is naturally about a step in a sequence). `ProjectTrack.steps: Step[]` imports it.

**Wiring in `useSynth.ts`:**

```ts
const onStep = (stepIndex: number, time: number) => {
  currentStep.value = stepIndex;
  for (let i = 0; i < 4; i++) {
    const track = project.tracks[i];
    const step = track.steps[stepIndex];
    if (step.note && !step.muted) {
      // ... existing trigger logic, reading from `track` instead of `trackStates[i]`
    }
  }
};
sequencer.start(state.ctx, () => project.bpm, onStep);
```

---

## 5. `useSynth.ts` changes

**Module-scope:**

```ts
// Before:
const sequencer = reactive(new Sequencer());
const trackStates = reactive<TrackState[]>([/* ... */]);

// After:
const project = reactive(loadProject());
const sequencer = reactive(new Sequencer());
installAutoSave(project);  // debounced localStorage observer
```

`loadProject()` runs at module init — before any component mounts — so `useSynth()` callers always see populated state. No flash-of-defaults.

**The `trackParam` helper updates its path:**

```ts
// Before: trackStates[i][engine][param]
// After:  project.tracks[i].engines[engine][param]
```

External shape (per-knob writable computeds like `osc1Coarse`, `kickTune`, etc.) is unchanged — App.vue and panels don't see the refactor.

**Watchers update:**

- The per-slice diff watcher (post-A2) now watches `project.tracks[i].engines[slice]` instead of `trackStates[i][slice]`. Same `snapshot()` + `diffParams()` plumbing.
- The `engineType` watcher now watches `project.tracks[i].engineType`.
- The mixer watcher now watches `project.tracks[i].mixer`.

**New top-level binding:**

```ts
const bpm = computed({
  get: () => project.bpm,
  set: (val: number) => { project.bpm = val; },
});
```

App.vue's BPM input rebinds to this. The Sequencer no longer owns `bpm`.

**Removed exposure:** `sequencer.tracks` and `sequencer.bpm` are gone. Anything that read them now reads from `project`.

**TrackState type is removed** in favor of `ProjectTrack` (re-exported from `src/project`).

**`MixerState`, `EngineType`, and `DEFAULT_MIXER_STATE` migrate from `useSynth.ts` into `src/project/types.ts`** — they're project-shape concepts and the new `Project` types depend on them. `useSynth.ts` imports them from the project module instead of declaring them. This avoids a feels-cyclic dependency where `project/types.ts` would otherwise have to reach back into `composables/useSynth.ts` for primitive types.

---

## 6. Persistence semantics

`src/project/storage.ts`:

```ts
const STORAGE_KEY = 'fiddle:project';
const SAVE_DEBOUNCE_MS = 500;

export function loadProject(): Project {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return freshProject();  // localStorage unavailable (sandbox, file://, etc.)
  }
  if (!raw) return freshProject();
  try {
    const parsed = JSON.parse(raw);
    return migrateToLatest(parsed);
  } catch (e) {
    console.warn('Project load failed, starting fresh:', e);
    return freshProject();
  }
}

export function installAutoSave(project: Project): () => void {
  const save = debounce(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(toRaw(project)));
    } catch (e) {
      console.warn('Project save failed:', e);  // quota / disabled — swallow
    }
  }, SAVE_DEBOUNCE_MS);

  return watch(project, save, { deep: true });
}
```

**Boot sequence:** `useSynth.ts` module init calls `loadProject()` and `installAutoSave(project)` immediately. Before any component renders.

**What is persisted:** the full Project (schemaVersion, bpm, tracks → engines/mixer/playMode/steps).

**What is NOT persisted** (ephemeral, runtime-only):
- `isPlaying` — never auto-play on load (no AudioContext gesture anyway)
- `currentStep` — starts at `-1` (stopped sentinel)
- `activeTrackIndex` — starts at `null` (overview mode)
- `audioState` — lazy via A1, unchanged

**Defenses:**

- `toRaw(project)` before `JSON.stringify` strips the Vue proxy explicitly. (`JSON.stringify` already skips Symbol-keyed reactive flags, but `toRaw` is defense-in-depth.)
- `try/catch` around both read and write — sandbox, quota, disabled storage degrade silently to "session-only".
- Debouncing: a 200-step knob drag produces exactly 1 write, not 200.

`src/project/migrations.ts`:

```ts
export function migrateToLatest(raw: unknown): Project {
  if (typeof raw !== 'object' || raw === null) {
    return freshProject();  // garbage in, fresh start
  }
  const v = (raw as { schemaVersion?: number }).schemaVersion;

  if (v === PROJECT_SCHEMA_VERSION) return raw as Project;

  if (typeof v === 'number') {
    throw new Error(
      `Unknown project schemaVersion: ${v}. App may be older than this save.`
    );
  }

  console.warn('Project missing schemaVersion, starting fresh');
  return freshProject();
}
```

When V2 ships, future-us adds `if (v === 1) raw = migrateV1ToV2(raw); v = 2;` before the V2 return. Each migration is a pure function. Standard pattern.

### 6.1 Versioning policy: when to bump `schemaVersion`

The version bumps for **breaking** changes only. Additive changes do not bump.

| Change | Bump? | Migration needed? |
|---|---|---|
| Add a new field with a default (e.g. LFO on the synth, per-track `color`) | No | No — `reconcileWithDefaults` fills it in at load time |
| Add a new engine type to `EngineType` and `EngineParamsMap` | No | No — `reconcileWithDefaults` adds the missing engine slot |
| Rename a field (`osc1Coarse` → `osc1Semitones`) | Yes | Yes — rename key in old docs |
| Change the *meaning* of an existing field (e.g. U4-style volume curve flip) | Yes | Yes — convert old values |
| Remove a field | Yes | Yes — map old value to the new representation |
| Change array length or top-level shape | Yes | Yes |

The rule is: **bump only when an old save would behave wrong under new code, even after defaults are filled in.** Renames, semantic changes, and removals always bump. Pure additions never do.

### 6.2 `reconcileWithDefaults`

After `migrateToLatest`, the load path runs a reconciliation step that fills in any field missing relative to current `DEFAULT_PARAMS`. This is what makes additive changes free.

```ts
// src/project/storage.ts
function reconcileWithDefaults(project: Project): Project {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    bpm: project.bpm ?? 120,
    tracks: project.tracks.map(reconcileTrack) as Project['tracks'],
  };
}

function reconcileTrack(track: ProjectTrack): ProjectTrack {
  const fresh = freshTrack();
  return {
    engineType: track.engineType ?? fresh.engineType,
    engines: {
      synth: deepMerge(SynthEngine.DEFAULT_PARAMS, track.engines?.synth),
      kick:  deepMerge(KickEngine.DEFAULT_PARAMS,  track.engines?.kick),
      hat:   deepMerge(HatEngine.DEFAULT_PARAMS,   track.engines?.hat),
      snare: deepMerge(SnareEngine.DEFAULT_PARAMS, track.engines?.snare),
      clap:  deepMerge(ClapEngine.DEFAULT_PARAMS,  track.engines?.clap),
    },
    mixer: deepMerge(DEFAULT_MIXER_STATE, track.mixer),
    playMode: track.playMode ?? fresh.playMode,
    steps: reconcileSteps(track.steps, fresh.steps),
  };
}

// deepMerge: loaded values win for present fields; missing fields fall through
// to defaults. Recurses into plain objects (like ADSR). Arrays are replaced
// wholesale (no element-wise merge) — for steps, which have a fixed length-16
// invariant, reconcileSteps handles position-by-position fill-in.

function reconcileSteps(loaded: Step[] | undefined, defaults: Step[]): Step[] {
  if (!Array.isArray(loaded)) return defaults.map(s => ({ ...s }));
  // Position-by-position: keep loaded entries where present, fresh-defaults
  // elsewhere. Tolerates length mismatches (over- or under-long saves).
  return defaults.map((def, i) => {
    return loaded[i] ? deepMerge(def, loaded[i]) : { ...def };
  });
}
```

`deepMerge` is a small utility (~10 lines). Recurses on plain objects, terminates on primitives and arrays. Lives in `src/utils/deepMerge.ts` (or inline in `storage.ts` — implementation choice). `reconcileSteps` is project-specific (knows about the length-16 invariant) and lives in `storage.ts`.

This reconciler is also useful as a **defensive layer for corruption**: a save that's syntactically valid V1 JSON but missing fields (e.g. partial write, code bug in a prior version) gets repaired to a complete shape rather than crashing the app.

**Validation depth:** for V1, beyond `schemaVersion === 1` + reconcile-with-defaults, we don't deep-type-check (no zod, no runtime assertions on field types). The cost of weird-type corruption is "knobs read wrong values" — visible immediately, recoverable by clearing localStorage. If real-world corruption becomes an issue, swap in zod-based validation. Not worth the dep up front.

---

## 7. Testing approach

Colocated test files (matching existing convention).

### `factory.test.ts`
- `freshProject()` returns `schemaVersion === 1`, 4 tracks, all 5 engines per track populated from each engine's `DEFAULT_PARAMS`.
- 16 steps per track, all freshly defaulted.
- Mutating track 0's `engines.synth.filterEnv.a` does NOT change track 1's value (catches the reference-sharing bug class).

### `mutations.test.ts`
- `clearTrack(track)` zeros all 16 steps to freshStep values.
- `shiftTrack(track, 'left' | 'right')` rotates correctly.
- `fillTrack(track, interval)` sets `step.note === 'C'` at every `i % interval === 0`.

### `migrations.test.ts`
- Valid V1 doc passes through unchanged.
- Missing `schemaVersion` → returns `freshProject()` + warns (no throw).
- `schemaVersion === 2` (unknown future) → throws with useful message.
- Non-object input (null, undefined, string, number) → returns `freshProject()`.

### `storage.test.ts`
- `loadProject()` with empty localStorage → `freshProject()`.
- `loadProject()` with a serialized V1 doc → restored equivalent.
- `loadProject()` with malformed JSON → fresh + warns, doesn't throw.
- `loadProject()` when `getItem` itself throws (sandbox/disabled) → fresh.
- `installAutoSave(project)` doesn't write immediately.
- After mutating + advancing fake timers past the debounce window, exactly one write occurs.
- A burst of 200 rapid mutations produces exactly 1 write.
- The dispose function returned by `installAutoSave` stops further writes.
- A `setItem` write throwing (quota / disabled) is swallowed.

### `reconcile.test.ts` (additive-changes coverage)
- A doc missing an entire engine slot (e.g. `engines.kick`) gets the slot populated with `KickEngine.DEFAULT_PARAMS`.
- A doc with a synth engine missing a single field (e.g. `osc1Level`) gets that field filled from `SynthEngine.DEFAULT_PARAMS.osc1Level`; the loaded `osc1Coarse` value is preserved.
- A doc with a partial ADSR (e.g. `ampEnv: { a: 0.1 }` only) gets `d`/`s`/`r` filled from defaults; `a` is preserved.
- A doc with a partial `mixer` (e.g. `{ volume: 0.5 }`) gets `muted`/`soloed` filled.
- A doc with extra unknown fields passes through untouched (forward-compat — future code's fields survive a round-trip through old code).
- `reconcileSteps` with a length-1 loaded array → returns length 16 (the one loaded step is reconciled at index 0, the other 15 are fresh-defaults).
- `reconcileSteps` with a length-20 loaded array → returns length 16 (the first 16 are reconciled, the extras are dropped).
- `reconcileSteps` with `undefined`/non-array → returns length-16 fresh defaults.
- `deepMerge` on top-level: arrays in loaded values replace the default arrays wholesale (e.g. a future field `lfo.destinations: string[]` is replaced, not merged element-wise).

### `Sequencer.test.ts` (existing)
- Existing scheduling tests stay green after updating the `start()` call signature to pass `getBpm` + `onStep`.
- Tests previously covering `clearTrack`/`shiftTrack`/`fillTrack` move to `mutations.test.ts` (implementation moves; tests follow).

### `useSynth.test.ts` + `TrackMixer.test.ts` (existing)
- Update access paths: `trackStates[i].synth.X` → `project.tracks[i].engines.synth.X`. Same assertions.
- Expect ALL existing tests green after path updates — regression gate.

### Integration smoke test (new case in `useSynth.test.ts`)
- Seed `localStorage` with a known V1 doc, `vi.resetModules`.
- Import `useSynth` fresh.
- Assert `synthData.project.tracks[0].engines.synth.filterCutoff` matches the seeded value (proves `loadProject` ran).
- Mutate a knob, advance fake timers past debounce.
- Assert `localStorage.getItem(STORAGE_KEY)` reflects the new value (proves `installAutoSave` is wired).

### What we still don't test
- UI components (`Tracker.vue`, `Knob.vue`, panels) — by-ear / by-eye.
- Audio "actually sounds correct" — no headless audio capture.
- Vue reactivity primitives themselves.

### Expected test count
- Today: 62.
- Drop: 0 (Sequencer mutation tests *move*, not deleted).
- Add: ~25 new (`factory`, `mutations` migration, `migrations`, `storage`, integration).
- Net: ~85.

`npm test` + `vue-tsc` + `vite build` must all be green at every commit.

---

## 8. Acceptance criteria

A working implementation of this design satisfies all of:

1. `src/project/` directory exists with `types.ts`, `factory.ts`, `mutations.ts`, `migrations.ts`, `storage.ts`, `index.ts`.
2. `Project` and `ProjectTrack` types are defined as in §2; `activeParams` accessor compiles and narrows correctly.
3. `useSynth.ts` exposes `project` (reactive root) instead of `trackStates`; `trackParam` paths update accordingly.
4. `Sequencer.ts` no longer owns `tracks`, `bpm`, or the three mutation helpers. `start()` takes `getBpm` and `onStep`.
5. localStorage save fires (debounced) on any user-visible state change; restore fires at module init.
6. Fresh app (cleared localStorage) starts with `freshProject()` defaults — verifiable by inspecting localStorage after first interaction.
7. After a knob turn + page refresh, the knob's value is preserved.
8. After an engine-type swap on track 0 (e.g. synth → kick → synth), the synth's params for track 0 are preserved.
9. Migration registry handles missing/unknown schemaVersion per §6.1.
9a. `reconcileWithDefaults` covers additive-change forward-compat per §6.2: a V1 save written by a future build of the app (with extra fields) loads cleanly; a V1 save written by an older build (with missing fields added later) loads with defaults filled in.
10. All existing 62 tests pass (after path updates); ~25 new tests pass; `vue-tsc` + `vite build` clean.
11. No `AudioContext` is created at module load (A1 invariant preserved).
12. The Visualizer still works on first Play (A1-reactivity invariant preserved — `audioState` shallowRef).

---

## 9. Open questions for the implementation plan

These don't need design decisions but should be settled during planning:

- Where to import the `debounce` utility from. Options: tiny inline implementation (~6 lines), `lodash-es/debounce` (adds dep, well-tested), or write our own in `src/utils/debounce.ts`. Recommendation: write our own tiny one — no dep, easy to test.
- Whether `installAutoSave` should be invoked unconditionally at module init or only after first `useSynth()` call. Recommendation: unconditional at module init — `useSynth` is the only consumer of the module's exports, and pre-mount saves are harmless (no mutations possible before mount).
- Whether `Step` interface stays in `src/sequencer/Sequencer.ts` or moves to `src/project/`. Recommendation: stays — it's a sequencing concept, and the Sequencer file still imports `Step` (it's the callback contract type).

---

## 10. Out-of-scope reminders

For future branches, NOT this one:

- Named presets UI (save/load/rename per-engine snapshots). The `Project` type can later grow a `presets: Record<string, PresetEntry>` field; this branch doesn't add it.
- Multi-project picker. Could later partition localStorage into `fiddle:projects:<id>` keys + a `fiddle:current-project-id` pointer; this branch uses one fixed key.
- Any networking, transport, sync, presence, conflict resolution code.

The `schemaVersion` field is the hook that future migrations and any future wire protocol will use. Adding those is not this branch.
