// WsClient — owns the client-side WebSocket lifecycle for a single room.
//
// Responsibilities (the higher layers — Outbox, CommandBus, presence store — sit
// on top and never touch the raw socket):
//
//   - Open the WebSocket, send `hello` (fresh OR resume based on what's in
//     sessionStorage for this room), and walk the state machine:
//       closed → opening → catching-up → live
//   - Persist `{ clientId, opIdLastSeen, clientSeq }` per room so a refresh /
//     transient disconnect can resume mid-stream rather than starting over.
//   - Reset `clientSeq` whenever `clientId` changes (fresh join OR a forced
//     re-issue by the server via `resume.unknown_client`).
//   - Auto-respond to ping with pong so heartbeat liveness is handled here and
//     not in every consumer.
//   - Reconnect with exponential backoff (1s → 30s) on unexpected close;
//     suppress reconnect when `disconnect()` is intentional or the server
//     sends a fatal error.
//   - Reset backoff to 1s on each successful `sync.complete` so a stable
//     session that briefly blips doesn't accumulate long delays.

import {
  PROJECT_SCHEMA_VERSION,
  type ClientMessage,
  type ServerMessage,
  type HelloMessage,
} from '@fiddle/shared';

export type WsState = 'closed' | 'opening' | 'catching-up' | 'live';

export interface WsClientOptions {
  url: string;
  roomId: string;
  onMessage: (msg: ServerMessage) => void;
  onStateChange?: (s: WsState) => void;
  // Injectable for tests. `typeof WebSocket` is a structural constructor
  // signature, so a mock class works as long as it matches the shape.
  socketCtor?: typeof WebSocket;
  // Injectable for tests; defaults to sessionStorage.
  storage?: Storage;
  // Returns the current Supabase access token, or undefined for a guest.
  // Read fresh on every hello so a reconnect after login carries the token.
  getToken?: () => string | undefined;
}

interface PersistedSyncState {
  clientId: string;
  opIdLastSeen: number;
  clientSeq: number;
}

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
// How long to wait for a sync.complete after a resync before assuming the
// request was dropped (e.g. the server rate-limited it) and re-arming so the
// next detected gap can retry. Without this the in-flight guard would wedge and
// silently disable all future gap repair until a full reconnect.
const RESYNC_TIMEOUT_MS = 5000;

export class WsClient {
  state: WsState = 'closed';

  private readonly opts: WsClientOptions;
  private readonly socketCtor: typeof WebSocket;
  private readonly storage: Storage;
  private readonly storageKey: string;

  private socket: WebSocket | null = null;
  // In-memory copy of the persisted sync state; sessionStorage is write-through
  // only. Read lazily once, then every save updates this field AND storage —
  // so the per-inbound-op reads (gap check + recordOpIdSeen) and per-edit
  // clientSeq bumps cost no getItem/JSON.parse on the main thread (E3).
  // Crash-resume semantics are unchanged: every mutation still hits storage
  // synchronously. `undefined` = not yet read; `null` = read, nothing stored.
  private persisted: PersistedSyncState | null | undefined = undefined;
  private backoff = INITIAL_BACKOFF_MS;
  private resyncInFlight = false;
  private resyncTimer: number | null = null;
  private readonly maxBackoff = MAX_BACKOFF_MS;
  private reconnectTimer: number | null = null;
  private intentionallyClosed = false;
  // When true, the next hello omits resumeFromOpId so the server replies with a
  // full snapshot instead of an op-replay delta. Set by a deliberate (re)entry
  // where the caller has reset local project state; a delta applied onto an
  // empty project would render the room blank. Cleared ONLY when a snapshot
  // actually arrives: needing a snapshot is a fact about local state, not about
  // any one connection attempt, so it must survive mid-handshake reconnects
  // (auth re-handshake, transient drop) until satisfied.
  private snapshotRequired = false;

  constructor(opts: WsClientOptions) {
    this.opts = opts;
    this.socketCtor = opts.socketCtor ?? WebSocket;
    this.storage = opts.storage ?? sessionStorage;
    this.storageKey = `fiddle:sync:${opts.roomId}`;
  }

  // === Public API ===

