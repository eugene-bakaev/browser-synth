# Lifecycle Architecture — Phase 2b-i (Inbound through the CommandBus) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route the live INBOUND message path (`messageDispatch`) through the `CommandBus` (`applyRemote` + a new `advanceWatermark`) instead of `applyOp`, then delete `applyOp`/`advanceOpIdForPath`/`resetApplyOpState` and their module-scope watermark `Map`. The outbound watchers and the `applyingFromNetwork` suppression flag stay (deleted later in 2b-iii) — so the inbound write is transitionally wrapped in `enterSuppress()/exitSuppress()` at the dispatch call site. One observable-behaviour-preserving switch.

**Architecture:** Phase 2 (the spec's "heart") replaces the two-writer duality with one `CommandBus → store.applySet` funnel. The user chose to land it in **incremental sub-phases**. Phase 2a (merged, `f65cdd0`) added the dormant `CommandBus`. **This plan (2b-i)** flips only the inbound half live: the bus's per-path opId watermark becomes the real one, and `applyOp` (the legacy inbound writer) is deleted. The outbound half is untouched — local edits still flow through the `installSyncWatchers` watchers + `Outbox`, still gated by `isApplyingFromNetwork()`. Because the watchers still observe the project, an applied remote op would otherwise echo straight back out; the suppression flag still prevents that, wrapped around the bus's `applyRemote` at the `messageDispatch` call site. **Phase 2b-ii** then migrates outbound writes to `dispatchLocal` (removing each watcher as it goes); **2b-iii** deletes the suppression flag + the file once no watchers remain.

**Tech Stack:** Vue 3.5, Pinia, Vitest 4, TypeScript; `@fiddle/shared` (`setDeep`, `pathKey`, types `Path` / `SetOpBroadcast`).

## Design decisions (Phase 2b-i)

- **Q1 — The bus's `applySet` dep is an inline `setDeep` on the canonical `project`, mirroring `Outbox.applyLocal`.** In `buildSyncState` the bus is created with `applySet: (path, value) => setDeep(project, path, value)` — the exact writer `Outbox.applyLocal` already uses on the same module-scope `project` (`useSynth.ts:316`). This keeps 2b-i out of any Pinia-active-context question in the sync layer and its unit tests (`buildSyncState` runs at runtime via `connectToSession`, not in a Vue `setup`). It is behaviourally identical to `store.applySet`. Folding every writer onto `store.applySet` is a 2b-ii/iii concern (once local writes move to `dispatchLocal` and the store is the sole writer). The store's `applySet` stays a pure primitive (spec DC) and is unchanged here.
- **Q2 — The transitional suppression wrap lives at the `messageDispatch` call site, not inside the bus or the `applySet` dep.** The bus's `applyRemote` stays sync-agnostic (it just writes + advances the watermark). `messageDispatch` wraps the `applyRemote` call in `enterSuppress()/exitSuppress()` (`try/finally`) exactly as it already wraps the snapshot `replaceProject`. This is the minimal, reversible transitional coupling: 2b-iii removes only this wrap (and the flag) once the outbound watchers are gone. Crucially, `applySet` must NOT self-suppress — 2b-ii routes local `dispatchLocal` writes through the same `applySet`, and those must remain observable to any not-yet-migrated watcher (the `dispatchLocal` path enqueues directly, so a suppressed local write would simply rely on its own enqueue — but keeping `applySet` pure avoids coupling the store writer to sync state at all).
- **Q3 — `advanceWatermark(path, opId)` is added to the bus now (the 2a-deferred self-echo-skip API).** The self-echo skip in `messageDispatch` (`outbox.hasPendingForPath` → advance watermark without writing) needs to advance the SAME per-path watermark `applyRemote` checks. 2a deliberately omitted this (YAGNI). 2b-i adds it: it shares the bus's private `lastAppliedOpIdForPath` Map with `applyRemote`, so a skipped echo still rejects older replayed ops. Also export `type CommandBus = ReturnType<typeof createCommandBus>` so deps can be typed.
- **Q4 — `applyOp.ts` keeps its filename; only the dead inbound code is deleted.** After 2b-i the file holds only the suppression flag (`applyingFromNetwork` + `isApplyingFromNetwork`/`enterSuppress`/`exitSuppress`). Renaming it to `suppress.ts` would churn every importer for a cosmetic gain on a file 2b-iii deletes outright. Keep the name; update the header comment to say it now holds only the transitional suppression flag (slated for deletion in 2b-iii).

## Global Constraints

- Work on branch `feat/lifecycle-architecture` (currently == `main` `f65cdd0`). **Never commit on `main`.**
- **This changes the LIVE inbound sync path.** Behaviour must be observably identical: remote ops apply, stale/duplicate opIds are dropped, self-echoes don't snap a dragging knob back, opId gaps still request a resync, snapshots still reset the watermark.
- **Do NOT touch the OUTBOUND path:** `installSyncWatchers` and its 8 watchers, the `Outbox`, `Outbox.applyLocal`, `knobSync.ts`, the `bpm` writable computed, `addTrack`/`removeTrack`, and every component stay exactly as-is. `dispatchLocal` is wired into the bus's deps but is NOT called by anything live yet (2b-ii).
- **Keep the suppression flag.** `applyingFromNetwork`/`isApplyingFromNetwork`/`enterSuppress`/`exitSuppress` stay and keep guarding the outbound watchers. Deleting them is Phase 2b-iii.
- The store's `applySet` stays a pure primitive — do NOT add suppression/opId/sync to it.
- Import `setDeep`, `pathKey`, and types `Path` / `SetOpBroadcast` from `@fiddle/shared`.
- **Do NOT mount `.vue` files in unit tests.**
- A fresh `Project` has `TRACK_POOL_SIZE` (32) track slots, exactly **4** `enabled`; `bpm` defaults to `120`.
- Stage only the files each task names — never `git add -A` / `git add .`. Never stage `studio-initial.png` or `synth2-wave-previews.png`.
- End every commit message with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Gate after the last task (from repo root): `npm run typecheck && npm test && npm run build`.
- Browser-verify the live two-tab sync round-trip before the branch is considered done (controller-owned, after the gate).

---

### Task 1: `CommandBus.advanceWatermark` + exported `CommandBus` type (TDD)

Add the self-echo-skip helper the inbound path needs, plus a type alias for the bus instance. Both are additive to the Phase-2a bus; nothing live consumes them yet.

**Files:**
- Modify: `packages/client/src/sync/CommandBus.ts`
- Test: `packages/client/src/sync/CommandBus.test.ts`

**Interfaces:**
- Consumes: the existing `createCommandBus({ applySet, enqueue })` and its private `lastAppliedOpIdForPath` Map.
- Produces (Task 2 + Phase 2b-ii rely on these exact names):
  - `advanceWatermark(path: Path, opId: number): boolean` — advances the per-path watermark WITHOUT writing; returns `false` if `opId` is stale (`<=` the current watermark). Returned from the bus alongside `dispatchLocal`/`applyRemote`/`resetWatermark`.
  - `export type CommandBus = ReturnType<typeof createCommandBus>`.

- [ ] **Step 1: Write the failing tests**

Append these tests inside the `describe('CommandBus', …)` block in `packages/client/src/sync/CommandBus.test.ts` (the existing `f`/`makeFakes`/`broadcast` helpers are in scope):

```ts
  it('advanceWatermark advances without writing and rejects stale opIds', () => {
    const bus = createCommandBus(f.deps);
    expect(bus.advanceWatermark(['bpm'], 5)).toBe(true);
    expect(bus.advanceWatermark(['bpm'], 3)).toBe(false); // older
    expect(bus.advanceWatermark(['bpm'], 5)).toBe(false); // equal
    expect(f.writes).toEqual([]); // never writes
    expect(f.enqueues).toEqual([]); // never enqueues
  });

  it('advanceWatermark shares the watermark with applyRemote (skipped echo blocks an older replay)', () => {
    const bus = createCommandBus(f.deps);
    // Self-echo skipped at opId 5 (advance only)...
    expect(bus.advanceWatermark(['bpm'], 5)).toBe(true);
    // ...so an older replayed op for the same path is now stale and does not write.
    expect(bus.applyRemote(broadcast(['bpm'], 99, 3))).toBe(false);
    expect(f.writes).toEqual([]);
    // ...and a newer op still applies.
    expect(bus.applyRemote(broadcast(['bpm'], 128, 6))).toBe(true);
    expect(f.writes).toEqual([{ path: ['bpm'], value: 128 }]);
  });

  it('resetWatermark also clears advanceWatermark state', () => {
    const bus = createCommandBus(f.deps);
    bus.advanceWatermark(['bpm'], 9);
    bus.resetWatermark();
    expect(bus.advanceWatermark(['bpm'], 1)).toBe(true); // fresh again
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/client && npx vitest run src/sync/CommandBus.test.ts`
Expected: FAIL — `bus.advanceWatermark is not a function`.

- [ ] **Step 3: Implement `advanceWatermark` + the type alias**

In `packages/client/src/sync/CommandBus.ts`, add the function inside `createCommandBus` (next to `applyRemote`, sharing `lastAppliedOpIdForPath`):

```ts
  // Advance the per-path watermark WITHOUT writing. Used by the self-echo skip:
  // when a newer local edit is still pending for a path, the echoed (older)
  // value must not be written (it would snap a dragging knob backward), but the
  // watermark must still advance so older replayed ops stay rejected. Shares the
  // same Map as applyRemote, so the two agree on what is stale.
  function advanceWatermark(path: Path, opId: number): boolean {
    const key = pathKey(path);
    const prev = lastAppliedOpIdForPath.get(key) ?? -1;
    if (opId <= prev) return false;
    lastAppliedOpIdForPath.set(key, opId);
    return true;
  }
```

Add it to the returned object:

```ts
  return { dispatchLocal, applyRemote, advanceWatermark, resetWatermark };
```

At the bottom of the file (after the function), add the type alias:

```ts
export type CommandBus = ReturnType<typeof createCommandBus>;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/client && npx vitest run src/sync/CommandBus.test.ts`
Expected: PASS (all CommandBus tests, incl. the 3 new ones).

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/sync/CommandBus.ts packages/client/src/sync/CommandBus.test.ts
git commit -m "feat(sync): add CommandBus.advanceWatermark + CommandBus type (phase 2b-i)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Route the inbound message path through the bus (LIVE switch)

Switch `messageDispatch` from `applyOp`/`advanceOpIdForPath`/`resetApplyOpState` to the bus's `applyRemote`/`advanceWatermark`/`resetWatermark`, and instantiate the bus in `buildSyncState`, threading it into the dispatch deps. This is the live inbound cutover. The bus and the dispatch wiring change together (the only caller must supply the new dep), so they are one task to keep typecheck green at the commit.

**Files:**
- Modify: `packages/client/src/sync/messageDispatch.ts`
- Modify: `packages/client/src/composables/useSynth.ts`
- Test: `packages/client/src/sync/messageDispatch.test.ts`

**Interfaces:**
- Consumes: `createCommandBus` / `type CommandBus` / `advanceWatermark` / `applyRemote` / `resetWatermark` (Task 1); `enterSuppress`/`exitSuppress` (unchanged, `applyOp.ts`); `setDeep` and the canonical `project`; `Outbox.enqueue`.
- Produces (Task 3 relies on this): `messageDispatch.ts` no longer imports `applyOp`/`advanceOpIdForPath`/`resetApplyOpState`.

- [ ] **Step 1: Update the messageDispatch test harness (RED)**

In `packages/client/src/sync/messageDispatch.test.ts`:

Replace the top imports — drop `resetApplyOpState`, add `createCommandBus` and `setDeep`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dispatchServerMessage, type DispatchDeps } from './messageDispatch.js';
import { createCommandBus } from './CommandBus.js';
import { freshProject, setDeep, TRACK_POOL_SIZE, type Project, type ServerMessage } from '@fiddle/shared';
```

Add a `commandBus` to the `deps` factory, wired to write into the test's `project` (a fresh bus per `deps()` call → fresh watermark, so no cross-test bleed):

```ts
function deps(project: Project): DispatchDeps {
  return {
    project,
    wsClient: { recordOpIdSeen: vi.fn(), opIdLastSeen: vi.fn(() => 0), requestResync: vi.fn() } as unknown as DispatchDeps['wsClient'],
    outbox: {
      onLive: vi.fn(), onEcho: vi.fn(), onNack: vi.fn(), reassertPending: vi.fn(),
      hasPendingForPath: vi.fn(() => false),
    } as unknown as DispatchDeps['outbox'],
    onFatalError: vi.fn(),
    commandBus: createCommandBus({
      applySet: (path, value) => setDeep(project as unknown as Record<string, unknown>, path, value),
      enqueue: vi.fn(),
    }),
  };
}
```

Remove the now-stale module-watermark `beforeEach` in the `self-echo skip (M2)` block (each `deps()` now owns a fresh bus). Delete these two lines (the comment + the `beforeEach`):

```ts
  // The per-path opId watermark in applyOp is module state — reset it so the
  // small opIds these cases use aren't rejected as stale by a previous test.
  beforeEach(() => { resetApplyOpState(); });
