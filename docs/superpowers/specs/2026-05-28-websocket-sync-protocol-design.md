# WebSocket Sync Protocol Design

**Date:** 2026-05-28
**Branch (planned):** TBD (named when the implementation plan is written)
**Base:** `main` at the most recent merge commit (`b6ccb0a` at time of writing)

## Goal

Define the **wire protocol and runtime contract** for synchronizing project state between 2+ browsers in the same room over WebSockets, so that a future implementation has an unambiguous target. Audio rendering stays local in each browser; only `Project` mutations cross the wire.

This spec is **protocol design only**. It defines message shapes, connection lifecycle, server-authoritative ordering, optimistic-UI semantics, and the responsibilities split between client and server. It does **not** define the production deploy (`render.yaml`, Redis provisioning, etc.) or the concrete client integration code — those land in the implementation plan.

## Context

The [[backend-scaffolding]] work landed a Fastify + `@fastify/websocket` skeleton at `packages/server/` with a placeholder `/ws` route that emits `{ type: "hello" }` and ignores incoming messages. The placeholder is the seam this protocol fills.

The user has fixed these constraints:

- **Audio local, state synced** — each peer renders sound from its own local engines. Only `Project` mutations are transmitted.
- **No auth** — rooms are accessed by URL alone (security by unguessability).
- **Anonymous identity** — server-issued, ephemeral per tab session.
- **Test with 2 users, design for many rooms** — Phase 1 ships a single Fastify process with in-memory rooms; Phase 2 swaps in Redis-backed `RoomStore` + Pub/Sub for multi-instance fanout. The wire protocol does not change between phases.

The project's existing watcher pipeline (§6 of `docs/ARCHITECTURE.md`) already produces path-addressed sparse diffs (`diffParams(old, new)` → `engine.applyParams(changed)`). This design exploits that: the unit on the wire is the same per-field diff the watcher already emits.

## Non-goals

- **CRDTs.** Per-field last-writer-wins by server-receive order is sufficient for the kinds of edits in this app (mostly scalar knob values; step cells are infrequent and conflicts are rare). CRDTs add binary encoding, harder debugging, and a real dependency. We will reach for them only if LWW visibly fails in practice.
- **A message broker.** Redis Pub/Sub (Phase 2) covers cross-process fanout. NATS/Kafka is only relevant at much higher scale; not part of this design.
- **Persistent user identity.** No accounts, no `localStorage`-stickied identity. Identity is purely a transport concept, lasting for one tab session.
- **Op batching in one frame.** Single op per WS frame in Phase 1. A `batch` envelope can be added later if profiling shows it's a win; the message catalog leaves room for it.
- **Authoritative project history.** The server's ring buffer is for reconnect catch-up, not undo/redo. Per-client undo is local to the client (out of scope here).

## Architecture overview

```
                    Browser A                              Browser B
  ┌────────────────────────────────────┐      ┌────────────────────────────────────┐
  │ Vue UI                              │      │ Vue UI                              │
  │   │ v-model                         │      │   │                                 │
  │   ▼                                 │      │   ▼                                 │
  │ project (Vue reactive)              │      │ project (Vue reactive)              │
  │   │ existing per-slice watcher      │      │                                     │
  │   ▼                                 │      │   ▲                                 │
  │ diff {path, value}                  │      │ applyOp (deep-set by path)          │
  │   │                                 │      │                                     │
  │   ▼                                 │      │                                     │
  │ Outbox (throttle 50ms,              │      │                                     │
  │         path-keyed coalesce,        │      │                                     │
  │         stores priorValue)          │      │                                     │
  │   │                                 │      │                                     │
  │   ▼                                 │      │                                     │
  │ WS client (sessionStorage clientId) │      │ WS client                           │
  └────────────┬───────────────────────┘      └────────────┬───────────────────────┘
               │                                            │
               │             WebSocket (JSON, /ws/{roomId}) │
               └──────────────┬────────────┬───────────────┘
                              ▼            ▼
                ┌────────────────────────────────────────┐
                │ Fastify server (Phase 1: single proc)  │
                │   ┌────────────────────────────────┐   │
                │   │ Room (per roomId)              │   │
                │   │   • connected sockets (≤4)     │   │
                │   │   • project (current snapshot) │   │
                │   │   • opLog (ring buffer 1000)   │   │
                │   │   • nextOpId, schemaVersion    │   │
                │   │   • identity assignments       │   │
                │   └────────────────────────────────┘   │
                │             ▲                          │
                │             │ RoomStore interface      │
                │   ┌─────────┴──────────┐               │
                │   │ InMemoryRoomStore  │ ← Phase 1     │
                │   └────────────────────┘               │
                │   ┌────────────────────┐               │
                │   │ RedisRoomStore     │ ← Phase 2     │
                │   └────────────────────┘               │
                └────────────────────────────────────────┘
```

