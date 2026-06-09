// Outbox — the outbound layer between the Vue watcher and the WebSocket.
//
// A slider drag fires dozens of local mutations per second; we don't want to
// flood the wire (or the server's op log) with every intermediate value. The
// Outbox sits in front of `WsClient.send` and applies four behaviours:
//
//   - Throttle per path (50ms): while live, rapid edits to the same path
//     collapse into one send carrying the latest value.
//   - Immediate flush on gesture end (mouseup / blur): the watcher signals the
//     interaction is over so the final value goes out without waiting for the
//     throttle window.
//   - Coalesce-by-path while offline: disconnected edits are queued (last value
//     wins per path) and flushed in one burst when the socket goes live.
//   - priorValue + rollback: every entry remembers the value it replaced so an
//     `onNack` can restore local state to what it was before the rejected op.
//
// The Outbox never inspects the socket itself — `OutboxDeps` injects whether
// we're live, how to send, how to mint a clientSeq, and how to apply a local
// rollback (which must run with the watcher's applyingFromNetwork suppression).

import type { Path, SetOpClient } from '@fiddle/shared';
import { pathKey } from '@fiddle/shared';

interface PendingEntry {
  path: Path;
  value: unknown;
  priorValue: unknown;
  clientSeq: number | null;     // assigned at send time
  timer: ReturnType<typeof setTimeout> | null;
  // For rollback bookkeeping after send:
  sent: boolean;
  resends: number;
  ackTimer: ReturnType<typeof setTimeout> | null;
}

const THROTTLE_MS = 50;
const ACK_TIMEOUT_MS = 4000;
const MAX_RESENDS = 3;

export interface OutboxDeps {
  /** Returns next clientSeq from WsClient/sessionStorage. */
  nextClientSeq: () => number;
  /** Send op now. Caller decides if connection is live; Outbox just hands it off. */
  send: (op: SetOpClient) => void;
  /** Apply `value` to local `project` along `path`, with applyingFromNetwork suppression. */
  applyLocal: (path: Path, value: unknown) => void;
  /** Returns true if the WS is in 'live' state (and we should actually send). */
  isLive: () => boolean;
}

export class Outbox {
  private pending = new Map<string, PendingEntry>();           // throttle / live pending
  private inFlight = new Map<number, PendingEntry>();          // sent, awaiting echo or nack
  private offlineQueue = new Map<string, PendingEntry>();      // disconnected; coalesced by path

  constructor(private readonly deps: OutboxDeps) {}

  /**
   * Called by the watcher when a local change happens.
   * gestureEnd=true forces immediate emission (mouseup, blur, etc.)
   */
  enqueue(path: Path, value: unknown, priorValue: unknown, gestureEnd: boolean): void {
    const key = pathKey(path);

    // If offline, coalesce by path; do not start timers.
    if (!this.deps.isLive()) {
      const existing = this.offlineQueue.get(key);
      this.offlineQueue.set(key, {
        path, value,
        priorValue: existing?.priorValue ?? priorValue,
        clientSeq: null, timer: null, sent: false,
        resends: 0, ackTimer: null,
      });
      return;
    }

    // Live: cancel any existing timer for this path; merge priorValue.
    const existing = this.pending.get(key);
    if (existing?.timer) clearTimeout(existing.timer);

    const entry: PendingEntry = {
      path, value,
      priorValue: existing?.priorValue ?? priorValue,
      clientSeq: null, timer: null, sent: false,
      resends: 0, ackTimer: null,
    };

    if (gestureEnd) {
      this.flushEntry(key, entry);
    } else {
      entry.timer = setTimeout(() => {
        this.flushEntry(key, this.pending.get(key) ?? entry);
      }, THROTTLE_MS);
      this.pending.set(key, entry);
    }
  }

  /** Flush every throttled pending entry immediately (gesture-end semantics).
   *  Called on leave / tab-close so a closing socket still delivers the last
   *  edits. flushEntry routes to the offline queue if the socket is already
   *  closed, so this never throws. */
  flushAllPending(): void {
    for (const [key, entry] of [...this.pending]) {
      if (entry.timer) clearTimeout(entry.timer);
      this.flushEntry(key, entry);
    }
  }

  /**
   * Flush the pending throttled entry for `path` immediately (gesture end —
   * e.g. knob mouseup). The final drag value is already sitting in `pending`
   * with its throttle timer running; this sends it now instead of waiting out
   * the window. No-op if nothing is pending for the path (e.g. a click with no
   * change, or already flushed). Offline routing is handled by flushEntry.
   */
  flushPath(path: Path): void {
    const key = pathKey(path);
    const entry = this.pending.get(key);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    this.flushEntry(key, entry);
  }

  /** Server confirmed our op (echo, including a duplicate echo). Drop tracking. */
  onEcho(clientSeq: number): void {
    const entry = this.inFlight.get(clientSeq);
    if (entry?.ackTimer) clearTimeout(entry.ackTimer);
    this.inFlight.delete(clientSeq);
  }

