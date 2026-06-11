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
  | { ok: false; reason: 'duplicate'; op: AppliedOp };

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

  // Identity bookkeeping. Identities persist (beyond a socket's lifetime) so a
  // reconnecting client can resume the same color/handle within the grace window.
  setIdentity(roomId: string, identity: Identity): Promise<void>;
  getIdentity(roomId: string, clientId: string): Promise<Identity | undefined>;
  listIdentities(roomId: string): Promise<Identity[]>;
  removeIdentity(roomId: string, clientId: string): Promise<void>;

  // Live presence: which clients have a socket connected right now. The roster
  // is derived from this (not the broader identity registry) so a client that
  // disconnects and doesn't come back stops appearing as a phantom member.
  markConnected(roomId: string, clientId: string): Promise<void>;
  markDisconnected(roomId: string, clientId: string): Promise<void>;
  // Identities of currently-connected clients, in join order.
  listConnected(roomId: string): Promise<Identity[]>;

  // Lifecycle: empty rooms enter a grace window before being pruned so brief
  // disconnects don't wipe state. onExpire may be async (flush → row prune →
  // pruneRoom); the store tracks the in-flight chain.
  startGrace(roomId: string, onExpire: () => void | Promise<void>): Promise<void>;
  // Settles the room's grace state: clears a pending timer, and if the timer
  // already fired, waits for the in-flight expiry chain to finish — so a caller
  // never observes a room that is mid-teardown (M3a). No-op for unknown rooms
  // (hello calls this before it knows whether the room is live).
  cancelGrace(roomId: string): Promise<void>;
  pruneRoom(roomId: string): Promise<void>;

  // Reads a room's current project WITHOUT creating it (null if absent). Used by
  // the autosave flusher, which must never resurrect a pruned room.
  peekProject(roomId: string): Promise<Project | null>;

  // Room ids with unsaved edits since their last flush.
  listDirtyRoomIds(): Promise<string[]>;

  // Monotonic version of a room's project (bumped per op); null if absent. Read
  // before a flush and passed back to clearDirty to detect mid-flush writes.
  roomVersion(roomId: string): Promise<number | null>;

  // Clears a room's dirty flag after a successful snapshot save. When `ifVersion`
  // is given, clears ONLY if the room's version is unchanged since it was read —
  // so an op applied mid-flush keeps the room dirty for the next sweep.
  clearDirty(roomId: string, ifVersion?: number): Promise<void>;

  // Live member count per existing room (size of the connected set). Drives the
  // lobby's member-count / "live" column and the guest "listed only while
  // occupied" rule.
  roomMemberCounts(): Promise<Map<string, number>>;
}