```

(The remaining test bodies and assertions are unchanged — they verify the same observable behaviour, now routed through the bus.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/client && npx vitest run src/sync/messageDispatch.test.ts`
Expected: FAIL — TypeScript/`DispatchDeps` has no `commandBus` field yet (and/or the dispatch still uses the deleted module watermark). This proves the harness now requires the new wiring.

- [ ] **Step 3: Rewire `messageDispatch.ts`**

Replace the import on line 19:

```ts
import { enterSuppress, exitSuppress } from './applyOp.js';
import type { CommandBus } from './CommandBus.js';
```

Add `commandBus` to `DispatchDeps` (after `outbox`):

```ts
  outbox: Outbox;
  commandBus: CommandBus;
```

In the `snapshot` case, replace `resetApplyOpState();` with:

```ts
      deps.commandBus.resetWatermark();
```

In the `set` case, replace the `skipWrite ? advanceOpIdForPath : applyOp` block:

```ts
      if (skipWrite) {
        deps.commandBus.advanceWatermark(msg.path, msg.opId);
      } else {
        // Transitional suppression (2b-i): the outbound watchers still observe
        // this write, so suppress while applyRemote runs to stop the applied
        // remote op echoing straight back out. Removed in 2b-iii once the
        // watchers are gone. applyRemote itself stays sync-agnostic.
        enterSuppress();
        try {
          deps.commandBus.applyRemote(msg);
        } finally {
          exitSuppress();
        }
      }
```

