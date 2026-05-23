# Project Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Project Model design — A3 tagged-union TrackState refactor + `Project` type + localStorage persistence + Sequencer-becomes-a-ticker refactor — without merging to `main` until explicit approval.

**Architecture:** Add a new `src/project/` module with the canonical `Project` shape, factory, mutations, migrations, storage (load/save) and a deep-merge reconciler. Refactor `useSynth.ts` to hold `project` (one reactive root) instead of `trackStates`. Refactor `Sequencer.ts` into a pure ticker. localStorage auto-save is debounced; loaded saves are reconciled against engine `DEFAULT_PARAMS` so additive features don't require schema bumps.

**Tech Stack:** Vue 3 + TypeScript + Vite + Vitest. Web Audio API.

**Spec:** `docs/superpowers/specs/2026-05-23-project-model-design.md`
**Branch:** `feature/project-model` (do NOT merge to `main` until user explicit approval).

**Branch-per-task workflow.** Each task gets a sub-branch (`feature/project-model-t<N>-<slug>`) cut from `feature/project-model`. When all task steps are green (`npm test` + `vue-tsc --noEmit` + `vite build` all pass), merge `--no-ff` back into `feature/project-model`. This keeps the feature branch history clean and bisectable.

**Always-green invariant.** At every commit on `feature/project-model`, `npm test` + `vue-tsc --noEmit` + `vite build` must succeed. There are 62 tests today; the count grows during this plan.

**Style note.** Match the existing codebase: TypeScript with explicit types at module boundaries, colocated `*.test.ts` next to source, two-space indentation, no `var`. Vitest with `vi.stubGlobal` for Web Audio mocks (see `src/engine/TrackMixer.test.ts` for the canonical mock setup).

---

## Phase A — Utilities (no app coupling)

### Task 1: `deepMerge` utility

Pure deep-merge helper used by `reconcileWithDefaults` later. Loaded values win for present fields; missing fields fall through to defaults. Recurses on plain objects; arrays are replaced wholesale (not merged element-wise).

**Files:**
- Create: `src/utils/deepMerge.ts`
- Create: `src/utils/deepMerge.test.ts`

- [ ] **Step 1: Cut sub-branch**

```bash
git checkout feature/project-model
git checkout -b feature/project-model-t1-deepmerge
```

- [ ] **Step 2: Write the failing test**

Create `src/utils/deepMerge.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { deepMerge } from './deepMerge';

describe('deepMerge', () => {
  it('returns a fresh copy of defaults when overrides is undefined', () => {
    const defaults = { a: 1, b: 2 };
    const merged = deepMerge(defaults, undefined);
    expect(merged).toEqual(defaults);
    expect(merged).not.toBe(defaults);
  });

  it('returns a fresh copy of defaults when overrides is null', () => {
    expect(deepMerge({ a: 1 }, null as any)).toEqual({ a: 1 });
  });

  it('overrides primitive fields', () => {
    expect(deepMerge({ a: 1, b: 2 }, { b: 5 })).toEqual({ a: 1, b: 5 });
  });

  it('recurses into nested objects', () => {
    const defaults = { env: { a: 0.1, d: 0.2, s: 0.5, r: 0.3 } };
    const overrides = { env: { d: 0.8 } };
    expect(deepMerge(defaults, overrides)).toEqual({
      env: { a: 0.1, d: 0.8, s: 0.5, r: 0.3 },
    });
  });

  it('replaces arrays wholesale (no element-wise merge)', () => {
    const defaults = { tags: ['x', 'y', 'z'] };
    const overrides = { tags: ['a'] };
    expect(deepMerge(defaults, overrides)).toEqual({ tags: ['a'] });
  });

  it('treats null overrides as "use default"', () => {
    expect(deepMerge({ a: 1 }, { a: null })).toEqual({ a: 1 });
  });

  it('does not mutate the defaults object', () => {
    const defaults = { env: { a: 0.1 } };
    deepMerge(defaults, { env: { a: 0.5 } });
    expect(defaults.env.a).toBe(0.1);
  });

  it('does not mutate the overrides object', () => {
    const overrides = { env: { a: 0.5 } };
    deepMerge({ env: { a: 0.1, d: 0.2 } }, overrides);
    expect(overrides).toEqual({ env: { a: 0.5 } });
  });
});
```

- [ ] **Step 3: Run test, confirm it fails**

```bash
npx vitest run src/utils/deepMerge.test.ts
```
Expected: FAIL — `Cannot find module './deepMerge'`.

- [ ] **Step 4: Implement `deepMerge`**

Create `src/utils/deepMerge.ts`:

```ts
// Deep-merge `overrides` into `defaults`. `overrides` wins for present, non-null
// fields; missing or null fields fall through to defaults. Recurses on plain
// objects only — arrays are replaced wholesale (no element-wise merge).
// Neither input is mutated.

type AnyObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is AnyObject {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function deepMerge<T>(defaults: T, overrides: Partial<T> | null | undefined): T {
  if (overrides === null || overrides === undefined) {
    return structuredClone(defaults);
  }
  if (!isPlainObject(defaults)) {
    // primitive / array default — replace if override is non-null, else keep default
    return (overrides as unknown as T) ?? structuredClone(defaults);
  }

  const result: AnyObject = {};
  const d = defaults as unknown as AnyObject;
  const o = overrides as unknown as AnyObject;

  for (const key of Object.keys(d)) {
    const dv = d[key];
    const ov = o[key];
    if (ov === undefined || ov === null) {
      result[key] = structuredClone(dv);
    } else if (isPlainObject(dv) && isPlainObject(ov)) {
      result[key] = deepMerge(dv, ov);
    } else {
      result[key] = ov;
    }
  }

  return result as T;
}
```

- [ ] **Step 5: Run test, confirm it passes**

```bash
npx vitest run src/utils/deepMerge.test.ts
```
Expected: 8/8 tests pass.

- [ ] **Step 6: Run full check**

```bash
npm test && npx vue-tsc --noEmit && npx vite build
```
Expected: all green; total test count = 62 + 8 = 70.

- [ ] **Step 7: Commit**

```bash
git add src/utils/deepMerge.ts src/utils/deepMerge.test.ts
git commit -m "feat(utils): add deepMerge for project reconciliation"
```

- [ ] **Step 8: Merge sub-branch back**

```bash
git checkout feature/project-model
git merge --no-ff feature/project-model-t1-deepmerge -m "Merge T1: deepMerge utility"
git branch -d feature/project-model-t1-deepmerge
```

---

### Task 2: `debounce` utility

Single-trailing-edge debounce. Schedules `fn` to fire `delay` ms after the last invocation. Subsequent calls within the window reset the timer. Used by `installAutoSave` to coalesce knob-drag bursts into one localStorage write.

**Files:**
- Create: `src/utils/debounce.ts`
- Create: `src/utils/debounce.test.ts`

- [ ] **Step 1: Cut sub-branch**

```bash
git checkout feature/project-model
git checkout -b feature/project-model-t2-debounce
```

- [ ] **Step 2: Write the failing test**

Create `src/utils/debounce.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { debounce } from './debounce';

describe('debounce', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('does not fire immediately', () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d();
    expect(fn).not.toHaveBeenCalled();
  });

  it('fires once after delay if invoked once', () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('fires exactly once for a burst of rapid calls', () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);
    for (let i = 0; i < 50; i++) d();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('passes the most recent arguments to fn', () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d('first');
    d('second');
    d('third');
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledWith('third');
  });

  it('refires when invoked again after the previous fire', () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    d();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('cancel() prevents pending fire', () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d();
    d.cancel();
    vi.advanceTimersByTime(100);
    expect(fn).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run test, confirm it fails**

```bash
npx vitest run src/utils/debounce.test.ts
```
Expected: FAIL — `Cannot find module './debounce'`.

- [ ] **Step 4: Implement `debounce`**

Create `src/utils/debounce.ts`:

```ts
// Single-trailing-edge debounce. `fn` fires `delay` ms after the LAST call.
// Calls within the window reset the timer; the most recent arguments win.
// `.cancel()` aborts a pending fire.

export interface Debounced<Args extends unknown[]> {
  (...args: Args): void;
  cancel(): void;
}

export function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  delay: number,
): Debounced<Args> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingArgs: Args | null = null;

  const debounced = ((...args: Args) => {
    pendingArgs = args;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const a = pendingArgs!;
      pendingArgs = null;
      fn(...a);
    }, delay);
  }) as Debounced<Args>;

  debounced.cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
      pendingArgs = null;
    }
  };

  return debounced;
}
```

- [ ] **Step 5: Run test, confirm it passes**

```bash
npx vitest run src/utils/debounce.test.ts
```
Expected: 6/6 tests pass.

- [ ] **Step 6: Run full check**

```bash
npm test && npx vue-tsc --noEmit && npx vite build
```
Expected: all green; total test count = 70 + 6 = 76.

- [ ] **Step 7: Commit + merge sub-branch**

```bash
git add src/utils/debounce.ts src/utils/debounce.test.ts
git commit -m "feat(utils): add debounce with cancel"

git checkout feature/project-model
git merge --no-ff feature/project-model-t2-debounce -m "Merge T2: debounce utility"
git branch -d feature/project-model-t2-debounce
```

---

## Phase B — Project module (build out new files; old code still wired)

### Task 3: `src/project/types.ts` — move types here + add new ones

Relocate `EngineType`, `MixerState`, `DEFAULT_MIXER_STATE` from `useSynth.ts` to the new module. Add `Project`, `ProjectTrack`, `EngineParamsMap`, `PROJECT_SCHEMA_VERSION`, and `activeParams`. Update importers (`useSynth.ts`, `TrackMixer.vue`) to point to the new location. Pure type relocation + additions — no behavior change.

**Files:**
- Create: `src/project/types.ts`
- Modify: `src/composables/useSynth.ts:16-41` (remove the three exports + their declarations)
- Modify: `src/composables/useSynth.ts` imports (add import of the three from `'../project/types'`)
- Modify: `src/components/TrackMixer.vue` import (was `'../composables/useSynth'` for `DEFAULT_MIXER_STATE`)

- [ ] **Step 1: Cut sub-branch**

```bash
git checkout feature/project-model
git checkout -b feature/project-model-t3-types
```

- [ ] **Step 2: Create `src/project/types.ts`**

```ts
import type { SynthEngineParams } from '../engine/SynthEngine';
import type { KickEngineParams }  from '../engine/KickEngine';
import type { HatEngineParams }   from '../engine/HatEngine';
import type { SnareEngineParams } from '../engine/SnareEngine';
import type { ClapEngineParams }  from '../engine/ClapEngine';
import type { Step } from '../sequencer/Sequencer';

