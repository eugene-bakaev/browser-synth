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
}
