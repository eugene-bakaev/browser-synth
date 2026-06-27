# Lifecycle Architecture — Phase 1 (Store canonical + read selectors) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Pinia `ProjectStore` hold the **single canonical** `project` instance the whole app shares, expose read-only selectors, and migrate the studio's read-only bindings to read from the store — with **no write-path and no behaviour change**.

**Architecture:** Today `useSynth.ts` creates the one live `project` at module scope (`useSynth.ts:66`) and Phase 0's store holds a *separate* throwaway `freshProject()`. Phase 1 unifies them: the canonical instance is lifted into `stores/project.ts` as a module-scope reactive that the store returns, and `useSynth.ts` imports that same instance instead of creating its own. Because both sides now reference one object, the store's selectors reflect live state, and read-only components can read the store directly. Writes still flow through the existing direct-mutation path (unchanged) — funnelling them through a command bus is Phase 2.

**Tech Stack:** Vue 3.5, Pinia, Vitest 4, TypeScript.

## Design decisions (Phase 1)

- **P1 — Instance unification mechanism.** The canonical `project` moves to **module scope in `stores/project.ts`**; the store's setup returns it; `useSynth.ts` imports it (deleting its own `reactive(freshProject())`). Chosen over the alternative ("`useSynth` calls `useProjectStore().project` at every call site") because that alternative requires an active Pinia at `useSynth` module-load time (there is none — module bodies run before `main.ts` calls `createPinia()`) and would force a Pinia-aware rewrite of `useSynth`'s ~600-test harness. Importing the raw module-scope reactive needs no Pinia and touches `useSynth` in exactly one line. The module-scope singleton is **retained** for now (it matches today's `useSynth` line 66); eliminating it — creating `project` inside `AppRuntime.bootstrap`, one per page — is **Phase 5**.
- **P2 — Reads only.** Phase 1 changes **no writes**. The studio still mutates `project` directly (e.g. `focusedTrack.engineType = 'synth'`, `bpm.value = …`, step toggles). Only genuinely read-only bindings migrate to store selectors. Fields where a component both reads and writes the same value migrate in **Phase 2**, together with their writes.
- **P3 — Transitional raw export.** `stores/project.ts` exports the raw `project` reactive so `useSynth.ts` (and, transitively, the sync layer it feeds) can keep mutating it directly this phase. That export disappears in **Phase 2**, when writes funnel through `store.applySet` and nothing mutates the instance directly.

## Global Constraints

- Work on branch `feat/lifecycle-architecture` (currently equal to `main` `30020aa`). **Never commit on `main`.**
- **The store holds NO live resources** — no WebSocket, no AudioContext, no timers. Pure state + derived reads.
- **No write-path changes this phase.** Do NOT add `applySet`, a `CommandBus`, `dispatch`, or any `dispose()`. Do NOT change how edits are applied. Writes stay on the existing direct-mutation + `applyOp` path.
- **Exactly one canonical `project` instance.** After Task 1 the only `reactive(freshProject())` in app (non-test) code is the module-scope one in `stores/project.ts`. `useSynth.ts` must not create its own.
- Import `freshProject`, `replaceProject`, and the types `Project` / `ProjectTrack` / `EngineType` from `../project` (the client barrel). Import store primitives from `pinia` / `vue`.
- **Do NOT mount `.vue` files in unit tests.** Component-read migration (Task 3) is verified by typecheck + build + the full suite staying green + browser, not by a unit test — this is consistent with the spec's testing strategy (components are covered through store tests).
- Store tests isolate with `setActivePinia(createPinia())` **and** `__resetProjectStoreForTest()` in `beforeEach` (the module-scope singleton means a fresh Pinia alone no longer resets project state).
- A fresh `Project` has `TRACK_POOL_SIZE` (32) track slots, exactly **4** `enabled`.
- Stage only the files each task names — never `git add -A` / `git add .`. Never stage `studio-initial.png` or `synth2-wave-previews.png`.
- End every commit message with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Gate after the last task (from repo root): `npm run typecheck && npm test && npm run build`.

---

### Task 1: Store owns the single canonical project instance

Lift the canonical `project` into the store at module scope and make `useSynth` import it, so there is exactly one instance and the store's selectors reflect live edits.

**Files:**
- Modify: `packages/client/src/stores/project.ts`
- Modify: `packages/client/src/composables/useSynth.ts:66` (delete the local creation; import the store's instance)
- Test: `packages/client/src/stores/project.test.ts`

**Interfaces:**
- Consumes: `freshProject()`, `replaceProject(target, source)`, types `Project` / `ProjectTrack` from `../project`.
- Produces (later tasks + `useSynth` rely on these exact names):
  - `useProjectStore()` — unchanged store id `'project'`; `.project` now refers to the module-scope canonical instance.
  - `project` — a **named export**: the raw module-scope `reactive<Project>` canonical instance (imported by `useSynth.ts`; removed in Phase 2).
  - `__resetProjectStoreForTest(): void` — replaces the canonical instance's contents with a fresh project, for test isolation.

- [ ] **Step 1: Update the failing test first (isolation + sharing semantics)**

Replace the `beforeEach` and add a sharing test in `packages/client/src/stores/project.test.ts`. The file currently imports from `./project` and uses `setActivePinia(createPinia())` only. New full contents:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { TRACK_POOL_SIZE } from '@fiddle/shared';
import { freshProject } from '../project';
import { useProjectStore, __resetProjectStoreForTest } from './project';

describe('useProjectStore', () => {
  beforeEach(() => {
    // The canonical project is now a module-scope singleton, so a fresh Pinia
    // alone no longer resets its state — reset the shared instance explicitly.
    __resetProjectStoreForTest();
    setActivePinia(createPinia());
  });

  it('starts holding a fresh project with the full track pool', () => {
    const store = useProjectStore();
    expect(store.project.tracks.length).toBe(TRACK_POOL_SIZE);
  });

  it('enabledTrackCount counts only enabled slots (4 on a fresh project)', () => {
    const store = useProjectStore();
    expect(store.enabledTrackCount).toBe(4);
  });

  it('getTrack returns the slot at the given index', () => {
    const store = useProjectStore();
    expect(store.getTrack(0)).toBe(store.project.tracks[0]);
  });

  it('loadProject replaces contents in place (stable .project identity)', () => {
    const store = useProjectStore();
    const before = store.project;
    const next = freshProject();
    next.bpm = 137;
    store.loadProject(next);
    expect(store.project).toBe(before); // same object — replaced in place
    expect(store.project.bpm).toBe(137);
  });

  it('exposes ONE module-scope canonical instance shared across Pinia instances', () => {
    const a = useProjectStore();
    a.project.bpm = 151;
    setActivePinia(createPinia()); // a brand-new Pinia → a new store wrapper
    const b = useProjectStore();
    expect(b.project).toBe(a.project); // same underlying canonical object
    expect(b.project.bpm).toBe(151);   // shared state, not a fresh copy
  });

  it('__resetProjectStoreForTest restores a fresh project in place', () => {
    const store = useProjectStore();
    store.project.bpm = 200;
    __resetProjectStoreForTest();
    expect(store.project.bpm).toBe(freshProject().bpm);
    expect(store.project.tracks.length).toBe(TRACK_POOL_SIZE);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/client && npx vitest run src/stores/project.test.ts`
Expected: FAIL — `__resetProjectStoreForTest` is not exported yet (import error / not a function).

- [ ] **Step 3: Lift the canonical instance to module scope in the store**

Replace the contents of `packages/client/src/stores/project.ts`:

```ts
import { defineStore } from 'pinia';
import { reactive, computed } from 'vue';
import { freshProject, replaceProject, type Project, type ProjectTrack } from '../project';

// THE single canonical project instance for the whole app. Lifted to module
// scope (Phase 1) so the Pinia store and the legacy `useSynth` module share ONE
// object: useSynth imports this instead of creating its own. This matches
// useSynth's existing module-scope singleton (useSynth.ts:66 before Phase 1).
// Phase 5 moves creation into AppRuntime.bootstrap (one instance per page) and
// drops this module-scope singleton.
//
// Holds ONLY data — no socket, no AudioContext, no timers.
const project = reactive<Project>(freshProject());

export const useProjectStore = defineStore('project', () => {
  const enabledTrackCount = computed(() => project.tracks.filter((t) => t.enabled).length);

  function getTrack(index: number): ProjectTrack {
    return project.tracks[index];
  }

  // Replace the project's contents in place (snapshot load / future reconnect),
  // preserving the `project` object identity so reactive bindings survive.
  function loadProject(next: Project): void {
    replaceProject(project, next);
  }

  return { project, enabledTrackCount, getTrack, loadProject };
});

// Raw access to the canonical instance for the legacy useSynth module (and the
// sync layer it feeds), which still mutates project directly this phase.
// Removed in Phase 2 when all writes funnel through the command bus.
export { project };

// Test-only: reset the shared module-scope instance between cases. The module
// singleton means setActivePinia(createPinia()) alone no longer isolates project
// state. Removed in Phase 5 when creation moves to AppRuntime.bootstrap.
export function __resetProjectStoreForTest(): void {
  replaceProject(project, freshProject());
}
```

- [ ] **Step 4: Run the store test to verify it passes**

Run: `cd packages/client && npx vitest run src/stores/project.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Point `useSynth` at the store's instance**

In `packages/client/src/composables/useSynth.ts`, delete the local creation at line 66:

```ts
const project: Project = reactive(freshProject());
```

and import the canonical instance instead. Add this import alongside the other relative imports near the top of the file (place it after the existing `../project` import group):

```ts
import { project } from '../stores/project';
```

Leave every other line untouched — all 51 in-function references to `project`, the `replaceProject(project, freshProject())` reset at line 546, the sync deps `project` at line 290, and the returned `project` at line 948 now resolve to the imported canonical instance. Do NOT remove the existing `reactive` or `freshProject` imports — `reactive` is still used for `sequencer` (line 68) and `freshProject` is still used at line 546.

- [ ] **Step 6: Run the full client suite to confirm no regression**

Run: `cd packages/client && npx vitest run`
Expected: all pass. The existing `useSynth` tests exercise the canonical project through the returned context; they prove the imported instance behaves identically. The 6 store tests pass. (If a `useSynth` test fails because its `bootWithFakeSocket()` does `vi.resetModules()`: that is expected to still work — after a module reset, both `useSynth` and `stores/project` re-import fresh, so `useSynth` gets the fresh module-scope instance; no Pinia is required because `useSynth` imports the raw reactive, not `useProjectStore()`.)

- [ ] **Step 7: Commit**

```bash
git add packages/client/src/stores/project.ts packages/client/src/composables/useSynth.ts packages/client/src/stores/project.test.ts
git commit -m "feat(store): make ProjectStore own the single canonical project (phase 1)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Add project read selectors to the store

Add the read-only selectors that mirror `useSynth`'s project-derived reads, so components have a canonical store read API to migrate to.

**Files:**
- Modify: `packages/client/src/stores/project.ts`
- Test: `packages/client/src/stores/project.test.ts`

**Interfaces:**
- Consumes: the canonical `project` and `useProjectStore()` from Task 1; type `EngineType` from `../project`.
- Produces (Task 3 + Phase 2 rely on these exact names):
  - `.bpm: number` — computed read getter equal to `project.bpm`.
  - `.getTrackEngineType(index: number): EngineType` — equal to `project.tracks[index].engineType` (mirrors `useSynth.getTrackEngineType`).

- [ ] **Step 1: Write the failing test**

Append these two tests inside the `describe('useProjectStore', …)` block in `packages/client/src/stores/project.test.ts`:

```ts
  it('bpm selector reflects project.bpm and updates after a mutation', () => {
    const store = useProjectStore();
    expect(store.bpm).toBe(store.project.bpm);
    store.project.bpm = 99;
    expect(store.bpm).toBe(99);
  });

  it('getTrackEngineType returns the engineType of the slot at index', () => {
    const store = useProjectStore();
    expect(store.getTrackEngineType(0)).toBe(store.project.tracks[0].engineType);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/client && npx vitest run src/stores/project.test.ts`
Expected: FAIL — `store.bpm` is `undefined` and `store.getTrackEngineType` is not a function.

- [ ] **Step 3: Add the selectors**

In `packages/client/src/stores/project.ts`, import `EngineType` by extending the existing `../project` type import:

```ts
import { freshProject, replaceProject, type Project, type ProjectTrack, type EngineType } from '../project';
```

Add the two selectors inside the store setup (after `getTrack`), and include them in the returned object:

```ts
  const bpm = computed(() => project.bpm);

  // Mirrors useSynth.getTrackEngineType — the canonical read API components
  // migrate to. (Convenience over getTrack(index).engineType.)
  function getTrackEngineType(index: number): EngineType {
    return project.tracks[index].engineType;
  }
```

```ts
  return { project, enabledTrackCount, getTrack, getTrackEngineType, bpm, loadProject };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/client && npx vitest run src/stores/project.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/stores/project.ts packages/client/src/stores/project.test.ts
git commit -m "feat(store): add bpm + getTrackEngineType read selectors (phase 1)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Migrate StudioView's read-only overview bindings to the store

Repoint the studio's two genuinely read-only project bindings — the enabled-track count and the per-slot engine type used to render the track-overview cards — from the injected `synth` context to the store selectors, establishing the store-as-read-source pattern. Writes and write-entangled reads stay on `synth` (Phase 2).

**Files:**
- Modify: `packages/client/src/views/StudioView.vue` (script `<script setup>` block around lines 348–367)

**Interfaces:**
- Consumes: `useProjectStore()`, `.enabledTrackCount`, `.getTrackEngineType(index)` from Tasks 1–2.
- Produces: no new exported symbols. `enabledTrackCount` and `getTrackEngineType` remain in scope under the same names (so the template at lines 56, 59, 70 is unchanged), now sourced from the store.

**Note:** No unit test — mounting `.vue` is forbidden by the constraints, and these are render-only reads. Verification is typecheck + build + the full suite staying green + the browser pass below.

- [ ] **Step 1: Import the store and source the two reads from it**

In `packages/client/src/views/StudioView.vue`, add the store import next to the other imports (e.g. after the `presetsApi` import at line 344):

```ts
import { useProjectStore } from '../stores/project';
```

Add the store instance just after the `synth` injection guard (after line 349):

```ts
const projectStore = useProjectStore();
```

Remove `getTrackEngineType` and `enabledTrackCount` from the `synth` destructure (lines 350–367) so the block reads:

```ts
const {
  project,
  trackAnalysers,
  sequencer,
  bpm,
  activeTrackIndex,
  focusedTrack,
  currentStep,
  waveforms,
  shortestActiveNoteDuration,
  togglePlay,
  selectTrack,
  roomLoading,
  addTrack,
  removeTrack,
} = synth;
```

Then re-introduce both names from the store, immediately after the destructure:

```ts
// Read-only project selectors now come from the canonical ProjectStore
// (Phase 1). Writes and write-entangled reads still use `synth` (Phase 2).
const enabledTrackCount = computed(() => projectStore.enabledTrackCount);
const getTrackEngineType = (index: number) => projectStore.getTrackEngineType(index);
```

Confirm `computed` is already imported in this file's `vue` import (StudioView already uses `computed` for `enabledTrackEntries` at line 371, so it is). Leave `project`, `bpm`, `focusedTrack`, the `enabledTrackEntries`/`trackMode`/`commitBpm` logic, and all template lines unchanged — they read/write the shared canonical instance exactly as before.

- [ ] **Step 2: Typecheck**

Run: `cd packages/client && npx vue-tsc --noEmit`
Expected: no errors. (`enabledTrackCount` is a `ComputedRef<number>` and `getTrackEngineType` a `(index: number) => EngineType`, matching their previous types from `synth`.)

- [ ] **Step 3: Run the full client suite to confirm no regression**

Run: `cd packages/client && npx vitest run`
Expected: all pass (the 8 store tests included; no test mounts StudioView).

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/views/StudioView.vue
git commit -m "refactor(studio): read enabledTrackCount + engineType from the store (phase 1)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Gate (after Task 3)

Run from repo root:

```bash
npm run typecheck && npm test && npm run build
```

Expected: typecheck clean; all tests pass (client incl. 8 store tests + existing useSynth suite, server, shared); client + server build succeed.

## Browser verification (after the gate)

Phase 1 is behaviour-preserving, so this is a no-regression pass plus a check that reads track live state through the store:

1. Start the safe local stack: `npm run dev:obs` (local Docker DB — **never** `npm run dev`).
2. Open the app, create/enter a session, open the track overview.
3. Confirm: the overview renders all enabled tracks with correct engine labels; **add a track** and **remove a track** — the count and the `+ track` affordance update correctly (these reads now come from the store).
4. Enter a track editor, switch its engine, toggle steps, change BPM, press Play — audio plays and edits apply (writes are unchanged).
5. Confirm no new console errors (only the pre-existing `favicon.ico` 404), and the Pinia `project` store now shows live data (its `enabledTrackCount` changes as you add/remove tracks — proving the store is canonical, not the empty Phase-0 placeholder).
6. Close the browser tab.

## What Phase 1 deliberately does NOT do

- It does **not** change any write path. No `CommandBus`, no `applySet`, no `dispatch`, no removal of `applyingFromNetwork` or the direct-mutation watchers — that is **Phase 2**.
- It does **not** migrate write-entangled component bindings (engine-type buttons, step grid, knobs, BPM field). Those migrate with their writes in **Phase 2**.
- It does **not** remove the module-scope project singleton or add any `dispose()` — creation moves into `AppRuntime.bootstrap` in **Phase 5**.
- It does **not** remove `project` / `enabledTrackCount` / `getTrackEngineType` from `useSynth`'s returned surface (harmless duplication during transition; cleaned up as consumers migrate in Phase 2).

## Self-review

- **Spec coverage (Phase 1 row):** "Store holds canonical state + selectors; migrate components to read from selectors." Task 1 makes the store hold the single canonical instance; Task 2 adds the read selectors; Task 3 migrates the studio's read-only bindings to those selectors. The spec's "low risk" rating is honoured by P2/P3 (no write changes, transitional raw export). Covered.
- **Placeholder scan:** No TBD/TODO; every code step shows complete code; every command states expected output. Clean.
- **Type consistency:** `useProjectStore` / `.project` / `.enabledTrackCount` / `.getTrack` / `.loadProject` carry over unchanged from Phase 0; new names `.bpm`, `.getTrackEngineType`, the raw `project` export, and `__resetProjectStoreForTest` are spelled identically in the store, the tests, Task 3, and the Interfaces blocks. `getTrackEngineType` returns `EngineType` in both the store and StudioView. `replaceProject(target, source)` uses the in-place signature from `storage.ts`. Consistent.