  // `forceSnapshot` forces a full-snapshot catch-up on the next hello (keeping
  // identity) — used when the caller has reset local project state and a resume
  // delta would leave it blank. Defaults to false so auto-reconnect resumes.
  connect(opts?: { forceSnapshot?: boolean }): void {
    if (this.socket) return;
    // Only ever SET here — never clear. A reconnect between the request and the
    // snapshot's arrival must keep requesting one, or the new hello would resume
    // and leave the local placeholder in place (the reload-blank P0).
    if (opts?.forceSnapshot) this.snapshotRequired = true;
    this.intentionallyClosed = false;
    this.setState('opening');
    const socket = new this.socketCtor(this.opts.url);
    this.socket = socket;
    // Guard every handler to THIS socket. After a reconnect, a superseded socket
    // can still fire late events; without the guard its onopen would call
    // sendHello against the *current* this.socket — which may still be
    // CONNECTING — throwing "Failed to execute 'send' … Still in CONNECTING
    // state", and its onclose would spuriously reconnect the live connection.
    socket.onopen = () => {
      if (this.socket === socket) this.sendHello();
    };
    socket.onmessage = (ev) => {
      if (this.socket === socket) this.onSocketMessage(ev.data);
    };
    socket.onclose = () => {
      if (this.socket === socket) this.onSocketClose();
    };
    // Errors fire before close; the close handler is where the real fallout
    // (reconnect, state transitions) lives, so onerror just absorbs.
    socket.onerror = () => {};
  }

  // Force a fresh connection — used when auth state changes so the server
  // re-derives identity from the (now present/absent) token.
  reconnect(): void {
    this.disconnect();
    this.connect();
  }

  disconnect(): void {
    this.intentionallyClosed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearResyncTimer();
    this.resyncInFlight = false;
    this.socket?.close();
    this.socket = null;
    this.setState('closed');
  }

  send(msg: ClientMessage): void {
    if (this.state !== 'live') {
      throw new Error(`WsClient.send called in state '${this.state}' (must be 'live')`);
    }
    this.socket?.send(JSON.stringify(msg));
  }

  isLive(): boolean {
    return this.state === 'live';
  }

  // Last opId this client has recorded as applied (from persisted sync state).
  // Used by the dispatcher to detect a gap in the broadcast stream.
  opIdLastSeen(): number {
    return this.getPersisted()?.opIdLastSeen ?? -1;
  }

  // Ask the server to replay everything after `fromOpId` (peer-drift repair).
  // No-op unless live. Guarded so a burst of gapped frames sends at most one
  // outstanding request; the flag clears on the next sync.complete, or re-arms
  // after RESYNC_TIMEOUT_MS if the request was dropped (e.g. rate-limited).
  requestResync(fromOpId: number): void {
    if (this.state !== 'live') return;
    // No known baseline (opIdLastSeen sentinel, e.g. persisted state cleared
    // mid-session). A negative fromOpId fails the server's nonnegative() schema
    // and would trigger a fatal disconnect — drop it instead.
    if (fromOpId < 0) return;
    if (this.resyncInFlight) return;
    this.resyncInFlight = true;
    this.send({ v: 1, type: 'resync', fromOpId });
    this.resyncTimer = setTimeout(() => {
      // No sync.complete arrived in time — assume the request was dropped and
      // clear the guard so the next detected gap can retry.
      this.resyncTimer = null;
      this.resyncInFlight = false;
    }, RESYNC_TIMEOUT_MS);
  }

  private clearResyncTimer(): void {
    if (this.resyncTimer !== null) {
      clearTimeout(this.resyncTimer);
      this.resyncTimer = null;
    }
  }

  // Outbox uses this to stamp outbound `set` ops. Throws if called before
  // `welcome` populated the persisted record: writing a `clientSeq` against
  // an empty `clientId` would get wiped when the next welcome reset the seq
  // (clientId-changed guard), silently losing in-flight numbering.
  nextClientSeq(): number {
    const persisted = this.getPersisted();
    if (!persisted || !persisted.clientId) {
      throw new Error('WsClient.nextClientSeq called before welcome');
    }
    persisted.clientSeq += 1;
    this.savePersisted(persisted);
    return persisted.clientSeq;
  }

  // === Internal: socket events ===

