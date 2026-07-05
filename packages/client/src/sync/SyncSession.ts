// SyncSession — owns the room connection (WsClient + Outbox + CommandBus) and
// presence for one browser tab. Long-lived: created once; connect(roomId) builds
// and opens a socket, disconnect() tears it down but the object persists, and
// dispose() is the idempotent full teardown at page unload. Extracted from
// useSynth (Phase 3 of the lifecycle-architecture redesign) so socket ownership
// and teardown are explicit rather than module-global — the structural fix for
// orphaned sockets / phantom presence on reconnect and HMR.
//
// Behaviour is byte-identical to the pre-extraction useSynth: this is a
// relocation, not a rewrite. The reactive connection state (currentRoomId /
// roomLoading / fatalError) lives here and is re-exported through synthContext
// so consumers are untouched.

import { ref, watch, type Ref } from 'vue';
import type { Path, LoadMessage, Project } from '@fiddle/shared';
import { WsClient, type WsClientOptions } from './WsClient';
import { Outbox } from './Outbox';
import type { CommandBus } from './CommandBus';
import { LoadTracker } from './LoadTracker';
import { dispatchServerMessage } from './messageDispatch';
import { resetPresence } from './presence';

export type WsClientFactory = (opts: WsClientOptions) => WsClient;

// Minimal slice of useAuth() the session needs: the token for the handshake and
// the reactive user id for the reconnect-on-identity-change watcher. Passed as a
// lazily-resolved getter so eager construction never calls useAuth() at module load.
export interface SyncAuth {
  accessToken: Ref<string | undefined>;
  session: Ref<{ user: { id: string } } | null>;
  // Resolves once the initial getSession + auth listener are wired. connect()
  // waits on this before the first hello so boot never handshakes as a guest
  // milliseconds before auth resolves (the double-handshake that armed the
  // reload-blank P0).
  ready: Promise<void>;
}

export interface SyncSessionDeps {
  bus: CommandBus;
  wsClientFactory: () => WsClientFactory; // getter — honours AppRuntimeOptions.wsClientFactory (tests)
  syncEnabled: () => boolean;             // getter — honours AppRuntimeOptions.syncEnabled (tests)
  auth: () => SyncAuth;                    // getter — resolved lazily (useAuth())
}

export class SyncSession {
  // Reactive connection state (re-exported through useSynth for consumers).
  readonly currentRoomId: Ref<string | null> = ref(null);
  readonly roomLoading: Ref<boolean> = ref(false);
  readonly fatalError: Ref<{ code: string; message: string } | null> = ref(null);
  readonly loadError: Ref<string | null> = ref(null);

  // Per-connection resources — built in connect(), nulled in disconnect().
  private wsClient: WsClient | null = null;
  private outbox: Outbox | null = null;
  private loadTracker: LoadTracker | null = null;

  // True once the CURRENT room has caught up (sync.complete). Outbound sync is
  // gated on this so pre-load / stale content is never leaked into the room.
  private syncReady = false;

  private authWatcherInstalled = false;
  private leaveFlushInstalled = false;

  constructor(private readonly deps: SyncSessionDeps) {}

  get isConnected(): boolean { return this.wsClient !== null; }
  get isSyncLive(): boolean { return this.outbox !== null && this.syncReady; }
  // Whether the WS layer is live at all (false in test mode). Read by
  // synthContext.connectToSession to pick the reflect-only test branch —
  // previously useSynth's module-scope `syncEnabled` flag.
  get isSyncEnabled(): boolean { return this.deps.syncEnabled(); }

  // Enter a room: build the socket/outbox/bus and open with a forced snapshot.
  // In disabled (test) mode, just reflect the room id — no socket, no loader.
  // Assumes it is called from a disconnected state (connectToSession in
  // app/synthContext.ts closes any previous socket first, preserving the
  // teardown → reset → build ordering).
  connect(roomId: string): void {
    if (!this.deps.syncEnabled()) { this.currentRoomId.value = roomId; return; }
    this.installAuthReconnectWatcher();
    this.installLeaveFlushHandler();
    this.buildConnection(roomId);
    this.currentRoomId.value = roomId;
    this.roomLoading.value = true;
    // Force a full snapshot: the caller reset the local project before connecting,
    // so a resume delta (op replay) would apply onto an empty project and leave
    // the room blank. forceSnapshot keeps our identity but pulls the whole room.
    //
    // Open only after auth has resolved: booting with a room URL used to send a
    // guest hello milliseconds before getSession() landed, and the auth watcher
    // then re-handshook mid-catch-up — the race behind the reload-blank P0. The
    // identity check below aborts if disconnect()/a newer connect() replaced
    // this connection while auth was resolving.
    const client = this.wsClient!;
    void this.deps.auth().ready.then(() => {
      if (this.wsClient === client) client.connect({ forceSnapshot: true });
    });
  }

  // Tear down the room connection; the session object persists (lobby state).
  disconnect(): void {
    // Deliver any throttled pending edits to the (still-live) socket before we
    // close it, so leaving / switching rooms can't strand the last edits.
    this.outbox?.flushAllPending();
    if (this.wsClient) {
      this.wsClient.disconnect();
      this.wsClient = null;
    }
    this.outbox = null;
    this.loadTracker = null;
    this.syncReady = false;
    this.fatalError.value = null;
    this.loadError.value = null;
    this.roomLoading.value = false;
    this.currentRoomId.value = null;
    resetPresence();
  }

