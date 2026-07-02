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
// roomLoading / fatalError) lives here and is re-exported through useSynth so
// consumers are untouched.

import { ref, watch, type Ref } from 'vue';
import type { Path, Project } from '@fiddle/shared';
import { setDeep } from '@fiddle/shared';
import { WsClient, type WsClientOptions } from './WsClient';
import { Outbox } from './Outbox';
import { createCommandBus, type CommandBus, type LocalCommand } from './CommandBus';
import { dispatchServerMessage } from './messageDispatch';
import { resetPresence } from './presence';

export type WsClientFactory = (opts: WsClientOptions) => WsClient;

// Minimal slice of useAuth() the session needs: the token for the handshake and
// the reactive user id for the reconnect-on-identity-change watcher. Passed as a
// lazily-resolved getter so eager construction never calls useAuth() at module load.
export interface SyncAuth {
  accessToken: Ref<string | undefined>;
  session: Ref<{ user: { id: string } } | null>;
}

export interface SyncSessionDeps {
  project: Project;
  wsClientFactory: () => WsClientFactory; // getter — honours setWsClientFactory (tests)
  syncEnabled: () => boolean;             // getter — honours setSyncEnabled (tests)
  auth: () => SyncAuth;                    // getter — resolved lazily (useAuth())
}

export class SyncSession {
  // Reactive connection state (re-exported through useSynth for consumers).
  readonly currentRoomId: Ref<string | null> = ref(null);
  readonly roomLoading: Ref<boolean> = ref(false);
  readonly fatalError: Ref<{ code: string; message: string } | null> = ref(null);

  // Per-connection resources — built in connect(), nulled in disconnect().
  private wsClient: WsClient | null = null;
  private outbox: Outbox | null = null;
  private commandBus: CommandBus | null = null;

  // True once the CURRENT room has caught up (sync.complete). Outbound sync is
  // gated on this so pre-load / stale content is never leaked into the room.
  private syncReady = false;

  private authWatcherInstalled = false;
  private leaveFlushInstalled = false;

  constructor(private readonly deps: SyncSessionDeps) {}

  get isConnected(): boolean { return this.wsClient !== null; }
  get isSyncLive(): boolean { return this.outbox !== null && this.syncReady; }

  // Enter a room: build the socket/outbox/bus and open with a forced snapshot.
  // In disabled (test) mode, just reflect the room id — no socket, no loader.
  // Assumes it is called from a disconnected state (the useSynth wrapper closes
  // any previous socket first, preserving the teardown → reset → build ordering).
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
    this.wsClient!.connect({ forceSnapshot: true });
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
    this.commandBus = null;
    this.syncReady = false;
    this.fatalError.value = null;
    this.roomLoading.value = false;
    this.currentRoomId.value = null;
    resetPresence();
  }

  // Idempotent full teardown for page unload / HMR / tests. Currently identical to
  // disconnect(); named separately as the lifecycle entry point the Phase-5
  // AppRuntime will call, and so a double-teardown is unmistakably a no-op.
  dispose(): void { this.disconnect(); }

  // Route a local edit through the command bus (state write + gated enqueue).
  // Returns false when not connected so the caller can fall back to a direct
  // store write (lobby / pre-connect / tests).
  dispatchLocal(cmd: LocalCommand): boolean {
    if (!this.commandBus) return false;
    this.commandBus.dispatchLocal(cmd);
    return true;
  }

  // Enqueue an already-applied leaf op (used by the bulk sync emitters). Gated on
  // the room being live — a no-op otherwise. Mirrors the removed watchers'
  // `outbox && syncReady` guard.
  enqueue(path: Path, value: unknown, priorValue: unknown, gestureEnd: boolean): void {
    if (!this.isSyncLive) return;
    this.outbox!.enqueue(path, value, priorValue, gestureEnd);
  }

  flushPath(path: Path): void { this.outbox?.flushPath(path); }
  flushAllPending(): void { this.outbox?.flushAllPending(); }

  // --- internals (verbatim relocation of buildSyncState) ---

  private buildConnection(roomId: string): void {
    this.syncReady = false;
    const project = this.deps.project;
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
        project,
        wsClient: this.wsClient!,
        outbox: this.outbox!,
        commandBus: this.commandBus!,
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
        if (s === 'closed' && this.outbox) this.outbox.onClosed();
      },
    });

    this.outbox = new Outbox({
      nextClientSeq: () => this.wsClient!.nextClientSeq(),
      send: (op) => this.wsClient!.send(op),
      applyLocal: (path: Path, value: unknown) => {
        // Rollback write (nack): revert the local project in place. No suppression
        // needed — no outbound watcher observes this write.
        setDeep(project as unknown as Record<string, unknown>, path, value);
      },
      isLive: () => !!this.wsClient?.isLive(),
    });

    this.commandBus = createCommandBus({
      applySet: (path: Path, value: unknown) => {
        setDeep(project as unknown as Record<string, unknown>, path, value);
      },
      enqueue: (path: Path, value: unknown, priorValue: unknown, gestureEnd: boolean) => {
        // Gated on the room being live so a local edit during initial catch-up
        // writes state but is not leaked up before the room loads.
        if (this.syncReady) this.outbox!.enqueue(path, value, priorValue, gestureEnd);
      },
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
        this.wsClient?.reconnect();
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
