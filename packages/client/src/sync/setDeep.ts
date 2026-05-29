// setDeep — write `value` at the leaf addressed by `path` in a nested object.
//
// Extracted from applyOp so both the inbound op-applier and the Outbox's
// rollback (`applyLocal`) share one implementation. It only writes an existing
// leaf — it never creates missing intermediate objects — because every path we
// accept is a known Project field; a break mid-path means the op is malformed
// (or aimed at a track/step index the project doesn't have) and we'd rather
// throw than silently graft a new branch onto the project.

import type { Path } from '@fiddle/shared';

export function setDeep(obj: Record<string, unknown>, path: Path, value: unknown): void {
  if (path.length === 0) return;
  let cursor: any = obj;
  for (let i = 0; i < path.length - 1; i++) {
    cursor = cursor[path[i]];
    if (cursor == null) throw new Error(`setDeep: path break at segment ${i} (${String(path[i])})`);
  }
  cursor[path[path.length - 1]] = value;
}
