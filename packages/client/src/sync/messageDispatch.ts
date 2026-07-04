// messageDispatch — routes a decoded ServerMessage to the right side effect.
//
// Kept as its own module so the wiring (which reactive store / which
// Outbox method each message type touches) reads as one switch instead of
// being smeared through AppRuntime/synthContext. WsClient owns the socket + state
// machine and hands fully-typed messages here; this layer owns the
// application semantics.
//
// Both `snapshot` (commandBus.loadProject) and `set` (commandBus.applyRemote)
// mutate the reactive `project` programmatically. These once had to be wrapped in an
// applyingFromNetwork suppression so the outbound sync watchers (deleted in Phase 5)
// wouldn't re-enqueue them as local edits — but every outbound watcher is gone
// (all writes now flow through the CommandBus), so there is nothing to suppress:
// the writes happen directly.

import type { ServerMessage } from '@fiddle/shared';
import { normalizeProject } from '@fiddle/shared';
import type { WsClient } from './WsClient.js';
import type { Outbox } from './Outbox.js';
import type { CommandBus } from './CommandBus.js';
import type { LoadTracker } from './LoadTracker.js';
import { roster, selfClientId, noteRemoteTouch } from './presence.js';

export interface DispatchDeps {
  wsClient: WsClient;
  outbox: Outbox;
  commandBus: CommandBus;
  loadTracker: LoadTracker;
  onFatalError: (code: string, message: string) => void;
  // Called when the room reaches the live / caught-up state (sync.complete).
  // Opens the outbound-sync gate in SyncSession so local edits can't leak into the
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
      // A snapshot confirms (ours) or supersedes (a peer's) any pending load.
      deps.loadTracker.onSnapshot();
      // Normalize first so a snapshot from an older (pre-pool) server can't
      // under-fill the fixed 32-slot model or leave an out-of-range bpm.
      // Routed through the bus so the audio stream gets one `replace` event.
      deps.commandBus.loadProject(normalizeProject(msg.project));
      deps.commandBus.resetWatermark();
      deps.outbox.reassertPending();
      return;
    case 'set': {
      // Peer-drift detection: a broadcast opId that skips ahead means we missed
      // an op. Ask the server to replay from our last applied opId; per-path
      // opId watermark in the CommandBus keeps the (newer) gapped op from being clobbered by
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
        deps.commandBus.advanceWatermark(msg.path, msg.opId);
      } else {
        // No outbound watcher observes this write any more, so the applied remote
        // op can't echo straight back out — apply it directly.
        deps.commandBus.applyRemote(msg);
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
      // A load nack matches here and never reaches the per-leaf Outbox path
      // (loads and set ops share the clientSeq counter, so seqs are disjoint).
      if (deps.loadTracker.onNack(msg.clientSeq, msg.code, msg.message)) return;
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
