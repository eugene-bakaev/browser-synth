# Lifecycle Architecture Redesign — Design Spec

**Date:** 2026-06-27
**Status:** Approved in brainstorming → pending implementation plan
**Branch:** `feat/lifecycle-architecture`

## Goal

Make resource and lifecycle ownership **explicit** so the app is no longer
implicitly coupled to module-evaluation lifetime. Dissolve the ~825-line
`composables/useSynth.ts` god-module into a small set of single-responsibility
units, move every state mutation onto one unidirectional command path, and give
every long-lived resource a single owner that tears it down at well-defined
lifecycle boundaries.

## Problem

The architecture rests on an unwritten invariant: *"`useSynth.ts` is evaluated
exactly once per page."* Critical live resources — the `AudioContext`, the
scheduler `setInterval`, the `WebSocket` — live as module-scope singletons with
no explicit owner and no teardown. Nothing disposes them; their lifetime is
implicitly the module's.

Two symptoms expose the same root cause:

1. **HMR (dev):** Vite re-evaluates the module, minting a second set of
   singletons while the first set stays alive (held by the running `setInterval`
   and the open socket). Result: two parallel "cores" — duplicated audio
   playback, and one browser tab counted as multiple room members (observed
   live: a single logged-in tab produced 4 distinct connected clientIds in 34s,
   tripping `ROOM_CAP = 4` "room full").
2. **Production reconnect:** an old socket that isn't cleanly closed lingers as
   a phantom room member until the 60s heartbeat reaps it — **no HMR involved**.
   Same missing concept: explicit teardown.

A second structural fragility: state has **two writers** into the reactive
`project` — direct component mutation (local edits) and `applyOp` (remote ops) —
reconciled by a module-scope `applyingFromNetwork` suppression flag that only
works because the sync watchers run `flush: 'sync'`. This is the source of a
recurring bug class (e.g. params added to an engine after a session was saved
not syncing in that old session; the suppression flag's `flush:'sync'`
brittleness).

The fix is not "handle HMR." It is: **make teardown a first-class capability and
state mutation a single explicit path**, after which HMR is just one of several
callers of a teardown that has to exist anyway.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| **DA** | Unidirectional command data flow (Model B). The UI never mutates state directly; every edit is a command. | Removes the two-writer duality and the suppression flag; one way state ever changes. |
| **DB** | A command **is** the existing `set(path, value)` op (Model B1) — reuse the validated op pipeline (`validatePathAndValue`, op log, `normalizeProject`, dedup, opId watermark). No new semantic-command layer. | Smallest faithful version of B; reuses battle-tested code; unifies local + remote into the same operation. Undo/redo grouping deferred (YAGNI). |
| **DC** | Canonical state lives in a **Pinia** store. | With resources owned elsewhere, Pinia does exactly what it is good at — state. Gives `createPinia()` per-test isolation (kills the 18 `resetModules`/`disposeSynth` hacks), `acceptHMRUpdate`, devtools. Pinia holds **state only — never live resources**. |
| **DD** | A single **composition root** (`AppRuntime`) owns every resource and is the only code that creates/destroys them. Each resource exposes an idempotent `dispose()`. | One owner, one teardown; makes "two cores" / phantom presence structurally impossible. |
| **DE** | **HMR-agnostic** architecture: HMR is wired in exactly one infra file, calling the same `shutdown()` as `pagehide`. Behaviour is **dispose-and-recreate**. | No business module references `import.meta.hot`. Preserve-in-place was rejected (it requires `import.meta.hot.data`, re-introducing the coupling we are removing). |

## Architecture — Components & boundaries

Five units. **State** units hold no live resources; **resource** units are
disposable and owned by one root.

