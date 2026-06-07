# Guaranteed Local Delivery & Non-Destructive Convergence — Design

> **Status:** Approved design (brainstorming output). Concrete, scoped design
> derived from the pre-plan `2026-06-07-single-source-of-truth.md`. This is the
> input to `superpowers:writing-plans`.
>
> **Date:** 2026-06-07 · **Branch:** `docs/sst-justification`

---

## TL;DR

The server (its in-memory room) is the single orderer and source of truth. Two
things are not yet guaranteed, and this design fixes them:

1. **Local edits don't reliably reach the server.** An op sent but not echoed has
   no resend; worse, it is *dropped* on disconnect (`Outbox.onClosed` preserves
   `pending` but not `inFlight`).
2. **Server-driven state replacement can erase un-acked local edits.** A
   `snapshot` does a wholesale `replaceProject` without consulting the Outbox.

We add **at-least-once delivery**, a **non-destructive reconcile-merge**,
**opId-gap peer-repair**, and an **honest periodic flush** — all **without any new
DB writes** (the original mission was to *reduce* free-tier DB load). The durable
op-log idea from the pre-plan ("approach B") is explicitly **out of scope**.

---

## 1. Guarantees

- **G1 — Delivery.** Every local edit reaches the in-memory authoritative room and
  is broadcast to peers. At-least-once; survives lost echoes, reconnects, and
  tab-close.
- **G2 — Non-destructive reconcile.** Server-driven state replacement (snapshot)
  never erases an un-acked local edit.
- **G3 — Peer convergence.** A connected peer that misses a broadcast detects the
  gap and self-repairs from the server.

### Locked decisions (from brainstorming)

- **Sole orderer.** The server in-memory room orders all ops. Multi-user same-leaf
  conflicts resolve by **server arrival order** (last to reach the server wins).
- **"Reached the server" = ordered into the in-memory room + broadcast.** *Not*
  the DB. The delivery guarantee targets the live session, not durability.
- **DB cadence unchanged.** Periodic flush (`FLUSH_INTERVAL_MS`, currently 60s) +
  flush-on-disconnect + flush-on-shutdown. **No new or per-op DB writes.**
- **Duplicate handling = server echoes, not nacks** (see Piece 1).
- **Reconcile re-asserts pending (single-author correct).** Per-leaf op-versioning
  for precise multi-user same-leaf reconcile is a **deferred follow-up**.

### Non-goals

- Per-op / durable op-log persistence (pre-plan "approach B"). Off the table.
- Rolling project state-hash divergence check (pre-plan "approach A" detail).
  Replaced by exact, cheaper opId-gap detection.
- CRDT / OT / sub-op (intra-leaf) merge.

---

## 2. Current architecture (grounded in code on `main`)

- **Op protocol.** Client edits → leaf `set` ops `{ clientSeq, path, value }` over
  WS. Server (`ConnectionHandler.onMessage`, `set` case) validates against the
  accept-list, calls `store.appendOp` (assigns monotonic `opId`, mutates the
  in-memory project, appends to a bounded ring buffer), and **broadcasts** to all
  sockets; the originator's echo carries back its `clientSeq`.
- **Server already dedupes.** `InMemoryRoomStore.appendOp` scans the ring buffer
  for a matching `(clientId, clientSeq)`; on a hit it returns
  `{ ok: false, reason: 'duplicate' }`, and `ConnectionHandler` currently
  **nacks** `op.duplicate` (`ConnectionHandler.ts:160-162`).
- **Outbox** (`packages/client/src/sync/Outbox.ts`): `pending` (throttle, 50ms),
  `inFlight` (sent, awaiting echo/nack), `offlineQueue` (disconnected,
  coalesced-by-path). `onEcho` clears `inFlight`; `onNack` **rolls back** via
  `applyLocal(path, priorValue)`. **No ack timeout / resend.**
- **Snapshot apply** (`messageDispatch.ts:42-55`): `replaceProject(project,
  normalizeProject(msg.project))` under `enterSuppress()/exitSuppress()`, then
  `resetApplyOpState()`. Does **not** consult the Outbox.
- **Catch-up** (`ConnectionHandler.handleHello`): on `hello` with
  `resumeFromOpId`, replay from ring buffer via `store.getOpsSince` (or `snapshot`
  if evicted), then `sync.complete`. This machinery exists **only at hello**.
- **Persistence** (`SessionSync`): `flushRoom` does `peekProject → saveSnapshot →
  clearDirty`; the lost-update window is documented at `SessionSync.ts:32-41`.

### The two concrete holes

1. **Delivery hole.** `Outbox.onClosed()` moves `pending` → `offlineQueue` but
   **not** `inFlight`. An op sent-but-not-echoed when the socket drops is neither
   re-sent (`onLive` flushes only `offlineQueue`) nor preserved → **silently lost**
   on reconnect.
2. **Clobber hole.** `snapshot` → `replaceProject` overwrites the entire reactive
   project with server state, ignoring `inFlight` / `offlineQueue` / `pending` →
   un-acked local edits can be **erased** by a server repair.

---

## 3. Design — four pieces

