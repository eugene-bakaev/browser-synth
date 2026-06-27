# Lifecycle Architecture — Phase 2a (Command infrastructure, additive) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce the two primitives the unidirectional command model needs — a low-level `ProjectStore.applySet(path, value)` state-writer and a `CommandBus` (`dispatchLocal` + `applyRemote`) — fully unit-tested but **dormant**: nothing live calls them yet. Zero behaviour change.

**Architecture:** Phase 2 (the spec's "heart") replaces the two-writer duality (direct component mutation observed by outbound watchers + `applyOp` for remote ops, reconciled by the `applyingFromNetwork` suppression flag) with one funnel: every write goes through `CommandBus` → `store.applySet`. That switchover is large and high-risk, so it is split. **Phase 2a (this plan)** adds the new units additively — exactly the pattern Phase 0 used for Pinia (present, wired into nothing). **Phase 2b (next plan)** performs the live switchover: migrate every component/composable write to `dispatchLocal`, route the inbound path through `applyRemote`, and delete the outbound watchers + `applyingFromNetwork` + `applyOp`. Keeping 2a dormant means it cannot change behaviour and its blast radius is zero.

**Tech Stack:** Vue 3.5, Pinia, Vitest 4, TypeScript; `@fiddle/shared` (`setDeep`, `pathKey`, types `Path` / `SetOpBroadcast`).

## Design decisions (Phase 2a)

- **Q1 — `applySet` is a pure store primitive.** `ProjectStore.applySet(path, value)` does `setDeep(project, path, value)` into the canonical module-scope instance and nothing else — no suppression, no sync knowledge, no opId logic (spec DC: "the store holds state only"). Error handling stays with callers (the inbound path keeps its own try/catch in 2b), so `applySet` is a thin, total writer.
- **Q2 — `CommandBus` is a plain injected factory, not a store/composable.** `createCommandBus({ applySet, enqueue })` lives in `src/sync/` (it orchestrates the store + outbox; that is the sync layer's job). Dependencies are injected so it unit-tests against a fake `applySet` and a fake `enqueue` with no Pinia, no socket, no Vue. Its `dispatchLocal` writes state **and** enqueues; its `applyRemote` writes state, does **not** enqueue, and honours an opId watermark.
- **Q3 — The bus owns its OWN watermark, self-contained.** `applyRemote`'s opId watermark is a private `Map` inside the bus instance (the spec's destination: "the opId watermark moves from `applyOp` into `CommandBus.applyRemote`"). In 2a this Map is **dormant** — the live inbound path still uses `applyOp` and its separate module-scope watermark, untouched. There is no shared state between the two, so 2a cannot perturb the live path. 2b deletes `applyOp` + its Map and switches the inbound path onto the bus's Map.
- **Q4 — Nothing live is rewired in 2a.** `messageDispatch`, the outbound watchers, `applyingFromNetwork`/`enterSuppress`/`exitSuppress`, `applyOp`, the Outbox rollback, and every component write are **untouched**. The only consumers of the new code are the new unit tests. This is the Phase-0 "wired but untouched" contract applied to the command layer.

## Global Constraints

- Work on branch `feat/lifecycle-architecture` (currently == `main` `55861ce`). **Never commit on `main`.**
- **The store holds NO live resources** — no WebSocket, no AudioContext, no timers. `applySet` is pure state.
- **ZERO behaviour change.** Nothing that currently runs may change. Do NOT modify `messageDispatch.ts`, `applyOp.ts`, `Outbox.ts`, `useSynth.ts`, or any component. Do NOT delete or alter `applyingFromNetwork`/`enterSuppress`/`exitSuppress` or the outbound watchers — that is Phase 2b.
- **`CommandBus` is dormant** — after 2a, a repo-wide search shows `createCommandBus` referenced only by `CommandBus.ts` and `CommandBus.test.ts`; `applySet` referenced only by the store, its test, and `CommandBus.test.ts`'s fake. No app/component/sync-runtime code consumes either.
- Import `setDeep`, `pathKey`, and types `Path` / `SetOpBroadcast` from `@fiddle/shared`. Import store types from `../project`. Import store primitives from `pinia` / `vue`.
- Store tests isolate with `setActivePinia(createPinia())` **and** `__resetProjectStoreForTest()` in `beforeEach` (the Phase-1 module-scope-singleton pattern).
- **Do NOT mount `.vue` files in unit tests.**
- A fresh `Project` has `TRACK_POOL_SIZE` (32) track slots, exactly **4** `enabled`; `bpm` defaults to `120`.
- Stage only the files each task names — never `git add -A` / `git add .`. Never stage `studio-initial.png` or `synth2-wave-previews.png`.
- End every commit message with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Gate after the last task (from repo root): `npm run typecheck && npm test && npm run build`.

---

### Task 1: `ProjectStore.applySet(path, value)` — the single state-write primitive (TDD)

Add the low-level path writer the command bus will route every write through. Pure `setDeep` into the canonical instance; no sync, no suppression.

**Files:**
- Modify: `packages/client/src/stores/project.ts`
- Test: `packages/client/src/stores/project.test.ts`

**Interfaces:**
- Consumes: the canonical `project` (Phase 1); `setDeep` and type `Path` from `@fiddle/shared`.
- Produces (Phase 2b + the CommandBus rely on this exact name):
  - `.applySet(path: Path, value: unknown): void` — writes `value` at `path` into the canonical project via `setDeep`. Returned from the store setup.

- [ ] **Step 1: Write the failing test**

Append these tests inside the `describe('useProjectStore', …)` block in `packages/client/src/stores/project.test.ts` (note: `Path` is `(string | number)[]`):

```ts
  it('applySet writes a top-level leaf (bpm)', () => {
    const store = useProjectStore();
    store.applySet(['bpm'], 140);
    expect(store.project.bpm).toBe(140);
  });

  it('applySet writes a deep engine-param path in place', () => {
    const store = useProjectStore();
    const before = store.project;
    store.applySet(['tracks', 0, 'engines', 'synth', 'cutoff'], 1234);
    expect(store.project.tracks[0].engines.synth.cutoff).toBe(1234);
    expect(store.project).toBe(before); // mutates in place, identity stable
  });

  it('applySet writes an engineType change', () => {
    const store = useProjectStore();
    store.applySet(['tracks', 2, 'engineType'], 'kick2');
    expect(store.project.tracks[2].engineType).toBe('kick2');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/client && npx vitest run src/stores/project.test.ts`
Expected: FAIL — `store.applySet is not a function`.

- [ ] **Step 3: Implement `applySet`**

In `packages/client/src/stores/project.ts`, extend the `@fiddle/shared` import (the file already imports from `../project`; add a new import line for the shared helpers — check whether one already exists and merge rather than duplicate):

```ts
import { setDeep, type Path } from '@fiddle/shared';
```

Add the action inside the store setup (after `getTrackEngineType`), and include it in the returned object:

```ts
  // The single low-level state-write primitive. Phase 2's CommandBus routes
  // every write — local dispatch and applied remote op — through here, so this
  // is the one place project state is mutated by a path/value. Pure state: no
  // suppression, no opId logic, no sync (the store never knows about the socket).
  function applySet(path: Path, value: unknown): void {
    setDeep(project as unknown as Record<string, unknown>, path, value);
  }
```

```ts
  return { project, enabledTrackCount, getTrack, getTrackEngineType, bpm, applySet, loadProject };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/client && npx vitest run src/stores/project.test.ts`
Expected: PASS (all store tests, incl. the 3 new ones).

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/stores/project.ts packages/client/src/stores/project.test.ts
git commit -m "feat(store): add applySet path/value state-write primitive (phase 2a)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `CommandBus` — dispatchLocal + applyRemote (dormant, TDD)

Add the write funnel as an injected factory, fully unit-tested against fakes, consumed by nothing live.

**Files:**
- Create: `packages/client/src/sync/CommandBus.ts`
- Test: `packages/client/src/sync/CommandBus.test.ts`

**Interfaces:**
- Consumes: `pathKey` and types `Path` / `SetOpBroadcast` from `@fiddle/shared`; injected `applySet` (from `ProjectStore` in 2b) and `enqueue` (from `Outbox` in 2b — signature `(path, value, priorValue, gestureEnd) => void`, matching `Outbox.enqueue`).
- Produces (Phase 2b relies on these exact names):
  - `createCommandBus(deps: CommandBusDeps)` returning `{ dispatchLocal, applyRemote, resetWatermark }`.
  - `dispatchLocal(cmd: LocalCommand): void` — `applySet(path, value)` then `enqueue(path, value, priorValue, gestureEnd ?? false)`.
  - `applyRemote(op: SetOpBroadcast): boolean` — opId-watermark check (private per-bus `Map`), then `applySet(op.path, op.value)`; returns whether it wrote. Never enqueues.
  - `resetWatermark(): void` — clears the watermark (snapshot / reconnect / tests).
  - Types `CommandBusDeps` and `LocalCommand`.

- [ ] **Step 1: Write the failing test**

Create `packages/client/src/sync/CommandBus.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import type { Path, SetOpBroadcast } from '@fiddle/shared';
import { createCommandBus } from './CommandBus';

// Fakes: record what the bus would do to the store and the outbox.
function makeFakes() {
  const writes: Array<{ path: Path; value: unknown }> = [];
  const enqueues: Array<{ path: Path; value: unknown; priorValue: unknown; gestureEnd: boolean }> = [];
  return {
    writes,
    enqueues,
    deps: {
      applySet: (path: Path, value: unknown) => { writes.push({ path, value }); },
      enqueue: (path: Path, value: unknown, priorValue: unknown, gestureEnd: boolean) =>
        { enqueues.push({ path, value, priorValue, gestureEnd }); },
    },
  };
}

function broadcast(path: Path, value: unknown, opId: number): SetOpBroadcast {
  // Minimal shape the bus reads: path/value/opId. Cast covers the wire-only
  // fields (clientId/clientSeq/etc.) the bus never touches.
  return { type: 'set', path, value, opId } as unknown as SetOpBroadcast;
}

describe('CommandBus', () => {
  let f: ReturnType<typeof makeFakes>;
  beforeEach(() => { f = makeFakes(); });

  it('dispatchLocal writes state AND enqueues (gestureEnd defaults false)', () => {
    const bus = createCommandBus(f.deps);
    bus.dispatchLocal({ path: ['bpm'], value: 128, priorValue: 120 });
    expect(f.writes).toEqual([{ path: ['bpm'], value: 128 }]);
    expect(f.enqueues).toEqual([{ path: ['bpm'], value: 128, priorValue: 120, gestureEnd: false }]);
  });

  it('dispatchLocal forwards gestureEnd when set', () => {
    const bus = createCommandBus(f.deps);
    bus.dispatchLocal({ path: ['tracks', 0, 'engineType'], value: 'kick2', priorValue: 'synth', gestureEnd: true });
    expect(f.enqueues[0].gestureEnd).toBe(true);
  });

  it('applyRemote writes state and does NOT enqueue', () => {
    const bus = createCommandBus(f.deps);
    const wrote = bus.applyRemote(broadcast(['bpm'], 90, 1));
    expect(wrote).toBe(true);
    expect(f.writes).toEqual([{ path: ['bpm'], value: 90 }]);
    expect(f.enqueues).toEqual([]); // remote never echoes back out
  });

  it('applyRemote drops a stale opId for the same path (watermark) and does not write', () => {
    const bus = createCommandBus(f.deps);
    expect(bus.applyRemote(broadcast(['bpm'], 90, 5))).toBe(true);
    expect(bus.applyRemote(broadcast(['bpm'], 80, 3))).toBe(false); // older opId
    expect(bus.applyRemote(broadcast(['bpm'], 80, 5))).toBe(false); // equal opId
    expect(f.writes).toEqual([{ path: ['bpm'], value: 90 }]); // only the first wrote
  });

  it('applyRemote tracks the watermark per path independently', () => {
    const bus = createCommandBus(f.deps);
    expect(bus.applyRemote(broadcast(['tracks', 0, 'engineType'], 'kick', 9))).toBe(true);
    // a fresh path starts below any opId, so a low opId still applies
    expect(bus.applyRemote(broadcast(['tracks', 1, 'engineType'], 'hat', 2))).toBe(true);
    expect(f.writes).toHaveLength(2);
  });

  it('resetWatermark lets a previously-stale opId apply again (reconnect/snapshot)', () => {
    const bus = createCommandBus(f.deps);
    bus.applyRemote(broadcast(['bpm'], 90, 5));
    bus.resetWatermark();
    expect(bus.applyRemote(broadcast(['bpm'], 80, 1))).toBe(true);
    expect(f.writes).toEqual([{ path: ['bpm'], value: 90 }, { path: ['bpm'], value: 80 }]);
  });

  it('applyRemote returns false and does not throw when applySet throws (bad path)', () => {
    const writes: Path[] = [];
    const bus = createCommandBus({
      applySet: () => { throw new Error('unresolvable path'); },
      enqueue: (path: Path) => { writes.push(path); },
    });
    expect(bus.applyRemote(broadcast(['tracks', 999, 'nope'], 1, 1))).toBe(false);
    expect(writes).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/client && npx vitest run src/sync/CommandBus.test.ts`
Expected: FAIL — `Cannot find module './CommandBus'`.

- [ ] **Step 3: Implement the CommandBus**

Create `packages/client/src/sync/CommandBus.ts`:

```ts
// CommandBus — the single write funnel for the unidirectional command model.
//
// Every state change flows through here. A LOCAL command writes state AND
// enqueues an outbound op; an applied REMOTE op writes state only (no echo).
// Because the origin is explicit (which method was called), there is no need
// for the legacy `applyingFromNetwork` suppression flag — that disappears in
// Phase 2b when the outbound watchers it guarded are deleted.
//
// Phase 2a: this unit is DORMANT — only the unit tests construct it. Phase 2b
// wires `applySet` to ProjectStore.applySet and `enqueue` to the Outbox, routes
// the inbound message path through `applyRemote`, and deletes `applyOp`.

import { pathKey, type Path, type SetOpBroadcast } from '@fiddle/shared';

export interface CommandBusDeps {
  /** Write `value` at `path` into canonical project state (ProjectStore.applySet). */
  applySet: (path: Path, value: unknown) => void;
  /** Hand an outbound op to the Outbox (throttle/coalesce/nack). Matches Outbox.enqueue. */
  enqueue: (path: Path, value: unknown, priorValue: unknown, gestureEnd: boolean) => void;
}

export interface LocalCommand {
  path: Path;
  value: unknown;
  /** Pre-edit value, carried to the Outbox for nack rollback. */
  priorValue?: unknown;
  /** Discrete action (select/toggle/mouseup) — flush immediately past the throttle. */
  gestureEnd?: boolean;
}

export function createCommandBus(deps: CommandBusDeps) {
  // Per-path opId watermark: a late echo of an older op for a path we've
  // advanced past is dropped rather than allowed to clobber the newer value.
  // Private to this bus instance (the future home of the watermark that
  // currently lives in applyOp.ts).
  const lastAppliedOpIdForPath = new Map<string, number>();

  function dispatchLocal(cmd: LocalCommand): void {
    deps.applySet(cmd.path, cmd.value);
    deps.enqueue(cmd.path, cmd.value, cmd.priorValue, cmd.gestureEnd ?? false);
  }

  function applyRemote(op: SetOpBroadcast): boolean {
    const key = pathKey(op.path);
    const prev = lastAppliedOpIdForPath.get(key) ?? -1;
    if (op.opId <= prev) return false; // stale / duplicate — ignore
    lastAppliedOpIdForPath.set(key, op.opId);
    try {
      deps.applySet(op.path, op.value);
    } catch (err) {
      // A malformed/out-of-range path should never reach us (the server
      // bounds-checks before broadcasting); if one does, drop it rather than
      // let the throw break the whole inbound frame. Watermark stays advanced
      // (matches applyOp), so the bad op won't be retried by a replay.
      console.warn('applyRemote: dropped op with unresolvable path', op.path, err);
      return false;
    }
    return true;
  }

  function resetWatermark(): void {
    lastAppliedOpIdForPath.clear();
  }

  return { dispatchLocal, applyRemote, resetWatermark };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/client && npx vitest run src/sync/CommandBus.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Confirm the bus is dormant**

Run: `cd packages/client && grep -rn "createCommandBus" src/ | grep -v -e "CommandBus.ts" -e "CommandBus.test.ts"`
Expected: no output (nothing live consumes it — the 2a contract).

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/sync/CommandBus.ts packages/client/src/sync/CommandBus.test.ts
git commit -m "feat(sync): add dormant CommandBus (dispatchLocal + applyRemote) (phase 2a)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Gate (after Task 2)

Run from repo root:

```bash
npm run typecheck && npm test && npm run build
```

Expected: typecheck clean; all tests pass (client incl. the new `applySet` store tests + the 8 CommandBus tests + the untouched `useSynth`/sync suites; server; shared); client + server build succeed.

## Browser verification (after the gate)

Phase 2a is dormant, so this is a no-regression smoke test plus a probe that the new code exists and is unconsumed — exactly like Phase 0:

1. Start the safe local stack: `npm run dev:obs` (local Docker DB — **never** `npm run dev`).
2. Open the app, create/enter a session. Toggle a step, turn a knob, change BPM, switch a track's engine, add/remove a track, press Play. Confirm everything works exactly as before and edits still sync (open a second tab on the same room and confirm an edit propagates — the existing `applyOp`/watcher path is untouched).
3. Confirm no new console errors (only the pre-existing `favicon.ico` 404).
4. Probe dormancy: in devtools console, confirm the new units are present but unconsumed — `applySet` lives on the store and the CommandBus module exists, yet the live sync path still runs through `applyOp` (no behaviour change). The store's `applySet` is callable; nothing in the running app references the CommandBus.
5. Close the browser tab.

## What Phase 2a deliberately does NOT do

- It does **not** change any live behaviour. `messageDispatch`, `applyOp`, the outbound watchers, `applyingFromNetwork`/`enterSuppress`/`exitSuppress`, the Outbox rollback, and every component write are untouched.
- It does **not** wire `CommandBus` into anything — no component dispatches, the inbound path still uses `applyOp`.
- It does **not** delete the suppression flag, the outbound watchers, or `applyOp` — that is **Phase 2b**.
- It does **not** add `advanceWatermark`, a self-echo-skip helper, or any other 2b-only API (YAGNI — added in 2b when the self-echo skip migrates off `advanceOpIdForPath`).
- It does **not** touch `SyncSession`/`AudioEngine`/`AppRuntime` extraction (Phases 3–5).

## Self-review

- **Spec coverage (Phase 2 row, first slice):** the spec's Phase 2 introduces `CommandBus`/`dispatch` with `dispatchLocal` (state + outbox) and `applyRemote` (state + watermark, no outbox), backed by `store.applySet`. Task 1 adds `applySet`; Task 2 adds the bus with both methods and the relocated watermark. The destructive half (migrate writes, delete watchers + `applyingFromNetwork` + `applyOp`) is explicitly carved out to Phase 2b. Covered for 2a; 2b covers the rest.
- **Placeholder scan:** No TBD/TODO; every code step shows complete code; every command states expected output. Clean.
- **Type consistency:** `applySet(path: Path, value: unknown): void` is spelled identically in the store, its test, the CommandBus `CommandBusDeps`, and the bus test fake. `enqueue(path, value, priorValue, gestureEnd)` matches `Outbox.enqueue` exactly. `dispatchLocal`/`applyRemote`/`resetWatermark`/`createCommandBus`/`CommandBusDeps`/`LocalCommand` are spelled identically in `CommandBus.ts`, the test, and the Interfaces blocks. `SetOpBroadcast` and `Path` and `pathKey` come from `@fiddle/shared`, matching `applyOp.ts`'s usage. Consistent.
