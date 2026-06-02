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

6. **Session version history (restore points)** — deferred follow-up to the
   persistent-lobby work (#1–2). Once sessions persist as a latest-snapshot in
   Postgres, keep the last ~10 *meaningful* versions per session — captured on
   **session-boundary flushes** (a user leaves / the room empties), NOT on the
   periodic 60s autosave (otherwise "10 versions" only spans ~10 minutes). Lets a
   user roll a session back to an earlier state. Implementation sketch: a
   `session_versions` table (`session_id, version_no, project jsonb, created_at`),
   insert-on-boundary, prune to the 10 most recent. Design the lobby/persistence
   flush path so this slots in without rework. Explicitly out of scope for the
   initial persistent-lobby slice.

7. **Project templates** — deferred extension to the create-session flow. The
   initial persistent-lobby slice lets a creator seed a new session from a blank
   default project or an imported `.json`. Later, offer a curated set of starter
   templates (e.g. genre/beat starting points) as a third seed option in the
   create form. Small, additive; no schema change beyond a template catalog.

8. **Breaking the 16-step limit** — *direction undecided; analysis below.*

   The real fork is **shared vs. local transport**, not pattern length. Today
   transport is **local**: each client runs its own `Sequencer` and presses PLAY
   independently; only data (steps, bpm) syncs, not the playhead — users can be
   at different loop positions. That locality is core to the "shared evolving
   loop" feel. The three directions sit differently against it:

   - **(a) Variable-length patterns — recommended first.** Length becomes a field
     (16/32/64), ideally **per-track** → polymeter/polyrhythm (tracks of
     different lengths phase into long evolving cycles). Keeps local transport
     fully intact; tiny sync impact (a `length` field + the steps array grows;
     `STEP_COUNT` becomes a *max* in the accept-list). Most musical, best fit,
     no backend pivot. Touches: `Sequencer` loop, project factory/schema +
     reconciler, accept-list bound, tracker UI (scroll/pages for long patterns).
   - **(b) Pattern chaining — later, bigger.** Multiple patterns + a chain/song
     order. Chaining forces **shared transport** ("which pattern is playing now"
     is shared state) + a decision on *who drives the chain* (a conductor or a
     shared clock). A coordination step-change that pulls away from free
     fiddling; pairs naturally with the persistence pivot (songs want saving).
   - **(c) Timeline — park it.** A linear authored arrangement implies a single
     shared playhead and composed structure — opposite of a live shared loop.
     Most complex, least aligned with the multiuser-jam identity. Skip unless the
     app shifts from "jam together" to "compose together".

   Caveat for (a): with long/polymetric patterns, the existing per-client phase
   drift gets more audible, raising a *soft* question of whether to add a lightly
   shared transport (shared downbeat) even without chaining. Note, not blocker.

9. **Remove a session from the lobby list** — follow-up to the persistent-lobby
   work (#1–2). There's currently no way to delete a session; the backend already
   has `DELETE /api/sessions/:id` + `deleteSession()` in the client, but no UI
   surfaces it. Add an owner-only remove control to each lobby row (and/or the
   session-settings panel), with a confirm step. **Fold in a known minor bug
   while implementing:** the lobby briefly flashes the empty-state ("No live
   sessions yet.") before the session list resolves — gate the empty-state on the
   initial fetch having completed (e.g. a `loaded`/`pending` flag) so it doesn't
   render during the first load.

## Suggested sequencing (not final)

- **No-pivot track (ship anytime):** more tracks → variable-length patterns
  (6a) → p-locks → cheap lobby.
- **Foundation track (commit to Supabase):** auth + DB → saved sessions →
  persistent lobby → per-user track pools. Pattern chaining (6b) belongs here
  too — it needs shared transport and pairs with saving "songs".