Update the file's header comment block: the line that says "`set` (applyOp) both mutate" should read that `set` now applies via `commandBus.applyRemote` wrapped in suppression here (applyOp is gone).

- [ ] **Step 4: Instantiate the bus in `buildSyncState` and thread it into the deps**

In `packages/client/src/composables/useSynth.ts`:

Add the import near the other sync imports (line ~52, by the `applyOp` import):

```ts
import { createCommandBus, type CommandBus } from '../sync/CommandBus';
```

Add a module-scope holder next to `outbox` (find `let outbox` and add beside it):

```ts
let commandBus: CommandBus | null = null;
```

In `buildSyncState`, immediately AFTER the `outbox = new Outbox({ … });` assignment (before `installLeaveFlushHandler();`), create the bus:

```ts
  commandBus = createCommandBus({
    // 2b-i wires only the INBOUND path (applyRemote) through the bus; the
    // transitional suppress wrap lives at the messageDispatch call site, so this
    // writer stays pure. Mirrors Outbox.applyLocal's writer on the same
    // module-scope `project`. 2b-ii routes local edits through dispatchLocal;
    // 2b-iii folds every writer onto the store's applySet.
    applySet: (path: Path, value: unknown) => {
      setDeep(project as unknown as Record<string, unknown>, path, value);
    },
    enqueue: (path: Path, value: unknown, priorValue: unknown, gestureEnd: boolean) =>
      outbox!.enqueue(path, value, priorValue, gestureEnd),
  });
```

