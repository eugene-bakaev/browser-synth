# Local Undo/Redo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Local, per-client undo/redo (mod+Z / shift+mod+Z) covering every local project edit, recorded as a tap on the CommandBus.

**Architecture:** A new pure factory `undoHistory.ts` records every local command (path, before, after) into gesture-sized entries — burst rule (one synchronous task = one entry, sealed by a microtask) plus drag rule (consecutive single-leaf continuous edits merge until `endGesture`). Undo/redo replay priors as ordinary local ops through the bus with a per-leaf skip-if-superseded check, so collaborators' newer edits are never clobbered. Spec: `docs/superpowers/specs/2026-07-12-undo-design.md` (approved, `e20cc5a`).

**Tech Stack:** TypeScript, Vue 3 client package only, Vitest (jsdom).

## Global Constraints

- **Zero shared/server changes.** Only `packages/client` is touched. Wire format unchanged (restores are ordinary set ops).
- Depth cap: `UNDO_DEPTH = 100` entries, oldest dropped.
- Undo policy: **skip-if-superseded** — a leaf is restored only when live value `===` the value this client wrote; fully-stale entries pop through to the next older entry.
- Re-entrancy: undo/redo dispatches are never recorded (`applying` flag).
- Remote ops (`applyRemote`) and nack rollbacks (`applyRollback`) are NEVER recorded — only `dispatchLocal`.
- History clears on `bus.loadProject` (New / Open / snapshot replace / room switch).
- Keyboard: `global.undo` → `mod+z`; `global.redo` → `shift+mod+z` and `mod+y`; both `context: 'global'`, `allowRepeat: true`; registered in AppRuntime.
- Continuous vs discrete leaf = existing `gestureEndForLeaf` (`sync/dispatchPolicy.ts`); do not add a parallel policy.
- Tests: `npm test -w @fiddle/client` must pass; full gate at the end also runs `npm test -w @fiddle/shared`, `npm test -w @fiddle/server`, `npm run typecheck -w @fiddle/client`, `npm run build -w @fiddle/client`.
- NEVER run `npm run dev` (prod DB). Local browser testing is `npm run dev:obs` only.
- Stage ONLY the files named in each commit step — never `git add -A`/`-u`. Never stage `studio-focused.md`, `studio-initial.png`, `synth2-wave-previews.png`.
- Every commit message ends with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01DFmmWXyd9uJAiJ6cdbE4ir`

---

### Task 1: `undoHistory` factory

**Files:**
- Create: `packages/client/src/app/undoHistory.ts`
- Test: `packages/client/src/app/undoHistory.test.ts`

**Interfaces:**
- Consumes: `pathKey`, `Path` from `@fiddle/shared` (existing).
- Produces (Tasks 2–3 rely on these exact names):
  - `createUndoHistory(deps: UndoHistoryDeps)` returning
    `{ record(path, value, priorValue, gestureEnd): void; endGesture(path): void; undo(): void; redo(): void; canUndo(): boolean; canRedo(): boolean; clear(): void }`
  - `UndoHistoryDeps = { getLiveValue(path: Path): unknown; dispatch(path: Path, value: unknown, priorValue: unknown): void }`
  - `export type UndoHistory = ReturnType<typeof createUndoHistory>`
  - `export const UNDO_DEPTH = 100`

- [ ] **Step 1: Write the failing tests**

Create `packages/client/src/app/undoHistory.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import type { Path } from '@fiddle/shared';
import { createUndoHistory, UNDO_DEPTH, type UndoHistory } from './undoHistory';

// Microtask flush: queueMicrotask(seal) enqueued before this await resolves.
const tick = () => Promise.resolve();

