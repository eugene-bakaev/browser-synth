# Lifecycle Architecture — Phase 2b-ii Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route the *simple scalar* outbound write sites (bpm, engineType, enabled, patternLength, mixer, steps) through `CommandBus.dispatchLocal` instead of mutating `project` directly, and delete the matching `flush:'sync'` outbound watchers — proving the local-command write path end-to-end while keeping the blast radius small.

**Architecture:** Today a component mutates the reactive `project` (e.g. `step.octave = 4`) and a hidden `flush:'sync'` watcher in `installSyncWatchers()` observes the change and enqueues an outbound op. Phase 2b-ii inverts this for the *simple* writers: the write site calls a new module-level `dispatchLocal(path, value)` (or binds a `useCommandModel(path)` writable-computed) which writes state through the bus (`store/applySet`) **and** enqueues — then the now-redundant outbound watcher for that subsystem is removed. The engine-param slice watcher, the synth2 matrix watcher, the **audio-reaction** watchers, and the `applyingFromNetwork` suppression flag all stay (later sub-phases). This is the second of three 2b sub-phases: **2b-i** routed inbound through `applyRemote` (done, on prod); **2b-ii** (this plan) migrates the simple outbound writers; a later sub-phase migrates the engine-param knob slices + matrix; the final sub-phase deletes the suppression flag + `applyOp.ts`.

**Tech Stack:** Vue 3.5 (reactivity + writable `computed`), Pinia, TypeScript, Vitest, `@fiddle/shared` (`setDeep`/`getDeep`/`pathKey`/`Path`).

## Global Constraints

Every task's requirements implicitly include this section. Copy values verbatim.

