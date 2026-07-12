# Undo/Redo Design

**Date:** 2026-07-12
**Status:** Approved (user-reviewed design conversation)
**Branch:** feat/undo-history

## Goal

Local, per-client undo/redo (mod+Z / shift+mod+Z) covering every local
project edit, built as a tap on the CommandBus — the single funnel all
local edits already flow through, each carrying `priorValue`.

## Scope decisions (user-approved)

- **Coverage: everything.** Every edit that goes through
  `bus.dispatchLocal` is undoable: step edits, selection ops (paste /
  move / clear / mute), knob turns, BPM, mixer, engine switch, preset
  load, INIT PATCH, track rename, track enable/disable. New / Open /
  session-switch are NOT undoable steps — they clear the history.
- **Granularity: one entry per user gesture.** A knob drag (dozens of
  dispatches) is ONE undo step; a paste (many leaves in one call stack)
  is ONE undo step; discrete presses (M, note edit, engine switch) are
  one step each.
- **Multi-user: local history, own edits only, skip-if-superseded.**
  Other users' edits never enter the history. Undo only takes back
  changes that are still yours: if a collaborator overwrote your value,
  the stale leaf is skipped, never clobbered (see §Undo semantics).
- **UI: keyboard only.** No buttons this round.
- **Depth: 100 entries**, oldest dropped.

## Architecture

Approach chosen: **bus tap** (vs explicit transactions at every call
site, vs command-pattern inverses — both rejected: call-site churn /
duplicated inverse logic).

### New unit: `packages/client/src/app/undoHistory.ts`

Pure factory (no Vue imports), same style as `trackerCommands`.

```ts
interface UndoLeaf  { path: Path; before: unknown; after: unknown }
interface UndoEntry { leaves: UndoLeaf[] }

interface UndoHistoryDeps {
  /** Read the canonical live value at path (getDeep on project). */
  getLiveValue(path: Path): unknown;
  /** Route a restore back through the bus as an ordinary local op. */
  dispatch(path: Path, value: unknown, priorValue: unknown): void;
}

createUndoHistory(deps): {
  record(path, value, priorValue, gestureEnd): void; // the bus tap
  undo(): void;
  redo(): void;
  canUndo(): boolean;   // for isEnabled
  canRedo(): boolean;
  clear(): void;        // loadProject
}
```

Two stacks: `undoStack`, `redoStack`, capped at `UNDO_DEPTH = 100`
(drop oldest). All leaf values in this app are primitives (accept-list
guarantees scalar leaves), so staleness checks are plain `===`.

### CommandBus change (the only one)

`CommandBusDeps` gains one optional member:

```ts
/** Undo-history tap: reports every LOCAL command after the write. */
onLocalCommand?: (path: Path, value: unknown, priorValue: unknown,
                  gestureEnd: boolean) => void;
```

`dispatchLocal` calls it after `applySet`/`emit`/`enqueue`.
`applyRemote`, `applyRollback` do NOT call it (remote edits and nack
rollbacks never enter the history). `loadProject` triggers
`history.clear()` (wired in AppRuntime, not inside the bus).

### Wiring (AppRuntime)

AppRuntime owns the lifecycle, mirroring KeyboardService:

1. Create the history with `getLiveValue` = `getDeep(project, path)`
   and `dispatch` routing to `bus.dispatchLocal` (with
   `gestureEnd: gestureEndForLeaf(leaf)`).
2. Pass `onLocalCommand: history.record` into `createCommandBus`.
   (Creation-order note: if the bus must exist before the history, pass
   a closure `(...args) => history?.record(...args)`.)
3. Wrap every `bus.loadProject` path so it also calls
   `history.clear()` — or wrap loadProject in AppRuntime once.

## Recording rules (inside `record`)

- **Re-entrancy guard:** while `undo()`/`redo()` is dispatching
  restores, `record` no-ops (`applying` flag). Undo never records
  itself.
- **Burst rule:** ops arriving in the same synchronous task accumulate
  into one OPEN entry, sealed by a microtask
  (`queueMicrotask(seal)` scheduled when the entry opens). One paste /
  clear / move / preset = one entry. Same leaf hit twice in one burst:
  keep earliest `before`, latest `after`.
- **Drag rule:** after sealing, a single-leaf entry on a continuous
  leaf (`gestureEnd === false`, per the existing
  `sync/dispatchPolicy.ts` set) MERGES into the previous entry if that
  previous entry consists of exactly the same single path AND is still
  open for merge — earliest `before` kept, `after` updated. Knob drags
  and BPM click-runs collapse into one entry. Discrete leaves (note,
  muted, engineType, …) never merge.
