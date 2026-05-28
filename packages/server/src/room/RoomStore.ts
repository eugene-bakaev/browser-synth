// RoomStore — the only legal surface for mutating per-room state.
//
// Phase 1 ships an in-process Map-backed implementation (see InMemoryRoomStore).
// All methods are async so a future Phase 2 swap to a Redis-backed store can
// drop in without touching the ConnectionHandler.
//
// Invariants:
//   - opIds are strictly increasing and contiguous within a room.
//   - The op log is bounded to RING_BUFFER_CAPACITY entries; if a client falls
//     behind further than that, getOpsSince returns null to signal "need
//     snapshot".
//   - Identity bookkeeping (color + handle assignment) is kept on the room so
//     reconnects can recover the same identity within the grace window.

import type { Project } from '@fiddle/shared';
import type { Identity, Path } from '@fiddle/shared';
import type { AppliedOp } from './types.js';

export const RING_BUFFER_CAPACITY = 1000;
export const GRACE_MS = 5 * 60 * 1000;

export interface AppendOpInput {
  clientId: string;
  clientSeq: number;
  path: Path;
  value: unknown;
}

export type AppendOpResult =
  | { ok: true; op: AppliedOp }
  | { ok: false; reason: 'duplicate' };

export interface RoomStore {
  // Returns the room's current project + the latest opId (0 for a fresh room).
  // Creates the room if it doesn't exist.
  getOrCreate(
    roomId: string,
    freshProject: () => Project,
  ): Promise<{ project: Project; opIdHead: number }>;

  // Dedups on (clientId, clientSeq). On success the project is mutated and the
  // op is appended to the log.
  appendOp(roomId: string, input: AppendOpInput): Promise<AppendOpResult>;

  // Returns ops with opId > fromOpId, or null if the requested range has been
  // evicted from the ring buffer (caller must send a snapshot instead).
  getOpsSince(roomId: string, fromOpId: number): Promise<AppliedOp[] | null>;

  // Identity bookkeeping.
  setIdentity(roomId: string, identity: Identity): Promise<void>;
  getIdentity(roomId: string, clientId: string): Promise<Identity | undefined>;
  listIdentities(roomId: string): Promise<Identity[]>;
  removeIdentity(roomId: string, clientId: string): Promise<void>;

  // Lifecycle: empty rooms enter a grace window before being pruned so brief
  // disconnects don't wipe state.
  startGrace(roomId: string, onExpire: () => void): Promise<void>;
  cancelGrace(roomId: string): Promise<void>;
  pruneRoom(roomId: string): Promise<void>;
}