- **Branch:** work on `feat/lifecycle-architecture` (the long-running lifecycle branch). NEVER commit on `main`; main only ever advances via merge.
- **Staging:** stage only the named files for each commit. NEVER `git add -A` / `git add .`. NEVER stage `studio-initial.png` or `synth2-wave-previews.png` (two unrelated untracked PNGs that must stay untracked).
- **Commit trailer:** end every commit message with exactly `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Local run/test:** use `npm run dev:obs` (local Docker Postgres), NEVER `npm run dev` (that points at the real prod Supabase DB and caused a prior data-loss incident). The gate is `npm run typecheck` + `npm test` at repo root.
- **Browser verification:** mandatory Playwright pass with a clean console before any app change is called done; close the browser tab afterward. (Controller runs this once at the end of the branch, not per task.)
- **No `.vue` in unit tests:** do NOT mount `.vue` single-file components in Vitest. `.vue` write-site changes are covered by the module-level dispatch tests (`dispatchLocal`/`useCommandModel`/`useSynth.test.ts` sync block) + the controller's browser pass — never by mounting the component.
- **`store/applySet` stays a pure primitive:** `setDeep(project, path, value)` only — no sync, suppression, opId, or gestureEnd logic inside it.
- **What STAYS in 2b-ii (do NOT touch):**
  - the `applyingFromNetwork` flag + `enterSuppress`/`exitSuppress` + the transitional suppress wrap around `applyRemote` in `messageDispatch.ts` (deleted in the final 2b sub-phase);
  - the **engine-slice** outbound watcher (`snapshot(project.tracks[i].engines[slice])` → `emitLeafDiff`) and the **synth2 matrix** outbound watcher — these migrate in the *next* sub-phase, NOT here;
  - ALL **audio-reaction** watchers in `buildAudioState` (engineType→`syncTrackToEngine`, slice→`applyParams`, mixer→`updateMixerGains`, enabled→lifecycle): they observe the same `setDeep` mutation `dispatchLocal` performs and must keep firing.
- **Behaviour must be preserved exactly:** one user edit must produce exactly one outbound op (never zero, never two). The discrete-vs-throttled policy (`DISCRETE_LEAF_FIELDS`) and the `syncReady` gate (no outbound before the room is live) are unchanged — they just move from the watcher into `dispatchLocal`/the bus `enqueue` closure.

---

## Design decisions (resolved with the user before planning)

- **Q1 — write mechanism = "v-model adapter (dispatch under the hood)".** A new `useCommandModel(path)` returns a writable `computed` whose getter reads the live value from the canonical `project` and whose setter calls `dispatchLocal`. Used for `v-model` controls (StepNumberInput, selects, the volume knob). For `@click` toggles / button handlers (mute/solo, engine buttons, note on/off) the handler calls `dispatchLocal(path, value)` directly. Both satisfy "components never mutate state directly". `Knob.vue` stays a pure UI component (no bus import).
- **Q2 — scope = simple scalar writers first.** 2b-ii covers bpm, engineType, enabled, patternLength, mixer (volume/muted/soloed), steps. Engine-param knob slices + synth2 matrix are deferred to the next sub-phase; the suppression flag dies in the final one.
- **`dispatchLocal(path, value)` derives `gestureEnd` internally** from the leaf segment via the existing `gestureEndForLeaf(leaf)` — exactly the policy the removed watchers used (discrete leaves flush immediately; continuous leaves ride the 50ms throttle and rely on the knob's `@gesture-end`/`endGesture(path)` mouseup flush, which is unchanged). This keeps the discrete/continuous policy in one place.
- **`priorValue` (nack rollback) is captured via `getDeep(project, path)` BEFORE the write** and threaded through `commandBus.dispatchLocal({ path, value, priorValue, gestureEnd })` → `outbox.enqueue(path, value, priorValue, gestureEnd)`, matching what the old watcher passed as `oldVal`.
- **`syncReady` gating moves into the bus `enqueue` closure** (in `buildSyncState`): `if (syncReady) outbox!.enqueue(...)`. `applySet` always runs (so a pre-live edit still drives audio/UI), only the enqueue is gated — identical to the old watcher's `outbox && syncReady` guard. The `!isApplyingFromNetwork()` half of the old guard is unnecessary on the local path: a local user gesture never runs inside an inbound apply.
- **Pre-connection fallback:** when `commandBus` is null (before `connectToSession`, or in tests), `dispatchLocal` writes straight to `project` via `setDeep` and does not enqueue — matching today's "mutation happens, nothing is sent" behaviour before a room is live.
- **Watcher removal is per-subsystem and self-contained:** removing the bpm watcher cannot affect engine-slice sync because each watcher is independent. The inbound path for the migrated field still works (`applyRemote`→`applySet`→reactive fan-out) and no longer has an outbound watcher to echo it, so for migrated fields the suppress wrap is simply a harmless no-op.

---

## File Structure

- `packages/shared/src/path.ts` — add `getDeep(obj, path)` (read-only dual of `setDeep`; never throws). Auto-exported — `index.ts` already does `export * from './path.js'`, so no index edit is needed.
- `packages/shared/src/path.test.ts` (or the existing path spec) — `getDeep` unit tests.
- `packages/client/src/composables/useSynth.ts` — add module-level `export function dispatchLocal(path, value)`; gate the bus `enqueue` closure on `syncReady`; migrate the bpm computed setter, `addTrack`/`removeTrack`; **delete** the bpm, engineType, enabled, patternLength, mixer, and steps outbound watchers from `installSyncWatchers()`; sweep two stale `applyOp` comments (lines ~376, ~703).
- `packages/client/src/sync/commandModel.ts` — **new.** `useCommandModel(path)` writable-computed adapter (+ re-exports nothing else).
- `packages/client/src/sync/commandModel.test.ts` — **new.** Unit tests for `useCommandModel` + `dispatchLocal` (no `.vue` mount).
- `packages/client/src/views/StudioView.vue` — engine-type buttons + the `set-length` handler dispatch instead of mutating.
- `packages/client/src/components/Tracker.vue` — step `v-model`s, mute/solo toggles, note on/off, and the volume knob dispatch instead of mutating.
- `packages/client/src/components/TrackMixer.vue` — mute/solo/volume dispatch instead of mutating (kept consistent even though currently unmounted).
- `packages/client/src/composables/useSynth.test.ts` — migrate the `engineType`/`mixer` outbound assertions from direct-mutation to dispatch-driven; add bpm/enabled/patternLength/steps dispatch assertions + "direct mutation no longer sends" regressions.
- `packages/client/src/sync/WsClient.ts` — sweep two stale `applyOp` comments (lines ~3, ~306) (housekeeping; folded into Task 1).

---

## Task 1: Local-dispatch infrastructure (additive, dormant)

Adds the write-path plumbing and proves it in isolation. Nothing calls it on a live edit yet (the watchers still do all sending), so behaviour is unchanged — the Phase-0/2a "wired but untouched" pattern.

**Files:**
- Modify: `packages/shared/src/path.ts` (add `getDeep`) — `index.ts` re-exports it automatically via `export * from './path.js'` (no index edit)
- Test: `packages/shared/src/path.test.ts` (create if absent)
- Create: `packages/client/src/sync/commandModel.ts`
- Test: `packages/client/src/sync/commandModel.test.ts`
- Modify: `packages/client/src/composables/useSynth.ts` (add `dispatchLocal`, gate bus `enqueue` on `syncReady`, sweep stale `applyOp` comments at ~376 and ~703)
- Modify: `packages/client/src/sync/WsClient.ts` (sweep stale `applyOp` comments at ~3 and ~306)

**Interfaces:**
- Consumes: `setDeep`, `pathKey`, `type Path` from `@fiddle/shared`; the module-scope `project`, `commandBus`, `syncReady`, `gestureEndForLeaf` already in `useSynth.ts`.
- Produces (later tasks rely on these exact signatures):
  - `getDeep(obj: Record<string, unknown>, path: Path): unknown` — leaf value or `undefined` if any intermediate is missing.
  - `dispatchLocal(path: Path, value: unknown): void` — exported from `packages/client/src/composables/useSynth.ts`. Writes state + enqueues via the bus when connected (gestureEnd derived from the leaf); falls back to a direct `setDeep` when `commandBus` is null.
  - `useCommandModel<T>(path: Path | (() => Path)): WritableComputedRef<T>` — exported from `packages/client/src/sync/commandModel.ts`.

- [ ] **Step 1: Write the failing `getDeep` test**

In `packages/shared/src/path.test.ts` (create if it does not exist; mirror the existing shared test style):

```ts
import { describe, it, expect } from 'vitest';
import { getDeep, setDeep } from './index.js';

