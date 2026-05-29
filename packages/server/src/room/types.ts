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
  // When the last connection drops the room enters a grace window before GC.
  // Cleared when a new client joins; fires `pruneRoom` on expiry.
  graceTimer: NodeJS.Timeout | null;
}
