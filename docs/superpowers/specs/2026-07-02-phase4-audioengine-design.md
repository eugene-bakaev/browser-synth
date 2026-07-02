# Phase 4 — Extract `AudioEngine` — Design Spec

**Date:** 2026-07-02
**Status:** Approved in brainstorming → pending implementation plan
**Branch:** `feat/phase4-audioengine`
**Parent:** [Lifecycle Architecture Redesign](./2026-06-27-lifecycle-architecture-design.md), Phase 4

## Goal

Move the entire audio cluster out of `composables/useSynth.ts` into a single
`AudioEngine` service with an idempotent `dispose()`, giving the `AudioContext`,
the per-track sound engines, and the `Sequencer` **one explicit owner** that tears
them down at a well-defined lifecycle boundary. This is the audio counterpart to
Phase 3's `SyncSession`: a **facade-preserving relocation**, not a rewrite.

## Scope decision — structural extraction only

The master spec's Phase 4 row is two things: **(a)** extract `AudioEngine` +
`dispose()`, and **(b)** "command-stream params" — have the engine *subscribe to
the command stream* instead of Vue slice-watchers, dropping the `diffParams`
machinery.

**This phase delivers (a) only. Part (b) is deliberately deferred** (see
[Out of scope](#out-of-scope--deferred) and `docs/BACKLOG.md`). The rationale:

- The master spec assumed a Pinia `ProjectStore` where the `CommandBus` is the
  sole writer. Reality diverged: `project` is a **plain reactive singleton**
  (`stores/project.ts`) and `CommandBus.applySet` is a bare `setDeep` on it that
  **emits no event stream**. The audio-reaction watchers work by observing the
  reactive object, so they fire for *every* mutation regardless of origin.
- Three mutation paths **bypass the command bus entirely** and reach audio today
  only because the watchers observe the reactive project:
  1. bulk ops — Clear/Shift/Fill, Open/New, preset load (mutate `project`
     directly, then emit outbound diffs separately);
  2. nack rollback — `Outbox.applyLocal` reverts via `setDeep`;
  3. `replaceProject` — snapshot load / room reset.
- "Subscribe to the command stream" is therefore **not a relocation** — it is a
  re-plumbing of all three bypass paths into a new event stream, or audio
  silently stops reacting to them. That is high-risk correctness work that does
  **not** serve Phase 4's litmus test (explicit ctx/engine/sequencer ownership +
  `dispose()`), and it is YAGNI against the success criteria of the redesign.
- Phase 3 proved the facade-preserving pure-relocation approach merges cleanly.

## Invariant

`git diff --stat main` for the whole branch shows only:

- new `packages/client/src/audio/AudioEngine.ts`
- new `packages/client/src/audio/AudioEngine.test.ts`
- new `packages/client/src/project/paramDiff.ts` (+ small `paramDiff.test.ts`)
- modified `packages/client/src/composables/useSynth.ts`

**No consumer file changes** (`StudioView.vue`, `App.vue`, panels, sync layer).
**Behaviour is byte-identical**, with the single called-out `currentStep`
consequence below.

## Architecture

### `AudioEngine` — `packages/client/src/audio/AudioEngine.ts`

Lives in a new `src/audio/` directory (per the master spec's naming; distinct
from `src/engine/`, which holds the per-voice sound-engine classes). Imports
**nothing** from `sync/` or `useSynth` — a one-directional, cycle-free edge,
mirroring how `SyncSession` imports nothing from audio.

- **Owns:** the `AudioContext`, the sparse per-track `engines[]`, the eager
  `trackGains[]` and `trackAnalysers[]`, `pendingDisposes`, the audio-reaction
  `effectScope`, the `Sequencer`, and the transport state (`currentStep`).
- **Deps (constructor):** `{ project }` — the reactive singleton.
- **Constructor is side-effect-free:** creates the `Sequencer`, the
  `audioState` shallowRef (null), and the `currentStep` ref. No `AudioContext`,
  no worklet loads, no watchers until `ensureAudio()`.

**Surface (relocated verbatim from `useSynth`):**

| Member | Relocated from | Notes |
|---|---|---|
| `ensureAudio(): Promise<AudioState>` | `buildAudioState` + `ensureAudio` + `bootstrapping` | single-flight graph build: worklets → compressor → master → gains → analysers → engines → `flush:'sync'` reaction watchers |
| `trackAnalysers` / `trackGains` (computed) | same-named computeds | null until first `ensureAudio()` |
| `sequencer` | module-scope `sequencer` | `reactive(new Sequencer())` |
| `currentStep` (ref) | per-`useSynth()`-call ref | now single-owned — see [consequence](#one-deliberate-consequence) |
| `togglePlay()` | `togglePlay` | transport + per-step trigger loop |
| `stopPlayback()` | `stopPlayback` | |
| `dispose()` | audio half of `disposeSynth` | idempotent — see below |

**`dispose()` contract (idempotent):**
`scope.stop()` → settle every `pendingDisposes` timer (dispose its engine now, so
no timer outlives the ctx) → dispose all engines → `ctx.close()` → null
`audioState`/`bootstrapping` → `sequencer.stop()`. A second call is a no-op
(`audioState` already null). **Does not touch sync** — `SyncSession.dispose()`
stays a separate call.

The audio-only helpers move **into** `AudioEngine`: `snapshot` (JSON-clone),
`sliderToLinearGain`, `engineFactories`, `ENGINE_SWAP_FADE_SECONDS`, and a **local
copy** of `ENGINE_SLICES` (a one-line literal already duplicated 5× across the
codebase — DRY-ing all six is a separate cleanup, out of scope).

### `useSynth.ts` after extraction

- Construct one eager singleton: `const audioEngine = new AudioEngine({ project })`.
- **Delete** the audio module-scope code: `sequencer`, `audioState`,
  `buildAudioState`, `ensureAudio`, `bootstrapping`, `engineFactories`,
  `sliderToLinearGain`, `snapshot`, `ENGINE_SWAP_FADE_SECONDS`, and the audio half
  of `disposeSynth`.
- `disposeSynth()` becomes `audioEngine.dispose(); session.dispose();` (keeps the
  test-facing export; same two-teardown shape as before).
- In `useSynth()`: `trackAnalysers`, `trackGains`, `togglePlay`, `stopPlayback`,
  `currentStep`, `sequencer`, and `ensureAudio` **delegate** to `audioEngine.*`.
- **Stays put:** every sync emitter (`syncEngineParamsDiff`, `syncStepWindowDiff`,
  `syncWholeProjectDiff`, `snapshotProjectForSync`, `cloneEngineSlice`),
  `dispatchLocal`, `endGesture`, `connectToSession`, `leaveSession`,
  `resetLocalProject`, and the view state (`focusedTrack`, `selectTrack`,
  `addTrack`, `removeTrack`, `shortestActiveNoteDuration`, …).

### Neutral shared module — `packages/client/src/project/paramDiff.ts`

Holds `diffParams` (pure, ~20 lines). Imported by **both** `AudioEngine` (its
param watcher) and `useSynth` (its sync emitters). `diffParams` is used by both
units, so it cannot live in either without a cycle; a leaf module under
`project/` is the clean home. `ENGINE_SLICES` is *not* moved here (kept as a local
copy in `AudioEngine`, matching the codebase's existing 5-copy pattern).

### One deliberate consequence

`currentStep` is currently created **per `useSynth()` call**; it becomes a
**single `AudioEngine`-owned ref**. In production only `StudioView` reads it (the
playhead); `App.vue` also calls `useSynth()` but never displays it. So there is no
visible change — this is a small, intentional tightening consistent with the
"single owner" goal, called out here so a reviewer isn't surprised.

## Testing strategy

- New `AudioEngine.test.ts` (**pure TS — no `.vue` mounts**, per the standing
  rule): side-effect-free construction; `ensureAudio()` builds the graph via the
  existing `MockAudioContext`; the param / mixer / enabled watchers reach the
  right nodes; `dispose()` stops the sequencer, closes the ctx, and is idempotent
  — the test that would catch an orphaned transport.
- Small `paramDiff.test.ts` for `diffParams` (changed-subset, null-when-equal,
  nested-object handling).
- The existing audio-touching tests that go **through the facade**
  (`engine/TrackMixer.test.ts` and anything calling `ensureAudio`/`disposeSynth`
  via `useSynth`) keep passing unchanged — the safety net, as `useSynth.test.ts`
  was for Phase 3.

## Task decomposition

Mirrors Phase 3's clean two-task shape:

- **Task 1:** Add `project/paramDiff.ts` (extract `diffParams`, update
  `useSynth`'s sync emitters to import it) + build `AudioEngine` as **dead code**
  (constructed nowhere yet) + `AudioEngine.test.ts` + `paramDiff.test.ts`. Green,
  unused.
- **Task 2:** Atomic swap — construct the singleton, delete the old audio code,
  rewrite the delegators, `disposeSynth` → two-teardown. Facade preserved; full
  gate + two-tab browser verification on the local Docker DB.

## Out of scope / deferred

- **Command-stream params (master spec part b) — DEFERRED.** Recorded in
  `docs/BACKLOG.md` and annotated on the master spec's Phase 4 row. Picked up
  once/if the `CommandBus` becomes the sole writer and emits an applied-set
  stream — most naturally alongside or after Phase 5's `AppRuntime` work, when the
  bus-bypass paths (bulk ops, nack rollback, `replaceProject`) can be routed
  through the stream deliberately rather than incidentally via reactive watchers.
- **DRY-ing the 6 `ENGINE_SLICES`/`ENGINE_KEYS` copies** — separate cleanup.
- **Pinia `ProjectStore` as the canonical writer** — the store exists
  (`useProjectStore`) but still wraps the raw reactive `project`; folding writes
  onto it is later-phase work, unchanged by Phase 4.

## Success criteria

1. `AudioEngine` owns the ctx / engines / sequencer with an idempotent
   `dispose()`; `useSynth` holds one eager singleton and delegates.
2. `AudioEngine` imports nothing from `sync/` or `useSynth` (cycle-free).
3. `git diff --stat main` matches the [Invariant](#invariant) file list; no
   consumer file changes; behaviour byte-identical (modulo the `currentStep`
   consequence).
4. Full gate green; two-tab browser verification on the local Docker DB shows
   audio, transport, engine swaps, mixer, and dispose behaving exactly as before.