// Harness mirrors the REAL wiring: `dispatch` writes state and then re-enters
// history.record (in production: bus.dispatchLocal → onLocalCommand tap), so
// the re-entrancy guard is exercised by every undo/redo test, not one.
function harness() {
  const state = new Map<string, unknown>();
  const key = (p: Path) => JSON.stringify(p);
  let history: UndoHistory;
  const dispatch = vi.fn((path: Path, value: unknown, priorValue: unknown) => {
    state.set(key(path), value);
    history.record(path, value, priorValue, true);
  });
  history = createUndoHistory({
    getLiveValue: (path) => state.get(key(path)),
    dispatch,
  });
  /** Simulate a local user edit (bus order: write state, then tap). */
  function edit(path: Path, value: unknown, gestureEnd = true): void {
    const prior = state.get(key(path));
    state.set(key(path), value);
    history.record(path, value, prior, gestureEnd);
  }
  /** Simulate a remote user's edit (applyRemote: state only, no tap). */
  function remote(path: Path, value: unknown): void {
    state.set(key(path), value);
  }
  return { state, key, dispatch, history, edit, remote };
}

describe('recording', () => {
  it('burst rule: leaves dispatched in one task form ONE entry', async () => {
    const h = harness();
    h.state.set(h.key(['a']), 0); h.state.set(h.key(['b']), 0); h.state.set(h.key(['c']), 0);
    h.edit(['a'], 1); h.edit(['b'], 2); h.edit(['c'], 3); // same task
    await tick();
    expect(h.history.canUndo()).toBe(true);
    h.history.undo();
    expect(h.state.get(h.key(['a']))).toBe(0);
    expect(h.state.get(h.key(['b']))).toBe(0);
    expect(h.state.get(h.key(['c']))).toBe(0);
    expect(h.history.canUndo()).toBe(false); // one entry, fully consumed
  });

  it('same leaf twice in one burst keeps earliest before, latest after', async () => {
    const h = harness();
    h.state.set(h.key(['a']), 0);
    h.edit(['a'], 1); h.edit(['a'], 2);
    await tick();
    h.history.undo();
    expect(h.state.get(h.key(['a']))).toBe(0); // not 1
    h.history.redo();
    expect(h.state.get(h.key(['a']))).toBe(2); // not 1
  });

  it('separate tasks make separate entries', async () => {
    const h = harness();
    h.state.set(h.key(['a']), 0);
    h.edit(['a'], 1); await tick();
    h.edit(['a'], 2); await tick();
    h.history.undo();
    expect(h.state.get(h.key(['a']))).toBe(1);
    h.history.undo();
    expect(h.state.get(h.key(['a']))).toBe(0);
  });

  it('no-op filter: value === priorValue records nothing', async () => {
    const h = harness();
    h.state.set(h.key(['a']), 5);
    h.edit(['a'], 5);
    await tick();
    expect(h.history.canUndo()).toBe(false);
  });
});

describe('drag merging', () => {
  const knob: Path = ['tracks', 0, 'engines', 'synth', 'osc1Coarse'];

  it('consecutive continuous single-leaf entries on one path merge into one entry', async () => {
    const h = harness();
    h.state.set(h.key(knob), 0);
    h.edit(knob, 0.1, false); await tick();
    h.edit(knob, 0.2, false); await tick();
    h.edit(knob, 0.3, false); await tick();
    h.history.undo();
    expect(h.state.get(h.key(knob))).toBe(0); // whole drag = one step
    expect(h.history.canUndo()).toBe(false);
  });

  it('endGesture closes the merge window: a second drag is a second entry', async () => {
    const h = harness();
    h.state.set(h.key(knob), 0);
    h.edit(knob, 0.1, false); await tick();
    h.history.endGesture(knob);
    h.edit(knob, 0.2, false); await tick();
    h.history.undo();
    expect(h.state.get(h.key(knob))).toBe(0.1); // second drag undone only
    h.history.undo();
    expect(h.state.get(h.key(knob))).toBe(0);
  });

  it('discrete leaves (gestureEnd=true) never merge', async () => {
    const h = harness();
    h.state.set(h.key(['m']), false);
    h.edit(['m'], true); await tick();
    h.edit(['m'], false); await tick();
    h.history.undo();
    expect(h.state.get(h.key(['m']))).toBe(true);
    h.history.undo();
    expect(h.state.get(h.key(['m']))).toBe(false);
  });

  it('a different path breaks the merge chain', async () => {
    const h = harness();
    h.state.set(h.key(['a']), 0); h.state.set(h.key(['b']), 0);
    h.edit(['a'], 0.1, false); await tick();
    h.edit(['b'], 0.5, false); await tick();
    h.edit(['a'], 0.2, false); await tick(); // must NOT merge into the first ['a'] entry
    h.history.undo();
    expect(h.state.get(h.key(['a']))).toBe(0.1);
  });

  it('undo closes the merge window', async () => {
    const h = harness();
    h.state.set(h.key(knob), 0);
    h.edit(knob, 0.1, false); await tick();
    h.history.undo();                        // back to 0
    h.history.redo();                        // forward to 0.1
    h.edit(knob, 0.2, false); await tick();  // new drag — must NOT merge into old entry
    h.history.undo();
    expect(h.state.get(h.key(knob))).toBe(0.1);
  });
});