**Key invariant:** the server is the authority for **ordering**. Two clients editing the same field at the same time both see the same final value — whichever the server processed second. Clients optimistically apply their own ops locally for zero-latency feel, then reconcile against the server's echo.

## The envelope

Every message — every direction — shares this minimal envelope:

```ts
interface Envelope {
  v: 1;           // PROTOCOL_VERSION (NOT PROJECT_SCHEMA_VERSION — see §"Schema versions")
  type: string;   // discriminator for the message kind
  // ... type-specific fields
}
```

**Two version numbers, distinct on purpose:**

- **`v`** (in this envelope) is the **protocol version** — increments only when the message catalog itself changes incompatibly (e.g. a field is renamed, an op flow changes). Starts at `1`.
- **`schemaVersion`** (sent in `hello` / `welcome`) is the **project schema version**, identical to `PROJECT_SCHEMA_VERSION` in `@fiddle/shared`. Increments when the `Project` shape changes. Server rejects clients with mismatched `schemaVersion` because their paths/values may not match the server's expected shape.

Both numbers start at `1` and increment independently. The split exists so a protocol-only change (e.g. adding a new message type) doesn't force every client to re-migrate their saved projects, and a project-only change (e.g. adding a new knob) doesn't bump the protocol.

## Connection lifecycle

### URL routing

