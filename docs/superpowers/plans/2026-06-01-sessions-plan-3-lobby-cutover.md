# Sessions — Plan 3: Client Lobby + Auto-mint Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace implicit auto-minted rooms with durable, lobby-created sessions: the server seeds each room from `SessionStore` (rejecting unknown ids), and the client gets a lobby home, a create dialog, session-scoped connect/leave, and an owner settings control.

**Architecture:** Two coordinated cutovers. (1) **Server:** `ConnectionHandler` gains an injected `SessionLoader` — on first join it loads the room's durable project from `SessionStore`; a missing session is rejected with a new fatal `session.not_found` error. Auto-mint is gone. (2) **Client:** the WS connection is decoupled from audio and made session-scoped (`connectToSession` / `leaveSession`); the router gains a `lobby` home; a `LobbyView` + create dialog consume the Plan 2 `/api/sessions` API; the studio gains Leave + an owner-only session-settings panel. A fatal `session.not_found` bounces the client to the lobby.

**Tech Stack:** Vue 3 + TypeScript + Vite (client), Fastify 5 (server), Vitest, `@fiddle/shared` (zod schemas + `LobbyEntry` wire type from Plan 2). `app.inject` for server route tests; `setWsClientFactory` + a fake socket for client sync tests; never mount `.vue` files.

**Spec:** `docs/superpowers/specs/2026-05-31-persistent-sessions-lobby-design.md`
**Builds on:** Plan 1 (`SessionStore`, `2026-05-31-sessions-plan-1-data-layer.md`) and Plan 2 (`/api/sessions`, `SessionSync`, `LobbyEntry`, `CreateSessionBodySchema`/`PatchSessionBodySchema`, `2026-05-31-sessions-plan-2-api-flusher.md`) — both already implemented on branch `feature/persistent-sessions-lobby`.

**Conventions to follow:**
- ESM NodeNext: import sibling `.ts` modules with a `.js` specifier (e.g. `./roomId.js`); cross-package via `@fiddle/shared`.
- Test logic/composables/pure helpers; **never mount `.vue` files** — `LobbyView.vue`, `CreateSessionDialog.vue`, and the studio template additions are not unit-tested; their logic lives in tested helpers/composables (`roomId.ts`, `sessionsApi.ts`, `useLobby.ts`, `useSynth.ts`).
- Gate before any merge: `npm run typecheck && npm test && npm run build`.
- Commit messages end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Commit ONLY the files listed per task. Never `git add -A`.

---

## Pre-flight context (existing code the implementer must know)

These already exist (do not recreate):

- **`packages/shared/src/protocol/types.ts`** — `ErrorCode` union (`'schema.version_mismatch' | … | 'internal'`) and `ErrorMessage { v, type, code, message, fatal }`.
- **`packages/shared`** exports (via `src/index.ts`): `Project`, `freshProject()`, `LobbyEntry`, `SessionSettings`, `DEFAULT_SESSION_SETTINGS` (`{ maxWritableUsers: 4, tracksPerUser: 4 }`), `CreateSessionBody` + `CreateSessionBodySchema`, `PatchSessionBody` + `PatchSessionBodySchema`, `SessionSettingsSchema`, `randomBase32`.
- **`packages/server/src/sync/ConnectionHandler.ts`** — constructor `(roomId, socket, store, pool, log, verify, profiles, heartbeat?)`. `handleHello` currently does `const { opIdHead } = await this.store.getOrCreate(this.roomId, freshProject)` then `cancelGrace`. `fatal(code, message)` sends a fatal `error` then closes 1008. `sendSnapshot` also calls `getOrCreate(roomId, freshProject)` (returns the already-seeded room). **No existing test passes a `heartbeat` arg** — verified — so a new param can slot before `heartbeat`.
- **`packages/server/src/room/RoomStore.ts` / `InMemoryRoomStore.ts`** — `getOrCreate(roomId, freshProject: () => Project)` only invokes the factory when the room is absent. Plan 2 added `peekProject(roomId): Promise<Project | null>` (null when not live; never resurrects), `listDirtyRoomIds`, `clearDirty`, `roomMemberCounts`.
- **`packages/server/src/session/SessionStore.ts`** — `get(id): Promise<SessionRecord | null>`, `getSnapshot(id): Promise<Project | null>`, `list`, `create`, `updateMeta`, `delete`. `SessionRecord { id, name, description, ownerUserId, ownerClientId, settings, createdAt, updatedAt }`.
- **`packages/server/src/routes/sessions.ts`** — `sessionsRoute(app, { sessions, verify, liveCounts })` with GET/POST/PATCH/DELETE `/api/sessions`. The `bearer(req)` + `claimsFrom(req, verify)` helpers live here. POST returns `{ id }` (201).
- **`packages/server/src/routes/ws.ts`** — `wsRoute(app, deps)` where `Deps { store, pool, verify, profiles, sessionSync }`. Constructs the handler with 7 args. `socket.on('close')` already calls `sessionSync.handleDisconnect`.
- **`packages/server/src/server.ts`** — `buildServer(): FastifyInstance`. Builds `sessions: SessionStore`, `sessionSync`, registers `sessionsRoute` + `wsRoute`. Must keep returning `FastifyInstance` (e2e types `app` as `ReturnType<typeof buildServer>`).
- **`packages/server/src/sync/protocol.e2e.test.ts`** — boots a real server (`app.listen({ port: 0 })`), `connect(roomId)` opens a real `WebSocket` to `/ws/<roomId>`, tests hardcode ids like `'e2e-handshake'`, `'e2e-broadcast'`. Excluded from `vitest run`; run via `npm run test:e2e`.
- **`packages/client/src/sync/roomId.ts`** — `generateRoomId()` and `resolveRoomIdFromUrl(loc)` which **auto-mints** (rewrites `/r/<fresh>` when absent). This auto-mint is what Plan 3 removes.
- **`packages/client/src/composables/useSynth.ts`** — module-scope `project` (reactive), `wsClient`, `outbox`, `fatalError` (`ref<{code,message}|null>`). `buildSyncState()` reads `resolveRoomIdFromUrl()` and builds `wsClient`/`outbox`, installs an auth-reconnect `watch`, calls `wsClient.connect()`. `ensureAudio()` calls `if (syncEnabled) buildSyncState()` after building audio. `disposeSynth()` tears down audio + sync. `setSyncEnabled(v)` and `setWsClientFactory(f)` are test seams. `endGesture(path)` exported. `useSynth()` returns `{ project, …, fatalError, roster, selfClientId }`.
- **`packages/client/src/sync/messageDispatch.ts`** — on a fatal `error` calls `deps.onFatalError(msg.code, msg.message)`; on `snapshot` does suppressed `replaceProject(project, msg.project)`.
- **`packages/client/src/sync/presence.ts`** — `resetPresence()`.
- **`packages/client/src/sync/WsClient.ts`** — `connect()`, `disconnect()`, `reconnect()`, persists per-room sync state under `fiddle:sync:<roomId>` in sessionStorage.
- **`packages/client/src/project/index.ts`** — re-exports `freshProject`, `replaceProject`, `serializeProject`, `deserializeProject`, `openProjectFromFile` (returns `Project | null`, throws `ProjectFileError`).
- **`packages/client/src/router/index.ts`** — `createMemoryHistory` router with `{ path: '/', redirect: '/studio' }`, `studio`, `account`. URL `/r/<id>` is owned out-of-band via `history.replaceState`.
- **`packages/client/src/auth/useAuth.ts`** — `useAuth()` returns `{ accessToken (ComputedRef<string|undefined>), session (Ref), isAuthenticated, signInWithGoogle, … }`.
- **`packages/client/vite.config.ts`** — dev proxy for `/ws` → `ws://localhost:8787`. **No `/api` proxy yet.**
- **`packages/client/src/composables/useSynth.test.ts`** — `bootWithFakeSocket()` does `resetModules → setWsClientFactory(fake) → setSyncEnabled(true) → disposeSynth() → useSynth() → await ensureAudio()`, relying on `ensureAudio()` to auto-build the socket. Stubs `window.location.pathname = '/r/testroom1'` + `history.replaceState`. **This helper must be updated in Task 6** because `ensureAudio()` will no longer auto-connect.

---

## File Structure

**New files:**
- `packages/client/src/sync/clientId.ts` — stable per-browser guest clientId (localStorage).
- `packages/client/src/sync/clientId.test.ts`
- `packages/client/src/sync/sessionsApi.ts` — typed HTTP client for `/api/sessions` (list/get/create/patch/delete) + API base resolution.
- `packages/client/src/sync/sessionsApi.test.ts`
- `packages/client/src/composables/useLobby.ts` — reactive session list + 3s polling.
- `packages/client/src/composables/useLobby.test.ts`
- `packages/client/src/views/LobbyView.vue` — lobby home (list, create button, click-to-join, empty state).
- `packages/client/src/components/CreateSessionDialog.vue` — create form (name/description, disabled settings, seed picker).
- `packages/server/src/routes/sessions.get-one.test.ts` — tests for the new `GET /api/sessions/:id`.

