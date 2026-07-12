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
