# Sessions — Plan 2: Lobby API + Autosave Flusher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the durable `SessionStore` (built in Plan 1) over an HTTP `/api/sessions` API and persist live room projects back to it via an autosave flusher — without changing how rooms are joined yet.

**Architecture:** Two new concerns wired into the existing Fastify server. (1) A `SessionSync` service couples the in-memory `RoomStore` to the durable `SessionStore`: a 60s sweep flushes rooms with unsaved edits, a flush fires on every disconnect, guest sessions are pruned when their room empties, and a Fastify `onClose` hook flushes everything on graceful shutdown (SIGTERM). (2) A `sessionsRoute` provides `GET/POST/PATCH/DELETE /api/sessions`, reusing the existing JWT `verify`. Auto-mint and room-init are **unchanged** — that cutover is Plan 3 — so the running app keeps working throughout.

**Tech Stack:** TypeScript, npm workspaces (`@fiddle/shared`, `@fiddle/server`), Fastify 5 (`app.inject` for route tests), Vitest, `postgres` (porsager), zod (already a `@fiddle/shared` dep).

**Spec:** `docs/superpowers/specs/2026-05-31-persistent-sessions-lobby-design.md`
**Builds on:** `docs/superpowers/plans/2026-05-31-sessions-plan-1-data-layer.md` (already implemented on this branch).

**Conventions to follow:**
- ESM NodeNext: import sibling `.ts` modules with a `.js` specifier (e.g. `./SessionSync.js`); cross-package via `@fiddle/shared`.
- Test logic/helpers only; never mount `.vue` files (N/A here — server/shared only).
- Postgres integration tests gate on `TEST_DATABASE_URL`; the in-memory fakes cover logic in the default run. (Plan 2 adds no new Postgres-specific tests — the new logic is exercised through `InMemoryRoomStore` + `InMemorySessionStore`.)
- Gate before any merge: `npm run typecheck && npm test && npm run build`.
- Commit messages end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Commit ONLY the files listed per task. Never `git add -A`.

---

## Pre-flight context (existing code the implementer must know)

These already exist on the branch (do not recreate):

- `packages/server/src/session/SessionStore.ts` — interface with `create`, `get(id)`, `list()`, `getSnapshot(id)`, `saveSnapshot(id, project)`, `updateMeta(id, patch)`, `delete(id)`. Plus types `SessionRecord` (`{ id, name, description, ownerUserId, ownerClientId, settings, createdAt, updatedAt }`), `CreateSessionInput` (`SessionRecord` fields minus timestamps, plus `project: Project`), `UpdateMetaPatch` (`{ name?, description?, settings? }`).
- `packages/server/src/session/InMemorySessionStore.ts` and `PostgresSessionStore.ts` — both implement `SessionStore`. **`saveSnapshot` is a no-op when the session row is absent** (in-memory checks the map; Postgres uses `insert … select … where exists`). This is load-bearing for the flusher: flushing an auto-minted room that has no session row is harmless.
- `@fiddle/shared` exports: `Project`, `freshProject()`, `ProjectSchema` (a zod schema), `SessionSettings`, `DEFAULT_SESSION_SETTINGS` (`{ maxWritableUsers: 4, tracksPerUser: 4 }`), `randomBase32(len)` (lowercase Crockford base32; **not collision-proof** — fine for 9 chars / 45 bits), `setDeep`.
- `packages/server/src/room/RoomStore.ts` (interface) + `InMemoryRoomStore.ts` + `room/types.ts` (`RoomState`). `appendOp` mutates `room.project` in place via `setDeep` and appends to a ring buffer. Presence lives in `RoomState.connected: Set<string>`.
- `packages/server/src/auth/verifyToken.ts` — `verifyToken(token, key) => Promise<VerifiedClaims | null>`; `VerifiedClaims = { userId: string; googleName: string }`.
- `packages/server/src/server.ts` — `buildServer(): FastifyInstance`. Builds one `InMemoryRoomStore`, a `ConnectionPool`, a `verify` fn (real JWKS if `SUPABASE_JWKS_URL` else always-`null`), and a `ProfileStore` (Postgres if `DATABASE_URL` else in-memory). Registers `healthRoute`, `websocket`, and `wsRoute(a, { store, pool, verify, profiles })`. **`buildServer` must keep returning `FastifyInstance`** — `protocol.e2e.test.ts` types `app` as `ReturnType<typeof buildServer>` and calls `app.listen()/app.close()`.
- `packages/server/src/routes/ws.ts` — `wsRoute(app, deps)`. Its `socket.on('close')` handler removes the socket from the pool then calls `handler.onClose()`. This is where the disconnect flush hooks in.
- `packages/server/src/index.ts` — entry point: `const app = buildServer(); app.listen(...)`. No signal handling yet.
- `app.inject({ method, url, headers, payload })` is how routes are tested (see `server.test.ts`). `light-my-request` auto-serialises an object `payload` to JSON and sets `content-type: application/json`.

---

## File Structure

**New files:**
- `packages/shared/src/session/lobby.ts` — `LobbyEntry` wire type (GET response shape; reused by the Plan 3 client).
- `packages/shared/src/session/api.ts` — zod request schemas (`CreateSessionBodySchema`, `PatchSessionBodySchema`) + inferred types.
- `packages/shared/src/session/api.test.ts` — schema defaults/validation tests.
- `packages/server/src/session/lobby.ts` — `buildLobbyList(records, liveCounts)` pure merge function.
- `packages/server/src/session/lobby.test.ts` — merge tests.
- `packages/server/src/session/SessionSync.ts` — the flusher / disconnect / sweep / shutdown service.
- `packages/server/src/session/SessionSync.test.ts` — flusher tests.
- `packages/server/src/routes/sessions.ts` — `sessionsRoute(app, deps)` HTTP handlers.
- `packages/server/src/routes/sessions.test.ts` — route tests via `app.inject`.
- `packages/server/src/room/InMemoryRoomStore.persistence.test.ts` — tests for the new RoomStore helpers.

