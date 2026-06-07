# Single Source of Truth & Live Convergence — Pre-Plan / Justification

> **Status:** Pre-plan / problem framing. This is **not** an implementation plan.
> It exists to justify the work, pin down the current architecture accurately, and
> survey approaches so we can pick a direction. The actual bite-sized plan comes
> later via `superpowers:brainstorming` → `superpowers:writing-plans`.
>
> **Date:** 2026-06-07 · **Branch where filed:** `docs/sst-justification`

---

## TL;DR

Fiddle's collaboration model has **no single authoritative source of truth and no
live convergence guarantee**. Authority is split across three tiers (client
reactive project, server in-memory room, durable Postgres snapshot), and once a
session is live nothing detects or repairs divergence between a connected client
and the server. We just fixed the worst *instance* of this (pre-Play edits that
were structurally unsendable — `fix/sync-before-play`), but the *class* of problem
remains: a client can display state the backend never accepted, and only a reload
heals it. This doc argues the problem is worth solving now, describes the system
as it actually is, and recommends an incremental **server-authoritative +
confirm/reconcile** direction over the existing op protocol.

---

## 1. Motivation

### What we observed (the incident)

Two browsers opened the same room (`/r/xhj7zme33`). Track 1 differed in **both
engine and sequence** between them; tracks 2–5 matched. Root cause of that
specific symptom: the outbound-sync watchers were installed by the audio
bootstrap (first **Play**), so edits made before Play were never emitted. Fixed in
`fix/sync-before-play` by decoupling the sync watchers from the `AudioContext`.

But the user's reaction cut deeper than the bug:

> "what bothers me most is that we don't have any single source of truth … those
> changes [were] not propagated to db or in-memory session on the backend, [yet] I
> … load[ed the] same session in the original browser and it was different from …
> other browsers."

That is the real issue. The pre-Play bug was just the most flagrant way to trip
over it.

### Why it matters now

- **Silent data loss / lost trust.** A user can edit for minutes, see their work
  on screen, and have none of it persist — with no error, no indicator. "It looked
  saved" is the worst failure mode for a creative tool.
- **It's the crux of the product direction.** The roadmap goal is live multi-user
  collaboration (see `[[multi_user_playground_goal]]`). Convergence is not a
  nice-to-have there; it's the feature.
- **We now have the telemetry to do it right.** The local OpenObserve stack
  (merged `4c723da`) can measure op flow, divergence, and DB cadence — so we can
  validate a fix with data instead of guesses.

---

## 2. Current architecture (as it actually is)

Grounded in the code on `main` as of this writing.

### 2.1 The op protocol

- Client edits produce **leaf `set` ops** `{ clientSeq, path, value }` over a
  WebSocket. Paths are validated against a fixed **accept-list**
  (`packages/shared/src/project/accept-list.ts`) — only known leaves are writable;
  no whole-object writes.