| # | Piece | Side | Serves |
|---|-------|------|--------|
| 1 | At-least-once Outbox | client | G1 |
| 2 | Non-destructive reconcile-merge | client | G2 |
| 3 | opId-gap detection + mid-session replay | client + server | G3 |
| 4 | Honest periodic persistence (lost-update fix) | server | reload correctness (no new writes) |

### Piece 1 — At-least-once Outbox (G1)

**Ack deadline + resend.** Each `inFlight` entry carries a deadline
(`ACK_TIMEOUT_MS`, value chosen in the plan — order of a few seconds). On expiry,
**resend the same op with the same `clientSeq`** (so server dedupe recognises it).
Cap the number of resends; after the cap, surface a failure rather than loop
forever.

**Duplicate handling — server echoes instead of nacks.** Change
`ConnectionHandler`: when `appendOp` returns `{ ok: false, reason: 'duplicate' }`,
send the originator a normal echo `set` (with `opId` from the existing op and the
incoming `clientSeq`) instead of an `op.duplicate` nack. This makes resend fully
transparent: the client's `onEcho` clears `inFlight` and nothing rolls back.
- *Requires:* `appendOp`'s duplicate result to expose the already-applied `opId`
  (so the echo carries the correct `opId`). Extend `AppendOpResult` duplicate
  variant with `{ op: AppliedOp }`.
- `nack` remains for genuine rejections (`validation`, `rate.limited`,
  `path` errors) → those still roll back. `op.duplicate` as a *nack* is removed.

**Preserve `inFlight` across disconnect.** `onClosed()` moves `inFlight` entries
into `offlineQueue` (coalesced by path, keyed like `pending`) so reconnect's
`onLive` re-sends them. Closes hole #1.

**Leave-flush.** On `beforeunload` / `leaveSession`, synchronously flush `pending`
(promote throttled entries to sent while the socket is still live). Discrete edits
already flush on gesture-end; this catches the ~50ms throttle window for a closing
tab.

### Piece 2 — Non-destructive reconcile-merge (G2)

When a `snapshot` arrives (`messageDispatch.ts` `snapshot` case), after
`replaceProject(normalizeProject(msg.project))`:

1. Re-apply every un-acked local edit on top — entries in `inFlight` and
   `offlineQueue` — to the reactive `project` (under suppression).
2. **Re-enqueue those edits through the Outbox for (re)delivery.** This must not
   depend on `onLive`: a snapshot can arrive mid-session while the socket is still
   live (a `resync` that hit ring-buffer eviction), in which case `onLive` never
   fires. The reconcile path re-sends directly when live and queues when offline.
   A single Outbox entrypoint (e.g. `reassertPending()`) covers both cases.

This guarantees a snapshot can never erase a pending local change (G2).

**Single-author correctness (iteration 1).** Re-asserting pending is
unconditionally correct when there is one author.

**Multi-user refinement (deferred).** In the rare multi-user same-leaf case during
a snapshot repair, a stale local value could re-win. Making that precise needs
per-leaf op-versioning (compare a pending op's base against the leaf's
`lastAppliedOpId`, re-assert only if not superseded). Tracked as a follow-up; not
built in iteration 1.

### Piece 3 — Peer-drift repair via opId-gap (G3)

- **Detect.** Broadcasts carry monotonic `opId`; the client persists
  `opIdLastSeen` (`WsClient` `PersistedSyncState`). On receiving a `set` with
  `opId > opIdLastSeen + 1`, the client has missed at least one op → **gap**.
- **Repair.** Send a lightweight mid-session **`resync`** request carrying
  `fromOpId = opIdLastSeen`. The server responds by replaying from the ring buffer
  (`store.getOpsSince`) or sending a `snapshot` if the range was evicted — the same
  code path `handleHello` uses for catch-up, factored so it's callable mid-session.
- **New protocol surface.** One new client→server message type (`resync`, with
  `fromOpId`). No new server machinery beyond routing it into the existing
  replay/snapshot helper. A replayed/snapshot repair flows through Piece 2's
  reconcile-merge, so it is also non-destructive.

### Piece 4 — Honest periodic persistence (no new writes)

Fix the documented `SessionSync` lost-update window
(`SessionSync.ts:32-41`):

- Add a **monotonic room version** to `RoomStore`, bumped on every `appendOp`.
- `flushRoom`: read `{ project, version }` at `peek`; after `saveSnapshot`, call a
  **conditional `clearDirty(roomId, version)`** that clears the dirty flag **only
  if** the room's version is unchanged since the peek. If an op landed mid-flush,
  the flag stays set and the next sweep retries.

Same cadence, same flush-on-disconnect — just guarantees the flush never clears
dirty for an op it didn't persist. A reload then reflects every acked op up to the
last flush boundary (bounded staleness, no silent loss).

---

## 4. Data flow

**Happy path (live).** edit → watcher → `Outbox.enqueue` → throttle/gesture-end →
`send(set)` → server validates → `appendOp` (new `opId`, mutate, ring buffer) →
broadcast to all → originator `onEcho` clears `inFlight`; peers `applyOp`,
`recordOpIdSeen`. Periodic sweep persists (conditional `clearDirty`).

