# Lifecycle Architecture — Phase 2b-iii Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route the **last two** outbound write paths — engine-param edits (all instrument panels) and the synth2 mod-matrix — through `dispatchLocal`/`useCommandModel`, then DELETE the two remaining `flush:'sync'` outbound watchers (the engine-slice watcher and the matrix watcher). After this phase, **every** local edit reaches the wire through the command bus, and `installSyncWatchers` is gone.

**Architecture:** Mirror the 2b-ii migration exactly, one slice-covering watcher at a time. Each panel control's write is moved off direct `project` mutation onto the command bus; the watcher that used to observe that mutation is deleted in the **same commit** so there is never a double-emit window. Bulk/indirect writers that the deleted watchers used to cover for free (preset load via `applyPreset`, whole-project replace via Open/New) get explicit diff-emit, exactly as 2b-ii did for steps/mixer/scalars.

**Tech Stack:** Vue 3.5 reactivity (`computed` writable refs, `effectScope`), the existing `CommandBus`/`Outbox`/`dispatchLocal` infra from 2a/2b-i/2b-ii, Vitest with the `bootWithFakeSocket()` harness.

**Out of scope (explicitly):** Removing the `applyingFromNetwork`/`enterSuppress`/`exitSuppress` suppression flag, deleting `applyOp.ts`, and unwinding the `messageDispatch.ts` / `Outbox.applyLocal` suppress wraps. Those become **dead code** after this phase but are removed in the follow-on **Phase 2b-iv**. This phase leaves the suppression flag in place (harmless once no watcher reads it) and the app fully working.

## Global Constraints

