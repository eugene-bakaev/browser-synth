# Phase 5 — AppRuntime + Command-Stream Params + useSynth Dissolution — Design Spec

**Date:** 2026-07-02
**Status:** Approved in brainstorming → pending implementation plan
**Branch:** `feat/phase5-appruntime`
**Parent:** [Lifecycle Architecture Redesign](./2026-06-27-lifecycle-architecture-design.md), Phase 5 (+ the Phase 4 row's deferred part b)

## Goal

Finish the redesign — the whole horse. Phase 5 delivers:

1. **AppRuntime** — the composition root: `createAppRuntime()`/`shutdown()`, one
   explicit call per lifecycle event, the **single** `import.meta.hot` reference
   in the app (decisions DD/DE).
2. **Command-stream params (master spec decision DE, deferred by Phase 4):** the
   `CommandBus` becomes the **sole gateway to state** and emits an
   applied-command stream; `AudioEngine` subscribes to it; the reactive
   slice-watchers and audio-side `diffParams` machinery are **deleted**.
3. **Per-page `project`** — created in `AppRuntime.bootstrap` via the Pinia
   store; the module-scope singleton in `stores/project.ts` dies (honoring that
   file's own Phase-5 comments).
4. **`useSynth.ts` deleted** — replaced by a `createSynthContext(runtime)`
   factory that preserves the injected `SYNTH_CONTEXT` surface, so context
   consumers are untouched.
5. **Docs:** `ARCHITECTURE.md` module map / data flow / lifecycle rewrite; new
   decision **D17**; **D8/D10 superseded, D13/D14 revised, D16 cross-referenced**.

After this phase, every master-spec success criterion is literally true.

## Current-state reconciliation (what Phases 2–4 already did)

The master spec predates Phases 2b–4. Verified reality at branch point
(`main` = `dde0f24`):

- `applyingFromNetwork` / `applyOp.ts` are **gone** (litmus #3 mostly done):
  leaf edits flow `dispatchLocal → CommandBus.dispatchLocal → setDeep + gated
  enqueue`; remote ops flow `messageDispatch → CommandBus.applyRemote`.
- `SyncSession` (Phase 3) and `AudioEngine` (Phase 4) exist with idempotent
  `dispose()` — but both are **module-scope singletons in `useSynth.ts`**
  (lines 85/97), constructed at module eval: the exact implicit-lifetime
  anti-pattern the redesign targets.
- `disposeSynth()` has **zero production callers**; `import.meta.hot` appears
  **nowhere**; no `pagehide` teardown exists. Litmus #1 and #4 are fully open.
- Audio reacts via `flush:'sync'` watchers on the reactive `project`
  (AudioEngine.ts effectScope) — Phase 4's called-out deferral.

**Complete writer inventory** (every code path that mutates `project` today):

| # | Writer | Path today | Re-routed to (this phase) |
|---|---|---|---|
| 1 | Knobs/steps/toggles | `dispatchLocal` → bus `applySet`; **bare `setDeep` fallback pre-connect** (useSynth.ts:60) | bus (fallback dies — bus is long-lived) |
| 2 | Remote ops | `bus.applyRemote` | unchanged |
| 3 | Nack rollback + `reassertPending` | `Outbox.applyLocal` → bare `setDeep` (SyncSession.ts:166) | `bus.applyRollback` |
| 4 | Server snapshot | `messageDispatch` → `replaceProject` direct | `bus.loadProject(normalizeProject(...))` |
| 5 | Bulk ops (Clear/Shift/Fill, preset load, init-patch) | in-place mutation + outbound-only diff (`session.enqueue`) | draft-diff-dispatch through `bus.dispatchLocal` |
| 6 | Open/New/reset (`resetLocalProject`) | `replaceProject` direct | `bus.loadProject` |

## Architecture

### 1. The write model — one long-lived CommandBus that writes, emits, syncs

**The bus becomes long-lived**, created once by `AppRuntime` (as the master
spec's diagram always showed) instead of per-connection in
`SyncSession.buildConnection`. This one move:

- kills the bare-`setDeep` pre-connect fallback in `dispatchLocal` — the bus
  always exists; its outbound `enqueue` sink (`session.enqueue`) is already
  gated on `isSyncLive`, so pre-connect edits write state + reach audio and
  simply don't sync;
- lets audio subscribe **once**, at graph build, with no per-room resubscribe;
- reduces the per-connection watermark story to `bus.resetWatermark()` called
  by `SyncSession.connect()` (the method already exists — snapshot arrival
  calls it today).

**Bus API** (all writes converge on the store's two primitives):

```ts
dispatchLocal(cmd)        // store.applySet + emit('set') + enqueue (gated on live)
applyRemote(op)           // watermark check → store.applySet + emit('set')
applyRollback(path, val)  // store.applySet + emit('set')  — no enqueue, no watermark
loadProject(project)      // store.loadProject + emit('replace') — wholesale replace
subscribe(listener)       // the applied-command stream (decision DE)
resetWatermark()          // unchanged; now also called on connect()
```

**Stream event shape:**

```ts
type AppliedCommand =
  | { kind: 'set'; path: Path; value: unknown }
  | { kind: 'replace' };
```

The emit is **synchronous, in the same call stack as the write** — exactly the
ordering `flush:'sync'` used to guarantee. Hard constraint, pinned by test:
**subscribers must not dispatch** (no re-entrant writes from a handler).

**Bus deps:** `{ applySet: store.applySet, loadProject: store.loadProject,
enqueue: session.enqueue }`. The bus↔session circularity (bus needs
`session.enqueue`; session needs the bus for `applyRemote`/`resetWatermark`)
resolves with a late-bound closure in `createAppRuntime` — no setter API.

**Bulk ops become draft-diff-dispatch (chosen over mutate-then-dispatch):**
`clearTrack`/`shiftTrack`/`fillTrack` (project/mutations.ts) and
`applyPreset`/`resetEnginePatch` (project/preset.ts) become **pure
draft-producers** — they compute the post-op value on a clone instead of
mutating live state (`shiftTrack` already builds an internal window copy;
`cloneEngineSlice` already exists). The caller diffs draft vs live and
dispatches each changed leaf through `bus.dispatchLocal` — the bus performs the
actual write. Prior values for nack rollback come free from live (pre-write)
state; the before-snapshot machinery dies.

**Exception:** Open/New (and `resetLocalProject`) stay wholesale —
`bus.loadProject(...)` (audio gets the `replace` event) plus the existing
whole-project outbound diff **enqueue** (as today). Leaf-dispatching a full
file load would be thousands of redundant ops for no benefit.

**Deviation from master spec, recorded:** the `Outbox` stays per-connection
inside `SyncSession` (not AppRuntime-owned) — its `clientSeq` state genuinely
is connection-scoped. The bus reaches it through the stable, gated
`session.enqueue`.

### 2. AudioEngine — watchers → command-stream subscription (DE proper)

**Deleted:** the entire `effectScope` block in `buildAudioState`
(AudioEngine.ts:244-292) — all four watcher families (engineType, per-slice
snapshot+diff, mixer, enabled) — plus the audio-side `snapshot()`-per-watch
machinery and the `diffParams` import. `project/paramDiff.ts` survives only on
the outbound side (projectOps diffs draft-vs-live to know what to dispatch).

**Replacement:** `AudioEngineDeps` grows `subscribe`. `buildAudioState`
subscribes; the unsubscribe handle lives in `AudioState` (where the scope
lived); `dispose()` unsubscribes. Handler:

```
{ kind:'set', path }:
  ['tracks', i, 'engineType']             → syncTrackToEngine(i)
  ['tracks', i, 'enabled']                → syncTrackToEngine(i) + updateMixerGains()
  ['tracks', i, 'mixer', ...]             → updateMixerGains()
  ['tracks', i, 'engines', slice, key, …] → if track.engineType === slice && engine:
                                              engine.applyParams({ [key]: snapshot(liveSlice[key]) })
  anything else (bpm/steps/patternLength) → ignore — the sequencer pulls per tick
{ kind:'replace' }:
  for all i: syncTrackToEngine(i); updateMixerGains()
```

The `replace` handler is **exactly the loop `buildAudioState` already runs at
boot** — snapshot arrival, Open/New, and leave-room all become "re-run initial
sync": one idempotent path instead of 32×13 watchers firing over a wholesale
replace.

Events arriving before the graph exists are ignored by construction (nothing
is subscribed); `buildAudioState` applies full current state when it builds —
the lazy-boot story is unchanged.

**Called-out behavioral consequences (benign):**

1. Nested-param granularity coarsens: editing `filterEnv.a` applies
   `{ filterEnv: {a,d,s,r} }` (whole re-read sub-object) instead of the diffed
   `{ filterEnv: {a} }`. Engine `applyParams` implementations are idempotent
   per-param setters that already receive whole slices at build/swap — a
   superset is safe, and re-reading live state makes the handler immune to
   partial-reconstruction bugs.
2. The synth2 matrix arrives as `{ matrix: <whole live array> }` on any slot
   edit — same reasoning.
3. Nack rollback and `reassertPending` now **reach audio** (they bypassed the
   watchers' paths only accidentally-correctly before; now the restored values
   are audible) — a latent-bug fix, not a regression.

This kills the `flush:'sync'` requirement for good: audio reactions no longer
depend on Vue watcher flush semantics at all (obsoletes the
sync-suppression-mechanism hazard class).

### 3. AppRuntime — the composition root + every lifecycle wire

**`src/app/AppRuntime.ts`:**

```ts
export interface AppRuntimeOptions {      // replaces the module-scope test knobs
  wsClientFactory?: WsClientFactory;      //   ← setWsClientFactory dies
  syncEnabled?: boolean;                  //   ← setSyncEnabled dies
}

export function createAppRuntime(opts?: AppRuntimeOptions): AppRuntime {
  const pinia = createPinia();
  const store = useProjectStore(pinia);   // project born HERE (per-page)
  let session: SyncSession;               // late-bound for bus↔session wiring
  const bus = createCommandBus({
    applySet: store.applySet,
    loadProject: store.loadProject,
    enqueue: (...args) => session.enqueue(...args),
  });
  session = new SyncSession({ project: store.project, bus, /* opts knobs */ });
  const audio = new AudioEngine({ project: store.project, subscribe: bus.subscribe });
  return { pinia, store, bus, session, audio, shutdown };
}
```

`shutdown()` = `audio.dispose()` → `session.dispose()` — both idempotent, so
shutdown is. **Shutdown disposes resources; it does not brick the runtime**:
`ensureAudio()` rebuilds from null and `connect()` works after `dispose()`, so
the bfcache-restore path (below) needs no special casing.

**Per-page `project`:** `reactive(freshProject())` moves **inside** the
`defineStore` setup — instance lifetime = the Pinia instance's, which
`createAppRuntime` creates. The module-scope singleton, the raw
`export { project }`, and `__resetProjectStoreForTest` all die. A fresh runtime
per test is the isolation (kills the `resetModules` hacks — decision DC).

**`main.ts` — the single lifecycle file** (the only code that knows about page
lifetime or HMR):

```ts
const runtime = createAppRuntime();
createApp(App).use(runtime.pinia).use(router).provide(RUNTIME_KEY, runtime).mount('#app');
window.addEventListener('pagehide', () => runtime.shutdown());
if (import.meta.hot) import.meta.hot.dispose(() => runtime.shutdown());
```

HMR reality note: Vue SFC edits self-accept and never reach main.ts. A
non-accepted TS-module edit bubbles to the entry → Vite **full-reloads** →
`pagehide` fires → same `shutdown()`. The `hot.dispose` covers the entry module
re-evaluating. Either road ends at one `shutdown()` — dispose-and-recreate
(decision DE). The two-cores bug becomes structurally impossible: after this
phase **no `new SyncSession` / `new AudioEngine` / `reactive(freshProject())`
exists at module scope anywhere** — re-evaluating any module mints nothing.

**Lifecycle litmus table, closed:**

| Event | Wire |
|---|---|
| Boot | `main.ts` → `createAppRuntime()` |
| Page unload | `pagehide` → `runtime.shutdown()` |
| HMR swap | `hot.dispose` → `runtime.shutdown()` (main.ts only) |
| Enter / leave room | `session.connect()` / `session.disconnect()` (as today) |
| Reconnect / logout | inside `SyncSession` (as today) |
| bfcache restore | App.vue `pageshow.persisted` → force reconnect (as today); audio re-boots lazily on next PLAY |

`pagehide` also fires on bfcache-**freeze**, so we now tear down where today
nothing does. This is more correct (the frozen socket dies anyway; the restore
path already force-reconnects) — pinned by a test and browser-verified.

### 4. Deleting useSynth.ts — the context factory

**The dissolution is not a consumer refactor:** the injected `SYNTH_CONTEXT`
surface survives unchanged. `src/app/synthContext.ts` —
`createSynthContext(runtime: AppRuntime)` — absorbs the `useSynth()` body
verbatim (activeTrackIndex, focusedTrack, bpm computed, selectTrack/
setFocusedTrack, add/removeTrack, shortestActiveNoteDuration, sessionName,
connect/leave flows with URL handling) and delegates the resource surface to
`runtime.audio`/`runtime.session` exactly as useSynth does today. App.vue:
`inject(RUNTIME_KEY)` → `createSynthContext(runtime)` →
`provide(SYNTH_CONTEXT, ...)` — once, in the never-unmounting shell.

**Fate of every current export:**

| Export | Fate |
|---|---|
| `useSynth()` body | → `createSynthContext(runtime)` |
| `dispatchLocal`, `endGesture`, `DISCRETE_LEAF_FIELDS` policy | → context methods (thin wrappers over `bus.dispatchLocal` / `session.flushPath`) |
| `setSyncEnabled`, `setWsClientFactory` | die → `createAppRuntime` options |
| `syncEngineParamsDiff`, `syncStepWindowDiff`, `syncWholeProjectDiff`, `snapshotProjectForSync`, `cloneEngineSlice`, `emitLeafDiff`/`emitMatrixDiff` | reshaped into `createProjectOps(runtime)` |
| `connectToSession`, `leaveSession`, `resetLocalProject` | → context factory (`resetLocalProject` = `bus.loadProject(freshProject())`) |
| `sessionName` | → context-owned ref |
| `disposeSynth` | dies → `runtime.shutdown()` |

**`createProjectOps(runtime)` — `src/app/projectOps.ts`, the litmus-#2 fix.**
StudioView today imports raw `project` and mutates it (onClear,
applyPresetSynced, onNew, …) — the last place a component writes state. The
draft-diff-dispatch flows need bus access anyway, so the bulk-op semantics move
wholesale into `{ clearTrack(i), shiftTrack(i, dir), fillTrack(i, interval),
applyPreset(i, preset), initPatch(i), newProject(), openProject(loaded) }`,
carried on the context. StudioView's handlers collapse to one-liners.

**The four direct importers, fixed:**

- **ErrorOverlay.vue** — `useSynth()` → `inject(SYNTH_CONTEXT)` (App provides
  before children render).
- **sync/knobSync.ts** — imports `dispatchLocal`/`endGesture` → injects the
  context (it already injects `ACTIVE_TRACK_KEY`; same dormant-fallback
  pattern for tests).
- **sync/commandModel.ts** (`useCommandModel`) — imports raw `project` +
  `dispatchLocal` → injects the context for both (the context already carries
  `project`).
- **views/StudioView.vue** — all named imports replaced by the injected
  context it already holds.

Post-condition: `grep -rn "from '.*composables/useSynth'"` returns nothing;
the file is deleted; the only state writers in the client are
`store.applySet`/`store.loadProject`, reached only through the bus.

## Testing strategy

`useSynth.test.ts`'s ~1100 lines redistribute — net count holds or grows:

- **CommandBus** — `applyRollback` writes without enqueue; `loadProject` emits
  `replace`; `subscribe` sees every applied set exactly once; watermark resets
  on connect; the subscribers-don't-dispatch constraint.
- **projectOps** — draft-diff-dispatch produces exactly today's leaf ops (same
  paths/values/priors — the old emitter tests port over); live state untouched
  until the bus writes.
- **AudioEngine** — stream-driven: engine-path `set` reaches `applyParams`;
  `enabled`/`engineType`/`mixer` paths hit the right node logic; `replace`
  re-syncs all slots; unsubscribed after `dispose()`.
- **AppRuntime** — the marquee test: *bootstrap → play → connect → shutdown ⇒
  sequencer stopped, ctx closed, socket closed; second shutdown = no-op.*
  Fresh runtime per test = real isolation.
- **synthContext** — the facade contract tests, built on a test runtime via
  options — no `resetModules`, no import-order gymnastics.

## Task decomposition (dependency-ordered; each ends green)

Hard ordering constraint: **audio's watchers can only be deleted after every
audio-relevant write flows through the bus** — else preset-load silently stops
reaching audio mid-branch.

1. **Bus grows up** — `subscribe`/`applyRollback`/`loadProject`; long-lived
   (SyncSession takes it as a constructor dep; interim construction stays in
   useSynth beside the other singletons); `dispatchLocal` fallback dies;
   nack/snapshot re-routed; `resetWatermark()` on connect. Watchers still on →
   behavior identical.
2. **Bulk ops → draft-diff-dispatch** — `projectOps` factory (interim
   instantiation in useSynth); `mutations.ts`/preset helpers become pure
   draft-producers; old emitters absorbed.
3. **Audio swaps watchers for the stream** — delete the effectScope +
   audio-side diff machinery; subscription + handler + tests.
4. **The atomic swap** — AppRuntime + per-page `project` + main.ts lifecycle
   wiring + `createSynthContext` + `createProjectOps` onto the context +
   delete `useSynth.ts` + fix the 4 importers. One task, deliberately: the
   pieces are circularly interdependent (useSynth's module-eval singletons
   import `project`, so per-page `project` cannot land while useSynth lives).
   Same shape as Phase 3/4's atomic-swap tasks; complete code in the plan.
5. **Docs** — ARCHITECTURE.md module map + data flow + lifecycle rewrite; D17
   added; D8/D10 superseded, D13/D14 revised, D16 cross-referenced; BACKLOG's
   command-stream-params entry closed.

Full gate + two-tab browser verification on the local Docker DB after tasks
3 and 4 (the behavior-bearing swaps).

## Risks (named honestly)

- **Task 4 is the widest change of the whole redesign.** Mitigations: the
  preserved `SYNTH_CONTEXT` surface, complete code in the plan, per-task
  review, browser verification.
- **`pagehide` on bfcache-freeze** now tears down where today nothing does —
  more correct, but a behavior change; pinned by test + browser-verified
  (restore path force-reconnects; audio re-boots lazily).
- **Emit-in-write-path reentrancy** — bounded by the subscribers-don't-dispatch
  constraint (audio's handler only touches audio nodes, as its watchers did).
- **Steps-window dispatch volume** (Clear on 64 steps ≈ a few hundred leaf
  ops) is identical to today's outbound enqueue behavior; state writes add a
  trivial per-leaf `setDeep`; audio ignores step paths.

## Out of scope / follow-ons

- **Transport as commands** — Play/Stop stay direct `AudioEngine` methods via
  the context. Dispatching transport through the bus serves no sync or
  ownership goal (transport is per-tab, never synced) — YAGNI.
- **Auth-path clientId resume** — unchanged server-side follow-on (master spec).
- **DRY-ing the ENGINE_SLICES copies** — separate cleanup, unchanged.
- **Semantic command layer / undo-redo** — still deferred (master spec, YAGNI).

## Success criteria

1. Every lifecycle event maps to exactly one explicit call (litmus table
   above); **no business module imports `import.meta.hot`**; grep proves it.
2. Components cannot mutate state or reach a live resource: dispatch +
   selectors via the injected context only; `grep` for raw `project` imports
   outside `stores/` returns nothing.
3. State has exactly one writer: `store.applySet`/`store.loadProject`, reached
   only via the four bus methods; no bare `setDeep` against `project` outside
   the store.
4. The AppRuntime shutdown test proves scheduler + socket + ctx are stopped
   after `shutdown()`, idempotently — orphaned-transport and phantom-presence
   are structurally impossible.
5. Audio reacts to the command stream: the watcher effectScope and audio-side
   `diffParams` are deleted; knob edits, remote ops, presets, bulk ops,
   snapshots, and nack rollbacks all audibly reach the engine — verified in
   the browser two-tab.
6. `useSynth.ts` does not exist; the full gate is green; ARCHITECTURE.md
   documents the end state (D17).
