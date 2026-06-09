// messageDispatch — routes a decoded ServerMessage to the right side effect.
//
// Kept separate from useSynth so the wiring (which reactive store / which
// Outbox method each message type touches) reads as one switch instead of
// being smeared through the composable. WsClient owns the socket + state
// machine and hands fully-typed messages here; this layer owns the
// application semantics.
//
// Suppression: `snapshot` (replaceProject) and `set` (applyOp) both mutate the
// reactive `project` programmatically. Those writes are wrapped in the
// applyingFromNetwork suppression so the sync watchers in useSynth don't
// re-enqueue them back out as local edits. applyOp does its own wrapping; the
// snapshot path wraps replaceProject explicitly here.

import type { ServerMessage, Project } from '@fiddle/shared';
import { normalizeProject } from '@fiddle/shared';
import type { WsClient } from './WsClient.js';
import type { Outbox } from './Outbox.js';
import { applyOp, advanceOpIdForPath, resetApplyOpState, enterSuppress, exitSuppress } from './applyOp.js';
import { roster, selfClientId, noteRemoteTouch } from './presence.js';
import { replaceProject } from '../project/storage.js';

export interface DispatchDeps {
  project: Project;
  wsClient: WsClient;
  outbox: Outbox;
  onFatalError: (code: string, message: string) => void;
  // Called when the room reaches the live / caught-up state (sync.complete).
  // Opens the outbound-sync gate in useSynth so local edits can't leak into the
  // room before it has loaded (cross-session bleed guard). Keyed on sync.complete
  // — NOT snapshot — because catch-up can arrive as op replay instead of a
  // snapshot (a resumed connection), and sync.complete fires on every path.
  onSyncLive?: () => void;
}

export function dispatchServerMessage(msg: ServerMessage, deps: DispatchDeps): void {
  switch (msg.type) {
    case 'welcome':
      selfClientId.value = msg.clientId;
      roster.value = msg.roster;
      return;
    case 'snapshot':
      // Programmatic bulk write — suppress so the sync watchers don't treat the
      // incoming snapshot as a flurry of local edits and echo it all back out.
      enterSuppress();
      try {
        // Normalize first so a snapshot from an older (pre-pool) server can't
        // under-fill the fixed 32-slot model the client assumes, or leave a
        // blank/out-of-range bpm in the reactive state.
        replaceProject(deps.project, normalizeProject(msg.project));
      } finally {
        exitSuppress();
      }
      resetApplyOpState();
      // Non-destructive reconcile: the snapshot just overwrote local state. Re-apply
      // any un-acked local edits on top and re-queue them for delivery so a server
      // repair (mid-session resync or reconnect eviction) can never erase a pending
      // change.
      deps.outbox.reassertPending();
      return;
    case 'set': {
      // Peer-drift detection: a broadcast opId that skips ahead means we missed
      // an op. Ask the server to replay from our last applied opId; per-path
      // opId guards in applyOp keep the (newer) gapped op from being clobbered by
      // the (older) replayed ones.
      const lastSeen = deps.wsClient.opIdLastSeen();
      if (msg.opId > lastSeen + 1) {
        deps.wsClient.requestResync(lastSeen);
      }
      let skipWrite = false;
      if (msg.clientSeq != null) {
        // Echo of our own op.
        deps.outbox.onEcho(msg.clientSeq);
        // During a continuous drag the echo carries the value from ~RTT ago,
        // while the local field has since advanced (a newer edit is throttled
        // or in flight). Writing the echo back would snap the knob — and its
        // sound — backward, so skip the write but still advance the per-path
        // opId watermark below. When nothing newer is pending, local state
        // already matches the echo (optimistic UI) and the write is a no-op.
        skipWrite = deps.outbox.hasPendingForPath(msg.path);
      }
      if (skipWrite) {
        advanceOpIdForPath(msg.path, msg.opId);
      } else {
        applyOp(deps.project, msg);
      }
      if (msg.clientId !== selfClientId.value) {
        noteRemoteTouch(msg.path, msg.clientId);
      }
      deps.wsClient.recordOpIdSeen(msg.opId);
      return;
    }
    case 'sync.complete':
      deps.outbox.onLive();
      // Room is now caught up (via snapshot OR op replay) — open the outbound
      // gate. Fires on every catch-up path, unlike snapshot.
      deps.onSyncLive?.();
      return;
    case 'presence.update':
      roster.value = msg.roster;
      return;
    case 'nack':
      deps.outbox.onNack(msg.clientSeq, msg.code);
      return;
    case 'error':
      if (msg.fatal) deps.onFatalError(msg.code, msg.message);
      // Non-fatal errors: log only; the welcome + snapshot following will fix state.
      return;
    case 'ping':
      // WsClient already auto-pongs; no further action.
      return;
  }
}