- **The invariant:** one user edit → **exactly one** outbound op. Never zero (a migrated control must still sync), never two (no double-emit: a control's watcher must be deleted in the same commit it is migrated). This is the acceptance bar for every task.
- **`ProjectStore.applySet` stays a pure primitive** — `setDeep` only. Do not add sync/opId/suppression logic to it.
- **Do NOT touch the audio-reaction watcher** at `useSynth.ts:744` (`() => snapshot(project.tracks[i].engines[slice])` inside `buildAudioState`). That one applies params to audio nodes and is disjoint from sync; Phase 4 owns it. Only the **sync** engine-slice watcher inside `installSyncWatchers` (≈ line 470–486) and the **matrix** watcher (≈ line 494–508) are deleted here.
- **Discrete-vs-throttled policy is unchanged** and lives only in `DISCRETE_LEAF_FIELDS` (`useSynth.ts:251`). `dispatchLocal` already derives gesture-end from the leaf. Do not re-derive it in panels. Matrix `source`/`dest` are discrete (already in the set); `amount` and every continuous knob ride the throttle.
- **The migration-rule invariant:** for every control that today has BOTH `v-model="params.<field>"` and `:syncPath="ks.pathFor(<X>)"`, the `<X>` passed to `pathFor` **is** the field path. The migrated model is `ks.model(<X>)` with the **same** `<X>`. `:syncPath` and `@gesture-end` are left exactly as they are.
- **No `.vue` mounting in unit tests.** Panels are covered through the store/bus/`useSynth` sync-integration tests, not by mounting components. (`Synth2Panel.test.ts` already exists and tests pure logic only — keep it that way.)
- **Staging:** stage only named files. NEVER `git add -A`/`.`. NEVER stage `studio-initial.png`, `synth2-wave-previews.png`, or `studio-focused.md`.
- **Commit trailer:** end every commit message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Browser verification** uses `npm run dev:obs` (LOCAL Docker DB) — NEVER `npm run dev` (real prod DB). Mandatory Playwright pass with a clean console before the phase is called done; close the tab + stop the dev server after.

## File structure

| File | Change | Responsibility after this phase |
|---|---|---|
| `packages/client/src/sync/knobSync.ts` | **Modify** (Task 1) | Adds `model(field)` (writable computed v-model adapter) + `set(field, value)` (imperative dispatch) alongside `pathFor`/`end`. Single place panels route writes through the bus. |
| `packages/client/src/sync/knobSync.test.ts` | **Create** (Task 1) | Unit tests for `model`/`set` against a fake dispatch + injected active track. |
| `packages/client/src/components/Synth2Panel.vue` | **Modify** (Tasks 2 + 3) | Knobs/toggles → `ks.model`/`ks.set`; matrix selects/knob → `ks.model` (Task 3). |
| `packages/client/src/components/{Oscillator,Filter,Envelope,Mixer}Panel.vue` | **Modify** (Task 2) | Legacy synth panels: every `params.*` write → `ks.model`/`ks.set`. |
| `packages/client/src/components/{Kick,Hat,Snare,Clap}Panel.vue` | **Modify** (Task 2) | Legacy drum panels: knob writes → `ks.model`. |
| `packages/client/src/components/{Kick2,Snare2,Hat2,Clap2}Panel.vue` | **Modify** (Task 2) | Descriptor-driven drum panels: the single `v-model` in the `v-for` → `ks.model(d.key)`. |
| `packages/client/src/views/StudioView.vue` | **Modify** (Task 2) | `applyPresetSynced` snapshots the engine slice and calls `syncEngineParamsDiff` after `applyPreset`. |
| `packages/client/src/composables/useSynth.ts` | **Modify** (Tasks 2 + 3) | Add `syncEngineParamsDiff`; extend `snapshotProjectForSync`/`syncWholeProjectDiff` to cover engine slices (Task 2) + matrix (Task 3); delete the engine-slice watcher (Task 2) + matrix watcher and the now-empty `installSyncWatchers`/`disposeSyncWatchers`/`syncWatcherScope` (Task 3). |
| `packages/client/src/composables/useSynth.test.ts` | **Modify** (Tasks 2 + 3) | `sync integration` cases: engine param single-emit, preset-load emit, Open/New engine+matrix emit, matrix single-emit. |

---

### Task 1: Add `model` + `set` to `useKnobSync`

**Files:**
- Modify: `packages/client/src/sync/knobSync.ts`
- Create: `packages/client/src/sync/knobSync.test.ts`

**Interfaces:**
- Consumes: `useCommandModel(path | () => path)` from `../sync/commandModel`; `dispatchLocal(path, value)` from `../composables/useSynth`; existing `pathFor(field)` (returns `[]` when no active track).
- Produces:
  - `model(field: string | ReadonlyArray<string|number>): WritableComputedRef<unknown>` — reads the live value at `pathFor(field)`, writes via `dispatchLocal`. When there is no active track (`pathFor` returns `[]`) the getter returns `undefined` and the setter is a no-op.
  - `set(field: string | ReadonlyArray<string|number>, value: unknown): void` — dispatches `value` to `pathFor(field)`; no-op when there is no active track.

This task is **purely additive** — no panel imports `model`/`set` yet, so behaviour is unchanged and all existing tests stay green.

- [ ] **Step 1: Write the failing test**

Create `packages/client/src/sync/knobSync.test.ts`. The composable reads the active track from an injected ref; tests provide it by running `useKnobSync` inside a component-less `effectScope` after stubbing `dispatchLocal`. Use a spy on the real `dispatchLocal` export and the inject default (a null ref) to drive the no-active-track branch, plus an explicit `provide`-style override.

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';

// Stub the module the composable writes through, so we assert the path/value
// without a live command bus. (knobSync imports dispatchLocal from useSynth.)
vi.mock('../composables/useSynth', () => ({
  dispatchLocal: vi.fn(),
  endGesture: vi.fn(),
}));

import { dispatchLocal } from '../composables/useSynth';
import { useKnobSync, ACTIVE_TRACK_KEY } from './knobSync';

// Helper: run useKnobSync with a chosen active-track ref by faking Vue inject.
import * as vue from 'vue';

function withActiveTrack<T>(idx: number | null, run: () => T): T {
  const spy = vi.spyOn(vue, 'inject').mockImplementation((key: unknown, def?: unknown) => {
    if (key === ACTIVE_TRACK_KEY) return ref(idx);
    return def;
  });
  try { return run(); } finally { spy.mockRestore(); }
}

describe('useKnobSync model/set', () => {
  beforeEach(() => { (dispatchLocal as unknown as ReturnType<typeof vi.fn>).mockClear(); });

  it('set() dispatches to the full wire path for the active track', () => {
    const ks = withActiveTrack(2, () => useKnobSync('synth2'));
    ks.set(['env1', 'loop'], true);
    expect(dispatchLocal).toHaveBeenCalledWith(['tracks', 2, 'engines', 'synth2', 'env1', 'loop'], true);
  });

  it('set() is a no-op when there is no active track', () => {
    const ks = withActiveTrack(null, () => useKnobSync('synth2'));
    ks.set('mode', 'poly');
    expect(dispatchLocal).not.toHaveBeenCalled();
  });

  it('model().value writes dispatch to the field path', () => {
    const ks = withActiveTrack(0, () => useKnobSync('kick2'));
    const m = ks.model('tune');
    m.value = 88;
    expect(dispatchLocal).toHaveBeenCalledWith(['tracks', 0, 'engines', 'kick2', 'tune'], 88);
  });

  it('model() setter is a no-op when there is no active track', () => {
    const ks = withActiveTrack(null, () => useKnobSync('kick2'));
    ks.model('tune').value = 88;
    expect(dispatchLocal).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --workspace @fiddle/client test -- knobSync`
Expected: FAIL — `ks.model is not a function` / `ks.set is not a function`.

- [ ] **Step 3: Implement `model` + `set`**

In `packages/client/src/sync/knobSync.ts`, add the import and the two members. Keep `pathFor`/`end` unchanged.

```ts
import { computed, inject, ref, type InjectionKey, type Ref, type WritableComputedRef } from 'vue';
import type { EngineType, Path } from '@fiddle/shared';
import { getDeep } from '@fiddle/shared';
import { dispatchLocal, endGesture } from '../composables/useSynth';
import { project } from '../stores/project';
```

Inside `useKnobSync`, after `end`:

```ts
  type Field = string | ReadonlyArray<string | number>;

  // Writable v-model for a knob/select: reads the live reactive value at the
  // field's wire path, writes through the command bus. Mirrors useCommandModel
  // but sources the (activeTrack-dependent) path from pathFor.
  function model(field: Field): WritableComputedRef<unknown> {
    return computed<unknown>({
      get: () => {
        const p = pathFor(field);
        if (p.length === 0) return undefined; // no active track → dormant
        return getDeep(project as unknown as Record<string, unknown>, p);
      },
      set: (v) => {
        const p = pathFor(field);
        if (p.length === 0) return;
        dispatchLocal(p, v);
      },
    });
  }

  // Imperative write for @click toggles/buttons that have no v-model.
  function set(field: Field, value: unknown): void {
    const p = pathFor(field);
    if (p.length === 0) return;
    dispatchLocal(p, value);
  }

  return { pathFor, end, model, set };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --workspace @fiddle/client test -- knobSync`
Expected: PASS (4/4), output pristine.

- [ ] **Step 5: Typecheck + commit**

Run: `npm --workspace @fiddle/client run typecheck` → 0 errors.

```bash
git add packages/client/src/sync/knobSync.ts packages/client/src/sync/knobSync.test.ts
git commit -m "feat(sync): add model + set to useKnobSync (route panel writes through dispatch) (phase 2b-iii)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Migrate engine-param writers; delete the engine-slice watcher

**Files:**
- Modify: all instrument panels EXCEPT the synth2 matrix block —
  `Synth2Panel.vue` (knobs + mode/sync/loop/filter-model/filter-type buttons; **leave the matrix block for Task 3**), `OscillatorPanel.vue`, `FilterPanel.vue`, `EnvelopePanel.vue`, `MixerPanel.vue`, `KickPanel.vue`, `HatPanel.vue`, `SnarePanel.vue`, `ClapPanel.vue`, `Kick2Panel.vue`, `Snare2Panel.vue`, `Hat2Panel.vue`, `Clap2Panel.vue`
- Modify: `packages/client/src/views/StudioView.vue` (`applyPresetSynced`)
- Modify: `packages/client/src/composables/useSynth.ts` (add `syncEngineParamsDiff`; extend snapshot/whole-project diff for engine slices; delete the engine-slice watcher)
- Test: `packages/client/src/composables/useSynth.test.ts`

**Interfaces:**
- Consumes: `ks.model`/`ks.set` (Task 1); existing `emitLeafDiff`, `diffParams`, `ENGINE_SLICES`, `snapshotProjectForSync`/`syncWholeProjectDiff` (`useSynth.ts`); `applyPreset` (`project/preset`).
- Produces: `syncEngineParamsDiff(trackIdx: number, engineType: EngineType, beforeSlice: Record<string, unknown>): void` exported from `useSynth.ts` — diffs the now-mutated engine slice against `beforeSlice` and emits the changed leaves (drilled one level), gated on `outbox && syncReady && !isApplyingFromNetwork()`.

**Why atomic:** the engine-slice sync watcher observes *every* engine slice of every track at once. A control migrated to `dispatchLocal` while that watcher still lives would emit twice (dispatch enqueues + the slice mutation re-triggers the watcher). So all engine-param controls move AND the watcher is deleted in this one task/commit. (The matrix has its own separate watcher → Task 3.)

#### 2a — the panel migration rule (apply to every panel above)

For each panel, migrate **every write to `params.*`**. Discover them mechanically:

```bash
grep -nE 'v-model="params|@click="params|@change="params|@update[^=]*="params' packages/client/src/components/<Panel>.vue
```

Transform each match:

- **`v-model="params.<field-access>"` next to `:syncPath="ks.pathFor(<X>)"`** → `v-model="ks.model(<X>)"`. The `<X>` is **identical** to the arg already in the adjacent `pathFor`. Leave `:syncPath` and `@gesture-end` untouched.
  - Example (Synth2Panel.vue:29):
    `v-model="params.osc1.morph" :syncPath="ks.pathFor(['osc1', 'morph'])"` → `v-model="ks.model(['osc1', 'morph'])" :syncPath="ks.pathFor(['osc1', 'morph'])"`
  - Example (KickPanel.vue:8): `v-model="params.tune" :syncPath="ks.pathFor('tune')"` → `v-model="ks.model('tune')" :syncPath="ks.pathFor('tune')"`
  - Descriptor panels (Kick2/Snare2/Hat2/Clap2): a single `v-model="params[d.key]" :syncPath="ks.pathFor(d.key)"` in the `v-for` → `v-model="ks.model(d.key)"`. **One line each.**

- **`@click="params.<field-access> = <value>"` (toggle/button, no syncPath)** → `@click="ks.set(<path>, <value>)"`, where `<path>` is the field-access as an array. Reading `params.*` to compute the toggled value stays (reads are fine; only the write routes through the bus).
  - Synth2Panel explicit set (these have NO `pathFor` to copy — derive the path from the `params` access):
    - `@click="params.mode = 'mono'"` → `@click="ks.set('mode', 'mono')"` (line 9); `'poly'` likewise (line 17)
    - `@click="params.env1.loop = !params.env1.loop"` → `@click="ks.set(['env1', 'loop'], !params.env1.loop)"` (line 44)
    - `@click="params.osc2.sync = !params.osc2.sync"` → `@click="ks.set(['osc2', 'sync'], !params.osc2.sync)"` (line 64); osc3 likewise (line 87)
    - `@click="params.filter.model = 'classic'"` → `@click="ks.set(['filter', 'model'], 'classic')"` (line 117); `'morph'` likewise (line 118)
    - `@click="params.filter.type = 'lp'"` → `@click="ks.set(['filter', 'type'], 'lp')"` (line 121); `'bp'`, `'hp'` likewise (lines 122–123)
  - Apply the same rule to any `@click/@change` on `params.*` found in the legacy panels (e.g. a waveform/type selector in OscillatorPanel/FilterPanel) — migrate each to `ks.set([...path], value)`.

- **Leave alone:** read-only bindings (`:morph="params.osc1.morph"` on `<WavePreview>`, `:class="{ active: params.mode === 'mono' }"`) — those are reads, not writes.

**Coverage check per panel:** after editing, re-run the `grep` above. The only remaining `params.*` hits must be **reads** (`:prop=`, `:class=`, `v-if=`, `{{ }}`) — zero `v-model=`/`@click=`/`@change=`/`@update…=` on `params.*` should remain (matrix block of Synth2Panel excepted, Task 3).

- [ ] **Step 1: Migrate the panels** per 2a. Start with the descriptor drum panels (Kick2/Snare2/Hat2/Clap2 — one line each), then legacy drum (Kick/Hat/Snare/Clap), then legacy synth (Oscillator/Filter/Envelope/Mixer), then Synth2Panel (knobs + the explicit toggles listed above; **skip the matrix block** lines 191–198).

- [ ] **Step 2: Add `syncEngineParamsDiff` + extend the bulk-sync helpers** in `useSynth.ts`.

Add the helper next to `syncStepWindowDiff`:

```ts
// Sync an already-applied engine-slice param write (preset load) by diffing the
// pre-write slice snapshot against the now-mutated live slice. Mirrors
// syncStepWindowDiff: the engine-slice watcher used to cover this for free; with
// it deleted, the bulk writer (applyPreset) must emit explicitly.
export function syncEngineParamsDiff(
  trackIdx: number,
  engineType: EngineType,
  beforeSlice: Record<string, unknown>,
): void {
  if (!outbox || !syncReady || isApplyingFromNetwork()) return;
  const after = project.tracks[trackIdx].engines[engineType] as unknown as Record<string, unknown>;
  const changed = diffParams(after, beforeSlice);
  if (changed) emitLeafDiff(['tracks', trackIdx, 'engines', engineType], changed, beforeSlice);
}
```

Extend `ProjectSyncSnapshot` + `snapshotProjectForSync` to capture engine slices (shallow per slice; **matrix captured but emitted in Task 3**):

```ts
export interface ProjectSyncSnapshot {
  bpm: number;
  tracks: {
    engineType: string; patternLength: number; enabled: boolean;
    mixer: Record<string, unknown>;
    steps: Record<string, unknown>[];
    engines: Record<string, Record<string, unknown>>; // per ENGINE_SLICES, shallow copy
  }[];
}
```

In `snapshotProjectForSync`, for each track add:

```ts
      engines: Object.fromEntries(
        ENGINE_SLICES.map((slice) => [
          slice,
          { ...(t.engines[slice] as unknown as Record<string, unknown>) },
        ]),
      ),
```

Extend `syncWholeProjectDiff` (after the existing step-leaves loop, still inside the `for i` loop) to emit per-slice engine param diffs. The matrix is an array nested in the synth2 slice — `diffParams`/`emitLeafDiff` skip arrays, so it is **intentionally not emitted here** (Task 3 adds it):

```ts
    // engine-slice params (excluding the synth2 matrix array — Task 3 emits that)
    for (const slice of ENGINE_SLICES) {
      const ec = diffParams(
        t.engines[slice] as unknown as Record<string, unknown>,
        b.engines[slice],
      );
      if (ec) emitLeafDiff(['tracks', i, 'engines', slice], ec, b.engines[slice]);
    }
```

Update the two doc-comments above `snapshotProjectForSync`/`syncWholeProjectDiff` that currently say engine params are "intentionally omitted … RETAINED slice watcher picks them up" — they are now emitted here; only the matrix is deferred (to Task 3).

- [ ] **Step 3: Wire `applyPresetSynced`** in `StudioView.vue` to emit the slice diff. Snapshot the slice **before** `applyPreset`, emit **after**:

```ts
function applyPresetSynced(trackIdx: number, preset: Preset): void {
  dispatchLocal(['tracks', trackIdx, 'engineType'], preset.engineType); // discrete, syncs the swap
  const before = { ...(project.tracks[trackIdx].engines[preset.engineType] as Record<string, unknown>) };
  applyPreset(project.tracks[trackIdx], preset);                        // mutates the slice in place
  syncEngineParamsDiff(trackIdx, preset.engineType, before);            // emit changed params (watcher is gone)
}
```

Add `syncEngineParamsDiff` to the existing `useSynth` import block in `StudioView.vue`. Remove the stale `// (slice watcher syncs)` comment on the `applyPreset` line.

- [ ] **Step 4: Delete the engine-slice sync watcher** in `useSynth.ts` `installSyncWatchers`. Remove the inner block:

```ts
      for (const slice of ENGINE_SLICES) {
        watch(
          () => snapshot(project.tracks[i].engines[slice]),
          (newVal, oldVal) => { /* … emitLeafDiff … */ },
          { flush: 'sync' },
        );
      }
```

Keep the surrounding `for (let i = 0; i < TRACK_POOL_SIZE; i++)` loop and the **matrix** `watch(...)` (Task 3 removes those). Do NOT touch the audio watcher at ~line 744.

- [ ] **Step 5: Write/extend the sync-integration tests** in `useSynth.test.ts` (`describe('sync integration')`). Use the existing `bootWithFakeSocket()` harness; `fake.sent` records ops; advance timers 50ms for throttled (continuous) params.

```ts
it('engine param edit via dispatch emits exactly one op (no double-emit)', async () => {
  const { mod, fake } = await bootWithFakeSocket();
  fake.sent.length = 0;
  mod.dispatchLocal(['tracks', 0, 'engines', 'synth2', 'filter', 'cutoff'], 3000);
  vi.advanceTimersByTime(50);
  const ops = fake.sent.filter(o => o.path.join('.') === 'tracks.0.engines.synth2.filter.cutoff');
  expect(ops).toHaveLength(1);
  expect(ops[0].value).toBe(3000);
});

it('applyPreset emits the changed engine-slice params', async () => {
  const { mod, synth, fake } = await bootWithFakeSocket();
  const before = { ...(synth.project.tracks[0].engines.kick as Record<string, unknown>) };
  // simulate the StudioView flow: mutate the slice then call the diff emitter
  synth.project.tracks[0].engines.kick.tune = 99;
  fake.sent.length = 0;
  mod.syncEngineParamsDiff(0, 'kick', before);
  vi.advanceTimersByTime(50);
  expect(fake.sent.some(o => o.path.join('.') === 'tracks.0.engines.kick.tune' && o.value === 99)).toBe(true);
});

it('whole-project diff emits engine-slice param changes (Open/New)', async () => {
  const { mod, synth, fake } = await bootWithFakeSocket();
  const snap = mod.snapshotProjectForSync();
  synth.project.tracks[0].engines.synth2.osc1.morph = 2.5;
  fake.sent.length = 0;
  mod.syncWholeProjectDiff(snap);
  vi.advanceTimersByTime(50);
  expect(fake.sent.some(o => o.path.join('.') === 'tracks.0.engines.synth2.osc1.morph' && o.value === 2.5)).toBe(true);
});
```

(Match the exact `fake.sent` op shape used by the existing 2b-ii tests — adjust `.path`/`.value` field names to whatever those tests assert.)

- [ ] **Step 6: Full client suite + typecheck**

Run: `npm --workspace @fiddle/client test` → all green, output pristine.
Run: `npm --workspace @fiddle/client run typecheck` → 0 errors.

- [ ] **Step 7: Commit**

```bash
git add packages/client/src/components/Synth2Panel.vue \
        packages/client/src/components/OscillatorPanel.vue \
        packages/client/src/components/FilterPanel.vue \
        packages/client/src/components/EnvelopePanel.vue \
        packages/client/src/components/MixerPanel.vue \
        packages/client/src/components/KickPanel.vue \
        packages/client/src/components/HatPanel.vue \
        packages/client/src/components/SnarePanel.vue \
        packages/client/src/components/ClapPanel.vue \
        packages/client/src/components/Kick2Panel.vue \
        packages/client/src/components/Snare2Panel.vue \
        packages/client/src/components/Hat2Panel.vue \
        packages/client/src/components/Clap2Panel.vue \
        packages/client/src/views/StudioView.vue \
        packages/client/src/composables/useSynth.ts \
        packages/client/src/composables/useSynth.test.ts
git commit -m "refactor(sync): route engine-param writes through dispatch, drop engine-slice watcher (phase 2b-iii)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Migrate the synth2 mod-matrix; delete the matrix watcher + empty `installSyncWatchers`

**Files:**
- Modify: `packages/client/src/components/Synth2Panel.vue` (matrix block, lines ≈ 191–198)
- Modify: `packages/client/src/composables/useSynth.ts` (delete matrix watcher + now-empty `installSyncWatchers`/`disposeSyncWatchers`/`syncWatcherScope` + call sites; extend snapshot/whole-project diff for the matrix)
- Test: `packages/client/src/composables/useSynth.test.ts`

**Interfaces:**
- Consumes: `ks.model` (Task 1); existing matrix-leaf emit shape (`['tracks', i, 'engines', 'synth2', 'matrix', s, field]`) from the watcher being deleted.
- Produces: nothing new exported; `snapshotProjectForSync`/`syncWholeProjectDiff` now also cover the matrix.

- [ ] **Step 1: Migrate the matrix controls** in `Synth2Panel.vue`. The matrix is a `v-for="(slot, s) in params.matrix"`; each slot has `source`/`dest` selects and an `amount` knob:

```html
<select class="matrix-source" :value="slot.source" @change="ks.set(['matrix', s, 'source'], ($event.target as HTMLSelectElement).value)">
  <option v-for="src in MOD_SOURCES" :key="src" :value="src">{{ src }}</option>
</select>
<select class="matrix-dest" :value="slot.dest" @change="ks.set(['matrix', s, 'dest'], ($event.target as HTMLSelectElement).value)">
  <option v-for="dst in MOD_DESTS" :key="dst" :value="dst">{{ dst }}</option>
</select>
<Knob label="Amt" :min="-1" :max="1" :step="0.01" :defaultValue="0" v-model="ks.model(['matrix', s, 'amount'])" :syncPath="ks.pathFor(['matrix', s, 'amount'])" @gesture-end="ks.end(['matrix', s, 'amount'])" />
```

Rationale: the selects use explicit `:value`/`@change` (rather than `v-model="ks.model(...)"`) because a fresh writable computed created per `v-for` iteration is awkward to two-way bind on a native `<select>`; `ks.set` on `@change` is the imperative analogue and keeps `source`/`dest` discrete (flush-now). The amount knob keeps `v-model` via `ks.model` (consistent with every other knob). `slot.source`/`slot.dest`/`slot.amount` reads stay (reactive display).

- [ ] **Step 2: Delete the matrix watcher and the now-empty watcher scaffolding** in `useSynth.ts`.

Remove the matrix `watch(() => snapshot(project.tracks[i].engines.synth2.matrix), …, { flush: 'sync' })` block. After Task 2 removed the engine-slice loop, `installSyncWatchers`'s `for i` body is now empty → delete the whole function `installSyncWatchers`, `disposeSyncWatchers`, the `syncWatcherScope` module variable, and their call sites:
- the `disposeSyncWatchers()` call (≈ line 531, in `teardownConnection`)
- the `installSyncWatchers()` call (≈ line 572, in `connectToSession`)
- the explanatory comment block above `syncWatcherScope` (≈ lines 449–459) and the `EffectScope`/`effectScope` import if now unused.

Verify no other reference remains:

```bash
grep -n "installSyncWatchers\|disposeSyncWatchers\|syncWatcherScope" packages/client/src/composables/useSynth.ts
```

Expected: no matches.

- [ ] **Step 3: Extend the snapshot/whole-project diff for the matrix** in `useSynth.ts`.

`snapshotProjectForSync` already deep-copies the `synth2` slice shallowly via the Task-2 `engines` capture, but the `matrix` array needs a per-slot copy so the diff has a stable `before`. In the `engines` capture, replace the synth2 entry's shallow copy so `matrix` is copied slot-by-slot — simplest: after building `engines`, deep-copy the matrix:

```ts
      engines: Object.fromEntries(
        ENGINE_SLICES.map((slice) => {
          const src = t.engines[slice] as unknown as Record<string, unknown>;
          const copy: Record<string, unknown> = { ...src };
          if (slice === 'synth2' && Array.isArray(src.matrix)) {
            copy.matrix = (src.matrix as Record<string, unknown>[]).map((m) => ({ ...m }));
          }
          return [slice, copy];
        }),
      ),
```

In `syncWholeProjectDiff`, after the engine-slice loop, emit matrix leaf diffs (mirror the deleted watcher's drill — per slot, per `source`/`dest`/`amount`):

```ts
    // synth2 mod matrix (array → drilled to per-slot leaf paths; diffParams skips arrays)
    const newM = (t.engines.synth2 as unknown as { matrix?: Record<string, unknown>[] }).matrix;
    const oldM = (b.engines.synth2 as { matrix?: Record<string, unknown>[] }).matrix;
    if (newM && oldM) {
      for (let s = 0; s < newM.length; s++) {
        for (const field of ['source', 'dest', 'amount'] as const) {
          const a = newM[s]?.[field]; const o = oldM[s]?.[field];
          if (a === o) continue;
          outbox!.enqueue(['tracks', i, 'engines', 'synth2', 'matrix', s, field], a, o, gestureEndForLeaf(field));
        }
      }
    }
```

- [ ] **Step 4: Sync-integration tests** for the matrix in `useSynth.test.ts`:

```ts
it('matrix source edit emits exactly one op (discrete, flush-now)', async () => {
  const { mod, fake } = await bootWithFakeSocket();
  fake.sent.length = 0;
  mod.dispatchLocal(['tracks', 0, 'engines', 'synth2', 'matrix', 0, 'source'], 'lfo1');
  const ops = fake.sent.filter(o => o.path.join('.') === 'tracks.0.engines.synth2.matrix.0.source');
  expect(ops).toHaveLength(1);
  expect(ops[0].value).toBe('lfo1');
});

it('whole-project diff emits matrix changes (Open/New)', async () => {
  const { mod, synth, fake } = await bootWithFakeSocket();
  const snap = mod.snapshotProjectForSync();
  synth.project.tracks[0].engines.synth2.matrix[0].amount = 0.5;
  fake.sent.length = 0;
  mod.syncWholeProjectDiff(snap);
  vi.advanceTimersByTime(50);
  expect(fake.sent.some(o => o.path.join('.') === 'tracks.0.engines.synth2.matrix.0.amount' && o.value === 0.5)).toBe(true);
});
```

- [ ] **Step 5: Full client suite + typecheck**

Run: `npm --workspace @fiddle/client test` → green, pristine.
Run: `npm --workspace @fiddle/client run typecheck` → 0 errors.
Sanity grep — the only watcher left on engine slices must be the audio one:

```bash
grep -n "engines\[slice\]\|engines.synth2.matrix" packages/client/src/composables/useSynth.ts
```

Expected: exactly one hit — the audio-reaction watcher inside `buildAudioState` (~line 744). No `installSyncWatchers` references anywhere.

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/components/Synth2Panel.vue \
        packages/client/src/composables/useSynth.ts \
        packages/client/src/composables/useSynth.test.ts
git commit -m "refactor(sync): route synth2 matrix through dispatch, delete matrix watcher + installSyncWatchers (phase 2b-iii)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification (controller, after all tasks)

Not an SDD task — the controller runs these before the finishing-branch step.

- **Full gate:** `npm run typecheck` (3 workspaces, 0 errors) + `npm test` (client/server/shared all green, pristine).
- **Whole-branch review** (opus) over the 2b-iii commit range, per `requesting-code-review` — specifically checking the invariant (single-emit) and that no engine/matrix writer was missed (the 2b-ii regression class): grep every panel for residual `v-model="params`/`@click="params` writes; confirm preset-load and Open/New emit engine + matrix diffs.
- **Browser verification** (`npm run dev:obs`, LOCAL DB, two tabs): drive REAL controls — a synth2 knob (e.g. filter cutoff), an osc `SYNC` / env `LOOP` toggle, filter `type`/`model`, a drum2 descriptor knob, a matrix `source` select + `amount` knob — and confirm each converges on the peer with **exactly one** op (watch the network/console), preset Load adopts engine + params on the peer, Open/New converges, and the snapshot restores on reload. Clean console; close tab; stop dev server.

## Self-review (against the spec)

- **Spec coverage:** This phase finishes the spec's Phase-2 "migrate write sites + delete direct-mutation watchers" for the engine/matrix slices (bpm/engineType/enabled/patternLength/mixer/steps were 2b-ii). The `applyingFromNetwork` removal + `applyRemote`-already-replaced-`applyOp` (done in 2b-i) clean-up is the spec's remaining Phase-2 item → **deferred to 2b-iv** by the user's explicit split decision; called out in "Out of scope" above.
- **Placeholder scan:** none — every step shows the concrete code or the exact mechanical rule plus the file:line anchors that determine each edit.
- **Type consistency:** `model`/`set`/`syncEngineParamsDiff`/`ProjectSyncSnapshot.engines` names are used identically across Tasks 1–3; matrix leaf path `['tracks', i, 'engines', 'synth2', 'matrix', s, field]` matches the deleted watcher's emit path byte-for-byte (so peers built on the old build still accept it).
