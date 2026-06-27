# Lifecycle Architecture — Phase 0 (Pinia foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce Pinia and an empty `ProjectStore` that mirrors the current `Project` shape, wired into the app, with zero behaviour change — the safe foundation the later phases build on.

**Architecture:** A composition-API (setup) Pinia store `useProjectStore` holds a reactive `Project` (from `freshProject()`) plus read-only derived getters and an in-place `loadProject` action. `createPinia()` is registered on the app in `main.ts`. Nothing consumes the store yet, so behaviour is unchanged; this phase only establishes the dependency, the store skeleton, and the `setActivePinia(createPinia())` test pattern that replaces the `resetModules`/`disposeSynth` dance in later phases.

**Tech Stack:** Vue 3.5, Pinia (new), Vitest 4, TypeScript.

## Global Constraints

- Work on branch `feat/lifecycle-architecture`. Never commit on `main`.
- **State stores hold NO live resources** — no `WebSocket`, no `AudioContext`, no timers. `ProjectStore` is pure state + derived reads.
- **Phase 0 introduces NO behaviour change**: nothing consumes `useProjectStore` yet. `useSynth.ts` and all components are untouched.
- Import `freshProject`, `replaceProject`, and the `Project`/`ProjectTrack` types from `../project` (the established shim), not from deep paths or `@fiddle/shared` directly.
- Store tests use `setActivePinia(createPinia())` in `beforeEach` for isolation. Do **not** use the `vi.resetModules()`/`disposeSynth()` pattern for store tests.
- Do **not** mount `.vue` files in unit tests.
- A fresh `Project` has `TRACK_POOL_SIZE` (32) track slots, of which exactly **4** are `enabled`.
- Stage only the files each task names — never `git add -A`/`git add .`. Never stage `studio-initial.png` or `synth2-wave-previews.png`.
- End every commit message with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Gate after the last task: `npm run typecheck && npm test && npm run build` (run from repo root).

---

### Task 1: ProjectStore skeleton + read getters (TDD)

**Files:**
- Modify: `packages/client/package.json` (add `pinia` to `dependencies`)
- Create: `packages/client/src/stores/project.ts`
- Test: `packages/client/src/stores/project.test.ts`

**Interfaces:**
- Consumes: `freshProject()`, `replaceProject(target, source)`, types `Project`, `ProjectTrack` from `../project`; `TRACK_POOL_SIZE` from `@fiddle/shared`.
- Produces (later phases rely on these exact names):
  - `useProjectStore()` — a Pinia setup store id `'project'`
  - `.project: Project` (reactive, stable object identity)
  - `.enabledTrackCount: number` (computed getter)
  - `.getTrack(index: number): ProjectTrack`
  - `.loadProject(next: Project): void` — replaces contents **in place** (preserves `.project` object identity)

- [ ] **Step 1: Add the Pinia dependency**

```bash
npm install pinia -w @fiddle/client
```

Expected: `pinia` appears under `"dependencies"` in `packages/client/package.json`, and `package-lock.json` updates.

- [ ] **Step 2: Write the failing test**

Create `packages/client/src/stores/project.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { TRACK_POOL_SIZE } from '@fiddle/shared';
import { freshProject } from '../project';
import { useProjectStore } from './project';

describe('useProjectStore', () => {
  beforeEach(() => {
    // One fresh Pinia per test — the isolation pattern that replaces the
    // resetModules()/disposeSynth() dance used by the legacy useSynth tests.
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
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd packages/client && npx vitest run src/stores/project.test.ts`
Expected: FAIL — `Cannot find module './project'` (the store file does not exist yet).

- [ ] **Step 4: Implement the store**

Create `packages/client/src/stores/project.ts`:

```ts
import { defineStore } from 'pinia';
import { reactive, computed } from 'vue';
import { freshProject, replaceProject, type Project, type ProjectTrack } from '../project';

// Canonical project state. Holds ONLY data — no socket, no AudioContext, no
// timers (those are resources owned by the composition root, not state).
// Phase 0: nothing consumes this yet; it exists so later phases can migrate
// reads here, then route all writes through a single command applier.
export const useProjectStore = defineStore('project', () => {
  // reactive() (not ref()) so nested mutation keeps working exactly as the
  // legacy module-scope `project` did; `.project` keeps a stable identity so
  // loadProject can replace contents in place without breaking references.
  const project = reactive<Project>(freshProject());

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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/client && npx vitest run src/stores/project.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/client/package.json package-lock.json packages/client/src/stores/project.ts packages/client/src/stores/project.test.ts
git commit -m "feat(store): add Pinia ProjectStore skeleton (phase 0)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Register Pinia on the app

**Files:**
- Modify: `packages/client/src/main.ts`

**Interfaces:**
- Consumes: `createPinia` from `pinia`.
- Produces: an app with an active Pinia instance, so `useProjectStore()` works at runtime (not just in tests). No new exported symbols.

**Note:** This is wiring, not behaviour — there is no unit test for `main.ts` (mounting the app is an integration concern and we do not mount `.vue` in unit tests). Verification is the type/build gate plus the existing suite staying green, proving nothing regressed.

- [ ] **Step 1: Add `createPinia` to the app bootstrap**

Replace the contents of `packages/client/src/main.ts`:

```ts
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'

// Pinia must be installed before the router so any store used during a route's
// setup has an active instance. Phase 0: no store is consumed yet, but the
// instance must exist for the later phases that migrate reads into the store.
createApp(App).use(createPinia()).use(router).mount('#app')
```

- [ ] **Step 2: Typecheck**

Run: `cd packages/client && npx vue-tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Run the full client suite to confirm no regression**

Run: `cd packages/client && npx vitest run`
Expected: all tests pass, including the 4 new store tests. (Existing `useSynth` tests are untouched and still green — Phase 0 changes no behaviour.)

- [ ] **Step 4: Build**

Run: `npm run build` (from repo root)
Expected: client build succeeds (`vue-tsc` + `vite build`) and server build succeeds.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/main.ts
git commit -m "feat(store): register Pinia on the app (phase 0)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Browser verification (after Task 2)

Phase 0 is invisible to the user, so the check is a no-regression smoke test, not a feature demo:

1. Start the safe local stack (`npm run dev:obs`, local Docker DB — never `npm run dev`).
2. Open the app, enter a session, press Play, turn a knob, toggle a step.
3. Confirm: audio plays, edits apply, no new console errors, and the Pinia devtools tab shows a `project` store present (proves `createPinia` is wired) but untouched (proves nothing consumes it yet).
4. Close the browser tab when done.

## What Phase 0 deliberately does NOT do

- It does **not** make the store canonical — `useSynth.ts` still owns the live `project` that the app reads and mutates. (Phase 1 migrates reads to the store; Phase 2 routes writes through the command bus.)
- It does **not** touch any component, `useSynth.ts`, the sync layer, or the audio engine.
- It does **not** add `applySet` / the command bus (Phase 2) or any `dispose()` (Phases 3–5).

The next plan (Phase 1) makes the store the canonical read-source and migrates components from `synth.project` to store selectors.

## Self-review

- **Spec coverage (Phase 0 row only):** "Add Pinia; empty `ProjectStore` mirroring current shape, no behaviour change." Task 1 adds Pinia + the store mirroring the shape; Task 2 wires it; no consumer ⇒ no behaviour change. Covered.
- **Placeholder scan:** No TBD/TODO; every code step shows complete code; commands have expected output. Clean.
- **Type consistency:** `useProjectStore` / `.project` / `.enabledTrackCount` / `.getTrack` / `.loadProject` are named identically in the store, the test, and the Interfaces blocks. `loadProject` uses the imported `replaceProject(target, source)` in-place signature from `storage.ts`. Consistent.