describe('getDeep', () => {
  it('reads a nested leaf', () => {
    const o = { a: { b: { c: 7 } } };
    expect(getDeep(o, ['a', 'b', 'c'])).toBe(7);
  });

  it('returns undefined when an intermediate is missing (never throws)', () => {
    const o: Record<string, unknown> = { a: {} };
    expect(getDeep(o, ['a', 'x', 'y'])).toBeUndefined();
    expect(getDeep(o, ['nope'])).toBeUndefined();
  });

  it('returns undefined for the empty path', () => {
    expect(getDeep({ a: 1 }, [])).toBeUndefined();
  });

  it('is the read dual of setDeep for an existing leaf', () => {
    const o = { tracks: [{ bpm: 1 }] } as unknown as Record<string, unknown>;
    setDeep(o, ['tracks', 0, 'bpm'], 120);
    expect(getDeep(o, ['tracks', 0, 'bpm'])).toBe(120);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w @fiddle/shared -- path`
Expected: FAIL — `getDeep` is not exported.

- [ ] **Step 3: Implement `getDeep` in `packages/shared/src/path.ts`**

Append after `setDeep`:

```ts
// Read the leaf at a wire path, or `undefined` if any intermediate is missing.
// The read-only dual of setDeep: walks existing intermediates only and never
// throws (a broken path yields undefined), so a caller can use it to capture a
// pre-edit value for nack rollback without guarding the path first.
export function getDeep(obj: Record<string, unknown>, path: Path): unknown {
  if (path.length === 0) return undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cursor: any = obj;
  for (let i = 0; i < path.length - 1; i++) {
    cursor = cursor?.[path[i]!];
    if (cursor == null) return undefined;
  }
  return cursor?.[path[path.length - 1]!];
}
```

`packages/shared/src/index.ts` already has `export * from './path.js'` (line ~42), so `getDeep` is exported automatically — no index edit.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w @fiddle/shared -- path`
Expected: PASS.

- [ ] **Step 5: Add `dispatchLocal` to `useSynth.ts` + gate the bus `enqueue` on `syncReady`**

In `packages/client/src/composables/useSynth.ts`:

(a) extend the shared import to include `getDeep` (the file already imports `setDeep`):
`import { setDeep, getDeep, type Path } from '@fiddle/shared';` (merge into the existing `@fiddle/shared` import — keep `TRACK_POOL_SIZE` etc.).

(b) in `buildSyncState`, change the bus `enqueue` closure to gate on `syncReady`:

```ts
    enqueue: (path: Path, value: unknown, priorValue: unknown, gestureEnd: boolean) => {
      // Outbound is gated on the room being live — mirrors the (removed) sync
      // watchers' `outbox && syncReady` guard, so a local edit made during the
      // initial catch-up writes state but is not leaked up before the room loads.
      if (syncReady) outbox!.enqueue(path, value, priorValue, gestureEnd);
    },
```

(c) add the module-level entry point (place it next to `endGesture`, ~line 199):

```ts
// The single outbound entry point for a LOCAL edit. Writes state through the
// command bus (which also enqueues the op for delivery) when a room connection
// exists; before one does (pre-connect / tests) it mutates the local project
// directly so the edit still drives audio + UI without trying to sync. The
// discrete-vs-throttled policy (flush-now vs ride the 50ms throttle) is derived
// from the leaf field — the same policy the removed sync watchers applied.
export function dispatchLocal(path: Path, value: unknown): void {
  const gestureEnd = gestureEndForLeaf(String(path[path.length - 1]));
  if (commandBus) {
    commandBus.dispatchLocal({
      path,
      value,
      priorValue: getDeep(project as unknown as Record<string, unknown>, path),
      gestureEnd,
    });
  } else {
    setDeep(project as unknown as Record<string, unknown>, path, value);
  }
}
```

(d) while here, sweep the two stale `applyOp` comments (M4 carry-over):
- `installSyncWatchers()` header (~line 376): replace the phrase "held synchronously during applyOp/replaceProject" with "held synchronously during applyRemote/replaceProject".
- `buildAudioState` audio-watcher note (~line 703): replace "in step with the synchronous applyOp write" with "in step with the synchronous applyRemote write".

- [ ] **Step 6: Write the failing `commandModel` / `dispatchLocal` test**

Create `packages/client/src/sync/commandModel.test.ts`. This exercises the dormant infra WITHOUT a live socket (commandBus null → setDeep fallback) and WITHOUT mounting a `.vue`:

```ts
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
```

- [ ] **Step 7: Run it to verify it fails**

Run: `npm test -w @fiddle/client -- commandModel`
Expected: FAIL — `./commandModel` does not exist.

- [ ] **Step 8: Implement `useCommandModel`**

Create `packages/client/src/sync/commandModel.ts`:

```ts
// useCommandModel — a v-model adapter that routes a control's writes through
// the command bus instead of mutating `project` directly.
//
// The returned writable computed reads the live value at `path` from the
// canonical project (reactively, so the control stays in sync with remote
// edits) and, on write, dispatches a local `set` command via dispatchLocal.
// `path` may be a thunk so a loop-bound control (a step cell, a mixer channel)
// can compute its path per render.

import { computed, type WritableComputedRef } from 'vue';
import { getDeep, type Path } from '@fiddle/shared';
import { project } from '../stores/project';
import { dispatchLocal } from '../composables/useSynth';

export function useCommandModel<T = unknown>(
  path: Path | (() => Path),
): WritableComputedRef<T> {
  const resolve = typeof path === 'function' ? path : () => path;
  return computed<T>({
    get: () => getDeep(project as unknown as Record<string, unknown>, resolve()) as T,
    set: (v) => dispatchLocal(resolve(), v),
  });
}
```

- [ ] **Step 9: Run the client test to verify it passes**

Run: `npm test -w @fiddle/client -- commandModel`
Expected: PASS (all 5 cases).

- [ ] **Step 10: Sweep the WsClient stale `applyOp` comments**

In `packages/client/src/sync/WsClient.ts`, update the two comments at ~line 3 and ~line 306 that still reference `applyOp` to say `applyRemote` / the CommandBus (read each in context and reword minimally — comment-only, no logic change).

- [ ] **Step 11: Typecheck + full gate**

Run: `npm run typecheck && npm test`
Expected: PASS. No behaviour change (nothing live calls `dispatchLocal`/`useCommandModel` yet; the watchers still send).

- [ ] **Step 12: Commit**

```bash
git add packages/shared/src/path.ts packages/shared/src/path.test.ts \
        packages/client/src/sync/commandModel.ts packages/client/src/sync/commandModel.test.ts \
        packages/client/src/composables/useSynth.ts packages/client/src/sync/WsClient.ts
git commit -m "feat(sync): add dispatchLocal + useCommandModel local-command infra (phase 2b-ii)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Migrate bpm → dispatch; remove the bpm outbound watcher

**Files:**
- Modify: `packages/client/src/composables/useSynth.ts` (bpm computed setter; delete the bpm watcher in `installSyncWatchers`, lines ~380-388)
- Test: `packages/client/src/composables/useSynth.test.ts` (sync block)

**Interfaces:**
- Consumes: `dispatchLocal` (Task 1).
- Produces: nothing new — behaviour-preserving migration.

- [ ] **Step 1: Write the failing tests (sync block of `useSynth.test.ts`)**

Add to the `describe('sync integration', …)` block. Each test boots its own harness via `const { mod, synth, fake } = await bootWithFakeSocket()` (it returns `{ mod, synth, fake }`, opens the `syncReady` gate, and records sends in `fake.sent`). bpm is NOT in `DISCRETE_LEAF_FIELDS`, so it rides the 50ms throttle → advance fake timers:

```ts
it('emits a bpm op via the bpm computed setter (dispatch path)', async () => {
  const { synth, fake } = await bootWithFakeSocket();
  synth.bpm = 132; // writable computed → dispatchLocal(['bpm'], 132)
  vi.advanceTimersByTime(50); // bpm rides the 50ms throttle
  const op = fake.sent.find((o) => JSON.stringify(o.path) === JSON.stringify(['bpm']));
  expect(op?.value).toBe(132);
});

it('a direct project.bpm mutation no longer emits (watcher removed)', async () => {
  const { synth, fake } = await bootWithFakeSocket();
  synth.project.bpm = 99; // direct mutation — no outbound watcher should catch it
  vi.advanceTimersByTime(50);
  expect(fake.sent.find((o) => JSON.stringify(o.path) === JSON.stringify(['bpm']))).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify the first test fails**

Run: `npm test -w @fiddle/client -- useSynth`
Expected: the new bpm-dispatch test FAILS (setter still does `project.bpm = v`, watcher sends on direct mutation so the "no longer emits" test also fails).

- [ ] **Step 3: Migrate the bpm computed setter**

In `useSynth()` (~line 806), change the setter:

```ts
  const bpm = computed({
    get: () => project.bpm,
    set: (v: number) => { dispatchLocal(['bpm'], v); },
  });
```

- [ ] **Step 4: Delete the bpm outbound watcher**

In `installSyncWatchers()` remove the whole `watch(() => project.bpm, …, { flush: 'sync' })` block (lines ~380-388).

- [ ] **Step 5: Run to verify both tests pass**

Run: `npm test -w @fiddle/client -- useSynth`
Expected: PASS (dispatch emits exactly one bpm op; direct mutation emits none).

- [ ] **Step 6: Typecheck + commit**

```bash
git add packages/client/src/composables/useSynth.ts packages/client/src/composables/useSynth.test.ts
git commit -m "refactor(sync): route bpm through dispatchLocal, drop bpm watcher (phase 2b-ii)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Migrate track-scalar discrete writers (engineType, enabled, patternLength)

These three are independent scalar leaves on a track. engineType and enabled have audio-reaction watchers (which STAY); patternLength has none (the sequencer reads it live).

**Files:**
- Modify: `packages/client/src/composables/useSynth.ts` (`addTrack`/`removeTrack`; delete the engineType watcher ~390-399, patternLength watcher ~468-476, enabled watcher ~478-486)
- Modify: `packages/client/src/views/StudioView.vue` (11 engine-type buttons; the `set-length` handler)
- Test: `packages/client/src/composables/useSynth.test.ts`

**Interfaces:**
- Consumes: `dispatchLocal` (Task 1).

- [ ] **Step 1: Write/adjust the failing tests**

In `useSynth.test.ts` sync block, **migrate** the existing `emits engineType swaps immediately (discrete)` test from direct mutation to dispatch, and add enabled + patternLength dispatch tests plus "direct mutation no longer sends" regressions:

engineType, enabled, and patternLength are all discrete (in `DISCRETE_LEAF_FIELDS`) → they flush immediately, no timer advance. Drive dispatch via `mod.dispatchLocal` (the fresh module instance the harness booted):

```ts
it('emits an engineType swap via dispatch (discrete)', async () => {
  const { mod, fake } = await bootWithFakeSocket();
  mod.dispatchLocal(['tracks', 0, 'engineType'], 'kick');
  const op = fake.sent.find((o) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'engineType']));
  expect(op?.value).toBe('kick');
});

it('a direct engineType mutation no longer emits (watcher removed)', async () => {
  const { synth, fake } = await bootWithFakeSocket();
  synth.project.tracks[0].engineType = 'hat';
  vi.advanceTimersByTime(50);
  expect(fake.sent.find((o) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'engineType']))).toBeUndefined();
});

it('addTrack emits an enabled op via dispatch', async () => {
  const { synth, fake } = await bootWithFakeSocket();
  const firstDisabled = synth.project.tracks.findIndex((t: any) => !t.enabled);
  synth.addTrack();
  const onOp = fake.sent.find((o) => JSON.stringify(o.path) === JSON.stringify(['tracks', firstDisabled, 'enabled']));
  expect(onOp?.value).toBe(true);
});

it('emits a patternLength op via dispatch', async () => {
  const { mod, fake } = await bootWithFakeSocket();
  mod.dispatchLocal(['tracks', 0, 'patternLength'], 32);
  const op = fake.sent.find((o) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'patternLength']));
  expect(op?.value).toBe(32);
});
```

- [ ] **Step 2: Run to verify failures**

Run: `npm test -w @fiddle/client -- useSynth`
Expected: the engineType "direct mutation no longer emits" + addTrack-dispatch tests FAIL (watchers still send; addTrack still mutates directly).

- [ ] **Step 3: Migrate `addTrack` / `removeTrack`**

```ts
  const addTrack = (): void => {
    const idx = project.tracks.findIndex(t => !t.enabled);
    if (idx !== -1) dispatchLocal(['tracks', idx, 'enabled'], true);
  };

  const removeTrack = (index: number): void => {
    if (index < 0 || index >= TRACK_POOL_SIZE) return;
    if (!project.tracks[index].enabled) return;
    if (enabledTrackCount.value <= 1) return;
    dispatchLocal(['tracks', index, 'enabled'], false);
  };
