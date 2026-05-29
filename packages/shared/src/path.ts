// Wire-path helpers shared by client and server so the two stay byte-for-byte
// in agreement about how a `Path` is hashed and applied.

import type { Path } from './protocol/types.js';

// Canonical map key for a wire path. Centralized so every keyed structure
// (server dedup, client outbox throttle, presence touch map) hashes the same
// logical path to the same string — diverging key schemes would silently break
// dedup/coalesce.
export function pathKey(path: Path): string {
  return JSON.stringify(path);
}

// Apply a wire-path mutation to an existing leaf of a nested object. Only walks
// existing intermediates — it never creates branches — so a missing segment is
// a malformed/out-of-range path and throws. Callers that accept untrusted paths
// must guard first: the server bounds-checks via the accept-list before
// appending; the client wraps applyOp's call so a bad inbound path can't break
// the whole message handler.
export function setDeep(obj: Record<string, unknown>, path: Path, value: unknown): void {
  if (path.length === 0) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cursor: any = obj;
  for (let i = 0; i < path.length - 1; i++) {
    cursor = cursor[path[i]!];
    if (cursor == null) {
      throw new Error(`setDeep: path break at segment ${i} (${String(path[i])})`);
    }
  }
  cursor[path[path.length - 1]!] = value;
}
