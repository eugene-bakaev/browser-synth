# Bulk Project Load — Design

**Date:** 2026-07-04
**Status:** Approved by user (option 2 of 3; "transport only" UX)
**Branch:** `feat/bulk-project-load`

## Problem

Loading a project into a live session (StudioView OPEN, and NEW over a
non-trivial project) syncs by emitting the whole-project leaf diff as
individual `set` ops — one WebSocket message per changed leaf. The server's
per-connection `TokenBucket` (`packages/server/src/sync/rate-limit.ts`:
burst 200, sustained 100 ops/sec) nacks everything over budget with
`rate.limited`, and the client's `Outbox.onNack`
(`packages/client/src/sync/Outbox.ts:146`) ignores the nack code and rolls
every nacked leaf back to its prior value — during an import, the blank
defaults. Result: silent, timing-dependent data loss.

**Reproduced 2026-07-04:** `___test-fiddle-project.prj.json` (8 customized
tracks) produces a 266-op burst; OPEN into a fresh session lost ~34+ leaves
(synth2 LFO rates/shapes, filter cutoff/resonance/drive, env3, matrix
amounts, mono/poly `mode`, step velocities), with a *different* subset lost
per attempt. Sessions `12312312312312312312` and `123123` on the local DB
hold two such damaged imports.

Note: the session-create "Import .json" path seeds the server over HTTP and
is already lossless. Only the in-session OPEN/NEW path is broken.

## Decision

Replace the op-storm with an **atomic client→server `load` message**: the
client sends the full project once; the server validates it, replaces the
room doc, and rebroadcasts the **existing** `SnapshotMessage` to every
socket in the room. Peers and the reconnect/catch-up path need no new
client machinery — snapshot application already exists and already
maintains the D18 watermark invariants (`recordOpIdSeen` on snapshot).

Rejected alternatives:
- *Client-side pacing + retry-on-`rate.limited`*: keeps import
  non-atomic, adds seconds of drain time, still racy with concurrent edits.
- *Load as a special op-log entry*: preserves ring-buffer contiguity but
  forces every `AppliedOp` consumer (catch-up replay, dedup, broadcast) to
  learn a second op kind.
- *HTTP side-channel* (`POST /api/sessions/:id/project`): second mutation
  surface racing the op stream; identity/ack plumbing murky.

## Wire protocol (additive; no protocol version bump)

New client→server message, Zod-validated like the others in
`packages/shared/src/protocol/schema.ts`:

```ts
export interface LoadMessage {
  v: 1;
  type: 'load';
  clientSeq: number;   // same counter as set ops — unique per connection
  project: unknown;    // validated server-side (see Server)
}
```

`ClientMessage` union gains `LoadMessage`. `WelcomeMessage` gains an
optional capability advertisement:

```ts
export interface WelcomeMessage {
  // ...existing fields...
  capabilities?: string[];   // server sends ['load']
}
```

The client uses the bulk path only when
`welcome.capabilities?.includes('load')`; otherwise it falls back to
today's whole-project diff. This protects the deploy-skew window (Vercel
client and Render server deploy independently). Old servers reject unknown
message types as fatal `hello.invalid`, so the client MUST NOT send `load`
without the capability.

Failure replies reuse the existing `NackMessage` correlated by the load's
`clientSeq`:
- invalid/oversized project → `value.invalid`
- load budget exceeded → `rate.limited`

Success reply is the broadcast `SnapshotMessage` itself (the originator
receives it like any peer). No new server→client message.

## Server

### RoomStore (`packages/server/src/room/RoomStore.ts` + InMemory impl)

New method:

```ts
// Atomically replace the room's project. Advances opIdHead by 1, CLEARS the
// op ring buffer (so getOpsSince(anything < new head) returns null → the
// caller sends a snapshot), bumps roomVersion, and marks the room dirty for
// the autosave flusher. Room must exist (ConnectionHandler runs post-hello).
replaceProject(roomId: string, project: Project): Promise<{ opId: number }>;
```

Invariant update (file header): opIds remain strictly increasing, but a
`load` creates a deliberate gap in replayability — any resume from a
pre-load watermark takes the snapshot path. This is the same contract as
ring-buffer eviction, so `sendCatchUp`'s existing `null` handling covers it.

### ConnectionHandler (`packages/server/src/sync/ConnectionHandler.ts`)

New `msg.type === 'load'` branch (post-hello, like `set`):

1. **Load budget** — a load is one message but replaces the whole doc; the
   TokenBucket is the wrong tool. Per-connection: at most 1 load per
   2000 ms (timestamp check, no new dependency). Over budget →
   `nack(clientSeq, 'rate.limited', 'load rate limit exceeded')`.
2. **Validate** — `Schemas.Project.safeParse(msg.project)`; failure →
   `nack(clientSeq, 'value.invalid', <first issue>)`. On success run
   `normalizeProject` on the parsed value (same healing as every other
   deserialize boundary).
3. **Apply** — `store.replaceProject(roomId, normalized)`.
4. **Broadcast** — `SnapshotMessage { v: 1, type: 'snapshot', opId, project: normalized }`
   to **all** sockets in the room (originator included — that is the ack).