**Modified files:**
- `packages/shared/src/index.ts` — two re-export lines.
- `packages/server/src/room/types.ts` — add `dirty` to `RoomState`.
- `packages/server/src/room/RoomStore.ts` — add 4 methods to the interface.
- `packages/server/src/room/InMemoryRoomStore.ts` — implement them + set `dirty` in `appendOp`.
- `packages/server/src/routes/ws.ts` — disconnect flush + guest-prune hook.
- `packages/server/src/server.ts` — wire `SessionStore` + `SessionSync` + `sessionsRoute`; start sweep; `onClose` flush hook.
- `packages/server/src/index.ts` — SIGTERM/SIGINT → `app.close()`.
- `packages/server/src/server.test.ts` — add `/api/sessions` smoke tests.

---

## Task 1: RoomStore dirty-tracking + presence-count helpers

**Files:**
- Modify: `packages/server/src/room/types.ts`
- Modify: `packages/server/src/room/RoomStore.ts`
- Modify: `packages/server/src/room/InMemoryRoomStore.ts`
- Create: `packages/server/src/room/InMemoryRoomStore.persistence.test.ts`

- [ ] **Step 1: Add `dirty` to `RoomState`**

In `packages/server/src/room/types.ts`, add a field to the `RoomState` interface, after `graceTimer`:

```ts
  // Set true by appendOp on every accepted op; cleared by the autosave flusher
  // after it persists the project. Lets the 60s sweep skip rooms with no edits.
  dirty: boolean;
```

- [ ] **Step 2: Extend the `RoomStore` interface**

In `packages/server/src/room/RoomStore.ts`, add these methods to the `RoomStore` interface (after `pruneRoom`):

```ts
  // Reads a room's current project WITHOUT creating it (null if absent). Used by
  // the autosave flusher, which must never resurrect a pruned room.
  peekProject(roomId: string): Promise<Project | null>;

  // Room ids with unsaved edits since their last flush.
  listDirtyRoomIds(): Promise<string[]>;

  // Clears a room's dirty flag (called after a successful snapshot save).
  clearDirty(roomId: string): Promise<void>;

  // Live member count per existing room (size of the connected set). Drives the
  // lobby's member-count / "live" column and the guest "listed only while
  // occupied" rule.
  roomMemberCounts(): Promise<Map<string, number>>;
```

- [ ] **Step 3: Write the failing test**

Create `packages/server/src/room/InMemoryRoomStore.persistence.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { freshProject } from '@fiddle/shared';
import { InMemoryRoomStore } from './InMemoryRoomStore.js';

describe('InMemoryRoomStore persistence/presence helpers', () => {
  it('appendOp marks the room dirty; clearDirty clears it', async () => {
    const store = new InMemoryRoomStore();
    await store.getOrCreate('r1', freshProject);
    expect(await store.listDirtyRoomIds()).toEqual([]);
    await store.appendOp('r1', { clientId: 'c1', clientSeq: 1, path: ['bpm'], value: 130 });
    expect(await store.listDirtyRoomIds()).toEqual(['r1']);
    await store.clearDirty('r1');
    expect(await store.listDirtyRoomIds()).toEqual([]);
  });

  it('peekProject returns the live project and null for a missing room', async () => {
    const store = new InMemoryRoomStore();
    expect(await store.peekProject('nope')).toBeNull();
    await store.getOrCreate('r1', freshProject);
    await store.appendOp('r1', { clientId: 'c1', clientSeq: 1, path: ['bpm'], value: 142 });
    expect((await store.peekProject('r1'))?.bpm).toBe(142);
  });

  it('roomMemberCounts reflects connected sockets per existing room', async () => {
    const store = new InMemoryRoomStore();
    await store.getOrCreate('r1', freshProject);
    await store.markConnected('r1', 'c1');
    await store.markConnected('r1', 'c2');
    await store.getOrCreate('r2', freshProject);
    const counts = await store.roomMemberCounts();
    expect(counts.get('r1')).toBe(2);
    expect(counts.get('r2')).toBe(0);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm test --workspace @fiddle/server -- InMemoryRoomStore.persistence`
Expected: FAIL — `listDirtyRoomIds`/`peekProject`/`roomMemberCounts` not functions (and a TS error).

- [ ] **Step 5: Implement in `InMemoryRoomStore`**

In `packages/server/src/room/InMemoryRoomStore.ts`:

(a) In `getOrCreate`, add `dirty: false,` to the new-room object literal (alongside `graceTimer: null,`).

(b) In `appendOp`, after the line `room.nextOpId += 1;`, add:

```ts
    room.dirty = true;
```

(c) Add these four methods to the class (anywhere among the other methods, e.g. after `pruneRoom`):

```ts
  async peekProject(roomId: string): Promise<Project | null> {
    return this.rooms.get(roomId)?.project ?? null;
  }

  async listDirtyRoomIds(): Promise<string[]> {
    const ids: string[] = [];
    for (const [roomId, room] of this.rooms) {
      if (room.dirty) ids.push(roomId);
    }
    return ids;
  }

  async clearDirty(roomId: string): Promise<void> {
    const room = this.rooms.get(roomId);
    if (room) room.dirty = false;
  }

  async roomMemberCounts(): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const [roomId, room] of this.rooms) {
      counts.set(roomId, room.connected.size);
    }
    return counts;
  }
```

`Project` is already imported in this file. If not, add `import type { Project } from '@fiddle/shared';` (check first — it is imported at the top).

- [ ] **Step 6: Run test + full server suite**

Run: `npm test --workspace @fiddle/server -- InMemoryRoomStore`
Expected: PASS — the new persistence suite (3 tests) plus the existing `InMemoryRoomStore.test.ts` all green.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/room/types.ts packages/server/src/room/RoomStore.ts packages/server/src/room/InMemoryRoomStore.ts packages/server/src/room/InMemoryRoomStore.persistence.test.ts
git commit -m "feat(server): RoomStore dirty-tracking + presence counts

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Lobby merge (shared `LobbyEntry` + server `buildLobbyList`)

**Files:**
- Create: `packages/shared/src/session/lobby.ts`
- Modify: `packages/shared/src/index.ts`
- Create: `packages/server/src/session/lobby.ts`
- Create: `packages/server/src/session/lobby.test.ts`