describe('undo/redo semantics', () => {
  it('skip-if-superseded: a remotely overwritten leaf is skipped, others restore', async () => {
    const h = harness();
    h.state.set(h.key(['a']), 0); h.state.set(h.key(['b']), 0);
    h.edit(['a'], 1); h.edit(['b'], 2); // one entry
    await tick();
    h.remote(['b'], 99);                // collaborator wins on b
    h.history.undo();
    expect(h.state.get(h.key(['a']))).toBe(0);  // still mine → restored
    expect(h.state.get(h.key(['b']))).toBe(99); // theirs → untouched
    h.history.redo();                   // redo entry contains ONLY the applied leaf
    expect(h.state.get(h.key(['a']))).toBe(1);
    expect(h.state.get(h.key(['b']))).toBe(99);
  });

  it('fully-stale entry pops through to the next older entry', async () => {
    const h = harness();
    h.state.set(h.key(['a']), 0); h.state.set(h.key(['b']), 0);
    h.edit(['a'], 1); await tick();
    h.edit(['b'], 2); await tick();
    h.remote(['b'], 99);                // newest entry fully superseded
    h.history.undo();                   // skips b-entry, undoes a-entry
    expect(h.state.get(h.key(['b']))).toBe(99);
    expect(h.state.get(h.key(['a']))).toBe(0);
    expect(h.history.canUndo()).toBe(false); // both entries consumed
  });

  it('redo skips a leaf someone changed after the undo', async () => {
    const h = harness();
    h.state.set(h.key(['a']), 0);
    h.edit(['a'], 1); await tick();
    h.history.undo();                   // a back to 0
    h.remote(['a'], 50);
    h.history.redo();                   // live 50 !== before 0 → skip
    expect(h.state.get(h.key(['a']))).toBe(50);
  });

  it('a fresh edit clears the redo stack', async () => {
    const h = harness();
    h.state.set(h.key(['a']), 0);
    h.edit(['a'], 1); await tick();
    h.history.undo();
    expect(h.history.canRedo()).toBe(true);
    h.edit(['a'], 7); await tick();
    expect(h.history.canRedo()).toBe(false);
  });

  it('redo does NOT clear the redo stack (chained redos work)', async () => {
    const h = harness();
    h.state.set(h.key(['a']), 0);
    h.edit(['a'], 1); await tick();
    h.edit(['a'], 2); await tick();
    h.history.undo(); h.history.undo();
    h.history.redo();
    expect(h.history.canRedo()).toBe(true);
    h.history.redo();
    expect(h.state.get(h.key(['a']))).toBe(2);
  });

  it('re-entrancy: undo/redo dispatches are not recorded as new entries', async () => {
    const h = harness();
    h.state.set(h.key(['a']), 0);
    h.edit(['a'], 1); await tick();
    h.history.undo();
    await tick(); // any illegal self-record would seal here
    expect(h.history.canUndo()).toBe(false);
    h.history.redo();
    await tick();
    expect(h.history.canRedo()).toBe(false);
    expect(h.history.canUndo()).toBe(true); // exactly the one re-pushed entry
  });

  it('undo/redo on empty stacks is a no-op', () => {
    const h = harness();
    h.history.undo();
    h.history.redo();
    expect(h.dispatch).not.toHaveBeenCalled();
  });
});