// Bump only on breaking schema changes — additive changes are handled by
// `reconcileWithDefaults` at load time. See spec §6.1.
export const PROJECT_SCHEMA_VERSION = 1 as const;

export type EngineType = 'synth' | 'kick' | 'hat' | 'snare' | 'clap';

export interface MixerState {
  volume: number;       // slider 0..1; the log mapping happens in useSynth (U4)
  muted: boolean;
  soloed: boolean;
}

export const DEFAULT_MIXER_STATE: MixerState = {
  volume: 0.9,          // 0 dB unity under the U4 dB curve
  muted: false,
  soloed: false,
};

export interface EngineParamsMap {
  synth: SynthEngineParams;
  kick: KickEngineParams;
  hat: HatEngineParams;
  snare: SnareEngineParams;
  clap: ClapEngineParams;
}

export interface ProjectTrack {
  engineType: EngineType;
  engines: EngineParamsMap;     // dense — all 5 engines always present
  mixer: MixerState;
  playMode: 'mono' | 'chord';
  steps: Step[];                // length 16
}

export interface Project {
  schemaVersion: 1;
  bpm: number;
  tracks: [ProjectTrack, ProjectTrack, ProjectTrack, ProjectTrack];
}

// Type-safe accessor: returns the active engine's params, narrowed by engineType.
export function activeParams<T extends EngineType>(
  track: ProjectTrack & { engineType: T }
): EngineParamsMap[T] {
  return track.engines[track.engineType] as EngineParamsMap[T];
}
```

- [ ] **Step 3: Remove the moved declarations from `useSynth.ts`**

In `src/composables/useSynth.ts`, find this block (around lines 16–41) and DELETE it:

```ts
export type EngineType = 'synth' | 'kick' | 'hat' | 'snare' | 'clap';

export interface MixerState {
  volume: number;
  muted: boolean;
  soloed: boolean;
}
// ...the TrackState interface below uses EngineType + MixerState — leave that
// intact for now (we drop TrackState in Task 9).

export const DEFAULT_MIXER_STATE: MixerState = {
  // ...
  volume: 0.9,
  muted: false,
  soloed: false,
};

function sliderToLinearGain(slider: number): number { /* unchanged */ }
```

Delete the `EngineType` type alias, the `MixerState` interface, and `DEFAULT_MIXER_STATE`. KEEP `sliderToLinearGain` — that lives in `useSynth.ts` (U4 audio math). KEEP `TrackState` for now — we drop it in Task 9.

- [ ] **Step 4: Add the new import at the top of `useSynth.ts`**

Add to the existing import block:

```ts
import {
  type EngineType,
  type MixerState,
  DEFAULT_MIXER_STATE,
} from '../project/types';
```

- [ ] **Step 5: Re-export for back-compat (one-line)**

Some other components import `EngineType` or `MixerState` from `useSynth`. To avoid a fan-out of import changes in this task, add re-exports at the top of `useSynth.ts` (just below the new import):

```ts
export { DEFAULT_MIXER_STATE };
export type { EngineType, MixerState };
```

- [ ] **Step 6: Update `TrackMixer.vue` import**

In `src/components/TrackMixer.vue`, change:
```ts
import { DEFAULT_MIXER_STATE, type TrackState } from '../composables/useSynth';
```
to:
```ts
import { DEFAULT_MIXER_STATE } from '../project/types';
import type { TrackState } from '../composables/useSynth';
```

(`TrackState` still lives in `useSynth.ts` until Task 9.)

- [ ] **Step 7: Run full check**

```bash
npm test && npx vue-tsc --noEmit && npx vite build
```
Expected: all 76 tests pass; tsc clean; build clean.

- [ ] **Step 8: Commit + merge sub-branch**

```bash
git add src/project/types.ts src/composables/useSynth.ts src/components/TrackMixer.vue
git commit -m "refactor(project): relocate engine/mixer types to src/project/types

Move EngineType, MixerState, DEFAULT_MIXER_STATE from useSynth.ts to the
new project module. Add Project, ProjectTrack, EngineParamsMap,
PROJECT_SCHEMA_VERSION, activeParams. Pure type relocation + additions,
no behavior change. useSynth still owns runtime state (TrackState, the
trackStates array, audio handles) until Task 9."

git checkout feature/project-model
git merge --no-ff feature/project-model-t3-types -m "Merge T3: project types"
git branch -d feature/project-model-t3-types
```

---

### Task 4: `src/project/factory.ts` — `freshProject`, `freshTrack`, `freshStep`

Constructors for fresh state, used by `loadProject` (when there's nothing in localStorage) and by tests.

**Files:**
- Create: `src/project/factory.ts`
- Create: `src/project/factory.test.ts`

- [ ] **Step 1: Cut sub-branch**

```bash
git checkout feature/project-model
git checkout -b feature/project-model-t4-factory
```

- [ ] **Step 2: Write the failing test**

Create `src/project/factory.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { freshProject, freshTrack, freshStep } from './factory';
import { PROJECT_SCHEMA_VERSION } from './types';
import { SynthEngine } from '../engine/SynthEngine';
import { KickEngine } from '../engine/KickEngine';
import { HatEngine } from '../engine/HatEngine';
import { SnareEngine } from '../engine/SnareEngine';
import { ClapEngine } from '../engine/ClapEngine';

describe('freshStep', () => {
  it('matches the canonical default Step shape', () => {
    expect(freshStep()).toEqual({
      note: null, octave: 4, length: 1, velocity: 0.8,
      muted: false, isChord: false, chordType: 'maj',
    });
  });

  it('returns a fresh object each call (no reference sharing)', () => {
    expect(freshStep()).not.toBe(freshStep());
  });
});

describe('freshTrack', () => {
  it('defaults to synth engineType in mono mode', () => {
    const t = freshTrack();
    expect(t.engineType).toBe('synth');
    expect(t.playMode).toBe('mono');
  });

  it('populates all 5 engine slots from each engine\'s DEFAULT_PARAMS', () => {
    const t = freshTrack();
    expect(t.engines.synth).toEqual(SynthEngine.DEFAULT_PARAMS);
    expect(t.engines.kick).toEqual(KickEngine.DEFAULT_PARAMS);
    expect(t.engines.hat).toEqual(HatEngine.DEFAULT_PARAMS);
    expect(t.engines.snare).toEqual(SnareEngine.DEFAULT_PARAMS);
    expect(t.engines.clap).toEqual(ClapEngine.DEFAULT_PARAMS);
  });

  it('deep-clones engine defaults (no reference sharing across tracks)', () => {
    const a = freshTrack();
    const b = freshTrack();
    a.engines.synth.filterEnv.a = 0.99;
    expect(b.engines.synth.filterEnv.a).toBe(SynthEngine.DEFAULT_PARAMS.filterEnv.a);
  });

  it('has 16 fresh steps', () => {
    const t = freshTrack();
    expect(t.steps).toHaveLength(16);
    for (const s of t.steps) {
      expect(s).toEqual(freshStep());
    }
  });

  it('mixer is a fresh copy of DEFAULT_MIXER_STATE', () => {
    const t = freshTrack();
    expect(t.mixer.volume).toBe(0.9);
    expect(t.mixer.muted).toBe(false);
    expect(t.mixer.soloed).toBe(false);
  });
});

