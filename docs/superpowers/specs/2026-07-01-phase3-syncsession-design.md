# Phase 3 — Extract `SyncSession` (Design)

> Part of the **Lifecycle Architecture Redesign**
> (`docs/superpowers/specs/2026-06-27-lifecycle-architecture-design.md`).
> This is the detailed design for **Phase 3** of that spec's migration table.

**Goal:** Move the room-connection machinery (`WsClient`, `Outbox`, `CommandBus`,
presence, and the connect/leave/reconnect/dispose lifecycle) out of `useSynth.ts`
into a single long-lived `SyncSession` service with an idempotent `dispose()` —
behind the existing `useSynth` export surface, so no consumer file changes.

**Non-goal:** No `AppRuntime` (Phase 5). No `AudioEngine` extraction (Phase 4).
No removal of the `diffParams`/bulk-emitter machinery (Phase 4). Behavior is
byte-for-byte identical; this is a relocation, not a rewrite.

---

## Background — what lives in `useSynth.ts` today

The sync layer is a set of module-scope mutable singletons plus free functions,
all interleaved with audio in the ~1000-line `useSynth.ts` god-module:

- **Resources:** `wsClient: WsClient | null`, `outbox: Outbox | null`,
  `commandBus: CommandBus | null` (co-created in `buildSyncState`, nulled in
  `teardownConnection`); presence lives in `sync/presence.ts`.
- **Connection-scoped reactive state:** `currentRoomId`, `roomLoading`,
  `fatalError`, `syncReady` (a plain `let`).
- **Lifecycle functions:** `buildSyncState(roomId)` → `connectToSession` →
  `teardownConnection` → `leaveSession` → `disposeSynth`, plus
  `installAuthReconnectWatcher` (re-handshake the socket on login/logout) and
  `installLeaveFlushHandler` (`beforeunload` → `outbox.flushAllPending()`).
- **Outbound funnel:** `dispatchLocal`, `endGesture`, and the three bulk
  emitters `syncStepWindowDiff` / `syncWholeProjectDiff` / `syncEngineParamsDiff`
  (which drive the `diffParams`/`emitLeafDiff`/`emitMatrixDiff` machinery).

The problem this redesign targets: these singletons have **no owner and no
teardown**. Their lifetime is implicitly the module's, which is the root cause of
the orphaned-socket / phantom-presence class of bugs on reconnect and HMR.

### Consumer surface (must stay byte-stable)

The whole outbound + lifecycle surface consumers depend on is `useSynth`
**exports**, so Phase 3 can hide the extraction behind them:

- **Free functions imported directly:** `dispatchLocal` (Tracker, TrackMixer,
  knobSync, commandModel, + tests), `endGesture` (Tracker, TrackMixer, knobSync),
  `connectToSession` / `leaveSession` (App/Lobby/Studio), `syncStepWindowDiff` /
  `syncWholeProjectDiff` / `syncEngineParamsDiff` / `snapshotProjectForSync` /
  `cloneEngineSlice` / `ProjectSyncSnapshot` (StudioView), `setSyncEnabled` /
  `setWsClientFactory` (tests).
- **Reactive refs on the `useSynth()` return:** `currentRoomId`, `sessionName`
  (both read by `App.vue`); `roomLoading` / `fatalError` (studio loader + error
  overlay).

`sessionName` is **App-shell-owned** (App.vue sets it from `getSession()` on room
change; StudioView after a rename) and the sync path never touches it. It stays
exactly where it is — **not** part of `SyncSession`.

---

## Decisions taken during brainstorming

1. **Session shape: long-lived, cycles the socket.** One `SyncSession` object per
   tab, created once. `connect(roomId)` builds and opens the socket/outbox/bus
   internally; `disconnect()` tears the socket down but the object persists;
   `dispose()` is full teardown at page unload. Connection-scoped reactive state
   (`currentRoomId`/`roomLoading`/`fatalError`) lives as reactive props **on** the
   session. This matches the parent spec's lifecycle litmus table
   (`syncSession.connect`/`.disconnect`/`.dispose` are methods on one object) and
   drops cleanly into the Phase-5 `AppRuntime`, which holds exactly one session.
   *(Rejected: per-connection object created on join / disposed on leave — needs
   re-shaping again in Phase 5 and forces `currentRoomId` et al. to live outside
   the session anyway.)*

