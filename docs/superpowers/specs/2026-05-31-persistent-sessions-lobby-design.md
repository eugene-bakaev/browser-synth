# Persistent Sessions + Lobby — Design

**Date:** 2026-05-31
**Status:** Approved (brainstorming) — pending spec review, then implementation plan.

## Goal

Turn today's ephemeral, auto-minted rooms into **durable, listable sessions** and
add a **lobby** where users browse, create, and join sessions. Sessions carry
metadata (name, description, owner, settings) and persist their project to
Postgres. This is the foundation slice; read-only/observer mode, moderation
(bans), version history, and project templates are explicitly **deferred** to
their own specs (tracked in `docs/ROADMAP.md`).

## Scope

**In scope:**
- Durable sessions in Postgres (metadata + latest project snapshot).
- Lobby: browse / create / join, owned by logged-in users or guests.
- Session settings schema: `name` and `description` functional; `maxWritableUsers`
  and `tracksPerUser` stored-but-disabled (shown, persisted, inert this slice).
- Session-scoped WS connection; lobby-as-home navigation.
- `GET/POST/PATCH/DELETE /api/sessions` HTTP API.

**Out of scope (deferred, see `docs/ROADMAP.md`):**
- Read-only / observer connections + visibility options.
- Moderation: banning users.
- Session version history / restore points (ROADMAP #6).
- Project templates (ROADMAP #7).
- Enforcing `maxWritableUsers` / `tracksPerUser`.

## Context (today's model)

- Rooms are **ephemeral**: created implicitly when someone joins `/r/<randomId>`,
  held in-memory (`InMemoryRoomStore`), GC'd after a grace window once empty. No
  metadata, no persistence, no way to list them.
- Project state autosaves to **localStorage on the client**; nothing is stored
  server-side. (This is the root of backlog bug #2.)
- Auth exists: Supabase Google login; `userId` carried on `Identity`; a Postgres
  `profiles` table with `ProfileStore` / `PostgresProfileStore`.
- `WsClient` already exposes `connect()` / `disconnect()`. `useSynth()` runs once
  in the never-unmounting App shell and connects on load via `buildSyncState()`.

## Data model

Two Postgres tables. The project blob is **separated** from session metadata so
(a) lobby list queries stay lean — they never drag the large, frequently-rewritten
blob — and (b) version history (ROADMAP #6) becomes an additive change.

### `sessions` (metadata only)

| column | type | notes |
| --- | --- | --- |
| `id` | text PK | the existing 9-char Crockford Base32 room id |
| `name` | text | functional; shown in lobby; owner-editable anytime |
| `description` | text | functional; shown in lobby; owner-editable anytime |
| `owner_user_id` | uuid null | set for logged-in creators; `null` for guests |
| `owner_client_id` | text null | guest creator's `clientId` (lets a guest edit settings while live) |
| `settings` | jsonb | `{ maxWritableUsers, tracksPerUser }` — stored, inert this slice |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | bumped on metadata/settings writes |

### `session_snapshots` (project blob)

| column | type | notes |
| --- | --- | --- |
| `session_id` | text PK → FK `sessions.id` | unique this slice (one snapshot per session) |
| `project` | jsonb | latest project snapshot (no op history) |
| `updated_at` | timestamptz | bumped on flush |

- **This slice:** exactly one snapshot row per session — the current state —
  **UPSERT** on flush. Entering a session = `SELECT project FROM session_snapshots
  WHERE session_id = $1`.
- **Versioning later (ROADMAP #6):** drop the one-row-per-session constraint, add
  `version_no` + `created_at`, insert-on-boundary, prune to 10. Mostly additive;
  `sessions` is untouched.

## Ownership & lifecycle

`ownerKey` = `owner_user_id` if logged in, else the guest `owner_client_id`.

- **Logged-in–owned sessions:** durable. Listed in the lobby **even when empty**;
  re-joinable later; deleted only by the owner.
- **Guest-owned sessions:** a real DB row while live (project flushes normally),
  but the row is **pruned when the room empties** — it is unreachable afterward,
  so this makes "listed only while occupied" fall out for free and keeps the
  tables clean. A guest's way to keep their work is **Export to JSON** (exists).
- A guest can edit their session's settings only **while it is live** (authorized
  by matching `owner_client_id`).

## Persistence / autosave

The in-memory `RoomState.project` stays the live authority; Postgres is the
durable backstop. We coalesce project writes rather than writing per-op:

- A `dirty` flag is set inside `RoomStore.appendOp` on each accepted op.
- A **60-second sweep** flushes dirty rooms: `UPSERT session_snapshots …`, then
  clears `dirty`. Clean rooms cost nothing.
- **Flush on disconnect** (this also covers the room-empties case).
- **Flush on graceful shutdown (SIGTERM)** — Render sends SIGTERM on every
  redeploy, so without this we'd lose up to a minute of edits per deploy. Live
  clients still hold the state regardless; worst-case loss is ~60s only on a hard
  crash.
- **Settings edits are written immediately** (rare; want them durable at once).

On join, the snapshot the client receives **is** the durable session project.

**Bug #2 (fresh room wipes local project) is resolved incidentally:** a new
session is born with a server-side project (default or imported JSON), so the
join-snapshot is always authoritative and there is no local scratch to clobber.

## Navigation & connection lifecycle

The URL is the session token:

- `/r/<id>` present → **Studio** (enter session, connect WS). Absent → **Lobby**.
  Shared `/r/<id>` links still deep-link straight into a session.
- Keep the memory-history router as the in-app view switcher
  (`lobby` / `studio` / `account`), synced to the URL: entering a session sets
  `/r/<id>` + `router.push('studio')`; leaving clears `/r/` + `router.push('lobby')`.
  **Account** is reachable from both and never touches `/r/`.
- **Auto-mint is removed.** Rooms are created only via the lobby
  (`POST /api/sessions`). A raw `/r/<id>` to a session that doesn't exist →
  "session not found" → bounce to lobby.

**Shell refactor (connection becomes session-scoped):** split today's once-on-load
`buildSyncState()` into `connectToSession(roomId)` (on entering studio) and
`leaveSession()` (on returning to lobby → `wsClient.disconnect()`, reset local
project to a neutral state). The audio engine stays alive in the shell; only the
room connection comes and goes.

## Server-side

- New **`SessionStore`** interface + **`PostgresSessionStore`** +
  **`InMemorySessionStore`** (tests) — mirrors the existing `ProfileStore` /
  `PostgresProfileStore` pattern. Owns `sessions` + `session_snapshots`.
- On first join, room init **loads the project from `SessionStore`** (instead of
  a fresh default) to seed the in-memory `RoomStore`. An unknown session id →
  reject the WS with a clear error so the client bounces to the lobby.
- The flusher (60s sweep / on-disconnect / SIGTERM) writes the in-memory project
  back to `SessionStore`. Guest-owned rows are pruned on empty.

## HTTP API (Fastify; reuses `verifyToken`)

- `GET /api/sessions` — list. Postgres durable (logged-in-owned) rows **plus**
  in-memory live guest sessions, merged with member counts. Public; no auth.
  Client fetches on opening the lobby and polls (~3s) for live counts.
- `POST /api/sessions` — create. Body: `name`, `description`, `settings`, `seed`
  (`default` | imported project JSON), `clientId`. A valid Bearer JWT →
  `owner_user_id`; otherwise guest → `owner_client_id`. Returns the new `id`;
  client then navigates to `/r/<id>`.
- `PATCH /api/sessions/:id` — edit `name` / `description` / `settings`. Authz:
  JWT `userId === owner_user_id`, **or** guest match on `owner_client_id`. (Guest
  match is weak; real authorization is deferred to the moderation spec — accepted
  for a hobby tool.)
- `DELETE /api/sessions/:id` — owner-only (logged-in). Guest sessions self-prune
  on empty.

## UI surfaces

- **`LobbyView`** — list of sessions (name, description, owner handle, live member
  count / "live" indicator), a **Create** button, click-to-join, and an empty
  state.
- **Create dialog** — form: `name`, `description`, *disabled* `maxWritableUsers`
  and `tracksPerUser`, and a seed picker (default project / import `.json`,
  reusing the existing export/import). Create → enter studio.
- **Studio additions** — a **Leave** (back-to-lobby) control, and an owner-only
  **Session settings** panel to edit name/description anytime.
- **Sidebar** — already lists Studio/Account. Lobby and Account entries are always
  present; when in a session it also shows **Leave** and **Session settings**
  (owner only).

## Testing

Follow the project convention: test logic/composables/pure helpers; never mount
`.vue` files.

- `SessionStore`: `InMemorySessionStore` unit tests (create/get/list/update/
  delete, snapshot upsert, guest-prune). `PostgresSessionStore` tested against the
  same contract where DB tests run.
- Autosave: dirty-flag set on `appendOp`; sweep flushes only dirty rooms;
  flush-on-disconnect; flush-on-SIGTERM; settings-write-immediate. Unit-test the
  flusher's dirty/clean selection and boundary triggers with an in-memory store.
- Lobby list merge: durable rows + in-memory presence + member counts, including
  guest-live-only visibility. Pure merge function, unit-tested.
- Navigation: URL ↔ session-token mapping (room present → studio, absent → lobby,
  unknown → bounce) as a pure resolver, extending the existing `roomId` tests.
- API handlers: create (guest vs logged-in owner assignment), PATCH authz
  (owner match / guest-client match / reject), DELETE owner-only, unknown-session
  rejection.

## Risks / accepted trade-offs

- **Removing auto-mint** changes long-standing behavior: a raw `/r/<id>` to an
  unknown session no longer creates a room (it bounces to lobby). Intentional —
  sessions are now entities created via the lobby.
- **Weak guest settings-edit auth** (`owner_client_id` match). Acceptable for a
  hobby tool; strengthened in the moderation spec.
- **~60s crash window** for unflushed edits on a hard crash. Mitigated by live
  clients holding state and SIGTERM flush on graceful restarts.
- **Single-instance assumption:** in-memory presence + in-memory `RoomStore`.
  Horizontal scaling would need a shared presence/store (Redis) — out of scope.
