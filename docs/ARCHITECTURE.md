# Fiddle Synth — Architecture Reference

**Audience:** future contributors (including future-me). Read this before changing audio engine code, sequencer scheduling, or `app/AppRuntime.ts`.

**Companion docs:**
- [`CODE_REVIEW.md`](./CODE_REVIEW.md) — Findings list with resolution status. Source of truth when this doc and a finding conflict.
- Memory: `audio_engine_decisions.md` — Same Decisions appendix content, surfaced into Claude's memory across sessions.

---

## 1. What this app is

A browser-based **multi-user step sequencer + synthesizer** built on Vue 3 + Web Audio. The app is **session-first**: you land in a lobby, create or join a *session* (a durable, shareable jam room), and edit its project live with up to 4 collaborators. Project state syncs over WebSocket (per-field last-write-wins) while **audio renders locally** in each browser. Optional Google sign-in (Supabase) layers on top of the zero-friction guest flow (§17).

A project is a fixed **32-slot track pool** (`TRACK_POOL_SIZE`); each slot carries an `enabled` flag, and "add/remove track" toggles that flag (no structural sync op, no index shift). A fresh project starts with 4 slots enabled (`DEFAULT_ENABLED_TRACKS`). Each track runs one of five sound engines (Synth, Kick, Hat, Snare, Clap) and has an independent loop length of **1–64 steps** (`patternLength`) over a fixed 64-step buffer — tracks share a downbeat but loop independently (polymeter); see D15. BPM 40–240, with per-step note/octave/length/velocity/mute/chord-type.

All user-editable state lives in a `Project` object. Persistence is **server-side**: the session's project is snapshotted to Postgres (Supabase) by the server's autosave layer (§14b). There is **no localStorage project autosave** — that path was vestigial once the app went session-only and was removed (review S1, 2026-06-09); explicit file Save/Open (§13) is the offline persistence story.

The **Fastify WebSocket sync server** in `packages/server/` carries the project-state mutations and owns durable persistence. Deployed: client on Vercel, server on Render, database on Supabase. See §14–§16.

```
┌────────────────────────────────────────────────────────────────┐
│  Vue 3 UI  (App shell → router: LobbyView | StudioView | …)    │
│       │   StudioView: channel rack (Tracker columns) + panels  │
│       │   :params engine-slice (read) → knob → dispatchLocal   │
│       ▼                                                        │
│  AppRuntime  (composition root; one per page)                  │
│    ├─ store:     Pinia ProjectStore — reactive Project (synced)│
│    ├─ bus:       CommandBus — sole writer; applied-command     │
│    │              stream drives AudioEngine (no watchers)      │
│    ├─ audio:     AudioEngine (ctx, sparse SoundEngine[],        │
│    │              Sequencer — lookahead ticker, absolute index)│
│    └─ session:   SyncSession (WsClient + Outbox) ←→ wss://…/ws/<sessionId> │
│       │                                                        │
│       │   applyParams(params)         trigger(freq,dur,t,vel)  │
│       ▼                                                        │
│  Engines (SynthEngine, KickEngine, HatEngine, SnareEngine,     │
│           ClapEngine) — each implements SoundEngine            │
│       │                                                        │
│       ▼                                                        │
│  trackGains[i] ─┬→ DynamicsCompressor → masterGain(0.6)        │
│                 │                       → ctx.destination      │
│                 └→ trackAnalysers[i] (per-track oscilloscope)  │
└────────────────────────────────────────────────────────────────┘
```

---

## 2. Module map

The repo is an **npm workspaces monorepo** with three packages under `packages/`. The client is the Vue/Vite app described throughout this doc; the server is a Fastify WebSocket **sync server** that carries real-time project-state mutations between clients (see §14–§16); shared holds the project schema, sync-protocol types, and helpers that must compile in both Node and the browser.

```
browser-synth/
├── package.json                # workspaces: ["packages/*"]; root scripts fan out via -w
├── tsconfig.base.json          # strict TS base; client and server each extend + override
├── vercel.json                 # Vercel deploys @fiddle/client; SPA rewrite /(.*) → /index.html (§16)
├── render.yaml                 # Render Blueprint: @fiddle/server web service (esbuild bundle, §16)
├── docker-compose.yml          # local server dev: tsx watch + bind-mounts on packages/server/src + packages/shared/src
├── supabase/migrations/        # SQL for the profiles + sessions tables (run manually; §17)
├── docs/                       # this doc, CODE_REVIEW.md, CODE_REVIEW_2026-06-09.md, ROADMAP.md, BACKLOG.md, superpowers/
└── packages/
    ├── shared/                 # @fiddle/shared — project schema + wire protocol + session contracts (see §14)
    │   └── src/
    │       ├── index.ts        # barrel: EngineType, MixerState, PROJECT_SCHEMA_VERSION, + the below
    │       ├── engines/        # per-engine param shapes + DEFAULT_PARAMS (portable, no DOM/Audio)
    │       ├── project/        # Project/ProjectTrack/Step types, freshProject, constants (TRACK_POOL_SIZE,
    │       │                   #   STEP_BUFFER_SIZE, BPM_MIN/MAX), Zod schema, accept-list (validatePathAndValue),
    │       │                   #   normalize.ts (boundary repair, §14b), snapshot-codec.ts (sparse pack/unpack)
    │       ├── protocol/       # wire message types + Zod schemas, identity constants, PROTOCOL_VERSION
    │       ├── session/        # /api/sessions contracts: Create/Patch body schemas, LobbyEntry, SessionSettings
    │       └── path.ts         # setDeep(obj, path, value) + pathKey — shared by client + server
    ├── server/                 # @fiddle/server — Fastify sync server + sessions API (see §14–§15)
    │   ├── Dockerfile          # multi-stage: builder → runtime (node:22-alpine)
    │   └── src/
    │       ├── index.ts        # bootstrap: loadEnv, startOtel, installProcessSafetyNet, listen(host, port)
    │       ├── server.ts       # buildServer() — wires CORS, websocket, routes, stores, SessionSync, memory gauge
    │       ├── processSafetyNet.ts  # unhandledRejection → log + stay up (porsager/postgres pooler blips)
    │       ├── cors.ts         # resolveCorsOrigin() — needed for the cross-origin /api routes
    │       ├── routes/         # health.ts, sessions.ts (lobby CRUD + per-IP create limit), ws.ts,
    │       │                   #   rate-limit.ts (KeyedTokenBucket)
    │       ├── room/           # RoomStore interface + InMemoryRoomStore (op log + O(1) dedup index,
    │       │                   #   dirty/version flags, grace timer), identity assignment, types
    │       ├── session/        # durable sessions (§14b): SessionStore interface, Postgres + InMemory impls,
    │       │                   #   SessionSync (autosave sweep, flush, guest prune), lobby.ts (buildLobbyList)
    │       ├── profile/        # ProfileStore interface + Postgres/InMemory impls (usernames, §17)
    │       ├── auth/           # verifyToken.ts — local JWT verify against cached Supabase JWKS (§17)
    │       ├── db/             # postgresOptions.ts — prepare:false etc. for the Supabase txn pooler
    │       ├── otel/           # opt-in observability (FIDDLE_OTEL): sdk, log, ws frame metrics, db spans
    │       ├── scripts/        # one-off maintenance (repair-track-pool)
    │       └── sync/           # ConnectionHandler (per-conn lifecycle), ConnectionPool, Heartbeat,
    │                           #   rate-limit (TokenBucket), withTimeout, protocol.e2e.test.ts
    └── client/                 # @fiddle/client — the Vue/Vite app
        ├── vite.config.ts      # dev proxy: /ws (WS upgrade) + /api → localhost:8787
        ├── vitest.config.ts
        ├── index.html
        ├── e2e/sync.spec.ts    # Playwright two-tab collaboration e2e
        └── src/
            ├── App.vue                     # Shell: Sidebar + <router-view> + DialogHost + ErrorOverlay;
            │                               #   creates the one SynthContext via createSynthContext(runtime)
            ├── main.ts                     # THE composition entry: createAppRuntime() + mount + pagehide/HMR — see §6
            ├── app/                        # composition root (Phase 5) — see §6
            │   ├── AppRuntime.ts           # createAppRuntime() — owns store/bus/session/audio; idempotent shutdown()
            │   ├── synthContext.ts         # createSynthContext(runtime) — the injected SYNTH_CONTEXT facade
            │   └── projectOps.ts           # bulk ops (Clear/Shift/Fill, preset load, INIT PATCH, New/Open) as
            │                               #   pure draft-diff-dispatch through the CommandBus
            ├── router/                     # memory-history router (lobby/studio/account) — URL stays /r/<id>
            ├── views/
            │   ├── LobbyView.vue           # session list (useLobby poll) + create-session flow
            │   ├── StudioView.vue          # the DAW: channel rack (per-track Tracker columns) + engine panels
            │   └── AccountView.vue         # sign-in / username editor
            ├── composables/
            │   └── useLobby.ts             # 30s visibility-aware poll of GET /api/sessions
            ├── auth/                       # supabase.ts (null without env), useAuth.ts (§17)
            ├── dialogs/                    # useDialog — promise-based modal host plumbing
            ├── sequencer/
            │   └── Sequencer.ts            # Lookahead scheduler; emits an absolute step index (D15)
            ├── engine/
            │   ├── types.ts                # SoundEngine, Module, ModulePort
            │   ├── SynthEngine.ts          # 6-voice subtractive synth
            │   ├── SynthVoice.ts           # One voice (osc×2 → mixer → filter → VCA)
            │   ├── KickEngine.ts           # Pitch-swept sine
            │   ├── HatEngine.ts            # Bandpassed noise + metallic oscillators
            │   ├── SnareEngine.ts          # Noise + tonal body
            │   ├── ClapEngine.ts           # Multi-burst noise
            │   ├── PatchBay.ts             # Trivial connect/disconnect helper
            │   ├── worklets/               # pulse-processor AudioWorklet (polyblep square/pulse osc)
            │   └── modules/
            │       ├── Oscillator.ts       # OscillatorNode + per-osc gain + coarse/fine tune
            │       ├── Mixer.ts            # 2-channel pre-filter mix
            │       ├── Filter.ts           # Lowpass BiquadFilterNode wrapper
            │       ├── Envelope.ts         # Shared ADSR; drives amp env AND filter env
            │       └── Noise.ts            # Per-context cached 2s white-noise buffer
            ├── project/
            │   ├── types.ts        # Project, ProjectTrack, EngineParamsMap; re-sources from @fiddle/shared
            │   ├── factory.ts      # freshProject(), freshTrack(), freshStep()
            │   ├── mutations.ts    # clearTrack(), shiftTrack(), fillTrack() — pure ops over ProjectTrack
            │   ├── migrations.ts   # migrateToLatest(raw) — versioned schema entry point
            │   ├── storage.ts      # reconcileWithDefaults + serialize/deserialize/replaceProject (no
            │   │                   #   localStorage path — removed, review S1)
            │   ├── file-io.ts      # saveProjectToFile(), openProjectFromFile(), ProjectFileError
            │   ├── preset.ts       # Preset type, makePreset, serializePreset/deserializePreset, applyPreset
            │   ├── preset-file-io.ts # savePresetToFile(), openPresetFromFile()
            │   └── index.ts        # public barrel
            ├── stores/
            │   └── project.ts      # Pinia ProjectStore — owns the canonical `project` instance, created
            │                       #   PER PINIA INSTANCE (per page / per test runtime, via createAppRuntime),
            │                       #   not at module scope; applySet/loadProject (write-only, reached via the bus)
            ├── sync/                       # real-time collab client (see §15)
            │   ├── WsClient.ts             # WS state machine; per-room {clientId, opIdLastSeen, clientSeq}
            │   │                           #   persisted to sessionStorage (in-memory cached, write-through)
            │   ├── Outbox.ts               # outbound: 50ms throttle, coalesce, offline queue, nack rollback,
            │   │                           #   ack-timeout resends, flushPath, reassertPending
            │   ├── CommandBus.ts           # createCommandBus() — sole write funnel; see §6
            │   ├── SyncSession.ts          # owns the room connection (WsClient+Outbox+presence) for one tab
            │   ├── messageDispatch.ts      # server-message switch (welcome/snapshot/set/presence/error/…);
            │   │                           #   routes inbound writes through the CommandBus
            │   ├── presence.ts             # roster + per-path "touched" map for the activity ring
            │   ├── knobSync.ts             # useKnobSync(engine): per-knob syncPath + gesture-end (§15)
            │   ├── roomId.ts               # /r/:roomId parsing + random room id generation
            │   ├── clientId.ts             # stable per-browser GUEST id (localStorage) for session ownership
            │   └── sessionsApi.ts          # typed HTTP client for /api/sessions (VITE_API_URL aware)
            ├── components/                 # Knob, Tracker, StepNumberInput, panels (SynthPanel, KickPanel, …),
            │                               #   TrackMixer, Visualizer, Sidebar (nav + roster chips),
            │                               #   BaseModal/DialogHost/CreateSessionDialog, ErrorOverlay
            ├── ui/                         # engineLabel, trackColors
            └── utils/                      # noteToFreq, chord resolution, debounce, deepMerge, stepFields
```