```

- [ ] **Step 4: Delete the engineType, patternLength, and enabled outbound watchers**

In `installSyncWatchers()` remove the three `watch(…, { flush:'sync' })` blocks for `project.tracks[i].engineType` (~390-399), `project.tracks[i].patternLength` (~468-476), and `project.tracks[i].enabled` (~478-486). Leave the engine-slice watcher, mixer watcher, steps watcher, and matrix watcher in place for now.

- [ ] **Step 5: Migrate the StudioView write sites**

In `packages/client/src/views/StudioView.vue`:
- Import the entry point in `<script setup>`: `import { dispatchLocal } from '../composables/useSynth';` (StudioView already calls `useSynth()`; it also has `activeTrackIndex` in scope).
- Add a helper near the other handlers:
  ```ts
  function setEngineType(t: EngineType) {
    if (activeTrackIndex.value === null) return;
    dispatchLocal(['tracks', activeTrackIndex.value, 'engineType'], t);
  }
  ```
  (Import `EngineType` from `@fiddle/shared` if not already.)
- Change each of the 11 engine buttons (lines ~91-154) from `@click="focusedTrack!.engineType = 'synth'"` to `@click="setEngineType('synth')"` (and `'kick'`, `'hat'`, `'snare'`, `'clap'`, `'synth2'`, `'kick2'`, `'snare2'`, `'hat2'`, `'clap2'`). The `:class`/`:style` reads of `focusedTrack!.engineType` stay unchanged.
- Find the `set-length` handler (the handler bound to Tracker's `@set-length`, payload `{ trackId, length }`) and change its body from mutating `patternLength` to:
  ```ts
  dispatchLocal(['tracks', trackId, 'patternLength'], length);
  ```

- [ ] **Step 6: Run the gate**

Run: `npm run typecheck && npm test -w @fiddle/client -- useSynth`
Expected: PASS. (The `.vue` button/handler changes are verified by the controller's browser pass, not unit tests.)

- [ ] **Step 7: Commit**

```bash
git add packages/client/src/composables/useSynth.ts packages/client/src/views/StudioView.vue packages/client/src/composables/useSynth.test.ts
git commit -m "refactor(sync): route engineType/enabled/patternLength through dispatch, drop their watchers (phase 2b-ii)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Migrate mixer (volume / muted / soloed); remove the mixer outbound watcher