- [ ] **Step 1: Add the shared `LobbyEntry` type**

Create `packages/shared/src/session/lobby.ts`:

```ts
// The lobby list entry — the wire shape GET /api/sessions returns and the lobby
// UI (Plan 3) renders. The server builds it by merging durable session metadata
// with live in-memory presence. Guest-owned sessions appear only while occupied;
// logged-in-owned sessions always appear.
export interface LobbyEntry {
  id: string;
  name: string;
  description: string;
  // null for guest-owned sessions; the owner's user id otherwise. Username/handle
  // resolution is layered on in the client lobby (Plan 3).
  ownerUserId: string | null;
  isGuestOwned: boolean;
  // Currently-connected member count (0 when no one is in the room).
  memberCount: number;
  // memberCount > 0.
  live: boolean;
  // ISO-8601 timestamps.
  createdAt: string;
  updatedAt: string;
}
```

- [ ] **Step 2: Re-export from the shared index**

In `packages/shared/src/index.ts`, add after the `export * from './session/settings.js';` line (added in Plan 1):

```ts
// Lobby list entry wire shape (GET /api/sessions response).
export * from './session/lobby.js';
```

- [ ] **Step 3: Write the failing test**

Create `packages/server/src/session/lobby.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_SESSION_SETTINGS } from '@fiddle/shared';
import { buildLobbyList } from './lobby.js';
import type { SessionRecord } from './SessionStore.js';

function rec(over: Partial<SessionRecord>): SessionRecord {
  return {
    id: 'x', name: 'n', description: '', ownerUserId: 'u', ownerClientId: null,
    settings: DEFAULT_SESSION_SETTINGS, createdAt: new Date(0), updatedAt: new Date(0),
    ...over,
  };
}

describe('buildLobbyList', () => {
  it('lists a logged-in-owned session even with no members', () => {
    const out = buildLobbyList([rec({ id: 'a', ownerUserId: 'u1' })], new Map());
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'a', isGuestOwned: false, memberCount: 0, live: false });
  });

  it('hides a guest-owned session with no members, shows it when occupied', () => {
    const guest = rec({ id: 'g', ownerUserId: null, ownerClientId: 'c1' });
    expect(buildLobbyList([guest], new Map())).toEqual([]);
    const shown = buildLobbyList([guest], new Map([['g', 2]]));
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ id: 'g', isGuestOwned: true, memberCount: 2, live: true });
  });

  it('annotates member counts and preserves input order', () => {
    const out = buildLobbyList(
      [rec({ id: 'a', ownerUserId: 'u1' }), rec({ id: 'b', ownerUserId: 'u2' })],
      new Map([['a', 1]]),
    );
    expect(out.map((e) => e.id)).toEqual(['a', 'b']);
    expect(out[0].memberCount).toBe(1);
    expect(out[1].memberCount).toBe(0);
  });

  it('serialises timestamps to ISO strings', () => {
    const out = buildLobbyList(
      [rec({ id: 'a', ownerUserId: 'u1', updatedAt: new Date('2026-05-31T00:00:00Z') })],
      new Map(),
    );
    expect(out[0].updatedAt).toBe('2026-05-31T00:00:00.000Z');
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm test --workspace @fiddle/server -- session/lobby`
Expected: FAIL — cannot find module `./lobby.js`.

- [ ] **Step 5: Implement `buildLobbyList`**

Create `packages/server/src/session/lobby.ts`:

```ts
import type { LobbyEntry } from '@fiddle/shared';
import type { SessionRecord } from './SessionStore.js';

// Merge durable session metadata with live presence into the lobby list.
//   - logged-in-owned sessions: always listed.
//   - guest-owned sessions (ownerUserId === null): listed only while occupied
//     (memberCount > 0), so an abandoned guest room disappears immediately —
//     even before its row is pruned by SessionSync.
// Input order is preserved (the store returns most-recently-updated first); this
// function only filters + annotates.
export function buildLobbyList(
  records: SessionRecord[],
  liveCounts: Map<string, number>,
): LobbyEntry[] {
  const entries: LobbyEntry[] = [];
  for (const r of records) {
    const memberCount = liveCounts.get(r.id) ?? 0;
    const isGuestOwned = r.ownerUserId === null;
    if (isGuestOwned && memberCount === 0) continue; // hide abandoned guest rooms
    entries.push({
      id: r.id,
      name: r.name,
      description: r.description,
      ownerUserId: r.ownerUserId,
      isGuestOwned,
      memberCount,
      live: memberCount > 0,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    });
  }
  return entries;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test --workspace @fiddle/server -- session/lobby`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/session/lobby.ts packages/shared/src/index.ts packages/server/src/session/lobby.ts packages/server/src/session/lobby.test.ts
git commit -m "feat: lobby list merge (LobbyEntry + buildLobbyList)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: SessionSync (flusher / disconnect / sweep / shutdown)