```
        ┌──────────────────────────────────────────────┐
        │  AppRuntime  (composition root)               │
        │  bootstrap() / shutdown() — the ONLY owner     │
        │  the ONLY place lifecycle (incl. HMR) is wired │
        └───────┬───────────────┬───────────────┬───────┘
            owns│           owns│           owns│
        ┌───────▼──────┐  ┌─────▼───────┐  ┌────▼─────────┐
        │ ProjectStore │  │ SyncSession │  │ AudioEngine  │
        │   (Pinia)    │  │  (resource) │  │  (resource)  │
        └───────▲──────┘  └─────┬───────┘  └────┬─────────┘
   state│ ▲          │           │ inbound ops   │ pulls state /
  reads │ │ applySet │           ▼               │ reacts to commands
        │ │          └────── CommandBus ◄─────────┘
        │ │            (dispatch — single writer)
   ┌────┴─▼─────┐              ▲
   │ Components │── dispatch ──┘   (never mutate state, never touch resources)
   └────────────┘
```

| Unit | Owns | Responsibility | Lifecycle |
|---|---|---|---|
| **ProjectStore** (Pinia) | the `project` state | canonical state + read-only selectors + a low-level `applySet(path, value)` and `replaceProject(snapshot)`. No socket, no audio. | per-page (Pinia instance) |
| **CommandBus** (`dispatch`) | nothing | the **single** write funnel. `dispatchLocal(set)` → `store.applySet` + `outbox.enqueue`; `applyRemote(op)` → opId-watermark check → `store.applySet`. Where `applyingFromNetwork` dies — origin is explicit, so no echo loop and no `flush:'sync'` dependency. | stateless |
| **SyncSession** | `WsClient`, `Outbox`, presence | socket lifecycle + protocol; inbound ops → `commandBus.applyRemote`; outbound ← `outbox`. | `dispose()` closes socket |
| **AudioEngine** | `AudioContext`, per-track engines, `Sequencer` | transport pulls store each tick; applies param changes from the command stream. | `start()/stop()/dispose()` |
| **AppRuntime** | all of the above | wires them; `bootstrap()`/`shutdown()`; the one file mapping every lifecycle event (mount, unload, HMR, leave, logout) to an explicit call. | one per page |

Components are reduced to **dispatch commands + read selectors** — they can no
longer mutate state or reach a resource.

## Data flow

Every state change is a `set` command through the one `CommandBus.dispatch`
funnel. Origin is explicit, which is what lets the suppression flag disappear.

**Local edit (user turns a knob / toggles a step):**
```
Component → dispatch({ set, path, value, origin: 'local' })
   → CommandBus:
       ├─ store.applySet(path, value)      // state write (setDeep)
       └─ outbox.enqueue(path, value)      // throttle/coalesce → WsClient.send
   → reactive fan-out:
       ├─ Components re-render from selectors
       └─ AudioEngine applies the param to its audio node
```

**Remote op (peer edit arrives):**
```
WsClient.onMessage(setBroadcast) → SyncSession
   → CommandBus.applyRemote(op):
       ├─ opId watermark check (drop stale/out-of-order echo)
       └─ store.applySet(path, value)      // state write only — NO outbox
   → same reactive fan-out (UI + AudioEngine react)
```

Both paths converge on the same `store.applySet`. The only difference is what
the bus does around it: local also enqueues to the outbox; remote does not.
Because the bus knows the origin, there is no echo loop.

**What dies:** `applyingFromNetwork` / `enterSuppress` / `exitSuppress`, the
`flush:'sync'` requirement, and the second (direct-mutation) write path. The
whole "suppression flag is fragile" bug class goes away by construction.

**What survives, relocated:**
- the `Outbox` (throttle, coalesce-offline, nack-rollback) — now fed explicitly
  by the bus instead of by a watcher;
- the **opId watermark** — moves from `applyOp` into `CommandBus.applyRemote`;
- **nack rollback** — becomes a state-only `applySet` (no re-send).

**Transport stays a pull:** the `Sequencer` tick reads current store state each
step (notes/params) and schedules audio. Reads are not commands.

**Audio param application:** the AudioEngine **subscribes to the command stream**
(the bus emits applied `set`s; the engine handles engine-param paths) rather than
keeping per-slice diff-watchers. Drops the `diffParams` machinery and aligns with
the command model. (Rejected alternative: keep Pinia `watch` on slices.)

