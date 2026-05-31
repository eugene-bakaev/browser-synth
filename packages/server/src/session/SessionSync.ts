import type { RoomStore } from '../room/RoomStore.js';
import type { SessionStore } from './SessionStore.js';
import type { Log } from '../sync/ConnectionHandler.js';

export const FLUSH_INTERVAL_MS = 60_000;

// Couples the live in-memory RoomStore to the durable SessionStore. Owns the
// project-persistence side effects the spec calls for:
//   - flushRoom / flushAllDirty: write the in-memory project to SessionStore.
//   - a periodic sweep (start/stop) that flushes rooms with unsaved edits.
//   - handleDisconnect: a flush on every disconnect (a network-blip / crash
//     boundary) plus a guest-session prune when the room empties (guest rooms are
//     unreachable once empty, so we drop the row to keep the lobby/tables clean).
//   - the Fastify onClose hook calls flushAllDirty on graceful shutdown (SIGTERM).
//
// saveSnapshot is a no-op when the session row is absent (see SessionStore), so
// flushing an auto-minted room that has no session row is harmless.
export class SessionSync {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly rooms: RoomStore,
    private readonly sessions: SessionStore,
    private readonly log: Log = () => {},
  ) {}

  // Persist one room's current project. Clears the dirty flag on success; on
  // failure the flag is left set so the next sweep retries.
  async flushRoom(roomId: string): Promise<void> {
    const project = await this.rooms.peekProject(roomId);
    if (!project) return; // room gone (pruned) — nothing to persist
    try {
      await this.sessions.saveSnapshot(roomId, project);
      await this.rooms.clearDirty(roomId);
    } catch (err) {
      this.log('session flush failed', { roomId, err: String(err) });
    }
  }

  // Flush every room with unsaved edits. Used by the periodic sweep and the
  // graceful-shutdown hook.
  async flushAllDirty(): Promise<void> {
    const ids = await this.rooms.listDirtyRoomIds();
    for (const id of ids) {
      await this.flushRoom(id);
    }
  }

  // Called by the ws route after a socket closes. Always flush (disconnect is a
  // good persistence boundary); when the room is now empty, also prune a
  // guest-owned session (it is unreachable from here on).
  async handleDisconnect(roomId: string, roomNowEmpty: boolean): Promise<void> {
    await this.flushRoom(roomId);
    if (!roomNowEmpty) return;
    const record = await this.sessions.get(roomId);
    if (record && record.ownerUserId === null) {
      await this.sessions.delete(roomId); // cascades the snapshot
      this.log('guest session pruned on empty', { roomId });
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flushAllDirty();
    }, FLUSH_INTERVAL_MS);
    // Don't keep the event loop alive solely for the sweep (matters for clean
    // shutdown and for any test that builds a server without closing it).
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