**Files:**
- Create: `packages/server/src/session/SessionSync.ts`
- Create: `packages/server/src/session/SessionSync.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/session/SessionSync.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { freshProject, DEFAULT_SESSION_SETTINGS } from '@fiddle/shared';
import { InMemoryRoomStore } from '../room/InMemoryRoomStore.js';
import { InMemorySessionStore } from './InMemorySessionStore.js';
import { SessionSync } from './SessionSync.js';
import type { CreateSessionInput } from './SessionStore.js';

function sessionInput(over: Partial<CreateSessionInput> = {}): CreateSessionInput {
  return {
    id: 'r1', name: 'Jam', description: '', ownerUserId: 'u1', ownerClientId: null,
    settings: DEFAULT_SESSION_SETTINGS, project: freshProject(), ...over,
  };
}

describe('SessionSync', () => {
  it('flushRoom persists the live project and clears dirty', async () => {
    const rooms = new InMemoryRoomStore();
    const sessions = new InMemorySessionStore();
    await sessions.create(sessionInput());
    await rooms.getOrCreate('r1', freshProject);
    await rooms.appendOp('r1', { clientId: 'c1', clientSeq: 1, path: ['bpm'], value: 155 });

    const sync = new SessionSync(rooms, sessions);
    await sync.flushRoom('r1');

    expect((await sessions.getSnapshot('r1'))?.bpm).toBe(155);
    expect(await rooms.listDirtyRoomIds()).toEqual([]);
  });

  it('flushAllDirty flushes only dirty rooms', async () => {
    const rooms = new InMemoryRoomStore();
    const sessions = new InMemorySessionStore();
    await sessions.create(sessionInput({ id: 'r1' }));
    await sessions.create(sessionInput({ id: 'r2' }));
    await rooms.getOrCreate('r1', freshProject);
    await rooms.getOrCreate('r2', freshProject);
    await rooms.appendOp('r1', { clientId: 'c1', clientSeq: 1, path: ['bpm'], value: 99 });
    // r2 is left clean.

    const sync = new SessionSync(rooms, sessions);
    await sync.flushAllDirty();

    expect((await sessions.getSnapshot('r1'))?.bpm).toBe(99);
    expect((await sessions.getSnapshot('r2'))?.bpm).toBe(freshProject().bpm); // untouched
  });

  it('handleDisconnect flushes, then prunes a guest session when the room empties', async () => {
    const rooms = new InMemoryRoomStore();
    const sessions = new InMemorySessionStore();
    await sessions.create(sessionInput({ id: 'g', ownerUserId: null, ownerClientId: 'c1' }));
    await rooms.getOrCreate('g', freshProject);
    await rooms.appendOp('g', { clientId: 'c1', clientSeq: 1, path: ['bpm'], value: 120 });

    const sync = new SessionSync(rooms, sessions);
    await sync.handleDisconnect('g', true);

    expect(await sessions.get('g')).toBeNull();
    expect(await sessions.getSnapshot('g')).toBeNull();
  });

  it('handleDisconnect keeps a logged-in session when the room empties', async () => {
    const rooms = new InMemoryRoomStore();
    const sessions = new InMemorySessionStore();
    await sessions.create(sessionInput({ id: 'r1', ownerUserId: 'u1' }));
    await rooms.getOrCreate('r1', freshProject);
    await rooms.appendOp('r1', { clientId: 'c1', clientSeq: 1, path: ['bpm'], value: 88 });

    const sync = new SessionSync(rooms, sessions);
    await sync.handleDisconnect('r1', true);

    expect(await sessions.get('r1')).not.toBeNull();
    expect((await sessions.getSnapshot('r1'))?.bpm).toBe(88);
  });

  it('flushRoom on a pruned/unknown room is a no-op', async () => {
    const rooms = new InMemoryRoomStore();
    const sessions = new InMemorySessionStore();
    const sync = new SessionSync(rooms, sessions);
    await expect(sync.flushRoom('ghost')).resolves.toBeUndefined();
  });

  it('start schedules the sweep; stop clears it', () => {
    vi.useFakeTimers();
    try {
      const rooms = new InMemoryRoomStore();
      const sessions = new InMemorySessionStore();
      const sync = new SessionSync(rooms, sessions);
      const spy = vi.spyOn(sync, 'flushAllDirty').mockResolvedValue();
      sync.start();
      vi.advanceTimersByTime(60_000);
      expect(spy).toHaveBeenCalledTimes(1);
      sync.stop();
      vi.advanceTimersByTime(120_000);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @fiddle/server -- SessionSync`
Expected: FAIL — cannot find module `./SessionSync.js`.

- [ ] **Step 3: Implement `SessionSync`**

Create `packages/server/src/session/SessionSync.ts`:

```ts
import type { RoomStore } from '../room/RoomStore.js';
import type { SessionStore } from './SessionStore.js';
import type { Log } from '../sync/ConnectionHandler.js';

export const FLUSH_INTERVAL_MS = 60_000;

// Couples the live in-memory RoomStore to the durable SessionStore. Owns the
// project-persistence side effects the spec calls for:
//   - flushRoom / flushAllDirty: write the in-memory project to SessionStore.
//   - a periodic sweep (start/stop) that flushes rooms with unsaved edits.
//   - handleDisconnect: a flush on every disconnect (a network-blip / crash
//     boundary) plus a guest-session prune when the room empties (guest rooms are
//     unreachable once empty, so we drop the row to keep the lobby/tables clean).
//   - the Fastify onClose hook calls flushAllDirty on graceful shutdown (SIGTERM).
//
// saveSnapshot is a no-op when the session row is absent (see SessionStore), so
// flushing an auto-minted room that has no session row is harmless.
export class SessionSync {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly rooms: RoomStore,
    private readonly sessions: SessionStore,
    private readonly log: Log = () => {},
  ) {}

  // Persist one room's current project. Clears the dirty flag on success; on
  // failure the flag is left set so the next sweep retries.
  async flushRoom(roomId: string): Promise<void> {
    const project = await this.rooms.peekProject(roomId);
    if (!project) return; // room gone (pruned) — nothing to persist
    try {
      await this.sessions.saveSnapshot(roomId, project);
      await this.rooms.clearDirty(roomId);
    } catch (err) {
      this.log('session flush failed', { roomId, err: String(err) });
    }
  }

  // Flush every room with unsaved edits. Used by the periodic sweep and the
  // graceful-shutdown hook.
  async flushAllDirty(): Promise<void> {
    const ids = await this.rooms.listDirtyRoomIds();
    for (const id of ids) {
      await this.flushRoom(id);
    }
  }

  // Called by the ws route after a socket closes. Always flush (disconnect is a
  // good persistence boundary); when the room is now empty, also prune a
  // guest-owned session (it is unreachable from here on).
  async handleDisconnect(roomId: string, roomNowEmpty: boolean): Promise<void> {
    await this.flushRoom(roomId);
    if (!roomNowEmpty) return;
    const record = await this.sessions.get(roomId);
    if (record && record.ownerUserId === null) {
      await this.sessions.delete(roomId); // cascades the snapshot
      this.log('guest session pruned on empty', { roomId });
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flushAllDirty();
    }, FLUSH_INTERVAL_MS);
    // Don't keep the event loop alive solely for the sweep (matters for clean
    // shutdown and for any test that builds a server without closing it).
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @fiddle/server -- SessionSync`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/session/SessionSync.ts packages/server/src/session/SessionSync.test.ts
git commit -m "feat(server): SessionSync autosave flusher + guest prune

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Shared session API request schemas