**Modified files:**
- `packages/shared/src/protocol/types.ts` — add `'session.not_found'` to `ErrorCode`.
- `packages/server/src/sync/ConnectionHandler.ts` — `SessionLoader` param + session-seeded room init + reject unknown.
- `packages/server/src/sync/ConnectionHandler.test.ts` — 2 new tests (reject unknown / seed from loader).
- `packages/server/src/routes/ws.ts` — thread `loadSession` into the handler.
- `packages/server/src/routes/sessions.ts` — add `GET /api/sessions/:id`.
- `packages/server/src/server.ts` — build the `loadSession` closure from `SessionStore`; pass to `wsRoute`.
- `packages/server/src/sync/protocol.e2e.test.ts` — create a session over HTTP before joining; add an unknown-session rejection test.
- `packages/client/src/sync/roomId.ts` — drop auto-mint; add `readRoomIdFromUrl` / `setRoomInUrl` / `clearRoomFromUrl` / `resolveInitialView`.
- `packages/client/src/sync/roomId.test.ts` — update for the no-mint API.
- `packages/client/src/composables/useSynth.ts` — decouple WS from audio; `connectToSession` / `leaveSession`; single auth watcher; expose `currentRoomId`.
- `packages/client/src/composables/useSynth.test.ts` — update `bootWithFakeSocket` to call `connectToSession`; add connect/leave tests.
- `packages/client/src/router/index.ts` — add `lobby` route; `/` redirects to `/lobby`.
- `packages/client/src/router/index.test.ts` — assert the lobby route.
- `packages/client/src/App.vue` — pick initial view from the URL; connect on load if a room is present; bounce to lobby on `session.not_found`.
- `packages/client/src/components/Sidebar.vue` — Lobby link + a Leave control when in a session.
- `packages/client/src/views/StudioView.vue` — Leave control + owner-only session-settings panel.
- `packages/client/vite.config.ts` — add `/api` dev proxy.
- `packages/client/.env.example` — document `VITE_API_URL`.

---

## Task 1: Add the `session.not_found` error code (shared)

**Files:**
- Modify: `packages/shared/src/protocol/types.ts`

- [ ] **Step 1: Extend the `ErrorCode` union**

In `packages/shared/src/protocol/types.ts`, add `'session.not_found'` to the union (after `'room.full'`):

```ts
export type ErrorCode =
  | 'schema.version_mismatch'
  | 'protocol.version_mismatch'
  | 'hello.invalid'
  | 'auth.invalid'
  | 'room.full'
  | 'session.not_found'
  | 'resume.unknown_client'
  | 'resume.client_ahead'
  | 'overloaded'
  | 'internal';
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (purely additive to a string-literal union).

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/protocol/types.ts
git commit -m "feat(shared): add session.not_found error code

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Server cutover — session-seeded room init + reject unknown

Removes auto-mint. On first join the room is seeded from the durable session; an
unknown session id is rejected with a fatal `session.not_found`. Done via an
injected `SessionLoader` so the existing handler tests (which pass no loader)
keep their behavior through a permissive default.

**Files:**
- Modify: `packages/server/src/sync/ConnectionHandler.ts`
- Modify: `packages/server/src/sync/ConnectionHandler.test.ts`
- Modify: `packages/server/src/routes/ws.ts`
- Modify: `packages/server/src/server.ts`
- Modify: `packages/server/src/sync/protocol.e2e.test.ts`

- [ ] **Step 1: Add the `SessionLoader` type + param to `ConnectionHandler`**

In `packages/server/src/sync/ConnectionHandler.ts`:

(a) Add `Project` to the existing `import type { … } from '@fiddle/shared';` block (the value imports `freshProject`, `validatePathAndValue`, etc. are already there; add the type):

```ts
import type {
  ErrorCode,
  ErrorMessage,
  HelloMessage,
  Identity,
  NackCode,
  NackMessage,
  PresenceUpdateMessage,
  Project,
  SetOpBroadcast,
  SnapshotMessage,
  SyncCompleteMessage,
  WelcomeMessage,
} from '@fiddle/shared';
```

(b) Add the loader type + default near the top of the file (after the `Log` type):

```ts
// Resolves the durable project for a room on first join. Returns null when no
// such session exists, which the handler turns into a fatal session.not_found.
// The default is permissive (every room "exists" with a fresh project) so unit
// tests that don't care about session lookup keep their pre-cutover behavior;
// production injects a SessionStore-backed loader (see server.ts).
export interface LoadedSession {
  project: Project;
}
export type SessionLoader = (roomId: string) => Promise<LoadedSession | null>;

const permissiveLoader: SessionLoader = async () => ({ project: freshProject() });
```

(c) Add the constructor param **before** the optional `heartbeat`:

```ts
  constructor(
    private readonly roomId: string,
    private readonly socket: SocketLike,
    private readonly store: RoomStore,
    private readonly pool: RoomConnectionPool,
    private readonly log: Log,
    private readonly verify: (token: string) => Promise<VerifiedClaims | null>,
    private readonly profiles: ProfileStore,
    private readonly loadSession: SessionLoader = permissiveLoader,
    heartbeat?: Heartbeat,
  ) {
    this.heartbeat = heartbeat ?? new Heartbeat(socket);
  }
```

- [ ] **Step 2: Seed the room from the session in `handleHello`**

In `handleHello`, replace this block:

```ts
    const { opIdHead } = await this.store.getOrCreate(this.roomId, freshProject);
    await this.store.cancelGrace(this.roomId);
```

with:

```ts
    // Session-scoped room init (Plan 3): a room is materialised only for a real
    // session. If it isn't already live in memory, load its durable project; a
    // null result means "no such session" — reject so the client bounces to the
    // lobby. Auto-mint is gone.
    let seed: () => Project = freshProject;
    const alreadyLive = (await this.store.peekProject(this.roomId)) !== null;
    if (!alreadyLive) {
      const loaded = await this.loadSession(this.roomId);
      if (!loaded) {
        this.fatal('session.not_found', `session ${this.roomId} does not exist`);
        return;
      }
      seed = () => loaded.project;
    }
    const { opIdHead } = await this.store.getOrCreate(this.roomId, seed);
    await this.store.cancelGrace(this.roomId);
```

(`sendSnapshot` is unchanged — by the time it runs the room exists, so its
`getOrCreate(this.roomId, freshProject)` returns the already-seeded project.)

- [ ] **Step 3: Add two handler tests**

In `packages/server/src/sync/ConnectionHandler.test.ts`, add a new describe block (the helpers `makeMockSocket`, `FakePool`, `noopLog`, `rejectAll`, `store`, `PROJECT_SCHEMA_VERSION`, `InMemoryProfileStore` are already imported/defined in this file — reuse them):

```ts
describe('session-scoped room init (Plan 3)', () => {
  it('rejects a hello for an unknown session with fatal session.not_found', async () => {
    const socket = makeMockSocket();
    const pool = new FakePool();
    pool.add('ghost', socket);
    // Loader returns null → no such session.
    const handler = new ConnectionHandler(
      'ghost', socket, store, pool, noopLog, rejectAll, new InMemoryProfileStore(),
      async () => null,
    );

    await handler.onMessage({ v: 1, type: 'hello', schemaVersion: PROJECT_SCHEMA_VERSION });

    const err = socket.sent.find((m) => m.type === 'error');
    expect(err && err.type === 'error' && err.code).toBe('session.not_found');
    expect(err && err.type === 'error' && err.fatal).toBe(true);
    expect(socket.closed).toBe(true);
    expect(socket.sent.find((m) => m.type === 'welcome')).toBeUndefined();
  });

  it('seeds the room snapshot from the session loader', async () => {
    const socket = makeMockSocket();
    const pool = new FakePool();
    pool.add('seeded', socket);
    const seeded = freshProject();
    seeded.bpm = 171;
    const handler = new ConnectionHandler(
      'seeded', socket, store, pool, noopLog, rejectAll, new InMemoryProfileStore(),
      async () => ({ project: seeded }),
    );

    await handler.onMessage({ v: 1, type: 'hello', schemaVersion: PROJECT_SCHEMA_VERSION });

    const snap = socket.sent.find((m) => m.type === 'snapshot');
    expect(snap && snap.type === 'snapshot' && snap.project.bpm).toBe(171);
  });
});
```

Add `freshProject` to this test file's `@fiddle/shared` import if not already present.

- [ ] **Step 4: Run the handler suite**

Run: `npm test --workspace @fiddle/server -- ConnectionHandler`
Expected: PASS — all pre-existing handler tests stay green (permissive default), plus the 2 new tests.

- [ ] **Step 5: Thread `loadSession` through the ws route**

In `packages/server/src/routes/ws.ts`:

(a) Add to imports:

```ts
import type { SessionLoader } from '../sync/ConnectionHandler.js';
```

(b) Add to the `Deps` interface:

```ts
  loadSession: SessionLoader;
