import { normalizeProject } from '@fiddle/shared';
import type { RoomStore } from '../room/RoomStore.js';
import type { SessionStore } from './SessionStore.js';
import type { Log } from '../sync/ConnectionHandler.js';

export const FLUSH_INTERVAL_MS = 60_000;

// Stale-guest-session sweep cadence: every Nth flush tick (hourly at the 60s
// flush interval). Guest sessions normally self-destruct at grace expiry, but
// two paths escape that event entirely: a session that is created and never
// joined, and a room lost to a server restart mid-session. Without a sweep
// those rows (plus their ~hundreds-of-KB snapshots) accumulate forever.
export const PRUNE_SWEEP_EVERY_TICKS = 60;
// How long an unowned session may sit idle (no live room, no metadata update)
// before the sweep deletes it. A week is deliberately generous — guests lose
// their session 5 minutes after abandoning it anyway; this only mops up rows
// whose end-of-life event never fired.
export const STALE_GUEST_SESSION_MS = 7 * 24 * 60 * 60 * 1000;

// Couples the live in-memory RoomStore to the durable SessionStore. Owns the
// project-persistence side effects the spec calls for:
//   - flushRoom / flushAllDirty: write the in-memory project to SessionStore.
//   - a periodic sweep (start/stop) that flushes rooms with unsaved edits.
//   - handleDisconnect: a flush on every disconnect (a network-blip / crash
//     boundary). Deliberately non-destructive — the in-memory room survives the
//     grace window so a reconnect can resume it, and the session row must
//     survive with it (deleting it here made every post-rejoin flush a silent
//     no-op; see CODE_REVIEW_2026-06-09 M1).
//   - handleGraceExpiry: the room's true end of life (grace timer fired with no
//     reconnect). Final flush, then prune a guest-owned session row (now truly
//     unreachable), then drop the in-memory room.
//   - pruneStaleGuestSessions: a low-cadence sweep for guest rows whose
//     grace-expiry event never fired (created-but-never-joined, or the room was
//     lost to a restart). See PRUNE_SWEEP_EVERY_TICKS / STALE_GUEST_SESSION_MS.
//   - the Fastify onClose hook calls flushAllDirty on graceful shutdown (SIGTERM).
//
// saveSnapshot is a no-op when the session row is absent (see SessionStore), so
// flushing an auto-minted room that has no session row is harmless.
export class SessionSync {
  private timer: NodeJS.Timeout | null = null;
  private isFlushing = false;

  constructor(
    private readonly rooms: RoomStore,
    private readonly sessions: SessionStore,
    private readonly log: Log = () => {},
  ) {}

  // Persist one room's current project. Clears the dirty flag on success; on
  // failure the flag is left set so the next sweep retries.
  //
  // The peekProject → saveSnapshot → clearDirty sequence is protected against
  // the lost-update window by a version-gated clearDirty: the version is
  // captured right after peek and passed to clearDirty, which clears the flag
  // only if no op has landed since. An op applied mid-flush advances the version,
  // so clearDirty no-ops and the room stays dirty for the next sweep.
  async flushRoom(roomId: string): Promise<void> {
    const project = await this.rooms.peekProject(roomId);
    if (!project) return; // room gone (pruned) — nothing to persist
    // Capture the version at read time; clearDirty below only clears if no op
    // has landed since, so a write racing the async save isn't lost (it stays
    // dirty and the next sweep retries).
    const version = await this.rooms.roomVersion(roomId);
    try {
      // Repair invariants at the persistence boundary: the server is the only
      // writer, so normalizing here guarantees a malformed in-memory project
      // (e.g. driven to 0 enabled tracks by a stream of leaf ops) can never
      // reach the DB. Idempotent — a well-formed project is unchanged.
      await this.sessions.saveSnapshot(roomId, normalizeProject(project));
      await this.rooms.clearDirty(roomId, version ?? undefined);
    } catch (err) {
      this.log('session flush failed', { roomId, err });
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
  // good persistence boundary). Nothing is deleted here: an empty room is still
  // reachable for the whole grace window, so destruction waits for
  // handleGraceExpiry.
  async handleDisconnect(roomId: string): Promise<void> {
    await this.flushRoom(roomId);
  }

  // Called when the grace timer fires: no one reconnected, so the room is now
  // truly unreachable. Ordering matters — flush while the in-memory room still
  // exists (last chance for edits whose disconnect flush failed), then prune
  // the guest session row (a guest has no way back to it; cascades the
  // snapshot), then drop the in-memory room.
  async handleGraceExpiry(roomId: string): Promise<void> {
    await this.flushRoom(roomId);
    const record = await this.sessions.get(roomId);
    if (record && record.ownerUserId === null) {
      await this.sessions.delete(roomId); // cascades the snapshot
      this.log('guest session pruned after grace', { roomId });
    }
    await this.rooms.pruneRoom(roomId);
  }

  // Deletes guest sessions that escaped their grace-expiry end-of-life:
  // unowned, idle past STALE_GUEST_SESSION_MS, and with no live room (a live
  // or in-grace room means someone may still come back — never touch it).
  // updatedAt tracks metadata activity only (autosaves bump the snapshot row,
  // not the session row), so the live-room check is what protects sessions
  // that are actively edited but never renamed.
  async pruneStaleGuestSessions(now: number = Date.now()): Promise<void> {
    const records = await this.sessions.list();
    for (const record of records) {
      if (record.ownerUserId !== null) continue; // owned rows are the owner's to delete
      if (now - record.updatedAt.getTime() < STALE_GUEST_SESSION_MS) continue;
      if ((await this.rooms.peekProject(record.id)) !== null) continue;
      try {
        await this.sessions.delete(record.id); // cascades the snapshot
        this.log('stale guest session pruned', { roomId: record.id });
      } catch (err) {
        this.log('stale guest session prune failed', { roomId: record.id, err });
      }
    }
  }

  // Timer wrapper around flushAllDirty: skips the tick if a sweep is still in
  // progress (a slow sweep must not overlap the next interval) and always
  // resets the guard via finally. flushAllDirty stays directly callable (the
  // onClose shutdown hook calls it) — the guard lives here, not in the sweep.
  private async runSweep(): Promise<void> {
    if (this.isFlushing) return;
    this.isFlushing = true;
    try {
      await this.flushAllDirty();
    } finally {
      this.isFlushing = false;
    }
  }

  start(): void {
    if (this.timer) return;
    let tick = 0;
    this.timer = setInterval(() => {
      this.runSweep().catch((err) => this.log('session flush sweep failed', { err }));
      tick += 1;
      if (tick % PRUNE_SWEEP_EVERY_TICKS === 0) {
        this.pruneStaleGuestSessions().catch((err) =>
          this.log('stale guest session sweep failed', { err }),
        );
      }
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