**Files:**
- Create: `packages/shared/src/session/api.ts`
- Create: `packages/shared/src/session/api.test.ts`
- Modify: `packages/shared/src/index.ts`

These live in `@fiddle/shared` (where zod is already a dependency) so the request
contract is shared with the Plan 3 client and the server needn't take a direct
zod dependency.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/session/api.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { freshProject } from '../project/index.js';
import { CreateSessionBodySchema, PatchSessionBodySchema } from './api.js';

describe('CreateSessionBodySchema', () => {
  it('defaults description to "" and seed to "default"', () => {
    const parsed = CreateSessionBodySchema.parse({ name: 'My Jam' });
    expect(parsed.description).toBe('');
    expect(parsed.seed).toBe('default');
  });

  it('rejects an empty name', () => {
    expect(CreateSessionBodySchema.safeParse({ name: '' }).success).toBe(false);
  });

  it('accepts a full project as the seed', () => {
    const parsed = CreateSessionBodySchema.parse({ name: 'n', seed: freshProject() });
    expect(parsed.seed).not.toBe('default');
    expect(typeof parsed.seed === 'object' && parsed.seed.tracks).toHaveLength(4);
  });

  it('accepts optional settings and clientId', () => {
    const parsed = CreateSessionBodySchema.parse({
      name: 'n', clientId: 'c1', settings: { maxWritableUsers: 4, tracksPerUser: 4 },
    });
    expect(parsed.clientId).toBe('c1');
    expect(parsed.settings).toEqual({ maxWritableUsers: 4, tracksPerUser: 4 });
  });
});

