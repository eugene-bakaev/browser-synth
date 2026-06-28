// CommandBus — the single write funnel for the unidirectional command model.
//
// Every state change flows through here. A LOCAL command writes state AND
// enqueues an outbound op; an applied REMOTE op writes state only (no echo).
// Because the origin is explicit (which method was called), there is no need
// for the legacy `applyingFromNetwork` suppression flag — that disappears in
// Phase 2b when the outbound watchers it guarded are deleted.
//
// Phase 2b-i: the INBOUND path is now live through `applyRemote` (the legacy
// `applyOp` is deleted). `applySet` is still an inline `setDeep` on the canonical
// `project` (mirroring Outbox.applyLocal); folding it onto ProjectStore.applySet
// and routing local edits through `dispatchLocal` is Phase 2b-ii/iii — until then
// `dispatchLocal` stays dormant (constructed but not called live).

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
  // Private to this bus instance — created fresh per connection in
  // buildSyncState, so a new room starts with an empty watermark (this replaced
  // the former module-scope watermark in applyOp.ts).
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

  return { dispatchLocal, applyRemote, advanceWatermark, resetWatermark };
}

export type CommandBus = ReturnType<typeof createCommandBus>;