The mixer audio-reaction watcher (`snapshot(mixer)` → `updateMixerGains`) STAYS — it observes the same `setDeep`. Only the outbound mixer watcher is removed.

**Files:**
- Modify: `packages/client/src/components/Tracker.vue` (inline mute/solo toggles ~206/212; the volume Knob ~196-200)
- Modify: `packages/client/src/components/TrackMixer.vue` (mute ~61, solo ~69, volume control)
- Modify: `packages/client/src/composables/useSynth.ts` (delete the mixer watcher ~418-429)
- Test: `packages/client/src/composables/useSynth.test.ts`

**Interfaces:**
- Consumes: `dispatchLocal`, `useCommandModel` (Task 1).

- [ ] **Step 1: Migrate the existing mixer test to dispatch**

Replace the body of `emits mixer volume (throttled) and muted (immediate) as leaf ops` (line ~326) so it drives dispatch rather than direct mutation:

```ts
it('emits mixer muted (immediate) and volume (throttled) as leaf ops via dispatch', async () => {
  const { mod, fake } = await bootWithFakeSocket();
  mod.dispatchLocal(['tracks', 1, 'mixer', 'muted'], true); // discrete → immediate
  expect(fake.sent.find((o) => JSON.stringify(o.path) === JSON.stringify(['tracks', 1, 'mixer', 'muted']))?.value).toBe(true);

  mod.dispatchLocal(['tracks', 1, 'mixer', 'volume'], 0.5); // continuous → throttled
  expect(fake.sent.find((o) => JSON.stringify(o.path) === JSON.stringify(['tracks', 1, 'mixer', 'volume']))).toBeUndefined();
  vi.advanceTimersByTime(50);
  expect(fake.sent.find((o) => JSON.stringify(o.path) === JSON.stringify(['tracks', 1, 'mixer', 'volume']))?.value).toBe(0.5);
});

it('a direct mixer mutation no longer emits (watcher removed)', async () => {
  const { synth, fake } = await bootWithFakeSocket();
  synth.project.tracks[1].mixer.muted = false;
  vi.advanceTimersByTime(50);
  expect(fake.sent.find((o) => JSON.stringify(o.path) === JSON.stringify(['tracks', 1, 'mixer', 'muted']))).toBeUndefined();
});
```

