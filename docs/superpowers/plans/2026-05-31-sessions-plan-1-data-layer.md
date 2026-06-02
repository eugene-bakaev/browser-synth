# Sessions — Plan 1: Session Data Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the durable persistence layer for sessions — a Postgres schema plus a `SessionStore` (interface + in-memory fake + Postgres implementation) — without wiring it into the live server yet.

**Architecture:** Mirrors the existing `ProfileStore` / `PostgresProfileStore` pattern. Two tables: `sessions` (metadata) and `session_snapshots` (the project jsonb blob, split out so lobby queries stay lean and version history is additive later). All new code; nothing existing is modified, so the build and tests stay green and the running app is unchanged. Plans 2 and 3 (API + flusher, then client lobby + cutover) build on this.

**Tech Stack:** TypeScript, npm workspaces (`@fiddle/shared`, `@fiddle/server`), Vitest, `postgres` (porsager) for Postgres, Supabase (Postgres) for the live DB.

**Spec:** `docs/superpowers/specs/2026-05-31-persistent-sessions-lobby-design.md`

**Conventions to follow:**
- Test logic/helpers; never mount `.vue` files (N/A here — server/shared only).
- Server `.js` import specifiers (NodeNext ESM): import from `'./Foo.js'` even though the file is `Foo.ts`.
- Postgres integration tests run only when `TEST_DATABASE_URL` is set; otherwise `describe.skip` (mirrors `PostgresProfileStore.test.ts`). The in-memory fake covers logic in the default run.
- Gate before any merge: `npm run typecheck && npm test && npm run build`.
- Commit messages end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## File Structure

- **Create** `supabase/migrations/0002_sessions.sql` — the `sessions` + `session_snapshots` tables (server-only access; no RLS).
- **Create** `packages/shared/src/session/settings.ts` — `SessionSettings` type + `DEFAULT_SESSION_SETTINGS`.
- **Create** `packages/shared/src/session/settings.test.ts` — defaults test.
- **Modify** `packages/shared/src/index.ts` — re-export the session settings module.
- **Create** `packages/server/src/session/SessionStore.ts` — interface + `SessionRecord` / `CreateSessionInput` types.
- **Create** `packages/server/src/session/InMemorySessionStore.ts` — in-memory fake.
- **Create** `packages/server/src/session/InMemorySessionStore.test.ts` — unit tests (the logic coverage).
- **Create** `packages/server/src/session/PostgresSessionStore.ts` — Postgres implementation.
- **Create** `packages/server/src/session/PostgresSessionStore.test.ts` — integration test (skipped without `TEST_DATABASE_URL`).

---

## Task 1: Database migration

**Files:**
- Create: `supabase/migrations/0002_sessions.sql`

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0002_sessions.sql`:

```sql
-- Sessions: durable, listable rooms. Metadata (sessions) is split from the
-- project blob (session_snapshots) so lobby list queries stay lean and a future
-- version-history table is additive. The realtime server reads/writes these via
-- DATABASE_URL (privileged). No RLS: the browser never touches these tables
-- directly — all access is through the server and the /api/sessions endpoints.

create table public.sessions (
  id              text primary key,                -- 9-char Crockford Base32 room id
  name            text not null,
  description     text not null default '',
  owner_user_id   uuid references auth.users(id) on delete set null,  -- null for guests
  owner_client_id text,                            -- guest creator's clientId
  settings        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index sessions_owner_user_id_idx on public.sessions (owner_user_id);

create table public.session_snapshots (
  session_id text primary key references public.sessions(id) on delete cascade,
  project    jsonb not null,
  updated_at timestamptz not null default now()
);
```

- [ ] **Step 2: Verify the SQL applies**

This migration is applied to the live DB later (a deploy step), not in CI. Verify it is syntactically valid by applying it to a throwaway local Postgres if one is available:

Run: `psql "$TEST_DATABASE_URL" -f supabase/migrations/0002_sessions.sql` (only if `TEST_DATABASE_URL` is set)
Expected: `CREATE TABLE` / `CREATE INDEX` with no errors. If no local DB is available, skip — Task 5's integration test exercises the same DDL shape.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0002_sessions.sql
git commit -m "feat(db): sessions + session_snapshots tables

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Shared session settings

**Files:**
- Create: `packages/shared/src/session/settings.ts`
- Create: `packages/shared/src/session/settings.test.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/session/settings.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_SESSION_SETTINGS } from './settings.js';

