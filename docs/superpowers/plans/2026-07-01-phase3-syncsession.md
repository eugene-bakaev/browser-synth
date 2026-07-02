# Phase 3 — Extract `SyncSession` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the room-connection machinery (`WsClient`, `Outbox`, `CommandBus`, presence, and the connect/leave/reconnect/dispose lifecycle) out of `useSynth.ts` into a single long-lived `SyncSession` class with an idempotent `dispose()`, behind `useSynth`'s existing export facade so no consumer file changes.

**Architecture:** A new `sync/SyncSession.ts` owns the three per-connection resources (built in `connect()`, dropped in `disconnect()`) plus the reactive connection state (`currentRoomId`/`roomLoading`/`fatalError`). `useSynth.ts` constructs one module-scope `SyncSession` singleton (eagerly, side-effect-free) and rewrites its existing sync exports (`connectToSession`/`leaveSession`/`disposeSynth`/`dispatchLocal`/`endGesture`/the bulk `sync*Diff` emitters/the returned refs) as thin delegators. Behaviour is byte-identical — a relocation, not a rewrite.

**Tech Stack:** TypeScript, Vue 3 reactivity (`ref`/`watch`), Vitest. Client workspace `@fiddle/client`.

## Global Constraints

- **Behaviour is byte-for-byte identical.** This is a facade-preserving extraction; no protocol, ordering, or reactivity change. Any observable behaviour change is a bug.
- **The `useSynth` export surface stays byte-stable.** The 11 consumer files (`App.vue`, `StudioView.vue`, `LobbyView.vue`, `Sidebar.vue`, `Tracker.vue`, `TrackMixer.vue`, `ErrorOverlay.vue`, `sync/knobSync.ts`, `sync/commandModel.ts`, `sync/synthContext.ts`, and the component tests) must NOT change. Verify with `git diff --stat` at the end: only `useSynth.ts`, `SyncSession.ts`, and `SyncSession.test.ts` are touched (plus this plan/spec).
- **`SyncSession` imports nothing from audio and nothing from `useSynth`.** Only `sync/*`, `@fiddle/shared`, and `vue`. This keeps the dependency edge one-directional (`useSynth` → `SyncSession`) and cycle-free.
- **The constructor does no side effects** (no `useAuth()` call, no `window.addEventListener`, no `watch`). Those install lazily on the first `connect()` via private once-guards — preserving today's timing and making eager module-load construction safe in every test context.
- **`applySet` stays a pure `setDeep` primitive** (mirrors `Outbox.applyLocal`); folding it onto a store method is a later phase.
- **Do NOT mount `.vue` files in new unit tests.** `SyncSession.test.ts` drives the class directly with a fake `WsClient`.
- **Never work on `main`; never delete the branch after merge; stage only named files (never `git add -A`/`.`).** Never stage `studio-initial.png`, `synth2-wave-previews.png`, `studio-focused.md`, `studio-rack.png`.
- **Local browser verification MUST use `npm run dev:obs`** (local Docker Postgres), never `npm run dev` (real prod Supabase DB).
- Commit/merge messages end with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01DFmmWXyd9uJAiJ6cdbE4ir`

**Commands** (run from `packages/client/` unless noted):
- Single test file: `npx vitest run src/sync/SyncSession.test.ts`
- Full client suite: `npm test` (alias for `vitest run`)
- Typecheck: `npm run typecheck` (`vue-tsc --noEmit`)
- Full gate (from repo root): `npm test && npm run typecheck`

---

## File Structure

- **Create `packages/client/src/sync/SyncSession.ts`** — the long-lived session class. Owns `WsClient`/`Outbox`/`CommandBus`/presence + reactive connection state; `connect`/`disconnect`/`dispose` lifecycle; `dispatchLocal`/`enqueue`/`flushPath`/`flushAllPending` outbound primitives; `isConnected`/`isSyncLive` getters.
- **Create `packages/client/src/sync/SyncSession.test.ts`** — unit tests driving the class with a fake `WsClient` (no `.vue` mounting).
- **Modify `packages/client/src/composables/useSynth.ts`** — construct one `SyncSession` singleton; delete the extracted internals; rewrite the sync exports as delegators. Consumers untouched.

Two tasks. **Task 1** builds and unit-tests `SyncSession` in isolation (dead code — nothing imports it yet, app stays green). **Task 2** is the atomic swap: wire `useSynth` to the singleton and delete the old internals. They split cleanly because a reviewer can approve "the class is correct in isolation" independently of "the facade was rewired faithfully"; but the swap itself (delete module vars + rewrite every referencing function) is indivisible — it must compile and pass as one unit.

---

## Task 1: Build and unit-test the `SyncSession` class (isolated, dead code)

**Files:**
- Create: `packages/client/src/sync/SyncSession.ts`
- Test: `packages/client/src/sync/SyncSession.test.ts`

**Interfaces:**
- Consumes (from existing `sync/*`): `WsClient`, `WsClientOptions` (`./WsClient`); `Outbox` (`./Outbox`); `createCommandBus`, `CommandBus`, `LocalCommand` (`./CommandBus`); `dispatchServerMessage` (`./messageDispatch`); `resetPresence` (`./presence`); `Path`, `Project`, `setDeep` (`@fiddle/shared`).
- Produces (relied on by Task 2):
  - `class SyncSession` with constructor `(deps: SyncSessionDeps)`
  - `interface SyncSessionDeps { project: Project; wsClientFactory: () => WsClientFactory; syncEnabled: () => boolean; auth: () => SyncAuth }`
  - `type WsClientFactory = (opts: WsClientOptions) => WsClient`
  - `interface SyncAuth { accessToken: Ref<string | undefined>; session: Ref<{ user: { id: string } } | null> }`
  - reactive props `currentRoomId: Ref<string | null>`, `roomLoading: Ref<boolean>`, `fatalError: Ref<{ code: string; message: string } | null>`
  - getters `isConnected: boolean`, `isSyncLive: boolean`
  - methods `connect(roomId: string): void`, `disconnect(): void`, `dispose(): void`, `dispatchLocal(cmd: LocalCommand): boolean`, `enqueue(path: Path, value: unknown, priorValue: unknown, gestureEnd: boolean): void`, `flushPath(path: Path): void`, `flushAllPending(): void`

- [ ] **Step 1: Write the failing test**

Create `packages/client/src/sync/SyncSession.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { ref } from 'vue';
import { freshProject } from '../project';
import { SyncSession, type SyncSessionDeps } from './SyncSession';

// A fake WsClient matching the surface SyncSession/messageDispatch touch. The
// factory captures opts so the test can push server messages via opts.onMessage.
function makeFakeWsClient(opts: any) {
  let seq = 0;
  return {
    _opts: opts,
    sent: [] as any[],
    connect: vi.fn(),
    disconnect: vi.fn(),
    reconnect: vi.fn(),
    send(op: any) { this.sent.push(op); },
    isLive: () => true,
    nextClientSeq: () => ++seq,
    recordOpIdSeen: vi.fn(),
    opIdLastSeen: vi.fn(() => 0),
    requestResync: vi.fn(),
    getPersisted: () => null,
  };
}

// window/location stubs: connect() computes a ws URL from `location` and installs
// a beforeunload handler on `window`.
function stubEnv() {
  vi.stubGlobal('window', { addEventListener: vi.fn() });
  vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173' });
}

function makeSession(overrides: Partial<SyncSessionDeps> = {}) {
  const built: any[] = [];
  const deps: SyncSessionDeps = {
    project: freshProject(),
    wsClientFactory: () => (o: any) => { const f = makeFakeWsClient(o); built.push(f); return f as any; },
    syncEnabled: () => true,
    auth: () => ({ accessToken: ref(undefined), session: ref(null) }),
    ...overrides,
  };
  const session = new SyncSession(deps);
  return { session, built };
}

describe('SyncSession', () => {
  it('constructs with no side effects and starts disconnected in the lobby', () => {
    stubEnv();
    const { session, built } = makeSession();
    expect(built).toHaveLength(0);          // constructor built no socket
    expect(session.isConnected).toBe(false);
    expect(session.currentRoomId.value).toBeNull();
    expect(session.roomLoading.value).toBe(false);
    expect(session.fatalError.value).toBeNull();
  });

  it('connect(roomId) builds+opens a socket, sets currentRoomId, raises roomLoading', () => {
    stubEnv();
    const { session, built } = makeSession();
    session.connect('room-a');
    expect(built).toHaveLength(1);
    expect(built[0]._opts.roomId).toBe('room-a');
    expect(built[0].connect).toHaveBeenCalledWith({ forceSnapshot: true });
    expect(session.isConnected).toBe(true);
    expect(session.currentRoomId.value).toBe('room-a');
    expect(session.roomLoading.value).toBe(true);
  });

  it('sync.complete flips isSyncLive true and clears roomLoading', () => {
    stubEnv();
    const { session, built } = makeSession();
    session.connect('room-a');
    expect(session.isSyncLive).toBe(false);
    built[0]._opts.onMessage({ v: 1, type: 'sync.complete', opId: 0 });
    expect(session.isSyncLive).toBe(true);
    expect(session.roomLoading.value).toBe(false);
  });

  it('dispatchLocal writes state + enqueues when live; returns false when disconnected', () => {
    stubEnv();
    const { session, built } = makeSession();
    // disconnected: no bus → returns false, no throw
    expect(session.dispatchLocal({ path: ['bpm'], value: 140 })).toBe(false);
    session.connect('room-a');
    built[0]._opts.onMessage({ v: 1, type: 'sync.complete', opId: 0 }); // go live
    expect(session.dispatchLocal({ path: ['bpm'], value: 140, priorValue: 120, gestureEnd: true })).toBe(true);
    expect(built[0].sent.some((op: any) => op.path?.[0] === 'bpm' && op.value === 140)).toBe(true);
  });

  it('enqueue is a no-op until the room is live, then reaches the outbox', () => {
    stubEnv();
    const { session, built } = makeSession();
    session.connect('room-a');
    session.enqueue(['bpm'], 130, 120, true);          // not live yet
    expect(built[0].sent).toHaveLength(0);
    built[0]._opts.onMessage({ v: 1, type: 'sync.complete', opId: 0 });
    session.enqueue(['bpm'], 130, 120, true);          // live
    expect(built[0].sent.some((op: any) => op.path?.[0] === 'bpm')).toBe(true);
  });

  it('disconnect() disconnects the socket and clears state; dispose() is idempotent', () => {
    stubEnv();
    const { session, built } = makeSession();
    session.connect('room-a');
    session.disconnect();
    expect(built[0].disconnect).toHaveBeenCalledTimes(1);
    expect(session.isConnected).toBe(false);
    expect(session.currentRoomId.value).toBeNull();
    expect(session.roomLoading.value).toBe(false);
    // idempotent: a second teardown does not throw and does not re-disconnect.
    session.dispose();
    expect(built[0].disconnect).toHaveBeenCalledTimes(1);
    expect(session.isConnected).toBe(false);
  });

  it('connect() in disabled mode sets currentRoomId without opening a socket', () => {
    stubEnv();
    const { session, built } = makeSession({ syncEnabled: () => false });
    session.connect('room-a');
    expect(built).toHaveLength(0);
    expect(session.isConnected).toBe(false);
    expect(session.currentRoomId.value).toBe('room-a');
    expect(session.roomLoading.value).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/client && npx vitest run src/sync/SyncSession.test.ts`
Expected: FAIL — `Failed to resolve import "./SyncSession"` / `SyncSession is not defined`.

- [ ] **Step 3: Write the `SyncSession` class**

Create `packages/client/src/sync/SyncSession.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/client && npx vitest run src/sync/SyncSession.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck**

Run: `cd packages/client && npm run typecheck`
Expected: exit 0. (If `SyncAuth` doesn't accept `useAuth()`'s return in Task 2, widen it there — Task 1 typechecks standalone because nothing consumes it yet.)

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/sync/SyncSession.ts packages/client/src/sync/SyncSession.test.ts
git commit -m "$(cat <<'EOF'
feat(sync): add SyncSession class owning WsClient/Outbox/CommandBus (phase 3 task 1)

Long-lived session: connect() builds+opens the socket/outbox/bus, disconnect()
tears it down while the object persists, dispose() is the idempotent full
teardown. Constructor is side-effect-free; the auth-reconnect watcher and
beforeunload flush install lazily on first connect. Dead code for now — nothing
imports it yet (wired into useSynth in task 2). Unit-tested with a fake WsClient.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DFmmWXyd9uJAiJ6cdbE4ir
EOF
)"
```

---

## Task 2: Wire `useSynth` to the singleton; delete the extracted internals (atomic swap)

**Files:**
- Modify: `packages/client/src/composables/useSynth.ts`

**Interfaces:**
- Consumes (from Task 1): `SyncSession`, `SyncSessionDeps`, `WsClientFactory` — but note `useSynth` already declares its own `type WsClientFactory` (line ~239) and `wsClientFactory` let (line ~240); keep those and pass `() => wsClientFactory` into the session. Import only `SyncSession` (and `type SyncSessionDeps` if useful) from `./`. The session's `WsClientFactory` and `useSynth`'s are structurally identical.
- Produces: no signature changes. Every current `useSynth` export keeps its exact signature; consumers are untouched.

The edits below are all within `packages/client/src/composables/useSynth.ts`. Line numbers refer to the current file; apply by matching the shown code.

- [ ] **Step 1: Add the `SyncSession` import**

After the existing sync imports (near line 56, after the `presence` import) add:

```ts
import { SyncSession } from '../sync/SyncSession';
```

- [ ] **Step 2: Replace the module-scope sync vars with the singleton**

Delete lines 154–172 (the block from the `// === Sync state ===` comment through the `currentRoomId` ref, i.e. `let wsClient`, `let outbox`, `let commandBus`, `const fatalError`, `const roomLoading`, `const currentRoomId`), **but keep** the `sessionName` ref (line 177) — it is App-shell-owned and not part of the session.

Replace the deleted resource/state block with the singleton construction. Put this AFTER the `wsClientFactory` let + `setWsClientFactory` (line ~243) and after `syncEnabled` (line 223) so the getters read initialised bindings — the arrow getters defer access, so construction order is safe regardless, but placing it here reads clearly:

```ts
// The one room connection for this tab. Long-lived; connect/disconnect cycle the
// socket internally, dispose() is the page-unload teardown. Owns WsClient/Outbox/
// CommandBus + presence + the reactive connection state (currentRoomId/roomLoading/
// fatalError), re-exported below so consumers are untouched. Constructed eagerly
// and side-effect-free (no socket, no listeners) so a lobby read of currentRoomId
// works before the first connect.
const session = new SyncSession({
  project,
  wsClientFactory: () => wsClientFactory,
  syncEnabled: () => syncEnabled,
  auth: () => useAuth(),
});
```

Keep the `sessionName` ref where it is:

```ts
const sessionName = ref<string | null>(null);
```

Delete the `authWatcherInstalled` / `leaveFlushInstalled` flags (lines 179–180) and the whole `installLeaveFlushHandler` function (lines 181–190) — they moved into `SyncSession`.

- [ ] **Step 3: Rewrite `endGesture` and `dispatchLocal` (delegators)**

Replace `endGesture` (lines 196–198):

```ts
export function endGesture(path: Path): void {
  session.flushPath(path);
}
```

Replace `dispatchLocal` (lines 206–218):

```ts
export function dispatchLocal(path: Path, value: unknown): void {
  const gestureEnd = gestureEndForLeaf(String(path[path.length - 1]));
  const priorValue = getDeep(project as unknown as Record<string, unknown>, path);
  // Route through the session's command bus when connected; before a room exists
  // (pre-connect / tests) fall back to a direct store write so the edit still
  // drives audio + UI without trying to sync.
  if (!session.dispatchLocal({ path, value, priorValue, gestureEnd })) {
    setDeep(project as unknown as Record<string, unknown>, path, value);
  }
}
```

- [ ] **Step 4: Delete the standalone `syncReady` var and re-point the emitters**

Delete the `let syncReady = false;` declaration (line 234) and its comment block (lines 226–234) — `syncReady` is now private session state.

In `emitLeafDiff` (lines 270–291): delete the `if (!outbox) return;` guard (line 275) and replace both `outbox.enqueue(...)` calls (lines 285, 288) with `session.enqueue(...)`:

```ts
function emitLeafDiff(
  prefix: Path,
  changed: Record<string, unknown>,
  oldObj: Record<string, unknown> | undefined,
): void {
  for (const [key, value] of Object.entries(changed)) {
    if (Array.isArray(value)) continue;
    if (value !== null && typeof value === 'object') {
      const oldNested = (oldObj?.[key] ?? {}) as Record<string, unknown>;
      const newNested = value as Record<string, unknown>;
      for (const subKey of Object.keys(newNested)) {
        if (oldNested[subKey] === newNested[subKey]) continue;
        session.enqueue([...prefix, key, subKey], newNested[subKey], oldNested[subKey], gestureEndForLeaf(subKey));
      }
    } else {
      session.enqueue([...prefix, key], value, oldObj?.[key], gestureEndForLeaf(key));
    }
  }
}
```

In `emitMatrixDiff` (lines 301–317): delete the `if (!outbox) return;` guard (line 306) and replace the `outbox.enqueue(...)` (line 314) with `session.enqueue(...)`:

```ts
function emitMatrixDiff(
  trackIdx: number,
  newSlice: Record<string, unknown>,
  oldSlice: Record<string, unknown>,
): void {
  const newM = (newSlice as { matrix?: Record<string, unknown>[] }).matrix;
  const oldM = (oldSlice as { matrix?: Record<string, unknown>[] }).matrix;
  if (!newM || !oldM) return;
  for (let s = 0; s < newM.length; s++) {
    for (const field of ['source', 'dest', 'amount'] as const) {
      const a = newM[s]?.[field]; const o = oldM[s]?.[field];
      if (a === o) continue;
      session.enqueue(['tracks', trackIdx, 'engines', 'synth2', 'matrix', s, field], a, o, gestureEndForLeaf(field));
    }
  }
}
```

In `syncEngineParamsDiff` (line 324): replace guard `if (!outbox || !syncReady) return;` → `if (!session.isSyncLive) return;`.

In `syncStepWindowDiff` (line 341): replace guard `if (!outbox || !syncReady) return;` → `if (!session.isSyncLive) return;`.

In `syncWholeProjectDiff` (lines 406–407): replace guard `if (!outbox || !syncReady) return;` → `if (!session.isSyncLive) return;`, and replace the direct bpm enqueue (line 407) `outbox.enqueue(['bpm'], project.bpm, before.bpm, gestureEndForLeaf('bpm'))` → `session.enqueue(['bpm'], project.bpm, before.bpm, gestureEndForLeaf('bpm'))`.

- [ ] **Step 5: Delete `buildSyncState`, `installAuthReconnectWatcher`, `teardownConnection`; rewrite `connectToSession` / `leaveSession`**

Delete the entire `buildSyncState` function (lines 437–502), the entire `installAuthReconnectWatcher` function (lines 504–518), and the entire `teardownConnection` function (lines 520–536) — all three moved into `SyncSession`.

Replace `connectToSession` (lines 538–577) with the faithful control-flow mapping (identical order: URL → test-mode early return → alreadyHere → disconnect → reset → build):

```ts
// Enter a session: bring up the room connection for `roomId` and reflect it in
// the URL. Idempotent for the same room; switches cleanly between rooms. Does
// NOT touch audio — the AudioContext still boots lazily on first PLAY.
//
// `history` controls how the URL change is recorded: 'replace' (default) keeps a
// single entry; the lobby passes 'push' so Back returns to the lobby. `force`
// rebuilds the connection even when it is already the current room — used after a
// bfcache restore, whose frozen socket is dead, where the idempotent same-room
// short-circuit would otherwise leave the page disconnected.
export function connectToSession(
  roomId: string,
  opts?: { history?: 'push' | 'replace'; force?: boolean },
): void {
  // A no-op re-connect to the room we're already in must never PUSH a second
  // /r/<id> entry — force 'replace' in that case, whatever the caller asked for.
  const alreadyHere = !opts?.force && session.isConnected && session.currentRoomId.value === roomId;
  setRoomInUrl(roomId, alreadyHere ? 'replace' : (opts?.history ?? 'replace'));
  // Test mode (sync disabled): reflect the room without opening a socket; no reset.
  if (!syncEnabled) { session.connect(roomId); return; }
  if (alreadyHere) return;
  // Close the previous room's socket first, then blank the store, then build the
  // new socket — order matters so no remote op applies onto the fresh project and
  // no stale content is synced up into the new room before its snapshot arrives.
  if (session.isConnected) session.disconnect();
  resetLocalProject();
  session.connect(roomId);
}
```

Replace `leaveSession` (lines 586–592):

```ts
// Leave the current session: drop the connection, reset local state to a neutral
// project, and clear the room from the URL. Audio stays alive.
export function leaveSession(): void {
  session.disconnect();
  resetLocalProject();
  clearRoomFromUrl();
}
```

(`resetLocalProject` at lines 578–584 stays as-is.)

- [ ] **Step 6: Re-point `disposeSynth`, `applyFocusedTrack`, and the `useSynth()` return**

In `disposeSynth` (line 821), replace `teardownConnection();` → `session.dispose();`.

In `applyFocusedTrack` (line 943), replace `const room = currentRoomId.value;` → `const room = session.currentRoomId.value;`.

In the `useSynth()` return block (lines ~1006–1010), replace the three refs with the session's:

```ts
    // --- Sync surface (read by Sidebar / AccountView / ErrorOverlay) ---
    fatalError: session.fatalError,       // ref<{code,message}|null> — set on a fatal server error
    roomLoading: session.roomLoading,     // ref<boolean> — true while the room's initial catch-up runs
    roster,           // ref<Identity[]> — everyone in the room
    selfClientId,     // ref<string|null> — which roster entry is us
    currentRoomId: session.currentRoomId,
    sessionName,
```

- [ ] **Step 7: Typecheck**

Run: `cd packages/client && npm run typecheck`
Expected: exit 0.

If `useAuth()`'s return is rejected where `SyncSession`'s `auth: () => SyncAuth` is expected (structural mismatch on `accessToken`/`session`), widen `SyncAuth` in `SyncSession.ts` to match (e.g. make `accessToken: Ref<string | undefined>` accept a `ComputedRef`, which it already does since `ComputedRef<T>` is assignable to `Ref<T>`; if `session`'s element type is stricter, relax to `Ref<{ user: { id: string } } | null>` which `useAuth`'s `SessionLike` satisfies structurally). Do not change `useSynth`'s call — the dep is `auth: () => useAuth()`.

- [ ] **Step 8: Run the full client suite**

Run: `cd packages/client && npm test`
Expected: PASS. The existing `useSynth.test.ts` sync suites (`sync integration`, `session-scoped connection`, `variable track count`, `focused-track URL view-state`) all drive through the facade (`connectToSession`/`leaveSession`/`setWsClientFactory`/`synth.currentRoomId`/`synth.roomLoading`) and must pass unchanged. Net count grows by the 7 new `SyncSession` tests.

If any facade test fails, the swap diverged from today's behaviour — fix `SyncSession`/the delegators to match, do NOT edit the test.

- [ ] **Step 9: Verify the consumer surface is untouched**

Run: `git diff --stat main -- packages/client/src`
Expected: only `composables/useSynth.ts`, `sync/SyncSession.ts`, `sync/SyncSession.test.ts` appear. If any other `.vue`/`.ts` consumer shows up, a signature leaked — revert that and keep the facade stable.

- [ ] **Step 10: Commit**

```bash
git add packages/client/src/composables/useSynth.ts
git commit -m "$(cat <<'EOF'
refactor(sync): route useSynth through the SyncSession singleton (phase 3 task 2)

Delete the module-scope wsClient/outbox/commandBus/syncReady + currentRoomId/
roomLoading/fatalError refs, buildSyncState/teardownConnection/installAuthReconnect
Watcher/installLeaveFlushHandler; construct one eager SyncSession and rewrite the
sync exports (connectToSession/leaveSession/disposeSynth/dispatchLocal/endGesture/
the bulk sync*Diff emitters + the returned refs) as thin delegators. Facade is
byte-stable — no consumer file changes. Behaviour unchanged; existing facade
tests pass as-is.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DFmmWXyd9uJAiJ6cdbE4ir
EOF
)"
```

---

## Final verification (before finishing the branch)

Not a code task — the gate before merge (run after Task 2):

- [ ] **Full gate:** from repo root, `npm test && npm run typecheck` → all green.
- [ ] **Browser verification (local Docker DB only):** `docker compose up -d` then `npm run dev:obs`; confirm `DATABASE_URL` points at `postgres://fiddle:fiddle@localhost:5432/fiddle` (LOCAL) before touching anything. Two tabs on the same room, verify:
  - a knob/bpm edit in tab A converges to tab B (outbound + inbound still work);
  - **room switch** (A leaves room-a, joins room-b): no orphaned socket, no phantom member left in room-a's roster (the whole point of the extraction);
  - **reload restore**: reload tab A mid-session → snapshot repaints its state;
  - peer console is clean (no errors/warnings).
  - Close both tabs and stop the dev servers when done.
- [ ] **Finish the branch** via the `superpowers:finishing-a-development-branch` skill (present merge/PR options; the user drives merge/push cadence — do not auto-merge).

---

## Self-Review

**Spec coverage** (against `docs/superpowers/specs/2026-07-01-phase3-syncsession-design.md`):
- SyncSession owns WsClient/Outbox/CommandBus/presence → Task 1 class + `buildConnection`/`disconnect`. ✓
- Long-lived, cycles socket; reactive props on the session → Task 1 (`connect`/`disconnect`/`dispose` + `currentRoomId`/`roomLoading`/`fatalError` refs). ✓
- Bus built per-connection in `connect()` → `buildConnection`. ✓
- `dispose()` = flush → disconnect → clear presence, idempotent → `disconnect()`/`dispose()` + the idempotency test. ✓
- Constructor side-effect-free; installers lazy-once on first connect → Task 1 `install*` guards + the "no side effects" test. ✓
- URL + `resetLocalProject` stay in the wrapper → Task 2 Step 5. ✓
- Faithful control-flow (teardown → reset → build; `isConnected`-based `alreadyHere`; test-mode early return) → Task 2 Step 5 `connectToSession`. ✓
- Outbound funnel stays in `useSynth`, re-pointed at `session.enqueue` / `session.dispatchLocal` / `session.isSyncLive` → Task 2 Steps 3–4. ✓
- Facade byte-stable, no consumer changes → Task 2 Step 9 `git diff --stat` gate. ✓
- New `SyncSession.test.ts` incl. the idempotent-dispose test; existing facade tests unchanged → Task 1 test + Task 2 Step 8. ✓
- Explicit scope guard (no AppRuntime, no audio, no diffParams removal) → nothing in either task touches those. ✓

**Placeholder scan:** none — every step shows exact code/commands.

**Type consistency:** `SyncSessionDeps`, `SyncAuth`, `WsClientFactory`, `LocalCommand`, `Path`, method names (`connect`/`disconnect`/`dispose`/`dispatchLocal`/`enqueue`/`flushPath`/`flushAllPending`/`isConnected`/`isSyncLive`) are used identically in Task 1 (definition) and Task 2 (call sites). `session.enqueue(path, value, priorValue, gestureEnd)` matches its Task 1 signature at every emitter call site.