This mirrors the existing `emits mixer volume (throttled) and muted (immediate)` test (line ~326) — same pre-throttle-undefined → advance-50 → present assertion, just dispatch-driven.

- [ ] **Step 2: Run to verify failures**

Run: `npm test -w @fiddle/client -- useSynth`
Expected: the "direct mutation no longer emits" test FAILS (watcher still present).

- [ ] **Step 3: Delete the mixer outbound watcher**

In `installSyncWatchers()` remove the `watch(() => snapshot(project.tracks[i].mixer), …, { flush:'sync' })` block (~418-429).

- [ ] **Step 4: Run to verify the unit tests pass**

Run: `npm test -w @fiddle/client -- useSynth`
Expected: PASS (dispatch sends; direct mutation does not).

- [ ] **Step 5: Migrate Tracker.vue mixer write sites**

In `packages/client/src/components/Tracker.vue` (`trackId` prop = track index; the file already imports `endGesture` from `useSynth` and builds mixer paths inline at ~199):
- Import `dispatchLocal`: extend the existing `import { endGesture } from '../composables/useSynth'` to `import { dispatchLocal, endGesture } from '../composables/useSynth';`, and `import { useCommandModel } from '../sync/commandModel';`.
- Mute toggle (~206): `@click="dispatchLocal(['tracks', trackId, 'mixer', 'muted'], !mixer.muted)"`.
- Solo toggle (~212): `@click="dispatchLocal(['tracks', trackId, 'mixer', 'soloed'], !mixer.soloed)"`.
- Volume Knob (~196-200): it already carries `:syncPath="['tracks', trackId, 'mixer', 'volume']"` and `@gesture-end="endGesture([...])"`. Replace its `v-model="mixer.volume"` (direct slice mutation) with a command model:
  ```ts
  // in <script setup>
  const volumeModel = useCommandModel<number>(() => ['tracks', props.trackId, 'mixer', 'volume']);
  ```
  ```html
  <Knob ... v-model="volumeModel" :syncPath="['tracks', trackId, 'mixer', 'volume']" @gesture-end="endGesture(['tracks', trackId, 'mixer', 'volume'])" />
  ```
  (`endGesture` flush on mouseup is unchanged; the continuous volume value rides the throttle exactly as before.)