**Test layout:** every engine and the sequencer have colocated `.test.ts` files using `vi.stubGlobal` to mock `AudioContext` / `AudioNode` / `AudioParam`. The project, sync, session, and server modules have their own suites. **560 unit tests** at time of writing (311 client + 152 server + 97 shared), plus the **server protocol e2e suite** (`*.e2e.test.ts`, real WebSocket sockets — excluded from `npm test`) and the Playwright browser e2e (`e2e/sync.spec.ts`, two-tab collaboration).

**Common commands** (from repo root):
- `npm run dev` — client (Vite) + server (`tsx watch`) in parallel via `npm-run-all`. Vite proxies `/ws` and `/api` → `localhost:8787`, so two browser tabs sync locally with no extra config.
- `npm run build` — client (`vue-tsc && vite build`) then server (`tsc --noEmit` typecheck **then esbuild bundle** → a single self-contained `dist/index.js`; see §16). Vercel only runs the client build.
- `npm test` — fans out to every workspace with a `test` script (unit + integration; e2e excluded).
- `npm run test:e2e:server` — server protocol e2e (boots a real listening socket). `npm run e2e` — Playwright browser e2e (boots dev client + server).
- `npm run typecheck` — `vue-tsc --noEmit` (client) and `tsc --noEmit` (server + shared).
- `docker compose up` — server only, port 8787, live-reload on edits to `packages/server/src` or `packages/shared/src`.

---

## 3. The `SoundEngine` contract (the most important interface)

```ts
// packages/client/src/engine/types.ts
export interface SoundEngine {
  readonly engineType: string;
  trigger(freq: number | number[], duration: number, time?: number, velocity?: number): void;
  applyParams(params: Record<string, any>): void;
  dispose(): void;
}
```

**Why it matters:** this is the seam that lets `AudioEngine` swap engine types per track without `instanceof` checks. New engine types add a class implementing this interface and a factory entry — that's it.

### Contract rules
- **`trigger`** must accept either a single freq (mono) or an array (chord/polyphonic). Drum engines treat the array as "play each one" but in practice always receive a single freq.
- **`trigger.time`** is an `AudioContext.currentTime`-relative timestamp. Engines must use `setValueAtTime` / `linearRampToValueAtTime` etc. at this time — **never** schedule against `ctx.currentTime` directly inside `trigger`, because that defeats the sequencer's lookahead.
- **`trigger.velocity`** is `0..1`. Engines must clamp and apply to amp envelope max (or equivalent loudness control). Defaults to `1.0` if omitted.
- **`applyParams`** is sparse — it accepts a `Record<string, any>` and only updates fields that are present. Pattern across engines:
  ```ts
  if (params.xxx !== undefined) this.setXxx(params.xxx);
  ```
  This shape lets `AudioEngine` pass `track.engines[engineType]` directly and lets per-knob updates skip serialization gymnastics.
- **`dispose`** must `stop()` any active oscillators, `disconnect()` everything, and clear any active-source tracking sets. Called when a track swaps engine type or on full teardown.

### Per-engine params: `DEFAULT_PARAMS` pattern

Every engine exports:
```ts
export interface SynthEngineParams { osc1Type: OscillatorType; /* … */ }
export class SynthEngine implements SoundEngine {
  static readonly DEFAULT_PARAMS: SynthEngineParams = { /* … */ };
  // private fields initialize from DEFAULT_PARAMS
}
```

`@fiddle/shared`'s `project/factory.ts` (`freshTrack()`) builds each track's slice via `structuredClone(DEFAULT_*_PARAMS)`. **Deep clone is required** — nested ADSR objects would otherwise be shared by reference across tracks, and mutating track 0's filterEnv would silently bleed into track 1.

---

## 4. Inside `SynthEngine` (the non-trivial one)

```
SynthEngine
├── ctx: AudioContext (shared from AudioEngine, NOT owned)
├── masterVCA: GainNode (engine's local sum)
├── voices: SynthVoice[6]
└── activeVoiceIndex: round-robin pointer
```

### `SynthVoice` signal chain

```
osc1 ──┐
       ├─→ mixer ──→ filter ──→ voiceGain ──→ masterVCA
osc2 ──┘                          ▲              │
                                  │              └─→ (to engine's destination)
                            filterEnv → cutoff
                            ampEnv   → voiceGain.gain
```

- `OscillatorModule` wraps `OscillatorNode` + a per-osc gain (always-on; `osc.start()` runs at voice construction).
- `MixerModule` is a 2-channel sum with per-channel `setTargetAtTime` smoothing.
- `FilterModule` exposes its `BiquadFilterNode.frequency` and `.Q` as `inputs.cutoff` and `inputs.resonance` — the envelope writes directly to them.
- `voiceGain.gain` is the per-voice VCA; `ampEnv.trigger(voiceGain.gain, …)` drives it.

### Voice stealing
6 voices, round-robin via `activeVoiceIndex = (activeVoiceIndex + 1) % 6`. No activity tracking. A stolen voice mid-release is cut by the new trigger — handled cleanly by `STEAL_RAMP` (see Decisions appendix).

### Filter envelope math
```ts
const peakCutoff = clamp(20, 20000, this.baseCutoff * Math.pow(2, this.filterEnvAmount));
this.filterEnv.trigger(this.filter.inputs.cutoff, time, duration, this.baseCutoff, peakCutoff);
```
**`filterEnvAmount` is in OCTAVES, bipolar, range `±4`.** Positive sweeps up, negative sweeps down, zero is flat. Logarithmic so perceived sweep depth is consistent across all base cutoffs. See Decision D1.

### Live cutoff knob behavior
`applyParams({ filterCutoff })` writes `setTargetAtTime(baseCutoff, ctx.currentTime, 0.01)` to the live filter param so the knob sweeps sustaining notes. Active envelopes call `cancelAndHoldAtTime` on each new trigger, which preempts in-flight `setTargetAtTime` ramps — so the live knob never fights an active filter envelope. See Decision D5.

---

## 5. The shared `EnvelopeModule`

Used by **both** amp env and filter env in every `SynthVoice`. ADSR with two non-obvious properties:

- **`R` is duration, not a time constant.** Implementation uses `linearRampToValueAtTime(min, releaseTime + r)`. The original code used `setTargetAtTime` with `τ = R/3`, which is asymptotic and never actually reaches `min`. See Decision D2.
- **`STEAL_RAMP = 0.001s`** — a 1ms ramp from the held value to `min` before the attack starts. Eliminates voice-steal clicks. Shifts the attack window by 1ms (inaudible). See Decision D3.