describe('PatchSessionBodySchema', () => {
  it('allows a subset of fields', () => {
    const parsed = PatchSessionBodySchema.parse({ description: 'new' });
    expect(parsed.description).toBe('new');
    expect(parsed.name).toBeUndefined();
  });

  it('rejects an empty name when name is provided', () => {
    expect(PatchSessionBodySchema.safeParse({ name: '' }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @fiddle/shared -- session/api`
Expected: FAIL — cannot find module `./api.js`.

- [ ] **Step 3: Implement the schemas**

Create `packages/shared/src/session/api.ts`:

```ts
import { z } from 'zod';
import { ProjectSchema } from '../project/index.js';

// Request bodies for the /api/sessions HTTP API. Shared so the client (Plan 3)
// and server validate against one source of truth.

export const SessionSettingsSchema = z.object({
  maxWritableUsers: z.number().int().min(1).max(16),
  tracksPerUser: z.number().int().min(1).max(16),
});

export const CreateSessionBodySchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).default(''),
  settings: SessionSettingsSchema.optional(),
  // 'default' seeds a blank project; a full project object imports it (e.g. from
  // the existing export-to-JSON). Validated against the project schema.
  seed: z.union([z.literal('default'), ProjectSchema]).default('default'),
  // Required for guest creators (matched later to authorise settings edits while
  // the session is live). Ignored for logged-in creators.
  clientId: z.string().min(1).optional(),
});
export type CreateSessionBody = z.infer<typeof CreateSessionBodySchema>;

export const PatchSessionBodySchema = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(500).optional(),
  settings: SessionSettingsSchema.optional(),
  // Guest owners pass their clientId to authorise the edit.
  clientId: z.string().min(1).optional(),
});
export type PatchSessionBody = z.infer<typeof PatchSessionBodySchema>;
```

- [ ] **Step 4: Re-export from the shared index**

In `packages/shared/src/index.ts`, add after the `export * from './session/lobby.js';` line:

```ts
// Session HTTP API request schemas (create/patch bodies).
export * from './session/api.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test --workspace @fiddle/shared -- session/api`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/session/api.ts packages/shared/src/session/api.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): session API request schemas

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Session HTTP routes

**Files:**
- Create: `packages/server/src/routes/sessions.ts`
- Create: `packages/server/src/routes/sessions.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/routes/sessions.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { freshProject, DEFAULT_SESSION_SETTINGS } from '@fiddle/shared';
import { InMemorySessionStore } from '../session/InMemorySessionStore.js';
import { sessionsRoute } from './sessions.js';
import type { VerifiedClaims } from '../auth/verifyToken.js';
import type { CreateSessionInput } from '../session/SessionStore.js';

const claimsByToken: Record<string, VerifiedClaims> = {
  'good-token': { userId: 'user-1', googleName: 'User One' },
  'other-token': { userId: 'user-2', googleName: 'User Two' },
};
const fakeVerify = async (t: string): Promise<VerifiedClaims | null> => claimsByToken[t] ?? null;

function build(
  sessions = new InMemorySessionStore(),
  counts = new Map<string, number>(),
) {
  const app = Fastify();
  app.register(async (a) =>
    sessionsRoute(a, { sessions, verify: fakeVerify, liveCounts: async () => counts }),
  );
  return { app, sessions };
}

function loggedIn(id: string, over: Partial<CreateSessionInput> = {}): CreateSessionInput {
  return {
    id, name: 'A', description: 'd', ownerUserId: 'user-1', ownerClientId: null,
    settings: DEFAULT_SESSION_SETTINGS, project: freshProject(), ...over,
  };
}
function guest(id: string, clientId: string): CreateSessionInput {
  return {
    id, name: 'G', description: 'd', ownerUserId: null, ownerClientId: clientId,
    settings: DEFAULT_SESSION_SETTINGS, project: freshProject(),
  };
}

describe('sessions HTTP API', () => {
  it('POST creates a logged-in-owned session and returns an id', async () => {
    const { app, sessions } = build();
    const res = await app.inject({
      method: 'POST', url: '/api/sessions',
      headers: { authorization: 'Bearer good-token' },
      payload: { name: 'My Jam', description: 'groove' },
    });
    expect(res.statusCode).toBe(201);
    const { id } = res.json() as { id: string };
    const rec = await sessions.get(id);
    expect(rec?.ownerUserId).toBe('user-1');
    expect(rec?.ownerClientId).toBeNull();
    expect(rec?.name).toBe('My Jam');
    await app.close();
  });

  it('POST as a guest requires a clientId and records it', async () => {
    const { app, sessions } = build();
    const missing = await app.inject({ method: 'POST', url: '/api/sessions', payload: { name: 'g' } });
    expect(missing.statusCode).toBe(400);
    const ok = await app.inject({ method: 'POST', url: '/api/sessions', payload: { name: 'g', clientId: 'client-9' } });
    expect(ok.statusCode).toBe(201);
    const { id } = ok.json() as { id: string };
    const rec = await sessions.get(id);
    expect(rec?.ownerUserId).toBeNull();
    expect(rec?.ownerClientId).toBe('client-9');
    await app.close();
  });

  it('POST rejects a malformed body', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'POST', url: '/api/sessions', payload: { name: '' } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('POST with seed=default seeds a fresh 4-track project', async () => {
    const { app, sessions } = build();
    const res = await app.inject({
      method: 'POST', url: '/api/sessions',
      headers: { authorization: 'Bearer good-token' },
      payload: { name: 'n', seed: 'default' },
    });
    const { id } = res.json() as { id: string };
    expect((await sessions.getSnapshot(id))?.tracks).toHaveLength(4);
    await app.close();
  });

  it('POST with an imported project seed stores it', async () => {
    const { app, sessions } = build();
    const project = freshProject();
    project.bpm = 137;
    const res = await app.inject({
      method: 'POST', url: '/api/sessions',
      headers: { authorization: 'Bearer good-token' },
      payload: { name: 'n', seed: project },
    });
    const { id } = res.json() as { id: string };
    expect((await sessions.getSnapshot(id))?.bpm).toBe(137);
    await app.close();
  });

  it('GET lists logged-in sessions but hides empty guest sessions', async () => {
    const sessions = new InMemorySessionStore();
    await sessions.create(loggedIn('a'));
    await sessions.create(guest('g', 'c1'));
    const { app } = build(sessions, new Map([['g', 0]]));
    const res = await app.inject({ method: 'GET', url: '/api/sessions' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { sessions: { id: string }[] };
    expect(body.sessions.map((s) => s.id)).toEqual(['a']);
    await app.close();
  });

  it('PATCH lets the logged-in owner edit; rejects a non-owner', async () => {
    const sessions = new InMemorySessionStore();
    await sessions.create(loggedIn('a', { description: 'd' }));
    const { app } = build(sessions);
    const ok = await app.inject({
      method: 'PATCH', url: '/api/sessions/a',
      headers: { authorization: 'Bearer good-token' }, payload: { description: 'new' },
    });
    expect(ok.statusCode).toBe(204);
    expect((await sessions.get('a'))?.description).toBe('new');
    const denied = await app.inject({
      method: 'PATCH', url: '/api/sessions/a',
      headers: { authorization: 'Bearer other-token' }, payload: { description: 'x' },
    });
    expect(denied.statusCode).toBe(403);
    await app.close();
  });

  it('PATCH lets a guest owner edit by matching clientId', async () => {
    const sessions = new InMemorySessionStore();
    await sessions.create(guest('g', 'c1'));
    const { app } = build(sessions);
    const ok = await app.inject({ method: 'PATCH', url: '/api/sessions/g', payload: { name: 'renamed', clientId: 'c1' } });
    expect(ok.statusCode).toBe(204);
    expect((await sessions.get('g'))?.name).toBe('renamed');
    const denied = await app.inject({ method: 'PATCH', url: '/api/sessions/g', payload: { name: 'x', clientId: 'wrong' } });
    expect(denied.statusCode).toBe(403);
    await app.close();
  });

  it('PATCH returns 404 for an unknown session', async () => {
    const { app } = build();
    const res = await app.inject({
      method: 'PATCH', url: '/api/sessions/none',
      headers: { authorization: 'Bearer good-token' }, payload: { name: 'x' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('DELETE is allowed for the logged-in owner only', async () => {
    const sessions = new InMemorySessionStore();
    await sessions.create(loggedIn('a'));
    const { app } = build(sessions);
    const denied = await app.inject({ method: 'DELETE', url: '/api/sessions/a', headers: { authorization: 'Bearer other-token' } });
    expect(denied.statusCode).toBe(403);
    const ok = await app.inject({ method: 'DELETE', url: '/api/sessions/a', headers: { authorization: 'Bearer good-token' } });
    expect(ok.statusCode).toBe(204);
    expect(await sessions.get('a')).toBeNull();
    await app.close();
  });

  it('DELETE on a guest session is forbidden (no logged-in owner)', async () => {
    const sessions = new InMemorySessionStore();
    await sessions.create(guest('g', 'c1'));
    const { app } = build(sessions);
    const res = await app.inject({ method: 'DELETE', url: '/api/sessions/g', headers: { authorization: 'Bearer good-token' } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @fiddle/server -- routes/sessions`
Expected: FAIL — cannot find module `./sessions.js`.

- [ ] **Step 3: Implement `sessionsRoute`**

Create `packages/server/src/routes/sessions.ts`:

```ts
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  CreateSessionBodySchema,
  PatchSessionBodySchema,
  DEFAULT_SESSION_SETTINGS,
  freshProject,
  randomBase32,
} from '@fiddle/shared';
import type { Project } from '@fiddle/shared';
import type { SessionStore } from '../session/SessionStore.js';
import type { VerifiedClaims } from '../auth/verifyToken.js';
import { buildLobbyList } from '../session/lobby.js';

interface Deps {
  sessions: SessionStore;
  verify: (token: string) => Promise<VerifiedClaims | null>;
  // Live member counts per room, injected so the route stays decoupled from the
  // RoomStore type (buildServer passes () => roomStore.roomMemberCounts()).
  liveCounts: () => Promise<Map<string, number>>;
}

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (typeof h === 'string' && h.startsWith('Bearer ')) return h.slice(7);
  return null;
}

async function claimsFrom(req: FastifyRequest, verify: Deps['verify']): Promise<VerifiedClaims | null> {
  const token = bearer(req);
  return token ? verify(token) : null;
}

export async function sessionsRoute(app: FastifyInstance, deps: Deps) {
  // List: durable sessions merged with live presence. Public, no auth.
  app.get('/api/sessions', async () => {
    const [records, counts] = await Promise.all([deps.sessions.list(), deps.liveCounts()]);
    return { sessions: buildLobbyList(records, counts) };
  });

  // Create. Bearer JWT → logged-in owner; otherwise guest (needs clientId).
  app.post('/api/sessions', async (req, reply) => {
    const parsed = CreateSessionBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', details: parsed.error.flatten() });
    }
    const body = parsed.data;
    const claims = await claimsFrom(req, deps.verify);

    let ownerUserId: string | null = null;
    let ownerClientId: string | null = null;
    if (claims) {
      ownerUserId = claims.userId;
    } else {
      if (!body.clientId) {
        return reply.code(400).send({ error: 'guest sessions require clientId' });
      }
      ownerClientId = body.clientId;
    }

    // seed is either the literal 'default' or a schema-validated project.
    const project: Project = body.seed === 'default' ? freshProject() : (body.seed as Project);
    const id = randomBase32(9);
    await deps.sessions.create({
      id,
      name: body.name,
      description: body.description,
      ownerUserId,
      ownerClientId,
      settings: body.settings ?? DEFAULT_SESSION_SETTINGS,
      project,
    });
    return reply.code(201).send({ id });
  });

  // Patch name/description/settings. Owner = matching userId (logged-in) OR
  // matching ownerClientId (guest, weak — strengthened in the moderation spec).
  app.patch('/api/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = PatchSessionBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', details: parsed.error.flatten() });
    }
    const record = await deps.sessions.get(id);
    if (!record) return reply.code(404).send({ error: 'not found' });

    const claims = await claimsFrom(req, deps.verify);
    const isOwner =
      (claims !== null && record.ownerUserId !== null && claims.userId === record.ownerUserId) ||
      (record.ownerClientId !== null && parsed.data.clientId === record.ownerClientId);
    if (!isOwner) return reply.code(403).send({ error: 'not the owner' });

    await deps.sessions.updateMeta(id, {
      name: parsed.data.name,
      description: parsed.data.description,
      settings: parsed.data.settings,
    });
    return reply.code(204).send();
  });

  // Delete: logged-in owner only. Guest sessions self-prune on empty (SessionSync).
  app.delete('/api/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const record = await deps.sessions.get(id);
    if (!record) return reply.code(404).send({ error: 'not found' });

    const claims = await claimsFrom(req, deps.verify);
    const isOwner = claims !== null && record.ownerUserId !== null && claims.userId === record.ownerUserId;
    if (!isOwner) return reply.code(403).send({ error: 'not the owner' });

    await deps.sessions.delete(id);
    return reply.code(204).send();
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @fiddle/server -- routes/sessions`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/routes/sessions.ts packages/server/src/routes/sessions.test.ts
git commit -m "feat(server): /api/sessions CRUD routes

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Wire into the server + graceful-shutdown flush

**Files:**
- Modify: `packages/server/src/server.ts`
- Modify: `packages/server/src/routes/ws.ts`
- Modify: `packages/server/src/index.ts`
- Modify: `packages/server/src/server.test.ts`

- [ ] **Step 1: Add the disconnect flush hook to `wsRoute`**

In `packages/server/src/routes/ws.ts`:

(a) Add an import near the other type imports:

```ts
import type { SessionSync } from '../session/SessionSync.js';
```

(b) Add `sessionSync` to the `Deps` interface:

```ts
interface Deps {
  store: RoomStore;
  pool: ConnectionPool;
  verify: (token: string) => Promise<VerifiedClaims | null>;
  profiles: ProfileStore;
  sessionSync: SessionSync;
}
```

(c) Replace the existing `socket.on('close', …)` handler with:

```ts
    socket.on('close', () => {
      // Remove from pool BEFORE onClose so pool.size === 0 means "last socket".
      deps.pool.remove(roomId, adapted);
      const roomNowEmpty = deps.pool.size(roomId) === 0;
      handler.onClose().catch((err) => app.log.error({ err }, 'ws onClose'));
      // Persist the room's project on every disconnect (and prune guest sessions
      // when the room empties). Independent of onClose; both read live state.
      deps.sessionSync
        .handleDisconnect(roomId, roomNowEmpty)
        .catch((err) => app.log.error({ err }, 'session disconnect'));
    });
```

- [ ] **Step 2: Wire `SessionStore` + `SessionSync` + routes into `buildServer`**

In `packages/server/src/server.ts`:

(a) Add imports (with the existing import block):

```ts
import { InMemorySessionStore } from './session/InMemorySessionStore.js';
import { PostgresSessionStore } from './session/PostgresSessionStore.js';
import type { SessionStore } from './session/SessionStore.js';
import { SessionSync } from './session/SessionSync.js';
import { sessionsRoute } from './routes/sessions.js';
```

(b) Replace the profiles-construction block. Currently:

```ts
  const profiles: ProfileStore = dbUrl
    ? new PostgresProfileStore(postgres(dbUrl))
    : new InMemoryProfileStore();
```

with a shared connection that backs both profiles and sessions:

```ts
  // One Postgres connection backs both privileged read/write stores when a DB is
  // configured; otherwise both fall back to in-memory.
  const sql = dbUrl ? postgres(dbUrl) : null;
  const profiles: ProfileStore = sql
    ? new PostgresProfileStore(sql)
    : new InMemoryProfileStore();
  const sessions: SessionStore = sql
    ? new PostgresSessionStore(sql)
    : new InMemorySessionStore();

  const sessionSync = new SessionSync(
    store,
    sessions,
    (msg, fields) => app.log.info(fields ?? {}, msg),
  );
```

(c) Replace the route registration block. Currently:

```ts
  app.register(websocket);
  app.register(healthRoute);
  app.register(async (a) => wsRoute(a, { store, pool, verify, profiles }));
  return app;
```

with:

```ts
  app.register(websocket);
  app.register(healthRoute);
  app.register(async (a) =>
    sessionsRoute(a, { sessions, verify, liveCounts: () => store.roomMemberCounts() }),
  );
  app.register(async (a) => wsRoute(a, { store, pool, verify, profiles, sessionSync }));

  // Autosave: periodic sweep of dirty rooms + a final flush on graceful shutdown
  // (SIGTERM → app.close() → onClose). stop() first so no sweep races the flush.
  sessionSync.start();
  app.addHook('onClose', async () => {
    sessionSync.stop();
    await sessionSync.flushAllDirty();
  });

  return app;
```

- [ ] **Step 3: Add SIGTERM/SIGINT handling to the entry point**

In `packages/server/src/index.ts`, replace the file body after `const app = buildServer();` with:

```ts
const app = buildServer();
app.listen({ port, host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

// Graceful shutdown: app.close() runs the onClose hook (flushes dirty rooms to
// the SessionStore) before the process exits. Render sends SIGTERM on redeploy.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    app
      .close()
      .then(() => process.exit(0))
      .catch((err) => {
        app.log.error(err);
        process.exit(1);
      });
  });
}
```

(Keep the existing `port`/`host` constant declarations and the `import` lines at the top of the file unchanged.)

- [ ] **Step 4: Add `/api/sessions` smoke tests to `server.test.ts`**

In `packages/server/src/server.test.ts`, add these tests inside the existing `describe('server', …)` block (before its closing `});`). Both delete the Supabase env first so the server uses the in-memory stores deterministically — without this, an ambient `DATABASE_URL` would make `POST` write a row to a real Postgres:

```ts
  it('GET /api/sessions returns a sessions array', async () => {
    const { SUPABASE_JWKS_URL, DATABASE_URL } = process.env;
    delete process.env.SUPABASE_JWKS_URL;
    delete process.env.DATABASE_URL;
    try {
      const app = buildServer();
      const res = await app.inject({ method: 'GET', url: '/api/sessions' });
      expect(res.statusCode).toBe(200);
      expect(Array.isArray((res.json() as { sessions: unknown[] }).sessions)).toBe(true);
      await app.close();
    } finally {
      if (SUPABASE_JWKS_URL !== undefined) process.env.SUPABASE_JWKS_URL = SUPABASE_JWKS_URL;
      if (DATABASE_URL !== undefined) process.env.DATABASE_URL = DATABASE_URL;
    }
  });

  it('POST /api/sessions creates a guest session (clientId required)', async () => {
    const { SUPABASE_JWKS_URL, DATABASE_URL } = process.env;
    delete process.env.SUPABASE_JWKS_URL;
    delete process.env.DATABASE_URL;
    try {
      const app = buildServer();
      // Guest-only (no JWKS) → verify() returns null → guest path.
      const noClient = await app.inject({ method: 'POST', url: '/api/sessions', payload: { name: 'jam' } });
      expect(noClient.statusCode).toBe(400);
      const res = await app.inject({ method: 'POST', url: '/api/sessions', payload: { name: 'jam', clientId: 'c1' } });
      expect(res.statusCode).toBe(201);
      expect((res.json() as { id: string }).id).toHaveLength(9);
      await app.close();
    } finally {
      if (SUPABASE_JWKS_URL !== undefined) process.env.SUPABASE_JWKS_URL = SUPABASE_JWKS_URL;
      if (DATABASE_URL !== undefined) process.env.DATABASE_URL = DATABASE_URL;
    }
  });
```

- [ ] **Step 5: Run the server test + full server suite**

Run: `npm test --workspace @fiddle/server`
Expected: PASS. All prior server tests stay green; `server.test.ts` gains 2 tests. (The default unit run excludes `protocol.e2e.test.ts`.)

- [ ] **Step 6: Run the e2e suite to confirm the WS path still works end-to-end**

Run: `npm run test:e2e --workspace @fiddle/server`
Expected: PASS — the real WebSocket handshake/sync still works with the new `wsRoute` dep and the autosave wiring. (If `npm run test:e2e` is not defined at the workspace level, run it from the repo root: `npm run test:e2e`.)

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/server.ts packages/server/src/routes/ws.ts packages/server/src/index.ts packages/server/src/server.test.ts
git commit -m "feat(server): wire SessionStore + autosave flusher into the server

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] **Run the full gate**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green. New tests: server gains the RoomStore persistence suite (3), lobby (4), SessionSync (6), routes/sessions (11), server.test (2) ≈ +26; shared gains api (6). The skipped Postgres session/profile suites stay skipped without `TEST_DATABASE_URL`. Builds clean.