> If `mixer` in Tracker is a prop/computed that aliases `project.tracks[trackId].mixer`, the `!mixer.muted` read in the `@click` still reflects live state — only the write moves to dispatch.

- [ ] **Step 6: Migrate TrackMixer.vue mixer write sites**

In `packages/client/src/components/TrackMixer.vue` (iterates channels with an index; `chan.track` aliases a pool track — derive the track's pool index the component already uses for its `syncPath`/`endGesture`, e.g. `chan.index`):
- Import `dispatchLocal` + `useCommandModel` from the same modules.
- Mute (~61): `@click="dispatchLocal(['tracks', chan.index, 'mixer', 'muted'], !chan.track.mixer.muted)"`.
- Solo (~69): `@click="dispatchLocal(['tracks', chan.index, 'mixer', 'soloed'], !chan.track.mixer.soloed)"`.
- Volume control: bind through `useCommandModel(() => ['tracks', chan.index, 'mixer', 'volume'])` (same pattern as Tracker), keeping any existing `endGesture` flush.

> Read the file to confirm the exact channel-index expression (`chan.index` vs a `v-for` index `i`) and the volume control element. TrackMixer is currently unmounted in the studio, but migrate it for consistency so a future remount can't reintroduce direct mutation.

- [ ] **Step 7: Gate + commit**

Run: `npm run typecheck && npm test -w @fiddle/client`
```bash
git add packages/client/src/composables/useSynth.ts packages/client/src/components/Tracker.vue packages/client/src/components/TrackMixer.vue packages/client/src/composables/useSynth.test.ts
git commit -m "refactor(sync): route mixer writes through dispatch, drop mixer watcher (phase 2b-ii)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Migrate steps; remove the steps outbound watcher

Steps have NO audio-reaction watcher (the sequencer reads `track.steps` live each tick), so removing the steps outbound watcher and dispatching writes is clean.

**Files:**
- Modify: `packages/client/src/components/Tracker.vue` (step `v-model`s ~115-143, mute toggle ~102, note on/off function ~323-326, plus any velocity binding)
- Modify: `packages/client/src/composables/useSynth.ts` (delete the steps watcher ~431-444)
- Test: `packages/client/src/composables/useSynth.test.ts`

**Interfaces:**
- Consumes: `dispatchLocal`, `useCommandModel` (Task 1).

- [ ] **Step 1: Write failing step-dispatch tests**

In `useSynth.test.ts` sync block:

`note` and `octave` are discrete (in `DISCRETE_LEAF_FIELDS`) → flush immediately, no timer advance:

```ts
it('emits a step note op via dispatch (discrete leaf)', async () => {
  const { mod, fake } = await bootWithFakeSocket();
  mod.dispatchLocal(['tracks', 0, 'steps', 0, 'note'], 'C');
  const op = fake.sent.find((o) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'steps', 0, 'note']));
  expect(op?.value).toBe('C');
});

it('emits a step octave op via dispatch (discrete leaf)', async () => {
  const { mod, fake } = await bootWithFakeSocket();
  mod.dispatchLocal(['tracks', 0, 'steps', 2, 'octave'], 5);
  expect(fake.sent.find((o) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'steps', 2, 'octave']))?.value).toBe(5);
});