describe('freshProject', () => {
  it('uses the current schemaVersion', () => {
    expect(freshProject().schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
  });

  it('starts at 120 bpm with 4 tracks', () => {
    const p = freshProject();
    expect(p.bpm).toBe(120);
    expect(p.tracks).toHaveLength(4);
  });

  it('tracks are independent (mutating one does not affect another)', () => {
    const p = freshProject();
    p.tracks[0].engines.synth.osc1Coarse = 7;
    expect(p.tracks[1].engines.synth.osc1Coarse).toBe(SynthEngine.DEFAULT_PARAMS.osc1Coarse);
  });
});
```

- [ ] **Step 3: Run test, confirm it fails**

```bash
npx vitest run src/project/factory.test.ts
```
Expected: FAIL — `Cannot find module './factory'`.

- [ ] **Step 4: Implement `src/project/factory.ts`**

```ts
import { SynthEngine } from '../engine/SynthEngine';
import { KickEngine }  from '../engine/KickEngine';
import { HatEngine }   from '../engine/HatEngine';
import { SnareEngine } from '../engine/SnareEngine';
import { ClapEngine }  from '../engine/ClapEngine';
import type { Step } from '../sequencer/Sequencer';
import {
  type Project,
  type ProjectTrack,
  DEFAULT_MIXER_STATE,
  PROJECT_SCHEMA_VERSION,
} from './types';

export function freshStep(): Step {
  return {
    note: null,
    octave: 4,
    length: 1,
    velocity: 0.8,
    muted: false,
    isChord: false,
    chordType: 'maj',
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

export function freshProject(): Project {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    bpm: 120,
    tracks: [freshTrack(), freshTrack(), freshTrack(), freshTrack()],
  };
}
```

- [ ] **Step 5: Run tests, confirm they pass**

```bash
npx vitest run src/project/factory.test.ts
```
Expected: 10/10 tests pass.

- [ ] **Step 6: Run full check**

```bash
npm test && npx vue-tsc --noEmit && npx vite build
```
Expected: all green; total test count = 76 + 10 = 86.

- [ ] **Step 7: Commit + merge sub-branch**

```bash
git add src/project/factory.ts src/project/factory.test.ts
git commit -m "feat(project): freshProject/freshTrack/freshStep factories"

git checkout feature/project-model
git merge --no-ff feature/project-model-t4-factory -m "Merge T4: factory"
git branch -d feature/project-model-t4-factory
```

---

### Task 5: `src/project/mutations.ts` — pure track mutators

`clearTrack`, `shiftTrack`, `fillTrack` as plain functions over a `ProjectTrack`. The existing Sequencer methods remain unused but still present — they're removed in Task 9.

**Files:**
- Create: `src/project/mutations.ts`
- Create: `src/project/mutations.test.ts`

- [ ] **Step 1: Cut sub-branch**

```bash
git checkout feature/project-model
git checkout -b feature/project-model-t5-mutations
```

- [ ] **Step 2: Write the failing test**

Create `src/project/mutations.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { freshTrack, freshStep } from './factory';
import { clearTrack, shiftTrack, fillTrack } from './mutations';

describe('clearTrack', () => {
  it('resets every step to freshStep defaults', () => {
    const track = freshTrack();
    track.steps[0].note = 'C';
    track.steps[0].velocity = 0.3;
    track.steps[5].muted = true;
    track.steps[10].isChord = true;
    clearTrack(track);
    for (const s of track.steps) {
      expect(s).toEqual(freshStep());
    }
  });

  it('does not change track.engineType or track.engines', () => {
    const track = freshTrack();
    track.engineType = 'kick';
    track.engines.synth.osc1Coarse = 2;
    clearTrack(track);
    expect(track.engineType).toBe('kick');
    expect(track.engines.synth.osc1Coarse).toBe(2);
  });
});

describe('shiftTrack', () => {
  it('shifts left: first → last', () => {
    const track = freshTrack();
    track.steps[0].note = 'A';
    track.steps[1].note = 'B';
    shiftTrack(track, 'left');
    expect(track.steps[0].note).toBe('B');
    expect(track.steps[15].note).toBe('A');
  });

  it('shifts right: last → first', () => {
    const track = freshTrack();
    track.steps[15].note = 'Z';
    shiftTrack(track, 'right');
    expect(track.steps[0].note).toBe('Z');
    expect(track.steps[15].note).toBeNull();
  });

  it('preserves step length (still 16 after shift)', () => {
    const track = freshTrack();
    shiftTrack(track, 'left');
    expect(track.steps).toHaveLength(16);
    shiftTrack(track, 'right');
    expect(track.steps).toHaveLength(16);
  });
});

describe('fillTrack', () => {
  it('sets note="C" on every Nth step (interval 4 → indices 0,4,8,12)', () => {
    const track = freshTrack();
    fillTrack(track, 4);
    [0, 4, 8, 12].forEach(i => expect(track.steps[i].note).toBe('C'));
    [1, 2, 3, 5, 6, 7].forEach(i => expect(track.steps[i].note).toBeNull());
  });

  it('un-mutes filled steps', () => {
    const track = freshTrack();
    track.steps[0].muted = true;
    fillTrack(track, 4);
    expect(track.steps[0].muted).toBe(false);
  });

  it('resets chord state on filled steps', () => {
    const track = freshTrack();
    track.steps[0].isChord = true;
    track.steps[0].chordType = 'min';
    fillTrack(track, 4);
    expect(track.steps[0].isChord).toBe(false);
    expect(track.steps[0].chordType).toBe('maj');
  });
});
```

- [ ] **Step 3: Run test, confirm it fails**

```bash
npx vitest run src/project/mutations.test.ts
```
Expected: FAIL — `Cannot find module './mutations'`.

- [ ] **Step 4: Implement `src/project/mutations.ts`**

```ts
import type { ProjectTrack } from './types';
import { freshStep } from './factory';

export function clearTrack(track: ProjectTrack): void {
  for (let i = 0; i < track.steps.length; i++) {
    Object.assign(track.steps[i], freshStep());
  }
}

export function shiftTrack(track: ProjectTrack, direction: 'left' | 'right'): void {
  if (direction === 'left') {
    const first = track.steps.shift();
    if (first !== undefined) track.steps.push(first);
  } else {
    const last = track.steps.pop();
    if (last !== undefined) track.steps.unshift(last);
  }
}

export function fillTrack(track: ProjectTrack, interval: number): void {
  for (let i = 0; i < track.steps.length; i++) {
    if (i % interval === 0) {
      const step = track.steps[i];
      step.note = 'C';
      step.muted = false;
      step.velocity = 0.8;
      step.isChord = false;
      step.chordType = 'maj';
    }
  }
}
```

Why `Object.assign` instead of replacing the step object: Vue reactivity tracks the per-step proxy. Replacing the object would lose the existing watcher subscriptions. Mutating in place preserves identity.

- [ ] **Step 5: Run tests, confirm they pass**

```bash
npx vitest run src/project/mutations.test.ts
```
Expected: 8/8 tests pass.

- [ ] **Step 6: Run full check**

```bash
npm test && npx vue-tsc --noEmit && npx vite build
```
Expected: all green; total = 86 + 8 = 94.

- [ ] **Step 7: Commit + merge sub-branch**

```bash
git add src/project/mutations.ts src/project/mutations.test.ts
git commit -m "feat(project): pure-function clearTrack/shiftTrack/fillTrack"

git checkout feature/project-model
git merge --no-ff feature/project-model-t5-mutations -m "Merge T5: mutations"
git branch -d feature/project-model-t5-mutations
```

---

### Task 6: `src/project/migrations.ts` — `migrateToLatest`

Single-entry-point schema migration. V1 today; pattern in place for V2+.

**Files:**
- Create: `src/project/migrations.ts`
- Create: `src/project/migrations.test.ts`

- [ ] **Step 1: Cut sub-branch**

```bash
git checkout feature/project-model
git checkout -b feature/project-model-t6-migrations
```

- [ ] **Step 2: Write the failing test**

Create `src/project/migrations.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { migrateToLatest } from './migrations';
import { freshProject } from './factory';
import { PROJECT_SCHEMA_VERSION } from './types';

describe('migrateToLatest', () => {
  it('returns a fresh project for null input', () => {
    expect(migrateToLatest(null).schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
  });

  it('returns a fresh project for undefined input', () => {
    expect(migrateToLatest(undefined).schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
  });

  it('returns a fresh project for string input', () => {
    expect(migrateToLatest('not a project').schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
  });

  it('returns a fresh project for numeric input', () => {
    expect(migrateToLatest(42).schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
  });

  it('passes a valid V1 doc through unchanged', () => {
    const p = freshProject();
    expect(migrateToLatest(p)).toBe(p);
  });

  it('warns and returns fresh when schemaVersion is missing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = migrateToLatest({ bpm: 100, tracks: [] });
    expect(out.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('throws for an unknown future schemaVersion', () => {
    expect(() => migrateToLatest({ schemaVersion: 99, bpm: 100, tracks: [] }))
      .toThrowError(/Unknown project schemaVersion: 99/);
  });
});
```

- [ ] **Step 3: Run test, confirm it fails**

```bash
npx vitest run src/project/migrations.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/project/migrations.ts`**

```ts
import { type Project, PROJECT_SCHEMA_VERSION } from './types';
import { freshProject } from './factory';

// Single entry point. Given any value loaded from storage, return a project
// at the current schema version — or a freshProject() if the input is
// unrecognizable. Throws ONLY for a known-future version (which indicates the
// app was downgraded since the save was written; no safe recovery).
//
// Versioning policy (spec §6.1): bump only on breaking changes (rename,
// remove, semantic change). Additive changes are handled later by
// reconcileWithDefaults — not here.
export function migrateToLatest(raw: unknown): Project {
  if (typeof raw !== 'object' || raw === null) {
    return freshProject();
  }
  const v = (raw as { schemaVersion?: number }).schemaVersion;

  if (v === PROJECT_SCHEMA_VERSION) return raw as Project;

  if (typeof v === 'number') {
    throw new Error(
      `Unknown project schemaVersion: ${v}. App may be older than this save.`
    );
  }

  // Versioned-but-undefined (legacy / corruption / malformed)
  console.warn('Project missing schemaVersion, starting fresh');
  return freshProject();
}
```

- [ ] **Step 5: Run tests, confirm they pass**

```bash
npx vitest run src/project/migrations.test.ts
```
Expected: 7/7 tests pass.

- [ ] **Step 6: Run full check**

```bash
npm test && npx vue-tsc --noEmit && npx vite build
```
Expected: all green; total = 94 + 7 = 101.

- [ ] **Step 7: Commit + merge sub-branch**

```bash
git add src/project/migrations.ts src/project/migrations.test.ts
git commit -m "feat(project): migrateToLatest with versioned dispatch"

git checkout feature/project-model
git merge --no-ff feature/project-model-t6-migrations -m "Merge T6: migrations"
git branch -d feature/project-model-t6-migrations
```

---

### Task 7: `src/project/storage.ts` — reconciler + load + autosave

Both halves of the storage layer in one task: the reconciliation helpers (`reconcileSteps`, `reconcileWithDefaults`) and the public surface (`loadProject`, `installAutoSave`). Two test files per spec §7: `storage.test.ts` (load/save) and `reconcile.test.ts` (additive-change coverage).

**Files:**
- Create: `src/project/storage.ts`
- Create: `src/project/storage.test.ts`
- Create: `src/project/reconcile.test.ts`

- [ ] **Step 1: Cut sub-branch**

```bash
git checkout feature/project-model
git checkout -b feature/project-model-t7-storage
```

- [ ] **Step 2: Write the failing reconciler test**

Create `src/project/reconcile.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { reconcileWithDefaults } from './storage';
import { freshProject, freshTrack } from './factory';
import { SynthEngine } from '../engine/SynthEngine';
import { KickEngine } from '../engine/KickEngine';
import { PROJECT_SCHEMA_VERSION } from './types';

describe('reconcileWithDefaults', () => {
  it('fills a missing engine slot from that engine\'s DEFAULT_PARAMS', () => {
    const p = freshProject();
    delete (p.tracks[0].engines as any).kick;
    const reconciled = reconcileWithDefaults(p);
    expect(reconciled.tracks[0].engines.kick).toEqual(KickEngine.DEFAULT_PARAMS);
  });

  it('fills a missing field in an engine slot while preserving loaded fields', () => {
    const p = freshProject();
    delete (p.tracks[0].engines.synth as any).osc1Level;
    p.tracks[0].engines.synth.osc1Coarse = 2;
    const reconciled = reconcileWithDefaults(p);
    expect(reconciled.tracks[0].engines.synth.osc1Level).toBe(SynthEngine.DEFAULT_PARAMS.osc1Level);
    expect(reconciled.tracks[0].engines.synth.osc1Coarse).toBe(2);
  });

  it('fills missing ADSR fields while preserving present ones', () => {
    const p = freshProject();
    (p.tracks[0].engines.synth.ampEnv as any) = { a: 0.5 };
    const reconciled = reconcileWithDefaults(p);
    expect(reconciled.tracks[0].engines.synth.ampEnv.a).toBe(0.5);
    expect(reconciled.tracks[0].engines.synth.ampEnv.d).toBe(SynthEngine.DEFAULT_PARAMS.ampEnv.d);
    expect(reconciled.tracks[0].engines.synth.ampEnv.s).toBe(SynthEngine.DEFAULT_PARAMS.ampEnv.s);
    expect(reconciled.tracks[0].engines.synth.ampEnv.r).toBe(SynthEngine.DEFAULT_PARAMS.ampEnv.r);
  });

  it('fills a partial mixer', () => {
    const p = freshProject();
    (p.tracks[0].mixer as any) = { volume: 0.5 };
    const reconciled = reconcileWithDefaults(p);
    expect(reconciled.tracks[0].mixer.volume).toBe(0.5);
    expect(reconciled.tracks[0].mixer.muted).toBe(false);
    expect(reconciled.tracks[0].mixer.soloed).toBe(false);
  });

  it('passes unknown extra fields through (forward-compat)', () => {
    const p = freshProject();
    (p as any).futureField = 'hello';
    const reconciled: any = reconcileWithDefaults(p);
    expect(reconciled.futureField).toBe('hello');
  });

  it('reconcileSteps: length-1 loaded → returns length 16', () => {
    const p = freshProject();
    p.tracks[0].steps = [{ ...p.tracks[0].steps[0], note: 'X' }] as any;
    const reconciled = reconcileWithDefaults(p);
    expect(reconciled.tracks[0].steps).toHaveLength(16);
    expect(reconciled.tracks[0].steps[0].note).toBe('X');
    expect(reconciled.tracks[0].steps[1].note).toBeNull();
  });

  it('reconcileSteps: length-20 loaded → returns length 16 (extras dropped)', () => {
    const p = freshProject();
    const long = Array.from({ length: 20 }, (_, i) => ({ ...freshTrack().steps[0], note: `N${i}` }));
    p.tracks[0].steps = long as any;
    const reconciled = reconcileWithDefaults(p);
    expect(reconciled.tracks[0].steps).toHaveLength(16);
    expect(reconciled.tracks[0].steps[15].note).toBe('N15');
  });

  it('reconcileSteps: non-array → returns 16 fresh defaults', () => {
    const p = freshProject();
    (p.tracks[0] as any).steps = undefined;
    const reconciled = reconcileWithDefaults(p);
    expect(reconciled.tracks[0].steps).toHaveLength(16);
    expect(reconciled.tracks[0].steps.every(s => s.note === null)).toBe(true);
  });

  it('sets schemaVersion to current', () => {
    const reconciled = reconcileWithDefaults({} as any);
    expect(reconciled.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
  });
});
```

- [ ] **Step 3: Write the failing storage test**

Create `src/project/storage.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { reactive } from 'vue';
import { loadProject, installAutoSave } from './storage';
import { freshProject } from './factory';
import { PROJECT_SCHEMA_VERSION } from './types';

const STORAGE_KEY = 'fiddle:project';

function mockLocalStorage() {
  const store = new Map<string, string>();
  return {
    getItem: vi.fn((k: string) => store.has(k) ? store.get(k)! : null),
    setItem: vi.fn((k: string, v: string) => { store.set(k, v); }),
    removeItem: vi.fn((k: string) => { store.delete(k); }),
    clear: vi.fn(() => { store.clear(); }),
    _peek: () => Object.fromEntries(store),
  };
}

describe('loadProject', () => {
  let ls: ReturnType<typeof mockLocalStorage>;
  beforeEach(() => {
    ls = mockLocalStorage();
    vi.stubGlobal('localStorage', ls);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns freshProject when storage is empty', () => {
    const p = loadProject();
    expect(p.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    expect(p.bpm).toBe(120);
  });

  it('returns a restored project for a valid V1 doc', () => {
    const seed = freshProject();
    seed.bpm = 144;
    ls.setItem(STORAGE_KEY, JSON.stringify(seed));
    const p = loadProject();
    expect(p.bpm).toBe(144);
  });

  it('returns freshProject + warns for malformed JSON', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    ls.setItem(STORAGE_KEY, '{not json');
    const p = loadProject();
    expect(p.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('returns freshProject when getItem itself throws', () => {
    ls.getItem.mockImplementation(() => { throw new Error('sandbox'); });
    const p = loadProject();
    expect(p.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
  });

  it('reconciles a loaded doc against current defaults', () => {
    const partial = { schemaVersion: 1, bpm: 100, tracks: [{}, {}, {}, {}] };
    ls.setItem(STORAGE_KEY, JSON.stringify(partial));
    const p = loadProject();
    // Engines filled in from defaults
    expect(p.tracks[0].engines.synth).toBeDefined();
    expect(p.tracks[0].engines.kick).toBeDefined();
    // 16 steps materialized
    expect(p.tracks[0].steps).toHaveLength(16);
  });
});

describe('installAutoSave', () => {
  let ls: ReturnType<typeof mockLocalStorage>;
  beforeEach(() => {
    ls = mockLocalStorage();
    vi.stubGlobal('localStorage', ls);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('does not write immediately', () => {
    const p = reactive(freshProject());
    installAutoSave(p);
    expect(ls.setItem).not.toHaveBeenCalled();
  });

  it('writes once after debounce window when project mutates', async () => {
    const p = reactive(freshProject());
    installAutoSave(p);
    p.bpm = 140;
    await Promise.resolve();      // let Vue flush the watcher
    vi.advanceTimersByTime(500);
    expect(ls.setItem).toHaveBeenCalledTimes(1);
    const written = JSON.parse(ls.setItem.mock.calls[0][1] as string);
    expect(written.bpm).toBe(140);
  });

  it('coalesces a 200-mutation burst into one write', async () => {
    const p = reactive(freshProject());
    installAutoSave(p);
    for (let i = 0; i < 200; i++) {
      p.bpm = 100 + i;
      await Promise.resolve();
    }
    vi.advanceTimersByTime(500);
    expect(ls.setItem).toHaveBeenCalledTimes(1);
  });

  it('the dispose function stops further writes', async () => {
    const p = reactive(freshProject());
    const stop = installAutoSave(p);
    stop();
    p.bpm = 140;
    await Promise.resolve();
    vi.advanceTimersByTime(500);
    expect(ls.setItem).not.toHaveBeenCalled();
  });

  it('swallows setItem errors (does not crash)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    ls.setItem.mockImplementation(() => { throw new Error('quota'); });
    const p = reactive(freshProject());
    installAutoSave(p);
    p.bpm = 140;
    await Promise.resolve();
    expect(() => vi.advanceTimersByTime(500)).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
```

- [ ] **Step 4: Run tests, confirm they fail**

```bash
npx vitest run src/project/reconcile.test.ts src/project/storage.test.ts
```
Expected: FAIL — `Cannot find module './storage'`.

- [ ] **Step 5: Implement `src/project/storage.ts`**

```ts
import { toRaw, watch, type WatchStopHandle } from 'vue';
import { deepMerge } from '../utils/deepMerge';
import { debounce } from '../utils/debounce';
import { SynthEngine } from '../engine/SynthEngine';
import { KickEngine }  from '../engine/KickEngine';
import { HatEngine }   from '../engine/HatEngine';
import { SnareEngine } from '../engine/SnareEngine';
import { ClapEngine } from '../engine/ClapEngine';
import type { Step } from '../sequencer/Sequencer';
import {
  type Project,
  type ProjectTrack,
  DEFAULT_MIXER_STATE,
  PROJECT_SCHEMA_VERSION,
} from './types';
import { freshProject, freshTrack, freshStep } from './factory';
import { migrateToLatest } from './migrations';

const STORAGE_KEY = 'fiddle:project';
const SAVE_DEBOUNCE_MS = 500;
const STEP_COUNT = 16;

function reconcileSteps(loaded: unknown, defaults: Step[]): Step[] {
  if (!Array.isArray(loaded)) {
    return defaults.map(s => ({ ...s }));
  }
  return defaults.map((def, i) => {
    const ov = loaded[i];
    return ov ? deepMerge(def, ov) : { ...def };
  });
}

function reconcileTrack(loaded: unknown): ProjectTrack {
  const fresh = freshTrack();
  const t = (typeof loaded === 'object' && loaded !== null) ? (loaded as Partial<ProjectTrack>) : {};
  const loadedEngines = (t as any).engines ?? {};

  return {
    engineType: (t.engineType as ProjectTrack['engineType']) ?? fresh.engineType,
    engines: {
      synth: deepMerge(SynthEngine.DEFAULT_PARAMS, loadedEngines.synth),
      kick:  deepMerge(KickEngine.DEFAULT_PARAMS,  loadedEngines.kick),
      hat:   deepMerge(HatEngine.DEFAULT_PARAMS,   loadedEngines.hat),
      snare: deepMerge(SnareEngine.DEFAULT_PARAMS, loadedEngines.snare),
      clap:  deepMerge(ClapEngine.DEFAULT_PARAMS,  loadedEngines.clap),
    },
    mixer: deepMerge(DEFAULT_MIXER_STATE, t.mixer),
    playMode: (t.playMode as ProjectTrack['playMode']) ?? fresh.playMode,
    steps: reconcileSteps(t.steps, fresh.steps),
  };
}

export function reconcileWithDefaults(loaded: unknown): Project {
  const fresh = freshProject();
  const p = (typeof loaded === 'object' && loaded !== null) ? (loaded as any) : {};
  const tracks = Array.isArray(p.tracks) ? p.tracks : [];

  const out: Project = {
    ...p,                                              // forward-compat: keep unknown extras
    schemaVersion: PROJECT_SCHEMA_VERSION,
    bpm: typeof p.bpm === 'number' ? p.bpm : fresh.bpm,
    tracks: [0, 1, 2, 3].map(i => reconcileTrack(tracks[i])) as Project['tracks'],
  };

  return out;
}

export function loadProject(): Project {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return freshProject();
  }
  if (raw === null) return freshProject();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.warn('Project load failed (invalid JSON), starting fresh:', e);
    return freshProject();
  }

  const migrated = migrateToLatest(parsed);
  return reconcileWithDefaults(migrated);
}

export function installAutoSave(project: Project): () => void {
  const save = debounce(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(toRaw(project)));
    } catch (e) {
      console.warn('Project save failed:', e);
    }
  }, SAVE_DEBOUNCE_MS);

  const stop: WatchStopHandle = watch(project, save, { deep: true });

  return () => {
    save.cancel();
    stop();
  };
}
```

A note on `freshStep` not being imported above: `reconcileSteps` derives fresh steps via `defaults.map(s => ({ ...s }))`, where `defaults` already comes from `freshTrack().steps`. No separate import needed.

- [ ] **Step 6: Run tests, confirm they pass**

```bash
npx vitest run src/project/reconcile.test.ts src/project/storage.test.ts
```
Expected: 19/19 tests pass (9 reconcile + 10 storage).

- [ ] **Step 7: Run full check**

```bash
npm test && npx vue-tsc --noEmit && npx vite build
```
Expected: all green; total = 101 + 19 = 120.

- [ ] **Step 8: Commit + merge sub-branch**

```bash
git add src/project/storage.ts src/project/storage.test.ts src/project/reconcile.test.ts
git commit -m "feat(project): storage layer — load, save, reconcile

loadProject parses + migrates + reconciles against engine DEFAULT_PARAMS.
installAutoSave watches the project deep + debounces 500ms writes to
localStorage. reconcileWithDefaults makes additive schema changes free —
new fields fall through to defaults without a version bump."

git checkout feature/project-model
git merge --no-ff feature/project-model-t7-storage -m "Merge T7: storage"
git branch -d feature/project-model-t7-storage
```

---

### Task 8: `src/project/index.ts` — barrel

Public surface for the project module.

**Files:**
- Create: `src/project/index.ts`

- [ ] **Step 1: Cut sub-branch**

```bash
git checkout feature/project-model
git checkout -b feature/project-model-t8-barrel
```

- [ ] **Step 2: Create `src/project/index.ts`**

```ts
export type {
  Project,
  ProjectTrack,
  EngineParamsMap,
  EngineType,
  MixerState,
} from './types';
export {
  PROJECT_SCHEMA_VERSION,
  DEFAULT_MIXER_STATE,
  activeParams,
} from './types';
export { freshProject, freshTrack, freshStep } from './factory';
export { clearTrack, shiftTrack, fillTrack } from './mutations';
export { loadProject, installAutoSave, reconcileWithDefaults } from './storage';
export { migrateToLatest } from './migrations';
```

- [ ] **Step 3: Run full check**

```bash
npm test && npx vue-tsc --noEmit && npx vite build
```
Expected: all 120 tests pass.

- [ ] **Step 4: Commit + merge sub-branch**

```bash
git add src/project/index.ts
git commit -m "feat(project): public barrel"

git checkout feature/project-model
git merge --no-ff feature/project-model-t8-barrel -m "Merge T8: barrel"
git branch -d feature/project-model-t8-barrel
```

---

## Phase C — Integration (rip-and-replace the runtime)

### Task 9: Refactor `useSynth` + `Sequencer` to use `project` as the single source of truth

This is the big lift. After this task:
- `useSynth.ts` exposes `project` (reactive root) instead of `trackStates`.
- `Sequencer.ts` no longer owns `tracks`, `bpm`, or the mutation helpers.
- `App.vue` calls `clearTrack/shiftTrack/fillTrack` from `src/project/mutations` and v-models `bpm` against `useSynth`'s new `bpm` writable computed.
- All existing tests pass with updated paths.

**Files:**
- Modify: `src/sequencer/Sequencer.ts` (drop tracks/bpm/clearTrack/shiftTrack/fillTrack; new start sig)
- Modify: `src/sequencer/Sequencer.test.ts` (update call sites; tests for removed methods are deleted because the tests moved to `mutations.test.ts` in T5)
- Modify: `src/composables/useSynth.ts` (replace trackStates with project; install autosave; update trackParam paths; add bpm computed; remove TrackState type)
- Modify: `src/composables/useSynth.test.ts` (path updates)
- Modify: `src/engine/TrackMixer.test.ts` (path updates)
- Modify: `src/App.vue` (use project mutations; bpm v-model)
- Modify: `src/components/TrackMixer.vue` (TrackState import → ProjectTrack from `../project`)

This task has more steps than the others — each is still small.

- [ ] **Step 1: Cut sub-branch**

```bash
git checkout feature/project-model
git checkout -b feature/project-model-t9-integration
```

- [ ] **Step 2: Refactor `Sequencer.ts`**

Replace the entire file with:

```ts
import { markRaw } from 'vue';

export interface Step {
  note: string | null;
  octave: number;
  length: number;         // duration in ticks (16th notes)
  velocity: number;       // 0..1
  muted: boolean;
  isChord?: boolean;
  chordType?: string;
}

// Scheduler bookkeeping that doesn't need Vue reactivity. Bundled into one
// markRaw'd object so `reactive(new Sequencer())` skips proxying these fields.
// Touched ~7x per setInterval tick — without markRaw that's ~120ms/min of
// pointless proxy-trap overhead during playback.
interface SchedulerInternals {
  currentStep: number;
  timer: any;
  // Absolute count of steps scheduled since the last anchor (lets us compute
  // step times without floating-point drift over thousands of steps).
  nextStepIndex: number;
  // The audio-clock time at which scheduleStartTime + 0*stepTime = step 0.
  scheduleStartTime: number;
  // Last BPM observed; used to detect mid-playback tempo changes.
  lastBpm: number;
}

export class Sequencer {
  // Public reactive surface — UI binds to this.
  isPlaying = false;

  // Scheduler internals — non-reactive. Access via `this.internals.X`.
  private internals: SchedulerInternals = markRaw({
    currentStep: 0,
    timer: null,
    nextStepIndex: 0,
    scheduleStartTime: 0,
    lastBpm: 120,
  });

  start(
    ctx: AudioContext,
    getBpm: () => number,
    onStep: (stepIndex: number, time: number) => void,
  ): void {
    if (this.isPlaying) return;
    this.isPlaying = true;

    const s = this.internals;
    s.currentStep = 0;
    s.nextStepIndex = 0;
    s.scheduleStartTime = ctx.currentTime + 0.1; // 0.1s lookahead absorbs JS jitter
    s.lastBpm = getBpm();

    s.timer = setInterval(() => {
      const bpm = getBpm();
      // If BPM changed mid-play, rebase the anchor to the last scheduled step's
      // time so the very next step uses the new stepTime forward.
      if (bpm !== s.lastBpm) {
        if (s.nextStepIndex > 0) {
          const oldStepTime = (60 / s.lastBpm) / 4;
          const lastScheduledTime = s.scheduleStartTime + (s.nextStepIndex - 1) * oldStepTime;
          s.scheduleStartTime = lastScheduledTime;
          s.nextStepIndex = 1;
        }
        s.lastBpm = bpm;
      }

      const stepTime = (60 / bpm) / 4;
      const lookaheadTime = ctx.currentTime + 0.1;

      let nextStepTime = s.scheduleStartTime + s.nextStepIndex * stepTime;
      while (nextStepTime < lookaheadTime) {
        onStep(s.currentStep, nextStepTime);
        s.currentStep = (s.currentStep + 1) % 16;
        s.nextStepIndex += 1;
        nextStepTime = s.scheduleStartTime + s.nextStepIndex * stepTime;
      }
    }, 25);
  }

  stop(): void {
    this.isPlaying = false;
    const s = this.internals;
    if (s.timer) {
      clearInterval(s.timer);
      s.timer = null;
    }
  }
}
```

Note: `Track` interface and `clearTrack/shiftTrack/fillTrack` methods are deleted. `Step` interface stays (it's the public contract for the `onStep` callback signature).

- [ ] **Step 3: Update `Sequencer.test.ts`**

Open `src/sequencer/Sequencer.test.ts` and:
- Remove any tests covering `clearTrack`, `shiftTrack`, `fillTrack` — they were moved to `mutations.test.ts` in T5.
- Update any `sequencer.start(ctx, callback)` calls to `sequencer.start(ctx, getBpm, onStep)`. If a test used `sequencer.bpm = X` to drive timing, replace with `let bpm = X; sequencer.start(ctx, () => bpm, ...)` and mutate the local `bpm` to test rebase behavior.

Run tests to confirm green:

```bash
npx vitest run src/sequencer/Sequencer.test.ts
```

- [ ] **Step 4: Refactor `useSynth.ts`**

This is the biggest single edit. The key changes:

1. Delete `trackStates`, the inline `TrackState` interface, and the `sequencer = reactive(new Sequencer())` initialization of fields tracks/bpm.
2. Import `project` machinery from `'../project'`.
3. Initialize `const project = reactive(loadProject())` at module scope; install autosave immediately: `installAutoSave(project)`.
4. Re-shape `audioState`-related code to operate on `project` instead of `trackStates`:
    - `buildAudioState`'s engine-init loop reads `project.tracks[i].engineType` and `project.tracks[i].engines[engineType]`.
    - The per-slice watcher's getter changes from `() => snapshot(trackStates[i][slice])` to `() => snapshot(project.tracks[i].engines[slice])`.
    - The `engineType` watcher reads `() => project.tracks[i].engineType`.
    - The `mixer` watcher reads `() => project.tracks[i].mixer`.
5. `trackParam` rewrites its `get`/`set` to traverse `project.tracks[activeTrackIndex.value].engines[engine][param]`.
6. Add a top-level `bpm` writable computed: `computed({ get: () => project.bpm, set: v => { project.bpm = v; } })`.
7. Update `togglePlay`'s `sequencer.start(state.ctx, callback)` to `sequencer.start(state.ctx, () => project.bpm, onStep)`. The `onStep` body reads from `project.tracks[i].steps[stepIndex]` instead of `sequencer.tracks[i].steps[stepIndex]`.
8. Update `playMode` writable to read from `project.tracks[activeTrackIndex.value].playMode`.
9. Remove the back-compat re-exports added in T3 (`EngineType`, `MixerState`, `DEFAULT_MIXER_STATE`) — callers now import directly from `'../project'`. Update any callers below (App.vue if it imports those) in step 6.
10. Delete the `TrackState` type entirely.
11. Return shape: add `project` and `bpm` to the return; remove `trackStates`.

Below is the complete intended structure (pseudocode for the diff shape; preserve all existing comments and ARCHITECTURE.md cross-references):

```ts
import { ref, watch, computed, effectScope, shallowRef, reactive,
         type WritableComputedRef, type EffectScope, type ComputedRef } from 'vue';
import { SoundEngine } from '../engine/types';
import { SynthEngine } from '../engine/SynthEngine';
import { KickEngine }  from '../engine/KickEngine';
import { HatEngine }   from '../engine/HatEngine';
import { SnareEngine } from '../engine/SnareEngine';
import { ClapEngine }  from '../engine/ClapEngine';
import { Sequencer } from '../sequencer/Sequencer';
import { noteToFreq } from '../utils/notes';
import { resolveChordFreqs } from '../utils/chords';
import {
  type Project,
  type ProjectTrack,
  type EngineType,
  type EngineParamsMap,
  loadProject,
  installAutoSave,
} from '../project';

// === Pure data state — built from localStorage (or fresh) at module init. ===
const project: Project = reactive(loadProject());
installAutoSave(project);   // debounced localStorage writes

const sequencer = reactive(new Sequencer());

// === Engine factories — unchanged ===
const ENGINE_SWAP_FADE_SECONDS = 0.02;
const ENGINE_SLICES: EngineType[] = ['synth', 'kick', 'hat', 'snare', 'clap'];

const engineFactories: Record<EngineType,
  (ctx: AudioContext, dest: AudioNode) => SoundEngine> = {
  synth: (ctx, dest) => new SynthEngine(ctx, dest),
  kick:  (ctx, dest) => new KickEngine(ctx, dest),
  hat:   (ctx, dest) => new HatEngine(ctx, dest),
  snare: (ctx, dest) => new SnareEngine(ctx, dest),
  clap:  (ctx, dest) => new ClapEngine(ctx, dest),
};

// === Audio state — lazy, built on first user gesture (post-A1) ===
interface AudioState {
  ctx: AudioContext;
  analyser: AnalyserNode;
  trackGains: GainNode[];
  engines: SoundEngine[];
  scope: EffectScope;
}

const audioState = shallowRef<AudioState | null>(null);

// Slider→linear gain conversion stays here (U4 audio math).
function sliderToLinearGain(slider: number): number {
  if (slider <= 0) return 0;
  const db = -54 + slider * 60;
  return Math.pow(10, db / 20);
}

function snapshot<T>(slice: T): T {
  return JSON.parse(JSON.stringify(slice));
}

function diffParams<T extends Record<string, unknown>>(
  newVal: T, oldVal: T | undefined,
): Partial<T> | null {
  if (!oldVal) return null;
  const changed: Partial<T> = {};
  let any = false;
  for (const key of Object.keys(newVal) as Array<keyof T>) {
    const a = newVal[key];
    const b = oldVal[key];
    if (a === b) continue;
    if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
      if (JSON.stringify(a) === JSON.stringify(b)) continue;
    }
    changed[key] = a as T[keyof T];
    any = true;
  }
  return any ? changed : null;
}

function buildAudioState(): AudioState {
  const ctx = new AudioContext();

  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.setValueAtTime(-12, ctx.currentTime);
  compressor.knee.setValueAtTime(30, ctx.currentTime);
  compressor.ratio.setValueAtTime(12, ctx.currentTime);
  compressor.attack.setValueAtTime(0.003, ctx.currentTime);
  compressor.release.setValueAtTime(0.25, ctx.currentTime);

  const masterGain = ctx.createGain();
  masterGain.gain.setValueAtTime(0.6, ctx.currentTime);

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;

  compressor.connect(masterGain);
  masterGain.connect(analyser);
  analyser.connect(ctx.destination);

  const trackGains: GainNode[] = Array(4).fill(null).map(() => {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.8, ctx.currentTime);
    g.connect(compressor);
    return g;
  });

  const engines: SoundEngine[] = [];

  const syncTrackToEngine = (i: number) => {
    const track = project.tracks[i];
    const targetType = track.engineType;
    const existing = engines[i];

    if (!existing || existing.engineType !== targetType) {
      if (existing) {
        trackGains[i].gain.setTargetAtTime(0, ctx.currentTime, ENGINE_SWAP_FADE_SECONDS / 3);
        const oldEngine = existing;
        setTimeout(() => {
          oldEngine.dispose();
          updateMixerGains();
        }, (ENGINE_SWAP_FADE_SECONDS * 1000) + 5);
      }
      engines[i] = engineFactories[targetType](ctx, trackGains[i]);
    }

    engines[i].applyParams(track.engines[targetType] as Record<string, any>);
  };

  const updateMixerGains = () => {
    const anySoloed = project.tracks.some(t => t.mixer.soloed);
    for (let i = 0; i < 4; i++) {
      const track = project.tracks[i];
      const audible = anySoloed
        ? (track.mixer.soloed && !track.mixer.muted)
        : !track.mixer.muted;
      const targetGain = audible ? sliderToLinearGain(track.mixer.volume) : 0;
      trackGains[i].gain.setTargetAtTime(targetGain, ctx.currentTime, 0.015);
    }
  };

  for (let i = 0; i < 4; i++) syncTrackToEngine(i);
  updateMixerGains();

  const scope = effectScope(true);
  scope.run(() => {
    for (let i = 0; i < 4; i++) {
      watch(
        () => project.tracks[i].engineType,
        () => syncTrackToEngine(i),
      );

      for (const slice of ENGINE_SLICES) {
        watch(
          () => snapshot(project.tracks[i].engines[slice]),
          (newVal, oldVal) => {
            if (project.tracks[i].engineType !== slice) return;
            const changed = diffParams(newVal as Record<string, unknown>, oldVal as Record<string, unknown>);
            if (changed) engines[i].applyParams(changed);
          },
        );
      }

      watch(
        () => project.tracks[i].mixer,
        () => updateMixerGains(),
        { deep: true },
      );
    }
  });

  return { ctx, analyser, trackGains, engines, scope };
}

function ensureAudio(): AudioState {
  if (!audioState.value) audioState.value = buildAudioState();
  return audioState.value;
}

export function disposeSynth() {
  const state = audioState.value;
  if (!state) return;
  state.scope.stop();
  for (const engine of state.engines) engine.dispose();
  state.ctx.close().catch(() => { /* may already be closed */ });
  audioState.value = null;
}

export function useSynth() {
  const currentStep = ref(-1);
  const activeTrackIndex = ref<number | null>(null);
  const waveforms: OscillatorType[] = ['sine', 'square', 'sawtooth', 'triangle'];

  function trackParam<K extends keyof EngineParamsMap, P extends keyof EngineParamsMap[K]>(
    engine: K, param: P, fallback: EngineParamsMap[K][P],
  ): WritableComputedRef<EngineParamsMap[K][P]> {
    return computed({
      get: () => activeTrackIndex.value !== null
        ? project.tracks[activeTrackIndex.value].engines[engine][param]
        : fallback,
      set: (val: EngineParamsMap[K][P]) => {
        if (activeTrackIndex.value !== null) {
          project.tracks[activeTrackIndex.value].engines[engine][param] = val;
        }
      },
    });
  }

  const engineType = computed({
    get: () => activeTrackIndex.value !== null
      ? project.tracks[activeTrackIndex.value].engineType
      : 'synth' as EngineType,
    set: (val: EngineType) => {
      if (activeTrackIndex.value !== null) {
        project.tracks[activeTrackIndex.value].engineType = val;
      }
    },
  });

  const playMode = computed({
    get: () => activeTrackIndex.value !== null
      ? project.tracks[activeTrackIndex.value].playMode
      : 'mono' as const,
    set: (val: 'mono' | 'chord') => {
      if (activeTrackIndex.value !== null) {
        project.tracks[activeTrackIndex.value].playMode = val;
      }
    },
  });

  const bpm = computed({
    get: () => project.bpm,
    set: (v: number) => { project.bpm = v; },
  });

  // (Per-engine knob bindings — same shape as before, but trackParam now reads
  // from project.tracks[i].engines[...]. List unchanged from prior version.)
  const osc1Type   = trackParam('synth', 'osc1Type', 'sawtooth' as OscillatorType);
  const osc2Type   = trackParam('synth', 'osc2Type', 'sawtooth' as OscillatorType);
  const osc1Coarse = trackParam('synth', 'osc1Coarse', 0);
  const osc1Fine   = trackParam('synth', 'osc1Fine', 0);
  const osc2Coarse = trackParam('synth', 'osc2Coarse', 0);
  const osc2Fine   = trackParam('synth', 'osc2Fine', 0);
  const osc1Level  = trackParam('synth', 'osc1Level', 0.5);
  const osc2Level  = trackParam('synth', 'osc2Level', 0.5);
  const filterCutoff   = trackParam('synth', 'filterCutoff', 2000);
  const filterRes      = trackParam('synth', 'filterRes', 1);
  const filterEnvAmount = trackParam('synth', 'filterEnvAmount', 2.4);
  const filterEnv = trackParam('synth', 'filterEnv', { a: 0.01, d: 0.2, s: 0.5, r: 0.5 });
  const ampEnv    = trackParam('synth', 'ampEnv',    { a: 0.01, d: 0.2, s: 0.5, r: 0.5 });

  const kickTune  = trackParam('kick',  'tune', 55);
  const kickDecay = trackParam('kick',  'decay', 0.3);
  const kickClick = trackParam('kick',  'click', 0.5);

  const hatDecay    = trackParam('hat', 'decay', 0.15);
  const hatTone     = trackParam('hat', 'tone', 8000);
  const hatMetallic = trackParam('hat', 'metallic', 0.5);

  const snareTune   = trackParam('snare', 'tune', 180);
  const snareDecay  = trackParam('snare', 'decay', 0.25);
  const snareSnappy = trackParam('snare', 'snappy', 0.5);

  const clapDecay  = trackParam('clap', 'decay', 0.25);
  const clapTone   = trackParam('clap', 'tone', 1000);
  const clapSloppy = trackParam('clap', 'sloppy', 0.015);

  const shortestActiveNoteDuration = computed<number | null>(() => {
    if (activeTrackIndex.value === null) return null;
    const track = project.tracks[activeTrackIndex.value];
    if (!track) return null;
    const activeSteps = track.steps.filter(s => s.note !== null && !s.muted);
    if (activeSteps.length === 0) return null;
    const tickDuration = (60 / project.bpm) / 4;
    const minTicks = Math.min(...activeSteps.map(s => s.length));
    return minTicks * tickDuration;
  });

  const analyser: ComputedRef<AnalyserNode | null>  = computed(() => audioState.value?.analyser ?? null);
  const trackGains: ComputedRef<GainNode[] | null>  = computed(() => audioState.value?.trackGains ?? null);

  const togglePlay = () => {
    const state = ensureAudio();
    if (state.ctx.state === 'suspended') state.ctx.resume();

    if (sequencer.isPlaying) {
      sequencer.stop();
      currentStep.value = -1;
    } else {
      sequencer.start(state.ctx, () => project.bpm, (stepIndex, time) => {
        currentStep.value = stepIndex;
        for (let i = 0; i < 4; i++) {
          const track = project.tracks[i];
          const step = track.steps[stepIndex];
          if (step.note && !step.muted) {
            const engineTypeI = track.engineType;
            if (engineTypeI === 'synth') {
              const currentPlayMode = track.playMode || 'mono';
              const tickDuration = (60 / project.bpm) / 4;
              const duration = step.length * tickDuration;
              if (currentPlayMode === 'chord') {
                const freqs = resolveChordFreqs(step.note, step.chordType || 'maj', step.octave);
                state.engines[i].trigger(freqs, duration, time, step.velocity);
              } else {
                const freq = noteToFreq(step.note, step.octave);
                state.engines[i].trigger(freq, duration, time, step.velocity);
              }
            } else {
              // Drums: fire-and-forget; freq/duration are ignored by drum engines (U6).
              state.engines[i].trigger(0, 0, time, step.velocity);
            }
          }
        }
      });
    }
  };

  const selectTrack = (index: number | null) => { activeTrackIndex.value = index; };
  const getTrackEngineType = (index: number): EngineType => project.tracks[index].engineType;

  return {
    project,                                       // NEW: single source of truth
    sequencer,
    bpm,                                           // NEW: writable computed against project.bpm
    analyser,
    trackGains,
    activeTrackIndex,
    currentStep,
    waveforms,
    engineType,
    playMode,
    osc1Type, osc2Type, osc1Coarse, osc1Fine, osc2Coarse, osc2Fine,
    osc1Level, osc2Level, filterCutoff, filterRes, filterEnvAmount, filterEnv, ampEnv,
    kickTune, kickDecay, kickClick,
    hatDecay, hatTone, hatMetallic,
    snareTune, snareDecay, snareSnappy,
    clapDecay, clapTone, clapSloppy,
    shortestActiveNoteDuration,
    togglePlay,
    selectTrack,
    getTrackEngineType,
    ensureAudio,
  };
}
```

Notes:
- The exported `trackStates` is GONE. The exported back-compat type/value re-exports (`EngineType`, `MixerState`, `DEFAULT_MIXER_STATE` from T3) are GONE. The `TrackState` type is GONE.
- Anywhere else in the codebase that imported them from `'../composables/useSynth'` now needs to import from `'../project'`. Find those in step 5.

- [ ] **Step 5: Update other importers of relocated types**

Run a grep to find anyone still importing `EngineType`, `MixerState`, `TrackState`, or `DEFAULT_MIXER_STATE` from `'../composables/useSynth'` or `'./composables/useSynth'`:

```bash
grep -rn "from.*composables/useSynth" src/ | grep -E "(EngineType|MixerState|TrackState|DEFAULT_MIXER_STATE)"
```

Expected importers based on the codebase: `TrackMixer.vue` (already updated in T3 for `DEFAULT_MIXER_STATE` but still imports `TrackState`). Update each:

In `src/components/TrackMixer.vue`, change:
```ts
import { DEFAULT_MIXER_STATE } from '../project/types';
import type { TrackState } from '../composables/useSynth';
```
to:
```ts
import { DEFAULT_MIXER_STATE, type ProjectTrack } from '../project';
```

And replace the prop type `trackStates: TrackState[]` with `trackStates: ProjectTrack[]` — note we keep the *prop name* `trackStates` in `TrackMixer.vue` for now to minimize App.vue diff. The contents are `ProjectTrack[]` now.

- [ ] **Step 6: Update `App.vue` — bpm v-model + mutation call sites**

Two changes in `src/App.vue`:

(a) BPM v-model: where App.vue currently writes `sequencer.bpm = X` or has `<input v-model="sequencer.bpm">`, change to use the new `bpm` from `useSynth`. Find the spot in App.vue's `<script>` destructuring and add `bpm` to the destructure, then use `v-model="bpm"` on the BPM input.

(b) Mutation calls: today `App.vue` calls `sequencer.clearTrack(id)`, `sequencer.shiftTrack(...)`, `sequencer.fillTrack(...)`. Replace with project mutations:
```ts
import { clearTrack as clearProjectTrack,
         shiftTrack as shiftProjectTrack,
         fillTrack  as fillProjectTrack } from './project';

// in the handlers:
const onClear = (trackId: number) => clearProjectTrack(project.tracks[trackId]);
const onShift = ({ trackId, direction }: { trackId: number; direction: 'left'|'right' }) =>
  shiftProjectTrack(project.tracks[trackId], direction);
const onFill = ({ trackId, interval }: { trackId: number; interval: number }) =>
  fillProjectTrack(project.tracks[trackId], interval);
```

Where `project` is destructured from `useSynth()`'s return (add `project` to the destructure).

The Tracker emits `(e: 'clear', trackId)` etc. — these handler shapes are unchanged.

- [ ] **Step 7: Update `useSynth.test.ts`**

In `src/composables/useSynth.test.ts`, find every reference to `trackStates` and rewrite to `project.tracks`. For example:
- `synthData.trackStates[0].synth.filterCutoff = 1500` → `synthData.project.tracks[0].engines.synth.filterCutoff = 1500`
- Disposal: `disposeSynth()` between tests still works.

Run the file:
```bash
npx vitest run src/composables/useSynth.test.ts
```
Expected: still 3/3 pass (or whatever the existing count is).

- [ ] **Step 8: Update `TrackMixer.test.ts`**

In `src/engine/TrackMixer.test.ts`, find every reference to `trackStates` and rewrite to `project.tracks`. The `mixer` access pattern stays the same:
- `synthData.trackStates[0].mixer.volume = 0.5` → `synthData.project.tracks[0].mixer.volume = 0.5`
- `synthData.trackStates[0].mixer.muted = true` → `synthData.project.tracks[0].mixer.muted = true`

Run the file:
```bash
npx vitest run src/engine/TrackMixer.test.ts
```
Expected: all 7 mixer tests pass.

- [ ] **Step 9: Clear stale localStorage from prior runs (test isolation)**

The new module-init now calls `loadProject()` at import time. Tests that import `useSynth` repeatedly across the suite may see leaked state from earlier tests. Add to `src/composables/useSynth.test.ts` (and other affected files) a `beforeEach` (or `beforeAll`) that clears the storage key:

```ts
beforeEach(() => {
  try { localStorage.removeItem('fiddle:project'); } catch {}
});
```

And ensure `vi.resetModules()` is called before each test that wants a fresh module-scope `project`. The existing tests use `disposeSynth()` between tests but that doesn't reset `project` itself. For tests that mutate `project`, reset module state:

```ts
beforeEach(async () => {
  try { localStorage.removeItem('fiddle:project'); } catch {}
  vi.resetModules();
  const mod = await import('../composables/useSynth');
  useSynth = mod.useSynth;
  disposeSynth = mod.disposeSynth;
});
```

This pattern only matters where tests previously relied on a clean module-scope. If the existing tests already pass without this, leave them alone.

- [ ] **Step 10: Run the full suite**

```bash
npm test
```
Expected: all green. New count = 120 + (Sequencer tests survived) + (no test removed because mutation tests already moved in T5). Around 120 total, give or take a few removed scheduling-only-affected ones.

- [ ] **Step 11: Type-check + build**

```bash
npx vue-tsc --noEmit && npx vite build
```
Expected: clean.

- [ ] **Step 12: Manual browser verification**

Start the dev server and verify in a browser:

```bash
npm run dev
```

Walk through:
- **Fresh load (cleared localStorage)** — App opens with 120 BPM, four synth tracks at default, no steps lit.
- **Knob turn** — turn any knob; wait ~1 sec; refresh page; knob value is preserved.
- **Engine swap roundtrip** — change track 0 to kick; turn the Tune knob; change back to synth; the synth's filter cutoff for that track is what you left it at.
- **Step toggle + persistence** — toggle some steps; refresh; pattern restored.
- **Play** — Play works; oscilloscope shows waveform; BPM changes take effect smoothly.
- **Open DevTools → Application → localStorage** — see `fiddle:project` key with the serialized JSON.

If anything's wrong, halt and report rather than committing.

- [ ] **Step 13: Commit + merge sub-branch**

```bash
git add src/sequencer/Sequencer.ts src/sequencer/Sequencer.test.ts \
        src/composables/useSynth.ts src/composables/useSynth.test.ts \
        src/engine/TrackMixer.test.ts \
        src/App.vue src/components/TrackMixer.vue
git commit -m "refactor: project replaces trackStates; Sequencer becomes a ticker

useSynth's reactive root is now a single Project doc loaded from localStorage
(or freshProject() if empty), with debounced auto-save. Sequencer no longer
owns tracks or bpm — start(ctx, getBpm, onStep) is its full contract.
Track mutations (clear/shift/fill) call into src/project/mutations. All
existing tests pass with updated access paths.

Implements A3 (tagged-union via dense engines map + activeParams accessor)
and the persistence half of F1 (auto-save, restore-on-load).
Spec: docs/superpowers/specs/2026-05-23-project-model-design.md"

git checkout feature/project-model
git merge --no-ff feature/project-model-t9-integration -m "Merge T9: project as single source of truth"
git branch -d feature/project-model-t9-integration
```

---

### Task 10: Integration smoke test for boot-time load + autosave

One new test that exercises the full boot path: seed localStorage, reset modules, import useSynth, verify state matches the seed, mutate a knob, advance fake timers, verify localStorage reflects the change.

**Files:**
- Modify: `src/composables/useSynth.test.ts` (add one new test case)

- [ ] **Step 1: Cut sub-branch**

```bash
git checkout feature/project-model
git checkout -b feature/project-model-t10-integration-test
```

- [ ] **Step 2: Add the integration test**

Append to `src/composables/useSynth.test.ts`:

```ts
describe('Project boot integration', () => {
  beforeEach(() => {
    try { localStorage.removeItem('fiddle:project'); } catch {}
    vi.resetModules();
  });

  it('loads a seeded V1 project from localStorage on first useSynth call', async () => {
    const seed = {
      schemaVersion: 1 as const,
      bpm: 144,
      tracks: [/* 4 partial tracks — reconciler fills in defaults */
        { engineType: 'synth', engines: { synth: { filterCutoff: 1234 } } },
        {}, {}, {},
      ],
    };
    localStorage.setItem('fiddle:project', JSON.stringify(seed));

    const { useSynth: useSynthFresh } = await import('../composables/useSynth');
    const synth = useSynthFresh();
    expect(synth.project.bpm).toBe(144);
    expect(synth.project.tracks[0].engines.synth.filterCutoff).toBe(1234);
  });

  it('persists a knob mutation to localStorage after debounce', async () => {
    vi.useFakeTimers();
    const { useSynth: useSynthFresh } = await import('../composables/useSynth');
    const synth = useSynthFresh();
    synth.project.tracks[0].engines.synth.filterCutoff = 5678;
    await Promise.resolve();
    vi.advanceTimersByTime(500);
    vi.useRealTimers();

    const raw = localStorage.getItem('fiddle:project');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.tracks[0].engines.synth.filterCutoff).toBe(5678);
  });
});
```

- [ ] **Step 3: Run the test, confirm pass**

```bash
npx vitest run src/composables/useSynth.test.ts
```
Expected: existing tests + 2 new = green.

- [ ] **Step 4: Run full check**

```bash
npm test && npx vue-tsc --noEmit && npx vite build
```
Expected: all green.

- [ ] **Step 5: Commit + merge sub-branch**

```bash
git add src/composables/useSynth.test.ts
git commit -m "test: integration smoke for loadProject + installAutoSave"

git checkout feature/project-model
git merge --no-ff feature/project-model-t10-integration-test -m "Merge T10: integration test"
git branch -d feature/project-model-t10-integration-test
```

---

## Phase D — Docs + finalize

### Task 11: Update in-repo docs

Update `ARCHITECTURE.md` to reflect the new module map + reactivity flow; mark A3 and F1 (persistence half) done in `CODE_REVIEW.md`.

**Files:**
- Modify: `docs/ARCHITECTURE.md` (§2 module map, §6 useSynth reactivity flow, possibly add §13 for project module)
- Modify: `docs/CODE_REVIEW.md` (A3 → done; F1 → persistence done, presets still open)

- [ ] **Step 1: Cut sub-branch**

```bash
git checkout feature/project-model
git checkout -b feature/project-model-t11-docs
```

- [ ] **Step 2: Update `docs/ARCHITECTURE.md`**

Add a new entry to §2 (Module map):
```
├── project/
│   ├── types.ts        # Project, ProjectTrack, EngineParamsMap, schema version
│   ├── factory.ts      # freshProject, freshTrack, freshStep
│   ├── mutations.ts    # clearTrack, shiftTrack, fillTrack (pure)
│   ├── migrations.ts   # migrateToLatest (versioned dispatch)
│   ├── storage.ts      # loadProject, installAutoSave, reconcileWithDefaults
│   └── index.ts        # public barrel
```

Update §6 "useSynth.ts — explicit lazy singleton":
- The "Layout" code block: replace `trackStates` with `project` (`reactive(loadProject())`); show `installAutoSave(project)` call.
- The "Lifecycle" section: add bullet about `loadProject` running at module init + `installAutoSave` returning a stop fn.
- "Reactivity flow per knob turn" — path changes from `trackStates[i][engine][param]` to `project.tracks[i].engines[engine][param]`.

Add a new section §13 (or as appropriate): "The Project module" — point to the spec file for the full design; cover the schemaVersion bump policy from §6.1 of the spec (one-paragraph summary).

The "Where to start when…" table: update the A3 / F1 rows to reflect "done" and point at the new module.

- [ ] **Step 3: Update `docs/CODE_REVIEW.md`**

Mark A3 done; mark F1 partially done (persistence shipped, presets still open):

```md
| **A3** | ~~Tagged-union TrackState~~ | ✅ **Done** (`<merge-commit-sha>`) — replaced by dense ProjectTrack with engines: EngineParamsMap. Active engine narrowed via activeParams helper. See docs/superpowers/specs/2026-05-23-project-model-design.md. |
| **F1** | localStorage persistence — ✅ persistence DONE; **named presets still open** | Persistence shipped: project model + auto-save + restore. Named presets are a separate future branch. |
```

(The merge SHA is the SHA of the eventual merge of `feature/project-model` to `main` — for now, leave it as `<TBD>` and the user will fill it in when they approve the merge, OR use the latest commit on `feature/project-model` and update at merge time.)

- [ ] **Step 4: Run full check**

```bash
npm test && npx vue-tsc --noEmit && npx vite build
```
Expected: all green.

- [ ] **Step 5: Commit + merge sub-branch**

```bash
git add docs/ARCHITECTURE.md docs/CODE_REVIEW.md
git commit -m "docs: update ARCHITECTURE + CODE_REVIEW for project model"

git checkout feature/project-model
git merge --no-ff feature/project-model-t11-docs -m "Merge T11: docs"
git branch -d feature/project-model-t11-docs
```

---

### Task 12: Final review checkpoint

Stand back, check the whole branch, hand off to the user for review before any merge to `main`.

- [ ] **Step 1: Verify acceptance criteria from spec §8**

For each of the 12+ items in spec §8, manually verify:
1. ✓ `src/project/` directory has all 6 files.
2. ✓ Types defined per §2; `activeParams` narrows correctly (TS check counts).
3. ✓ `useSynth.ts` exposes `project` (not `trackStates`); `trackParam` paths update.
4. ✓ `Sequencer.ts` no longer owns tracks/bpm/mutations; new `start()` sig.
5. ✓ localStorage save fires (debounced) on state changes; restore at module init.
6. ✓ Fresh app starts with `freshProject()` defaults.
7. ✓ Knob turn + page refresh preserves value.
8. ✓ Engine-type swap roundtrip preserves params (synth → kick → synth).
9. ✓ Migration registry handles missing/unknown schemaVersion per §6.1.
10. ✓ `reconcileWithDefaults` covers additive-change forward-compat per §6.2.
11. ✓ All existing 62 tests pass + ~25 new tests pass; `vue-tsc` + `vite build` clean.
12. ✓ No `AudioContext` at module load (A1 invariant); Visualizer works on first Play (A1 shallowRef invariant).

- [ ] **Step 2: Compute final stats**

```bash
git log --oneline main..feature/project-model
git diff --stat main..feature/project-model
npm test 2>&1 | grep -E "Tests|Test Files" | tail -3
```

Report back to user with:
- Total commits added
- Files changed / lines added / lines removed
- Final test count (expected ~120+)
- All three checks green

- [ ] **Step 3: Hand off**

Tell the user the branch is complete and ready for browser-verification and review. **Do not merge to `main`** — wait for explicit user approval per the original instruction.

Suggested handoff message:
> `feature/project-model` is complete: A3 + persistence half of F1 landed across N commits. `npm test` shows `<count>` passing; `vue-tsc` + `vite build` clean. Tested in browser: load/save/engine-swap/persistence all behave per spec acceptance criteria. Ready for your review. Don't merge to main until you give the word.

---

## Self-review (against spec)

### Spec coverage

| Spec section | Covered in plan? | Task(s) |
|---|---|---|
| §1 Goals (A3, Project, persistence, versioning, Sequencer refactor) | ✓ | T3–T11 |
| §1 Non-goals (no presets UI, no picker, no networking) | ✓ | Honored across all tasks |
| §2 Types (Project, ProjectTrack, EngineParamsMap, activeParams, freshProject etc.) | ✓ | T3 (types), T4 (factory) |
| §3 Module layout (src/project/ 6 files) | ✓ | T3, T4, T5, T6, T7, T8 |
| §4 Sequencer refactor (drops tracks/bpm/mutations; new start sig) | ✓ | T9 step 2 |
| §5 useSynth changes (project replaces trackStates; bpm computed; types relocation) | ✓ | T3 (relocation), T9 step 4 |
| §6 Persistence semantics (load, autosave, debounce, defenses) | ✓ | T7 |
| §6.1 Versioning policy (additive vs breaking) | ✓ | T6 implementation respects this; documented in T6 code comment + T11 docs |
| §6.2 reconcileWithDefaults | ✓ | T7 |
| §7 Testing approach (factory/mutations/migrations/storage/reconcile + Seq/useSynth/TrackMixer updates + integration) | ✓ | T4, T5, T6, T7, T9 steps 3/7/8, T10 |
| §8 Acceptance criteria | ✓ | T12 step 1 |
| §9 Open questions (debounce, autosave invocation, Step location) | ✓ | T2 (custom debounce), T9 step 4 (autosave at module init), T9 step 2 (Step stays in Sequencer.ts) |
| §10 Out-of-scope reminders (presets, picker, networking) | ✓ | None of these appear in any task |

No gaps.

### Placeholder scan

- No "TBD", "TODO", "implement later", "fill in details".
- T6 code shows the full migration function, not "add migration logic".
- T9 shows complete useSynth.ts and Sequencer.ts replacements.
- One exception: T11 step 3 says `<merge-commit-sha>` for the A3/F1 entry in CODE_REVIEW.md — this is intentional because the merge happens AFTER plan execution, on user approval. The plan instructs the executor to leave it as `<TBD>` or use the latest feature-branch commit, with the user filling it in at merge time. Acceptable.

### Type consistency

- `EngineType`, `MixerState`, `DEFAULT_MIXER_STATE` consistently moved to `src/project/types.ts` in T3, imported from there everywhere afterward.
- `Project`, `ProjectTrack`, `EngineParamsMap` defined once (T3), referenced consistently.
- `freshProject`, `freshTrack`, `freshStep` defined once (T4), called consistently.
- `clearTrack`, `shiftTrack`, `fillTrack` defined once (T5); old Sequencer versions deleted in T9.
- `loadProject`, `installAutoSave`, `reconcileWithDefaults` defined once (T7).
- `migrateToLatest` defined once (T6).
- `sliderToLinearGain` stays in useSynth (T9) — same name, same range, same math.
- `PROJECT_SCHEMA_VERSION` constant used in T3, T4, T6, T7, T9 — all references consistent.

No inconsistencies.

### Scope check

This plan implements exactly the spec's in-scope items: A3 + persistence half of F1. No drift into presets UI, picker, or networking. Branch-per-task workflow keeps it incremental. T9 is the largest single task — it's where the rip-and-replace happens, and it's clearly bounded.
