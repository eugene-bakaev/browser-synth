// applyOp — the inbound counterpart to the Outbox.
//
// When a broadcast `set` op arrives from the server it has to be written into
// the same Vue reactive `project` the local UI edits. That write trips the
// per-slice watcher in useSynth.ts, which would normally hand the change to
// the Outbox and echo it straight back out — an infinite round trip. The
// module-scope `applyingFromNetwork` flag is the suppression switch: it is true
// for the duration of the write, and the watcher checks `isApplyingFromNetwork`
// before enqueuing, so remote ops land silently.
//
// Broadcasts can arrive out of order (reconnect replay, server fan-out racing
// a fresh edit), so we also keep `lastAppliedOpIdForPath`: a stale echo of an
// older op for a path we've already advanced past is dropped rather than
// allowed to clobber the newer value.

import type { Project, SetOpBroadcast } from '@fiddle/shared';
import { setDeep, pathKey } from '@fiddle/shared';

// Module-scope flag: set true while a programmatic (network-origin) write runs;
// the sync-participating watchers in useSynth.ts check this and skip calling
// Outbox.enqueue so an applied remote op doesn't echo straight back out.
//
// This only works because those watchers run with `flush: 'sync'` — they fire
// synchronously inside the suppressed write, while the flag is still held.
// `enterSuppress`/`exitSuppress` are exported so the Outbox rollback and the
// snapshot-replace path (which also mutate `project` programmatically) can wrap
// their writes in the same suppression without going through `applyOp`.
let applyingFromNetwork = false;
export function isApplyingFromNetwork(): boolean { return applyingFromNetwork; }
export function enterSuppress(): void { applyingFromNetwork = true; }
export function exitSuppress(): void { applyingFromNetwork = false; }

// Track the most recent opId applied to each path so a late echo of an
// older op cannot overwrite a newer one.
const lastAppliedOpIdForPath = new Map<string, number>();

export function applyOp(project: Project, op: SetOpBroadcast): boolean {
  const key = pathKey(op.path);
  const prev = lastAppliedOpIdForPath.get(key) ?? -1;
  if (op.opId <= prev) return false;  // stale; ignore
  lastAppliedOpIdForPath.set(key, op.opId);

  enterSuppress();
  try {
    setDeep(project as unknown as Record<string, unknown>, op.path, op.value);
  } catch (err) {
    // A malformed / out-of-range path should never reach us — the server
    // bounds-checks (accept-list indicesInRange) before broadcasting. But if
    // one ever does, drop it here rather than let the throw escape and break
    // the whole inbound message handler for this frame.
    console.warn('applyOp: dropped op with unresolvable path', op.path, err);
    return false;
  } finally {
    exitSuppress();
  }
  return true;
}

export function resetApplyOpState(): void {
  // For tests + reconnect.
  lastAppliedOpIdForPath.clear();
}