> **UPDATE 2026-07-02 — DEFERRED past Phase 4.** As implemented, the bus writes to
> a plain reactive `project` via bare `setDeep` and emits **no** stream, and three
> paths bypass the bus (bulk ops, nack rollback, `replaceProject`) yet must reach
> audio. Phase 4 therefore ships the structural `AudioEngine` extraction only and
> **keeps** the reactive slice-watchers. Command-stream params picks up later, once
> the bus is the sole writer. See the [phase-4 spec](./2026-07-02-phase4-audioengine-design.md).

## Lifecycle & ownership

**Composition root — `AppRuntime`:**
- `bootstrap()`: create the Pinia instance, `ProjectStore`, `Outbox`,
  `SyncSession`, `AudioEngine`, and `CommandBus`; wire them; return a handle.
  Called once at app boot.
- `shutdown()`: `audioEngine.dispose()` → `syncSession.dispose()` → drop the
  store. Idempotent. Nothing else creates or destroys these.

**Every lifecycle event maps to one explicit call (litmus table):**

| Event | Trigger | Call |
|---|---|---|
| App boot | `main.ts` mount | `runtime.bootstrap()` |
| Page unload | `pagehide` | `runtime.shutdown()` |
| **HMR swap (dev)** | `import.meta.hot.dispose` — **in the runtime file only** | `runtime.shutdown()` |
| Enter room | lobby join / deep link | `syncSession.connect(roomId)` |
| Leave room | leave / `not_found` bounce | `syncSession.disconnect()` → close frame → server `markDisconnected` |
| Reconnect | network blip | `syncSession` closes the old socket **before** opening the new — no orphan |
| Logout | auth change | `syncSession.reconnect()` (drops the authed identity cleanly) |

HMR appears in exactly one infra file, calling the same `shutdown()` that
`pagehide` calls. No `audio/`, `sync/`, `store/`, or component module imports
`import.meta.hot`.

**`dispose()` contracts (both idempotent):**
- `SyncSession.dispose()`: flush outbox → `wsClient.disconnect()` → clear presence.
- `AudioEngine.dispose()`: `sequencer.stop()` → dispose engines → `ctx.close()`.

**HMR behaviour is dispose-and-recreate** (a consequence of HMR-agnosticism, not
a special case): a hot edit fully tears down the old instance and builds a fresh
one. Audio cleanly stops (re-press Play); the socket cleanly closes and reopens
as one member. Preserve-in-place is deliberately not implemented.

**Error handling:** bootstrap failures surface via the existing `fatalError`
channel; a fatal `session.not_found` still bounces to the lobby, now owned by the
runtime/`SyncSession`; an `AudioContext` build failure leaves audio null (UI
shows a flat visualizer) as today.

## Testing strategy

- **ProjectStore** — `setActivePinia(createPinia())` per test gives real
  isolation; test `applySet`/selectors directly. **Kills the 18
  `resetModules`/`disposeSynth` hacks.**
- **CommandBus** — fake store + fake outbox: `dispatchLocal` writes state *and*
  enqueues; `applyRemote` writes state, does *not* enqueue, and honours the opId
  watermark. (Replaces the brittle suppression-flag tests.)
- **SyncSession** — the existing `makeFakeWsClient` pattern carries over: inbound
  ops route to `applyRemote`, outbound drains the outbox, `dispose()` closes the
  socket.
- **AudioEngine** — existing `MockAudioContext` for wiring + `OfflineAudioContext`
  for kernel audio; assert transport pulls state, command-stream params reach
  nodes, `dispose()` stops the sequencer and closes the ctx.
- **AppRuntime** — one small integration test: `bootstrap()` builds everything,
  `shutdown()` disposes everything (sequencer stopped, socket closed), idempotent.
  **This is the test that would have caught the orphan bug.**
- Components stay thin (dispatch + selectors), so the "don't mount `.vue` in unit
  tests" rule holds — they are covered through store/bus tests.

Migration of the ~600 existing tests: as each unit is extracted, its tests move
to that unit's file; the god-module's test file shrinks and is deleted last. Net
count holds or grows.

## Migration phasing

Dependency-ordered; every phase ends green, browser-verified, and reviewable.

