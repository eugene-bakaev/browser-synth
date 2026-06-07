// In-process RoomStore implementation. Suitable for single-instance dev/prod;
// horizontal scaling will require a Redis-backed sibling that shares the same
// interface.

import type { Project } from '@fiddle/shared';
import type { Identity } from '@fiddle/shared';
import { setDeep } from '@fiddle/shared';
import type { AppliedOp, RoomState } from './types.js';
import {
  GRACE_MS,
  RING_BUFFER_CAPACITY,
  type AppendOpInput,
  type AppendOpResult,
  type RoomStore,
} from './RoomStore.js';

export class InMemoryRoomStore implements RoomStore {
  private readonly rooms = new Map<string, RoomState>();

  async getOrCreate(
    roomId: string,
    freshProject: () => Project,
  ): Promise<{ project: Project; opIdHead: number }> {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = {
        project: freshProject(),
        opLog: [],
        nextOpId: 1,
        identities: new Map(),
        connected: new Set(),
        graceTimer: null,
        dirty: false,
      };
      this.rooms.set(roomId, room);
    }
    return { project: room.project, opIdHead: room.nextOpId - 1 };
  }

  async appendOp(roomId: string, input: AppendOpInput): Promise<AppendOpResult> {
    const room = this.requireRoom(roomId);
    // Dedup on (clientId, clientSeq). Linear scan is fine while the log is
    // capped at RING_BUFFER_CAPACITY entries.
    for (const entry of room.opLog) {
      if (entry.clientId === input.clientId && entry.clientSeq === input.clientSeq) {
        return { ok: false, reason: 'duplicate', op: entry };
      }
    }

    const op: AppliedOp = {
      opId: room.nextOpId,
      clientId: input.clientId,
      clientSeq: input.clientSeq,
      path: input.path,
      value: input.value,
    };

    setDeep(room.project as unknown as Record<string, unknown>, op.path, op.value);

    room.opLog.push(op);
    if (room.opLog.length > RING_BUFFER_CAPACITY) {
      room.opLog.splice(0, room.opLog.length - RING_BUFFER_CAPACITY);
    }
    room.nextOpId += 1;
    room.dirty = true;

    return { ok: true, op };
  }

  async getOpsSince(
    roomId: string,
    fromOpId: number,
  ): Promise<AppliedOp[] | null> {
    const room = this.requireRoom(roomId);
    const head = room.nextOpId - 1;

    if (room.opLog.length === 0) {
      // No ops have ever been recorded, or the log is empty after pruning.
      return fromOpId === head ? [] : null;
    }

    const oldest = room.opLog[0]!;
    // If the next op the client needs (fromOpId + 1) was already evicted, the
    // caller has to fall back to a snapshot.
    if (fromOpId + 1 < oldest.opId) {
      return null;
    }

    return room.opLog.filter((op) => op.opId > fromOpId);
  }

  async setIdentity(roomId: string, identity: Identity): Promise<void> {
    const room = this.requireRoom(roomId);
    room.identities.set(identity.clientId, identity);
  }

  async getIdentity(
    roomId: string,
    clientId: string,
  ): Promise<Identity | undefined> {
    const room = this.requireRoom(roomId);
    return room.identities.get(clientId);
  }

  async listIdentities(roomId: string): Promise<Identity[]> {
    const room = this.requireRoom(roomId);
    return Array.from(room.identities.values());
  }

  async removeIdentity(roomId: string, clientId: string): Promise<void> {
    const room = this.requireRoom(roomId);
    room.identities.delete(clientId);
    room.connected.delete(clientId);
  }

  async markConnected(roomId: string, clientId: string): Promise<void> {
    const room = this.requireRoom(roomId);
    room.connected.add(clientId);
  }

  async markDisconnected(roomId: string, clientId: string): Promise<void> {
    const room = this.requireRoom(roomId);
    room.connected.delete(clientId);
  }

  async listConnected(roomId: string): Promise<Identity[]> {
    const room = this.requireRoom(roomId);
    // Preserve identities' insertion order; filter to connected clientIds.
    return Array.from(room.identities.values()).filter((id) =>
      room.connected.has(id.clientId),
    );
  }

  async startGrace(roomId: string, onExpire: () => void): Promise<void> {
    const room = this.requireRoom(roomId);
    if (room.graceTimer) {
      clearTimeout(room.graceTimer);
    }
    room.graceTimer = setTimeout(onExpire, GRACE_MS);
  }

  async cancelGrace(roomId: string): Promise<void> {
    const room = this.requireRoom(roomId);
    if (room.graceTimer) {
      clearTimeout(room.graceTimer);
      room.graceTimer = null;
    }
  }

  async pruneRoom(roomId: string): Promise<void> {
    const room = this.rooms.get(roomId);
    if (room?.graceTimer) {
      clearTimeout(room.graceTimer);
    }
    this.rooms.delete(roomId);
  }

  async peekProject(roomId: string): Promise<Project | null> {
    return this.rooms.get(roomId)?.project ?? null;
  }

  async listDirtyRoomIds(): Promise<string[]> {
    const ids: string[] = [];
    for (const [roomId, room] of this.rooms) {
      if (room.dirty) ids.push(roomId);
    }
    return ids;
  }

  async clearDirty(roomId: string): Promise<void> {
    const room = this.rooms.get(roomId);
    if (room) room.dirty = false;
  }

  async roomMemberCounts(): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const [roomId, room] of this.rooms) {
      counts.set(roomId, room.connected.size);
    }
    return counts;
  }

  private requireRoom(roomId: string): RoomState {
    const room = this.rooms.get(roomId);
    if (!room) {
      throw new Error(`Room ${roomId} not found`);
    }
    return room;
  }
}