describe('lifecycle', () => {
  it('depth cap: oldest entries evicted beyond UNDO_DEPTH', async () => {
    const h = harness();
    h.state.set(h.key(['a']), 0);
    for (let i = 1; i <= UNDO_DEPTH + 5; i++) {
      h.edit(['a'], i); await tick();
    }
    let undos = 0;
    while (h.history.canUndo()) { h.history.undo(); undos++; }
    expect(undos).toBe(UNDO_DEPTH);
    expect(h.state.get(h.key(['a']))).toBe(5); // entries 1..5 were evicted
  });

  it('clear() empties both stacks and the merge window', async () => {
    const h = harness();
    h.state.set(h.key(['a']), 0);
    h.edit(['a'], 1); await tick();
    h.history.undo();
    h.history.clear();
    expect(h.history.canUndo()).toBe(false);
    expect(h.history.canRedo()).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @fiddle/client -- run src/app/undoHistory.test.ts`
Expected: FAIL — cannot resolve `./undoHistory`.

- [ ] **Step 3: Write the implementation**

Create `packages/client/src/app/undoHistory.ts`:

```ts
// undoHistory — local, per-client undo/redo over the CommandBus funnel.
//
// Records every LOCAL command (the bus's onLocalCommand tap) into gesture-
// sized entries and replays priors as ordinary local ops. Pure factory, no
// Vue imports; deps inject the live-state read and the dispatch route.
//
// Batching (spec docs/superpowers/specs/2026-07-12-undo-design.md):
//   burst rule — ops recorded in one synchronous task form ONE entry
//     (sealed by a microtask), so paste/clear/move/preset are single steps;
//   drag rule  — a sealed single-leaf entry on a CONTINUOUS leaf
//     (gestureEnd === false, per sync/dispatchPolicy) merges into the
//     previous entry while the gesture is open; endGesture(path), any other
//     entry, undo/redo, or clear closes it. Two drags = two steps.
//
// Undo policy — skip-if-superseded: a leaf is restored only when the live
// value still === what this client wrote; anything newer (another user, a
// nack rollback, a reconcile) wins and the leaf is skipped. A fully-stale
// entry pops through to the next older one so a keypress always does
// something while anything undoable remains.

import { pathKey, type Path } from '@fiddle/shared';

export interface UndoLeaf { path: Path; before: unknown; after: unknown }
export interface UndoEntry { leaves: UndoLeaf[] }

export const UNDO_DEPTH = 100;

export interface UndoHistoryDeps {
  /** Read the canonical live value at path (getDeep on project). */
  getLiveValue(path: Path): unknown;
  /** Route a restore back through the bus as an ordinary local op. */
  dispatch(path: Path, value: unknown, priorValue: unknown): void;
}

export function createUndoHistory(deps: UndoHistoryDeps) {
  const undoStack: UndoEntry[] = [];
  const redoStack: UndoEntry[] = [];

  // The burst being accumulated this task. singleContinuousKey is the
  // pathKey when the burst is exactly one continuous leaf (drag candidate).
  let open: { leaves: UndoLeaf[]; singleContinuousKey: string | null } | null = null;
  // pathKey of the undoStack top while it is still open for drag merging.
  let mergeKey: string | null = null;
  // True while undo()/redo() dispatch restores — those must not self-record.
  let applying = false;

  function record(path: Path, value: unknown, priorValue: unknown, gestureEnd: boolean): void {
    if (applying) return;
    if (priorValue === value) return; // no-op edit
    if (!open) {
      open = { leaves: [], singleContinuousKey: null };
      queueMicrotask(seal);
    }
    const key = pathKey(path);
    const existing = open.leaves.find((l) => pathKey(l.path) === key);
    if (existing) {
      existing.after = value; // same leaf twice in one burst: keep earliest before
    } else {
      open.leaves.push({ path, before: priorValue, after: value });
    }
    open.singleContinuousKey = open.leaves.length === 1 && !gestureEnd ? key : null;
  }

  function seal(): void {
    const entry = open;
    open = null;
    if (!entry || entry.leaves.length === 0) return;
    redoStack.length = 0; // any fresh edit (including a drag tick) invalidates redo
    const top = undoStack[undoStack.length - 1];
    if (entry.singleContinuousKey !== null && entry.singleContinuousKey === mergeKey && top) {
      top.leaves[0].after = entry.leaves[0].after; // drag continuation
      return;
    }
    undoStack.push({ leaves: entry.leaves });
    if (undoStack.length > UNDO_DEPTH) undoStack.shift();
    mergeKey = entry.singleContinuousKey;
  }

  /** Gesture boundary (knob mouseup): the next edit on this path is a new entry. */
  function endGesture(path: Path): void {
    if (mergeKey !== null && mergeKey === pathKey(path)) mergeKey = null;
  }

  function undo(): void {
    if (open) seal(); // a same-task edit is undoable immediately
    mergeKey = null;
    while (undoStack.length > 0) {
      const entry = undoStack.pop()!;
      const applied: UndoLeaf[] = [];
      applying = true;
      try {
        for (let i = entry.leaves.length - 1; i >= 0; i--) {
          const leaf = entry.leaves[i];
          if (deps.getLiveValue(leaf.path) !== leaf.after) continue; // superseded
          deps.dispatch(leaf.path, leaf.before, leaf.after);
          applied.unshift(leaf); // forward order for the redo mirror
        }
      } finally {
        applying = false;
      }
      if (applied.length > 0) {
        redoStack.push({ leaves: applied });
        return;
      }
      // fully stale — pop through to the next older entry
    }
  }

  function redo(): void {
    if (open) seal(); // consistent ordering; the seal clears redo, making this a no-op
    mergeKey = null;
    while (redoStack.length > 0) {
      const entry = redoStack.pop()!;
      const applied: UndoLeaf[] = [];
      applying = true;
      try {
        for (const leaf of entry.leaves) {
          if (deps.getLiveValue(leaf.path) !== leaf.before) continue; // superseded
          deps.dispatch(leaf.path, leaf.after, leaf.before);
          applied.push(leaf);
        }
      } finally {
        applying = false;
      }
      if (applied.length > 0) {
        undoStack.push({ leaves: applied });
        if (undoStack.length > UNDO_DEPTH) undoStack.shift();
        return;
      }
    }
  }

  function canUndo(): boolean {
    return undoStack.length > 0 || (open?.leaves.length ?? 0) > 0;
  }
  function canRedo(): boolean {
    return redoStack.length > 0;
  }

  /** New/Open/snapshot/room switch: history never spans projects. */
  function clear(): void {
    open = null;
    mergeKey = null;
    undoStack.length = 0;
    redoStack.length = 0;
  }

  return { record, endGesture, undo, redo, canUndo, canRedo, clear };
}

export type UndoHistory = ReturnType<typeof createUndoHistory>;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @fiddle/client -- run src/app/undoHistory.test.ts`
Expected: PASS (18 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/app/undoHistory.ts packages/client/src/app/undoHistory.test.ts
git commit -m "feat(client): undoHistory factory — gesture-batched local undo/redo core

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DFmmWXyd9uJAiJ6cdbE4ir"
```

---

### Task 2: CommandBus `onLocalCommand` tap

**Files:**
- Modify: `packages/client/src/sync/CommandBus.ts` (deps interface + one call in `dispatchLocal`)
- Test: `packages/client/src/sync/CommandBus.test.ts` (append one describe block)

**Interfaces:**
- Consumes: nothing new.
- Produces: `CommandBusDeps.onLocalCommand?: (path: Path, value: unknown, priorValue: unknown, gestureEnd: boolean) => void`, invoked from `dispatchLocal` ONLY (after write/emit/enqueue). Task 3 wires `history.record` into it.

- [ ] **Step 1: Write the failing tests**

Append to `packages/client/src/sync/CommandBus.test.ts` (top level, after the existing describes; reuses `makeFakes`/`broadcast` from the top of the file):

```ts
describe('onLocalCommand tap (undo history)', () => {
  it('dispatchLocal reports path/value/priorValue/gestureEnd to the tap', () => {
    const f = makeFakes();
    const tapped: Array<{ path: Path; value: unknown; priorValue: unknown; gestureEnd: boolean }> = [];
    const bus = createCommandBus({
      ...f.deps,
      onLocalCommand: (path, value, priorValue, gestureEnd) => { tapped.push({ path, value, priorValue, gestureEnd }); },
    });
    bus.dispatchLocal({ path: ['bpm'], value: 128, priorValue: 120, gestureEnd: true });
    bus.dispatchLocal({ path: ['bpm'], value: 130, priorValue: 128 });
    expect(tapped).toEqual([
      { path: ['bpm'], value: 128, priorValue: 120, gestureEnd: true },
      { path: ['bpm'], value: 130, priorValue: 128, gestureEnd: false }, // default false
    ]);
  });

  it('applyRemote and applyRollback do NOT hit the tap', () => {
    const f = makeFakes();
    const tap = vi.fn();
    const bus = createCommandBus({ ...f.deps, onLocalCommand: tap });
    bus.applyRemote(broadcast(['bpm'], 90, 1));
    bus.applyRollback(['bpm'], 120);
    expect(tap).not.toHaveBeenCalled();
  });

  it('a bus without the tap dispatches without throwing', () => {
    const f = makeFakes();
    const bus = createCommandBus(f.deps);
    expect(() => bus.dispatchLocal({ path: ['bpm'], value: 128, priorValue: 120 })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @fiddle/client -- run src/sync/CommandBus.test.ts`
Expected: FAIL — first new test's `tapped` stays empty (TS may also reject the unknown dep; that counts as the failing state).

- [ ] **Step 3: Implement**

In `packages/client/src/sync/CommandBus.ts`, add to `CommandBusDeps` (after `enqueue`):

```ts
  /** Undo-history tap: reports every LOCAL command after the write + enqueue.
   *  Remote ops and rollbacks never report — only the user's own edits are undoable. */
  onLocalCommand?: (path: Path, value: unknown, priorValue: unknown, gestureEnd: boolean) => void;
```

And in `dispatchLocal`, add one line at the end:

```ts
  function dispatchLocal(cmd: LocalCommand): void {
    deps.applySet(cmd.path, cmd.value);
    emit({ kind: 'set', path: cmd.path, value: cmd.value });
    deps.enqueue(cmd.path, cmd.value, cmd.priorValue, cmd.gestureEnd ?? false);
    deps.onLocalCommand?.(cmd.path, cmd.value, cmd.priorValue, cmd.gestureEnd ?? false);
  }
```

No other method changes.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @fiddle/client -- run src/sync/CommandBus.test.ts`
Expected: PASS (all existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/sync/CommandBus.ts packages/client/src/sync/CommandBus.test.ts
git commit -m "feat(client): CommandBus onLocalCommand tap for undo recording

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DFmmWXyd9uJAiJ6cdbE4ir"
```

---

### Task 3: Wiring — AppRuntime, bindings, synthContext gesture tap

**Files:**
- Modify: `packages/client/src/app/AppRuntime.ts` (history creation, bus deps, keyboard registration, interface/return)
- Modify: `packages/client/src/keyboard/bindings.ts` (two rows)
- Modify: `packages/client/src/app/synthContext.ts:47-49` (`endGesture`)
- Test: `packages/client/src/app/AppRuntime.test.ts` (append describe), `packages/client/src/app/synthContext.test.ts` (append one test)

**Interfaces:**
- Consumes: `createUndoHistory`/`UndoHistory` (Task 1), `onLocalCommand` (Task 2), existing `getDeep` (`@fiddle/shared`), `gestureEndForLeaf` (`../sync/dispatchPolicy`), `KeyboardService.register`.
- Produces: `AppRuntime.history: UndoHistory` (used by synthContext and tests); bindings ids `global.undo`, `global.redo`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/client/src/app/AppRuntime.test.ts` (uses the existing audio mocks; add `detectPlatform` and `freshProject` to the imports at the top: `import { detectPlatform } from '../keyboard/keys';` and `import { freshProject } from '../project';`):

```ts
describe('undo/redo wiring', () => {
  // jsdom's platform varies by host OS — derive the expected mod key the same
  // way the KeyboardService does, so the test passes on mac and linux CI alike.
  const mod = () => (detectPlatform() === 'mac' ? { metaKey: true } : { ctrlKey: true });

  it('mod+z undoes and shift+mod+z redoes a local edit end-to-end', async () => {
    const rt = createAppRuntime({ syncEnabled: false });
    const prior = rt.store.project.bpm;
    rt.bus.dispatchLocal({ path: ['bpm'], value: prior + 8, priorValue: prior, gestureEnd: true });
    await Promise.resolve(); // seal the burst entry
    rt.keyboard.handleKeydown(new KeyboardEvent('keydown', { key: 'z', ...mod() }));
    expect(rt.store.project.bpm).toBe(prior);
    rt.keyboard.handleKeydown(new KeyboardEvent('keydown', { key: 'z', shiftKey: true, ...mod() }));
    expect(rt.store.project.bpm).toBe(prior + 8);
    rt.shutdown();
  });

  it('undo restores route through the bus (outbound enqueue observed)', async () => {
    const rt = createAppRuntime({ syncEnabled: false });
    const enqueued: unknown[] = [];
    const spy = vi.spyOn(rt.session, 'enqueue').mockImplementation(((...args: unknown[]) => { enqueued.push(args); }) as never);
    const prior = rt.store.project.bpm;
    rt.bus.dispatchLocal({ path: ['bpm'], value: prior + 8, priorValue: prior, gestureEnd: true });
    await Promise.resolve();
    rt.history.undo();
    expect(rt.store.project.bpm).toBe(prior);
    expect(enqueued.length).toBe(2); // the edit AND the restore both sync
    spy.mockRestore();
    rt.shutdown();
  });

  it('loadProject clears the history', async () => {
    const rt = createAppRuntime({ syncEnabled: false });
    rt.bus.dispatchLocal({ path: ['bpm'], value: 99, priorValue: rt.store.project.bpm, gestureEnd: true });
    await Promise.resolve();
    expect(rt.history.canUndo()).toBe(true);
    rt.bus.loadProject(freshProject());
    expect(rt.history.canUndo()).toBe(false);
    expect(rt.history.canRedo()).toBe(false);
    rt.shutdown();
  });
});
```

Append to `packages/client/src/app/synthContext.test.ts` (inside a new top-level describe; uses the existing `makeCtx` helper):

```ts
describe('endGesture undo tap', () => {
  it('endGesture closes the undo drag-merge window AND still flushes the path', () => {
    const { runtime, ctx } = makeCtx({ sync: false });
    const histSpy = vi.spyOn(runtime.history, 'endGesture');
    const flushSpy = vi.spyOn(runtime.session, 'flushPath');
    const path = ['tracks', 0, 'engines', 'synth', 'osc1Coarse'];
    ctx.endGesture(path);
    expect(histSpy).toHaveBeenCalledWith(path);
    expect(flushSpy).toHaveBeenCalledWith(path);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @fiddle/client -- run src/app/AppRuntime.test.ts src/app/synthContext.test.ts`
Expected: FAIL — `rt.history` undefined / TS error (`history` not on `AppRuntime`).

- [ ] **Step 3: Add the bindings rows**

In `packages/client/src/keyboard/bindings.ts`, add to `KEY_BINDINGS` (keep the table alphabetical — these two rows go first):

```ts
  'global.redo': ['shift+mod+z', 'mod+y'],
  'global.undo': 'mod+z',
```

- [ ] **Step 4: Wire AppRuntime**

In `packages/client/src/app/AppRuntime.ts`:

Add imports:

```ts
import { getDeep } from '@fiddle/shared';
import { gestureEndForLeaf } from '../sync/dispatchPolicy';
import { createUndoHistory, type UndoHistory } from './undoHistory';
```

Add to the `AppRuntime` interface (after `keyboard`):

```ts
  history: UndoHistory;
```

Replace the body of `createAppRuntime` between `const project = store.project;` and `const audio = ...` with:

```ts
  // history ↔ bus wiring mirrors the bus ↔ session pattern below: the arrows
  // late-bind busRef (they only run on user input, long after both exist).
  let busRef: CommandBus;
  const history = createUndoHistory({
    getLiveValue: (path) => getDeep(project as unknown as Record<string, unknown>, path),
    dispatch: (path, value, priorValue) => busRef.dispatchLocal({
      path, value, priorValue,
      gestureEnd: gestureEndForLeaf(String(path[path.length - 1])),
    }),
  });

  // bus ↔ session wiring: the bus needs the session's gated outbound enqueue;
  // the session needs the bus for inbound ops. The arrow late-binds `session`
  // (it only runs on a dispatch, long after both exist).
  let session: SyncSession;
  const bus = createCommandBus({
    applySet: store.applySet,
    // History never spans projects: New/Open/snapshot/room switch clear it.
    loadProject: (next) => { store.loadProject(next); history.clear(); },
    enqueue: (path, value, prior, gestureEnd) => session.enqueue(path, value, prior, gestureEnd),
    onLocalCommand: history.record,
  });
  busRef = bus;
  session = new SyncSession({
    bus,
    wsClientFactory: () => (opts.wsClientFactory ?? ((o) => new WsClient(o))),
    syncEnabled: () => opts.syncEnabled ?? true,
    auth: () => useAuth(),
  });
```

After `const keyboard = new KeyboardService();` add:

```ts
  // App-global undo/redo. Registered here (not in a view) because the history
  // is page-lifetime; keyboard.dispose() in shutdown() drops the registrations.
  keyboard.register({
    id: 'global.undo', description: 'Undo last edit', context: 'global',
    allowRepeat: true, isEnabled: () => history.canUndo(), run: () => history.undo(),
  });
  keyboard.register({
    id: 'global.redo', description: 'Redo last undone edit', context: 'global',
    allowRepeat: true, isEnabled: () => history.canRedo(), run: () => history.redo(),
  });
```

And return `history`:

```ts
  return { pinia, store, bus, session, audio, keyboard, history, shutdown };
```

- [ ] **Step 5: Tap endGesture in synthContext**

In `packages/client/src/app/synthContext.ts`, change `endGesture` (currently lines 47-49) to (uses `runtime.history`, NOT a destructured `history`, to avoid shadowing questions):

```ts
  function endGesture(path: Path): void {
    runtime.history.endGesture(path); // close the undo drag-merge window for this knob
    session.flushPath(path);
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -w @fiddle/client -- run src/app/AppRuntime.test.ts src/app/synthContext.test.ts src/keyboard`
Expected: PASS — new tests green; existing keyboard hygiene tests unaffected (they only assert `tracker.*` ids).

- [ ] **Step 7: Run the full client suite + typecheck**

Run: `npm test -w @fiddle/client -- run && npm run typecheck -w @fiddle/client`
Expected: PASS, no type errors.

- [ ] **Step 8: Commit**

```bash
git add packages/client/src/app/AppRuntime.ts packages/client/src/app/AppRuntime.test.ts packages/client/src/app/synthContext.ts packages/client/src/app/synthContext.test.ts packages/client/src/keyboard/bindings.ts
git commit -m "feat(client): wire undo/redo — bus tap, mod+z/shift+mod+z, gesture boundary

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DFmmWXyd9uJAiJ6cdbE4ir"
```

---

## Final gates (controller, after all tasks)

1. **Monorepo gate:** `npm test -w @fiddle/shared`, `npm test -w @fiddle/client -- run`, `npm test -w @fiddle/server`, `npm run typecheck -w @fiddle/client`, `npm run build -w @fiddle/client` — all green.
2. **Final whole-branch review** (opus) per subagent-driven-development.
3. **Mandatory browser verification** on `npm run dev:obs` (throwaway session, Playwright MCP, close browser after), per the spec checklist:
   - knob drag → ONE cmd+Z restores the pre-drag value; a second drag then cmd+Z undoes only the second drag
   - paste 3+ steps → cmd+Z restores all, shift+cmd+Z re-applies
   - M / note edits step back one press per undo; holding cmd+Z repeats
   - two tabs: undo in tab A visible in tab B; tab B overwrites a value tab A edited → tab A's cmd+Z skips it (B's value stands)
   - Open project → history cleared (cmd+Z inert)
   - focus in the track-name editor: cmd+Z does native text undo (command system stands down)
   - clean console (known favicon 404 / local presets 500 tolerated)
4. Update SDD ledger + memory; present finishing options (default: keep branch for user browser-check before merge).
