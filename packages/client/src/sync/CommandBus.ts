// CommandBus — the single write funnel for the unidirectional command model.
//
// Every state change flows through here. A LOCAL command (`dispatchLocal`) writes
// state AND enqueues an outbound op; an applied REMOTE op (`applyRemote`) writes
// state only (no echo). Because the origin is explicit (which method was called),
// there is no `applyingFromNetwork` suppression flag: with no outbound watcher
// left to echo a programmatic write, none is needed.
//
// Long-lived: created once by the app root (useSynth, until Task 4's AppRuntime),
// not per-connection. `resetWatermark()` is called per connect (a fresh room
// starts with an empty watermark) instead of the bus itself being rebuilt. Every
// write also emits on the applied-command stream (`subscribe`) — consumed by
// AudioEngine in place of the old flush:'sync' watchers.
//
// `applySet` is an inline `setDeep` on the canonical `project` (mirroring
// Outbox.applyLocal); folding it onto ProjectStore.applySet is a later phase.

import { pathKey, type Path, type Project, type SetOpBroadcast } from '@fiddle/shared';
import type { AppliedCommand, AppliedCommandListener } from '../project/appliedCommand';

export interface CommandBusDeps {
  /** Write `value` at `path` into canonical project state (ProjectStore.applySet). */
  applySet: (path: Path, value: unknown) => void;
  /** Replace the whole project in place (snapshot / Open / New / room reset). */
  loadProject: (next: Project) => void;
  /** Hand an outbound op to the Outbox (throttle/coalesce/nack). Gated on the room being live by the provider. */
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
  // Private to this bus instance — resetWatermark() is called per connect (see
  // SyncSession.buildConnection), so a new room starts with an empty watermark.
  const lastAppliedOpIdForPath = new Map<string, number>();

  // Applied-command stream: emitted synchronously AFTER each state write and
  // BEFORE the outbound enqueue — the same ordering the flush:'sync' audio
  // watchers had. Subscribers must never dispatch (no re-entrant writes).
  const listeners = new Set<AppliedCommandListener>();
  function emit(cmd: AppliedCommand): void {
    for (const l of listeners) l(cmd);
  }
  function subscribe(l: AppliedCommandListener): () => void {
    listeners.add(l);
    return () => { listeners.delete(l); };
  }

  function dispatchLocal(cmd: LocalCommand): void {
    deps.applySet(cmd.path, cmd.value);
    emit({ kind: 'set', path: cmd.path, value: cmd.value });
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
      // let the throw break the whole inbound frame. The watermark stays
      // advanced, so the bad op won't be retried by a replay.
      console.warn('applyRemote: dropped op with unresolvable path', op.path, err);
      return false;
    }
    emit({ kind: 'set', path: op.path, value: op.value });
    return true;
  }

  // State-only write + emit: nack rollback and reassert-pending restores.
  // No enqueue (never re-sends), no watermark (not a broadcast op).
  function applyRollback(path: Path, value: unknown): void {
    deps.applySet(path, value);
    emit({ kind: 'set', path, value });
  }

  // Wholesale replace + one replace event (subscribers re-derive from state).
  function loadProject(next: Project): void {
    deps.loadProject(next);
    emit({ kind: 'replace' });
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

  return { dispatchLocal, applyRemote, applyRollback, loadProject, subscribe, advanceWatermark, resetWatermark };
}

export type CommandBus = ReturnType<typeof createCommandBus>;