- Server (`packages/server/src/sync/ConnectionHandler.ts`) validates each op,
  then `store.appendOp` assigns a **monotonic `opId`**, mutates the in-memory
  project, appends to a per-room **ring buffer**, and **broadcasts** to all sockets
  (the originator's echo carries back its `clientSeq`).
- Join handshake: `hello` → `welcome` → **catch-up** (replay ops since the
  client's `resumeFromOpId` if still in the ring buffer, else a full `snapshot`)
  → `sync.complete`. The client gates outbound sync on `sync.complete`
  (`syncReady`).

### 2.2 Three tiers of "truth"

| Tier | What it is | Authority | Durability | Failure mode |
|------|-----------|-----------|------------|--------------|
| **Client reactive `project`** (`useSynth.ts`) | What the user sees; optimistically mutated on every edit | Authoritative *to the user*, locally | localStorage (`fiddle:project`, standalone only) | Holds un-acked / un-sent state with **no reconciliation while live** |
| **Server in-memory room** (`InMemoryRoomStore`) | The live project + op ring buffer; assigns `opId` order | De-facto **live** authority + orderer | **None** — lost on crash/restart; ring buffer bounded (`RING_BUFFER_CAPACITY`) | Crash loses ops since last flush; eviction breaks long-offline resume |
| **Durable snapshot** (Postgres `session_snapshots`) | Materialized project blob | Authoritative **only at join** | Persisted, but **lossy** | Flushed every `FLUSH_INTERVAL_MS` (60s) / on disconnect / on shutdown — not per-op; the op log itself is never persisted |

The server **is** the orderer, so for ops that actually reach it, leaf
last-writer-wins by `opId` order gives convergence: every client replays the same
broadcasts in the same order. The problem is everything *outside* that happy path.

### 2.3 What already exists to build on

- **Per-op confirm primitive.** `Outbox` (`packages/client/src/sync/Outbox.ts`)
  tracks `inFlight` ops by `clientSeq`, clears on echo (`onEcho`), rolls back on
  `onNack`. Offline edits coalesce by path and flush on reconnect (`onLive`).
- **Monotonic `opId` + ring-buffer replay** for reconnect catch-up.
- **`opIdLastSeen`** persisted per room (`WsClient` `PersistedSyncState`) — used
  for resume, not for live divergence checks.
- **Periodic durable flush** with dirty tracking (`SessionSync`), plus
  normalize-at-the-boundary (`normalizeProject`) so malformed state can't reach
  the DB.

### 2.4 Where convergence actually breaks

1. **Ops never emitted.** Optimistic apply with no gate on server acceptance: any
   failure to send (the pre-Play bug, a watcher gap, a crash before flush) creates
   a silent local-only divergence. *Fixed one instance; the class remains.*
2. **In-flight ops with no timeout.** `Outbox.inFlight` entries that are never
   echoed **and** never nacked (dropped frame, server applied but echo lost) sit
   forever — no resend, no warning. "Confirmed" is best-effort.
3. **No live divergence detection.** A connected client that drops/misorders a
   broadcast has no way to notice it has drifted. `opIdLastSeen` is only consulted
   on reconnect.
4. **Durable truth lags and can lose data.** The op log is in-memory only; a crash
   loses up to `FLUSH_INTERVAL_MS` of ops. The documented `peek → saveSnapshot →
   clearDirty` lost-update window (`SessionSync.ts`) clears dirty for ops that may
   not have been persisted against an async store.
5. **No surfaced sync state.** The UI shows unconfirmed/optimistic edits
   identically to confirmed ones. The user cannot tell "saved" from "not saved."

---

## 3. Problem statement

> While a session is live there is no authoritative source of truth that clients
> are guaranteed to converge to, no detection or repair of divergence, and no way
> for a user to know whether what they see has been accepted and persisted.

Concretely, a fix should make these true:

- **R1 — Single authority:** the server is the one orderer *and* the durable truth
  is a faithful, bounded-staleness reflection of the ordered op stream (not a
  lossy periodic blob that can disagree with what was acknowledged).
- **R2 — Convergence:** a connected client provably converges to server truth;
  divergence is **detected** (cheaply, continuously) and **repaired** (re-sync).
- **R3 — Honest UI:** the client distinguishes pending / confirmed / failed /
  offline, and never silently presents unconfirmed edits as committed.
- **R4 — No silent loss:** an op that isn't accepted is retried or surfaced; a
  crash loses at most a bounded, known amount.

### Non-goals (for the first iteration)

- Full offline-first authoring or rich conflict-merge UX.
- Sub-op (intra-leaf) merge / operational transform of text-like fields.
- Replacing the leaf-`set` accept-list model. We want to *strengthen* it, not
  swap it for a general CRDT (see §4).

---

## 4. Options considered

### A. Server-authoritative + confirm/reconcile (over the existing op model) — **recommended**

Keep leaf-`set` + `opId` ordering. Add:

- **Ack with timeout/resend.** Extend `Outbox.inFlight` with a deadline; an op not
  echoed/nacked within N ms is resent (idempotent by `clientSeq`) or surfaced.
- **Cheap divergence check.** Server includes a running **state version/hash**
  (e.g. `opIdHead` + a rolling project hash) on `sync.complete` and periodically;
  client compares against its applied state and, on mismatch, pulls a fresh
  snapshot (forced re-sync) — the same machinery `connectToSession` already uses
  at join, now usable mid-session.
- **Honest sync status** derived from `inFlight`/offline-queue/divergence state,
  surfaced in the UI (connection-transparency banner — already on the roadmap as
  item #4).

*Pros:* smallest delta; reuses `opId`, ring buffer, echo/nack, `forceSnapshot`.
Incremental and shippable in phases. *Cons:* hashing/versioning must be cheap and
deterministic across client/server; re-sync is a blunt repair (full snapshot).

### B. Durable op log + version vector

Make the **op log itself durable** (append ops to Postgres, snapshot becomes a
cache/compaction). `opId` becomes the canonical version; clients track
`lastAppliedOpId`; "am I at head?" is a trivial integer compare.

*Pros:* eliminates the lossy-snapshot tier (R1/R4 fall out naturally); exact
divergence detection. *Cons:* a real write-path redesign and more DB load — which
cuts against the *original* motivation (we started this whole effort to *reduce*
non-optimal DB interaction on the free tier). Likely a **phase 2** once telemetry
tells us the write volume is tolerable.

### C. CRDT / OT

Replace leaf-LWW with a convergent data type.

*Pros:* convergence by construction, true offline-first. *Cons:* large rewrite;
overkill for a fixed-schema leaf model with a small accept-list; conflicts with
the existing validation/normalize design. **Rejected** for now.

### Recommendation

Pursue **A** incrementally, designed so it can grow into **B** for durability if
telemetry justifies it. A directly satisfies R2/R3 and most of R4 with low churn;
B is the eventual answer for R1/R4 but is gated on the DB-load analysis that
motivated this entire workstream.

---

## 5. Proposed direction (high level — not the task list)

Phased building blocks for approach A. The real plan will decompose these.

1. **In-flight reliability:** deadline + idempotent resend in `Outbox`; expose
   pending/failed counts. (Client-only; high value, low risk.)
2. **State version + divergence check:** server-computed version/hash on
   `welcome`/`sync.complete` + periodic heartbeat; client compares and triggers a
   mid-session `forceSnapshot` re-sync on mismatch.
3. **Sync-status UI:** surface connected / syncing / pending / offline / diverged
   (roadmap item #4). Make "saved" legible.
4. **Durable lost-update fix:** versioned/conditional `clearDirty` on `RoomStore`
   (close the `SessionSync` window) — small, and a prerequisite for trusting the
   durable tier.
5. **(Phase 2, telemetry-gated)** durable op log / version vector (approach B).

---

## 6. Validation plan (use the telemetry)

The merged observability stack makes this measurable. Before/after a change, with
`FIDDLE_OTEL=1`:

- **Op flow:** `fiddle.ws.frames` by `ws.dir`/`ws.type` — confirm every local edit
  produces an inbound `set` server-side; watch for `nack`.
- **Divergence:** instrument the new version/hash check; count mismatch → re-sync
  events (should trend to ~0 in steady state).
- **DB cadence:** `fiddle.db.calls` / `fiddle.db.duration_ms` by `db.op` +
  `error` — ensure any durability change (esp. approach B) doesn't regress the
  free-tier DB load that started this effort.

A repro harness: two clients, scripted edits incl. concurrent same-leaf writes and
a forced mid-session frame drop; assert both converge and the DB snapshot matches.

---

## 7. Risks & open questions

- **Hash determinism:** client and server must compute the same project hash
  (key ordering, float formatting, `normalizeProject` parity). Needs a shared,
  tested codec.
- **Re-sync cost:** full-snapshot repair is ~224 KB; acceptable if rare, but the
  divergence check must be genuinely cheap so we don't trade silent drift for
  chatty re-syncs.
- **DB load vs. the original mission:** approach B adds writes. This work must not
  undo the DB-interaction improvements we set out to make — telemetry gates it.
- **Scope creep:** R3 (sync-status UI) and R4 (reliability) are independently
  valuable and shippable; resist bundling them with the bigger B redesign.

---

## 8. Next steps

1. Review/adjust this framing with the user (scope, R1–R4, A-vs-B sequencing).
2. `superpowers:brainstorming` on approach A to produce a concrete spec.
3. `superpowers:writing-plans` → bite-sized TDD plan.
4. Implement (subagent-driven), validating each phase against the telemetry above.

This pre-plan is the input to step 2, not a substitute for it.
