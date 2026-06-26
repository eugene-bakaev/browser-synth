# Preset Library — design

**Date:** 2026-06-25 · **Status:** approved, pre-implementation
**Area:** `supabase/migrations`, `@fiddle/shared`, `@fiddle/server`, `@fiddle/client`

## Summary

Add a DB-backed **preset library**: logged-in users save a track's per-engine
patch to the server; anyone (guests included) can browse and load presets in the
browser. Presets are private by default with a `public` flag that shares them
into a global pool. This reuses the existing per-engine `Preset` shape and
`applyPreset` machinery; it adds server persistence and a browse/load UI.

The future "project preset pool" (whole-project templates) is **out of scope** —
this iteration is per-engine patches only.

## Decisions (locked during brainstorming)

- **Unit of a preset:** the existing per-engine `Preset` =
  `{ schemaVersion, engineType, params }` (one track's active engine + its knob
  values). Reuse `makePreset` / `applyPreset` from
  `packages/client/src/project/preset.ts` unchanged.
- **Visibility:** owned, **private by default**, with a `public` flag to share
  into a single global pool. Browse shows "yours" + all public.
- **Who can save:** **login-only.** Guests can browse + load (public presets)
  and keep the existing file Save/Load (`.chnl.json`). Saving to the DB requires
  a Supabase login.
- **Browse/load UX:** a global **"Presets"** library modal, openable app-wide
  from the top app-bar, filterable by engine. **Load applies to the focused
  track.** Because `applyPreset` already sets `track.engineType`, loading a
  preset *adopts* its engine — there is no engine-mismatch case to handle.

## Existing building blocks (reused, not rebuilt)

- `Preset` shape + `makePreset(engineType, params)` + `applyPreset(track, preset)`
  + `resetEnginePatch` in `packages/client/src/project/preset.ts`.
- File Save/Load via `preset-file-io.ts` (stays for guests, unchanged).
- DB/persistence pattern from sessions: server-only access over `DATABASE_URL`,
  **no RLS** (browser never touches the DB), typed `/api/...` HTTP endpoints,
  a `Store` interface with `InMemory*` + `Postgres*` implementations.
- `Schemas` registry in `packages/shared/src/project/schema.ts` — has a param
  schema for all 10 engine types (`Schemas.SynthParams`, `Schemas.Synth2Params`,
  `Schemas.KickParams`, `Schemas.Kick2Params`, `Schemas.HatParams`,
  `Schemas.Hat2Params`, `Schemas.SnareParams`, `Schemas.Snare2Params`,
  `Schemas.ClapParams`, `Schemas.Clap2Params`) — used for server-side param
  validation.
- `profiles.username` for attribution; `KeyedTokenBucket` (`routes/rate-limit.ts`)
  for per-user create throttling.

## 1. Database — migration `0005_presets.sql`

Mirrors the sessions tables: server-only access, no RLS.

```sql
create table public.presets (
  id             text primary key,         -- 9-char Crockford Base32 (randomBase32(9))
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

Notes:
- `owner_user_id` is **NOT NULL** — login-only saving, so there is no
  guest-owned (`owner_client_id`) variant. Simpler than the sessions dual-owner
  model.
- No RLS, consistent with `sessions` / `session_snapshots`. All access is via
  the privileged server connection.

## 2. Shared contract (`@fiddle/shared`)

New types + zod schemas (new file, e.g. `packages/shared/src/preset/`):

- `PresetRecord` — the API read shape:
  `{ id, name, engineType, params, ownerUserId, ownerUsername, isPublic,
  createdAt, updatedAt }`. `ownerUsername` is `string | null` (join to
  `profiles.username`).
- `CreatePresetBody` + `CreatePresetBodySchema` (zod):
  - `name`: string, trimmed, length 1–60.
  - `engineType`: `EngineTypeSchema`.
  - `params`: validated against the matching `Schemas.<Engine>Params` via an
    engine→schema lookup (a `superRefine` or discriminated check keyed on
    `engineType`). Rejects malformed/fuzzed params.
  - `isPublic`: boolean, default `false`.
- `PatchPresetBody` + `PatchPresetBodySchema`: `{ name?, isPublic? }`.

The client's `preset.ts` stays as-is; these shared types are the wire contract,
reused by both client `presetsApi` and the server route for one-source
validation (same pattern as `CreateSessionBodySchema`).

## 3. Server (`@fiddle/server`)

### `PresetStore` (interface + two implementations)

Mirrors `SessionStore`. New files under `packages/server/src/preset/`:

```ts
interface PresetRow { /* db row */ }

interface CreatePresetInput {
  id: string;
  name: string;
  engineType: string;
  params: unknown;        // already schema-validated at the route
  ownerUserId: string;
  isPublic: boolean;
}

