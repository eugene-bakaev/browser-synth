// LoadTracker — the single in-flight whole-project load (spec
// 2026-07-04-bulk-project-load-design). Lives BESIDE the Outbox, not inside
// it: the Outbox is per-leaf with per-path coalescing; a load is one atomic
// message whose rollback is the entire prior project.
//
// Lifecycle: begin() on send → cleared by the first snapshot arrival (ours or
// a concurrent peer's — last-write-wins, same as op semantics), by a matching
// nack (rollback to prior), or by onClosed() (a reconnect that resumes from a
// pre-load watermark hits the server's cleared op log and gets a snapshot, so
// state settles without client-side bookkeeping).

import type { LoadMessage, Project } from '@fiddle/shared';

export interface LoadTrackerDeps {
  /** Re-send the original LoadMessage (resend-once on ack timeout). */
  send: (msg: LoadMessage) => void;
  /** Restore the pre-load project (terminal failure only). */
  rollback: (prior: Project) => void;
  /** Surface a terminal load failure to the user. */
  onError: (message: string) => void;
  /** Test seam; defaults to 5000 (same as the Outbox ACK timeout). */
  ackTimeoutMs?: number;
}

interface PendingLoad {
  msg: LoadMessage;
  prior: Project;
  timer: ReturnType<typeof setTimeout> | null;
  resent: boolean;
}

export class LoadTracker {
  private pending: PendingLoad | null = null;

  constructor(private readonly deps: LoadTrackerDeps) {}

  get hasPending(): boolean {
    return this.pending !== null;
  }

  begin(msg: LoadMessage, prior: Project): void {
    this.clearTimer();
    this.pending = { msg, prior, timer: null, resent: false };
    this.armTimer();
  }

  /** Any snapshot confirms or supersedes the pending load. */
  onSnapshot(): void {
    this.clearTimer();
    this.pending = null;
  }

  /** True when the nack matched the pending load (caller stops routing it). */
  onNack(clientSeq: number, code: string, message: string): boolean {
    if (!this.pending || this.pending.msg.clientSeq !== clientSeq) return false;
    const { prior } = this.pending;
    this.clearTimer();
    this.pending = null;
    this.deps.rollback(prior);
    this.deps.onError(`Project load rejected (${code}): ${message}`);
    return true;
  }

  /** Socket died mid-load: drop it; the resume/snapshot path settles state. */
  onClosed(): void {
    this.clearTimer();
    this.pending = null;
  }

  private armTimer(): void {
    const pending = this.pending!;
    pending.timer = setTimeout(() => {
      if (this.pending !== pending) return;
      if (!pending.resent) {
        pending.resent = true;
        // Idempotent by construction: the server replaces with identical
        // content and re-broadcasts a snapshot.
        this.deps.send(pending.msg);
        this.armTimer();
        return;
      }
      this.pending = null;
      this.deps.rollback(pending.prior);
      this.deps.onError('Project load timed out');
    }, this.deps.ackTimeoutMs ?? 5000);
  }

  private clearTimer(): void {
    if (this.pending?.timer) {
      clearTimeout(this.pending.timer);
      this.pending.timer = null;
    }
  }
}