  private sendHello(): void {
    const persisted = this.getPersisted();
    const hello: HelloMessage = {
      v: 1,
      type: 'hello',
      schemaVersion: PROJECT_SCHEMA_VERSION,
    };
    if (persisted?.clientId) {
      // Keep our identity (guest ownership / color) across the reconnect.
      hello.clientId = persisted.clientId;
      // Resume mid-stream only on a transient reconnect. On a forced-snapshot
      // (re)entry the local project was reset to fresh, so omit resumeFromOpId
      // — the server then sends a full snapshot rather than a delta that would
      // apply onto an empty project and leave the room blank.
      if (!this.snapshotRequired && persisted.opIdLastSeen >= 0) {
        hello.resumeFromOpId = persisted.opIdLastSeen;
      }
    }
    const token = this.opts.getToken?.();
    if (token) hello.token = token;
    this.socket?.send(JSON.stringify(hello));
  }

  private onSocketMessage(raw: unknown): void {
    // WebSocket can deliver Blob/ArrayBuffer; we only speak JSON text.
    if (typeof raw !== 'string') return;
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }

    switch (msg.type) {
      case 'welcome': {
        const prev = this.getPersisted();
        const next: PersistedSyncState = {
          clientId: msg.clientId,
          // Carry the last APPLIED op forward — never adopt msg.opIdHead here.
          // The head is a promise of content to come; recording it before the
          // snapshot/replay arrives would make a connection that dies mid
          // catch-up resume "from head" and skip the content entirely (the P0
          // reload-blank bug). The watermark advances in the snapshot case
          // below and per-op via recordOpIdSeen.
          opIdLastSeen: prev?.opIdLastSeen ?? -1,
          // If clientId changed (fresh join OR unknown_client reissue), the
          // old clientSeq belongs to a different identity — start over.
          clientSeq: prev && prev.clientId === msg.clientId ? prev.clientSeq : 0,
        };
        this.savePersisted(next);
        this.setState('catching-up');
        break;
      }
      case 'sync.complete': {
        this.recordOpIdSeen(msg.opId);
        this.clearResyncTimer();
        this.resyncInFlight = false;
        this.setState('live');
        this.backoff = INITIAL_BACKOFF_MS;
        break;
      }
      case 'error': {
        if (msg.fatal) {
          // The server is about to close us; mark intentional so the close
          // handler doesn't immediately try to reconnect into the same fault.
          this.intentionallyClosed = true;
        }
        break;
      }
      case 'ping': {
        // Reply before notifying consumers so heartbeat liveness is honored
        // even if `opts.onMessage` is slow or throws.
        this.socket?.send(JSON.stringify({ v: 1, type: 'pong' }));
        break;
      }
      case 'snapshot': {
        // The requested full snapshot is here — local state now holds room
        // content, so future hellos may resume again.
        this.snapshotRequired = false;
        // The snapshot IS applied content up to its opId (dispatch applies it
        // synchronously right after this handler) — advance the watermark now,
        // replacing the welcome-time pre-advance.
        this.recordOpIdSeen(msg.opId);
        break;
      }
      default:
        break;
    }

    this.opts.onMessage(msg);
  }

  private onSocketClose(): void {
    this.socket = null;
    if (this.intentionallyClosed) {
      this.setState('closed');
      return;
    }
    this.setState('closed');
    const delay = this.backoff;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay) as unknown as number;
    this.backoff = Math.min(this.backoff * 2, this.maxBackoff);
  }

  // === Internal: state ===

  private setState(s: WsState): void {
    if (this.state === s) return;
    this.state = s;
    this.opts.onStateChange?.(s);
  }

  // === Persistence (public so the Outbox + CommandBus layers can read/advance them) ===

  getPersisted(): PersistedSyncState | null {
    if (this.persisted === undefined) {
      this.persisted = this.readPersistedFromStorage();
    }
    return this.persisted;
  }

  private readPersistedFromStorage(): PersistedSyncState | null {
    const raw = this.storage.getItem(this.storageKey);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as PersistedSyncState;
    } catch {
      return null;
    }
  }

  private savePersisted(s: PersistedSyncState): void {
    this.persisted = s;
    this.storage.setItem(this.storageKey, JSON.stringify(s));
  }

  // Monotonic: never roll the recorded `opIdLastSeen` backwards (an in-flight
  // duplicate or a misordered replay should not clobber forward progress).
  recordOpIdSeen(opId: number): void {
    const persisted = this.getPersisted();
    if (!persisted) return;
    if (opId > persisted.opIdLastSeen) {
      persisted.opIdLastSeen = opId;
      this.savePersisted(persisted);
    }
  }
}
