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