it('a direct step mutation no longer emits (watcher removed)', async () => {
  const { synth, fake } = await bootWithFakeSocket();
  synth.project.tracks[0].steps[0].octave = 7;
  vi.advanceTimersByTime(50);
  expect(fake.sent.find((o) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'steps', 0, 'octave']))).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w @fiddle/client -- useSynth`
Expected: "direct step mutation no longer emits" FAILS (steps watcher still present).

- [ ] **Step 3: Delete the steps outbound watcher**

In `installSyncWatchers()` remove the `watch(() => snapshot(project.tracks[i].steps), …, { flush:'sync' })` block (~431-444).

- [ ] **Step 4: Run to verify unit tests pass**

Run: `npm test -w @fiddle/client -- useSynth`
Expected: PASS.

- [ ] **Step 5: Migrate Tracker.vue step write sites**

In `Tracker.vue`, `step` is the reactive step object from the `visibleSteps`/`props.steps` v-for; capture each step's index. The cleanest per-cell pattern uses `useCommandModel` with a thunk for the `v-model` controls and `dispatchLocal` for toggles/handlers:

For each step row, derive the step's pool index `i` from the v-for (`v-for="(step, i) in visibleSteps"` — confirm the index variable; `visibleSteps` is `props.steps.slice(0, patternLength)`, so `i` is the real step index). Then:
- Note selects (~115, ~134): `<select :value="step.note" @change="e => dispatchLocal(['tracks', trackId, 'steps', i, 'note'], (e.target as HTMLSelectElement).value || null)">` — preserve the existing empty-string→`null` semantics.
- Chord-type select (~121): same `@change`→`dispatchLocal(['tracks', trackId, 'steps', i, 'chordType'], …)`.
- Octave / Length `StepNumberInput` (~126/129/140/143): replace `v-model="step.octave"` with `:model-value="step.octave"` + `@update:model-value="v => dispatchLocal(['tracks', trackId, 'steps', i, 'octave'], v)"` (and `length`). (StepNumberInput emits `update:modelValue`; verify its emit name and keep it.)
- Mute toggle (~102): `@click="dispatchLocal(['tracks', trackId, 'steps', i, 'muted'], !step.muted)"`.
- Note on/off function (~323-326): convert the `toggleNote(step)` body to dispatch:
  ```ts
  function toggleNote(step, i) {
    dispatchLocal(['tracks', props.trackId, 'steps', i, 'note'], step.note !== null ? null : 'C');
  }
  ```
  and pass the index from the template call site.
- Any velocity / `isChord` binding present in the row: migrate the same way (`v-model` → `:model-value`+`@update`/dispatch).
- Import `dispatchLocal` (already importing `endGesture` from `useSynth`).

> Read the full step-row template region (~95-185) and the `<script setup>` toggle/handler functions before editing; migrate **every** field that today mutates `step.*` (`note`, `octave`, `length`, `muted`, `chordType`, and `velocity`/`isChord` if bound). Any missed field would silently stop syncing once its shared watcher is gone — so confirm against the `DISCRETE_LEAF_FIELDS`/step schema that all step leaves are covered.

- [ ] **Step 6: Gate + commit**

Run: `npm run typecheck && npm test -w @fiddle/client`
```bash
git add packages/client/src/composables/useSynth.ts packages/client/src/components/Tracker.vue packages/client/src/composables/useSynth.test.ts
git commit -m "refactor(sync): route step writes through dispatch, drop steps watcher (phase 2b-ii)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Post-tasks: end state + final review

After Task 5, `installSyncWatchers()` retains exactly two outbound watchers — the **engine-slice** watcher and the **synth2 matrix** watcher — plus the `syncReady`/`isApplyingFromNetwork` machinery they still need. The `applyingFromNetwork` flag, `enterSuppress`/`exitSuppress`, and the `applyRemote` suppress wrap are untouched. Grep checks for the controller:

```bash
grep -n "watch(" packages/client/src/composables/useSynth.ts   # only engine-slice + matrix outbound + the audio-reaction watchers remain
grep -rn "\.bpm\s*=\|\.engineType\s*=\|\.patternLength\s*=\|mixer\.\(muted\|soloed\|volume\)\s*=\|step\.\(note\|octave\|length\|muted\|chordType\)\s*=" packages/client/src/components packages/client/src/views   # no direct mutations of migrated fields remain (reads in :class/:style are fine)
```

**Browser verification (controller, once, before merge):** with `npm run dev:obs` (confirm LOCAL Docker DB via `ps eww`), two tabs in one room:
1. bpm edit on tab A → tab B; engine-type swap → tab B (+ local audio graph rebuilds); add/remove track → enabledTrackCount converges; pattern-length change → converges.
2. mute/solo/volume on tab A → tab B (volume rides the throttle, snaps cleanly on release).
3. step edits (note/octave/length/mute/chord) on tab A → tab B.
4. Drag a still-watcher-driven engine param (e.g. Cutoff) → confirm it still syncs and the self-echo no-snap still holds (suppression path intact).
5. Reload a tab → snapshot restores all migrated fields. Console clean (favicon 404 only). Close tabs.

Then dispatch the final whole-branch review (opus) over `git merge-base main HEAD`..HEAD and proceed to superpowers:finishing-a-development-branch.

---

## Self-Review (run before dispatching Task 1)

- **Spec coverage:** the spec's Phase 2 "migrate write sites + delete direct-mutation watchers" is delivered incrementally for the simple writers; engine-param slices/matrix + the `applyingFromNetwork` deletion are explicitly deferred to later sub-phases (documented in Global Constraints). ✅
- **Type consistency:** `dispatchLocal(path, value)`, `getDeep(obj, path)`, `useCommandModel<T>(path | () => path)` are referenced with identical signatures across Tasks 1-5. ✅
- **No placeholders:** every code step shows complete code or an exact transformation rule + exhaustive site list; `.vue` repetitive transforms give one worked example + the full field list (DRY). The implementer must read the three `.vue` files to confirm exact line context — flagged in each task. ✅
- **One-op invariant:** every subsystem task pairs a dispatch test (sends exactly one op) with a "direct mutation no longer sends" regression (proves the watcher is gone) — guarding against both double-send and zero-send. ✅