describe('DEFAULT_SESSION_SETTINGS', () => {
  it('provides inert defaults for the stored-but-disabled fields', () => {
    expect(DEFAULT_SESSION_SETTINGS).toEqual({
      maxWritableUsers: 4,
      tracksPerUser: 4,
    });
  });

  it('is a fresh object each import reference (not accidentally shared mutable)', () => {
    // Guards against a future change handing out a frozen/shared singleton that
    // callers mutate. A spread copy must be safe.
    const copy = { ...DEFAULT_SESSION_SETTINGS, name: undefined };
    expect(copy.maxWritableUsers).toBe(4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @fiddle/shared -- settings`
Expected: FAIL — cannot find module `./settings.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/shared/src/session/settings.ts`:

```ts
// Session settings — the per-session knobs shown to the creator. In the initial
// lobby slice only the session name/description (carried on the session row,
// not here) are functional; these two fields are stored and shown but inert
// (no enforcement) until read-only/observer mode and per-user track pools land.
export interface SessionSettings {
  // Max simultaneous writers. Stored + shown disabled this slice; enforcement
  // still comes from the connection cap (ROOM_CAP). Wired up alongside
  // read-only/observer mode later.
  maxWritableUsers: number;
  // Tracks each user may write. Stored + shown disabled; needs the per-user
  // track pool (ROADMAP #4) before it has any effect.
  tracksPerUser: number;
}

export const DEFAULT_SESSION_SETTINGS: SessionSettings = {
  maxWritableUsers: 4,
  tracksPerUser: 4,
};
```

- [ ] **Step 4: Re-export from the shared index**

In `packages/shared/src/index.ts`, add after the `export * from './path.js';` line:

```ts
// Session settings shape + defaults, shared by the lobby UI and the server.
export * from './session/settings.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test --workspace @fiddle/shared -- settings`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/session/settings.ts packages/shared/src/session/settings.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): SessionSettings type + defaults

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: SessionStore interface + types

**Files:**
- Create: `packages/server/src/session/SessionStore.ts`

No test in this task — it is a types-and-interface file with no runtime logic. Task 4 tests the interface through the in-memory implementation.

- [ ] **Step 1: Write the interface**

Create `packages/server/src/session/SessionStore.ts`:

```ts
// SessionStore — the persistence surface for durable sessions. Mirrors the
// ProfileStore / RoomStore pattern: async so the Postgres implementation drops
// in behind the same interface the in-memory fake satisfies.
//
// Two concerns, deliberately separate columns/tables behind one store:
//   - metadata (SessionRecord): small, listed frequently in the lobby.
//   - the project snapshot (getSnapshot/saveSnapshot): the ~28KB jsonb blob,
//     loaded only when entering a session and rewritten by the autosave flusher.

import type { Project, SessionSettings } from '@fiddle/shared';

export interface SessionRecord {
  id: string;
  name: string;
  description: string;
  ownerUserId: string | null;   // set for logged-in owners; null for guests
  ownerClientId: string | null; // guest creator's clientId; null for logged-in
  settings: SessionSettings;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateSessionInput {
  id: string;
  name: string;
  description: string;
  ownerUserId: string | null;
  ownerClientId: string | null;
  settings: SessionSettings;
  project: Project; // the initial snapshot (default project or imported JSON)
}

export interface UpdateMetaPatch {
  name?: string;
  description?: string;
  settings?: SessionSettings;
}

export interface SessionStore {
  // Creates the metadata row + its initial snapshot row together.
  create(input: CreateSessionInput): Promise<SessionRecord>;
  // Metadata only; null if no such session.
  get(id: string): Promise<SessionRecord | null>;
  // All sessions, most-recently-updated first. The lobby endpoint (Plan 2)
  // decides which to surface; the store does not filter.
  list(): Promise<SessionRecord[]>;
  // The current project snapshot; null if the session/snapshot is absent.
  getSnapshot(id: string): Promise<Project | null>;
  // UPSERT the current snapshot. No-op if the session row does not exist.
  saveSnapshot(id: string, project: Project): Promise<void>;
  // Patch metadata fields; only provided fields change. No-op if absent.
  updateMeta(id: string, patch: UpdateMetaPatch): Promise<void>;
  // Removes the session and (via cascade in Postgres) its snapshot.
  delete(id: string): Promise<void>;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no errors; the file is referenced by nothing yet but must compile).

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/session/SessionStore.ts
git commit -m "feat(server): SessionStore interface + types

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: InMemorySessionStore + tests

**Files:**
- Create: `packages/server/src/session/InMemorySessionStore.ts`
- Create: `packages/server/src/session/InMemorySessionStore.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/session/InMemorySessionStore.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { freshProject, DEFAULT_SESSION_SETTINGS } from '@fiddle/shared';
import { InMemorySessionStore } from './InMemorySessionStore.js';
import type { CreateSessionInput } from './SessionStore.js';

function input(overrides: Partial<CreateSessionInput> = {}): CreateSessionInput {
  return {
    id: 'sess-1',
    name: 'My Jam',
    description: 'a groove',
    ownerUserId: 'user-1',
    ownerClientId: null,
    settings: DEFAULT_SESSION_SETTINGS,
    project: freshProject(),
    ...overrides,
  };
}

describe('InMemorySessionStore', () => {
  it('create then get returns the metadata record', async () => {
    const store = new InMemorySessionStore();
    const created = await store.create(input());
    expect(created.id).toBe('sess-1');
    expect(created.name).toBe('My Jam');
    expect(created.ownerUserId).toBe('user-1');
    const got = await store.get('sess-1');
    expect(got?.name).toBe('My Jam');
    expect(got?.description).toBe('a groove');
  });

  it('get returns null for a missing session', async () => {
    const store = new InMemorySessionStore();
    expect(await store.get('nope')).toBeNull();
  });

  it('stores the initial snapshot and serves it back', async () => {
    const store = new InMemorySessionStore();
    await store.create(input());
    const snap = await store.getSnapshot('sess-1');
    expect(snap?.tracks).toHaveLength(4);
  });

  it('saveSnapshot overwrites the current snapshot', async () => {
    const store = new InMemorySessionStore();
    await store.create(input());
    const edited = freshProject();
    edited.bpm = 145;
    await store.saveSnapshot('sess-1', edited);
    expect((await store.getSnapshot('sess-1'))?.bpm).toBe(145);
  });

  it('saveSnapshot on a missing session is a no-op (no throw)', async () => {
    const store = new InMemorySessionStore();
    await store.saveSnapshot('ghost', freshProject());
    expect(await store.getSnapshot('ghost')).toBeNull();
  });

  it('list returns sessions most-recently-updated first', async () => {
    const store = new InMemorySessionStore();
    await store.create(input({ id: 'a' }));
    await store.create(input({ id: 'b' }));
    // Touch 'a' so it becomes the most recently updated.
    await store.updateMeta('a', { name: 'renamed' });
    const ids = (await store.list()).map((r) => r.id);
    expect(ids).toEqual(['a', 'b']);
  });

  it('updateMeta patches only provided fields and bumps updatedAt', async () => {
    const store = new InMemorySessionStore();
    const created = await store.create(input());
    await store.updateMeta('sess-1', { description: 'new desc' });
    const got = await store.get('sess-1');
    expect(got?.name).toBe('My Jam');        // unchanged
    expect(got?.description).toBe('new desc'); // changed
    expect(got!.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
  });

  it('updateMeta on a missing session is a no-op', async () => {
    const store = new InMemorySessionStore();
    await store.updateMeta('ghost', { name: 'x' });
    expect(await store.get('ghost')).toBeNull();
  });

  it('delete removes both the record and its snapshot', async () => {
    const store = new InMemorySessionStore();
    await store.create(input());
    await store.delete('sess-1');
    expect(await store.get('sess-1')).toBeNull();
    expect(await store.getSnapshot('sess-1')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @fiddle/server -- InMemorySessionStore`
Expected: FAIL — cannot find module `./InMemorySessionStore.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/server/src/session/InMemorySessionStore.ts`:

```ts
// In-memory SessionStore for unit tests and the no-database fallback path.
// Snapshot writes do NOT bump the record's updatedAt — that mirrors the table
// split, where the 60s autosave flush touches only session_snapshots.updated_at
// and not sessions.updated_at (so the lobby's metadata ordering reflects
// metadata/settings activity, not every autosave tick).

import type { Project } from '@fiddle/shared';
import type {
  CreateSessionInput,
  SessionRecord,
  SessionStore,
  UpdateMetaPatch,
} from './SessionStore.js';

export class InMemorySessionStore implements SessionStore {
  private readonly records = new Map<string, SessionRecord>();
  private readonly snapshots = new Map<string, Project>();

  async create(input: CreateSessionInput): Promise<SessionRecord> {
    const now = new Date();
    const record: SessionRecord = {
      id: input.id,
      name: input.name,
      description: input.description,
      ownerUserId: input.ownerUserId,
      ownerClientId: input.ownerClientId,
      settings: input.settings,
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(input.id, record);
    this.snapshots.set(input.id, input.project);
    return record;
  }

  async get(id: string): Promise<SessionRecord | null> {
    return this.records.get(id) ?? null;
  }

  async list(): Promise<SessionRecord[]> {
    return [...this.records.values()].sort(
      (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
    );
  }

  async getSnapshot(id: string): Promise<Project | null> {
    return this.snapshots.get(id) ?? null;
  }

  async saveSnapshot(id: string, project: Project): Promise<void> {
    if (!this.records.has(id)) return; // no row to attach to
    this.snapshots.set(id, project);
  }

  async updateMeta(id: string, patch: UpdateMetaPatch): Promise<void> {
    const record = this.records.get(id);
    if (!record) return;
    if (patch.name !== undefined) record.name = patch.name;
    if (patch.description !== undefined) record.description = patch.description;
    if (patch.settings !== undefined) record.settings = patch.settings;
    record.updatedAt = new Date();
  }

  async delete(id: string): Promise<void> {
    this.records.delete(id);
    this.snapshots.delete(id);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @fiddle/server -- InMemorySessionStore`
Expected: PASS (9 tests).

Note on the `list` ordering test: if it ever flakes because two `new Date()` calls land in the same millisecond, the `updateMeta('a', …)` still runs strictly after both creates, so `a.updatedAt >= b.updatedAt`; the sort is stable for equal keys, preserving insertion order `a, b` either way. No fix needed.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/session/InMemorySessionStore.ts packages/server/src/session/InMemorySessionStore.test.ts
git commit -m "feat(server): InMemorySessionStore + tests

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: PostgresSessionStore + integration test

**Files:**
- Create: `packages/server/src/session/PostgresSessionStore.ts`
- Create: `packages/server/src/session/PostgresSessionStore.test.ts`

- [ ] **Step 1: Write the implementation**

Create `packages/server/src/session/PostgresSessionStore.ts`:

```ts
import postgres from 'postgres';
import type { Project } from '@fiddle/shared';
import type {
  CreateSessionInput,
  SessionRecord,
  SessionStore,
  UpdateMetaPatch,
} from './SessionStore.js';

// The connected-client type postgres() returns (the package doesn't export a
// clean named `Sql` type across versions, so derive it from the constructor).
type Sql = ReturnType<typeof postgres>;

interface SessionRow {
  id: string;
  name: string;
  description: string;
  owner_user_id: string | null;
  owner_client_id: string | null;
  settings: SessionRecord['settings'];
  created_at: Date;
  updated_at: Date;
}

function toRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    ownerUserId: row.owner_user_id,
    ownerClientId: row.owner_client_id,
    settings: row.settings,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Writes/reads sessions via a privileged Postgres connection (DATABASE_URL).
// jsonb columns are written with sql.json() so objects serialise correctly.
export class PostgresSessionStore implements SessionStore {
  constructor(private readonly sql: Sql) {}

  async create(input: CreateSessionInput): Promise<SessionRecord> {
    const rows = await this.sql<SessionRow[]>`
      insert into sessions
        (id, name, description, owner_user_id, owner_client_id, settings)
      values
        (${input.id}, ${input.name}, ${input.description},
         ${input.ownerUserId}, ${input.ownerClientId}, ${this.sql.json(input.settings)})
      returning *
    `;
    await this.sql`
      insert into session_snapshots (session_id, project)
      values (${input.id}, ${this.sql.json(input.project as unknown as object)})
    `;
    return toRecord(rows[0]!);
  }

  async get(id: string): Promise<SessionRecord | null> {
    const rows = await this.sql<SessionRow[]>`
      select * from sessions where id = ${id} limit 1
    `;
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async list(): Promise<SessionRecord[]> {
    const rows = await this.sql<SessionRow[]>`
      select * from sessions order by updated_at desc
    `;
    return rows.map(toRecord);
  }

  async getSnapshot(id: string): Promise<Project | null> {
    const rows = await this.sql<{ project: Project }[]>`
      select project from session_snapshots where session_id = ${id} limit 1
    `;
    return rows[0]?.project ?? null;
  }

  async saveSnapshot(id: string, project: Project): Promise<void> {
    await this.sql`
      insert into session_snapshots (session_id, project, updated_at)
      values (${id}, ${this.sql.json(project as unknown as object)}, now())
      on conflict (session_id) do update
        set project = excluded.project, updated_at = now()
    `;
  }

  async updateMeta(id: string, patch: UpdateMetaPatch): Promise<void> {
    // Only touch provided fields; an unspecified field reuses its own column
    // value (a no-op assignment). updated_at always bumps.
    await this.sql`
      update sessions set
        name        = ${patch.name ?? this.sql`name`},
        description  = ${patch.description ?? this.sql`description`},
        settings     = ${patch.settings ? this.sql.json(patch.settings) : this.sql`settings`},
        updated_at  = now()
      where id = ${id}
    `;
  }

  async delete(id: string): Promise<void> {
    // session_snapshots row is removed by ON DELETE CASCADE.
    await this.sql`delete from sessions where id = ${id}`;
  }
}
```

- [ ] **Step 2: Write the integration test**

Create `packages/server/src/session/PostgresSessionStore.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import postgres from 'postgres';
import { freshProject, DEFAULT_SESSION_SETTINGS } from '@fiddle/shared';
import { PostgresSessionStore } from './PostgresSessionStore.js';

// Integration test: only runs when TEST_DATABASE_URL points at a throwaway
// Postgres. Skipped in the default unit run (InMemorySessionStore covers logic).
const url = process.env.TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe('PostgresSessionStore (integration)', () => {
  let sql: ReturnType<typeof postgres>;
  let store: PostgresSessionStore;

  beforeAll(async () => {
    sql = postgres(url!);
    // Minimal standalone schema (no auth.users FK) so the test is self-contained.
    await sql`create table if not exists sessions (
      id text primary key,
      name text not null,
      description text not null default '',
      owner_user_id uuid,
      owner_client_id text,
      settings jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )`;
    await sql`create table if not exists session_snapshots (
      session_id text primary key references sessions(id) on delete cascade,
      project jsonb not null,
      updated_at timestamptz not null default now()
    )`;
    store = new PostgresSessionStore(sql);
  });

  beforeEach(async () => {
    await sql`delete from sessions`; // cascades to session_snapshots
  });

  afterAll(async () => {
    await sql`drop table if exists session_snapshots`;
    await sql`drop table if exists sessions`;
    await sql.end();
  });

  it('create + get round-trips metadata and settings', async () => {
    await store.create({
      id: 's1', name: 'Jam', description: 'd',
      ownerUserId: null, ownerClientId: 'client-9',
      settings: DEFAULT_SESSION_SETTINGS, project: freshProject(),
    });
    const got = await store.get('s1');
    expect(got?.name).toBe('Jam');
    expect(got?.ownerClientId).toBe('client-9');
    expect(got?.settings).toEqual(DEFAULT_SESSION_SETTINGS);
  });

  it('getSnapshot returns the stored project; saveSnapshot upserts it', async () => {
    await store.create({
      id: 's1', name: 'Jam', description: '',
      ownerUserId: null, ownerClientId: null,
      settings: DEFAULT_SESSION_SETTINGS, project: freshProject(),
    });
    const edited = freshProject();
    edited.bpm = 150;
    await store.saveSnapshot('s1', edited);
    expect((await store.getSnapshot('s1'))?.bpm).toBe(150);
  });

  it('updateMeta changes only provided fields', async () => {
    await store.create({
      id: 's1', name: 'Jam', description: 'orig',
      ownerUserId: null, ownerClientId: null,
      settings: DEFAULT_SESSION_SETTINGS, project: freshProject(),
    });
    await store.updateMeta('s1', { description: 'changed' });
    const got = await store.get('s1');
    expect(got?.name).toBe('Jam');
    expect(got?.description).toBe('changed');
  });

  it('delete removes the row and cascades the snapshot', async () => {
    await store.create({
      id: 's1', name: 'Jam', description: '',
      ownerUserId: null, ownerClientId: null,
      settings: DEFAULT_SESSION_SETTINGS, project: freshProject(),
    });
    await store.delete('s1');
    expect(await store.get('s1')).toBeNull();
    expect(await store.getSnapshot('s1')).toBeNull();
  });

  it('list returns most-recently-updated first', async () => {
    await store.create({
      id: 'a', name: 'A', description: '', ownerUserId: null, ownerClientId: null,
      settings: DEFAULT_SESSION_SETTINGS, project: freshProject(),
    });
    await store.create({
      id: 'b', name: 'B', description: '', ownerUserId: null, ownerClientId: null,
      settings: DEFAULT_SESSION_SETTINGS, project: freshProject(),
    });
    await store.updateMeta('a', { name: 'A2' });
    expect((await store.list()).map((r) => r.id)).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 3: Run the test**

Run: `npm test --workspace @fiddle/server -- PostgresSessionStore`
Expected: without `TEST_DATABASE_URL` — the suite is SKIPPED (reported as skipped, run passes). With `TEST_DATABASE_URL` set to a throwaway Postgres — 5 tests PASS.

- [ ] **Step 4: Typecheck the whole workspace**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/session/PostgresSessionStore.ts packages/server/src/session/PostgresSessionStore.test.ts
git commit -m "feat(server): PostgresSessionStore + integration test

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] **Run the full gate**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green. Test counts grow by the new shared (2) and server in-memory (9) tests; the Postgres session suite reports as skipped (joining the existing skipped Postgres profile suite) unless `TEST_DATABASE_URL` is set. Existing tests unchanged (no existing files modified except the additive shared `index.ts` re-export).

- [ ] **Confirm nothing existing changed behavior**

Run: `git diff main --stat`
Expected: only new files under `supabase/migrations/`, `packages/shared/src/session/`, `packages/server/src/session/`, plus the one-line re-export added to `packages/shared/src/index.ts`.

---

## What Plan 2 will add (not in scope here)

- Wire `SessionStore` into `buildServer()` (Postgres when `DATABASE_URL`, else `InMemorySessionStore`), mirroring the `profiles` wiring.
- `GET/POST/PATCH/DELETE /api/sessions` Fastify routes, reusing `verifyToken`.
- The autosave flusher: a `dirty` flag set in `RoomStore.appendOp`, a 60s sweep, flush-on-disconnect, and a SIGTERM flush, all writing via `SessionStore.saveSnapshot`.
- The lobby list = `SessionStore.list()` merged with in-memory presence (member counts; guest sessions surfaced only while occupied).

## What Plan 3 will add (not in scope here)

- Server room-init loads the project from `SessionStore` and rejects unknown sessions.
- Client: lobby-as-home navigation, removal of auto-mint, session-scoped WS connection (`connectToSession` / `leaveSession`), `LobbyView`, the create dialog (default / import-JSON seed), and the studio Leave + owner Session-settings panel.
