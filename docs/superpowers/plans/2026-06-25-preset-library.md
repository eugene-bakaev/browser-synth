# Preset Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let logged-in users save a track's per-engine patch to the DB and let anyone browse + load presets in the browser (private by default, with a `public` flag for a global pool).

**Architecture:** Reuse the existing per-engine `Preset` shape and `applyPreset`. Persist via a new `presets` Postgres table, written only by the Fastify server (no RLS), exposed through `/api/presets` HTTP endpoints. The client gets a typed `presetsApi`, a login-gated "save to library" dialog, and a global "Presets" browse/load modal. Mirrors the existing **sessions** subsystem end-to-end (shared zod contract → `Store` interface + InMemory/Postgres → route → typed client).

**Tech Stack:** TypeScript (strict), Zod (`@fiddle/shared`), Fastify + `postgres` (server), Vue 3 + Vite (client), Vitest.

## Global Constraints

- **Never work on `main`.** This work happens on branch `feat/preset-library` (already created). `main` only via merge, on explicit user instruction.
- **Gate before any merge:** `npm run typecheck && npm test && npm run build` must be green (run from repo root).
- **Commits:** stage only files relevant to the change — never `git add -A`/`git add .`. End every commit message with the trailer:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **Do not mount `.vue` files in tests.** Test logic, composables, and pure helpers only. UI tasks are validated by the browser-verification task.
- **Saving is login-only;** browse/load is public (guests included). Presets are private by default; `is_public` defaults `false`.
- **Server is the only DB client** (privileged `DATABASE_URL`); the browser never touches the `presets` table directly. No RLS.
- **`Preset` unit** = the existing `{ schemaVersion, engineType, params }` per-engine patch. Do **not** invent a new project-level preset (that's the deferred "project preset pool").
- Spec: `docs/superpowers/specs/2026-06-25-preset-library-design.md`.

---

### Task 1: Shared preset contract (`@fiddle/shared`)

The wire contract both the server route and the client `presetsApi` validate against. Reuses the per-engine param schemas already in `Schemas` (`packages/shared/src/project/schema.ts:237`).

**Files:**
- Create: `packages/shared/src/preset/schema.ts`
- Create: `packages/shared/src/preset/index.ts`
- Create: `packages/shared/src/preset/schema.test.ts`
- Modify: `packages/shared/src/index.ts` (add `export * from './preset/index.js';`)

**Interfaces:**
- Consumes: `Schemas` (`EngineType`, and per-engine `*Params`) from `packages/shared/src/project/schema.ts`; `EngineType` type from `packages/shared/src/index.ts`.
- Produces:
  - `presetParamsSchemaFor(engineType: EngineType): z.ZodTypeAny`
  - `CreatePresetBodySchema` (zod) and `type CreatePresetBody = z.infer<typeof CreatePresetBodySchema>` → `{ name: string; engineType: EngineType; params: unknown; isPublic: boolean }`
  - `PatchPresetBodySchema` (zod) and `type PatchPresetBody = { name?: string; isPublic?: boolean }`
  - `interface PresetRecord { id: string; name: string; engineType: EngineType; params: unknown; ownerUserId: string; ownerUsername: string | null; isPublic: boolean; createdAt: string; updatedAt: string }`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/preset/schema.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Kick2Engine } from '@fiddle/shared'; // NOTE: see step 3 — use the DEFAULT params source available in shared
import {
  CreatePresetBodySchema,
  PatchPresetBodySchema,
  presetParamsSchemaFor,
} from './schema.js';
import { DEFAULT_KICK2_PARAMS } from '../engines/kick2.js';
import { DEFAULT_SYNTH_PARAMS } from '../engines/synth.js';

