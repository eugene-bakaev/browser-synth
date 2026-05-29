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

import type { Path, Project, SetOpBroadcast } from '@fiddle/shared';

// Module-scope flag: set true while applyOp runs; the per-slice watcher
// in useSynth.ts checks this and skips calling Outbox.enqueue.
let applyingFromNetwork = false;
export function isApplyingFromNetwork(): boolean { return applyingFromNetwork; }

// Track the most recent opId applied to each path so a late echo of an
// older op cannot overwrite a newer one.
const lastAppliedOpIdForPath = new Map<string, number>();

export function applyOp(project: Project, op: SetOpBroadcast): boolean {
  const key = JSON.stringify(op.path);
  const prev = lastAppliedOpIdForPath.get(key) ?? -1;
  if (op.opId <= prev) return false;  // stale; ignore
  lastAppliedOpIdForPath.set(key, op.opId);

  applyingFromNetwork = true;
  try {
    setDeep(project as unknown as Record<string, unknown>, op.path, op.value);
  } finally {
    applyingFromNetwork = false;
  }
  return true;
}

export function resetApplyOpState(): void {
  // For tests + reconnect.
  lastAppliedOpIdForPath.clear();
}

function setDeep(obj: Record<string, unknown>, path: Path, value: unknown): void {
  if (path.length === 0) return;
  let cursor: any = obj;
  for (let i = 0; i < path.length - 1; i++) {
    cursor = cursor[path[i]];
    if (cursor == null) throw new Error(`applyOp: path break at segment ${i} (${String(path[i])})`);
  }
  cursor[path[path.length - 1]] = value;
}