2. **Bus placement: session builds all three resources in `connect()`.**
   `wsClient` + `outbox` + `commandBus` are built inside `connect()` and dropped
   in `disconnect()` — a near-verbatim relocation of today's
   `buildSyncState`/`teardownConnection`. The bus stays created-per-connection
   (its opId watermark is per-connection, reset on snapshot as today). The parent
   spec's "separate CommandBus box" is honored **logically** (single writer,
   explicit origin) without physically rewiring the bus↔outbox relationship.
   *(Rejected: hoist bus+outbox to tab-lifetime peers now — more churn and risk
   for no behavior gain; Phase 5 can hoist later if it ever needs to.)*

3. **URL + local-project reset stay in the `useSynth` wrapper.** `SyncSession` is
   pure transport + connection state. Navigation (`setRoomInUrl` /
   `clearRoomFromUrl`) and store reset (`resetLocalProject` = `replaceProject(…,
   freshProject())`) are orchestrated by the thin `connectToSession` /
   `leaveSession` wrappers, not by the session.

4. **Eager module-load construction** of the singleton, so a lobby read of
   `session.currentRoomId` (which starts `null`) works before any `connect()`.

5. **Bulk `sync*Diff` emitters stay in `useSynth`** (deferred to Phase 4 with the
   rest of the `diffParams` machinery). Phase 3 only re-points their output guard
   at `session.isSyncLive` and their sends at `session.enqueue(...)`.

---

## Architecture

### New module — `sync/SyncSession.ts`

Imports only from `sync/*` (`WsClient`, `Outbox`, `CommandBus`,
`messageDispatch`, `presence`), `project/storage` (`replaceProject`), and
`@fiddle/shared` (`normalizeProject`, types). **No audio imports** → no dependency
cycle: `useSynth` imports `SyncSession`, `SyncSession` never imports `useSynth`.

```ts
export interface SyncSessionDeps {
  project: Project;                       // the reactive store (module `project`)
  wsClientFactory: () => WsClientFactory; // getter — honors setWsClientFactory (tests)
  syncEnabled: () => boolean;             // getter — honors setSyncEnabled (tests)
  auth: AuthApi;                          // useAuth() — token + identity for reconnect
}

export class SyncSession {
  constructor(deps: SyncSessionDeps);

  // Reactive connection state (re-exported through useSynth for consumers).
  readonly currentRoomId: Ref<string | null>;  // null in the lobby
  readonly roomLoading:   Ref<boolean>;
  readonly fatalError:    Ref<{ code: string; message: string } | null>;

  // Lifecycle.
  connect(roomId: string): void;  // build ws+outbox+bus; open with forceSnapshot (test-mode: just set currentRoomId)
  disconnect(): void;             // flush → ws.disconnect() → null resources → clear state+presence
  dispose(): void;                // idempotent full teardown (delegates to disconnect); page unload

  // Connection introspection (for the wrapper's room-switch / alreadyHere logic).
  get isConnected(): boolean;                  // wsClient != null (a live socket exists)

  // Outbound funnel (used by the useSynth delegators).
  dispatchLocal(cmd: LocalCommand): boolean;  // false when not connected → caller falls back to setDeep
  enqueue(path: Path, value: unknown, priorValue: unknown, gestureEnd: boolean): void; // gated on syncReady
  flushPath(path: Path): void;                 // endGesture (knob mouseup)
  flushAllPending(): void;                     // beforeunload
  get isSyncLive(): boolean;                   // outbox != null && syncReady
}
```

**Owned state (private):** `wsClient`, `outbox`, `commandBus` (all built in
`connect`, nulled in `disconnect`), and `syncReady` (a private connection-scoped
flag — moved out of `useSynth`, where it belongs).

**Owned side effects (installed once in the constructor):**

- **Auth-reconnect watcher** — `watch(() => auth.session.value?.user.id ?? null)`;
  on change, `wsClient?.reconnect()`. (Verbatim from
  `installAuthReconnectWatcher`; the once-guard is now the constructor.)