Client connects to `wss://<server>/ws/{roomId}` where `roomId` is an 8-10 char [Crockford Base32](https://www.crockford.com/base32.html) string (e.g. `j7k2mq8n`). The server reads `roomId` from the URL path.

**RoomId origin:** the client generates a fresh `roomId` if the page URL is bare (no `/r/{roomId}` path), then `history.replaceState`s the URL so the room is shareable by copying the address. If the URL already carries a `roomId`, the client uses it verbatim.

**Auto-create:** the server does not distinguish "create room" from "join room." A `hello` for an unknown `roomId` causes the server to instantiate a fresh `Room` with `project = freshProject()` and `nextOpId = 0`. The first client to connect is the de-facto creator with no special privileges.

**Required `@fiddle/shared` expansion (precondition for this work):** the server needs `freshProject()` to construct a default `Project` for newly created rooms, and a Zod schema mirroring `Project` for path/value validation. Today, `freshProject()` lives at `packages/client/src/project/factory.ts` and depends on `*EngineParams` types + `EngineClass.DEFAULT_PARAMS` constants spread across the engine files. As a precondition for this design's implementation, those must move:

- Each engine's `*EngineParams` interface and its `DEFAULT_PARAMS` constant relocate from the engine class to `@fiddle/shared`. The engine classes import them back (the engine class itself stays client-side; only the static-data types and default constants move).
- `freshProject` / `freshTrack` / `freshStep` factories move to `@fiddle/shared`.
- The Zod schema for `Project` is colocated in `@fiddle/shared` alongside the types, so client and server compile against the exact same schema.

This is a refactor task in the implementation plan, not part of the protocol design.

### Hello / welcome (fresh join)

```
CLIENT → SERVER:
{
  v: 1,
  type: "hello",
  schemaVersion: 1
  // (no clientId — fresh tab session)
  // (no resumeFromOpId — fresh join)
}

SERVER → CLIENT:
{
  v: 1,
  type: "welcome",
  clientId: "c_a3f9",        // server-assigned, sticky for this tab session
  color: "#7CFC00",          // assigned from palette (see §Presence)
  handle: "Owl",             // assigned from animal list
  opIdHead: 482,             // most recent opId in the room's log
  schemaVersion: 1,          // server's PROJECT_SCHEMA_VERSION (must match client's)
  roster: [                  // current room population, including self
    { clientId: "c_a3f9", color: "#7CFC00", handle: "Owl" },
    { clientId: "c_b2e1", color: "#FF8C00", handle: "Fox"  }
  ]
}

SERVER → CLIENT (snapshot for fresh join):
{
  v: 1,
  type: "snapshot",
  opId: 482,                 // matches welcome.opIdHead
  project: { /* full Project JSON */ }
}

SERVER → CLIENT:
{
  v: 1,
  type: "sync.complete",
  opId: 482
}

SERVER → ALL OTHER CLIENTS (presence update):
{
  v: 1,
  type: "presence.update",
  roster: [
    { clientId: "c_a3f9", color: "#7CFC00", handle: "Owl" },
    { clientId: "c_b2e1", color: "#FF8C00", handle: "Fox"  }
  ]
}
```

**Client behavior during catch-up:**
- After receiving `welcome`, the client is in `catching-up` state.
- Inbound `snapshot` is applied wholesale: the local `project` is replaced via `replaceProject(target, source)` (the existing helper at `packages/client/src/project/storage.ts`), preserving the Vue reactive proxy identity.
- Any inbound op messages with `opId > opIdHead` arriving during catch-up are **queued**, not applied immediately, so apply-order remains monotonic.
- `sync.complete` flips client to `live` state. The queued ops are then applied in `opId` order. From this point the client may emit its own ops.

### Hello / welcome (resume after blip)

```
CLIENT → SERVER:
{
  v: 1,
  type: "hello",
  schemaVersion: 1,
  clientId: "c_a3f9",        // recovered from sessionStorage
  resumeFromOpId: 478        // last opId the client successfully applied
}

SERVER → CLIENT:
{
  v: 1,
  type: "welcome",
  clientId: "c_a3f9",        // confirmed, unchanged
  color: "#7CFC00",
  handle: "Owl",
  opIdHead: 482,
  schemaVersion: 1,
  roster: [...]
}

SERVER → CLIENT (replay, if gap is within ring buffer):
{ v:1, type:"set", opId:479, clientId:"c_b2e1", path:[...], value:... }
{ v:1, type:"set", opId:480, clientId:"c_b2e1", path:[...], value:... }
{ v:1, type:"set", opId:481, clientId:"c_a3f9", clientSeq:42, path:[...], value:... }
{ v:1, type:"set", opId:482, clientId:"c_b2e1", path:[...], value:... }

SERVER → CLIENT:
{ v:1, type:"sync.complete", opId:482 }
```

**Resume eligibility check:** server checks `resumeFromOpId` against its ring buffer.
- If `resumeFromOpId + 1` is still in the buffer (and the buffer is contiguous up to `opIdHead`), server replays `[resumeFromOpId+1 .. opIdHead]` as individual op messages.
- If the gap is too large (`opIdHead - resumeFromOpId > 1000`), or the buffer has been GC'd since the disconnect, server falls back to sending a `snapshot` (same shape as fresh-join catch-up).
- If `resumeFromOpId > opIdHead` (client claims to have applied ops the server doesn't know about — should be impossible but defensive), server sends a `snapshot` and emits a non-fatal `error` with `code:"resume.client_ahead"`.

**Identity on resume:**
- If `clientId` is recognized **and** the client's previous session is still in the room's identity table (within the 5-min grace), the same `color` and `handle` are reissued.
- If `clientId` is unknown to the server (e.g. server restart, GC'd), server reissues fresh identity and emits `error` with `code:"resume.unknown_client"` and `fatal:false` — just informational.

### Identity sticky-store

Client stores `{ clientId, roomId, opIdLastSeen }` in `sessionStorage` under key `fiddle:sync:{roomId}`, updated on every applied op. On tab close, sessionStorage drops it. A fresh tab opening the same room URL = a fresh client. Different rooms in different tabs = independent identities.

## Mutation ops

Every project mutation rides as a `set` op:

```
CLIENT → SERVER:
{
  v: 1,
  type: "set",
  clientSeq: 17,             // client-stamped monotonic counter, per-connection
  path: ["tracks", 0, "engines", "synth", "filterCutoff"],
  value: 800
}

SERVER → ALL CLIENTS (broadcast, including originator):
{
  v: 1,
  type: "set",
  opId: 483,                 // server-stamped, monotonic per-room
  clientId: "c_a3f9",        // originator
  clientSeq: 17,             // echoed for originator's outbox
  path: ["tracks", 0, "engines", "synth", "filterCutoff"],
  value: 800
}
```

**Path format:** array of strings/numbers. Numbers address array indices (`tracks[0]`, `steps[4]`); strings address object keys. Mirrors the structure of `Project` so a generic deep-set is a 5-line function.

**`value` type:** any JSON value (number, string, boolean, null, object, array). The accept-list (see §"Server-side responsibilities") constrains what's actually allowed.

**`clientSeq` lifetime:** monotonic per `(roomId, clientId)` pair, persisted in sessionStorage alongside `clientId` and `opIdLastSeen`. On reconnect with the same `clientId`, the counter continues from where it left off, so the server's `(clientId, clientSeq)` deduplication remains correct across blips. A fresh tab session starts at `clientSeq = 0`.

**Originator correlation:**
- Client outbox maps `clientSeq → { op, priorValue, timer }`.
- When server's broadcast echo arrives, client matches by `clientSeq`, clears the outbox entry, and applies the op to local state (idempotent — local value already matches if optimistic).
- If a `nack` arrives with the same `clientSeq` instead, client reverts using `priorValue`.

**Step cell example (no special op needed):**
```
{ v:1, type:"set", clientSeq:18, path:["tracks", 1, "steps", 4, "velocity"], value:0.85 }
{ v:1, type:"set", clientSeq:19, path:["tracks", 1, "steps", 4, "mute"], value:false }
```

The path-based design means a multi-field step edit is two ops, not one. This is intentional — Phase 1 keeps the op shape uniform. If profiling shows step toggles are bandwidth-relevant, a future `patch` op can carry multiple field writes for one path prefix.

### Throttle and coalesce policy

The client outbox layer between the watcher and the WS enforces:

| Gesture type | Behavior |
|---|---|
| **Continuous knob/slider drag** (in-flight, `mousedown` until `mouseup`) | Throttle to **50 ms per path** — drop intermediate values to the same path within the window, keep the latest. |
| **Gesture end** (`mouseup`, `blur`, key-release on knob) | Always emit, immediately, bypassing throttle. Guarantees the resting value lands exactly. |
| **Discrete action** (step toggle, engine swap, preset apply, button-click BPM nudge) | Emit immediately, no throttle. |
| **Offline outbox** (disconnected with pending ops) | Coalesce by path — multiple writes to the same path while offline collapse to the last one. |

Implementation: a `Map<pathKey, { op, priorValue, timer }>` keyed on `JSON.stringify(path)`. `pathKey` is the dedupe identity for throttling and coalescing.

**Why 50 ms:** 20 ops/sec per active drag is more than enough for the receiving client to render visible knob motion smoothly. Halves the bandwidth vs the 25-30 ms I'd been considering earlier, with no perceptible smoothness loss.

## Errors

### `nack` — op-scoped reject

```
SERVER → CLIENT (originator only):
{
  v: 1,
  type: "nack",
  clientSeq: 17,             // echoes the rejected op
  code: "path.invalid",      // small enum, see below
  message: "path tracks.0.engineType is not client-writable",
  details: { /* optional, code-specific */ }
}
```

**Code enum (extensible):**

| Code | When it fires |
|---|---|
| `path.invalid` | Path doesn't exist in `Project` schema, or not in the writable accept-list |
| `value.invalid` | Wrong type, NaN/Infinity, out of declared range, fails Zod validation |
| `rate.limited` | Client exceeded per-client op-rate cap (Phase 1: 100 ops/sec/client) |
| `op.duplicate` | `(clientId, clientSeq)` already in the room's op log — server does not re-broadcast or re-append; nack is informational for the client (safe to ignore — the broadcast for this op already happened in a previous round-trip) |

**Server behavior:** rejected ops are **not** broadcast. Only the originator gets a `nack`. The op log is untouched.

**Client behavior:** look up `clientSeq` in outbox, retrieve `priorValue`, write `priorValue` back into local `project` (suppressing the outbound that the next watcher tick would otherwise generate via a one-tick guard flag), clear the outbox entry.

### `error` — connection-scoped

```
SERVER → CLIENT (just this client):
{
  v: 1,
  type: "error",
  code: "schema.version_mismatch",
  message: "server is on schema v2, client sent v1",
  fatal: true                // if true, server is about to close the socket
}
```

**Code enum:**

| Code | When | `fatal` |
|---|---|---|
| `schema.version_mismatch` | `hello.schemaVersion` ≠ server's `PROJECT_SCHEMA_VERSION` | `true` |
| `protocol.version_mismatch` | `hello.v` ≠ server's protocol version | `true` |
| `hello.invalid` | Missing or malformed required `hello` fields | `true` |
| `room.full` | Room at cap (4 clients) | `true` |
| `resume.unknown_client` | `resumeFromOpId` provided but `clientId` not in server's identity table; server has reissued fresh identity in the `welcome` | `false` |
| `resume.client_ahead` | `resumeFromOpId > opIdHead` (defensive); server has sent a fresh `snapshot` | `false` |
| `overloaded` | Server backpressure; client should back off and retry | `false` |
| `internal` | Catch-all for server bugs | varies |

**Client behavior on fatal:** show a user-facing message ("Disconnected — your client may be out of date" / "This room is full — try later"), do **not** auto-reconnect for `schema.version_mismatch` (a reconnect won't help). For `room.full`, route to a "room is full" screen and offer the user a button to create a new room.

**Client behavior on non-fatal:** log to console (and to telemetry once we have any), continue normally. `resume.unknown_client` and `resume.client_ahead` always arrive **alongside** a snapshot that fixes the situation; the `error` is informational.

## Presence

Identity assignment (Tier B from the brainstorm):

- **Color** assigned from a fixed 8-color palette: `["#FF4136", "#FF851B", "#FFDC00", "#2ECC40", "#39CCCC", "#0074D9", "#B10DC9", "#F012BE"]`. Server picks the first color not currently in use by any connected client in this room.
- **Handle** assigned from a fixed list of ~20 short animal names: `["Owl", "Fox", "Otter", "Lynx", "Hawk", "Mole", "Frog", "Wren", "Toad", "Bat", ...]`. Server picks the first not in use in this room.
- Both are assigned in `welcome` and never change for the life of the session (or, on resume within grace, are reissued unchanged).
- After 8 colors are taken (impossible at cap=4 but defensive), wrap with hashing. After 20 handles are taken, append a digit (`Owl2`).

### Roster broadcasts

Server emits `presence.update` to every client in the room on:
- A new client successfully joining (after their `sync.complete`).
- A client disconnecting (including post-grace cleanup).
- (No other triggers — handle/color are stable for the session.)

```
SERVER → ALL:
{
  v: 1,
  type: "presence.update",
  roster: [
    { clientId: "c_a3f9", color: "#7CFC00", handle: "Owl" },
    { clientId: "c_b2e1", color: "#FF8C00", handle: "Fox" }
  ]
}
```

### Implicit activity highlight

No dedicated "I am touching X" messages. Each `set` broadcast already carries `clientId`. The client UI maintains a `Map<pathKey, { clientId, expiresAt }>` of "last touched by whom"; UI elements check this map on render and apply a fading colored ring (~500ms) when their path was last written by a non-self client. This is purely a render-side concern — no protocol cost.

## Heartbeat

```
SERVER → CLIENT (every 30 s):
{ v: 1, type: "ping" }

CLIENT → SERVER (immediate):
{ v: 1, type: "pong" }
```

Server tracks `lastPongAt` per socket. If no `pong` within **60 s** of the last `ping`, server terminates the socket (the client will hit the close handler and start the resume flow on its next reconnect). This catches half-open TCP states that the OS-level keepalive misses.

Client side: if no inbound message (any type) for 45 s, client treats the socket as suspect and forces a reconnect.

## Server-side responsibilities

### `RoomStore` interface

All room-mutating logic goes through this interface. Phase 1 backs it with an in-memory `Map`; Phase 2 backs it with Redis. The protocol seen by clients is identical.

```ts
// in packages/server/src/room/RoomStore.ts (Phase 1 sketch — not full impl)
export interface RoomStore {
  // Get the current room state. Auto-creates if the room is unknown.
  getOrCreate(roomId: string): Promise<RoomState>;

  // Append an op to the log, assign opId, update project snapshot atomically.
  // Returns the assigned opId.
  appendOp(roomId: string, op: Op): Promise<number>;

  // Fetch ops in [fromOpId+1 .. headOpId] inclusive. Returns null if any
  // op in that range has been GC'd (caller falls back to snapshot).
  getOpsSince(roomId: string, fromOpId: number): Promise<Op[] | null>;

  // Identity table per session.
  registerClient(roomId: string, clientId: string, identity: Identity, ttlMs: number): Promise<void>;
  resolveClient(roomId: string, clientId: string): Promise<Identity | null>;

  // GC.
  pruneRoom(roomId: string): Promise<void>;  // called after grace expires with 0 connections
}
```

Phase 1 `InMemoryRoomStore` is ~150 lines. Phase 2 `RedisRoomStore` is a straightforward port (Redis Hashes for project + identity tables, Redis Streams for the op log with XADD/XRANGE, Pub/Sub for cross-process fanout). Switching is one flag.

### Op validation (server-side)

Two checks, in order:

1. **Path is in the writable accept-list.** A static array in `@fiddle/shared` enumerates writable path prefixes:
   - `bpm` — root scalar
   - `tracks.*.engineType` — engine swap on a track
   - `tracks.*.engines.{synth|kick|hat|snare|clap}.*` — any engine param, scoped to its slice
   - `tracks.*.steps.*.{note|octave|length|velocity|mute|chordType}` — any step cell field
   - `tracks.*.mixer.{volume|muted|soloed}` — track mixer

   Wildcards (`*`) expand to any index/key matching the next segment's expected type. Paths outside this list reject with `nack:path.invalid`. Explicitly **excluded** (server-only): `schemaVersion`, and the future `Project` envelope fields if any are added later.

2. **Value matches the schema for that path.** A Zod tree mirrors `Project` (also lives in `@fiddle/shared` so client and server agree). After path-walk, the leaf's Zod schema runs `safeParse(value)`. Failures reject with `nack:value.invalid` and the Zod error message in `details`.

Both validations are **synchronous in-memory** — no DB roundtrips. Phase 1 cost is microseconds per op. The accept-list and Zod tree are the source of truth for "what's syncable" and live in `@fiddle/shared` so they version with the project schema.

### Rate limiting

Per-client cap: **100 ops/sec sustained, burst 200**. Token bucket per `clientId`, replenished every 10 ms. Violations reject with `nack:rate.limited`. The client's outbox throttle (50 ms per path) keeps a single user well below this even with both hands on knobs; the cap exists as a defensive bound.

### Room GC

- A room is **live** while ≥1 client is connected.
- On the last client's disconnect, the room enters **grace** for **5 minutes** (timer in the `RoomStore`).
- If a client reconnects during grace, the timer is cancelled and the room becomes live again.
- After grace expires with no connections, `pruneRoom(roomId)` is called and the room's in-memory state is freed. The roomId itself remains valid — a future `hello` for the same `roomId` will create a fresh empty room. (We do **not** keep a "this roomId was previously used" record. URL collision is theoretically possible but extraordinarily unlikely at the entropy of 8-10 base32 chars.)

### Logging

Server logs (via pino, already wired in Phase 1) every:
- `welcome` issuance (clientId, roomId, isResume)
- `nack` and `error` emission (full code + message)
- Room create/destroy

Per-op logging is **off by default** — too noisy at 100 ops/sec. A `DEBUG_OPS=1` env flag enables it for troubleshooting.

## Client-side responsibilities

### Outbox layer

A new file `packages/client/src/sync/Outbox.ts` (proposed location) wraps the existing per-slice watchers. The watcher continues to compute path-keyed diffs but writes them through the Outbox rather than directly to the local engine (the local engine apply remains, but as part of the optimistic-UI step described below).

Outbox API sketch:

```ts
interface OutboxEntry {
  clientSeq: number;
  op: SetOp;
  priorValue: unknown;       // for rollback on nack
  timer: number | null;      // throttle timer; null after first flush
}

class Outbox {
  enqueue(path: PathSegment[], value: unknown, priorValue: unknown, opts: { gestureEnd: boolean }): void;
  onEcho(clientSeq: number): void;   // server confirmed our op
  onNack(clientSeq: number, code: string): void;  // server rejected; we roll back
  flushAllImmediate(): void;         // called on disconnect/reconnect
}
```

### Optimistic UI

1. User turns knob → Vue write to `project.tracks[i].engines.synth.filterCutoff`.
2. Watcher fires, computes diff `{path, value, priorValue}`.
3. Watcher calls `outbox.enqueue(path, value, priorValue, { gestureEnd: false })`.
4. **In parallel**, the existing local apply path runs: `engine.applyParams({ filterCutoff: value })`. The user hears the change instantly.
5. Outbox throttles, eventually emits `{type:"set", clientSeq, path, value}` to the WS.
6. Server validates, appends to log, broadcasts.
7. Client receives echo, matches `clientSeq`, clears outbox entry. Local state already matches; no re-apply needed.

If step 6 returns `nack` instead: client looks up `priorValue`, writes it back via the same Vue write path (with a one-tick guard to suppress the watcher from re-emitting), audibly reverting the change.

### Inbound op apply (remote ops)

When the client receives a `set` for an `opId > lastAppliedOpId` from another client (`broadcast.clientId !== self.clientId`):
1. Apply via Vue write — `setPath(project, path, value)`. This triggers the existing per-slice watcher.
2. The watcher's diff routine sees the change and naturally writes through to the engine via `applyParams`.
3. **Do not** emit an outbound op for this — the watcher needs a "suppress outbound" flag set during inbound apply. Implementation: a module-scope `let applyingFromNetwork = false`, set/cleared around the apply call. Watcher checks the flag and skips outbox.enqueue.

This means the existing watcher → engine pipeline is **reused unchanged** for both local and remote ops. The new layer (`Outbox`) only intercepts the outbound side.

### Self-ops vs others (echoes)

When the server echoes our own op back (`broadcast.clientId === self.clientId`):
- Find the outbox entry by `clientSeq`, clear it.
- The local value already matches (we applied optimistically in step 4 above), so no re-apply is needed.
- **Exception:** if our local value has since been overwritten by a later remote op for the same path, the echo of the older self-op is stale. We use `opId` ordering to drop it. (Concrete check: maintain `lastAppliedOpIdForPath: Map<pathKey, opId>`. Reject any apply for a path whose `op.opId <` the map entry.)

### Connection state machine

```
            ┌─────────────────────────────────────────────────────────┐
            │                                                         │
            ▼                                                         │
        ┌────────┐  open + send hello  ┌─────────┐  welcome  ┌──────────────┐
        │ closed │─────────────────────│ opening │───────────│ catching-up  │
        └────────┘                     └─────────┘           └──────────────┘
            ▲                                                       │
            │                                                       │ snapshot/replay
            │ socket close, schedule reconnect                      │ + sync.complete
            │ (exponential backoff: 1s, 2s, 4s, max 30s)            │
            │                                                       ▼
            │  fatal error                                    ┌────────────┐
            └─────────────────────────────────────────────────│    live    │
                                                              └────────────┘
                                                                    │
                                                                    │ socket close
                                                                    ▼
                                                              (back to closed)
```

While in `catching-up`, **outbound ops are not transmitted** — they accumulate in the outbox. On flip to `live`, the outbox flushes in order. While in `closed`/`opening`, same — outbox accumulates, coalescing by path. This guarantees a knob ramp during a brief network blip doesn't replay 600 ops on reconnect; only the final value per path is sent.

## Phase 1 vs Phase 2

### Phase 1 (this design + initial implementation)

- Single Fastify process behind one Render web service.
- `InMemoryRoomStore`: `Map<string, RoomState>` in the Node process.
- opId is a per-room `number` counter, monotonic from 0.
- Op log is an in-memory ring buffer of capacity 1000 per room.
- Server restart = all rooms lost. Clients reconnect, get fresh empty rooms (their saved-to-localStorage `Project` is unaffected because audio + persistence are local — they can re-open their `.prj.json` if they want to seed the new room).
- One process serves all rooms. Capacity envelope: ~hundreds of concurrent rooms, ~thousands of WS connections. Far past the 2-user testing target.

### Phase 2 (when traffic warrants)

- Multi-instance behind a load balancer (Render auto-scaling or fly.io equivalent).
- `RedisRoomStore`:
  - Redis **Hash** for room project snapshot + room metadata.
  - Redis **Stream** (`XADD`/`XRANGE`/`XLEN`) for the op log; trimmed to 1000 entries via `MAXLEN ~ 1000`.
  - Redis **Hash** for identity table per room (`HSET <room>:identity <clientId> <json>`), with `EXPIRE` on the key for grace TTL.
  - Redis **Pub/Sub** channel per room for cross-process broadcast: when server A appends an op, it publishes to `room:{roomId}`; server B's subscriber forwards to its connected sockets in that room.
- Op IDs become Redis Stream entry IDs (`ms-seq`), which are monotonic per stream — the protocol's `opId: number` field becomes a string in Phase 2 only if we choose to expose stream IDs raw. **Recommended:** keep `opId: number` and synthesize from `XLEN` / `XADD` returned IDs, so the client-visible protocol is identical across phases.
- Server restart survives: rooms persist as long as Redis does.

The phase boundary is a configuration toggle + a `RedisRoomStore` implementation. **No protocol change. No client change.** This is the load-bearing payoff of the `RoomStore` abstraction.

### When to flip

Triggers, any of which would prompt the Phase 2 work:

- Server restarts visibly disrupt active rooms (operationally noticeable).
- Need to deploy >1 server instance (single instance hits CPU or memory limit).
- A user explicitly asks "can I make my room survive a deploy?" (would also be satisfied by Phase 2).

None of these is on the near horizon for 2-user testing. Phase 1 ships first.

## Out of scope (now)

- **Authentication / accounts.** Anonymous + URL-based access is the model. Add later if needed.
- **Persistence across server restart (Phase 1).** Locally, users still have `localStorage` autosave + project file Save/Open. Future Phase 2 gets this for free.
- **Cursor positions / pointer tracking.** Not a knob-based UI primitive.
- **Voice/text chat.** Out of scope. Suggest external (Discord etc.) for now.
- **Mobile support for collab.** The synth itself doesn't have a mobile UI yet; collab can ride that work whenever it happens.
- **Server-side undo/redo history beyond ring buffer.** Per-client undo is local (and itself out of scope for this design — there's no client undo yet either).
- **Tracking changes by user for posterity.** No audit log beyond pino server logs.

## Open questions / future work

1. **What if both users want to play simultaneously?** Today `Sequencer` is local and `isPlaying` is not synced. Open question: should `isPlaying`, the current step position, and `bpm` changes mid-playback be synced? `bpm` is easy (just another path). `isPlaying` + transport sync is genuinely tricky because audio latency between two clients makes "in sync" hard — they're not even running the same `AudioContext.currentTime`. Probably defer to a Phase 1.5 once we have ears on the basic protocol.
2. **Sound preview when remote user is editing.** If Owl turns the filter cutoff, does Fox's audio change too? In the current design, **yes** — because Fox applies the op locally, and Fox's engine is running. This is the "everyone hears everyone's changes" behavior, which I think is what we want, but worth verifying once playable.
3. **Undo/redo (local) interaction with remote ops.** Future client-side undo needs to skip ops authored by other users (or it'd un-do their changes from your local history). Not protocol-affecting; flagged for the undo design when it lands.
4. **Tier C presence (Figma-style "X is touching Y").** Cheap to add later as a separate non-logged channel. Wait for user feedback before designing.
5. **Schema migrations during a live session.** If schema bumps from v1 to v2 and one client connects with v1 while v2 clients are live, do we eject the v1 client (current design — `schema.version_mismatch` with `fatal:true`) or migrate their hello? Current answer: eject. Force-refresh is acceptable for now.

---

*Companion future docs to write: the implementation plan (after user reviews this spec), and an update to `docs/ARCHITECTURE.md` §14 (currently has placeholder language) once the protocol lands.*
