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

interface PendingEntry {
  path: Path;
  value: unknown;
  priorValue: unknown;
  clientSeq: number | null;     // assigned at send time
  timer: ReturnType<typeof setTimeout> | null;
  // For rollback bookkeeping after send:
  sent: boolean;
}

const THROTTLE_MS = 50;

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
    const key = JSON.stringify(path);

    // If offline, coalesce by path; do not start timers.
    if (!this.deps.isLive()) {
      const existing = this.offlineQueue.get(key);
      this.offlineQueue.set(key, {
        path, value,
        priorValue: existing?.priorValue ?? priorValue,
        clientSeq: null, timer: null, sent: false,
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

  /** Server confirmed our op. Drop the in-flight tracking. */
  onEcho(clientSeq: number): void {
    this.inFlight.delete(clientSeq);
  }

  /** Server rejected our op. Roll back local state. */
  onNack(clientSeq: number, _code: string): void {
    const entry = this.inFlight.get(clientSeq);
    if (!entry) return; // unknown clientSeq (e.g. server restarted); ignore
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

  /** Called when the WS goes from live → closed. Move pending into offline queue. */
  onClosed(): void {
    for (const [key, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      this.offlineQueue.set(key, { ...entry, timer: null });
    }
    this.pending.clear();
  }

  private flushEntry(key: string, entry: PendingEntry): void {
    this.pending.delete(key);
    if (!this.deps.isLive()) {
      this.offlineQueue.set(key, { ...entry, timer: null });
      return;
    }
    const clientSeq = this.deps.nextClientSeq();
    entry.clientSeq = clientSeq;
    entry.sent = true;
    this.inFlight.set(clientSeq, entry);
    const op: SetOpClient = {
      v: 1, type: 'set', clientSeq,
      path: entry.path, value: entry.value,
    };
    this.deps.send(op);
  }
}
