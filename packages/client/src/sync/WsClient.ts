// WsClient — owns the client-side WebSocket lifecycle for a single room.
//
// Responsibilities (the higher layers — Outbox, applyOp, presence store — sit
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

export class WsClient {
  state: WsState = 'closed';

  private readonly opts: WsClientOptions;
  private readonly socketCtor: typeof WebSocket;
  private readonly storage: Storage;
  private readonly storageKey: string;

  private socket: WebSocket | null = null;
  private backoff = INITIAL_BACKOFF_MS;
  private readonly maxBackoff = MAX_BACKOFF_MS;
  private reconnectTimer: number | null = null;
  private intentionallyClosed = false;
  // When true, the next hello keeps our clientId (identity/ownership) but omits
  // resumeFromOpId so the server replies with a full snapshot instead of an
  // op-replay delta. Set by a deliberate (re)entry where the caller has reset
  // local project state; a delta applied onto an empty project would render the
  // room blank. Auto-reconnect / auth-reconnect leave this false (resume).
  private forceSnapshotNextHello = false;

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
    this.forceSnapshotNextHello = opts?.forceSnapshot ?? false;
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
      if (!this.forceSnapshotNextHello) {
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
          opIdLastSeen: msg.opIdHead,
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

  // === Persistence (public so the Outbox + applyOp layers can read/advance them) ===

  getPersisted(): PersistedSyncState | null {
    const raw = this.storage.getItem(this.storageKey);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as PersistedSyncState;
    } catch {
      return null;
    }
  }

  private savePersisted(s: PersistedSyncState): void {
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