- **`beforeunload` flush** — `outbox?.flushAllPending()`. (Verbatim from
  `installLeaveFlushHandler`.)

### `connect(roomId)` body (from `buildSyncState` + the tail of `connectToSession`)

`connect` assumes it is called from a disconnected state — the wrapper closes any
previous socket **before** calling it (see the table below), preserving today's
`teardown → resetLocalProject → build` ordering. Its body:

1. If `!syncEnabled()`: set `currentRoomId = roomId` and return (test mode — no
   socket, no `roomLoading`, mirroring today's `if (!syncEnabled) { currentRoomId
   = roomId; return; }`).
2. `syncReady = false`; build `wsClient` (via `wsClientFactory()`), `outbox`,
   `commandBus` — exactly today's wiring: `onMessage` routes to
   `dispatchServerMessage(msg, { project, wsClient, outbox, commandBus,
   onFatalError, onSyncLive })`; `onStateChange` closed → `outbox.onClosed()`;
   the bus's `enqueue` gates on `syncReady`; `applySet` = `setDeep(project, …)`.
3. `currentRoomId = roomId`; `roomLoading = true`.
4. `wsClient.connect({ forceSnapshot: true })`.

`onSyncLive` sets `syncReady = true` + `roomLoading = false`. `onFatalError` sets
`fatalError` + `roomLoading = false`. The auth-reconnect watcher and
`beforeunload` flush are installed once in the constructor (not here), so
`connect` no longer calls `installAuthReconnectWatcher` /
`installLeaveFlushHandler`.

### `disconnect()` / `dispose()` body (from `teardownConnection`)

`outbox?.flushAllPending()` → `wsClient?.disconnect()` → null `wsClient` /
`outbox` / `commandBus` → `syncReady = false` → clear `fatalError` /
`roomLoading` / `currentRoomId` → `resetPresence()`. Idempotent: a second call
with everything already null is a clean no-op. `dispose()` is currently identical
to `disconnect()`; it exists as the Phase-5 lifecycle name and to give the
`AppRuntime` an unmistakable teardown entry point.

### `useSynth.ts` after extraction

A single eager singleton and thin delegators; every export keeps its signature:

```ts
const session = new SyncSession({
  project,
  wsClientFactory: () => wsClientFactory,   // module let, swappable by setWsClientFactory
  syncEnabled: () => syncEnabled,
  auth: useAuth(),
});
```

| Export (unchanged signature) | New body |
|---|---|
| `connectToSession(roomId, opts)` | preserves today's control flow verbatim (see below), swapping internals for session calls |
| `leaveSession()` | `session.disconnect()` + `resetLocalProject()` + `clearRoomFromUrl()` |
| `disposeSynth()` | audio teardown (unchanged) + `session.dispose()` |
| `dispatchLocal(path, value)` | `const gestureEnd = gestureEndForLeaf(...); if (!session.dispatchLocal({ path, value, priorValue: getDeep(project, path), gestureEnd })) setDeep(project, path, value)` |
| `endGesture(path)` | `session.flushPath(path)` |
| `syncStepWindowDiff` / `syncWholeProjectDiff` / `syncEngineParamsDiff` | diff machinery unchanged; guard becomes `if (!session.isSyncLive) return`; leaf/matrix ops sent via `session.enqueue(...)` |
| `currentRoomId` / `roomLoading` / `fatalError` on `useSynth()` return | re-exported from the singleton: `session.currentRoomId`, `session.roomLoading`, `session.fatalError` |
| `sessionName` | unchanged — App-shell-owned module ref |

`connectToSession` keeps today's exact control flow (this is what preserves the
`teardown → resetLocalProject → build` ordering and the test-mode early return):

```ts
const alreadyHere =
  !opts?.force && session.isConnected && session.currentRoomId.value === roomId;