```

(c) Pass it as the 8th arg when constructing the handler:

```ts
    const handler = new ConnectionHandler(
      roomId,
      adapted,
      deps.store,
      deps.pool,
      (msg, fields) => app.log.info(fields ?? {}, msg),
      deps.verify,
      deps.profiles,
      deps.loadSession,
    );
```

- [ ] **Step 6: Build the loader in `buildServer` and pass it to `wsRoute`**

In `packages/server/src/server.ts`:

(a) Ensure `freshProject` is imported from `@fiddle/shared` (add it if absent):

```ts
import { freshProject } from '@fiddle/shared';
```

(b) After `sessions` is constructed and before route registration, add the loader:

```ts
  // Production session loader: a room exists iff it has a session row. Seed its
  // in-memory project from the durable snapshot (falling back to a fresh project
  // for a session whose snapshot hasn't been flushed yet).
  const loadSession = async (roomId: string) => {
    const record = await sessions.get(roomId);
    if (!record) return null;
    const project = await sessions.getSnapshot(roomId);
    return { project: project ?? freshProject() };
  };
```

(c) Add `loadSession` to the `wsRoute` deps:

```ts
  app.register(async (a) => wsRoute(a, { store, pool, verify, profiles, sessionSync, loadSession }));
```

- [ ] **Step 7: Typecheck + unit suite**

Run: `npm run typecheck && npm test --workspace @fiddle/server`
Expected: PASS. (Default `vitest run` excludes the e2e suite.)

- [ ] **Step 8: Update the e2e suite to create-then-join**

The e2e now needs a real session before joining (auto-mint is gone). In
`packages/server/src/sync/protocol.e2e.test.ts`:

(a) Add a helper below `connect(...)` that creates a session over HTTP and returns its id:

```ts
async function createSession(): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'e2e', clientId: 'e2e-client' }),
  });
  if (res.status !== 201) throw new Error(`createSession failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}
```

(b) In **every** test that calls `connect('<literal>')`, replace the literal room
id with one created via `createSession()`. For tests where two clients share a
room, create the id once and pass it to both `connect(id)` calls. Example
(handshake test):

```ts
  it('fresh hello → welcome + snapshot + sync.complete', async () => {
    const room = await createSession();
    const c = connect(room);
    await c.opened;
    c.send({ v: 1, type: 'hello', schemaVersion: PROJECT_SCHEMA_VERSION });
    // … unchanged assertions …
  });
```

And the broadcast/presence/resume tests:

```ts
    const room = await createSession();
    const a = connect(room);
    // …
    const b = connect(room);
```

(c) Add one new test asserting the cutover rejects unknown sessions:

```ts
  it('rejects a hello for a session that was never created', async () => {
    const c = connect('never-created-x');
    await c.opened;
    c.send({ v: 1, type: 'hello', schemaVersion: PROJECT_SCHEMA_VERSION });
    const err = await c.waitFor((m) => m.type === 'error');
    if (err.type !== 'error') throw new Error('unreachable');
    expect(err.code).toBe('session.not_found');
    expect(err.fatal).toBe(true);
    c.close();
  });
```

- [ ] **Step 9: Run the e2e suite**

Run: `npm run test:e2e`
Expected: PASS — every test creates its session first; the new rejection test passes.

- [ ] **Step 10: Commit**

```bash
git add packages/server/src/sync/ConnectionHandler.ts packages/server/src/sync/ConnectionHandler.test.ts packages/server/src/routes/ws.ts packages/server/src/server.ts packages/server/src/sync/protocol.e2e.test.ts
git commit -m "feat(server): seed rooms from SessionStore; reject unknown sessions (cutover)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `GET /api/sessions/:id` (single record)

The studio needs a session's name/description/settings + owner fields to render
and authorize the owner settings panel (a deep-linked `/r/<id>` has no lobby
entry). Add a public single-record endpoint.

**Files:**
- Modify: `packages/server/src/routes/sessions.ts`
- Create: `packages/server/src/routes/sessions.get-one.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/routes/sessions.get-one.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { freshProject, DEFAULT_SESSION_SETTINGS } from '@fiddle/shared';
import { InMemorySessionStore } from '../session/InMemorySessionStore.js';
import { sessionsRoute } from './sessions.js';
import type { VerifiedClaims } from '../auth/verifyToken.js';

const fakeVerify = async (): Promise<VerifiedClaims | null> => null;

function build(sessions = new InMemorySessionStore()) {
  const app = Fastify();
  app.register(async (a) =>
    sessionsRoute(a, { sessions, verify: fakeVerify, liveCounts: async () => new Map() }),
  );
  return { app, sessions };
}

describe('GET /api/sessions/:id', () => {
  it('returns the record (metadata + owner fields, no project) for a known id', async () => {
    const { app, sessions } = build();
    await sessions.create({
      id: 'abc', name: 'Jam', description: 'd', ownerUserId: null, ownerClientId: 'c1',
      settings: DEFAULT_SESSION_SETTINGS, project: freshProject(),
    });
    const res = await app.inject({ method: 'GET', url: '/api/sessions/abc' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      id: 'abc', name: 'Jam', description: 'd',
      ownerUserId: null, ownerClientId: 'c1', isGuestOwned: true,
    });
    expect(body.settings).toEqual(DEFAULT_SESSION_SETTINGS);
    expect(body.project).toBeUndefined(); // never ships the blob
    await app.close();
  });

  it('returns 404 for an unknown id', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'GET', url: '/api/sessions/nope' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @fiddle/server -- sessions.get-one`
Expected: FAIL — route returns 404 (or Fastify "not found") for the known id because the endpoint doesn't exist yet.

- [ ] **Step 3: Add the route**

In `packages/server/src/routes/sessions.ts`, add this handler inside
`sessionsRoute`, right after the `GET /api/sessions` (list) handler:

```ts
  // Single session metadata (no project blob). Public; powers the studio's
  // session-settings panel + deep-link ownership checks.
  app.get('/api/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const record = await deps.sessions.get(id);
    if (!record) return reply.code(404).send({ error: 'not found' });
    return {
      id: record.id,
      name: record.name,
      description: record.description,
      ownerUserId: record.ownerUserId,
      ownerClientId: record.ownerClientId,
      isGuestOwned: record.ownerUserId === null,
      settings: record.settings,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @fiddle/server -- sessions.get-one`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/routes/sessions.ts packages/server/src/routes/sessions.get-one.test.ts
git commit -m "feat(server): GET /api/sessions/:id single-record endpoint

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Client navigation helpers — drop auto-mint

`roomId.ts` becomes pure URL plumbing: read the room from the URL (no minting),
set/clear it, and resolve the initial view. Auto-mint is removed because rooms
are created only via the lobby now.

**Files:**
- Modify: `packages/client/src/sync/roomId.ts`
- Modify: `packages/client/src/sync/roomId.test.ts`

- [ ] **Step 1: Update the tests first**

Replace the body of `packages/client/src/sync/roomId.test.ts` with:

```ts
import { describe, it, expect } from 'vitest';
import { readRoomIdFromUrl, resolveInitialView } from './roomId';

describe('readRoomIdFromUrl', () => {
  it('extracts the room id from /r/<id>', () => {
    expect(readRoomIdFromUrl({ pathname: '/r/j7k2mq8n3' } as Location)).toBe('j7k2mq8n3');
  });

  it('matches case-insensitively and normalizes to lowercase', () => {
    expect(readRoomIdFromUrl({ pathname: '/r/J7K2MQ8N3' } as Location)).toBe('j7k2mq8n3');
  });

  it('returns null when the URL has no room (no auto-mint)', () => {
    expect(readRoomIdFromUrl({ pathname: '/' } as Location)).toBeNull();
    expect(readRoomIdFromUrl({ pathname: '/lobby' } as Location)).toBeNull();
  });
});

describe('resolveInitialView', () => {
  it('is studio when a room is present, lobby otherwise', () => {
    expect(resolveInitialView({ pathname: '/r/j7k2mq8n3' } as Location)).toBe('studio');
    expect(resolveInitialView({ pathname: '/' } as Location)).toBe('lobby');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @fiddle/client -- sync/roomId`
Expected: FAIL — `readRoomIdFromUrl` / `resolveInitialView` not exported.

- [ ] **Step 3: Rewrite `roomId.ts`**

Replace `packages/client/src/sync/roomId.ts` with:

```ts
// Room IDs are short, URL-safe identifiers used both as the routing token
// (`/r/<roomId>`) and as the key under which the server stores room state.
//
// Plan 3: rooms are created only via the lobby (POST /api/sessions returns the
// id), so the client no longer mints ids from the URL. These helpers are pure
// URL plumbing: read the current room, set it when entering a session, clear it
// when leaving.

const ROOM_RE = /^\/r\/([0-9a-z]{6,12})/i;

// The room id in the current URL (`/r/<id>`), or null if none. Case-insensitive,
// normalized to lowercase (the server keys rooms by exact string). `loc` is
// injectable for testing without touching jsdom's history mock.
export function readRoomIdFromUrl(loc: Location = window.location): string | null {
  const m = loc.pathname.match(ROOM_RE);
  return m ? m[1].toLowerCase() : null;
}

// Which in-app view a fresh load lands on, derived from the URL: a `/r/<id>`
// deep-link opens the studio; anything else opens the lobby.
export function resolveInitialView(loc: Location = window.location): 'studio' | 'lobby' {
  return readRoomIdFromUrl(loc) ? 'studio' : 'lobby';
}

// Rewrite the address bar to `/r/<id>` without a navigation (memory-history
// router handles view switching; the URL is just the shareable session token).
export function setRoomInUrl(roomId: string): void {
  window.history.replaceState(null, '', `/r/${roomId}`);
}

// Drop the room from the address bar when returning to the lobby.
export function clearRoomFromUrl(): void {
  window.history.replaceState(null, '', '/');
}
```

(`generateRoomId` is intentionally removed — the client no longer generates ids.
Grep confirms its only caller was the old auto-mint path.)

- [ ] **Step 4: Confirm no stale imports of removed symbols**

Run: `grep -rn "resolveRoomIdFromUrl\|generateRoomId" packages/client/src`
Expected: the only hits are in `useSynth.ts` (fixed in Task 6). If any other file
references them, it must be updated; none should remain after Task 6.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test --workspace @fiddle/client -- sync/roomId`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/sync/roomId.ts packages/client/src/sync/roomId.test.ts
git commit -m "feat(client): URL room helpers without auto-mint

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Client session API client + guest clientId + dev proxy

**Files:**
- Create: `packages/client/src/sync/clientId.ts`
- Create: `packages/client/src/sync/clientId.test.ts`
- Create: `packages/client/src/sync/sessionsApi.ts`
- Create: `packages/client/src/sync/sessionsApi.test.ts`
- Modify: `packages/client/vite.config.ts`
- Modify: `packages/client/.env.example`

- [ ] **Step 1: Write the guest-clientId test**

Create `packages/client/src/sync/clientId.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('guestClientId', () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    });
    vi.resetModules();
  });

  it('mints once and is stable across calls', async () => {
    const { guestClientId } = await import('./clientId');
    const a = guestClientId();
    const b = guestClientId();
    expect(a).toBe(b);
    expect(a).toMatch(/^g_[0-9a-z]+$/);
  });

  it('reuses a previously persisted id', async () => {
    store.set('fiddle:clientId', 'g_existing');
    const { guestClientId } = await import('./clientId');
    expect(guestClientId()).toBe('g_existing');
  });
});
```

- [ ] **Step 2: Implement `clientId.ts`**

Create `packages/client/src/sync/clientId.ts`:

```ts
// A stable per-browser guest identity, persisted in localStorage. Sent as the
// `clientId` when a guest creates a session (POST /api/sessions) and matched
// when a guest edits its own session's settings (PATCH). Distinct from the
// per-room WS clientId (minted server-side, lives in sessionStorage).
import { randomBase32 } from '@fiddle/shared';

const KEY = 'fiddle:clientId';

export function guestClientId(): string {
  const existing = localStorage.getItem(KEY);
  if (existing) return existing;
  const fresh = `g_${randomBase32(12)}`;
  localStorage.setItem(KEY, fresh);
  return fresh;
}
```

- [ ] **Step 3: Run the clientId test**

Run: `npm test --workspace @fiddle/client -- sync/clientId`
Expected: PASS (2 tests).

- [ ] **Step 4: Write the sessionsApi test**

Create `packages/client/src/sync/sessionsApi.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listSessions, getSession, createSession, patchSession, deleteSession } from './sessionsApi';

function mockFetch(impl: (url: string, init?: RequestInit) => Partial<Response> & { json?: () => Promise<unknown> }) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const r = impl(url, init);
    return { ok: true, status: 200, json: async () => ({}), ...r } as Response;
  }));
}

beforeEach(() => { vi.unstubAllGlobals(); });

describe('sessionsApi', () => {
  it('listSessions unwraps { sessions }', async () => {
    mockFetch(() => ({ json: async () => ({ sessions: [{ id: 'a' }, { id: 'b' }] }) }));
    const out = await listSessions();
    expect(out.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('getSession returns null on 404', async () => {
    mockFetch(() => ({ ok: false, status: 404 }));
    expect(await getSession('nope')).toBeNull();
  });

  it('createSession POSTs the body + bearer token and returns the id', async () => {
    let seen: { url: string; init?: RequestInit } | null = null;
    mockFetch((url, init) => { seen = { url, init }; return { status: 201, json: async () => ({ id: 'new9chars' }) }; });
    const id = await createSession({ name: 'Jam', description: '', seed: 'default' } as any, 'tok-1');
    expect(id).toBe('new9chars');
    expect(seen!.init?.method).toBe('POST');
    expect((seen!.init?.headers as Record<string, string>).authorization).toBe('Bearer tok-1');
    expect(JSON.parse(seen!.init?.body as string)).toMatchObject({ name: 'Jam' });
  });

  it('createSession omits the auth header for guests', async () => {
    let headers: Record<string, string> = {};
    mockFetch((_url, init) => { headers = init?.headers as Record<string, string>; return { status: 201, json: async () => ({ id: 'x' }) }; });
    await createSession({ name: 'g', description: '', seed: 'default', clientId: 'g_1' } as any);
    expect(headers.authorization).toBeUndefined();
  });

  it('patchSession sends PATCH and resolves on 204', async () => {
    let method = '';
    mockFetch((_url, init) => { method = init?.method ?? ''; return { ok: true, status: 204 }; });
    await patchSession('a', { name: 'renamed' }, 'tok');
    expect(method).toBe('PATCH');
  });

  it('deleteSession sends DELETE', async () => {
    let method = '';
    mockFetch((_url, init) => { method = init?.method ?? ''; return { ok: true, status: 204 }; });
    await deleteSession('a', 'tok');
    expect(method).toBe('DELETE');
  });

  it('throws on a non-ok create', async () => {
    mockFetch(() => ({ ok: false, status: 400, json: async () => ({ error: 'bad' }) }));
    await expect(createSession({ name: '', description: '', seed: 'default' } as any)).rejects.toThrow();
  });
});
```

- [ ] **Step 5: Implement `sessionsApi.ts`**

Create `packages/client/src/sync/sessionsApi.ts`:

```ts
// Typed HTTP client for the /api/sessions API (Plan 2). Same-origin in dev via
// the Vite /api proxy; cross-origin in prod via VITE_API_URL (client on Vercel,
// server on Render). Request shapes reuse the shared zod-inferred types so the
// client and server validate against one contract.
import type { LobbyEntry, CreateSessionBody, PatchSessionBody, SessionSettings } from '@fiddle/shared';

const API_BASE = (
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_API_URL ?? ''
).replace(/\/$/, '');

function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

function headers(token?: string, json = false): Record<string, string> {
  const h: Record<string, string> = {};
  if (json) h['content-type'] = 'application/json';
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

// The single-record shape from GET /api/sessions/:id (metadata + owner fields).
export interface SessionMeta {
  id: string;
  name: string;
  description: string;
  ownerUserId: string | null;
  ownerClientId: string | null;
  isGuestOwned: boolean;
  settings: SessionSettings;
  createdAt: string;
  updatedAt: string;
}

export async function listSessions(): Promise<LobbyEntry[]> {
  const res = await fetch(apiUrl('/api/sessions'));
  if (!res.ok) throw new Error(`list sessions failed: ${res.status}`);
  const body = (await res.json()) as { sessions: LobbyEntry[] };
  return body.sessions;
}

export async function getSession(id: string): Promise<SessionMeta | null> {
  const res = await fetch(apiUrl(`/api/sessions/${id}`));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`get session failed: ${res.status}`);
  return (await res.json()) as SessionMeta;
}

export async function createSession(body: CreateSessionBody, token?: string): Promise<string> {
  const res = await fetch(apiUrl('/api/sessions'), {
    method: 'POST',
    headers: headers(token, true),
    body: JSON.stringify(body),
  });
  if (res.status !== 201) {
    throw new Error(`create session failed: ${res.status}`);
  }
  const { id } = (await res.json()) as { id: string };
  return id;
}

export async function patchSession(id: string, patch: PatchSessionBody, token?: string): Promise<void> {
  const res = await fetch(apiUrl(`/api/sessions/${id}`), {
    method: 'PATCH',
    headers: headers(token, true),
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`patch session failed: ${res.status}`);
}

export async function deleteSession(id: string, token?: string): Promise<void> {
  const res = await fetch(apiUrl(`/api/sessions/${id}`), {
    method: 'DELETE',
    headers: headers(token),
  });
  if (!res.ok) throw new Error(`delete session failed: ${res.status}`);
}
```

- [ ] **Step 6: Run the sessionsApi test**

Run: `npm test --workspace @fiddle/client -- sync/sessionsApi`
Expected: PASS (7 tests).

- [ ] **Step 7: Add the `/api` dev proxy + document the env var**

In `packages/client/vite.config.ts`, add an `/api` entry alongside `/ws`:

```ts
    proxy: {
      '/ws': {
        target: 'ws://localhost:8787',
        ws: true,
        changeOrigin: true,
      },
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
```

In `packages/client/.env.example`, add (near the `VITE_WS_URL` doc):

```
# Production-only: the server origin for the HTTP API when the client is served
# from a different origin (client on Vercel, server on Render). Leave UNSET in
# local dev — Vite proxies /api → :8787. Example: VITE_API_URL=https://<render-host>
# VITE_API_URL=
```

- [ ] **Step 8: Commit**

```bash
git add packages/client/src/sync/clientId.ts packages/client/src/sync/clientId.test.ts packages/client/src/sync/sessionsApi.ts packages/client/src/sync/sessionsApi.test.ts packages/client/vite.config.ts packages/client/.env.example
git commit -m "feat(client): sessions HTTP client + guest clientId + /api dev proxy

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: `useSynth` — session-scoped connect/leave (decouple WS from audio)

The WS connection becomes explicit and session-scoped, and is no longer triggered
by `ensureAudio()` (so entering a session connects without an AudioContext, and
audio still boots lazily on first PLAY).

**Files:**
- Modify: `packages/client/src/composables/useSynth.ts`
- Modify: `packages/client/src/composables/useSynth.test.ts`

- [ ] **Step 1: Refactor `useSynth.ts`**

(a) Update imports — drop `resolveRoomIdFromUrl`, add the new room helpers,
`freshProject`, `replaceProject`, and `ref` is already imported:

```ts
import { setRoomInUrl, clearRoomFromUrl } from '../sync/roomId';
```

Add `freshProject` and `replaceProject` to the existing `'../project'` import block:

```ts
import {
  type Project,
  type ProjectTrack,
  type EngineType,
  loadProject,
  installAutoSave,
  freshProject,
  replaceProject,
} from '../project';
```

(b) Add module-scope room tracking next to `wsClient` / `outbox`:

```ts
// The room this tab is currently connected to (null in the lobby). A ref so the
// shell/sidebar can react (e.g. show the Leave control only inside a session).
const currentRoomId = ref<string | null>(null);
let authWatcherInstalled = false;
```

(c) Change `buildSyncState()` to take an explicit `roomId` and drop the URL read.
Replace its first lines:

```ts
function buildSyncState(): void {
  if (wsClient) return;
  const roomId = resolveRoomIdFromUrl();
  const envUrl = …
```

with:

```ts
function buildSyncState(roomId: string): void {
  if (wsClient) return;
  const envUrl = (import.meta as unknown as { env?: Record<string, string | undefined> })
    .env?.VITE_WS_URL;
```

(everything else in the function body is unchanged: it already uses `roomId` to
build `wsUrl` and passes `roomId` to the factory). Then **move the auth-reconnect
`watch` out** of `buildSyncState` into its own idempotent installer so reconnecting
on each new session doesn't stack watchers. Delete the `watch(() => auth.session…)`
block at the end of `buildSyncState` and add this function below it:

```ts
// Installed once (the shell never unmounts). Re-handshakes the live socket when
// the user logs in/out so the server re-derives identity. Watches the user id,
// not the token (Supabase refreshes the token silently).
function installAuthReconnectWatcher(): void {
  if (authWatcherInstalled) return;
  authWatcherInstalled = true;
  const auth = useAuth();
  watch(
    () => auth.session.value?.user.id ?? null,
    (next, prev) => {
      if (next === prev) return;
      wsClient?.reconnect();
    },
  );
}
```

(d) Add a connection teardown helper + the public `connectToSession` /
`leaveSession`, placed near `buildSyncState`:

```ts
// Tear down only the room connection (audio stays alive). Shared by leaveSession,
// room-switching, and disposeSynth.
function teardownConnection(): void {
  if (wsClient) {
    wsClient.disconnect();
    wsClient = null;
  }
  outbox = null;
  fatalError.value = null;
  currentRoomId.value = null;
  resetPresence();
}

// Enter a session: bring up the room connection for `roomId` and reflect it in
// the URL. Idempotent for the same room; switches cleanly between rooms. Does
// NOT touch audio — the AudioContext still boots lazily on first PLAY.
export function connectToSession(roomId: string): void {
  setRoomInUrl(roomId);
  if (!syncEnabled) { currentRoomId.value = roomId; return; }
  if (wsClient && currentRoomId.value === roomId) return;
  if (wsClient) teardownConnection();
  currentRoomId.value = roomId;
  installAuthReconnectWatcher();
  buildSyncState(roomId);
  wsClient!.connect();
}

// Leave the current session: drop the connection, reset local state to a neutral
// project, and clear the room from the URL. Audio stays alive.
export function leaveSession(): void {
  teardownConnection();
  replaceProject(project, freshProject());
  resetApplyOpState();
  clearRoomFromUrl();
}
```

Note: `wsClient.connect()` moves OUT of `buildSyncState` into `connectToSession`
(remove the `wsClient.connect();` line that was inside `buildSyncState`).

(e) Remove the auto-connect from `ensureAudio()`. Change:

```ts
    bootstrapping = buildAudioState().then(s => {
      audioState.value = s;
      if (syncEnabled) buildSyncState();
      return s;
    });
```

to:

```ts
    bootstrapping = buildAudioState().then(s => {
      audioState.value = s;
      return s;
    });
```

(f) Update `disposeSynth()` to use `teardownConnection()` — replace the inline
sync-teardown block:

```ts
  // Tear down the sync layer too so a re-init (or a test) starts clean.
  if (wsClient) {
    wsClient.disconnect();
    wsClient = null;
  }
  outbox = null;
  fatalError.value = null;
  resetApplyOpState();
  resetPresence();
```

with:

```ts
  // Tear down the sync layer too so a re-init (or a test) starts clean.
  teardownConnection();
  resetApplyOpState();
```

(g) Expose `currentRoomId` and the two new actions from `useSynth()`'s return
object (add to the `--- Sync surface ---` group). `connectToSession` /
`leaveSession` are module-scope exports; surfacing them here lets the shell and
sidebar call them via the injected context:

```ts
    fatalError,
    roster,
    selfClientId,
    currentRoomId,    // ref<string|null> — the connected room, null in the lobby
    connectToSession, // (roomId: string) => void
    leaveSession,     // () => void
```

- [ ] **Step 2: Update `useSynth.test.ts` for explicit connect**

In `packages/client/src/composables/useSynth.test.ts`, update `bootWithFakeSocket`
so it connects explicitly (since `ensureAudio()` no longer auto-connects):

```ts
  async function bootWithFakeSocket() {
    try { localStorage.removeItem('fiddle:project'); } catch {}
    vi.resetModules();
    const mod = await import('./useSynth');
    let fake: ReturnType<typeof makeFakeWsClient>;
    mod.setWsClientFactory((o: any) => { fake = makeFakeWsClient(o); return fake as any; });
    mod.setSyncEnabled(true);
    mod.disposeSynth();
    const synth = mod.useSynth();
    await synth.ensureAudio();
    mod.connectToSession('testroom1'); // explicit now (was auto on ensureAudio)
    return { mod, synth, fake: fake! };
  }
```

All existing assertions in the `sync integration` block continue to hold (the
fake socket is created by `connectToSession` via the factory). Then add a new
describe block exercising connect/leave:

```ts
describe('session-scoped connection', () => {
  function makeFakeWsClient(opts: any) {
    let seq = 0;
    return {
      _opts: opts, sent: [] as any[],
      connect: vi.fn(), disconnect: vi.fn(), reconnect: vi.fn(),
      send(op: any) { this.sent.push(op); },
      isLive: () => true, nextClientSeq: () => ++seq,
      recordOpIdSeen: vi.fn(), getPersisted: () => null,
    };
  }

  beforeEach(() => {
    vi.stubGlobal('window', { location: { pathname: '/' }, history: { replaceState: vi.fn() } });
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173', pathname: '/' });
  });

  async function boot() {
    try { localStorage.removeItem('fiddle:project'); } catch {}
    vi.resetModules();
    const mod = await import('./useSynth');
    const built: any[] = [];
    mod.setWsClientFactory((o: any) => { const f = makeFakeWsClient(o); built.push(f); return f as any; });
    mod.setSyncEnabled(true);
    mod.disposeSynth();
    const synth = mod.useSynth();
    return { mod, synth, built };
  }

  it('connectToSession builds + connects a socket for the room and tracks currentRoomId', async () => {
    const { mod, synth, built } = await boot();
    mod.connectToSession('room-a');
    expect(built).toHaveLength(1);
    expect(built[0]._opts.roomId).toBe('room-a');
    expect(built[0].connect).toHaveBeenCalledTimes(1);
    expect(synth.currentRoomId.value).toBe('room-a');
  });

  it('is idempotent for the same room', async () => {
    const { mod, built } = await boot();
    mod.connectToSession('room-a');
    mod.connectToSession('room-a');
    expect(built).toHaveLength(1);
  });

  it('switching rooms disconnects the old socket and builds a new one', async () => {
    const { mod, synth, built } = await boot();
    mod.connectToSession('room-a');
    mod.connectToSession('room-b');
    expect(built).toHaveLength(2);
    expect(built[0].disconnect).toHaveBeenCalled();
    expect(built[1]._opts.roomId).toBe('room-b');
    expect(synth.currentRoomId.value).toBe('room-b');
  });

  it('leaveSession disconnects, clears currentRoomId, and resets the project', async () => {
    const { mod, synth, built } = await boot();
    mod.connectToSession('room-a');
    synth.project.bpm = 199;
    mod.leaveSession();
    expect(built[0].disconnect).toHaveBeenCalled();
    expect(synth.currentRoomId.value).toBeNull();
    expect(synth.project.bpm).toBe(120); // fresh project default
  });
});
```

- [ ] **Step 3: Run the useSynth suite**

Run: `npm test --workspace @fiddle/client -- composables/useSynth`
Expected: PASS — the updated `sync integration` tests + the 4 new connection tests.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/composables/useSynth.ts packages/client/src/composables/useSynth.test.ts
git commit -m "feat(client): session-scoped connectToSession/leaveSession

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Lobby route + `useLobby` composable + LobbyView + create dialog

**Files:**
- Modify: `packages/client/src/router/index.ts`
- Modify: `packages/client/src/router/index.test.ts`
- Create: `packages/client/src/composables/useLobby.ts`
- Create: `packages/client/src/composables/useLobby.test.ts`
- Create: `packages/client/src/views/LobbyView.vue`
- Create: `packages/client/src/components/CreateSessionDialog.vue`

- [ ] **Step 1: Add the lobby route + update its test**

In `packages/client/src/router/index.ts`, add the import and route, and point `/`
at the lobby:

```ts
import { createRouter, createMemoryHistory } from 'vue-router';
import LobbyView from '../views/LobbyView.vue';
import StudioView from '../views/StudioView.vue';
import AccountView from '../views/AccountView.vue';

export const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/', redirect: '/lobby' },
    { path: '/lobby', name: 'lobby', component: LobbyView },
    { path: '/studio', name: 'studio', component: StudioView },
    { path: '/account', name: 'account', component: AccountView },
  ],
});
```

Update `packages/client/src/router/index.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { router } from './index';

describe('router', () => {
  it('redirects / to /lobby', () => {
    const route = router.getRoutes().find((r) => r.path === '/');
    expect(route?.redirect).toBe('/lobby');
  });

  it('registers /lobby, /studio and /account routes', () => {
    const paths = router.getRoutes().map((r) => r.path);
    expect(paths).toContain('/lobby');
    expect(paths).toContain('/studio');
    expect(paths).toContain('/account');
  });
});
```

- [ ] **Step 2: Run the router test (will fail to import until LobbyView exists)**

Run: `npm test --workspace @fiddle/client -- router/index`
Expected: FAIL — cannot resolve `../views/LobbyView.vue` (created in Step 6). This
is expected; proceed.

- [ ] **Step 3: Write the `useLobby` test**

Create `packages/client/src/composables/useLobby.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../sync/sessionsApi', () => ({
  listSessions: vi.fn(),
}));
import { listSessions } from '../sync/sessionsApi';
import { useLobby } from './useLobby';

const mockList = listSessions as unknown as ReturnType<typeof vi.fn>;

describe('useLobby', () => {
  beforeEach(() => { vi.useFakeTimers(); mockList.mockReset(); });
  afterEach(() => { vi.useRealTimers(); });

  it('refresh populates sessions and clears loading', async () => {
    mockList.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    const { sessions, loading, refresh } = useLobby();
    const p = refresh();
    expect(loading.value).toBe(true);
    await p;
    expect(loading.value).toBe(false);
    expect(sessions.value.map((s: any) => s.id)).toEqual(['a', 'b']);
  });

  it('captures an error message on failure', async () => {
    mockList.mockRejectedValue(new Error('boom'));
    const { error, refresh } = useLobby();
    await refresh();
    expect(error.value).toContain('boom');
  });

  it('startPolling refreshes immediately and on the interval; stopPolling halts it', async () => {
    mockList.mockResolvedValue([]);
    const { startPolling, stopPolling } = useLobby();
    startPolling(3000);
    expect(mockList).toHaveBeenCalledTimes(1); // immediate
    await vi.advanceTimersByTimeAsync(3000);
    expect(mockList).toHaveBeenCalledTimes(2);
    stopPolling();
    await vi.advanceTimersByTimeAsync(6000);
    expect(mockList).toHaveBeenCalledTimes(2); // no more after stop
  });
});
```

- [ ] **Step 4: Implement `useLobby.ts`**

Create `packages/client/src/composables/useLobby.ts`:

```ts
import { ref, type Ref } from 'vue';
import type { LobbyEntry } from '@fiddle/shared';
import { listSessions } from '../sync/sessionsApi';

// Reactive lobby state: the session list plus a poll loop for live member counts.
// Logic-only (no DOM) so it is unit-testable; LobbyView wires it to lifecycle.
export function useLobby() {
  const sessions: Ref<LobbyEntry[]> = ref([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  let timer: ReturnType<typeof setInterval> | null = null;

  async function refresh(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      sessions.value = await listSessions();
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'failed to load sessions';
    } finally {
      loading.value = false;
    }
  }

  function startPolling(intervalMs = 3000): void {
    if (timer) return;
    void refresh(); // immediate
    timer = setInterval(() => { void refresh(); }, intervalMs);
  }

  function stopPolling(): void {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { sessions, loading, error, refresh, startPolling, stopPolling };
}
```

- [ ] **Step 5: Run the useLobby test**

Run: `npm test --workspace @fiddle/client -- composables/useLobby`
Expected: PASS (3 tests).

- [ ] **Step 6: Create `LobbyView.vue`**

Create `packages/client/src/views/LobbyView.vue`:

```vue
<template>
  <div class="lobby-view">
    <div class="lobby-head">
      <h2>Sessions</h2>
      <button class="btn primary" @click="showCreate = true">+ New session</button>
    </div>

    <p v-if="error" class="error">{{ error }}</p>

    <div v-if="!loading && sessions.length === 0" class="empty">
      <p>No live sessions yet.</p>
      <p>Create one to start jamming — share its link and others can join.</p>
    </div>

    <ul v-else class="session-list">
      <li v-for="s in sessions" :key="s.id" class="session-card" @click="join(s.id)">
        <div class="session-main">
          <span class="session-name">{{ s.name || 'Untitled session' }}</span>
          <span v-if="s.description" class="session-desc">{{ s.description }}</span>
        </div>
        <div class="session-meta">
          <span class="owner-tag">{{ s.isGuestOwned ? 'guest' : 'member' }}</span>
          <span v-if="s.live" class="live-dot" :title="`${s.memberCount} here`">
            ● {{ s.memberCount }}
          </span>
        </div>
      </li>
    </ul>

    <CreateSessionDialog v-if="showCreate" @close="showCreate = false" @created="onCreated" />
  </div>
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, inject } from 'vue';
import { useRouter } from 'vue-router';
import { useLobby } from '../composables/useLobby';
import { SYNTH_CONTEXT } from '../sync/synthContext';
import CreateSessionDialog from '../components/CreateSessionDialog.vue';

const router = useRouter();
const synth = inject(SYNTH_CONTEXT);
if (!synth) throw new Error('SYNTH_CONTEXT not provided');

const { sessions, loading, error, startPolling, stopPolling } = useLobby();
const showCreate = ref(false);

onMounted(() => startPolling(3000));
onBeforeUnmount(() => stopPolling());

function join(id: string): void {
  synth.connectToSession(id);
  router.push({ name: 'studio' });
}

function onCreated(id: string): void {
  showCreate.value = false;
  join(id);
}
</script>

<style scoped>
.lobby-view { padding: 30px 20px; max-width: 820px; margin: 0 auto; display: flex; flex-direction: column; gap: 20px; }
.lobby-head { display: flex; align-items: center; justify-content: space-between; }
.lobby-view h2 { font-family: monospace; text-transform: uppercase; letter-spacing: 0.08em; margin: 0; }
.btn { font-size: 0.85rem; padding: 8px 14px; border-radius: 6px; border: 1px solid #444; background: #222; color: #ddd; cursor: pointer; }
.btn.primary { border-color: #00f0ff; color: #00f0ff; }
.error { color: #FF4136; font-size: 0.85rem; }
.empty { color: #888; border: 1px dashed #333; border-radius: 8px; padding: 24px; text-align: center; }
.session-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 10px; }
.session-card { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 16px; background: #1a1a1a; border: 1px solid #222; border-radius: 8px; cursor: pointer; transition: border-color 0.2s ease; }
.session-card:hover { border-color: #00f0ff; }
.session-main { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.session-name { font-weight: 600; }
.session-desc { font-size: 0.8rem; color: #888; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session-meta { display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
.owner-tag { font-family: monospace; font-size: 0.7rem; color: #666; text-transform: uppercase; }
.live-dot { color: #4ade80; font-size: 0.8rem; font-weight: 600; }
</style>
```

> **Deferred (note in PR):** the spec mentions showing the owner's *username* in
> the lobby. There is no public username-read endpoint yet (Supabase RLS scopes
> `profiles` reads to the owner's own row), so this slice shows a `guest`/`member`
> tag instead. Resolving `ownerUserId → username` needs a public profiles read
> (a server endpoint or a Postgres view) — track as a follow-up; the wire
> `LobbyEntry.ownerUserId` already carries the id for when it lands.

- [ ] **Step 7: Create `CreateSessionDialog.vue`**

Create `packages/client/src/components/CreateSessionDialog.vue`:

```vue
<template>
  <div class="backdrop" @click.self="emit('close')">
    <div class="dialog" role="dialog" aria-label="Create session">
      <h3>New session</h3>

      <label class="field">
        <span>Name</span>
        <input v-model="name" maxlength="80" placeholder="My jam" @keyup.enter="submit" />
      </label>

      <label class="field">
        <span>Description</span>
        <input v-model="description" maxlength="500" placeholder="optional" />
      </label>

      <div class="field-row">
        <label class="field disabled">
          <span>Max writers</span>
          <input type="number" :value="settings.maxWritableUsers" disabled />
        </label>
        <label class="field disabled">
          <span>Tracks / user</span>
          <input type="number" :value="settings.tracksPerUser" disabled />
        </label>
      </div>
      <p class="hint">Limits are saved but inert this release.</p>

      <div class="seed">
        <span class="seed-label">Start from</span>
        <label><input type="radio" value="default" v-model="seedMode" /> Blank project</label>
        <label><input type="radio" value="import" v-model="seedMode" /> Import .json</label>
        <button v-if="seedMode === 'import'" class="btn" @click="pickFile">
          {{ importedName ? `✓ ${importedName}` : 'Choose file…' }}
        </button>
      </div>

      <p v-if="err" class="error">{{ err }}</p>

      <div class="actions">
        <button class="btn" @click="emit('close')">Cancel</button>
        <button class="btn primary" :disabled="busy || !name.trim() || (seedMode === 'import' && !importedProject)" @click="submit">
          {{ busy ? 'Creating…' : 'Create' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { DEFAULT_SESSION_SETTINGS, type Project, type CreateSessionBody } from '@fiddle/shared';
import { openProjectFromFile } from '../project';
import { createSession } from '../sync/sessionsApi';
import { guestClientId } from '../sync/clientId';
import { useAuth } from '../auth/useAuth';

const emit = defineEmits<{ (e: 'close'): void; (e: 'created', id: string): void }>();
const auth = useAuth();

const name = ref('');
const description = ref('');
const settings = DEFAULT_SESSION_SETTINGS;
const seedMode = ref<'default' | 'import'>('default');
const importedProject = ref<Project | null>(null);
const importedName = ref<string | null>(null);
const busy = ref(false);
const err = ref<string | null>(null);

async function pickFile(): Promise<void> {
  err.value = null;
  try {
    const project = await openProjectFromFile();
    if (project) {
      importedProject.value = project;
      importedName.value = 'imported project';
    }
  } catch (e) {
    err.value = e instanceof Error ? e.message : 'could not read file';
  }
}

async function submit(): Promise<void> {
  if (!name.trim()) return;
  busy.value = true;
  err.value = null;
  try {
    const token = auth.accessToken.value;
    const body: CreateSessionBody = {
      name: name.value.trim(),
      description: description.value.trim(),
      settings,
      seed: seedMode.value === 'import' && importedProject.value ? importedProject.value : 'default',
      // Logged-in creators ignore clientId server-side; guests need it.
      clientId: token ? undefined : guestClientId(),
    };
    const id = await createSession(body, token);
    emit('created', id);
  } catch (e) {
    err.value = e instanceof Error ? e.message : 'create failed';
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.backdrop { position: fixed; inset: 0; z-index: 60; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; }
.dialog { width: 420px; max-width: calc(100vw - 32px); background: #161616; border: 1px solid #2a2a2a; border-radius: 10px; padding: 22px; display: flex; flex-direction: column; gap: 14px; }
.dialog h3 { margin: 0; font-family: monospace; text-transform: uppercase; letter-spacing: 0.06em; color: #ddd; }
.field { display: flex; flex-direction: column; gap: 6px; font-size: 0.8rem; color: #999; }
.field input { background: #111; border: 1px solid #333; border-radius: 6px; color: #eee; padding: 8px 10px; }
.field.disabled input { opacity: 0.5; }
.field-row { display: flex; gap: 12px; }
.field-row .field { flex: 1; }
.hint { margin: 0; font-size: 0.72rem; color: #666; }
.seed { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; font-size: 0.82rem; color: #ccc; }
.seed-label { font-family: monospace; font-size: 0.7rem; color: #666; text-transform: uppercase; }
.error { color: #FF4136; font-size: 0.8rem; margin: 0; }
.actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 4px; }
.btn { font-size: 0.85rem; padding: 8px 14px; border-radius: 6px; border: 1px solid #444; background: #222; color: #ddd; cursor: pointer; }
.btn.primary { border-color: #00f0ff; color: #00f0ff; }
.btn:disabled { opacity: 0.5; cursor: default; }
</style>
```

- [ ] **Step 8: Run the router test (now resolves) + typecheck**

Run: `npm test --workspace @fiddle/client -- router/index && npm run typecheck`
Expected: PASS — `LobbyView.vue` now resolves; router asserts the lobby route;
typecheck clean across the new `.vue` files.

- [ ] **Step 9: Commit**

```bash
git add packages/client/src/router/index.ts packages/client/src/router/index.test.ts packages/client/src/composables/useLobby.ts packages/client/src/composables/useLobby.test.ts packages/client/src/views/LobbyView.vue packages/client/src/components/CreateSessionDialog.vue
git commit -m "feat(client): lobby route, useLobby, LobbyView + create dialog

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: App shell wiring + Sidebar nav

On load, pick the initial view from the URL and connect if a room is present. A
fatal `session.not_found` bounces to the lobby. The sidebar gets a Lobby link and
a Leave control while in a session.

**Files:**
- Modify: `packages/client/src/App.vue`
- Modify: `packages/client/src/components/Sidebar.vue`

- [ ] **Step 1: Wire initial view + connect + bounce in `App.vue`**

In `packages/client/src/App.vue`'s `<script setup>`:

(a) Extend imports:

```ts
import { onBeforeUnmount, onMounted, provide, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { readRoomIdFromUrl } from './sync/roomId';
```

(b) After `const route = useRoute();`, add the router + watchers + onMounted logic
(keep the existing `synth`, `provide`, `sidebarOpen`, Escape handler):

```ts
const router = useRouter();

// Decide the landing view from the URL: a `/r/<id>` deep-link opens the studio
// and connects to that session; anything else opens the lobby. Connection is
// independent of audio (which still boots lazily on first PLAY).
onMounted(() => {
  const roomId = readRoomIdFromUrl();
  if (roomId) {
    synth.connectToSession(roomId);
    router.replace({ name: 'studio' });
  } else {
    router.replace({ name: 'lobby' });
  }
});

// A fatal session.not_found (unknown / pruned session) bounces to the lobby.
watch(
  () => synth.fatalError.value,
  (err) => {
    if (err?.code === 'session.not_found') {
      synth.leaveSession();
      router.replace({ name: 'lobby' });
    }
  },
);
```

`synth.connectToSession` / `synth.leaveSession` / `synth.currentRoomId` were
added to the `useSynth()` return in Task 6 — no further change to `useSynth.ts`
is needed here.

- [ ] **Step 2: Sidebar — Lobby link + Leave control**

In `packages/client/src/components/Sidebar.vue`:

(a) Update the nav block:

```vue
    <nav class="nav">
      <RouterLink to="/lobby" class="nav-link">Lobby</RouterLink>
      <RouterLink v-if="inSession" to="/studio" class="nav-link">Studio</RouterLink>
      <RouterLink to="/account" class="nav-link">Account</RouterLink>
      <button v-if="inSession" class="nav-link leave" @click="leave">Leave session</button>
    </nav>
```

(b) Extend the `<script setup>`:

```ts
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { roster, selfClientId } from '../sync/presence';
import { useAuth } from '../auth/useAuth';
import { SYNTH_CONTEXT } from '../sync/synthContext';
import { inject } from 'vue';

const emit = defineEmits<{ (e: 'close'): void }>();
const auth = useAuth();
const router = useRouter();
const synth = inject(SYNTH_CONTEXT);
if (!synth) throw new Error('SYNTH_CONTEXT not provided');

const inSession = computed(() => synth.currentRoomId.value !== null);

function leave(): void {
  synth.leaveSession();
  emit('close');
  router.push({ name: 'lobby' });
}
```

(c) Add a style for the `.leave` button (reuses `.nav-link` look but as a button):

```css
.nav-link.leave { background: none; text-align: left; font-family: monospace; }
.nav-link.leave:hover { color: #fb923c; }
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/App.vue packages/client/src/components/Sidebar.vue
git commit -m "feat(client): lobby-as-home shell wiring + sidebar Leave

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Studio — Leave control + owner session-settings panel

**Files:**
- Modify: `packages/client/src/views/StudioView.vue`

- [ ] **Step 1: Add Leave + a session-settings drawer to the studio**

In `packages/client/src/views/StudioView.vue`:

(a) In the teleported transport block, add a Leave + Session button (after the OPEN button):

```vue
      <button @click="onOpen" title="Open a project from a file">OPEN</button>
      <button @click="showSettings = true" title="Session settings">SESSION</button>
      <button @click="onLeave" title="Leave this session and return to the lobby">LEAVE</button>
```

(b) Add a settings panel near the end of the template (before the closing
`</div>` of `.synth-container`):

```vue
    <div v-if="showSettings" class="settings-backdrop" @click.self="showSettings = false">
      <div class="settings-dialog" role="dialog" aria-label="Session settings">
        <h3>Session</h3>
        <template v-if="meta">
          <label class="field">
            <span>Name</span>
            <input v-model="metaName" :disabled="!isOwner" maxlength="80" />
          </label>
          <label class="field">
            <span>Description</span>
            <input v-model="metaDesc" :disabled="!isOwner" maxlength="500" />
          </label>
          <p v-if="!isOwner" class="hint">Only the session owner can edit these.</p>
          <p v-if="settingsErr" class="error">{{ settingsErr }}</p>
          <div class="actions">
            <button class="btn" @click="showSettings = false">Close</button>
            <button v-if="isOwner" class="btn primary" :disabled="savingMeta" @click="saveMeta">
              {{ savingMeta ? 'Saving…' : 'Save' }}
            </button>
          </div>
        </template>
        <p v-else class="hint">Loading…</p>
      </div>
    </div>
```

(c) Extend the `<script setup>` imports + logic:

```ts
import { computed, inject, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { getSession, patchSession, type SessionMeta } from '../sync/sessionsApi';
import { guestClientId } from '../sync/clientId';
import { useAuth } from '../auth/useAuth';
```

(The studio reaches connect/leave through the injected `synth` context —
`synth.leaveSession()` / `synth.currentRoomId` — so no import from `useSynth` is
needed here.)

Add below the existing destructure of `synth`:

```ts
const router = useRouter();
const auth = useAuth();

const showSettings = ref(false);
const meta = ref<SessionMeta | null>(null);
const metaName = ref('');
const metaDesc = ref('');
const savingMeta = ref(false);
const settingsErr = ref<string | null>(null);

const isOwner = computed(() => {
  const m = meta.value;
  if (!m) return false;
  const uid = auth.session.value?.user.id ?? null;
  if (m.ownerUserId !== null) return uid === m.ownerUserId;
  return m.ownerClientId !== null && m.ownerClientId === guestClientId();
});

// Load (or refresh) the session metadata whenever the settings panel opens for
// the current room.
watch(showSettings, async (open) => {
  if (!open) return;
  const id = synth.currentRoomId.value;
  if (!id) return;
  settingsErr.value = null;
  meta.value = null;
  try {
    const m = await getSession(id);
    meta.value = m;
    if (m) { metaName.value = m.name; metaDesc.value = m.description; }
  } catch (e) {
    settingsErr.value = e instanceof Error ? e.message : 'failed to load session';
  }
});

async function saveMeta(): Promise<void> {
  const id = synth.currentRoomId.value;
  if (!id || !meta.value) return;
  savingMeta.value = true;
  settingsErr.value = null;
  try {
    await patchSession(
      id,
      {
        name: metaName.value.trim(),
        description: metaDesc.value.trim(),
        // Guests authorise with their clientId; logged-in owners via the token.
        clientId: auth.accessToken.value ? undefined : guestClientId(),
      },
      auth.accessToken.value,
    );
    showSettings.value = false;
  } catch (e) {
    settingsErr.value = e instanceof Error ? e.message : 'save failed';
  } finally {
    savingMeta.value = false;
  }
}

function onLeave(): void {
  synth.leaveSession();
  router.push({ name: 'lobby' });
}
```

Make sure `synth` (the injected `SYNTH_CONTEXT`) destructure also pulls
`leaveSession` and `currentRoomId` if you reference them via destructured names;
the snippet above uses `synth.currentRoomId` / `synth.leaveSession` directly, so
no change to the existing destructure is required.

(d) Add styles (append to the scoped block):

```css
.settings-backdrop { position: fixed; inset: 0; z-index: 60; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; }
.settings-dialog { width: 420px; max-width: calc(100vw - 32px); background: #161616; border: 1px solid #2a2a2a; border-radius: 10px; padding: 22px; display: flex; flex-direction: column; gap: 14px; }
.settings-dialog h3 { margin: 0; font-family: monospace; text-transform: uppercase; letter-spacing: 0.06em; color: #ddd; }
.settings-dialog .field { display: flex; flex-direction: column; gap: 6px; font-size: 0.8rem; color: #999; }
.settings-dialog .field input { background: #111; border: 1px solid #333; border-radius: 6px; color: #eee; padding: 8px 10px; }
.settings-dialog .field input:disabled { opacity: 0.5; }
.settings-dialog .hint { margin: 0; font-size: 0.72rem; color: #666; }
.settings-dialog .error { margin: 0; color: #FF4136; font-size: 0.8rem; }
.settings-dialog .actions { display: flex; justify-content: flex-end; gap: 10px; }
.settings-dialog .btn { font-size: 0.85rem; padding: 8px 14px; border-radius: 6px; border: 1px solid #444; background: #222; color: #ddd; cursor: pointer; }
.settings-dialog .btn.primary { border-color: #00f0ff; color: #00f0ff; }
.settings-dialog .btn:disabled { opacity: 0.5; cursor: default; }
```

- [ ] **Step 2: Typecheck + full client suite**

Run: `npm run typecheck && npm test --workspace @fiddle/client`
Expected: PASS — no unit tests mount `.vue` files; the studio additions are covered
by typecheck + the helper/composable tests from earlier tasks.

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/views/StudioView.vue
git commit -m "feat(client): studio Leave control + owner session-settings panel

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] **Run the full gate**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green. New/changed tests: server gains the 2 handler cutover tests +
`sessions.get-one` (2); client gains `roomId` (updated), `clientId` (2),
`sessionsApi` (7), `useLobby` (3), `useSynth` connection (4), `router` (updated).
Both builds clean.

- [ ] **Run the e2e suite**

Run: `npm run test:e2e`
Expected: PASS — every e2e test creates its session over HTTP before joining, and
the unknown-session rejection test passes.

- [ ] **Confirm scope**

Run: `git diff main --stat`
Expected: changes only under `packages/shared/src/protocol/`, `packages/server/src/`
(sync, routes, server), and `packages/client/src/` (sync, composables, views,
components, router, App.vue) + `vite.config.ts` / `.env.example`. No changes to the
audio engine, sequencer, or project model.

- [ ] **Manual browser verification (user-driven, after merge decision)**

Leave the branch for the user to verify in a browser (do not auto-merge):
  1. Load the app with no `/r/` → lands on the **Lobby**; empty state if no sessions.
  2. **Create** a session (blank seed) as a guest → enters the studio, URL becomes `/r/<id>`.
  3. Open another tab on `/lobby` → the new session appears with a live count; click → joins; edits sync between tabs.
  4. **Leave** → returns to lobby; URL clears to `/`.
  5. Visit a bogus `/r/zzzzzzzzz` → bounces back to the lobby (`session.not_found`).
  6. Sign in with Google → create a session → it persists in the lobby even after everyone leaves (logged-in-owned); a guest session disappears once empty.
  7. As owner, open **SESSION** in the studio → edit name/description → Save → reflected in the lobby.
  8. **Import .json** seed in the create dialog → new session opens with the imported pattern.

---

## What this plan deliberately defers (tracked, not in scope)

- **Owner username in the lobby:** shown as a `guest`/`member` tag; resolving
  `ownerUserId → username` needs a public profiles read (endpoint or Postgres
  view). Follow-up.
- **Enforcing `maxWritableUsers` / `tracksPerUser`:** stored + shown disabled,
  inert this slice (per spec).
- **Read-only/observer connections, moderation/bans, version history, project
  templates:** separate specs (see `docs/ROADMAP.md`).
- **Strong guest settings-edit auth:** the `ownerClientId` match is intentionally
  weak (hobby tool); strengthened in the moderation spec.