  // Idempotent full teardown for page unload / HMR / tests. Currently identical to
  // disconnect(); named separately as the lifecycle entry point the Phase-5
  // AppRuntime will call, and so a double-teardown is unmistakably a no-op.
  dispose(): void { this.disconnect(); }

  // Enqueue an already-applied leaf op (used by the bulk sync emitters). Gated on
  // the room being live — a no-op otherwise. Mirrors the removed watchers'
  // `outbox && syncReady` guard.
  enqueue(path: Path, value: unknown, priorValue: unknown, gestureEnd: boolean): void {
    if (!this.isSyncLive) return;
    this.outbox!.enqueue(path, value, priorValue, gestureEnd);
  }

  flushPath(path: Path): void { this.outbox?.flushPath(path); }
  flushAllPending(): void { this.outbox?.flushAllPending(); }

  // Bulk-load path is available only when the room is live AND the server
  // advertised the capability (old servers fatally close on unknown types).
  get canBulkLoad(): boolean {
    return this.isSyncLive && (this.wsClient?.serverCapabilities.includes('load') ?? false);
  }

  // Send the whole project atomically (OPEN/NEW). `prior` is a full deep clone
  // of the pre-load project, held for nack/timeout rollback.
  sendProjectLoad(project: Project, prior: Project): void {
    if (!this.canBulkLoad || !this.wsClient || !this.loadTracker) return;
    const msg: LoadMessage = {
      v: 1, type: 'load', clientSeq: this.wsClient.nextClientSeq(), project,
    };
    this.loadTracker.begin(msg, prior);
    this.wsClient.send(msg);
  }

  // --- internals (verbatim relocation of buildSyncState) ---

  private buildConnection(roomId: string): void {
    this.syncReady = false;
    this.deps.bus.resetWatermark();
    const auth = this.deps.auth();
    const envUrl = (import.meta as unknown as { env?: Record<string, string | undefined> })
      .env?.VITE_WS_URL;
    const wsUrl = envUrl
      ? `${envUrl.replace(/\/$/, '')}/ws/${roomId}`
      : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/${roomId}`;

    this.wsClient = this.deps.wsClientFactory()({
      url: wsUrl,
      roomId,
      getToken: () => auth.accessToken.value,
      onMessage: (msg) => dispatchServerMessage(msg, {
        wsClient: this.wsClient!,
        outbox: this.outbox!,
        commandBus: this.deps.bus,
        loadTracker: this.loadTracker!,
        onFatalError: (code, message) => {
          this.fatalError.value = { code, message };
          // The error overlay takes over; stop showing the loader behind it.
          this.roomLoading.value = false;
        },
        onSyncLive: () => {
          this.syncReady = true;
          // Initial catch-up done — the room's content is now applied locally.
          this.roomLoading.value = false;
        },
      }),
      onStateChange: (s) => {
        if (s === 'closed') {
          this.outbox?.onClosed();
          this.loadTracker?.onClosed();
        }
      },
    });

    this.outbox = new Outbox({
      nextClientSeq: () => this.wsClient!.nextClientSeq(),
      send: (op) => this.wsClient!.send(op),
      applyLocal: (path: Path, value: unknown) => {
        // Rollback / reassert write: route through the bus so state AND the
        // audio stream see the restored value (state-only — never re-sends).
        this.deps.bus.applyRollback(path, value);
      },
      isLive: () => !!this.wsClient?.isLive(),
    });

    this.loadTracker = new LoadTracker({
      send: (msg) => {
        // Best-effort resend; a dead socket surfaces via onStateChange('closed')
        // → loadTracker.onClosed(), so a throw here is benign.
        try { this.wsClient?.send(msg); } catch { /* settled by reconnect snapshot */ }
      },
      rollback: (prior) => this.deps.bus.loadProject(prior),
      onError: (message) => { this.loadError.value = message; },
      requireSnapshot: () => this.wsClient?.requireSnapshot(),
    });
  }

  // Re-handshake the live socket when the user logs in/out so the server
  // re-derives identity. Watches the user id, not the token (Supabase refreshes
  // the token silently). Installed once, lazily (verbatim from
  // installAuthReconnectWatcher).
  private installAuthReconnectWatcher(): void {
    if (this.authWatcherInstalled) return;
    this.authWatcherInstalled = true;
    const auth = this.deps.auth();
    watch(
      () => auth.session.value?.user.id ?? null,
      (next, prev) => {
        if (next === prev) return;
        // A flip before the socket ever connected is boot-time getSession
        // resolution, not a login: the pending first hello reads the token
        // fresh (getToken), so there is nothing to re-derive. Only a socket
        // that has started its handshake carries a possibly-stale identity.
        const ws = this.wsClient;
        if (!ws || ws.state === 'closed') return;
        ws.reconnect();
      },
    );
  }

  // Best-effort flush of throttled edits on tab close (the socket is usually
  // still open during beforeunload). Installed once, lazily (verbatim from
  // installLeaveFlushHandler).
  private installLeaveFlushHandler(): void {
    if (this.leaveFlushInstalled) return;
    if (typeof window === 'undefined') return;
    this.leaveFlushInstalled = true;
    window.addEventListener('beforeunload', () => {
      this.outbox?.flushAllPending();
    });
  }
}