In the `onMessage` dispatch deps object (the `dispatchServerMessage(msg, { … })` literal), add `commandBus` alongside `outbox`:

```ts
      project,
      wsClient: wsClient!,
      outbox: outbox!,
      commandBus: commandBus!,
```

In the teardown (where `wsClient = null;` / `outbox = null;` at ~line 487-489), null the bus too so a fresh room gets a fresh watermark:

```ts
  outbox = null;
  commandBus = null;
```

- [ ] **Step 5: Run the focused tests to verify they pass**

Run: `cd packages/client && npx vitest run src/sync/messageDispatch.test.ts src/sync/CommandBus.test.ts`
Expected: PASS — all messageDispatch cases (snapshot pad/reconcile, self-echo skip ×4, gap detection ×2) green through the bus; CommandBus green.

- [ ] **Step 6: Typecheck the client to confirm the live wiring compiles**

Run: `cd packages/client && npx vue-tsc --noEmit`
Expected: clean (the `set` 'set'-variant `ServerMessage` is assignable to `applyRemote`'s `SetOpBroadcast`, exactly as it was to `applyOp`).

- [ ] **Step 7: Commit**

```bash
git add packages/client/src/sync/messageDispatch.ts packages/client/src/sync/messageDispatch.test.ts packages/client/src/composables/useSynth.ts
git commit -m "feat(sync): route inbound ops through CommandBus.applyRemote (phase 2b-i)

Inbound 'set' now applies via commandBus.applyRemote (suppress-wrapped at the
dispatch site, transitional) and skipped self-echoes advance the bus watermark;
snapshot resets it. The bus is instantiated in buildSyncState. Outbound watchers
+ the applyingFromNetwork flag are unchanged (deleted in 2b-iii). applyOp is now
unused and is removed in the next task.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Delete the dead `applyOp` inbound code

Now that nothing imports `applyOp`/`advanceOpIdForPath`/`resetApplyOpState`, delete them and their module-scope watermark `Map`. Keep the suppression flag (still guarding the outbound watchers until 2b-iii).

**Files:**
- Modify: `packages/client/src/sync/applyOp.ts`
- Test: `packages/client/src/sync/applyOp.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `applyOp.ts` exports ONLY `isApplyingFromNetwork`/`enterSuppress`/`exitSuppress` (plus the private `applyingFromNetwork`). `applyOp`/`advanceOpIdForPath`/`resetApplyOpState`/`lastAppliedOpIdForPath` are gone.

- [ ] **Step 1: Confirm nothing still imports the to-be-deleted symbols**

Run: `cd packages/client && grep -rn "applyOp\b\|advanceOpIdForPath\|resetApplyOpState" src/ | grep -v -e "applyOp.ts" -e "applyOp.test.ts"`
Expected: no output (Task 2 removed the last live + test importers).

- [ ] **Step 2: Rewrite the test to cover only the surviving suppression flag (RED)**

Replace the entire contents of `packages/client/src/sync/applyOp.test.ts` with:

```ts
import { describe, it, expect } from 'vitest';
import { isApplyingFromNetwork, enterSuppress, exitSuppress } from './applyOp.js';

describe('suppression flag', () => {
  it('defaults to not-applying', () => {
    expect(isApplyingFromNetwork()).toBe(false);
  });

  it('enterSuppress sets it and exitSuppress clears it', () => {
    enterSuppress();
    expect(isApplyingFromNetwork()).toBe(true);
    exitSuppress();
    expect(isApplyingFromNetwork()).toBe(false);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd packages/client && npx vitest run src/sync/applyOp.test.ts`
Expected: FAIL — the old test file imported `applyOp`/`resetApplyOpState`; after this rewrite it still references the old module shape ONLY if Step 4 hasn't run. (If it already passes because the symbols still exist, that's fine — proceed; the meaningful RED is that the OLD test asserted deleted behaviour. The new test asserts the surviving behaviour.)

