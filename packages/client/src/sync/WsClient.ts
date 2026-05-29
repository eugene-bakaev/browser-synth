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

  constructor(opts: WsClientOptions) {
    this.opts = opts;
    this.socketCtor = opts.socketCtor ?? WebSocket;
    this.storage = opts.storage ?? sessionStorage;
    this.storageKey = `fiddle:sync:${opts.roomId}`;
  }

  // === Public API ===

  connect(): void {
    if (this.socket) return;
    this.intentionallyClosed = false;
    this.setState('opening');
    const socket = new this.socketCtor(this.opts.url);
    this.socket = socket;
    socket.onopen = () => this.sendHello();
    socket.onmessage = (ev) => this.onSocketMessage(ev.data);
    socket.onclose = () => this.onSocketClose();
    // Errors fire before close; the close handler is where the real fallout
    // (reconnect, state transitions) lives, so onerror just absorbs.
    socket.onerror = () => {};
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

  // Outbox uses this to stamp outbound `set` ops. Reads, increments, persists,
  // and returns the new value. If there's no persisted state yet (we haven't
  // seen `welcome`), we still bump from 0 — but in practice Outbox waits for
  // `live` before sending, by which point `welcome` has populated clientId.
  nextClientSeq(): number {
    const persisted = this.getPersisted() ?? {
      clientId: '',
      opIdLastSeen: 0,
      clientSeq: 0,
    };
    persisted.clientSeq += 1;
    this.savePersisted(persisted);
    return persisted.clientSeq;
  }

  // === Internal: socket events ===

  private sendHello(): void {
    const persisted = this.getPersisted();
    const hello: HelloMessage = persisted?.clientId
      ? {
          v: 1,
          type: 'hello',
          schemaVersion: PROJECT_SCHEMA_VERSION,
          clientId: persisted.clientId,
          resumeFromOpId: persisted.opIdLastSeen,
        }
      : {
          v: 1,
          type: 'hello',
          schemaVersion: PROJECT_SCHEMA_VERSION,
        };
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