The drum engines do **not** use `EnvelopeModule` — each implements its own bespoke amp envelope with `exponentialRampToValueAtTime` directly. This is intentional: drum envelopes are highly stylized (e.g. kick's pitch sweep + AD envelope is the kick character) and don't benefit from a generic ADSR.

---

## 6. `app/` — AppRuntime composition root & synthContext facade

> Was `useSynth.ts` — the "singleton-dressed-as-a-composable" — before Phase 5 (`feat/phase5-appruntime`, 2026-07-02; decision D17). Now: **nothing lives at module scope anywhere in the app.** `app/AppRuntime.ts` is the composition root that creates and owns every long-lived resource exactly once per page; `app/synthContext.ts` builds the injected facade the component tree consumes.

### Layout

```ts
// app/AppRuntime.ts
export interface AppRuntimeOptions {
  wsClientFactory?: WsClientFactory;  // test seam: fake sockets instead of real ones
  syncEnabled?: boolean;              // test seam: keep the WS layer dark
}

export interface AppRuntime {
  pinia: Pinia;
  store: ReturnType<typeof useProjectStore>;
  bus: CommandBus;
  session: SyncSession;
  audio: AudioEngine;
  shutdown(): void;   // idempotent full teardown
}

export function createAppRuntime(opts: AppRuntimeOptions = {}): AppRuntime { /* … */ }
```

`createAppRuntime()` wires **store → bus → session → audio**, in that order: it creates the Pinia instance and the `ProjectStore` (§13's `project` is born *here*, per Pinia instance — no module-scope singleton, no `reactive(freshProject())` anywhere else), then the `CommandBus` (`{ applySet: store.applySet, loadProject: store.loadProject, enqueue: (…) => session.enqueue(…) }`), then `SyncSession` (takes the bus), then `AudioEngine` (`{ project, subscribe: bus.subscribe }`). The bus↔session circularity — the bus needs `session.enqueue`; the session needs the bus for `applyRemote`/`resetWatermark` — resolves with a late-bound closure (`session` is `let`-declared and assigned before the enqueue arrow is ever invoked), not a setter API. `AppRuntimeOptions` (`wsClientFactory`, `syncEnabled`) are the test seams that replaced `useSynth`'s module-scope `setWsClientFactory`/`setSyncEnabled`.

### Lifecycle

**Every lifecycle event maps to exactly one explicit call:**

| Event | Wire |
|---|---|
| Boot | `main.ts` → `createAppRuntime()` |
| Page unload | `pagehide` → `runtime.shutdown()` |
| HMR swap (dev) | `import.meta.hot.dispose` → `runtime.shutdown()` (`main.ts` only) |
| Enter / leave room | `session.connect()` / `session.disconnect()` |
| Reconnect / logout | inside `SyncSession` (auth-id watcher calls `wsClient.reconnect()`) |
| bfcache restore | App.vue `pageshow.persisted` → force reconnect; audio re-boots lazily on next PLAY |

`main.ts` is **the only module that touches page lifetime or `import.meta.hot`** in the whole app — no `audio/`, `sync/`, `stores/`, or component module references either. `pagehide` also fires on bfcache-**freeze** (the frozen socket dies anyway; the restore path force-reconnects), so teardown now runs on a path where nothing did before — more correct, browser-verified.

`shutdown()` = `audio.dispose()` → `session.dispose()`, both idempotent, so a second call is a no-op. **Shutdown disposes resources; it does not brick the runtime**: `ensureAudio()` rebuilds from null and `connect()` works after `dispose()`, so the bfcache-restore path needs no special casing. HMR reality: Vue SFC edits self-accept and never reach `main.ts`; a non-accepted TS-module edit bubbles to the entry, Vite full-reloads, `pagehide` fires, and the same `shutdown()` runs. Either road ends at one `shutdown()` — **dispose-and-recreate**, never preserve-in-place. After this phase no `new SyncSession` / `new AudioEngine` / `reactive(freshProject())` exists at module scope anywhere — re-evaluating any module mints nothing, so the old "two audio cores" / phantom-presence bug class is structurally impossible.

### `createSynthContext` — the injected facade

`app/synthContext.ts`'s `createSynthContext(runtime: AppRuntime)` is called **exactly once**, by `App.vue` (the never-unmounting shell), and its return value is `provide`d under `SYNTH_CONTEXT`; `StudioView` and every panel `inject` it. The facade is `useSynth()`'s old return shape, unchanged for consumers, plus three Phase-5 additions:

- **Reactive data**: `project` (from `runtime.store`), `sequencer`/`currentStep`/`trackAnalysers`/`trackGains` (from `runtime.audio`), `bpm` (writable computed — its setter calls `dispatchLocal`, not a direct write), `activeTrackIndex`, `focusedTrack`, `sessionName` — all **per-context** (one per `createSynthContext` call, i.e. per page), replacing `useSynth`'s per-call refs over module-scope state.
- **Methods**: `togglePlay`/`stopPlayback`/`ensureAudio` (thin delegates to `runtime.audio`), `selectTrack`/`setFocusedTrack`, `addTrack`/`removeTrack`, `getTrackEngineType`.
- **Sync surface**: `fatalError`/`roomLoading`/`currentRoomId` (from `runtime.session`), `roster`/`selfClientId`, `connectToSession`/`leaveSession`.
- **Phase 5 additions** (were bare module-scope exports in `useSynth.ts`): **`dispatchLocal(path, value)`** — the single outbound entry point for a local edit; always routes through `runtime.bus.dispatchLocal`, so pre-connect edits still drive audio/UI without trying to sync (the enqueue sink is gated inside `session.enqueue`). **`endGesture(path)`** — flushes a knob's throttled outbox entry on gesture-end (`session.flushPath`). **`projectOps`** — the bulk-operation surface (below).

### The applied-command stream — how a write reaches audio

Every write — local dispatch, an applied remote op, a nack rollback, or a wholesale `loadProject` — funnels through the long-lived `CommandBus` (`sync/CommandBus.ts`) and, **synchronously in the same call stack as the state write**, emits on its `subscribe`-able applied-command stream:

```ts
type AppliedCommand = { kind: 'set'; path: Path; value: unknown } | { kind: 'replace' };
```

`AudioEngine` is the sole subscriber (subscribed once, at graph build — no per-room resubscribe): a `set` on an engine-param path re-reads the live slice and calls `applyParams`; on `engineType`/`enabled` it re-syncs that track's engine (`syncTrackToEngine`); on `mixer.*` it recomputes gains; anything else (bpm, steps, patternLength) is ignored — the sequencer still pulls those per tick, unchanged. A `replace` event (snapshot arrival, Open/New, room reset) re-runs the exact same full-track sync loop `buildAudioState` runs at boot — one idempotent path instead of a wall of per-slice watchers reacting to a wholesale swap. This is what replaced the old `flush:'sync'` Vue-watcher / audio-side `diffParams` machinery; see D17.

### Bulk operations — `projectOps` (draft-diff-dispatch)

`app/projectOps.ts`'s `createProjectOps({ project, bus, isSyncLive, enqueue })` gives `clearTrack`, `shiftTrack`, `fillTrack`, `applyPreset`, `initPatch`, `newProject`, `openProject` — every bulk mutation `StudioView` used to perform by mutating `project` in place. Each op computes a **draft** of the post-op value with pure helpers in `project/mutations.ts` / `project/preset.ts` (`clearTrackDraft`, `shiftTrackDraft`, `fillTrackDraft`, `applyPresetDraft`, `resetEnginePatchDraft` — nothing here mutates live state), diffs the draft against live state, and dispatches each changed **leaf** through `bus.dispatchLocal` — the bus performs the actual write, the stream emit, and the outbound enqueue; prior values for nack rollback come free from live (pre-write) state. `newProject`/`openProject` are the one exception: they replace the whole project via `bus.loadProject` (one `replace` stream event) and then only **enqueue** the outbound leaf diff of live-vs-before — leaf-dispatching a full file load would be thousands of redundant writes for no benefit.

---

## 7. `Sequencer.ts` — lookahead scheduler

Standard Chris-Wilson-style lookahead pattern. The Sequencer owns **no tracks and no bpm** — `start(ctx, getBpm, onStep)` takes a bpm getter and a callback, and emits a **monotonic absolute step index** (no modulo; consumers apply `% track.patternLength` per track — D15):

```ts
s.timer = setInterval(() => {
  const bpm = getBpm();
  if (bpm !== s.lastBpm) { /* rebase scheduleStartTime to the last scheduled step */ }

  const stepTime = (60 / bpm) / 4;             // 16th note in seconds
  const lookaheadTime = ctx.currentTime + 0.1; // schedule 100ms ahead
  let nextStepTime = s.scheduleStartTime + s.nextStepIndex * stepTime;
  while (nextStepTime < lookaheadTime) {
    onStep(s.currentStep, nextStepTime);       // ← engines schedule against THIS time
    s.currentStep = s.currentStep + 1;         // absolute, never wraps (D15)
    s.nextStepIndex += 1;
    nextStepTime = s.scheduleStartTime + s.nextStepIndex * stepTime;
  }
}, 25);
```

### Three non-obvious choices

**Absolute step counter.** `currentStep` increments forever (safe-integer headroom ≈ 35M years). Per-track looping is the consumer's job — the playback loop in `AudioEngine`, the Tracker active-row highlight, and the TrackMixer LED each apply `stepIndex % patternLength` independently, which is what makes polymeter work with one scheduler. See D15.

**Anchor + integer counter, not accumulator.** `nextStepTime = scheduleStartTime + nextStepIndex × stepTime` — no float drift over thousands of steps. The naive `nextNoteTime += stepTime` drifts ~1ms/min, usually negligible but trivially avoidable. See Decision D6.

**BPM-change rebase.** When the polled bpm changes mid-playback, we rebase `scheduleStartTime` to the last scheduled step's time and reset `nextStepIndex = 1`. The very next step uses the new `stepTime` forward. Without this, the next step would land on the old grid and feel like a one-step tempo lag.

### Callback contract
The callback `(stepIndex, time) => void` is invoked **for the audio time at which the step should sound**. Engines must schedule sound-emitting calls against `time`, not `ctx.currentTime`. Violating this defeats the lookahead and produces jitter.

### Reactivity boundary (post-A5)

`AudioEngine` wraps the sequencer with `reactive(new Sequencer())`. That makes `isPlaying` (the whole UI-facing surface — tracks and bpm live on `project`, not here) Vue-reactive — the PLAY button watches it.

The five scheduler internals (`currentStep`, `timer`, `nextStepIndex`, `scheduleStartTime`, `lastBpm`) live inside a `markRaw`'d `internals` object so Vue skips them during proxy setup. They're touched ~7× per setInterval tick during playback; without `markRaw` that's ~120ms/min of pointless proxy-trap overhead (not user-visible, but conceptually wrong: scheduler bookkeeping is not UI state, and `timer` is a `setInterval` return value that has no business being a Proxy).

**When adding new Sequencer fields:** ask "does the UI need to react to this?" UI-facing → add as a public field (reactive). Internal bookkeeping → add to `SchedulerInternals` and `this.internals`.

---

## 8. Master signal chain

Built in `buildAudioState()` on first PLAY:

```
engines[i] (enabled slots only) ─→ trackGains[i] ─┬─→ DynamicsCompressor ─→ masterGain(0.6) ─→ destination
        (i = 0..31; disabled slots have NO engine) └─→ trackAnalysers[i] (fftSize 1024)
```

- **`trackGains[i]` / `trackAnalysers[i]`** — built eagerly for all 32 pool slots: with no source connected they render nothing per quantum, and a fixed dense array keeps the Visualizer's by-index binding trivial. The analyser tees off each trackGain so the focused panel's oscilloscope shows only that channel; there is **no master analyser**.
- **`engines[i]`** — built **lazily per enabled slot** (E1). An engine's oscillators start at construction and never stop, and gain=0 does not stop a Web Audio subgraph from being processed — eagerly building all 32 slots cost ~190 always-running oscillators rendering silence. Enabling a slot constructs its engine (and applies the slice); disabling fade-disposes it via the same D4 path as an engine-type swap.
- **`trackGains[i]`** — per-track mute/solo/volume node. `updateMixerGains()` does smooth `setTargetAtTime(target, t, 0.015)` writes; solo is scoped to enabled tracks, and a disabled slot is always silent.
- **`DynamicsCompressor`** — threshold -12dB, ratio 12:1, attack 3ms, release 250ms. Absorbs transient peaks from simultaneous drum hits before they reach the master gain.
- **`masterGain.gain = 0.6`** — fixed headroom. Compressor sits *before* master gain by design; compressing after the master gain would either be too quiet to engage or already clipped.

### Engine-swap fade
When `state.engineType` changes, `syncTrackToEngine` fades `trackGains[i]` to 0 over ~20ms, then `setTimeout`-defers `dispose()` on the old engine. The new engine connects to the same `trackGain`; `updateMixerGains()` restores volume after. Prevents the click from `osc.stop()` + `disconnect()` on the outgoing engine. See Decision D4.

---

## 9. Component layer

```
App.vue                  ← shell: Sidebar + <router-view> + DialogHost + ErrorOverlay; creates the one
                            SynthContext via createSynthContext(runtime) — see §6
├── Sidebar.vue          ← nav (lobby/studio/account), roster chips, leave-session control
├── views/LobbyView.vue  ← session list (useLobby 30s visibility-aware poll) + CreateSessionDialog
├── views/AccountView.vue ← sign-in / username editor (§17)
└── views/StudioView.vue ← the DAW (channel-rack layout):
    ├── Tracker.vue          ← per-track rack column: step grid + chord/oct/len/velocity controls
    │   └── StepNumberInput.vue ← draft-ref + commit-on-change number input (OCT/LEN editing fix)
    ├── SynthPanel.vue       ← osc/mixer/filter/env knobs for the focused synth track
    │   ├── OscillatorPanel.vue
    │   ├── FilterPanel.vue
    │   ├── EnvelopePanel.vue   ← shows ⚠ when A+D > shortest active note
    │   └── MixerPanel.vue
    ├── KickPanel.vue / HatPanel.vue / SnarePanel.vue / ClapPanel.vue  ← drum knob clusters
    ├── TrackMixer.vue       ← volume/mute/solo strip over the enabled slots
    ├── Visualizer.vue       ← reads the focused track's trackAnalysers[i]
    └── Knob.vue             ← the reusable rotary control; formats: hz, ms, %, octave, semitones, db, none
```

**State direction:** `StudioView` passes each engine/drum panel a single `:params` prop — the reactive `focusedTrack.engines.<engine>` slice — for **reads only**. Panels bind knobs one-way (`:modelValue="params.<field>"`) and route every write through `useKnobSync(engine).set(field, value)` (`sync/knobSync.ts`), which calls the injected synth context's `dispatchLocal` → `CommandBus.dispatchLocal` — the single write funnel that updates `project`, emits on the applied-command stream (§6), and enqueues the outbound sync op. Panels never mutate the slice directly; there is no two-way `v-model` into `project` and no event-up plumbing. The remote-activity ring and gesture-end flush still key off `knobSync`'s `ks.pathFor(field)`. See D13/D14 (revised, Phase 5).

### CSS scoping convention (post-A4)

`App.vue` has **two style blocks**:

1. **Unscoped `<style>`** — the design system. Selectors here are global because child components render elements with these classes:
   - `.module-group` — every engine/drum/mixer/envelope panel uses it
   - `.module-group h3` — section header style
   - `.knob-row` — knob layout in panel components
   - `.rack-columns` / `.rack-column` — multi-column rack inside SynthPanel + drum panels
   - `.engine-section .module-group` (+ `:hover`) — cross-component hover effect: the focused engine section's panels light up in the active track's color
   - `body`, `header`, `h1` — element-level theme rules

2. **Scoped `<style scoped>`** — App.vue's own shell layout. View-specific layout (the channel rack, transport, etc.) lives in each view's own scoped block (`StudioView.vue` has its own). Vue's scoped CSS adds `data-v-*` attributes so these don't leak.

**Adding new selectors:**
- If a *child component renders* the element with this class → put the rule in App.vue's unscoped block.
- If only one component's template uses it → put it in that component's scoped block.
- All components other than App.vue use `<style scoped>` exclusively.

---

## 10. Testing

- **Mocking.** `vi.stubGlobal('AudioContext', MockAudioContext)` lets engine logic run in jsdom. Mocks provide `MockAudioParam` with the AudioParam methods we care about (`setValueAtTime`, `linearRampToValueAtTime`, `setTargetAtTime`, `cancelAndHoldAtTime`).
- **What we test.**
  - Engine triggers don't throw, clamp params correctly, forward velocity, hit `setTargetAtTime` for live params.
  - `SynthEngine` filter env: `min`/`max` passed to `EnvelopeModule.trigger` match `baseCutoff` → `baseCutoff × 2^amount`.
  - `Sequencer`: callbacks fire at expected times; BPM change mid-playback rebases anchor.
  - `EnvelopeModule`: trigger writes the expected ADR ramps with `STEAL_RAMP` offset.
- **What we don't test.** UI (`Tracker.vue`, `Knob.vue`). Audio actually-sounds-correct (no headless audio capture). Both are best done by ear.

`npm test` is the gate. `vue-tsc` + `vite build` must also stay clean.

---

## 11. Conventions

- **AudioParam writes:** prefer `setTargetAtTime(target, ctx.currentTime, 0.01-0.015)` for "smooth, immediate" changes; `setValueAtTime` only for sample-accurate-must-be-at-this-time; `linearRampToValueAtTime` for envelope segments. Raw `.value =` is forbidden — it causes zipper noise.
- **Param clamping:** every engine clamps its own params in setters. Don't trust upstream UI clamps as the only safety.
- **Scheduling:** anything inside `trigger(freq, duration, time)` must reference `time`, not `ctx.currentTime`.
- **Active sources:** if an engine creates dynamic `OscillatorNode`s or `AudioBufferSourceNode`s, track them in a `Set` and clean up via `onended`. `KickEngine` / `HatEngine` / `SnareEngine` / `ClapEngine` all follow this pattern; copy them.
- **Defaults:** new engines must declare `static readonly DEFAULT_PARAMS` and use it to initialize private fields. The track's `engines: EngineParamsMap` slice (`@fiddle/shared`) must reference the engine's `*EngineParams` type, not duplicate the shape.

---

## 12. Where to start when…

All client paths below are relative to `packages/client/src/`.

| Task | First file to read |
|---|---|
| Add a new engine type | `engine/KickEngine.ts` (smallest), `engine/types.ts`, `audio/AudioEngine.ts` (`engineFactories`), plus the per-engine-slice key list duplicated in `project/preset.ts`/`storage.ts`/`app/projectOps.ts`/`@fiddle/shared`'s `project/normalize.ts`, plus a panel taking a `:params` prop and a `<template v-else-if="focusedTrack!.engineType === '…'">` branch in `views/StudioView.vue` |
| Add a new knob to the synth | the relevant sub-panel (e.g. `components/FilterPanel.vue`) — add a `<Knob :modelValue="params.<field>" @update:modelValue="ks.set('<field>', $event)" :syncPath="ks.pathFor('<field>')" @gesture-end="ks.end('<field>')">` (`ks = useKnobSync('synth')`); `engine/SynthEngine.ts` (the `<field>` in `*EngineParams`/`DEFAULT_PARAMS` + setter + `applyParams` line), `engine/SynthVoice.ts` (param application), and the accept-list in `@fiddle/shared` if it should sync. **No `app/synthContext.ts` change** — the slice binding and the applied-command stream both pick it up automatically |
| Change envelope behavior | `engine/modules/Envelope.ts` (+ Decision D2/D3 in appendix) |
| Change sequencer timing | `sequencer/Sequencer.ts` (+ Decision D6) |
| Add a named preset | F1 (presets still open) in `CODE_REVIEW.md`; persistence itself is done — see §13 and `project/storage.ts` |
| Change project schema | `project/types.ts` (bump `PROJECT_SCHEMA_VERSION` — note: it currently re-exports from `@fiddle/shared`, so the bump lands in `packages/shared/src/index.ts`), `project/migrations.ts` (add handler), `project/storage.ts` (`reconcileWithDefaults` if new optional fields) |
| Add/change a bulk project operation | `app/projectOps.ts` (draft-diff-dispatch pattern — see §6); the pure draft producer lives in `project/mutations.ts` or `project/preset.ts` |
| Add a server route or evolve the WS protocol | `packages/server/src/server.ts` (registration), `packages/server/src/routes/` (handlers), `packages/shared/src/index.ts` (message types if shared with the client). See §14. |
| Add a symbol used by both client and server | `packages/shared/src/index.ts` only. Constraint: no DOM/Audio types, must stay JSON-serializable, must compile under both `moduleResolution: bundler` and `NodeNext`. |

---

## Appendix: Key design decisions

The non-obvious choices. Each lists the **decision**, the **alternative that was rejected**, and **why** — so future work can revisit them with full context instead of accidentally reverting them.

### D1 — Filter envelope amount is bipolar log-octaves, not linear Hz

**Decision.** `filterEnvAmount` ∈ `[-4, +4]` octaves. `peakCutoff = baseCutoff × 2^filterEnvAmount`, clamped to `[20, 20000]` Hz.

**Rejected alternative.** Linear `0..1 × 5000Hz` factor added to base cutoff.

**Why.** Musical perception of brightness is logarithmic. With a linear-Hz factor, a setting of 0.5 added 2500Hz: dramatic when base cutoff is 200Hz, inaudible when base cutoff is 8000Hz. Octaves give consistent perceived sweep depth regardless of base. Bipolar lets the envelope sweep *down* (useful for synth-bass plucks where the filter closes during the note).

### D2 — Envelope release is a linearRamp duration, not a time constant

**Decision.** `EnvelopeModule.trigger` uses `linearRampToValueAtTime(min, releaseTime + r)` for the release segment.

**Rejected alternative.** The original code: `setTargetAtTime(min, releaseTime, r / 3)`.

**Why.** `setTargetAtTime` is asymptotic — at `τ = r/3` it reaches ~95% of target at `r` but never actually reaches `min`. The R knob label was a lie; long releases left a persistent filter offset that never settled. Linear ramp means R now means **release duration**.

### D3 — 1ms `STEAL_RAMP` on every envelope trigger

**Decision.** Before the attack starts, ramp from the held value to `min` over 1ms.

**Rejected alternative.** `setValueAtTime(min, time)` (instant jump to floor).

**Why.** Voice stealing happens mid-release. An instant jump to 0 produces an audible click on the stolen voice. 1ms is below the perceptual threshold for envelope onset but eliminates the discontinuity.

### D4 — Engine-type swap fades `trackGain` to 0 before `dispose()`

**Decision.** When `state.engineType` changes, smooth `trackGains[i].gain` to 0 over ~20ms, then `setTimeout(dispose, 25)`.

**Rejected alternative.** Synchronous `oldEngine.dispose()` immediately.

**Why.** `dispose()` calls `oscillator.stop()` and `disconnect()` synchronously. Any active oscillator's release tail is amputated mid-cycle, producing a click. The new engine connects to the same `trackGain`; `updateMixerGains()` restores volume after the swap.

### D5 — Filter cutoff knob writes to the live AudioParam

**Decision.** `applyParams({ filterCutoff })` writes both the local `baseCutoff` field **and** calls `setTargetAtTime(baseCutoff, ctx.currentTime, 0.01)` on the filter's frequency param.

**Rejected alternative.** Only update `baseCutoff` and let it take effect on the next trigger.

**Why.** Users expect the cutoff knob to sweep sustaining notes (drone mode, long releases). Active filter envelopes call `cancelAndHoldAtTime` at each trigger, which preempts any in-flight `setTargetAtTime` — so the live write never fights an active envelope.

### D6 — Sequencer schedules from an anchor + integer counter

**Decision.** `nextStepTime = scheduleStartTime + nextStepIndex × stepTime`. On BPM change, rebase `scheduleStartTime` to the last scheduled step and reset `nextStepIndex = 1`.

**Rejected alternative.** Accumulating `nextNoteTime += stepTime` per step.

**Why.** Float accumulation drifts ~1ms/min — usually negligible, trivially avoidable. The BPM-rebase is the real win: without it, a tempo change schedules the next step on the old grid (one-step tempo lag); with it, tempo takes effect immediately.

### D7 — Each engine owns its defaults via `static readonly DEFAULT_PARAMS`

**Decision.** Every engine class exports `*EngineParams` interface and a `static readonly DEFAULT_PARAMS` of that type. `useSynth` `TrackState` references those types and builds slices via `structuredClone(EngineClass.DEFAULT_PARAMS)`.

**Rejected alternative.** Inline object literals in `useSynth` `trackStates` initialization (the original code, which also had a hidden `osc2Fine: index === 0 ? 10 : 0` asymmetry for a "fat-saw" demo state on track 0).

**Why.** Defaults were duplicated in three places (engine constructor, engine setter clamps, `useSynth` initialization) and silently diverged. Single source of truth eliminates that. `structuredClone` is required because nested ADSR objects would otherwise be shared by reference across tracks. The track-0 detune asymmetry should come back as an explicit named preset when F1 lands, not as hidden initialization magic.

### D8 — `useSynth` is an explicit lazy singleton, not a true composable

**[SUPERSEDED by D17, Phase 5 2026-07-02]** — useSynth.ts is deleted; the composition root (`app/AppRuntime.ts`) owns all resources and `createSynthContext` provides the facade.

**Decision.** Data state (`project`, `sequencer`) lives at module scope. **Audio state** (`AudioContext`, master chain, `trackGains`, engines, watchers) is held in a module-scope `audioState: AudioState | null` and built lazily on first `togglePlay()` / `ensureAudio()`. Watchers live inside an `effectScope(true)` so they can be stopped via `disposeSynth()`. `useSynth()` is idempotent — multiple calls return fresh local refs but share all module-scope state.

**Rejected alternative A (the original code).** All audio created at module load. `new AudioContext()` ran on import, before any user gesture — Chrome printed "AudioContext was not allowed to start". Watchers had no teardown path. `useSynth()` warned on second invocation because re-running the body would have leaked watchers.

**Rejected alternative B (true composable).** Instantiate `AudioContext` + engines inside `useSynth()`, tear down on unmount. Re-creates the AudioContext on every call (browsers limit concurrent contexts), duplicates watchers (doubling work per knob turn), and loses HMR state.

**Why this shape.** The lazy singleton is the middle ground that wins on every axis: no pre-gesture `AudioContext` creation, idempotent `useSynth()`, explicit teardown via `EffectScope` + `disposeSynth()`, single AudioContext for the page, and `project` survives HMR re-mounts of components (the module is cached). Knob turns before first play still mutate `project.tracks`; `ensureAudio()` builds engines from current state, so pre-play edits are honored on first play.

### D9 — Sync is per-field LWW path ops, not CRDT/OT; transport stays local

**Decision.** Collaboration ships project mutations as `{ path, value }` last-write-wins ops validated against a static accept-list, broadcast through a server op log. Audio and the sequencer playhead stay **local** to each client — only `project` data syncs.

**Rejected alternative.** A CRDT/OT document, or syncing transport (a shared playhead).

**Why.** The state is a small, shallow, JSON object where last-write-wins per leaf is musically acceptable (two people rarely fight over the same knob). LWW path ops are trivially serializable, diffable, and replayable from a ring buffer — orders of magnitude less machinery than a CRDT for this payload. Local transport preserves the "everyone fiddles on the same evolving loop" feel and avoids a shared-clock coordination problem. Breaking that (pattern chaining, timeline) is the explicit fork in [`ROADMAP.md`](./ROADMAP.md) §6.

### D10 — Network-applied writes are suppressed via a sync-flush watcher guard

**[REMOVED by D17]** — with the CommandBus as sole writer there is nothing to suppress; the flag, and the flush:'sync' coupling it required, are gone.

**Decision.** Inbound ops apply to `project` inside `enterSuppress()`/`exitSuppress()` (module-scope `applyingFromNetwork`), and every sync-participating watcher uses `{ flush: 'sync' }`.

**Rejected alternative.** Default async watcher flush + the same boolean guard.

**Why.** The guard only suppresses the echo if the watcher fires *synchronously inside* the suppressed write. With async flush the guard is already cleared by the time the watcher runs → the applied remote value is re-emitted as a local op → echo loop + snapshot flood. This is the single most load-bearing invariant of the sync layer; see §15 and the `sync_suppression_mechanism` memory.

### D11 — Live presence is tracked separately from the identity registry

**Decision.** The room keeps both an `identities` map (persists for resume) and a `connected` set (clients with a live socket right now). The roster broadcast is built from `connected`, not `identities`.

**Rejected alternative.** Build the roster from the identity registry (the original bug), or delete identities on disconnect.

**Why.** The registry must outlive a socket so a reconnecting client resumes its color/handle — but if the roster reads from it, departed clients linger as phantom chips forever. Deleting identities on leave fixes the roster but breaks resume (and loses color continuity on refresh). Separating the two satisfies both: roster = currently-connected; identities = resumable.

### D12 — The server is bundled with esbuild, not emitted with `tsc`

**Decision.** `npm run build:server` = `tsc --noEmit` (typecheck) then `esbuild … --packages=external --alias:@fiddle/shared=../shared/src/index.ts`, producing one self-contained `dist/index.js`.

**Rejected alternative.** `tsc` emit (the original), or giving `@fiddle/shared` its own build + `dist`.

**Why.** `@fiddle/shared` is source-only (`main` → `src/index.ts`) so dev (tsx/vite/vitest) resolves TS directly. A `tsc`-emitted server kept a bare `@fiddle/shared` import that Node resolved to that `.ts` source at runtime → `ERR_MODULE_NOT_FOUND`. Bundling inlines shared from source while keeping npm deps external, so the server is deployable without changing the zero-friction dev path.

### D13 — Knob `syncPath` is provided from `App.vue`, gesture-end is a direct outbox flush

**[REVISED by D17]** — reads still bind the reactive slice, but every write now flows through dispatch (`useKnobSync.set` → `ctx.dispatchLocal` → CommandBus); knobs never mutate the slice directly.

**Decision.** `App.vue` provides its `activeTrackIndex` ref (`ACTIVE_TRACK_KEY`); `useKnobSync(engine)` builds each knob's path from it. Knob `gesture-end` calls `endGesture(path)` → `Outbox.flushPath(path)`.

**Rejected alternative.** Have panels call `useSynth()` for the track index (each call mints a *fresh* `activeTrackIndex` ref, so they'd read `null`); and the plan's original `gestureEndingForPath` ref read by the watcher.

**Why.** Only `App.vue`'s `useSynth()` instance holds the real focused-track index, so it must be injected. And `gesture-end` fires on pointer-up *after* the final value change — there's no later watcher tick to read a flag — so the final throttled value must be flushed directly from the Outbox's pending map.

### D14 — Panels bind directly to the reactive engine slice (`:params`), not per-field computeds

**[REVISED by D17]** — reads still bind the reactive slice, but every write now flows through dispatch (`useKnobSync.set` → `ctx.dispatchLocal` → CommandBus); knobs never mutate the slice directly.

**Decision.** `useSynth` exposes a `focusedTrack` computed (`ProjectTrack | null`). `App.vue` passes each engine/drum panel one prop — `:params="focusedTrack!.engines.<engine>"` — and panels bind their knobs with `v-model="params.<field>"`. Mutating the slice writes straight through to `project` (it's the live reactive sub-object, passed by reference), driving the existing `useSynth` slice watchers (audio + outbox). The per-field projection wall (the `trackParam` helper + ~30 writable-computeds, plus `engineType`/`synthMode`) was deleted. Phase 1 of the panel-binding refactor; descriptor-driven panels are a deferred Phase 2 (see `ROADMAP.md`).

**Rejected alternative.** Keep the `trackParam` writable-computeds (the original): a single parameter's name was repeated ~6× across 4 layers (declaration, return, App destructure, `v-model:`, panel `defineModel`, `ks.pathFor`), so every new param/track/field paid that tax. Also rejected: a `:params` down + `@update` event up flow (reintroduces the per-field plumbing) and panels pulling the slice from a composable (couples panels to the global singleton).

**Why.** The slice binding deletes both `v-model` walls in one move while keeping panels explicit, prop-driven, and unit-testable. The value binding and the sync path are now orthogonal: `knobSync` still owns `syncPath`/gesture-end (D13), unaffected. "Mutating a prop" is only cosmetic here — the slice is a shared reactive store, exactly what the old computed setters wrote to; the repo has no ESLint and Vue does not warn on *nested* prop mutation.

### D15 — Variable track length is a play-window over a fixed 64-step buffer; the sequencer counter is absolute

**[REVISED by D17]** — `patternLength` now syncs via `dispatchLocal` → CommandBus (no `flush:'sync'` watcher, no `applyingFromNetwork` suppression guard), and the playback loop lives in `AudioEngine` (subscribed to the applied-command stream), not `useSynth` (deleted).

**Decision.** Each `ProjectTrack` always stores a 64-element `steps` buffer plus `patternLength` (1–64). Playback/render use only `[0, patternLength)`; buffered steps beyond the window keep their data (non-destructive shrink). The `Sequencer` emits a **monotonic absolute** step index (no `% 16`); the consumer applies `stepIndex % track.patternLength` per track — playback loop (`useSynth`), Tracker active-row highlight, and TrackMixer LED each mod independently. Tracks share a downbeat and loop at their own length (polymeter), realigning at the LCM. `patternLength` syncs as a normal discrete leaf op (`['tracks', i, 'patternLength']`, flush:'sync' + suppression guard).

**Rejected alternative.** Storing `steps` at exactly `patternLength` (destructive resize, smaller payload, more sync churn) — rejected for the non-destructive window. A per-track timer/clock (true per-track *speed*: triplets, swing, independent tempo) — rejected as out of scope; the absolute-counter model gives polymeter with one scheduler and could later take integer clock-dividers cheaply. See `docs/superpowers/specs/2026-05-30-variable-track-length-design.md`.

**Why.** The fixed buffer keeps the wire shape stable and the accept-list bounds simple, makes resize non-destructive, and keeps the `Sequencer` project-agnostic (it still just emits an index). The absolute counter has ~35M-years of safe-integer headroom at typical step rates.

### D16 — `clientId` stays per-connection; `userId` rides alongside on `Identity` (auth is additive, never collapsing the two)

**Decision.** Supabase Google sign-in is **optional and additive**: guests keep the zero-friction "open URL and jam" flow untouched. A logged-in client presents its JWT on the `hello` frame; the server verifies it **locally** (cached JWKS via `jose`, no per-hello network call) and resolves the room handle from the app-owned `profiles` table (custom username, falling back to the Google display name). The verified `userId` is carried on `Identity` **next to**, not in place of, the per-connection `clientId`.

**Rejected alternative.** Collapsing `clientId = userId` (one identity per account) — rejected because it reintroduces the multi-tab presence bug (two tabs of the same account would share/stomp one roster entry) and erases the per-connection grain future per-user features want. Storing the username in Supabase `user_metadata` instead of an app table — rejected because the app needs its own tables anyway; standing up the DB layer now (a `ProfileStore` interface, Postgres-backed in prod, in-memory fake for tests) avoids doing the work twice.

**Why.** Auth must not regress the guest path: the server runs **guest-only** when Supabase env is absent (verify rejects all tokens, profile store is empty/in-memory), and the client doesn't offer login. Login/logout triggers a **WS reconnect** (watching the session *user id*, not the token, so Supabase's silent token refreshes don't bounce the socket) so the server re-derives identity cleanly. Profile **writes** go browser→Supabase (RLS-guarded); the Fastify server only **reads** profiles with a privileged connection. See `docs/superpowers/specs/2026-05-30-auth-persistence-foundation-design.md` and §17.

Phase 5's AppRuntime does not change this — identity remains per-connection, owned by SyncSession.

### D17 — Unidirectional command architecture with an explicit composition root (Phase 5, 2026-07-02)

**What.** (a) A single long-lived `CommandBus` is the only gateway to project
state — `dispatchLocal` / `applyRemote` / `applyRollback` / `loadProject` all
converge on `ProjectStore.applySet`/`loadProject`, and the bus emits a
synchronous applied-command stream (`{kind:'set',path,value} | {kind:'replace'}`).
(b) `AudioEngine` subscribes to that stream instead of watching the reactive
project — the flush:'sync' slice-watchers and audio-side diff machinery are
gone. (c) Bulk operations (Clear/Shift/Fill, preset load, INIT PATCH) are pure
draft-diff-dispatch (`app/projectOps.ts`): helpers compute a draft, the diff is
dispatched leaf-by-leaf, the bus performs every write. (d) `AppRuntime`
(`app/AppRuntime.ts`) is the composition root: the only creator/owner of the
store, bus, `SyncSession`, and `AudioEngine`, with an idempotent `shutdown()`;
`main.ts` is the only module that touches page lifecycle (`pagehide`) or
`import.meta.hot`. (e) `project` is created per Pinia instance (per page / per
test runtime) — nothing lives at module scope.

**Why.** The app's old invariant — "useSynth.ts is evaluated exactly once per
page" — put the AudioContext, scheduler interval, and WebSocket in
module-scope with no owner and no teardown: HMR minted parallel cores
(duplicate audio, phantom room members) and reconnects leaked sockets. Making
teardown first-class and state single-writer removes the whole bug class
structurally: re-evaluating any module mints nothing, every lifecycle event
maps to one explicit call, and audio reacts to the same stream that carries
every write (local, remote, rollback, replace) — no suppression flag, no
watcher-flush coupling. Supersedes D8 and D10; revises D13/D14 (writes
dispatch; reads still bind). Design: `docs/superpowers/specs/2026-07-02-phase5-appruntime-design.md`.

### D18 — Sync-catch-up invariants: watermark = applied content; snapshot-required until satisfied (2026-07-04)

Two invariants repaired after the reload-blank P0 (a signed-in reload showed a
fresh default project with the outbound gate open — edits could clobber room
data; the same mechanism most plausibly explains the June prod data-loss
incident):

- **`opIdLastSeen` records applied content, never a promise of it.** The
  `welcome` handler must not adopt the server's `opIdHead`; the watermark
  advances when content actually lands (the `snapshot` frame, each applied
  `set`, and `sync.complete` as the replay-path finalizer). Consequence: a
  connection that dies mid-catch-up resumes from what it truly applied, and
  the server replays the difference — correct by construction.
- **"I need a snapshot" is a fact about local state, not about a connection
  attempt.** `WsClient.snapshotRequired` is set when the caller has blanked the
  local project (room entry) and cleared only when a snapshot arrives. Any
  number of reconnects in between (auth re-handshake, transient drop) keep
  requesting a snapshot. A `connect()` call never clears it.

Supporting rule: the first socket open of a room connection waits on
`useAuth().ready`, and the auth-reconnect watcher ignores identity flips while
the socket has never connected (`state === 'closed'`) — the pending hello reads
the token fresh, so there is nothing to re-derive. This removes the boot-time
guest-hello → auth-reconnect double handshake rather than merely surviving it.

### D19 — Bulk project load is a protocol message, not an op storm (2026-07-04)

OPEN/NEW in a live session used to sync via the whole-project leaf diff — one
`set` op per changed leaf. Any import over the server's per-connection budget
(TokenBucket: burst 200, 100 ops/sec) had its tail nacked `rate.limited`, and
the Outbox rolls nacked leaves back to their priors — during an import, blank
defaults. Silent, timing-dependent data loss (reproduced 2026-07-04 with a
266-op project).

Now: the client sends one `load` message (full project); the server validates
(Schemas.Project + normalizeProject), atomically replaces the room doc via
`RoomStore.replaceProject` (consumes one opId, CLEARS the op log so any
pre-load watermark falls into the existing snapshot catch-up path), and
broadcasts the existing `SnapshotMessage` to every socket — the originator's
copy doubles as the ack. Capability-gated: welcome advertises
`capabilities: ['load']`; without it the client falls back to the leaf diff
(old servers fatally close on unknown message types). Invariants:

- A load is a replay horizon: `getOpsSince(< load opId)` returns null.
- Loads share the clientSeq counter with set ops (disjoint seqs ⇒ nacks route
  unambiguously: LoadTracker first, Outbox otherwise).
- Loads are NOT deduped server-side; a resend re-applies identical content.
- One in-flight load per client (LoadTracker), resend-once on ack timeout,
  rollback-to-prior on nack/second timeout. A socket close while a load is
  still pending drops it WITHOUT rollback but forces a full-snapshot catch-up
  on the next hello (`WsClient.requireSnapshot`) — a resume delta alone can't
  tell an applied load from one lost in transit (the load frame never reached
  the server, so its op log wasn't cleared and `getOpsSince(watermark)` comes
  back empty with no snapshot); only forcing a snapshot reconciles both cases.

---

## 13. The Project module

`packages/client/src/project/` is the single source of truth for all user-editable state. Full design rationale lives in [`docs/superpowers/specs/2026-05-23-project-model-design.md`](./superpowers/specs/2026-05-23-project-model-design.md). The canonical `Project` schema now lives in `@fiddle/shared` (see §14) so the WebSocket sync server speaks the exact same project shape without pulling in DOM/Audio types; the client re-exports it through the project barrel.

**What lives here and what doesn't.** `Project` holds `bpm`, a fixed pool of **32 `ProjectTrack` slots** (each with `enabled`, `engineType`, `engines: EngineParamsMap`, `mixer`, a `patternLength` (1–64), and a fixed 64-element `steps` buffer), and a `schemaVersion` field. The `enabled` flag is how tracks are added/removed — disabling is non-destructive (the slot keeps its data; re-enabling restores it), and the pool's fixed size means the wire shape never changes. `patternLength` is the play/render window — steps at indices `>= patternLength` retain their data but neither play nor render, so shrinking is non-destructive (D15). Playback state (`isPlaying`, `currentStep`), audio graph handles, and per-user UI focus (`activeTrackIndex`) are *not* part of `Project` — they're ephemeral runtime state split between `AudioEngine` (`isPlaying`, `currentStep`) and the injected synth context (`activeTrackIndex`) — see §6. Mono vs. chord (poly) behaviour is not a track-level field; the sequencer reads `track.engines.synth.mode` (`'mono' | 'poly'`) directly from the synth engine's params at trigger time.

**Dense engine map.** Every `ProjectTrack` stores a full `EngineParamsMap` — all five engine param sets at once, regardless of which engine is active. This means an engine-type swap is a single-field write (`engineType` only); the new engine's params are already in place. It also means per-engine edits survive a round-trip through any other engine type. See the spec §2 for the rejected alternatives (sparse map, discriminated union) and why the dense shape was chosen.

**Schema versioning.** `Project.schemaVersion` is a literal integer (`2` today — bumped from 1 for the 64-step buffer + `patternLength`; the bump also makes the server's `hello` check reject stale 16-step browser tabs). When a breaking field change is required, increment `PROJECT_SCHEMA_VERSION` (it lives in `@fiddle/shared`) and add a handler to the `migrations` registry in `migrations.ts`. `deserializeProject(text)` always calls `migrateToLatest(raw)` before reconciling, so old `.prj.json` files are silently upgraded on open. The migration registry is a plain `Record<number, (old) => newer>` dispatch table — add entries, never remove them. Additive changes (new optional fields with defaults) can use `reconcileWithDefaults` in `storage.ts` without a version bump.

**Persistence (where saving actually happens).** There is **no localStorage project path** — `loadProject()`/`installAutoSave()` were removed (review S1, 2026-06-09): the app is session-only, `connectToSession` resets the local project before the room snapshot replaces it, so a locally-persisted project was never rendered and the autosave silently overwrote pre-session work. Durable persistence is server-side: every edit reaches the room over WS and the server's autosave layer snapshots it to Postgres (§14b). Explicit file Save/Open (below) is the offline story. Two repair layers guard the boundaries: `normalizeProject` (`@fiddle/shared`) does **structural** repair (pool size, 64-step buffers, engine slices present, bpm coerced) at every sync/persistence boundary, while the client's `reconcileWithDefaults` additionally heals **param-by-param** against engine defaults on the file-open path.

**File I/O.** `packages/client/src/project/file-io.ts` adds explicit Save / Open support. `serializeProject(project)` and `deserializeProject(text)` (both in `storage.ts`) are the round-trip helpers: `serializeProject` calls `toRaw` before `JSON.stringify` so Vue proxy metadata never reaches the file; `deserializeProject` runs the full `migrateToLatest` + `reconcileWithDefaults` pass, so a partial or older-schema file is upgraded and filled to current defaults. `replaceProject(target, source)` mutates `target` in place to match `source` — preserving the reactive proxy identity — so the watchers that hold references to `project.tracks[i]` don't need teardown on Open (the same helper applies incoming room snapshots, §15). `saveProjectToFile` / `openProjectFromFile` (the two public helpers in `file-io.ts`) feature-detect the File System Access API and fall back to a download-anchor / `<input type="file">` pair for browsers that don't support it. Both functions return `null` / resolve silently on user cancellation. `ProjectFileError` is the typed error for unreadable JSON, failed migrations, and future `schemaVersion` values the current code doesn't understand. The canonical extension for new project saves is `.prj.json`; the open picker also accepts plain `.json` for legacy files. All three helpers (`serializeProject`, `deserializeProject`, `replaceProject`) are re-exported from `packages/client/src/project/index.ts` alongside the `file-io.ts` exports. Long-form design rationale lives in [`docs/superpowers/specs/2026-05-24-project-file-io-design.md`](./superpowers/specs/2026-05-24-project-file-io-design.md).

**Engine presets.** A preset is a single engine's choice + its full param
set, serialized as a `.chnl.json` file. Distinct from `.prj.json` project
files (which capture the whole project — track pool + BPM + steps).
`packages/client/src/project/preset.ts` defines the `Preset` type, `makePreset` factory,
`serializePreset` / `deserializePreset`, and `applyPreset(track, preset)`
which mutates a track in place — sets `engineType`, `Object.assign`s
`params` into the matching engine slice, and leaves the other engines on
that track, the mixer, and the steps untouched (so toggling back to a
previously-active engine restores its prior params). File I/O lives in
`packages/client/src/project/preset-file-io.ts` and follows the same picker + fallback
pattern as project save/open. Presets carry their own
`PRESET_SCHEMA_VERSION` (currently `1`), independent from `PROJECT_SCHEMA_VERSION`.

---

## 14. The collaboration backend (`@fiddle/shared` and `@fiddle/server`)

Real-time multi-user collaboration is **implemented and deployed**. **Audio stays local** in each browser — the server carries only project-state mutations. The detailed design lives in [`docs/superpowers/plans/2026-05-28-websocket-sync-protocol.md`](./superpowers/plans/2026-05-28-websocket-sync-protocol.md); §14–§16 here are the living overview.

### `@fiddle/shared` (`packages/shared/`)

A framework-free package that compiles in both the browser (`moduleResolution: bundler`) and Node (`moduleResolution: NodeNext`). It is the **canonical home of the project schema, the wire protocol, and the sessions-API contracts** — both client and server import the same definitions so they cannot drift:

- `engines/` — per-engine param shapes + `DEFAULT_PARAMS` (moved out of the client engine files so the server can build a default project without DOM/Audio types).
- `project/` — `Project` / `ProjectTrack` / `Step` types, `freshProject()`, the shared **constants** (`TRACK_POOL_SIZE=32`, `STEP_BUFFER_SIZE=64`, `BPM_MIN/MAX`, defaults), a **Zod schema**, the **accept-list** (`validatePathAndValue(pathStr, value)` in `accept-list.ts`: the allow-list of writable project paths plus value/range validation — the server's authorization boundary for inbound ops), **`normalize.ts`** (`normalizeProject` + `coerceBpm` — idempotent structural repair run at every sync/persistence boundary: exactly 32 slots, 64-step buffers padded, all engine slices present, ≥1 enabled track, bpm coerced), and **`snapshot-codec.ts`** (`packProject`/`unpackProject` — the sparse `StoredProject` form persisted to the DB: pristine disabled slots are omitted, cutting the stored blob down from the full 32-slot shape).
- `protocol/` — wire message types + Zod schemas, `PROTOCOL_VERSION`, and identity constants (the color `PALETTE`, animal `HANDLES`, `randomBase32`).
- `session/` — the `/api/sessions` contracts: `CreateSessionBodySchema` / `PatchSessionBodySchema`, `LobbyEntry`, and `SessionSettings` (stored per session; `maxWritableUsers` / `tracksPerUser` are stored + shown but inert until observer mode / per-user track pools land).
- `path.ts` — `setDeep(obj, path, value)` (throws on a broken path) and `pathKey(path)` (= `JSON.stringify(path)`), shared by the client Outbox/CommandBus and the server store.

**Constraint:** anything in `@fiddle/shared` must stay portable — no DOM, no `AudioContext`, no Vue, no Node-only modules. Litmus test: "could a Cloudflare Worker or a CLI import this?"

### `@fiddle/server` (`packages/server/`)

- **Stack:** Fastify 5 + `@fastify/websocket` 11 (wraps `ws`) + `@fastify/cors` + `postgres` (porsager). `moduleResolution: NodeNext`. **Built via esbuild** (not `tsc` emit) — see §16. Dev runs via `tsx watch src/index.ts`.
- **Entry / construction:** `src/index.ts` loads env, starts the (opt-in) OTel SDK, installs the process safety net, and listens on `PORT` (default `8787`) / `HOST` (default `0.0.0.0`). `src/server.ts` `buildServer()` constructs Fastify (`trustProxy: true` — Render terminates TLS at its proxy and the per-IP create limit needs real client IPs), registers CORS + websocket + routes, and wires the shared `InMemoryRoomStore`, `ConnectionPool`, `SessionStore`, `ProfileStore`, and `SessionSync` (§14b). With no `DATABASE_URL` / `SUPABASE_JWKS_URL` the server runs fully in-memory and guest-only — the same graceful degradation as §17. The pure-construction split lets tests use `.inject()` and lets the protocol e2e boot it on an ephemeral port.
- **Routes:** `GET /health` → `{ ok: true }` (liveness probe — deliberately DB-free, so it stays 200 through a database outage); the **`/api/sessions` CRUD** (§14b); `GET /ws/:roomId` → adapts the raw socket to a `SocketLike`, registers it in the `ConnectionPool`, and delegates frames/close to a per-connection `ConnectionHandler`. On socket close the route also fires `sessionSync.handleDisconnect(roomId)` — every disconnect is a persistence boundary.
- **`RoomStore` (`room/`):** the only legal surface for live room state. `InMemoryRoomStore` holds, per room: the canonical `Project`, a ring buffer of recent `AppliedOp`s (`RING_BUFFER_CAPACITY=1000`) plus an **O(1) `(clientId, clientSeq)` dedup index** mirroring it (E2 — appendOp is the hottest path; entries are evicted in the same splice), the identity registry, a **live `connected` set** (presence, distinct from identities — see D11), a **dirty flag + monotonic version** (consumed by the autosave flush, §14b), and a grace timer (`GRACE_MS=5min`). `cancelGrace` also **awaits an in-flight expiry chain**, so a hello can never race a room that is mid-teardown (M3a). All methods are async so a future Redis-backed sibling can drop in.
- **`ConnectionHandler` (`sync/`):** per-connection lifecycle — validates every frame with the Zod `ClientMessageSchema`, enforces hello-first ordering, assigns/resumes identity, runs catch-up, validates+appends+broadcasts ops, answers mid-session `resync` requests, and fans presence updates. **Session-scoped room init:** a room is materialised only for a real session — if not already live in memory, the injected `loadSession` reads the durable snapshot (capped at `SESSION_LOAD_TIMEOUT_MS=8s` via `withTimeout`; a wedged DB read becomes a retryable `overloaded` fatal instead of an infinite loader), and a null result is a fatal `session.not_found` (auto-mint is gone). A guest presenting a clientId that is **already connected** (duplicated browser tab — sessionStorage is copied) gets a fresh identity + non-fatal `resume.duplicate_client` instead of a colliding resume (M3b). `Heartbeat` (30s ping / 60s pong-timeout) reaps dead sockets — and because it only starts *after* hello, a never-helloing socket is closed by the `HELLO_DEADLINE_MS=15s` deadline instead of squatting. `TokenBucket` rate-limits ops; `ROOM_CAP=4`.
- **`processSafetyNet.ts`:** logs-and-survives `unhandledRejection` — porsager/postgres emits its own uncatchable rejection on a fatal pooler error, separate from the awaited query promise, and the default process-kill turned transient DB blips into crash-restart loops. `uncaughtException` deliberately still crashes.
- **`otel/` (opt-in via `FIDDLE_OTEL`, never set in prod):** WS frame counters/sizes by message type, DB call spans/durations/blob sizes wrapped around the stores, and trace-correlated log records for the domain events ("client live", "guest session pruned", "session flush failed"). Without the env var every instrumentation call is a no-op.

### 14b. The durable session layer (`session/`, `routes/sessions.ts`)

Sessions are the durable unit: a `sessions` row (metadata: name, description, owner, settings) plus a `session_snapshots` row (the packed project blob), both in Supabase Postgres. The **in-memory room is a live cache over the durable session** — seeded from the snapshot on first join, flushed back on a schedule, and pruned when truly unreachable.

- **`SessionStore`** — async interface mirroring `RoomStore`/`ProfileStore`; `PostgresSessionStore` in prod (privileged `DATABASE_URL` connection; snapshots packed via `packProject`), `InMemorySessionStore` for tests/no-DB. Metadata and the snapshot are deliberately separate (the lobby lists metadata frequently; the blob loads only on join). `saveSnapshot` is an exists-guarded upsert — a no-op when the session row is gone, which is what makes the flush-vs-delete race safe.
- **`SessionSync`** — couples the two stores; owns all persistence side effects:
  - **Autosave sweep:** every `FLUSH_INTERVAL_MS=60s`, flush all dirty rooms (an `isFlushing` guard prevents overlap). Each flush is `peekProject` → `normalizeProject` → `saveSnapshot` → **version-gated `clearDirty`** — the room version is captured at read time, and the dirty flag clears only if no op landed mid-flush, so a racing write stays dirty for the next sweep (no lost update).
  - **`handleDisconnect(roomId)`:** flush on every socket close — a network-blip/crash boundary. Deliberately non-destructive: the room (and its session row) must survive the grace window so a reconnect can resume it (review M1 — deleting the guest row here made every post-rejoin flush a silent no-op).
  - **`handleGraceExpiry(roomId)`:** the room's true end of life (grace timer fired with no reconnect; injected into `ConnectionHandler` as `onGraceExpire`). Ordering matters: final flush (while the room still exists) → delete a **guest-owned** session row (a guest has no way back to it; cascades the snapshot) → prune the in-memory room. Owned sessions keep their row forever.
  - **Stale-guest sweep:** every 60th flush tick (~hourly), delete guest rows idle past `STALE_GUEST_SESSION_MS=7d` with no live room — mops up sessions whose grace-expiry never fired (created-but-never-joined, or the room was lost to a restart) (M4).
  - **Graceful shutdown:** Fastify's `onClose` stops the sweep, then `flushAllDirty()` — so SIGTERM (deploys) persists everything first.
- **`/api/sessions` (lobby CRUD):** `GET /api/sessions` lists durable metadata merged with live member counts — **guest-owned sessions are listed only while occupied** (`buildLobbyList`), so an abandoned guest room disappears from the lobby immediately, before its row is pruned. `GET /:id` returns metadata (no blob) for the studio's settings panel. `POST` creates row + initial snapshot (the creator can upload a seed project); bearer JWT → logged-in owner, else guest (requires the browser's stable `clientId`); **per-IP rate-limited** (burst 5, sustained 2/min — M4). `PATCH` (name/description/settings) requires ownership: matching `userId`, or for guests a matching `ownerClientId` (acknowledged-weak until the moderation spec). `DELETE` is logged-in-owner only — guest sessions self-prune.

## 15. Real-time sync protocol & the client sync layer

**Model:** per-field **last-write-wins** ops over JSON paths. Audio is local; only `project` mutations cross the wire. There is **no shared transport** — each client runs its own `Sequencer` and PLAY/position are local; only data (steps, bpm, params) syncs.

**Handshake / lifecycle** (one `ConnectionHandler` per socket):
1. Client → `hello` (schemaVersion, optional auth token, optional `clientId` + `resumeFromOpId` for reconnect). The room's durable project loads here if it isn't live in memory (§14b); a socket that never sends hello is closed after 15s.
2. Server → `welcome` (assigned `clientId`, color, handle, auth state, `opIdHead`, roster) → catch-up (**replay** ops from the ring buffer if the client is close enough, else a full **snapshot**) → `sync.complete`.
3. Steady state: client → `set` (`clientSeq`, `path`, `value`); server validates against the accept-list, appends with a server `opId`, and broadcasts `set` to the room (echo to the originator carries `clientSeq`; peers don't see it). A duplicate `(clientId, clientSeq)` — an idempotent resend — is confirmed by echoing the already-applied op rather than nacked. Rejected ops get a `nack` (`path.invalid` / `value.invalid` / `rate.limited`).
4. **Mid-session repair:** if a client sees a broadcast `opId` skip ahead of its `opIdLastSeen`, it sends `resync(fromOpId)` and the server re-runs catch-up (replay or snapshot) ending in another `sync.complete`. Per-path opId guards in `CommandBus.applyRemote` keep older replayed ops from clobbering newer gapped ones.
5. `presence.update` fans the roster on join/leave; `ping`/`pong` heartbeat; `error` (fatal closes the socket — e.g. `room.full`, `schema.version_mismatch`, `session.not_found`, `auth.invalid`, `overloaded`; non-fatal like `resume.unknown_client` / `resume.duplicate_client` / `resume.client_ahead` does not).

**Wire path shape:** `Path = ReadonlyArray<string|number>` (array form). The server bridges to the dot-string the accept-list wants via `path.join('.')`.

**Client sync layer (`packages/client/src/sync/`):**
- **`WsClient`** — connection state machine (`closed → opening → catching-up → live`); persists `{ clientId, opIdLastSeen, clientSeq }` per room in `sessionStorage` (per-tab, so two tabs are two clients) and reconnects with `resumeFromOpId`. The persisted state is **cached in memory with write-through** (E3) — per-inbound-op reads (gap check, `recordOpIdSeen`) and per-edit `clientSeq` bumps cost no `getItem`/`JSON.parse`, while every mutation still hits storage synchronously so crash-resume semantics are unchanged. Reconnect backoff 1s→30s, reset on `sync.complete`; the resync in-flight guard re-arms after 5s so a dropped resync can't wedge gap repair.
- **`Outbox`** — sits between the watchers and the socket: 50ms per-path **throttle**, path-keyed **coalesce**, an **offline queue** (last-write-wins while disconnected, flushed on reconnect), **nack rollback** (every entry remembers its `priorValue`), **ack-timeout resends** (4s, up to 3 — same `clientSeq`, so the server's dedup confirms instead of double-applying; guaranteed local delivery), **`reassertPending()`** (re-applies + re-queues un-acked edits after a snapshot overwrites local state, so a server repair can never erase a pending change), and **`flushPath(path)`** for immediate gesture-end flush.
- **`messageDispatch`** — the server-message switch, now routed through the `CommandBus` (§6) instead of direct `project` mutation. Snapshot apply = `normalizeProject` → `commandBus.loadProject` (one `replace` stream event) → `resetWatermark` → `reassertPending`. For `set`: detects opId gaps (→ `requestResync`), and **skips the write for an echo of our own op when a newer local edit is pending for that path** (M2 — during a drag the echo carries the value from ~RTT ago; writing it back snapped the knob and its sound backward) via `commandBus.advanceWatermark`; otherwise applies it through `commandBus.applyRemote`, which also owns the per-path opId guard (replayed older ops can't clobber newer ones).
- **`presence`** — reactive roster (drives the `Sidebar` chips) + a per-path "touched" map that fades the `Knob` activity ring when a peer edits that path.
- **`knobSync`** (`useKnobSync(engine)`) — builds each knob's `syncPath` (`['tracks', activeTrackIndex, 'engines', engine, field]`, injected from `App.vue` via `ACTIVE_TRACK_KEY`) and routes `gesture-end` → `endGesture` → `Outbox.flushPath`. `TrackMixer` builds `['tracks', i, 'mixer', 'volume']` from its loop index directly.

**There is no suppression mechanism any more (D10 — removed by D17).** Every inbound write — a remote op (`commandBus.applyRemote`), a snapshot (`commandBus.loadProject`), or a nack rollback / reassert (`commandBus.applyRollback`, called from `Outbox`'s `applyLocal`) — is applied directly. With the `CommandBus` as the sole writer there is no outbound Vue watcher left to observe the reactive `project` and re-enqueue the change as a local op, so there is nothing to suppress and no `flush:'sync'` dependency. (The old `applyingFromNetwork`/`enterSuppress`/`exitSuppress` mechanism and why it used to be load-bearing are preserved for historical context in D10 and the `sync_suppression_mechanism` memory.)

**Outbound coverage:** every local edit dispatches through `CommandBus.dispatchLocal` at **leaf** granularity directly — a knob write is one `dispatchLocal(path, value)` call (`useKnobSync.set` / `useCommandModel`), not a diffed watcher snapshot. Bulk operations (Clear/Shift/Fill, preset load, INIT PATCH) go through `app/projectOps.ts`'s draft-diff-dispatch, which diffs a computed draft against live state and dispatches each changed leaf the same way (whole-object writes are forbidden by the accept-list either way — see §6). Discrete edits (selects, toggles — `engineType`, `muted`, `note`, …) flush immediately (`gestureEnd: true`); continuous knob drags ride the `Outbox`'s throttle and flush on gesture-end.

## 16. Deployment

Three services: **client on Vercel**, **server on Render**, **database (Postgres + auth) on Supabase**. Client and server are cross-origin in prod: the WebSocket needs no CORS, but the **`/api` routes do** — the server registers `@fastify/cors` with `resolveCorsOrigin()` (`CORS_ORIGIN` env, falling back to permissive in dev).

- **Client (Vercel).** `vercel.json` pins the Vite preset, `buildCommand: npm run build -w @fiddle/client`, `outputDirectory: packages/client/dist`. Required pieces: (1) **`VITE_WS_URL`** = the server **origin only** (e.g. `wss://fiddle-server.onrender.com`) — the client appends `/ws/<roomId>` itself (`SyncSession.buildConnection`); (2) **`VITE_API_URL`** = the server origin for the `/api/sessions` HTTP client (`sessionsApi.ts`); (3) **`VITE_SUPABASE_URL`** / **`VITE_SUPABASE_ANON_KEY`** for sign-in (§17 — absent = guest-only). All compiled in at build time, so changing them needs a redeploy. If unset, WS/API fall back to same-origin (the dev-proxy case). (4) An **SPA rewrite** `"/(.*)" → "/index.html"` in `vercel.json` — without it, refreshing or sharing a `/r/<room>` deep link 404s (the monorepo config doesn't get Vite's default SPA fallback).
- **Server (Render).** `render.yaml` Blueprint: a single-instance web service, `buildCommand: npm ci && npm run build:server`, `startCommand: node packages/server/dist/index.js`, health check `/health` (DB-free by design — it stays green through a database outage, which is exactly what made the 2026-06-06 incident diagnosable). The build is `tsc --noEmit` (typecheck) **then esbuild** — `esbuild src/index.ts --bundle --format=esm --packages=external --alias:@fiddle/shared=../shared/src/index.ts` — which **inlines `@fiddle/shared` from source** into a single `dist/index.js` while keeping real npm deps external. (Plain `tsc` emitted a bare `@fiddle/shared` import that Node resolved to the package's `.ts` source `main` → `ERR_MODULE_NOT_FOUND` at runtime.) Server env: `DATABASE_URL` (the Supabase **pooler** string — see below), `SUPABASE_JWKS_URL`, optional `CORS_ORIGIN`; `FIDDLE_OTEL` is dev-only and never set here.
- **Supabase pooler constraints.** `db/postgresOptions.ts` sets `prepare: false` — the transaction pooler doesn't support prepared statements, and leaving them on caused the prod crash-loop fixed 2026-06-05. `processSafetyNet` (§14) absorbs the pooler's out-of-band rejections; the 8s `withTimeout` on session loads (§14) bounds a wedged DB read. Free-tier Supabase can pause the database entirely (the 2026-06-06 outage) — `/health` stays up, WS joins fail fast with retryable `overloaded`.
- **Constraints that follow from the in-memory room store:** keep Render at **one instance** (live rooms are per-process; scaling out would split collaborators). Free tier spins down on idle (cold start ~30–60s). A restart/redeploy is **not** data loss: sessions are durable in Supabase, graceful shutdown flushes all dirty rooms, and rooms reseed from their snapshots on the next join. What a restart does lose is the in-memory op ring buffer — reconnecting clients fall back to a snapshot (and a fresh identity via the non-fatal `resume.unknown_client` path), so nothing breaks.

## 17. Auth & persistence foundation (Milestone 1)

Optional Google sign-in over Supabase Auth, layered onto the existing sync backend **without changing the guest flow**. Design: [`docs/superpowers/specs/2026-05-30-auth-persistence-foundation-design.md`](./superpowers/specs/2026-05-30-auth-persistence-foundation-design.md). The load-bearing decision is **D16** (`clientId` stays per-connection; `userId` rides alongside).

**Data flow on `hello`:**
1. Client attaches its Supabase access token to the `hello` frame (`WsClient.getToken`, read fresh each handshake; guests omit it).
2. Server `verifyToken` (`auth/verifyToken.ts`) verifies the JWT **locally** against a cached remote JWKS (`jose`, no per-hello network call) → `{ userId, googleName }`. An invalid/expired token is a **fatal `auth.invalid`** (no silent downgrade to guest).
3. Server looks up the username in `profiles` via the **`ProfileStore`** (`profile/`) — `PostgresProfileStore` in prod (privileged connection, bypasses RLS), `InMemoryProfileStore` for tests/fallback — and builds an authenticated `Identity` (`makeAuthenticatedIdentity`): handle = username ?? googleName, `authenticated: true`, `userId` carried alongside a fresh per-connection `clientId`.
4. `welcome` carries `userId` + `authenticated` so the originator learns its own auth state; the roster carries them for peers.

**Client surface (`auth/`):** `supabase.ts` is a singleton that is **null when `VITE_SUPABASE_*` env is absent** (app boots guest-only). `useAuth.ts` is a module-singleton composable: reactive `session`, `signInWithGoogle`/`signOut`, and `setUsername` (writes the user's own `profiles` row — RLS-guarded — mapping a Postgres `23505` unique violation to `{ ok: false, reason: 'taken' }`). `SyncSession` passes `getToken` into the `WsClient` and watches the session **user id** to call `reconnect()` on login/logout (D16). `AccountView.vue` renders the sign-in button / username editor (reached via the `Sidebar`).

**Graceful degradation.** No Supabase env on the server → `verify` rejects all tokens + empty in-memory profile store; no env on the client → `supabase === null`, auth calls no-op, no login offered. Guests are unaffected either way.

**Profiles table (`supabase/migrations/0001_profiles.sql`):** `profiles(id uuid pk → auth.users, username text unique, created_at)`, RLS policies for own-row read/write/insert, and an `on_auth_user_created` trigger that auto-inserts an empty row on signup. Browser writes go through RLS; the server only reads (via `DATABASE_URL`).

### One-time Supabase setup (manual, done in dashboards)

1. Create a Supabase project; note its URL + anon key.
2. Google Cloud Console → create an OAuth 2.0 client (Web). Copy client id + secret.
3. Supabase → Authentication → Providers → Google: paste client id/secret; enable.
4. Supabase → Authentication → URL config: add the app origins to redirect URLs
   (local http://localhost:5173 + the Vercel domain).
5. Run `supabase/migrations/0001_profiles.sql` (SQL editor or `supabase db push`).
6. Set client env (Vercel): VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.
7. Set server env (Render): SUPABASE_JWKS_URL, DATABASE_URL (the pooler string).

---

*Last updated: 2026-07-02 (Phase 5 — `feat/phase5-appruntime` — the lifecycle-architecture redesign lands: §2 module map (`app/`, `stores/`), §6 rewritten as the `app/` composition root + `synthContext` facade (was `useSynth.ts`), §7/§9/§15 updated for the applied-command stream and the removed suppression mechanism, new decision **D17**, **D8/D10 superseded, D13/D14 revised, D16 cross-referenced**. Design: `docs/superpowers/specs/2026-07-02-phase5-appruntime-design.md`.) Prior: 2026-06-11 (D1 doc refresh — caught the doc up to: durable sessions + lobby + `/api/sessions` (§14b), session-scoped rooms, the 32-slot track pool with `enabled` flags, lazy per-enabled-slot audio graph (E1), per-track analysers (§8), router/views/Sidebar shell (§9), localStorage path removal (S1, §13), sync-layer hardening from the 2026-06-09 review (M1–M4, E2–E3, D2, §14–§15), and the corrected deployment story (§16). See `CODE_REVIEW_2026-06-09.md` for the findings driving this pass.) Prior: 2026-05-31 (auth & persistence foundation; §17 + D16). Prior: 2026-05-30 (variable track length, D15; slice-down panel binding, D14). Prior: 2026-05-29 (sync protocol implemented + deployed). When the contracts in §3 / §11 change, or the sync model in §15 evolves, update this doc — `CODE_REVIEW.md`, `CODE_REVIEW_2026-06-09.md`, `ROADMAP.md`, and the memories (`audio_engine_decisions`, `sync_suppression_mechanism`, `project_state`) are the other places to keep in sync.*