interface PresetStore {
  create(input: CreatePresetInput): Promise<PresetRecord>;
  get(id: string): Promise<PresetRecord | null>;
  // Library listing: the viewer's own presets ∪ all public presets.
  // Guest viewer (viewerUserId null) → public only. Newest-first, LIMIT 500.
  list(opts: { viewerUserId: string | null; engineType?: string }): Promise<PresetRecord[]>;
  updateMeta(id: string, patch: { name?: string; isPublic?: boolean }): Promise<void>;
  delete(id: string): Promise<void>;
}
```

- `InMemoryPresetStore` — the test fake.
- `PostgresPresetStore` — `sql.json()` for the `params` jsonb; `list` LEFT JOINs
  `profiles` for `ownerUsername`; `list` query is
  `where owner_user_id = $viewer or is_public` (+ optional `and engine_type = $engine`)
  `order by updated_at desc limit 500`.

### Routes — `routes/presets.ts`

Registered in `buildServer` alongside `sessionsRoute`.

- `GET /api/presets?engineType=` — **public** (no auth required). Viewer =
  `claims?.userId ?? null` (bearer optional). Returns yours + public (guest →
  public only).
- `POST /api/presets` — **auth required → 401** if no valid bearer. Validate body
  with `CreatePresetBodySchema` (→ 400 on failure). Per-user create rate-limit
  via `KeyedTokenBucket` keyed by `userId` (→ 429). Insert with
  `owner_user_id = claims.userId`, `id = randomBase32(9)`. → `201 { id }`.
- `PATCH /api/presets/:id` — auth; owner-only (`record.ownerUserId === claims.userId`,
  else 403). Body `PatchPresetBodySchema`. → 204.
- `DELETE /api/presets/:id` — auth; owner-only (else 403). → 204.

Rate-limit tuning: burst ~10, refill 1 / 10s per user (a normal "save a few
patches" flow never hits it; a script does).

## 4. Client (`@fiddle/client`)

### `sync/presetsApi.ts`

Typed fetch client mirroring `sessionsApi.ts`: `listPresets(engineType?, token?)`,
`createPreset(body, token)`, `patchPreset(id, patch, token)`,
`deletePreset(id, token)`. Token sourced from the existing auth/session store;
omitted for guests (only `listPresets` works without it).

### Save flow

- A small dialog: **name** input + **"Make public"** checkbox →
  `createPreset({ name, engineType, params, isPublic }, token)` where the body is
  built from `makePreset(track.engineType, track.engines[track.engineType])`.
- Logged-in only. Guests see a "Sign in to save to the library" nudge; the
  existing **file** Save Preset button stays for everyone.

### `PresetLibraryModal.vue`

- Entry point: a **"PRESETS"** button in the top app-bar (near the room name).
- Lists presets from `listPresets`, grouped **"Yours"** / **"Public"**, with
  engine-filter chips (all / per engine). Each row shows name, engine,
  attribution (`ownerUsername` or "you").
- Row actions: **Load** → `applyPreset(focusedTrack, preset)` (disabled with a
  hint when no track is focused). Own rows additionally: rename, toggle public,
  delete (via `patchPreset` / `deletePreset`).
- Refetches after a successful save or delete. No live/realtime updates of the
  list (fetch on open).

### Load semantics / sync

`applyPreset` mutates `track.engineType` + `track.engines[type]` in place — these
are synced Project fields, so a load propagates to collaborators through the
existing WS watchers (no new sync wiring). Verify this in the browser pass.

## 5. Security & scale

- Server validates `name` length, `engineType`, and the **full param shape**
  (via `Schemas.<Engine>Params`) before insert → the public pool can't be
  polluted by malformed or fuzzed input.
- Create is rate-limited per user.
- `is_public` defaults `false`.
- No RLS — server-only DB access, consistent with sessions.
- `list` caps at 500 rows (LIMIT) for the first iteration; pagination/search is a
  later concern.

## 6. Testing

- **Shared:** `CreatePresetBodySchema` accepts a valid body; rejects unknown
  engineType, params that fail the engine schema, and over-long/empty names.
- **Server:**
  - `PresetStore` (InMemory + Postgres) CRUD + `list` scoping: own+public for a
    logged-in viewer, public-only for a guest viewer, engineType filter.
  - Route tests mirroring `sessions.test.ts`: 401 on unauthenticated POST/PATCH/
    DELETE, 403 on non-owner PATCH/DELETE, 400 on invalid body, 429 on rate-limit,
    201/204 happy paths, GET visibility scoping.
- **Client:** `presetsApi` contract tests (URL/shape/headers). `preset.ts` is
  already covered. The modal is a `.vue` file → browser-verified, not unit-mounted
  (per repo conventions).
- **Browser verification (required before "done"):** logged-in save → preset
  appears in the library → toggle public → load onto a focused track (engine
  switches, knobs move) → second client / guest sees the public preset and can
  load it → console clean. Close the tab/session afterward.

## 7. Explicitly out of scope (YAGNI)

- Whole-project presets / the future "project preset pool".
- Folders, tags, descriptions, text search.
- Overwriting an existing preset's params (save always creates a new row; editing
  is rename / public-toggle / delete only).
- Merging the deferred factory-preset voicings (separate BACKLOG item; can fold
  into this library later).
- Guest-owned presets.
- Live/realtime updates of the library list.