- [ ] **Run the e2e suite once more on the merged result**

Run: `npm run test:e2e`
Expected: PASS (the WS protocol e2e still green — proves auto-mint/join is unchanged).

- [ ] **Confirm scope**

Run: `git diff main --stat`
Expected: only the files listed in this plan's File Structure (plus the Plan 1 files already on the branch). No client (`packages/client/**`) changes — the lobby UI + cutover are Plan 3.

---

## What Plan 3 will add (not in scope here)

- **Server room-init from `SessionStore`:** on first join, seed the in-memory room from `getSnapshot(roomId)` instead of `freshProject`; reject unknown session ids (removing auto-mint) so a raw `/r/<id>` to a non-existent session bounces to the lobby. This is the breaking cutover.
- **Client:** lobby-as-home navigation, `LobbyView`, the create dialog (default / import-JSON seed, disabled settings fields), session-scoped WS connect (`connectToSession` / `leaveSession`), the studio Leave control + owner Session-settings panel, and consuming `GET /api/sessions` (`LobbyEntry`) + the create/patch/delete endpoints with `CreateSessionBodySchema` / `PatchSessionBodySchema`.
- **Owner handle in the lobby:** resolve `ownerUserId` → username (via the profiles read) for display; the wire `LobbyEntry` already carries `ownerUserId`.
```