  /** Server rejected our op (validation / rate limit). Roll back local state. */
  onNack(clientSeq: number, _code: string): void {
    const entry = this.inFlight.get(clientSeq);
    if (!entry) return; // unknown clientSeq (e.g. server restarted); ignore
    if (entry.ackTimer) clearTimeout(entry.ackTimer);
    this.inFlight.delete(clientSeq);
    this.deps.applyLocal(entry.path, entry.priorValue);
  }

  /** Called when the WS flips from {opening|catching-up} to live. Flushes offline queue. */
  onLive(): void {
    for (const entry of this.offlineQueue.values()) {
      this.flushEntry(JSON.stringify(entry.path), entry);
    }
    this.offlineQueue.clear();
  }

  // Re-apply every un-acked local edit on top of a just-replaced project (server
  // snapshot) and re-route it for delivery. Used by the reconcile-merge so a
  // snapshot can never erase a pending change. Works whether the snapshot arrived
  // via reconnect (offline → entries re-queue) or mid-session (live → resend).
  // Coalesces all tiers by path, newest wins (offlineQueue < inFlight < pending).
  // For a shared path the newest VALUE wins but the EARLIEST priorValue is kept
  // (the true pre-edit baseline) so a later nack rolls back correctly — same rule
  // as onClosed.
  reassertPending(): void {
    const merged = new Map<string, PendingEntry>();
    const absorb = (entries: Iterable<PendingEntry>) => {
      for (const e of entries) {
        if (e.timer) clearTimeout(e.timer);
        if (e.ackTimer) clearTimeout(e.ackTimer);
        const key = pathKey(e.path);
        const prev = merged.get(key);
        merged.set(key, { ...e, priorValue: prev?.priorValue ?? e.priorValue });
      }
    };
    absorb(this.offlineQueue.values());
    absorb(this.inFlight.values());
    absorb(this.pending.values());
    this.offlineQueue.clear();
    this.inFlight.clear();
    this.pending.clear();

    for (const [key, e] of merged) {
      this.deps.applyLocal(e.path, e.value); // restore the edit on top of the snapshot
      this.flushEntry(key, {
        path: e.path, value: e.value, priorValue: e.priorValue,
        clientSeq: null, timer: null, sent: false, resends: 0, ackTimer: null,
      });
    }
  }

  /** WS live → closed. Move pending AND in-flight into the offline queue so a
   *  disconnect can't strand an op that was sent but never echoed. Coalesced by
   *  path; pending (newer) wins over in-flight (older); the earliest priorValue
   *  is preserved for rollback. */
  onClosed(): void {
    const requeue = (entry: PendingEntry) => {
      if (entry.timer) clearTimeout(entry.timer);
      if (entry.ackTimer) clearTimeout(entry.ackTimer);
      const key = pathKey(entry.path);
      const existing = this.offlineQueue.get(key);
      this.offlineQueue.set(key, {
        path: entry.path,
        value: entry.value,
        priorValue: existing?.priorValue ?? entry.priorValue,
        clientSeq: null, timer: null, sent: false, resends: 0, ackTimer: null,
      });
    };
    for (const entry of this.inFlight.values()) requeue(entry);
    this.inFlight.clear();
    for (const entry of this.pending.values()) requeue(entry);
    this.pending.clear();
  }

  private flushEntry(key: string, entry: PendingEntry): void {
    this.pending.delete(key);
    if (!this.deps.isLive()) {
      this.offlineQueue.set(key, { ...entry, timer: null, ackTimer: null });
      return;
    }
    const clientSeq = this.deps.nextClientSeq();
    entry.clientSeq = clientSeq;
    entry.sent = true;
    entry.resends = 0;
    this.inFlight.set(clientSeq, entry);
    const op: SetOpClient = {
      v: 1, type: 'set', clientSeq,
      path: entry.path, value: entry.value,
    };
    this.deps.send(op);
    entry.ackTimer = setTimeout(() => this.onAckTimeout(clientSeq), ACK_TIMEOUT_MS);
  }

  // Resend an op that was never echoed/nacked within ACK_TIMEOUT_MS. Same
  // clientSeq so the server's (clientId, clientSeq) dedupe recognises it and
  // echoes rather than re-applying. Caps at MAX_RESENDS; after that the entry
  // stays tracked (a later echo still resolves it; a disconnect requeues it).
  private onAckTimeout(clientSeq: number): void {
    const entry = this.inFlight.get(clientSeq);
    if (!entry) return;            // already echoed / nacked
    entry.ackTimer = null;
    if (!this.deps.isLive()) return;          // offline: onClosed will requeue it
    if (entry.resends >= MAX_RESENDS) return; // give up resending; keep tracked
    entry.resends += 1;
    const op: SetOpClient = {
      v: 1, type: 'set', clientSeq,
      path: entry.path, value: entry.value,
    };
    this.deps.send(op);
    entry.ackTimer = setTimeout(() => this.onAckTimeout(clientSeq), ACK_TIMEOUT_MS);
  }
}