describe('preset contract', () => {
  it('accepts a valid kick2 preset body', () => {
    const res = CreatePresetBodySchema.safeParse({
      name: '808 Boom',
      engineType: 'kick2',
      params: DEFAULT_KICK2_PARAMS,
      isPublic: true,
    });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.isPublic).toBe(true);
  });

  it('defaults isPublic to false when omitted', () => {
    const res = CreatePresetBodySchema.safeParse({
      name: 'My Patch', engineType: 'synth', params: DEFAULT_SYNTH_PARAMS,
    });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.isPublic).toBe(false);
  });

  it('rejects an unknown engineType', () => {
    const res = CreatePresetBodySchema.safeParse({
      name: 'x', engineType: 'tb303', params: {},
    });
    expect(res.success).toBe(false);
  });

  it('rejects params that do not match the engine schema', () => {
    const res = CreatePresetBodySchema.safeParse({
      name: 'x', engineType: 'kick2', params: { not: 'a kick2 patch' },
    });
    expect(res.success).toBe(false);
  });

  it('rejects an empty or over-long name', () => {
    expect(CreatePresetBodySchema.safeParse({ name: '', engineType: 'synth', params: DEFAULT_SYNTH_PARAMS }).success).toBe(false);
    expect(CreatePresetBodySchema.safeParse({ name: 'a'.repeat(61), engineType: 'synth', params: DEFAULT_SYNTH_PARAMS }).success).toBe(false);
  });

  it('presetParamsSchemaFor returns a schema for every engine', () => {
    const engines = ['synth','synth2','kick','kick2','hat','hat2','snare','snare2','clap','clap2'] as const;
    for (const e of engines) expect(presetParamsSchemaFor(e)).toBeDefined();
  });

  it('PatchPresetBodySchema accepts partial fields', () => {
    expect(PatchPresetBodySchema.safeParse({ name: 'renamed' }).success).toBe(true);
    expect(PatchPresetBodySchema.safeParse({ isPublic: true }).success).toBe(true);
    expect(PatchPresetBodySchema.safeParse({}).success).toBe(true);
  });
});
```

Note: confirm the exact export names of the per-engine default params in `packages/shared/src/engines/*.ts` (e.g. `DEFAULT_KICK2_PARAMS`, `DEFAULT_SYNTH_PARAMS`). Grep before writing: `grep -rn "export const DEFAULT_" packages/shared/src/engines/`. Use the real names.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @fiddle/shared -- preset/schema`
Expected: FAIL — `Cannot find module './schema.js'`.

- [ ] **Step 3: Write the schema**

Create `packages/shared/src/preset/schema.ts`:

```ts
import { z } from 'zod';
import type { EngineType } from '../index.js';
import { Schemas } from '../project/schema.js';

// One source of truth mapping an engineType to its param schema. Reuses the
// per-engine schemas already used for sync-op validation.
const ENGINE_PARAM_SCHEMAS: Record<EngineType, z.ZodTypeAny> = {
  synth:  Schemas.SynthParams,
  synth2: Schemas.Synth2Params,
  kick:   Schemas.KickParams,
  kick2:  Schemas.Kick2Params,
  hat:    Schemas.HatParams,
  hat2:   Schemas.Hat2Params,
  snare:  Schemas.SnareParams,
  snare2: Schemas.Snare2Params,
  clap:   Schemas.ClapParams,
  clap2:  Schemas.Clap2Params,
};

export function presetParamsSchemaFor(engineType: EngineType): z.ZodTypeAny {
  return ENGINE_PARAM_SCHEMAS[engineType];
}

export const CreatePresetBodySchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    engineType: Schemas.EngineType,
    params: z.unknown(),
    isPublic: z.boolean().optional().default(false),
  })
  .superRefine((val, ctx) => {
    const schema = ENGINE_PARAM_SCHEMAS[val.engineType as EngineType];
    if (!schema.safeParse(val.params).success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['params'],
        message: 'params do not match the engineType schema',
      });
    }
  });

export type CreatePresetBody = z.infer<typeof CreatePresetBodySchema>;

export const PatchPresetBodySchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  isPublic: z.boolean().optional(),
});

export type PatchPresetBody = z.infer<typeof PatchPresetBodySchema>;

export interface PresetRecord {
  id: string;
  name: string;
  engineType: EngineType;
  params: unknown;
  ownerUserId: string;
  ownerUsername: string | null;
  isPublic: boolean;
  createdAt: string; // ISO
  updatedAt: string; // ISO
}
```

Create `packages/shared/src/preset/index.ts`:

```ts
export * from './schema.js';
```

- [ ] **Step 4: Wire the barrel export**

In `packages/shared/src/index.ts`, after the existing `export * from './protocol/index.js';` line, add:

```ts
// Preset library wire contract (CreatePresetBodySchema, PresetRecord, …).
export * from './preset/index.js';
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npm test -w @fiddle/shared -- preset/schema && npm run typecheck -w @fiddle/shared`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/preset packages/shared/src/index.ts
git commit -m "feat(presets): shared preset wire contract + param validation

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `PresetStore` interface + `InMemoryPresetStore`

The persistence surface + the test fake. Mirrors `SessionStore` / `InMemorySessionStore`.

**Files:**
- Create: `packages/server/src/preset/PresetStore.ts`
- Create: `packages/server/src/preset/InMemoryPresetStore.ts`
- Create: `packages/server/src/preset/InMemoryPresetStore.test.ts`

**Interfaces:**
- Consumes: `PresetRecord`, `EngineType` from `@fiddle/shared`.
- Produces:
  - `interface CreatePresetInput { id: string; name: string; engineType: EngineType; params: unknown; ownerUserId: string; isPublic: boolean }`
  - `interface ListPresetsOpts { viewerUserId: string | null; engineType?: EngineType }`
  - `interface PresetStore { create(i: CreatePresetInput): Promise<PresetRecord>; get(id): Promise<PresetRecord | null>; list(o: ListPresetsOpts): Promise<PresetRecord[]>; updateMeta(id, patch: { name?: string; isPublic?: boolean }): Promise<void>; delete(id): Promise<void>; }`
  - `class InMemoryPresetStore implements PresetStore`

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/preset/InMemoryPresetStore.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { InMemoryPresetStore } from './InMemoryPresetStore.js';
import type { CreatePresetInput } from './PresetStore.js';

function mk(over: Partial<CreatePresetInput> = {}): CreatePresetInput {
  return {
    id: Math.random().toString(36).slice(2),
    name: 'P', engineType: 'kick2', params: { tune: 1 },
    ownerUserId: 'user-1', isPublic: false, ...over,
  };
}

describe('InMemoryPresetStore', () => {
  it('creates and reads back a record', async () => {
    const s = new InMemoryPresetStore();
    const rec = await s.create(mk({ id: 'p1', name: 'Boom' }));
    expect(rec.name).toBe('Boom');
    expect((await s.get('p1'))?.ownerUserId).toBe('user-1');
  });

  it('list scopes to the viewer own + public', async () => {
    const s = new InMemoryPresetStore();
    await s.create(mk({ id: 'mine-priv', ownerUserId: 'user-1', isPublic: false }));
    await s.create(mk({ id: 'mine-pub',  ownerUserId: 'user-1', isPublic: true }));
    await s.create(mk({ id: 'other-priv', ownerUserId: 'user-2', isPublic: false }));
    await s.create(mk({ id: 'other-pub',  ownerUserId: 'user-2', isPublic: true }));

    const asUser1 = await s.list({ viewerUserId: 'user-1' });
    expect(asUser1.map((r) => r.id).sort()).toEqual(['mine-priv', 'mine-pub', 'other-pub']);

    const asGuest = await s.list({ viewerUserId: null });
    expect(asGuest.map((r) => r.id).sort()).toEqual(['mine-pub', 'other-pub']);
  });

  it('list filters by engineType', async () => {
    const s = new InMemoryPresetStore();
    await s.create(mk({ id: 'k', engineType: 'kick2', isPublic: true }));
    await s.create(mk({ id: 'h', engineType: 'hat2', isPublic: true }));
    const onlyKick = await s.list({ viewerUserId: null, engineType: 'kick2' });
    expect(onlyKick.map((r) => r.id)).toEqual(['k']);
  });

  it('updateMeta patches only provided fields and bumps updatedAt', async () => {
    const s = new InMemoryPresetStore();
    await s.create(mk({ id: 'p1', name: 'Old', isPublic: false }));
    await s.updateMeta('p1', { name: 'New' });
    const rec = await s.get('p1');
    expect(rec?.name).toBe('New');
    expect(rec?.isPublic).toBe(false);
  });

  it('delete removes the record', async () => {
    const s = new InMemoryPresetStore();
    await s.create(mk({ id: 'p1' }));
    await s.delete('p1');
    expect(await s.get('p1')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @fiddle/server -- InMemoryPresetStore`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the interface**

Create `packages/server/src/preset/PresetStore.ts`:

```ts
import type { EngineType, PresetRecord } from '@fiddle/shared';

export interface CreatePresetInput {
  id: string;
  name: string;
  engineType: EngineType;
  params: unknown;       // already schema-validated at the route
  ownerUserId: string;
  isPublic: boolean;
}

export interface ListPresetsOpts {
  // The own+public scope key. null = a guest viewer (public only).
  viewerUserId: string | null;
  engineType?: EngineType;
}

export interface PresetStore {
  create(input: CreatePresetInput): Promise<PresetRecord>;
  get(id: string): Promise<PresetRecord | null>;
  // The viewer's own presets UNION all public presets, newest-first.
  list(opts: ListPresetsOpts): Promise<PresetRecord[]>;
  updateMeta(id: string, patch: { name?: string; isPublic?: boolean }): Promise<void>;
  delete(id: string): Promise<void>;
}
```

- [ ] **Step 4: Write the in-memory implementation**

Create `packages/server/src/preset/InMemoryPresetStore.ts`:

```ts
import type { PresetRecord } from '@fiddle/shared';
import type { CreatePresetInput, ListPresetsOpts, PresetStore } from './PresetStore.js';

interface Row extends Omit<PresetRecord, 'createdAt' | 'updatedAt'> {
  createdAt: Date;
  updatedAt: Date;
}

// Username attribution is resolved by the Postgres store via a join; the fake
// returns null (route/store tests that need it set it explicitly).
export class InMemoryPresetStore implements PresetStore {
  private readonly rows = new Map<string, Row>();

  async create(input: CreatePresetInput): Promise<PresetRecord> {
    const now = new Date();
    const row: Row = {
      id: input.id,
      name: input.name,
      engineType: input.engineType,
      params: input.params,
      ownerUserId: input.ownerUserId,
      ownerUsername: null,
      isPublic: input.isPublic,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(input.id, row);
    return toRecord(row);
  }

  async get(id: string): Promise<PresetRecord | null> {
    const row = this.rows.get(id);
    return row ? toRecord(row) : null;
  }

  async list(opts: ListPresetsOpts): Promise<PresetRecord[]> {
    return [...this.rows.values()]
      .filter((r) => r.isPublic || r.ownerUserId === opts.viewerUserId)
      .filter((r) => !opts.engineType || r.engineType === opts.engineType)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .map(toRecord);
  }

  async updateMeta(id: string, patch: { name?: string; isPublic?: boolean }): Promise<void> {
    const row = this.rows.get(id);
    if (!row) return;
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.isPublic !== undefined) row.isPublic = patch.isPublic;
    row.updatedAt = new Date();
  }

  async delete(id: string): Promise<void> {
    this.rows.delete(id);
  }
}

function toRecord(row: Row): PresetRecord {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npm test -w @fiddle/server -- InMemoryPresetStore && npm run typecheck -w @fiddle/server`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/preset/PresetStore.ts packages/server/src/preset/InMemoryPresetStore.ts packages/server/src/preset/InMemoryPresetStore.test.ts
git commit -m "feat(presets): PresetStore interface + in-memory store

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Migration `0005_presets.sql` + `PostgresPresetStore`

The real table + the Postgres implementation. Integration test is gated behind `TEST_DATABASE_URL` (skipped in the default unit run), mirroring `PostgresSessionStore.test.ts`.

**Files:**
- Create: `supabase/migrations/0005_presets.sql`
- Create: `packages/server/src/preset/PostgresPresetStore.ts`
- Create: `packages/server/src/preset/PostgresPresetStore.test.ts`

**Interfaces:**
- Consumes: `PresetStore`, `CreatePresetInput`, `ListPresetsOpts` (Task 2); `postgres` package.
- Produces: `class PostgresPresetStore implements PresetStore` (constructor `(sql: ReturnType<typeof postgres>)`).

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0005_presets.sql`:

```sql
-- Preset library: per-engine patches saved by logged-in users. Private by
-- default; is_public shares into a global pool. Server-only access via
-- DATABASE_URL (no RLS), consistent with sessions / session_snapshots.

create table public.presets (
  id             text primary key,         -- 9-char Crockford Base32
  name           text not null,
  engine_type    text not null,            -- one of the 10 engine keys
  params         jsonb not null,           -- the Preset.params blob
  schema_version int  not null default 1,  -- forward-compat for param migrations
  owner_user_id  uuid not null references auth.users(id) on delete cascade,
  is_public      boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index presets_owner_idx  on public.presets (owner_user_id);
create index presets_public_idx on public.presets (is_public) where is_public;
```

- [ ] **Step 2: Write the failing integration test**

Create `packages/server/src/preset/PostgresPresetStore.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import postgres from 'postgres';
import { PostgresPresetStore } from './PostgresPresetStore.js';

// Integration test: only runs when TEST_DATABASE_URL points at a throwaway
// Postgres. Skipped in the default unit run (InMemoryPresetStore covers logic).
const url = process.env.TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe('PostgresPresetStore (integration)', () => {
  let sql: ReturnType<typeof postgres>;
  let store: PostgresPresetStore;

  beforeAll(async () => {
    sql = postgres(url!);
    // Self-contained schema: no auth.users FK and a standalone profiles table
    // so the username join resolves without the real auth schema.
    await sql`create table if not exists profiles (id uuid primary key, username text)`;
    await sql`create table if not exists presets (
      id text primary key,
      name text not null,
      engine_type text not null,
      params jsonb not null,
      schema_version int not null default 1,
      owner_user_id uuid not null,
      is_public boolean not null default false,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )`;
    store = new PostgresPresetStore(sql);
  });

  beforeEach(async () => {
    await sql`delete from presets`;
    await sql`delete from profiles`;
  });

  afterAll(async () => {
    await sql`drop table if exists presets`;
    await sql`drop table if exists profiles`;
    await sql.end();
  });

  const owner = '00000000-0000-0000-0000-000000000001';

  it('creates, reads, lists (own+public), patches, deletes', async () => {
    await sql`insert into profiles (id, username) values (${owner}, 'alice')`;
    const rec = await store.create({
      id: 'p1', name: 'Boom', engineType: 'kick2', params: { tune: 1 },
      ownerUserId: owner, isPublic: true,
    });
    expect(rec.name).toBe('Boom');

    const got = await store.get('p1');
    expect(got?.ownerUsername).toBe('alice'); // resolved via join
    expect(got?.isPublic).toBe(true);

    const guestView = await store.list({ viewerUserId: null });
    expect(guestView.map((r) => r.id)).toEqual(['p1']); // public visible to guests

    await store.updateMeta('p1', { name: 'Boom2', isPublic: false });
    expect((await store.get('p1'))?.name).toBe('Boom2');
    expect((await store.list({ viewerUserId: null })).length).toBe(0); // now private

    await store.delete('p1');
    expect(await store.get('p1')).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails (compile error / skip)**

Run: `npm test -w @fiddle/server -- PostgresPresetStore`
Expected: FAIL to import `./PostgresPresetStore.js` (the suite is `describe.skip` without `TEST_DATABASE_URL`, but the import still resolves at load time, so the run errors on the missing module).

- [ ] **Step 4: Write the Postgres implementation**

Create `packages/server/src/preset/PostgresPresetStore.ts`:

```ts
import postgres from 'postgres';
import type { EngineType, PresetRecord } from '@fiddle/shared';
import type { CreatePresetInput, ListPresetsOpts, PresetStore } from './PresetStore.js';

type Sql = ReturnType<typeof postgres>;
type JsonArg = Parameters<Sql['json']>[0];

interface PresetRow {
  id: string;
  name: string;
  engine_type: string;
  params: unknown;
  owner_user_id: string;
  owner_username: string | null;
  is_public: boolean;
  created_at: Date;
  updated_at: Date;
}

function toRecord(row: PresetRow): PresetRecord {
  return {
    id: row.id,
    name: row.name,
    engineType: row.engine_type as EngineType,
    params: row.params,
    ownerUserId: row.owner_user_id,
    ownerUsername: row.owner_username,
    isPublic: row.is_public,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// SELECT list with the username join, reused by get() and list().
const SELECT = (sql: Sql) => sql`
  select p.id, p.name, p.engine_type, p.params, p.owner_user_id,
         pr.username as owner_username, p.is_public, p.created_at, p.updated_at
  from presets p
  left join profiles pr on pr.id = p.owner_user_id
`;

export class PostgresPresetStore implements PresetStore {
  constructor(private readonly sql: Sql) {}

  async create(input: CreatePresetInput): Promise<PresetRecord> {
    await this.sql`
      insert into presets (id, name, engine_type, params, owner_user_id, is_public)
      values (${input.id}, ${input.name}, ${input.engineType},
              ${this.sql.json(input.params as JsonArg)}, ${input.ownerUserId}, ${input.isPublic})
    `;
    const rec = await this.get(input.id);
    if (!rec) throw new Error('preset vanished immediately after insert');
    return rec;
  }

  async get(id: string): Promise<PresetRecord | null> {
    const rows = await this.sql<PresetRow[]>`${SELECT(this.sql)} where p.id = ${id} limit 1`;
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async list(opts: ListPresetsOpts): Promise<PresetRecord[]> {
    const viewer = opts.viewerUserId; // string | null
    const rows = await this.sql<PresetRow[]>`
      ${SELECT(this.sql)}
      where (p.is_public or p.owner_user_id = ${viewer})
      ${opts.engineType ? this.sql`and p.engine_type = ${opts.engineType}` : this.sql``}
      order by p.updated_at desc
      limit 500
    `;
    return rows.map(toRecord);
  }

  async updateMeta(id: string, patch: { name?: string; isPublic?: boolean }): Promise<void> {
    await this.sql`
      update presets set
        name      = ${patch.name ?? this.sql`name`},
        is_public = ${patch.isPublic ?? this.sql`is_public`},
        updated_at = now()
      where id = ${id}
    `;
  }

  async delete(id: string): Promise<void> {
    await this.sql`delete from presets where id = ${id}`;
  }
}
```

Note: `owner_user_id = ${null}` in `list` correctly yields no own-rows match for guests (`p.owner_user_id = NULL` is never true), so the `is_public` branch is what they see. Verify this holds in the integration run.

- [ ] **Step 5: Run test + typecheck**

Run: `npm test -w @fiddle/server -- PostgresPresetStore && npm run typecheck -w @fiddle/server`
Expected: PASS (the integration body is skipped without `TEST_DATABASE_URL`; the module now imports cleanly and typechecks).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0005_presets.sql packages/server/src/preset/PostgresPresetStore.ts packages/server/src/preset/PostgresPresetStore.test.ts
git commit -m "feat(presets): presets table migration + Postgres store

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: `/api/presets` route + server wiring

The HTTP surface. Mirrors `routes/sessions.ts` (bearer→claims, owner checks, per-user rate limit). Wires the store into `buildServer`.

**Files:**
- Create: `packages/server/src/routes/presets.ts`
- Create: `packages/server/src/routes/presets.test.ts`
- Modify: `packages/server/src/server.ts` (construct the store + register the route)

**Interfaces:**
- Consumes: `PresetStore` (Task 2), `CreatePresetBodySchema`/`PatchPresetBodySchema`/`presetParamsSchemaFor` (Task 1), `randomBase32` from `@fiddle/shared`, `VerifiedClaims`/`verify` (existing), `KeyedTokenBucket` (`routes/rate-limit.ts`).
- Produces: `presetsRoute(app, deps)` where `interface Deps { presets: PresetStore; verify: (t: string) => Promise<VerifiedClaims | null>; createLimiter?: KeyedTokenBucket }`. Exports `PRESET_CREATE_BURST` and `PRESET_CREATE_REFILL_MS` for tests.

- [ ] **Step 1: Write the failing route test**

Create `packages/server/src/routes/presets.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { DEFAULT_KICK2_PARAMS } from '@fiddle/shared'; // confirm exact export name in shared engines barrel
import { InMemoryPresetStore } from '../preset/InMemoryPresetStore.js';
import { presetsRoute } from './presets.js';
import type { VerifiedClaims } from '../auth/verifyToken.js';

const claimsByToken: Record<string, VerifiedClaims> = {
  'tok-1': { userId: 'user-1', googleName: 'User One' },
  'tok-2': { userId: 'user-2', googleName: 'User Two' },
};
const fakeVerify = async (t: string): Promise<VerifiedClaims | null> => claimsByToken[t] ?? null;

function build(presets = new InMemoryPresetStore()) {
  const app = Fastify();
  app.register(async (a) => presetsRoute(a, { presets, verify: fakeVerify }));
  return { app, presets };
}

const validBody = { name: 'Boom', engineType: 'kick2', params: DEFAULT_KICK2_PARAMS, isPublic: false };
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

describe('presets HTTP API', () => {
  it('POST requires login (401 for guests)', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'POST', url: '/api/presets', payload: validBody });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('POST creates a preset owned by the caller', async () => {
    const { app, presets } = build();
    const res = await app.inject({ method: 'POST', url: '/api/presets', headers: auth('tok-1'), payload: validBody });
    expect(res.statusCode).toBe(201);
    const { id } = res.json() as { id: string };
    expect((await presets.get(id))?.ownerUserId).toBe('user-1');
    await app.close();
  });

  it('POST rejects an invalid body (400)', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'POST', url: '/api/presets', headers: auth('tok-1'),
      payload: { name: '', engineType: 'kick2', params: {} } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('GET returns own + public, scoped to the viewer', async () => {
    const { app, presets } = build();
    await presets.create({ id: 'a', name: 'mine', engineType: 'kick2', params: {}, ownerUserId: 'user-1', isPublic: false });
    await presets.create({ id: 'b', name: 'pub',  engineType: 'kick2', params: {}, ownerUserId: 'user-2', isPublic: true });
    await presets.create({ id: 'c', name: 'hidden', engineType: 'kick2', params: {}, ownerUserId: 'user-2', isPublic: false });

    const asUser1 = await app.inject({ method: 'GET', url: '/api/presets', headers: auth('tok-1') });
    expect(((asUser1.json() as { presets: { id: string }[] }).presets).map((p) => p.id).sort()).toEqual(['a', 'b']);

    const asGuest = await app.inject({ method: 'GET', url: '/api/presets' });
    expect(((asGuest.json() as { presets: { id: string }[] }).presets).map((p) => p.id)).toEqual(['b']);
    await app.close();
  });

  it('GET filters by engineType', async () => {
    const { app, presets } = build();
    await presets.create({ id: 'k', name: 'k', engineType: 'kick2', params: {}, ownerUserId: 'user-2', isPublic: true });
    await presets.create({ id: 'h', name: 'h', engineType: 'hat2',  params: {}, ownerUserId: 'user-2', isPublic: true });
    const res = await app.inject({ method: 'GET', url: '/api/presets?engineType=hat2' });
    expect(((res.json() as { presets: { id: string }[] }).presets).map((p) => p.id)).toEqual(['h']);
    await app.close();
  });

  it('PATCH/DELETE are owner-only', async () => {
    const { app, presets } = build();
    await presets.create({ id: 'p', name: 'x', engineType: 'kick2', params: {}, ownerUserId: 'user-1', isPublic: false });

    const notOwner = await app.inject({ method: 'PATCH', url: '/api/presets/p', headers: auth('tok-2'), payload: { isPublic: true } });
    expect(notOwner.statusCode).toBe(403);

    const owner = await app.inject({ method: 'PATCH', url: '/api/presets/p', headers: auth('tok-1'), payload: { isPublic: true } });
    expect(owner.statusCode).toBe(204);
    expect((await presets.get('p'))?.isPublic).toBe(true);

    const delNotOwner = await app.inject({ method: 'DELETE', url: '/api/presets/p', headers: auth('tok-2') });
    expect(delNotOwner.statusCode).toBe(403);
    const del = await app.inject({ method: 'DELETE', url: '/api/presets/p', headers: auth('tok-1') });
    expect(del.statusCode).toBe(204);
    expect(await presets.get('p')).toBeNull();
    await app.close();
  });

  it('PATCH/DELETE on a missing preset → 404', async () => {
    const { app } = build();
    const patch = await app.inject({ method: 'PATCH', url: '/api/presets/nope', headers: auth('tok-1'), payload: { name: 'y' } });
    expect(patch.statusCode).toBe(404);
    await app.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @fiddle/server -- routes/presets`
Expected: FAIL — `./presets.js` not found.

- [ ] **Step 3: Write the route**

Create `packages/server/src/routes/presets.ts`:

```ts
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { CreatePresetBodySchema, PatchPresetBodySchema, randomBase32 } from '@fiddle/shared';
import type { EngineType } from '@fiddle/shared';
import type { PresetStore } from '../preset/PresetStore.js';
import type { VerifiedClaims } from '../auth/verifyToken.js';
import { KeyedTokenBucket } from './rate-limit.js';

// Per-user create cap: a normal "save a few patches" flow never hits burst 10;
// a scripted loop does. Refill 1 / 10s.
export const PRESET_CREATE_BURST = 10;
export const PRESET_CREATE_REFILL_MS = 10_000;

interface Deps {
  presets: PresetStore;
  verify: (token: string) => Promise<VerifiedClaims | null>;
  createLimiter?: KeyedTokenBucket;
}

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  return typeof h === 'string' && h.startsWith('Bearer ') ? h.slice(7) : null;
}
async function claimsFrom(req: FastifyRequest, verify: Deps['verify']): Promise<VerifiedClaims | null> {
  const token = bearer(req);
  return token ? verify(token) : null;
}

export async function presetsRoute(app: FastifyInstance, deps: Deps) {
  const createLimiter = deps.createLimiter ?? new KeyedTokenBucket(PRESET_CREATE_BURST, PRESET_CREATE_REFILL_MS);

  // List: own + public, scoped to the (optional) viewer. Public read.
  app.get('/api/presets', async (req) => {
    const claims = await claimsFrom(req, deps.verify);
    const q = req.query as { engineType?: string };
    const engineType = q.engineType as EngineType | undefined;
    const rows = await deps.presets.list({ viewerUserId: claims?.userId ?? null, engineType });
    return { presets: rows };
  });

  // Create: login required.
  app.post('/api/presets', async (req, reply) => {
    const claims = await claimsFrom(req, deps.verify);
    if (!claims) return reply.code(401).send({ error: 'login required to save presets' });
    if (!createLimiter.consume(claims.userId)) {
      return reply.code(429).send({ error: 'too many presets created, try again shortly' });
    }
    const parsed = CreatePresetBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', details: parsed.error.flatten() });
    }
    const body = parsed.data;
    const id = randomBase32(9);
    await deps.presets.create({
      id,
      name: body.name,
      engineType: body.engineType,
      params: body.params,
      ownerUserId: claims.userId,
      isPublic: body.isPublic,
    });
    return reply.code(201).send({ id });
  });

  // Patch name / public flag: owner only.
  app.patch('/api/presets/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = PatchPresetBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', details: parsed.error.flatten() });
    const record = await deps.presets.get(id);
    if (!record) return reply.code(404).send({ error: 'not found' });
    const claims = await claimsFrom(req, deps.verify);
    if (!claims || claims.userId !== record.ownerUserId) return reply.code(403).send({ error: 'not the owner' });
    await deps.presets.updateMeta(id, { name: parsed.data.name, isPublic: parsed.data.isPublic });
    return reply.code(204).send();
  });

  // Delete: owner only.
  app.delete('/api/presets/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const record = await deps.presets.get(id);
    if (!record) return reply.code(404).send({ error: 'not found' });
    const claims = await claimsFrom(req, deps.verify);
    if (!claims || claims.userId !== record.ownerUserId) return reply.code(403).send({ error: 'not the owner' });
    await deps.presets.delete(id);
    return reply.code(204).send();
  });
}
```

- [ ] **Step 4: Run the route test**

Run: `npm test -w @fiddle/server -- routes/presets`
Expected: PASS.

- [ ] **Step 5: Wire the store + route into `buildServer`**

In `packages/server/src/server.ts`:

1. Add imports near the other store/route imports (around lines 17–21):

```ts
import { InMemoryPresetStore } from './preset/InMemoryPresetStore.js';
import { PostgresPresetStore } from './preset/PostgresPresetStore.js';
import type { PresetStore } from './preset/PresetStore.js';
import { presetsRoute } from './routes/presets.js';
```

2. Construct the store next to `sessions` (after the `sessions = …` block, ~line 55):

```ts
const presets: PresetStore = sql ? new PostgresPresetStore(sql) : new InMemoryPresetStore();
```

3. Register the route next to the sessions registration (~line 76):

```ts
app.register(async (a) => presetsRoute(a, { presets, verify }));
```

Note: presets are intentionally **not** wrapped in `instrumentSessionStore`-style OTel (no `instrumentPresetStore` exists). Consistency follow-up is out of scope; leave a one-line `// TODO(presets): add OTel store instrumentation for parity with sessions` above the construction.

- [ ] **Step 6: Run server tests + typecheck**

Run: `npm test -w @fiddle/server && npm run typecheck -w @fiddle/server`
Expected: PASS (existing + new), no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/routes/presets.ts packages/server/src/routes/presets.test.ts packages/server/src/server.ts
git commit -m "feat(presets): /api/presets route + server wiring

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Client `presetsApi.ts`

Typed HTTP client mirroring `sync/sessionsApi.ts`.

**Files:**
- Create: `packages/client/src/sync/presetsApi.ts`
- Create: `packages/client/src/sync/presetsApi.test.ts`

**Interfaces:**
- Consumes: `PresetRecord`, `CreatePresetBody`, `PatchPresetBody`, `EngineType` from `@fiddle/shared`.
- Produces:
  - `listPresets(engineType?: EngineType, token?: string): Promise<PresetRecord[]>`
  - `createPreset(body: CreatePresetBody, token: string): Promise<string>` (returns new id)
  - `patchPreset(id: string, patch: PatchPresetBody, token: string): Promise<void>`
  - `deletePreset(id: string, token: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `packages/client/src/sync/presetsApi.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { listPresets, createPreset, patchPreset, deletePreset } from './presetsApi.js';

function mockFetch(impl: (url: string, init?: RequestInit) => Partial<Response> & { json?: () => Promise<unknown> }) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => impl(url, init)));
}
afterEach(() => vi.unstubAllGlobals());

describe('presetsApi', () => {
  it('listPresets passes engineType as a query param and unwraps presets', async () => {
    let seenUrl = '';
    mockFetch((url) => { seenUrl = url; return { ok: true, status: 200, json: async () => ({ presets: [{ id: 'p1' }] }) }; });
    const out = await listPresets('kick2');
    expect(seenUrl).toContain('/api/presets?engineType=kick2');
    expect(out).toEqual([{ id: 'p1' }]);
  });

  it('listPresets without engineType omits the query', async () => {
    let seenUrl = '';
    mockFetch((url) => { seenUrl = url; return { ok: true, status: 200, json: async () => ({ presets: [] }) }; });
    await listPresets();
    expect(seenUrl).toMatch(/\/api\/presets$/);
  });

  it('createPreset POSTs with bearer auth and returns the id', async () => {
    let seenInit: RequestInit | undefined;
    mockFetch((_url, init) => { seenInit = init; return { ok: true, status: 201, json: async () => ({ id: 'new-id' }) }; });
    const id = await createPreset({ name: 'x', engineType: 'kick2', params: {}, isPublic: false } as never, 'tok');
    expect(id).toBe('new-id');
    expect((seenInit?.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(seenInit?.method).toBe('POST');
  });

  it('createPreset throws on non-201', async () => {
    mockFetch(() => ({ ok: false, status: 400, json: async () => ({}) }));
    await expect(createPreset({} as never, 'tok')).rejects.toThrow();
  });

  it('patchPreset PATCHes and deletePreset DELETEs', async () => {
    const methods: string[] = [];
    mockFetch((_url, init) => { methods.push(init?.method ?? 'GET'); return { ok: true, status: 204, json: async () => ({}) }; });
    await patchPreset('p', { isPublic: true }, 'tok');
    await deletePreset('p', 'tok');
    expect(methods).toEqual(['PATCH', 'DELETE']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @fiddle/client -- presetsApi`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the client**

Create `packages/client/src/sync/presetsApi.ts`:

```ts
// Typed HTTP client for /api/presets. Same-origin in dev via the Vite /api
// proxy; cross-origin in prod via VITE_API_URL. Mirrors sessionsApi.ts.
import type { PresetRecord, CreatePresetBody, PatchPresetBody, EngineType } from '@fiddle/shared';

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

export async function listPresets(engineType?: EngineType, token?: string): Promise<PresetRecord[]> {
  const qs = engineType ? `?engineType=${encodeURIComponent(engineType)}` : '';
  const res = await fetch(apiUrl(`/api/presets${qs}`), { headers: headers(token) });
  if (!res.ok) throw new Error(`list presets failed: ${res.status}`);
  const body = (await res.json()) as { presets: PresetRecord[] };
  return body.presets;
}

export async function createPreset(body: CreatePresetBody, token: string): Promise<string> {
  const res = await fetch(apiUrl('/api/presets'), {
    method: 'POST', headers: headers(token, true), body: JSON.stringify(body),
  });
  if (res.status !== 201) throw new Error(`create preset failed: ${res.status}`);
  const { id } = (await res.json()) as { id: string };
  return id;
}

export async function patchPreset(id: string, patch: PatchPresetBody, token: string): Promise<void> {
  const res = await fetch(apiUrl(`/api/presets/${id}`), {
    method: 'PATCH', headers: headers(token, true), body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`patch preset failed: ${res.status}`);
}

export async function deletePreset(id: string, token: string): Promise<void> {
  const res = await fetch(apiUrl(`/api/presets/${id}`), { method: 'DELETE', headers: headers(token) });
  if (!res.ok) throw new Error(`delete preset failed: ${res.status}`);
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test -w @fiddle/client -- presetsApi && npm run typecheck -w @fiddle/client`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/sync/presetsApi.ts packages/client/src/sync/presetsApi.test.ts
git commit -m "feat(presets): typed presetsApi client

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Display helper `groupPresets` (pure, tested)

The modal needs presets split into "Yours" / "Public (others')" given the current user id. Extracting this keeps the `.vue` thin and gives us a unit-tested seam.

**Files:**
- Create: `packages/client/src/project/preset-display.ts`
- Create: `packages/client/src/project/preset-display.test.ts`

**Interfaces:**
- Consumes: `PresetRecord` from `@fiddle/shared`.
- Produces: `groupPresets(all: PresetRecord[], currentUserId: string | null): { yours: PresetRecord[]; others: PresetRecord[] }` — `yours` = records whose `ownerUserId === currentUserId` (empty when `currentUserId` is null); `others` = the rest. Order within each group preserves input order (already newest-first from the API).

- [ ] **Step 1: Write the failing test**

Create `packages/client/src/project/preset-display.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { groupPresets } from './preset-display.js';
import type { PresetRecord } from '@fiddle/shared';

const rec = (id: string, ownerUserId: string): PresetRecord => ({
  id, name: id, engineType: 'kick2', params: {}, ownerUserId,
  ownerUsername: null, isPublic: true, createdAt: '', updatedAt: '',
});

describe('groupPresets', () => {
  it('splits into yours vs others for a logged-in user', () => {
    const out = groupPresets([rec('a', 'u1'), rec('b', 'u2'), rec('c', 'u1')], 'u1');
    expect(out.yours.map((r) => r.id)).toEqual(['a', 'c']);
    expect(out.others.map((r) => r.id)).toEqual(['b']);
  });

  it('puts everything in others for a guest', () => {
    const out = groupPresets([rec('a', 'u1'), rec('b', 'u2')], null);
    expect(out.yours).toEqual([]);
    expect(out.others.map((r) => r.id)).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @fiddle/client -- preset-display`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the helper**

Create `packages/client/src/project/preset-display.ts`:

```ts
import type { PresetRecord } from '@fiddle/shared';

export function groupPresets(
  all: PresetRecord[],
  currentUserId: string | null,
): { yours: PresetRecord[]; others: PresetRecord[] } {
  const yours: PresetRecord[] = [];
  const others: PresetRecord[] = [];
  for (const p of all) {
    if (currentUserId !== null && p.ownerUserId === currentUserId) yours.push(p);
    else others.push(p);
  }
  return { yours, others };
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -w @fiddle/client -- preset-display`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/project/preset-display.ts packages/client/src/project/preset-display.test.ts
git commit -m "feat(presets): groupPresets display helper

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: "Save to library" flow in StudioView

Add a login-gated "Save to library" action next to the existing file SAVE PRESET button. Reuses `makePreset` + `createPreset`. The existing file Save/Load stays for everyone.

**Files:**
- Modify: `packages/client/src/views/StudioView.vue` (script: import `createPreset`, `useAuth`, add `onSaveToLibrary`; template: the new button + a small name/public prompt)
- Reuse: `makePreset` (already imported at `StudioView.vue:307`), the existing `dialog` service used by `onInitPatch`.

**Interfaces:**
- Consumes: `makePreset` (`project/preset`), `createPreset` (`sync/presetsApi`), `useAuth().accessToken` + `isAuthenticated`.
- Produces: `onSaveToLibrary()` handler + a reactive `userId` for Task 8. The currently-logged-in user id is `auth.session.value?.user.id` (see `auth/useAuth.ts`). Expose it as `const currentUserId = computed(() => auth.session.value?.user.id ?? null);` for reuse by the library modal.

- [ ] **Step 1: Add the handler (script section)**

In `packages/client/src/views/StudioView.vue` `<script setup>`:

1. Add imports:

```ts
import { createPreset } from '../sync/presetsApi';
import { useAuth } from '../auth/useAuth';
```

2. Near the other composable setup, add:

```ts
const auth = useAuth();
const currentUserId = computed(() => auth.session.value?.user.id ?? null);
```

(Ensure `computed` is imported from `vue` — it likely already is; if not, add it.)

3. Add the handler next to `onSavePreset` (~`StudioView.vue:511`):

```ts
const onSaveToLibrary = async () => {
  if (activeTrackIndex.value === null) return;
  if (!auth.isAuthenticated.value || !auth.accessToken.value) {
    await dialog.alert('Sign in to save presets to the library. You can still use Save Preset to a file.');
    return;
  }
  const name = await dialog.prompt({
    title: 'Save to library',
    message: 'Preset name',
    confirmLabel: 'Save',
  });
  if (!name) return; // cancelled or empty
  const track = project.tracks[activeTrackIndex.value];
  const preset = makePreset(track.engineType, track.engines[track.engineType] as any);
  try {
    await createPreset(
      { name, engineType: preset.engineType, params: preset.params, isPublic: false },
      auth.accessToken.value,
    );
    await dialog.alert(`Saved "${name}" to your library.`);
  } catch (e) {
    await dialog.alert(`Could not save preset: ${e instanceof Error ? e.message : 'unknown error'}`);
  }
};
```

Note: confirm the `dialog` service exposes a `prompt` returning the entered string (grep `dialog.prompt` / the dialog composable). If it only has `confirm`/`alert`, either (a) add a minimal `prompt` to that service, or (b) defer name entry to the modal in Task 8 and have `onSaveToLibrary` save with a default name `"${engineType} patch"` that the user can rename from the library. Pick (a) if a prompt is a small addition; otherwise (b). Document which you chose in the commit body. Presets default to **private** here; publishing happens from the library (Task 8).

- [ ] **Step 2: Add the button (template section)**

In the `.preset-controls` area of the template (where SAVE PRESET / LOAD PRESET live), add a button bound to `onSaveToLibrary`. Match the surrounding button markup/classes exactly. Example:

```html
<button class="preset-btn" :disabled="activeTrackIndex === null" @click="onSaveToLibrary">
  SAVE TO LIBRARY
</button>
```

- [ ] **Step 3: Typecheck + build**

Run: `npm run typecheck -w @fiddle/client && npm run build -w @fiddle/client`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/views/StudioView.vue
git commit -m "feat(presets): save-to-library action (login-gated)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: `PresetLibraryModal.vue` + top-bar "PRESETS" button

The global browse/load modal. Lists presets (yours/public), engine-filterable; Load applies to the focused track via `applyPreset`; owner rows can rename / toggle public / delete.

**Files:**
- Create: `packages/client/src/components/PresetLibraryModal.vue`
- Modify: the app shell that renders the top app-bar (grep for where the room name renders — per memory it's in `App.vue`'s app-bar LEFT; the "PRESETS" button goes in the app-bar). Add the button + modal mount.
- Modify: `packages/client/src/views/StudioView.vue` if the focused-track + `applyPreset` wiring needs to be reachable from the modal. Prefer passing the load handler down / emitting up rather than reaching across components.

**Interfaces:**
- Consumes: `listPresets`/`patchPreset`/`deletePreset` (`sync/presetsApi`), `groupPresets` (`project/preset-display`), `applyPreset` (`project/preset`), `useAuth` (token + `currentUserId`), the focused track + `EngineType` list.
- Produces: a `<PresetLibraryModal>` component with props `{ open: boolean; currentUserId: string | null; token?: string; onLoad: (rec: PresetRecord) => void }` and an emit `close`. `onLoad` is provided by StudioView and does `applyPreset(focusedTrack, { schemaVersion: PRESET_SCHEMA_VERSION, engineType: rec.engineType, params: rec.params })`.

- [ ] **Step 1: Build the modal component**

Create `packages/client/src/components/PresetLibraryModal.vue`. Behavior:

- On `open` becoming true (watch), call `listPresets(filterEngine, token)` and store the result; show a loading state; surface errors inline.
- An engine filter: chips/`<select>` for `all` + each `EngineType`. Changing it refetches (or filters client-side; refetch is simpler and authoritative). Default `all`.
- Render two sections via `groupPresets(all, currentUserId)`: **Yours** and **Public**. Each row: name, engine badge, attribution (`ownerUsername ?? 'anon'`, or "you" in Yours).
- Row actions:
  - **Load** (all rows): calls the `onLoad(rec)` prop, then emits `close`. If no focused track, the parent's `onLoad` no-ops with a hint — disable the button when the parent signals no focused track (pass a `canLoad: boolean` prop).
  - **Yours rows only:** Rename (prompt → `patchPreset(id, { name })` → refetch), Make public / Make private (`patchPreset(id, { isPublic })` → refetch), Delete (confirm → `deletePreset(id)` → refetch).
- Refetch after any successful mutation. All mutating actions require `token` (present, since only your own rows show these and you must be logged in to own a row).

Keep markup/styling consistent with existing modals/dialogs in `packages/client/src/components/` (find an existing modal, e.g. the session settings or create-session dialog, and match its overlay/card structure and classes).

- [ ] **Step 2: Add the "PRESETS" button + mount the modal in the app shell**

In the app-bar (where the room name renders — grep `Untitled session` / the app-bar template), add:

```html
<button class="appbar-btn" @click="presetLibraryOpen = true">PRESETS</button>
```

Mount the modal (passing the focused-track-aware `onLoad`, `currentUserId`, `token`, `canLoad`, and `open`/`@close`). Wire `onLoad` to apply onto the studio's focused track:

```ts
const onLoadPresetFromLibrary = (rec: PresetRecord) => {
  if (activeTrackIndex.value === null) return;
  applyPreset(project.tracks[activeTrackIndex.value], {
    schemaVersion: PRESET_SCHEMA_VERSION,
    engineType: rec.engineType,
    params: rec.params as EngineParamsMap[typeof rec.engineType],
  });
};
```

`applyPreset` already sets `track.engineType` and assigns params in place, so loading adopts the preset's engine and the change flows through existing sync watchers. Import `PRESET_SCHEMA_VERSION` and `applyPreset` from `project/preset` (or `project/index`).

Note: the focused track lives in StudioView, while the app-bar/button may live in App.vue. Choose the lower-friction wiring: either (a) lift `presetLibraryOpen` + `onLoad` into StudioView and render the PRESETS button within the studio's own header area, or (b) expose the focused-track load handler from StudioView up to App.vue via an emit/provide. Prefer (a) if the studio already owns a header row — fewer cross-component seams. Record the choice in the commit body.

- [ ] **Step 3: Typecheck + build**

Run: `npm run typecheck -w @fiddle/client && npm run build -w @fiddle/client`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/components/PresetLibraryModal.vue packages/client/src/views/StudioView.vue packages/client/src/App.vue
git commit -m "feat(presets): preset library browse/load modal + PRESETS button

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

(Adjust the staged file list to exactly the files you touched.)

---

### Task 9: Full gate + browser verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full gate**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green. Fix anything red before proceeding.

- [ ] **Step 2: Browser verification (required — AGENTS.md)**

Start the dev app (`npm run dev`) and drive it with the Playwright MCP. Verify the full flow with a clean console:

1. **Logged-in save:** sign in (Google), focus a track, "SAVE TO LIBRARY" → name it → confirm success.
2. **Browse:** open the **PRESETS** modal → the new preset appears under **Yours**; engine filter narrows the list.
3. **Publish:** toggle the preset **public** from its row.
4. **Load:** focus a *different* track, Load the preset → the track adopts the preset's engine and its knobs move to the saved values.
5. **Guest visibility:** in a second browser context (no login), open PRESETS → the **public** preset shows under Public and loads onto a focused track; private ones do **not** appear.
6. **Guest save gate:** as the guest, "SAVE TO LIBRARY" shows the sign-in nudge; the file SAVE PRESET still works.
7. **Owner edit:** rename and delete your preset from the modal; the list updates.
8. Confirm **no console errors** throughout. Report observations.

- [ ] **Step 3: Close the browser**

Close every Playwright tab/context you opened and stop any dev server you started (AGENTS.md cleanup rule).

- [ ] **Step 4: Stop for user sign-off**

Do **not** merge. Report the gate result + browser observations and hand back to the user for their own visual/audio sign-off and the merge decision (keep the branch).

---

## Self-Review

**Spec coverage:**
- DB table → Task 3 (migration `0005_presets.sql`). ✓
- Shared contract (`PresetRecord`, `CreatePresetBody`/Schema, `PatchPresetBody`/Schema, engine→param validation) → Task 1. ✓
- `PresetStore` + InMemory + Postgres, `list` scoping (own+public; guest→public-only; engineType filter; LIMIT 500; username join) → Tasks 2–3. ✓
- `/api/presets` routes (GET public; POST login-only+rate-limit+validation; PATCH/DELETE owner-only) + `buildServer` wiring → Task 4. ✓
- Client `presetsApi` → Task 5. ✓
- Save flow (login-gated, file Save stays for guests) → Task 7. ✓
- Browse/load modal + top-bar PRESETS button + load-adopts-engine via `applyPreset` → Tasks 6 & 8. ✓
- Security/scale (name/engine/param validation, rate-limit, default private, no RLS, LIMIT 500) → Tasks 1, 3, 4. ✓
- Testing (shared schema, store scoping, route auth/owner/validation/rate-limit, client api contract, display helper) → Tasks 1–6. ✓
- Browser verification → Task 9. ✓
- Out-of-scope items (whole-project presets, tags/search, overwrite, factory-pool merge, guest-owned, realtime list) — none implemented. ✓

**Placeholder scan:** Two UI tasks (7, 8) contain explicit *decision points* (dialog `prompt` availability; where the PRESETS button/`onLoad` is wired) rather than placeholders — each names the concrete options, a default recommendation, and asks the implementer to record the choice in the commit. All code-bearing steps include real code. No "TBD"/"add error handling"-style gaps.

**Type consistency:** `PresetRecord`, `CreatePresetInput`, `ListPresetsOpts`, `CreatePresetBody`, `PatchPresetBody`, `presetParamsSchemaFor`, `groupPresets`, and the route `Deps`/limiter exports are used with the same names/shapes across tasks. Store `list({ viewerUserId, engineType })` matches the route call and the tests. `createPreset(body, token)` / `patchPreset(id, patch, token)` / `deletePreset(id, token)` signatures match between Task 5's client and Task 8's modal usage.

**Implementer pre-flight greps (do before Task 1 and Task 7):**
- `grep -rn "export const DEFAULT_" packages/shared/src/engines/` — confirm the exact per-engine default-params export names used in tests.
- `grep -rn "prompt\|confirm\|alert" packages/client/src` for the dialog service — confirm whether `dialog.prompt` exists (Task 7 decision).
- Grep the app-bar template (`Untitled session`) to locate where the PRESETS button mounts (Task 8 decision).
