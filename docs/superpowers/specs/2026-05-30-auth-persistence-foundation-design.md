# Auth + Persistence Foundation — Design (Milestone 1)

**Date:** 2026-05-30
**Status:** Approved (brainstorm complete; ready for implementation plan)

## Goal

Add optional Google sign-in to Fiddle Synth and stand up the database access
layer it rides on. A logged-in user gets a durable account identity and a
claimable username; guests keep today's zero-friction "open URL and jam" flow
unchanged. This is the **foundation** milestone — saved sessions, lobby, and
per-user track pools build on the persistence layer added here without redoing
it.

## Context

The app today (see `docs/ROADMAP.md`, `docs/ARCHITECTURE.md`):

- Client on Vercel, Fastify WebSocket sync server on Render (free tier),
  per-field LWW collaboration.
- **In-memory, single-instance** room store; the server has **zero database
  dependency**.
- Identity is ephemeral: `ConnectionHandler.handleHello` mints a per-room
  `clientId` + color + animal handle via `makeIdentity`.
- Op authorization is path-only (`validatePathAndValue`) — "is this path
  writable", with no notion of *who* is writing.

This milestone is the roadmap's "foundation track" entry point. It is
deliberately scoped to **auth + the DB layer + one table**, not saved sessions.

## Decisions (locked during brainstorming)

1. **Provider: Supabase, Google sign-in only.** No email/password, no other
   OAuth providers, no avatars. Supabase Auth issues a JWT; Supabase Postgres
   holds app data.
2. **Guests stay anonymous; login is optional and additive.** Anonymous users
   jam immediately with an ephemeral identity exactly as today. Logging in is
   optional and grants a durable identity + claimable username.
3. **App tables now, not later.** We know app tables are coming (saved
   sessions), so we stand up the database access layer in this milestone rather
   than store the username in `user_metadata` and migrate it later. A `profiles`
   table is the low-stakes first table to prove out the Postgres + migrations +
   RLS pipeline, and gives us a `UNIQUE` (claimable) username for free.
4. **Identity shown to peers:** Google display name by default; the user may set
   a custom username. No avatar. Server still assigns the color.

## Architecture

Three actors, two new data paths. The realtime WS path stays lean; account and
profile work goes directly between the browser and Supabase.

```
                 ┌─────────────────────────────────────────────┐
  Browser ───────┤ Supabase Auth (Google OAuth, JWT issuance)   │  ← login + profile CRUD
     │           │ Supabase Postgres (profiles table, RLS)      │
     │           └─────────────────────────────────────────────┘
     │ (1) sign in with Google → JWT                    ▲
     │ (2) read/write own profile row (RLS-guarded) ────┘
     │
     │ (3) WS hello { token } ──────────────► Fastify WS server
     └──────────────────────────────────────┤ verifies JWT locally (signing key)
                                             │ reads profiles.username by userId (pg)
                                             │ resolves handle, runs sync as today
```

### Architectural decisions

**A1 — Profile management is client↔Supabase; the Fastify server only *reads*.**
The browser uses the Supabase JS client to log in and to read/write its own
`profiles` row. RLS lets a user touch only their own row; the `UNIQUE`
constraint enforces claimable usernames and surfaces "taken" errors client-side.
The Fastify server never writes profiles — on hello it does a single indexed
`SELECT username WHERE id = $userId`. Clean split: Supabase = account/profile
CRUD, Fastify = realtime sync + authoritative handle resolution.

**A2 — JWT verified locally on hello (no network call).** The server caches
Supabase's public signing key (JWKS) and verifies the token signature itself.
Fast, and joining doesn't depend on Supabase being reachable. Guests send no
token → existing `makeIdentity` path, unchanged.

**A3 — `clientId` stays per-connection-unique; `userId` rides alongside it on
`Identity`.** We deliberately do **not** collapse `clientId = userId`. Two
browser tabs of one account are two independent editors, and the presence roster
/ `connected` set are keyed by `clientId`; collapsing would make closing one tab
wrongly drop the user from the roster while the other tab is live. Instead
`Identity` gains `userId: string | null` + `authenticated: boolean`. This avoids
the multi-tab bug and is the hook the later per-user-track-pools feature needs
(ops trace to a user). Op attribution and resume keep working as-is.

**A4 — Login/logout triggers a WS reconnect.** A guest who logs in mid-session
re-handshakes with the token to pick up the durable identity (and vice-versa on
logout). No mid-connection identity mutation. Supabase auto-refreshes the access
token; we verify only at hello, so a long-lived connection is not dropped on
token expiry (acceptable for M1).

**A5 — Server gets a `ProfileStore` interface, mirroring `RoomStore`.** A
`PostgresProfileStore` for production + an `InMemoryProfileStore` fake for unit
tests, so the server stays testable without a live database and the DB
dependency is injected, not hard-wired.

## Components

### Shared (`@fiddle/shared`)

- `Identity` gains `userId: string | null` and `authenticated: boolean`.
  Existing `clientId`, `color`, `handle` stay.
- **`Handle` widens from the animal-name literal union to `string`** — a custom
  username can be anything. Guest handles still draw from the `HANDLES` list; the
  type just stops being a closed set. (`assignHandle` already returns
  `Handle | string`, so this removes an existing coercion.)
- `HelloMessage` gains optional `token?: string`. `WelcomeMessage` and
  `PresenceUpdateMessage` carry the richer `Identity`, so the client learns each
  peer's `authenticated` flag (lets the UI badge logged-in users; rendering it
  is optional in M1).