- [ ] **Step 4: Delete the dead inbound code from `applyOp.ts`**

Edit `packages/client/src/sync/applyOp.ts` so it contains ONLY the suppression flag. Remove the `Project`/`SetOpBroadcast`/`setDeep`/`pathKey` imports, `lastAppliedOpIdForPath`, `advanceOpIdForPath`, `applyOp`, and `resetApplyOpState`. The whole file becomes:

```ts
// Suppression flag (transitional) — slated for deletion in Phase 2b-iii.
//
// While the OUTBOUND sync watchers in useSynth.ts still observe the reactive
// `project`, any programmatic (network-origin) write — the inbound
// CommandBus.applyRemote, the snapshot replaceProject, the Outbox rollback —
// must be wrapped so those watchers don't echo it straight back out. This flag
// is that switch: it is true for the duration of such a write, and each
// sync-participating watcher checks `isApplyingFromNetwork` before enqueuing.
//
// This only works because those watchers run with `flush: 'sync'` — they fire
// synchronously inside the suppressed write, while the flag is still held.
//
// Phase 2b-iii deletes this once every outbound write goes through the
// CommandBus (dispatchLocal) and no watcher remains to suppress.
let applyingFromNetwork = false;
export function isApplyingFromNetwork(): boolean { return applyingFromNetwork; }
export function enterSuppress(): void { applyingFromNetwork = true; }
export function exitSuppress(): void { applyingFromNetwork = false; }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/client && npx vitest run src/sync/applyOp.test.ts`
Expected: PASS (2 suppression-flag tests).

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/sync/applyOp.ts packages/client/src/sync/applyOp.test.ts
git commit -m "refactor(sync): delete applyOp + module watermark, now superseded by CommandBus (phase 2b-i)