- **Gesture boundary:** an entry closes for merging when
  `endGesture(path)` fires (new `history.endGesture(path)` tap called
  from synthContext's existing `endGesture`, i.e. knob mouseup), when
  any other entry is recorded, or on `undo`/`redo`/`clear`. Two
  separate drags of the same knob are therefore two undo steps.
- **Redo invalidation:** every genuinely recorded entry (not merged
  continuation ops of the same drag — those count as the same entry)
  clears the redo stack. Simplest correct rule: clear redoStack on
  every `record` that isn't re-entrant; a drag merge still means the
  user edited, so clearing is correct there too.
- **No-op filter:** a leaf with `before === after` is not recorded; an
  entry that seals with zero leaves is discarded.

## Undo semantics (skip-if-superseded)

`undo()` pops an entry, walks leaves in REVERSE order:

- If `getLiveValue(path) === leaf.after` — the edit is still mine on
  top — dispatch `before` (ordinary local op: syncs, rolls back on
  nack, drives audio). Collect the leaf (inverted) into a redo entry.
- Else SKIP the leaf: a collaborator's edit, a nack rollback, or a
  reconcile superseded it. Writing `before` would destroy someone
  else's newer edit.

If every leaf was skipped (fully stale entry), continue popping older
entries until one applies at least one leaf or the stack is empty — a
cmd+Z press always does something when anything undoable remains.
Applied leaves (only those) form the redo entry pushed to `redoStack`.

`redo()` is the mirror image: walk leaves forward, compare live
`=== before`, dispatch `after`, push the applied leaves back onto
`undoStack` — without clearing `redoStack` (only fresh edits clear
redo). The depth cap applies to `undoStack`; `redoStack` is bounded by
it naturally.

Worked multi-user example (from the design conversation): value 0 →
I set A (entry: before 0, after A) → collaborator sets B. My cmd+Z
sees live B ≠ A → skips. Neither 0 nor A is written; B stands. From
the collaborator's perspective their edit is never mysteriously
reverted by someone else's undo.

## Keyboard commands

Two new GLOBAL-context commands (the tracker>global priority and the
existing guards apply unchanged):

| id            | binding                    | isEnabled   |
|---------------|----------------------------|-------------|
| `global.undo` | `mod+z`                    | `canUndo()` |
| `global.redo` | `shift+mod+z`, `mod+y`     | `canRedo()` |

Registered from AppRuntime (where the history lives), not from
trackerCommands. The editable guard means focus in an input/textarea
keeps the browser's native text undo; modal stand-down applies as
usual. `allowRepeat: true` on both (holding cmd+Z steps back).

## Lifecycle

- `bus.loadProject` (New, Open, snapshot replace, room switch) →
  `history.clear()` — history never spans projects.
- Nothing else clears it: nack rollbacks, reconciles and remote edits
  self-heal via the staleness check.
- Not recorded by design: selection/cursor state, track focus, session
  rename (REST call, not an op), presence.

## Blast radius

- `packages/client/src/sync/CommandBus.ts` — one optional dep + one
  call line.
- `packages/client/src/app/undoHistory.ts` — new, + test file.
- `packages/client/src/app/AppRuntime.ts` — wiring (history creation,
  tap, clear-on-load, command registration).
- `packages/client/src/keyboard/bindings.ts` — two rows.
- `packages/client/src/app/synthContext.ts` — one line: `endGesture`
  also notifies `history.endGesture(path)`.
- **Zero shared / server changes.** Wire format untouched (restores
  are ordinary set ops).

## Testing

Unit (`undoHistory.test.ts`):
- burst batching (N leaves in one task → one entry)
- drag merge (same continuous path across tasks → one entry; discrete
  leaf does not merge; different path does not merge; after
  `endGesture` a new drag of the same path is a NEW entry)
- skip-if-superseded per leaf (partial entry restore)
- fully-stale entry → pops through to older entry
- redo mirror + redo cleared on fresh edit
- depth cap eviction
- re-entrancy (undo's own dispatches not recorded)
- no-op filter, clear()

Integration: KeyboardService binding/hygiene tests pick up the two new
ids automatically; AppRuntime test covers clear-on-loadProject.

Browser verification (dev:obs, throwaway session, Playwright MCP,
close browser after):
- knob drag → ONE cmd+Z restores pre-drag value
- paste 3+ steps → cmd+Z restores all, shift+cmd+Z re-applies
- M / note edits step back one press per undo
- two tabs: undo in tab A visible in tab B; tab B overwrites a value
  tab A edited → tab A's cmd+Z skips it (B's value stands)
- Open project → history cleared (cmd+Z inert)
- input focus: cmd+Z in the track-name editor does native text undo
- clean console (known favicon 404 / local presets 500 tolerated)