setRoomInUrl(roomId, alreadyHere ? 'replace' : (opts?.history ?? 'replace'));
if (!syncEnabled) { session.connect(roomId); return; } // test mode: sets currentRoomId, no socket, no reset
if (alreadyHere) return;
if (session.isConnected) session.disconnect();          // close old socket first
resetLocalProject();                                    // then blank the store
session.connect(roomId);                                // then build + open the new socket
```

`session.isConnected` (`wsClient != null`) is what tells the wrapper whether a
socket exists — faithful to today's `!!wsClient`, and correct in `syncEnabled =
false` test mode (where `currentRoomId` is set but no socket exists). The wrapper
never reaches into the private `wsClient`.

**Deleted from `useSynth.ts`:** `wsClient` / `outbox` / `commandBus` module refs,
`syncReady`, `fatalError` / `roomLoading` / `currentRoomId` refs (now session
props), `buildSyncState`, `teardownConnection`, `installAuthReconnectWatcher`,
`installLeaveFlushHandler`, and the `authWatcherInstalled` / `leaveFlushInstalled`
guards.

---

## Data flow (unchanged)

Both directions are byte-identical to post-Phase-2; only the *owner* of the
objects changes.

- **Local edit:** `dispatchLocal(path,value)` → `session.dispatchLocal(cmd)` →
  `commandBus.dispatchLocal` → `applySet` (setDeep) + `outbox.enqueue` (gated on
  `syncReady`) → `WsClient.send`.
- **Remote op:** `WsClient.onMessage` → `dispatchServerMessage` →
  `commandBus.applyRemote` (opId watermark + `applySet`). No enqueue, no echo.
- **Snapshot:** `dispatchServerMessage` → `replaceProject(project,
  normalizeProject(msg.project))` → `resetWatermark()` → `reassertPending()`.

---

## Error handling

- **Fatal server error** (`session.not_found`, `overloaded`, …): `onFatalError`
  sets `session.fatalError` and clears `roomLoading`; the `ErrorOverlay` reads it
  through `useSynth` as today; the not-found→lobby bounce is unchanged (owned by
  the App shell, driven off `fatalError`).
- **Socket close / reconnect:** `onStateChange('closed')` → `outbox.onClosed()`
  (requeue in-flight → offline queue), unchanged. A room switch calls
  `disconnect()` **before** the new `connect()`, so no orphaned socket.
- **`dispose()` idempotency:** double-dispose (e.g. HMR then unload) is a no-op.

---

## Testing strategy

**New `sync/SyncSession.test.ts`** (uses the existing `makeFakeWsClient` pattern;
no `.vue` mounting):

- `connect(roomId)` opens the fake socket and requests a snapshot
  (`forceSnapshot: true`); `currentRoomId`/`roomLoading` reflect the connect.
- An inbound `set` routes to `commandBus.applyRemote`: state is written, nothing
  is enqueued to the outbox.
- `dispatchLocal(cmd)` while live writes state **and** enqueues; while
  disconnected returns `false` and does not throw.
- `enqueue` is gated on `syncReady` (nothing sent before `sync.complete`).
- `disconnect()` flushes pending → disconnects the socket → clears presence +
  reactive state; **`dispose()` is idempotent** (second call is a no-op). This is
  the test that would have caught the orphaned-transport bug.

**Existing `useSynth.test.ts`:** the facade tests (calling `connectToSession` /
`leaveSession` / `dispatchLocal` / the bulk emitters) keep passing unchanged
because behavior is identical. Tests that reach into now-deleted internals migrate
to `SyncSession.test.ts`. Net test count holds or grows.

**Gate + browser verification:** full `npm test` green; two-tab live verification
on the **local Docker DB** via `npm run dev:obs` (never `npm run dev` / prod) —
convergence of a knob edit, a room switch (no orphan / no phantom member), a
snapshot restore on reload, and a clean peer console — before merge.

---

## Success criteria

1. `SyncSession` owns `WsClient` + `Outbox` + `CommandBus` + presence; `useSynth`
   holds none of them directly.
2. `connect` / `disconnect` / `dispose` are the only lifecycle entry points;
   `dispose` is idempotent and exercised by a test.
3. Every `useSynth` export keeps its signature; the 11 consumer files are
   untouched (verified by `git diff --stat` showing no consumer changes).
4. Behavior is unchanged: full gate green + two-tab browser verification pass.
5. `useSynth.ts` shrinks by the extracted sync block; `sync/SyncSession.ts` +
   `sync/SyncSession.test.ts` are added.