**Lost echo.** `inFlight` deadline fires → resend same `clientSeq` → server dedupe
hit → server **echoes** the already-applied op → `onEcho` clears `inFlight`. No
rollback, no double-apply.

**Disconnect with un-acked op.** `onClosed` moves `inFlight` (+ `pending`) →
`offlineQueue` → reconnect → `onLive` flushes `offlineQueue` → server (dedupe as
needed) → delivered.

**Mid-session snapshot repair.** `resync`/eviction → `snapshot` → `replaceProject`
→ re-apply `inFlight` + `offlineQueue` on top and re-enqueue via the Outbox
(Piece 2; re-sends directly while live). Local edits survive and are delivered.

**Peer misses a broadcast.** Peer sees `opId` gap → `resync(fromOpId)` → server
replays missing ops (or snapshot) → peer converges.

**Tab close mid-edit.** `beforeunload` → leave-flush promotes `pending` → sent
while live → server orders + broadcasts → peers see it; server's
flush-on-disconnect persists at the normal boundary.

---

## 5. Components & interfaces touched

- `packages/client/src/sync/Outbox.ts` — ack deadline + resend (cap), `onClosed`
  preserves `inFlight`, leave-flush entrypoint, duplicate-as-success (via server
  echo). New dep hooks as needed (clock/timer injection for testability).
- `packages/client/src/sync/messageDispatch.ts` — reconcile-merge on `snapshot`;
  opId-gap detection on `set`; route `resync` trigger.
- `packages/client/src/sync/WsClient.ts` — send `resync` frame; expose
  `opIdLastSeen` for gap detection; leave-flush wiring.
- `packages/client/src/composables/useSynth.ts` — wire leave-flush into
  `leaveSession`; surface delivery/failure state if needed for tests.
- `packages/shared/src/...` — new `resync` client message type + schema; extend
  `AppendOpResult` duplicate variant to carry the existing `op`.
- `packages/server/src/sync/ConnectionHandler.ts` — duplicate → echo (not nack);
  factor catch-up replay into a mid-session-callable helper; handle `resync`.
- `packages/server/src/room/RoomStore.ts` + `InMemoryRoomStore.ts` — room version
  counter; `clearDirty(roomId, version)` conditional signature; duplicate result
  carries `op`.
- `packages/server/src/session/SessionSync.ts` — version-gated `clearDirty`.

---

## 6. Testing (TDD)

Client:
- Resend fires after `ACK_TIMEOUT_MS` for an un-echoed op; same `clientSeq`.
- Resend cap surfaces failure, does not loop.
- `op.duplicate`-class resend resolves via echo → `inFlight` cleared, **no
  rollback** (regression for the duplicate-nack trap).
- Genuine nack (validation/rate) still rolls back.
- `inFlight` survives disconnect → reconnect and is re-sent (regression for hole #1).
- Snapshot reconcile-merge re-applies pending; pending not erased (regression for
  hole #2).
- opId-gap on inbound `set` triggers a `resync(fromOpId)`.
- Leave-flush sends `pending` synchronously on `leaveSession`.

Server:
- Duplicate `appendOp` → echo `set` with the original `opId` (not a nack).
- `resync(fromOpId)` replays ring-buffer ops (or snapshot if evicted), then resumes.
- Conditional `clearDirty(version)`: an op applied mid-flush keeps the room dirty
  (regression for the lost-update window).

Shared:
- `resync` message schema round-trips; extended `AppendOpResult` types.

## 7. Validation (telemetry, `FIDDLE_OTEL=1`)

- `fiddle.ws.frames` by `ws.dir`/`ws.type`: every local edit produces a server-side
  inbound `set`; resends and `resync` frames trend to ~0 in steady state.
- Gap/resync counter (new instrumentation) → ~0 in steady state.
- `fiddle.db.calls` / `fiddle.db.duration_ms`: **unchanged** before/after — proves
  no new DB load (the core constraint).

Repro harness: two clients, scripted edits incl. a forced mid-session frame drop
and a tab-close mid-edit; assert both converge and the post-flush DB snapshot
reflects all acked ops.

## 8. Risks & open questions

- **`ACK_TIMEOUT_MS` tuning.** Too low → spurious resends; too high → slow recovery.
  Pick conservatively (a few seconds); validate with telemetry.
- **Resend cap UX.** What does "delivery failed after N retries" surface as? For
  iteration 1, log + keep the op queued; a sync-status banner is a separate concern.
- **Dedupe horizon.** Server dedupe scans the ring buffer (bounded
  `RING_BUFFER_CAPACITY`); a resend of a very old op evicted from the buffer could
  re-apply. In practice resends happen within seconds, far inside the buffer — but
  note it.
- **Leave-flush reliability.** `beforeunload` WS sends are best-effort. Mitigated by
  gesture-end already flushing discrete edits; the residual window is small.
- **Multi-user same-leaf reconcile** is deferred (see Piece 2). Acceptable because
  the protected case is single-author, and mid-session snapshots are rare.

## 9. Next step

`superpowers:writing-plans` → bite-sized TDD plan, implemented piece-by-piece
(1 → 4), validated against the telemetry in §7.
