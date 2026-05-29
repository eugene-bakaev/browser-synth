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
import type { WsClient } from './WsClient.js';
import type { Outbox } from './Outbox.js';
import { applyOp, resetApplyOpState, enterSuppress, exitSuppress } from './applyOp.js';
import { roster, selfClientId, noteRemoteTouch } from './presence.js';
import { replaceProject } from '../project/storage.js';

export interface DispatchDeps {
  project: Project;
  wsClient: WsClient;
  outbox: Outbox;
  onFatalError: (code: string, message: string) => void;
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
        replaceProject(deps.project, msg.project);
      } finally {
        exitSuppress();
      }
      resetApplyOpState();
      return;
    case 'set':
      if (msg.clientSeq != null) {
        // Echo of our own op.
        deps.outbox.onEcho(msg.clientSeq);
        // Local state already matches (optimistic UI); applyOp still
        // updates lastAppliedOpIdForPath, which is what we want.
      }
      applyOp(deps.project, msg);
      if (msg.clientId !== selfClientId.value) {
        noteRemoteTouch(msg.path, msg.clientId);
      }
      deps.wsClient.recordOpIdSeen(msg.opId);
      return;
    case 'sync.complete':
      deps.outbox.onLive();
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
