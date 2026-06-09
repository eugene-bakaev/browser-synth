# Code Review: Fiddle Synth — full-codebase pass

**Review date:** 2026-06-09 — Claude (Fable 5)
**Baseline reviewed:** `main` at `f47a9d3` (guaranteed local delivery + non-destructive convergence)
**Scope:** Full pass over all three workspaces with four lenses: code effectiveness,
code simplicity, alignment with the canonical docs, and memory/connection handling.
**Gate at review time:** green — typecheck clean across workspaces; unit tests passing
(client + 131 server + 91 shared).

This complements [`CODE_REVIEW.md`](./CODE_REVIEW.md) (the 2026-05-23 review, whose
findings were spot-checked and remain resolved as recorded). Findings here are new.
Status column is for tracking as items get picked up.

---

## Severity legend

- 🟥 **Critical** — broken user-visible feature or data loss likely to be noticed
- 🟧 **High** — correctness bug, data-loss path, or significant resource waste
- 🟨 **Medium** — real but bounded impact; fix when in the area or schedule deliberately
- 🟦 **Low** — nit, hardening, or cheap-to-close edge case

## Findings index

| # | Sev | Lens | Title | Status |
|---|-----|------|-------|--------|
| [M1](#m1) | 🟧 | Connections | Guest session row deleted 5 min before its in-memory room dies | open |
| [E1](#e1) | 🟧 | Effectiveness | Audio graph builds all 32 pool slots → ~190 always-running oscillators | fixed on `perf/e1-lazy-audio-graph` |
| [D1](#d1) | 🟨 | Docs | ARCHITECTURE.md materially lags the code (last updated 2026-05-31) | open |
| [M2](#m2) | 🟨 | Sync correctness | Self-echo overwrites a newer local value mid-drag under latency | open |
| [S1](#s1) | 🟨 | Simplicity | localStorage project path is vestigial and now misleading | open |
| [E2](#e2) | 🟨 | Effectiveness | `appendOp` dedup linear-scans the 1000-op ring buffer per inbound op | open |
| [M3a](#m3a) | 🟦 | Connections | Grace-expiry vs. hello race can recreate a room blank | open |
| [M3b](#m3b) | 🟦 | Connections | Duplicated browser tab → two sockets resume one clientId | open |
| [M4](#m4) | 🟦 | Connections | `POST /api/sessions` unlimited; never-joined guest sessions never pruned | open |
| [D2](#d2) | 🟦 | Docs | Sync path never runs deep repair (the documented normalize split's open half) | open |
| [E3](#e3) | 🟦 | Effectiveness | sessionStorage read/parse/write per op during peer knob drags | open |
| [S2](#s2) | 🟦 | Simplicity | Knob drag listeners not removed on unmount | open |
| [B1](#b1) | 🟦 | Docs | Stale BACKLOG entry (empty-snapshot clobber) overtaken by session-scoped rooms | open |

**Suggested priority order:** M1 → E1 → D1 → M2 → S1 → the rest opportunistically.
Rationale: M1 is silent user data loss; E1 taxes every user on every PLAY; D1 makes
every future change against stale docs riskier; M2 is user-visible under real WAN
latency; S1 is a confusing data path that can also surprise users.

---

<a id="m1"></a>
## 🟧 M1 — Guest session row deleted 5 minutes before its in-memory room dies

**Lens:** memory & connections (data loss). **Area:** `packages/server/src/routes/ws.ts`,
`packages/server/src/session/SessionSync.ts`, `packages/server/src/sync/ConnectionHandler.ts`.

Two cleanup mechanisms disagree about when a guest room is "over":

1. When the **last socket closes**, `ws.ts:99` fires
   `sessionSync.handleDisconnect(roomId, roomNowEmpty=true)`, which — after the flush —
   **deletes the guest session row immediately** (`SessionSync.ts:68-76`,
   "guest rooms are unreachable once empty"). The snapshot cascades away with it.
2. Simultaneously, `ConnectionHandler.onClose` (`ConnectionHandler.ts:221-227`) starts
   the **5-minute grace timer** (`GRACE_MS`) that keeps the in-memory room alive
   *precisely so a reconnect can resume it*.

So the premise of the prune ("unreachable once empty") is false for those 5 minutes: a
guest who refreshes the page (sessionStorage clientId survives, URL unchanged) rejoins
via the `alreadyLive` fast path in `handleHello` (`ConnectionHandler.ts:264` —
`peekProject` is non-null, so the session-existence check via `loadSession` is
**skipped**). From there:

- Every subsequent flush silently no-ops — `PostgresSessionStore.saveSnapshot`'s
  `insert … where exists` guard inserts nothing for a deleted session
  (`PostgresSessionStore.ts:85-99`) — **and `clearDirty` still clears the dirty flag**
  (`SessionSync.flushRoom`), so the room doesn't even stay dirty for retry. All edits
  made after the rejoin are unpersistable.
- At grace expiry (or a server restart/deploy), the in-memory room is pruned and the
  work is gone.
- The studio's session-settings panel (`GET /api/sessions/:id`) 404s for the rejoined
  guest.

**Why it matters:** this is silent data loss in the exact window the grace timer exists
to protect. The user sees a working session; nothing tells them their edits stopped
persisting.

**Fix direction:** move the guest-session prune from `handleDisconnect` (socket close)
into the **grace-expiry callback** — the same place `pruneRoom` already runs
(`ConnectionHandler.onClose`'s `startGrace` callback). At expiry the room is truly
unreachable, so the original rationale holds. The flush-on-disconnect stays where it is.
Care points:
- The grace callback currently lives in `ConnectionHandler` and calls only
  `store.pruneRoom`; it needs access to `SessionSync` (or a callback injected through
  the route deps) to also prune the durable row.
- Keep the ordering *flush → prune* at expiry, and only prune when
  `record.ownerUserId === null` (same condition as today).
- Tests: a rejoin-within-grace e2e asserting the session row still exists and a flush
  after rejoin persists; an expiry test asserting row + snapshot are gone.

---

<a id="e1"></a>
## 🟧 E1 — Audio graph builds all 32 pool slots → ~190 always-running oscillators

**Lens:** effectiveness (CPU/memory). **Area:** `packages/client/src/composables/useSynth.ts`
(`buildAudioState`), `packages/client/src/engine/modules/Oscillator.ts`.

`buildAudioState` loops `syncTrackToEngine(i)` over the full `TRACK_POOL_SIZE = 32`
(`useSynth.ts:545-548`), regardless of `enabled`. Disabled slots default to
`engineType: 'synth'` (`shared/src/project/factory.ts:28`), and a fresh project has 28
of them. Each `SynthEngine` constructs 6 `SynthVoice`s; each voice has **two
`OscillatorModule`s whose native `OscillatorNode.start()` runs at construction and never
stops** (`Oscillator.ts:39-41` — documented as "always-on"), plus a pulse
`AudioWorkletNode`, a biquad filter, and a gain chain.

For a default project on first PLAY that means roughly:

- **192 always-running native oscillators** (32 engines × 6 voices × 1 connected osc)
- 192 biquad filters, ~1,500 gain nodes, 384 constructed `AudioWorkletNode`s
- 32 `AnalyserNode`s (fftSize 1024) created eagerly in the same loop
  (`useSynth.ts:493-504`)

…of which ~90% belongs to disabled slots that can only ever render silence. **A zero
gain does not stop a Web Audio subgraph from being processed** — every node in the
chain renders each 128-frame quantum. This is a constant audio-thread CPU tax on every
user for the whole session, plus a noticeable first-PLAY construction cost (the
worklet-node constructions alone are cross-thread).

**Fix direction:** build engines (and analysers) **only for enabled slots**, and make
the existing `enabled` audio watcher (`useSynth.ts:598-602`, currently just
`updateMixerGains`) construct/dispose engines on toggle:

- On enable: `engines[i] = engineFactories[type](ctx, trackGains[i])` + apply slice —
  the same code `syncTrackToEngine` already runs for a type swap.
- On disable: reuse the fade-then-`setTimeout`-dispose path from `syncTrackToEngine`
  (D4 semantics) so disabling a playing track doesn't click.
- Guard the sequencer tick and the per-slice watchers against `engines[i]` being
  undefined for disabled slots (tick already checks `track.enabled` first; the slice
  watchers check `engineType` but would need an `engines[i]` existence check).
- `disposeSynth` should iterate only constructed engines.
- Decide whether the per-track `AnalyserNode` should also be lazy (cheap win, same
  watcher).

Expected effect: default project drops from ~32 engines to 4 — ~88% fewer live audio
nodes — and first-PLAY latency shrinks proportionally.

---

<a id="d1"></a>
## 🟨 D1 — ARCHITECTURE.md materially lags the code

**Lens:** doc alignment. **Area:** `docs/ARCHITECTURE.md` (footer says last updated
2026-05-31; the durable-persistence pivot, lobby, sessions API, track pool, and
channel-rack UI all landed after).

What's wrong, by section:

- **§1 / §2 / §7:** still describe a **4-track, 16-step** app. The §7 scheduler sample
  shows `this.currentStep = (this.currentStep + 1) % 16`, contradicting the doc's own
  D15 (absolute monotonic counter — which is what `Sequencer.ts` implements).
  §2's tree says `Sequencer.ts # Lookahead scheduler, 4 × Track[16 × Step]`; the
  Sequencer no longer owns tracks at all (it takes `getBpm` + callback).
- **§8 (master chain):** shows a single shared `AnalyserNode` after `masterGain` read
  by Visualizer. The code has **per-track analysers** teeing off each trackGain and no
  master analyser (`useSynth.ts:493-504`, `trackAnalysers`).
- **§14 (backend):** ends at `InMemoryRoomStore`. Entirely undocumented:
  `SessionStore` / `PostgresSessionStore` / `InMemorySessionStore`, the `SessionSync`
  autosave sweep (60s dirty-room flush, version-gated `clearDirty`, flush-on-disconnect,
  guest prune), the `/api/sessions` lobby CRUD API + ownership rules, session-scoped
  room init ("auto-mint is gone" — `ConnectionHandler.ts:259`), `SESSION_LOAD_TIMEOUT_MS`
  / `HELLO_DEADLINE_MS`, the resync message, the otel layer, and `processSafetyNet`.
- **§16 (deployment):** claims "a restart/redeploy wipes rooms" (false — sessions are
  durable in Supabase; in-memory rooms reseed from snapshots) and "the server doesn't
  enforce origin" (the server now registers `@fastify/cors` with `resolveCorsOrigin()`,
  `server.ts:68` — needed for the `/api` routes).
- **Module map:** missing `server/src/{session,profile,auth,otel,db,scripts}` and the
  client's `views/`, `router/`, `auth/`, `dialogs/`; still references `RoomBar.vue`
  (now `Sidebar.vue` + views); test counts stale.
- **§13:** "auto-saved to localStorage on every change and restored on page load" is
  no longer the user-facing story (see S1).

**Fix direction:** one focused doc pass. Keep the Decisions appendix (it's accurate);
rewrite §1/§2 framing (32-slot pool, enabled flags, sessions), fix the §7 sample and §8
diagram, add a §14b for the durable session layer, and correct §16. Update the BACKLOG
per B1 while in there.

---

<a id="m2"></a>
## 🟨 M2 — Self-echo overwrites a newer local value mid-drag

**Lens:** sync correctness / UX under latency. **Area:**
`packages/client/src/sync/messageDispatch.ts:61-81`, `applyOp.ts`.

For a `set` broadcast that is the echo of our own op, the dispatcher calls
`deps.outbox.onEcho(msg.clientSeq)` and then **unconditionally** `applyOp(project, msg)`.
The comment assumes "local state already matches (optimistic UI)" — true for discrete
edits, false during a continuous drag: the echo carries the value from ~RTT ago, while
the local field has since advanced. `applyOp`'s per-path opId guard doesn't help (the
echo's opId is newer than anything recorded for that path), so `setDeep` writes the
**older** value over the **newer** one. The audio watcher (guard-free by design) applies
it to the engine too.

Effect: with realistic WAN latency (50–200ms), a dragged knob — and its sound — snaps
backward by ~RTT repeatedly during the drag, then corrects on the next 50ms throttle
flush. Invisible on localhost; visible in production.

**Fix direction:** in the `set` handler, when `msg.clientSeq != null` (own echo) and the
Outbox holds a **pending or in-flight entry for that path**, skip the `setDeep` (the
local value is newer by construction) while still running the bookkeeping
(`onEcho`, `recordOpIdSeen`, and the `lastAppliedOpIdForPath` advance). Needs a small
Outbox query API like `hasPendingForPath(path): boolean` (checks `pending` + `inFlight`,
and `offlineQueue` for completeness). Unit test: enqueue → flush → local edit → echo of
the flushed value → assert project keeps the newer value.

---

<a id="s1"></a>
## 🟨 S1 — localStorage project path is vestigial and now misleading

**Lens:** simplicity (and a latent user surprise). **Area:**
`packages/client/src/composables/useSynth.ts:42-43`,
`packages/client/src/project/storage.ts`.

At module init the client loads `fiddle:project` from localStorage into the reactive
`project` and installs the 500ms-debounced autosave. But the app is **session-only**
now: `connectToSession` wipes `project` with `freshProject()` before connecting
(`useSynth.ts:438`, deliberately, to prevent cross-session bleed), and the room snapshot
then replaces it. Consequences:

- Nothing ever renders the localStorage project (the lobby doesn't; the studio only
  shows session content), so `loadProject()` at boot is dead weight.
- Autosave persists **whatever room you last visited** into the "local project" key. A
  user who had pre-session solo work in localStorage has it silently overwritten the
  first time they join any session.
- The file-I/O save/open path (`file-io.ts`) shares the same serialization and still
  works, but its localStorage sibling no longer means what the docs say it means.

**Fix direction (decide, then small):** either (a) remove `loadProject`/`installAutoSave`
from the boot path entirely (file save/open remains the offline persistence story), or
(b) re-scope the key per session (`fiddle:project:<roomId>`) and treat it as a local
cache/backup of the last room state. (a) is simpler; (b) gives offline resilience. Doc
§13 updates ride along with D1.

---

<a id="e2"></a>
## 🟨 E2 — `appendOp` dedup linear-scans the ring buffer per inbound op

**Lens:** effectiveness. **Area:** `packages/server/src/room/InMemoryRoomStore.ts:41-49`.

Every accepted `set` scans up to `RING_BUFFER_CAPACITY = 1000` log entries looking for a
`(clientId, clientSeq)` duplicate. At the rate cap (100 ops/sec/client × 4 clients)
that's ~400k comparisons/sec on the hottest server path. The in-code comment correctly
notes it's tolerable at the current cap — this is not urgent — but the fix is also a
simplification: per-room `Map<clientId, Map<clientSeq, AppliedOp>>` mirror of the ring
buffer (pruned in the same splice), or — since each client's seqs are monotonic — track
`maxSeqSeen` per client plus the ring buffer for echo lookup. O(1) either way.

---

<a id="m3a"></a>
## 🟦 M3a — Grace-expiry vs. hello race can recreate a room blank

**Lens:** connections (race). **Area:**
`packages/server/src/sync/ConnectionHandler.ts:262-289`.

`handleHello` decides the seed by `peekProject` (`alreadyLive`), and only calls
`cancelGrace` **after** `getOrCreate`. If the grace timer fires inside that await
window, `pruneRoom` deletes the room between the peek and the `getOrCreate` — which
then recreates it with the default `freshProject` seed (the durable load was skipped
because `alreadyLive` was true). The client gets a blank room; for an **owned** session
the next dirty flush would overwrite the durable snapshot with that blank project.

Probability is tiny (the timer must fire inside a microtask-scale window after exactly
5 minutes), but the fix is one line of reordering: `await cancelGrace(roomId)` **before**
the `peekProject` check, so a live room can't be pruned mid-handshake. (A defensive
alternative: have `getOrCreate` accept "must already exist" semantics for the
alreadyLive path.)

---

<a id="m3b"></a>
## 🟦 M3b — Duplicated browser tab → two sockets resume one clientId

**Lens:** connections (identity). **Area:** `WsClient` sessionStorage persistence +
`ConnectionHandler.handleHello` guest-resume path.

`clientId`/`clientSeq` are persisted in sessionStorage to make "two tabs = two clients"
true — but **duplicating** a tab (Chrome right-click → Duplicate) copies sessionStorage.
Both tabs then connect presenting the same `clientId`; the server resumes the same
identity for both (no check that the clientId is already in the `connected` set). The
two tabs mint colliding `clientSeq`s, so the server's `(clientId, clientSeq)` dedup
treats tab B's distinct op as a duplicate of tab A's and **echoes A's op back as B's
confirmation** — B's edit is silently dropped and its optimistic state diverges. Also a
roster anomaly (one chip for two live sockets; first close removes it).

**Fix direction:** in the guest-resume branch, if `msg.clientId` is already in the room's
`connected` set, mint a fresh identity instead of resuming (the requester gets a
`resume.unknown_client`-style informational and new credentials via `welcome` — the
client already handles clientId change by resetting `clientSeq`).

---

<a id="m4"></a>
## 🟦 M4 — `POST /api/sessions` unlimited; never-joined guest sessions never pruned

**Lens:** connections / resource hygiene. **Area:**
`packages/server/src/routes/sessions.ts:60-92`, `SessionSync`.

Session creation has no rate limit and no per-owner cap; each create writes a session
row plus a full project snapshot (~hundreds of KB packed). The guest-session prune only
triggers on a **room-empty disconnect** — a session that is created and never joined
never produces that event, so it persists forever, accumulating in the DB and lobby.

**Fix direction:** (a) a cheap token bucket on the create route (per-IP or per-clientId);
(b) a periodic sweep (could ride the existing `SessionSync` interval at a lower cadence)
deleting guest sessions with `updated_at` older than N days that have no live room.
Note the moderation spec already plans to strengthen guest ownership — fold this in there
if that work is near.

---

<a id="d2"></a>
## 🟦 D2 — Sync path never runs deep repair (the normalize split's open half)

**Lens:** doc/code alignment (latent). **Area:** `packages/shared/src/project/normalize.ts:36-38`,
server `loadSession` → `unpackProject`, client snapshot apply.

`normalizeProject`'s contract comment scopes deep repair (step-buffer length, engine
params) to the client's `reconcileWithDefaults` — but the sync path (durable snapshot →
`unpackProject` → `normalizeProject` → wire → `replaceProject`) never runs it. A legacy
snapshot whose tracks carry 16-element `steps` arrays reaches clients short:
`replaceProject` iterates `j < 64` and `Object.assign(t.steps[j], undefined)` silently
no-ops, leaving whatever the local buffer held (fresh defaults after a session join, so
benign today — but the invariant "every track has 64 steps" is unenforced on this
boundary). Server-side, an op for `steps.40` against a 16-element in-memory array
creates a sparse array via `setDeep`.

This was already on the radar (recorded in working notes during the 2026-06-06 incident).
**Fix direction:** either extend `normalizeProject` to pad/truncate `steps` to 64 and
fill missing engine slices (it's the single boundary both paths share), or run a shared
deep-reconcile in `unpackProject`. Add a regression test with a legacy 16-step stored
snapshot.

---

<a id="e3"></a>
## 🟦 E3 — sessionStorage read/parse/write per op during peer knob drags

**Lens:** effectiveness (minor). **Area:** `packages/client/src/sync/WsClient.ts`
(`getPersisted`/`savePersisted`/`opIdLastSeen`/`recordOpIdSeen`/`nextClientSeq`),
`messageDispatch.ts:66`.

Every inbound `set` performs two synchronous sessionStorage `getItem` + `JSON.parse`
calls (gap check + `recordOpIdSeen`) and one `setItem`; every outbound op does a
read-modify-write for `nextClientSeq`. A peer dragging a knob ≈ 20 ops/sec ≈ 60
storage operations/sec on the main thread. Fix: hold the `PersistedSyncState` in a
field, treat sessionStorage as write-through (or flush on `visibilitychange`/
`beforeunload`), keeping the same crash-resume semantics.

---

<a id="s2"></a>
## 🟦 S2 — Knob drag listeners not removed on unmount

**Lens:** simplicity/hygiene. **Area:** `packages/client/src/components/Knob.vue:196-236`.

`onPointerDown` adds `pointermove`/`pointerup` listeners on `window`; they're removed
only in `onPointerUp`. If the Knob unmounts mid-drag (track switch / panel swap during
a drag), the listeners survive and keep emitting `update:modelValue` into the unmounted
component until the next pointerup anywhere (which self-heals). One `onBeforeUnmount`
calling the same removal closes it. (Everything else checked — BaseModal, Visualizer
RAF + resize, presence sweeper, heartbeat, gauge, sweep timers — cleans up correctly.)

---

<a id="b1"></a>
## 🟦 B1 — Stale BACKLOG entry: "Joining a fresh room replaces the local project with an empty snapshot"

**Lens:** doc alignment. **Area:** `docs/BACKLOG.md`.

That entry (reported 2026-05-31) predates session-scoped rooms. Today rooms exist only
for real sessions, are seeded server-side from the durable snapshot (or the creator's
uploaded seed at `POST /api/sessions`), and `connectToSession` resets local state *by
design* before the snapshot lands (cross-session bleed guard). The described failure
mode can no longer occur as written. Re-triage: close it, or rewrite it as the S1
decision ("what should localStorage mean now"). The other BACKLOG entry (OCT/LEN inputs
hard to edit) remains valid — `Tracker.vue` still binds them with `v-model.number` +
`:disabled="step.note === null"`.

---

## What was checked and found healthy

Worth recording so future reviews don't re-litigate:

- **Suppression invariant (D10):** every sync-participating watcher uses
  `flush: 'sync'` and gates on `outbox && syncReady && !isApplyingFromNetwork()`;
  `applyOp`/snapshot/rollback writes all hold the guard. Verified end to end.
- **Connection lifecycle:** pool-removal-before-`onClose` ordering; heartbeat stopped
  before async close work; hello deadline bounds pre-handshake squatting; fatal-error
  close codes; `WsClient`'s per-socket handler guards (`this.socket === socket`)
  correctly neutralize late events from superseded sockets; backoff reset on
  `sync.complete`; resync guard re-arms on timeout.
- **Lost-update protection:** version-gated `clearDirty` (capture version at peek,
  clear only if unchanged) is correct; `saveSnapshot`'s exists-guard upsert handles the
  flush-vs-delete race; the sweep's `isFlushing` guard prevents overlap; shutdown does
  stop → final flush in the right order.
- **Outbox:** priorValue baselines kept earliest across requeues (correct rollback);
  `onClosed` strands nothing (in-flight + pending → offline queue); resends reuse the
  same `clientSeq` so server dedup confirms instead of double-applying;
  `reassertPending` re-applies un-acked edits over snapshots.
- **Memory hygiene:** drum engines track active sources in `Set`s with `onended`
  cleanup; engine `dispose()` chains disconnect everything; effect scopes
  (audio watchers, sync watchers) tear down with their owners; presence sweeper
  self-stops when empty; server gauge/sweep timers `unref`'d and cleared in `onClose`;
  ConnectionPool leak gauges in place.
- **Validation boundary:** accept-list patterns + `indicesInRange` + Zod leaf schemas
  cover every writable path; whole-object writes rejected; rate limiting per
  connection; sessions API validates bodies and checks ownership (guest clientId
  ownership is acknowledged-weak pending the moderation spec).
- **Prior review claims:** CODE_REVIEW.md resolutions spot-checked true (STEAL_RAMP,
  linearRamp release, ClapEngine source tracking, DEFAULT_PARAMS, sequencer anchor +
  BPM rebase, markRaw'd scheduler internals).