Payload size: the ws server's `maxPayload` must admit ≥ 1 MB (a full
32-track project serializes to ~270 KB). Verify the current setting in the
server bootstrap and raise it if it is lower; document the limit next to
the constant.

Idempotency: `load` is NOT deduped on (clientId, clientSeq). A client
resend after a lost ack re-applies the same content and re-broadcasts a
snapshot — harmless by construction (content-identical replace).

## Client

### WsClient (`packages/client/src/sync/WsClient.ts`)

- Parse `capabilities` off `welcome`; expose `canLoad: boolean`.
- `sendLoad(project: Project, prior: Project): void` — mints a `clientSeq`
  from the same counter as set ops, records the pending load (holding
  `prior` for rollback), sends `LoadMessage`. Only callable when live.
- **Pending-load tracking** (beside the Outbox, not inside it — the Outbox
  is per-leaf): at most one in-flight load, holding `{ clientSeq, prior:
  Project (deep clone of pre-load state), timer }`.
  - `nack` with matching `clientSeq` → `store.loadProject(prior)` rollback
    + surface the error (dialog via the existing StudioView catch → alert
    path).
  - **Any** `snapshot` arrival clears the pending load (ours or a
    concurrent peer's — last-write-wins, same as today's op semantics).
    Snapshot application is already idempotent and already calls
    `recordOpIdSeen(msg.opId)` (D18 honest watermark).
  - Ack timeout (reuse the Outbox's ACK timeout constant): resend once;
    a second timeout rolls back to `prior` and surfaces an error.
- Verify (plan task): the `snapshot` handler applies snapshots that arrive
  **mid-session** (after `sync.complete`), not only during catch-up. If it
  is gated, ungate it — peers converge on a load via exactly this message.

### projectOps (`packages/client/src/app/projectOps.ts`)

`loadAndSyncWholeProject` becomes:

```ts
function loadAndSyncWholeProject(next: Project): void {
  const live = deps.isSyncLive();
  const bulk = live && deps.canBulkLoad();
  // prior = full-Project deep clone of pre-load live state, for nack rollback.
  // toRaw strips Vue proxies (same pattern as serializeProject).
  const prior = bulk ? (structuredClone(toRaw(project)) as Project) : null;
  const before = live && !bulk ? snapshotProjectForSync() : null;
  bus.loadProject(next);                    // optimistic local apply (unchanged)
  if (bulk) deps.sendLoad(next, prior!);    // NEW: one message
  else if (before) enqueueWholeProjectDiff(before); // fallback: old servers
  // offline/solo (neither branch): unchanged behavior, local-only
}
```

New `ProjectOpsDeps`: `canBulkLoad: () => boolean` and
`sendLoad(project: Project, prior: Project): void` (SyncSession wires these
to WsClient; `prior` feeds the pending-load rollback). The diff fallback
(`snapshotProjectForSync` / `enqueueWholeProjectDiff` / `enqueueLeafDiff` /
`enqueueMatrixDiff`) is **kept** until prod is verified on the new path;
its removal goes to BACKLOG.

## Out of scope (logged, not built)

- Confirmation UX when peers are connected ("transport only" per user).
- **BACKLOG entry to add:** `Outbox.onNack` still treats `rate.limited` as
  authoritative for regular set ops — a >200-op burst from other features
  (e.g. FILL/CLEAR across several long tracks) can still lose leaves. The
  bulk load removes the biggest source, not the class.
- Removing the diff fallback + `capabilities` gate (BACKLOG, after prod
  browser sign-off).
- Undo, offline-reconcile changes, HTTP seed path (already lossless).

## Testing

- **Shared:** `LoadMessage` Zod round-trip; `ClientMessageSchema` accepts
  `load` and still rejects unknown types; welcome `capabilities` optional
  (absent = old server, present = `['load']`).
- **Server (unit):** `replaceProject` advances head, clears ring buffer
  (`getOpsSince(oldHead)` → `null`), bumps version, marks dirty;
  ConnectionHandler `load` → snapshot broadcast to originator + peers with
  the new opId; invalid project → `value.invalid` nack and doc unchanged;
  second load inside 2 s → `rate.limited` nack; post-load `resync` from a
  pre-load watermark receives a snapshot (existing null-path).
- **Server (e2e, protocol.e2e.test.ts):** two clients; client A loads a
  project the size of the repro (>266 changed leaves); both clients
  converge to the exact project; zero `rate.limited` nacks observed.
- **Client (unit):** `openProject`/`newProject` send exactly one `load` and
  zero `set` ops when `canBulkLoad()`; diff fallback used when not;
  nack → state restored to `prior`; snapshot arrival clears pending load;
  ack-timeout resend-once then rollback.
- **Browser verification (mandatory):** replay today's exact repro on
  dev:obs — OPEN `___test-fiddle-project.prj.json` into a fresh session,
  deep-compare live state vs file (zero diffs), hard reload, deep-compare
  again (zero diffs), console clean, close tabs.

## Success criteria

The 2026-07-04 repro produces **zero** lost leaves through OPEN + reload;
full gate green (`npm run -w @fiddle/client typecheck && npm run -w
@fiddle/client test -- --run` plus server/shared suites).