- Zod schema for `hello` gains `token: z.string().optional()`.

### Server (`@fiddle/server`)

- `auth/verifyToken.ts` — verifies a Supabase JWT against the cached JWKS,
  returns `{ userId, googleName } | null`. Key fetch is cached; unit-testable
  with a test keypair.
- `profile/ProfileStore.ts` — interface `getUsername(userId): Promise<string | null>`.
  - `PostgresProfileStore` — a pooled Postgres connection, one indexed `SELECT`.
  - `InMemoryProfileStore` — fake for tests. Mirrors the `RoomStore` pattern.
- `ConnectionHandler.handleHello` — the one real logic change (see data flow).
- `makeAuthenticatedIdentity(existing, { userId, handle })` — sibling of
  `makeIdentity`; same color-assignment logic, handle comes from the account,
  `userId`/`authenticated` set.
- A new fatal error code `auth.invalid` for a present-but-invalid token.

### Client (`@fiddle/client`)

- `auth/supabase.ts` — Supabase client singleton (`VITE_SUPABASE_URL`,
  `VITE_SUPABASE_ANON_KEY`).
- `auth/useAuth.ts` — composable: session state, `signInWithGoogle()`,
  `signOut()`, current username, `setUsername()` (writes `profiles` via Supabase,
  maps a unique-violation to a "taken" result).
- WS client passes `session.access_token` as `token` in hello and **reconnects
  on auth-state change**.
- Minimal UI in `RoomBar`: "Sign in with Google" button → when logged in, shows
  the handle + a small username editor + sign-out.

## Data flow — hello

```
client → hello { schemaVersion, token?, clientId?, resumeFromOpId? }

server:
  if token present:
      claims = verifyToken(token)            # local signature check
      if invalid → fatal 'auth.invalid'
      userId = claims.userId
      username = profileStore.getUsername(userId)   # one indexed SELECT
      handle = username ?? claims.googleName
      identity = makeAuthenticatedIdentity(present, { userId, handle })
  else:                                       # guest — unchanged
      identity = makeIdentity(present)        # (resume-by-clientId still applies)

  → welcome { ...identity } → catch-up → sync.complete → presence fan-out
```

Guests keep the existing resume-by-`clientId` path untouched. Authenticated
users get a fresh per-connection `clientId` each connect with a stable `userId`
and stable handle; color is reassigned among present peers (cosmetic).

## Schema — Supabase migration

```sql
create table public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  username   text unique,                       -- claimable, nullable until set
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

-- a user may read/update only their own row
create policy "own profile read"   on public.profiles for select using  (auth.uid() = id);
create policy "own profile write"  on public.profiles for update using  (auth.uid() = id);
create policy "own profile insert" on public.profiles for insert with check (auth.uid() = id);

-- auto-create an empty profile row on signup (standard Supabase trigger)
create function public.handle_new_user() returns trigger language plpgsql security definer as $$
begin insert into public.profiles (id) values (new.id); return new; end; $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
```

Migrations live in `supabase/migrations/`. The Fastify server connects with a
**privileged** Postgres connection string (not the anon key), so its
`SELECT username` bypasses RLS — RLS only guards the browser's direct access.

## Testing strategy

**Shared:** Zod schema test for `hello` with/without `token`; type-level check
that `Identity` carries `userId`/`authenticated`.

**Server (the bulk):**

- `verifyToken` with a **test keypair**: valid → claims; expired → null; wrong
  signature → null; malformed → null; missing `sub` → null. No live Supabase.
- `handleHello` with `InMemoryProfileStore`: token + profile row → handle =
  username; token + no username → handle = Google name; invalid token → fatal
  `auth.invalid`; no token → existing guest path unchanged (regression).
- Multi-tab: two connections, same `userId`, distinct `clientId` → both appear;
  closing one leaves the other in the roster (guards A3).
- `PostgresProfileStore` — thin integration test against a local/CI Postgres,
  skipped behind an env guard when no DB is present. The unit suite uses the
  in-memory fake, so the existing test run needs no database.

**Client:**

- `useAuth` session transitions (signed-out ↔ signed-in) with a mocked Supabase
  client.
- WS client includes `token` in hello when a session exists; reconnects on
  auth-state change.
- `setUsername` maps a Postgres unique-violation to a "username taken" result.

## Config / secrets

- **Client (Vercel):** `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.
- **Server (Render):** `SUPABASE_JWKS_URL` (or project URL to derive it) for
  verification, `DATABASE_URL` (privileged Postgres connection string via
  Supabase's connection pooler). Added to `render.yaml`.
- **Local dev:** `.env` files (gitignored); required vars documented in the
  README. A guest-only path works with no Supabase vars set, so the app still
  boots locally without secrets — auth just stays unavailable.
- **One-time manual setup** (documented, done in dashboards): create the
  Supabase project, create a Google Cloud OAuth client, paste client id/secret
  into Supabase, register redirect URLs, run the migration.

## Graceful degradation

If Supabase is unreachable or unconfigured, the client doesn't offer login and
everyone is a guest; the server treats a missing/invalid token per its rules.
The realtime jam never hard-depends on the auth stack being up.

## Scope boundaries (what M1 does NOT do)

- No saved sessions / project persistence — rooms stay in-memory. The
  `RoomStore` swap is a later milestone; we only add the `ProfileStore` + DB
  layer now.
- No lobby / room ownership.
- No per-user track pools (A3 lays the `userId` groundwork, but op authorization
  stays path-only).
- No email/password or non-Google providers.
- No avatars.
- No mid-connection token-expiry enforcement (verify at hello only).
