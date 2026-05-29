# Fiddle Synth — Feature Roadmap

Backlog of planned features (excluding sound-engine work, which is tracked
separately). Captured 2026-05-29. This is a **backlog for later** — ordering is
not finalized; revisit to pick the next feature when ready.

## Where the app is today

Deployed and working: client on Vercel, Fastify WebSocket sync server on Render
(free tier), real-time per-field LWW collaboration verified in production.
Constraints that shape this backlog:

- **In-memory, single-instance** room store (`InMemoryRoomStore`); free-tier
  Render spins down on idle and wipes rooms. **No database, no auth** yet.
- Fixed project schema: **4 tracks × 16 steps**. `TRACK_COUNT`/`STEP_COUNT`
  bounds live in `packages/shared/src/project/accept-list.ts`; `ROOM_CAP=4` is
  separate and unrelated.
- Sync ops are validated against a **static path accept-list**
  (`validatePathAndValue`) — it answers "is this path writable", with **no
  notion of who** is writing.
- Identity is ephemeral: a per-room `clientId` + color + handle assigned on the
  `hello` handshake (`ConnectionHandler.handleHello`).

## The architectural fork

Four of the five features below converge on one decision: **add an identity +
persistence layer**, turning the server from an ephemeral toy into a stateful
app. That decision orders the whole backlog.

**Intended pivot stack: Supabase (free tier).** It bundles Auth (email + OAuth)
+ Postgres + row-level security, covering "auth + saved sessions" end-to-end
without building a separate auth system. Integration point: Supabase Auth issues
a JWT; the Fastify WS server validates it on the `hello` frame and the
authenticated user id *becomes* the `clientId`.

- Alternative (if we'd rather own auth): **Neon Postgres + Auth.js/Clerk**.
- Avoid Render Postgres — its free tier is time-limited.
- Note: free Supabase pauses inactive projects (~1 week, wakeable) — fine for now.

## The five features

1. **User auth + saved sessions** — the foundation; needs Supabase (auth + DB).
   Forces off pure in-memory (and likely off free Render). Unlocks everything
   "persistent". Biggest lift.

2. **Lobby / room selector** — two flavors:
   - *Cheap:* list currently-active rooms from the server's in-memory `Map` via
     an HTTP endpoint + member counts (no DB, ~1 day).
   - *Persistent:* list saved rooms (needs #1).
   Ship the cheap version first regardless.

3. **More tracks** — schema change, mechanical but spread out: `TRACK_COUNT`
   bound in the shared accept-list + project factory; client 4-color palette +
   grid layout + mixer strips; `PROJECT_SCHEMA_VERSION` bump + reconciler.
   Decouple from `ROOM_CAP`. **No backend pivot.**

4. **Separate track pool per user** — most invasive to the *sync model*. Moves
   op validation from static "is this path writable" to per-connection "writable
   *by this client*" authorization in the op path (`ConnectionHandler` set-op
   branch). Couples to auth (#1) + more-tracks (#3). Do last.

5. **Per-step parameter locks (p-locks)** — self-contained, **no backend
   dependency**, high musical payoff (Elektron-style). Each `Step` gains an
   optional param-override map; the accept-list opens `tracks.i.steps.j.locks.*`;
   the engine applies overrides at trigger time via the existing `applyParams`
   path; the step UI gains per-step editing. (Brushes against the "sound-engine
   excluded" note — treat as sequencer work.)

## Suggested sequencing (not final)

- **No-pivot track (ship anytime):** more tracks → p-locks → cheap lobby.
- **Foundation track (commit to Supabase):** auth + DB → saved sessions →
  persistent lobby → per-user track pools.
