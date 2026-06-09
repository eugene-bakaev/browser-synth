// Authoritative server-side room state types.
//
// Every accepted client op becomes an AppliedOp with a server-assigned `opId`
// (strictly increasing, room-local). The room holds the canonical Project plus
// a ring buffer of recent ops so reconnecting clients can replay forward
// without a full snapshot when possible.

import type { Project } from '@fiddle/shared';
import type { Identity, Path } from '@fiddle/shared';

export interface AppliedOp {
  opId: number;
  clientId: string;
  clientSeq: number;
  path: Path;
  value: unknown;
}

export interface RoomState {
  project: Project;
  opLog: AppliedOp[];
  // (clientId, clientSeq) → AppliedOp mirror of opLog, so the per-op duplicate
  // check (resend dedup) is O(1) instead of a scan over the ring buffer —
  // appendOp is the hottest server path. Entries are evicted in the same splice
  // that prunes opLog; the two structures always hold the same ops.
  opIndex: Map<string, AppliedOp>;
  nextOpId: number;
  identities: Map<string, Identity>;
  // clientIds with a live socket right now. The roster (presence) is built from
  // this set; `identities` is kept broader so a reconnecting client can resume
  // its identity even after its socket dropped. Cleared entry-by-entry on
  // disconnect; the whole room (identities included) is GC'd after grace.
  connected: Set<string>;
  // When the last connection drops the room enters a grace window before GC.
  // Cleared when a new client joins; fires `pruneRoom` on expiry.
  graceTimer: NodeJS.Timeout | null;
  // Set true by appendOp on every accepted op; cleared by the autosave flusher
  // after it persists the project. Lets the 60s sweep skip rooms with no edits.
  dirty: boolean;
  // Monotonic counter bumped by appendOp on every accepted op. Lets the autosave
  // flusher clear `dirty` conditionally — only if no op has landed since it read
  // the project — closing the peek→save→clearDirty lost-update window.
  version: number;
}