| Phase | What | Risk |
|---|---|---|
| **0** | Add Pinia; empty `ProjectStore` mirroring current shape, no behaviour change | trivial |
| **1** | Store holds canonical state + selectors; migrate components to **read** from selectors | low |
| **2** | `CommandBus`/`dispatch`; migrate **write** sites; delete direct-mutation watchers + `applyingFromNetwork`; `applyRemote` replaces `applyOp` | **high — the heart** |
| **3** | Extract `SyncSession` (owns WsClient/Outbox/presence) + `dispose()` | medium |
| **4** | Extract `AudioEngine` (owns ctx/engines/Sequencer) + `dispose()`. ~~command-stream params~~ **DEFERRED** — Phase 4 ships the structural extraction only; the engine keeps the Vue reactive slice-watchers (see [phase-4 spec](./2026-07-02-phase4-audioengine-design.md) + `docs/BACKLOG.md`) because 3 mutation paths bypass the bus | medium |
| **5** | `AppRuntime` root: `bootstrap`/`shutdown` + all lifecycle wiring incl. the **single** HMR hook; delete `useSynth.ts`; update `ARCHITECTURE.md` + add decision **D17** (and mark superseded decisions) | medium |

Order rationale: foundation (store) → the write-funnel (correctness) → peel
resources into services → the root that owns lifecycle. Each phase leaves the app
working. The in-flight `fix/hmr-orphaned-transport` branch becomes throwaway —
its dispose logic lands properly as `AudioEngine.dispose()` /
`SyncSession.dispose()` in phases 3–4.

## Documentation deliverables (part of the work, not optional)

- Update `docs/ARCHITECTURE.md`: new module map, the unidirectional command data
  flow, and the lifecycle/ownership model (composition root + dispose contracts).
- Add a new entry **D17** to the `ARCHITECTURE.md` "Appendix: Key design
  decisions" (the appendix currently runs D1–D16) recording this redesign
  (command bus, Pinia state store, composition root, HMR-agnostic lifecycle) and
  why. D17 summarizes the spec-internal decisions DA–DE below.
- **Mark the decisions this redesign supersedes or revises** in the appendix:
  - **D8** (`useSynth` is an explicit lazy singleton) → superseded by the
    `AppRuntime` composition root + service decomposition.
  - **D10** (network-applied writes suppressed via a sync-flush watcher guard) →
    **removed**; the single `CommandBus` writer makes the `applyingFromNetwork`
    guard unnecessary.
  - **D13 / D14** (knob `syncPath` / direct slice binding for writes) → revised:
    writes now flow through `dispatch`, not direct slice mutation.
  - **D16** (`clientId` stays per-connection) → unchanged, but referenced by the
    optional auth-resume follow-on below.

## Out of scope / follow-ons

- **Auth-path clientId resume (separate, optional follow-on).** The prod
  phantom-presence had a second contributor: `makeAuthenticatedIdentity` always
  mints a fresh clientId (no resume; resume is guest-only). The client lifecycle
  fix removes the *orphan* (old socket now closes promptly), reducing this to a
  brief self-healing blip. Giving the auth path the same clientId-resume as the
  guest path is a small **server-side** change, recorded here but not bundled
  into this client redesign.
- **Preserve-in-place HMR (rejected).** Would keep audio playing seamlessly
  across hot edits but requires `import.meta.hot.data`, re-introducing the HMR
  coupling this redesign removes.
- **Semantic command layer / undo-redo (deferred, YAGNI).** B1 keeps commands as
  raw `set` ops; a higher-level command vocabulary can be layered later if undo
  grouping is actually needed.

## Success criteria (the litmus test)

The architecture is correct when:

1. Every one of these lifecycle events maps to exactly one explicit call —
   mount · unmount · page unload · HMR swap · WS reconnect · leave session ·
   logout — and **no business module imports `import.meta.hot`**.
2. Components cannot mutate state directly or reach a live resource (dispatch +
   selectors only).
3. State has exactly one writer (`store.applySet`, reached only via the
   `CommandBus`); the `applyingFromNetwork` flag is gone.
4. The `AppRuntime` shutdown test proves the old scheduler and socket are stopped
   after `shutdown()` — i.e. the orphan-on-HMR and phantom-presence symptoms are
   structurally impossible, not patched.