The inbound writer + per-path opId watermark moved into CommandBus.applyRemote /
advanceWatermark in the previous task. applyOp.ts now holds only the transitional
suppression flag (deleted in 2b-iii).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Gate (after Task 3)

Run from repo root:

```bash
npm run typecheck && npm test && npm run build
```

Expected: typecheck clean; all tests pass (client incl. the new CommandBus `advanceWatermark` tests + the bus-routed messageDispatch suite + the slimmed applyOp suppression test; server; shared); client + server build succeed.

## Browser verification (after the gate) — CRITICAL, this is a live-path change

Controller-owned. Use `npm run dev:obs` (LOCAL Docker DB — **never** `npm run dev`).

1. Open the app, create/enter a session. Confirm it boots clean (only the pre-existing `favicon.ico` 404).
2. **Two-tab inbound round-trip (the core of this change):** open a second tab on the same room. In tab A change BPM, toggle/set a step note, switch a track engine, add/remove a track. Confirm each propagates to tab B (now applied via `commandBus.applyRemote`). Then edit in tab B and confirm it lands in tab A. Bidirectional.
3. **Self-echo / dragging knob:** drag a knob continuously in tab A; confirm it does not snap backward mid-drag (the `advanceWatermark` skip path) and settles to the released value, and that tab B follows.
4. **Snapshot/reconnect:** reload tab B (fresh snapshot) and confirm it shows tab A's edits (snapshot path + `resetWatermark`).
5. Probe: in devtools, confirm the inbound path now runs through the bus — `applyOp` is gone from the module graph, the live `project` still mutates on remote ops, and the outbound watchers still emit local edits (sync still bidirectional).
6. Confirm no new console errors. Close the browser tab(s).

## What Phase 2b-i deliberately does NOT do

- It does **not** touch the OUTBOUND path: `installSyncWatchers` + its 8 watchers, `Outbox`, `Outbox.applyLocal`, `knobSync.ts`, the `bpm` computed, `addTrack`/`removeTrack`, and all components are unchanged. `dispatchLocal` is wired into the bus deps but called by nothing live yet.
- It does **not** delete the suppression flag — `applyingFromNetwork`/`enterSuppress`/`exitSuppress` stay and keep guarding the watchers (deleted in **2b-iii**).
- It does **not** fold writers onto `store.applySet` — the bus's `applySet` dep inlines `setDeep` on the same `project` (mirrors `Outbox.applyLocal`); unification is **2b-ii/iii**.
- It does **not** rename `applyOp.ts` (cosmetic; the file is deleted in 2b-iii).
- It does **not** migrate any component write to `dispatchLocal` (that is **2b-ii**).

## Self-review

- **Spec coverage (Phase 2, inbound slice):** the spec moves the opId watermark from `applyOp` into `CommandBus.applyRemote` and routes inbound ops through the bus. Task 1 adds the `advanceWatermark` the self-echo skip needs; Task 2 flips `messageDispatch` live onto `applyRemote`/`advanceWatermark`/`resetWatermark` and instantiates the bus; Task 3 deletes the superseded `applyOp`. The outbound migration + suppression-flag deletion are carved to 2b-ii/2b-iii. Covered for 2b-i.
- **Placeholder scan:** every code step shows complete code; every command states expected output. The one soft spot — Task 3 Step 3's RED — is called out explicitly (the meaningful RED is the deleted-symbol import; if the rewritten test passes pre-delete because the symbols still exist, proceed). Clean.
- **Type consistency:** `advanceWatermark(path: Path, opId: number): boolean` is spelled identically in `CommandBus.ts`, its test, and the `messageDispatch` call. `type CommandBus = ReturnType<typeof createCommandBus>` is the dep type in `DispatchDeps` and the `useSynth` holder. `applySet`/`enqueue` dep shapes match `createCommandBus`'s `CommandBusDeps` and `Outbox.enqueue`. The `set` `ServerMessage` variant is assignable to `applyRemote`'s `SetOpBroadcast` (it already was to `applyOp`). Consistent.
- **Behaviour preservation:** the messageDispatch suite is unchanged in its assertions — only the harness gains a real bus — so a green suite is direct evidence the observable inbound behaviour (apply / drop-stale / skip-echo / advance-on-skip / gap-resync / snapshot-reset) is preserved through the bus.
