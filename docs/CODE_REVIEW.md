# Code Review: Fiddle Synth

**Original review:** 2026-05-23 — Claude (Opus 4.7)
**Last updated:** 2026-05-24 (post-merge of `feature/project-model` — A3 + F1 persistence done)
**Scope:** Full architecture and code review of `src/` (engine, sequencer, composables, components, utils, tests).
**Baseline reviewed:** `main` at `9063585`.

This document is the durable source-of-truth for findings from the review and their current resolution status. The original review identified 20 items; subsequent UI-correctness and architectural follow-up passes added more. See the [Current state](#current-state) section for what's landed vs what's open.

---

## Current state

### Commits landed in `main` from `review/audio-engine-fixes`

| Commit | Title | What it does |
|---|---|---|
| `469b3ef` | `fix: address top-10 issues from code review` | Velocity passthrough, lazy-init engines, voice-steal click ramp, engine-swap fade, dead code purge, envelope release semantics, ClapEngine source tracking, trigger signature, filter cutoff init, sequencer anchoring + BPM rebase. |
| `8f3d8bf` | `feat: bipolar octave filter envelope + stable knob value layout` | Replaced linear `0..1 × 5000Hz` filter env with bipolar `±4 octaves` (log scale). Knob value cell width fixed; octave display uses `↑/↓` arrows. |
| `f9d227f` | `fix: live cutoff knob, honest trigger LED, envelope-too-long warning` | Cutoff knob writes to live AudioParam (audible on sustaining notes). LED honors mute/solo state. Warning when A+D exceeds shortest active note. |
| `5881a6b` | `refactor: engines own their defaults via DEFAULT_PARAMS` | Each engine exports `Params` interface + static `DEFAULT_PARAMS`. `useSynth` `TrackState` references those types and `structuredClone`s defaults. Track 0 detune asymmetry removed. |

Tests: **59/59 passing**. `vue-tsc` + `vite build` clean.

### Outstanding work (see [Outstanding](#outstanding) at bottom for full list)

- **🟦 7 small UI/cosmetic items** (U1–U7) — knob format consistency, mixer dB scale, stale double-click reset, drum step field vestiges, etc.
- **🟧 0 architectural items remaining** — A1–A5 all resolved. See A-series table below.
- **🟩 1 feature gap partially done** (F1) — persistence shipped; named presets still open.

---

## Overall verdict

A well-thought-out browser synth with solid bones. The `SoundEngine` abstraction is the strongest part of the codebase. Audio engineering is mostly correct but has several classic Web Audio pitfalls. State management has accumulated the most cruft and is the natural target for the upcoming architectural refactor.

---

## Severity legend

- 🟥 **Critical** — broken user-visible feature or audio glitch likely to be noticed
- 🟧 **High** — correctness bug or fragile state; not always audible but should be fixed
- 🟨 **Medium** — code smell or future-fragility; non-urgent
- 🟦 **Low** — nit / future-cleanup
- 🟩 **Feature** — not a defect; called out for the roadmap

---

## What's working well

1. **Engine abstraction.** `SoundEngine` interface (`trigger / applyParams / dispose / engineType`) gives polymorphic dispatch without `instanceof`. Engines hot-swap per track via the `engineFactories` map.
2. **Master signal chain.** `trackGains → DynamicsCompressor → masterGain(0.6) → analyser → destination` is textbook. The compressor placement before the master gain absorbs transient peaks from simultaneous drum hits.
3. **Sample-accurate scheduling.** `Sequencer.ts` uses the canonical lookahead clock pattern (`setInterval` + `ctx.currentTime + 0.1` lookahead). Sample-accurate without burning the main thread.
4. **Smooth-transition discipline.** `setTargetAtTime` with `0.015s` (mixer) and `0.01s` (filter) is applied consistently — no raw `.value =` zipper noise.
5. **Active-source tracking.** Drum engines use `Set<AudioNode>` + `onended` cleanup to prevent dangling oscillator memory leaks. (`ClapEngine` is the exception — see #7.)
6. **Web Audio test mocking.** Tests stub `AudioContext`/`AudioParam`/`AudioNode` via `vi.stubGlobal`, allowing engines to be unit-tested in jsdom.

---

## Findings (20 total)

### 🟥 #1 — Module-scope side-effecting singleton (`useSynth.ts:13-209`)

Lines 13–209 execute at module load before any user gesture:
- Creates an `AudioContext` (Chrome will log `"The AudioContext was not allowed to start..."`)
- Creates 4 `SynthEngine` instances (~50 audio nodes each) before user picks an engine type
- Registers Vue `watch` effects against module-scope state

Comment "Persist the reactive states at module scope so they survive HMR/reload" is itself an admission of fragility. Calling `useSynth()` twice would re-register all 8 watchers, doubling work per knob turn.

**Recommended minimal fix (Fix 2):** lazy-init engines on first sync, add console.warn guard on double `useSynth()`. The full refactor (composable that initializes on first call, tears down on unmount) is better deferred to the post-architectural-doc cleanup.

---

### 🟧 #2 — Envelope release uses time constant ≠ release time (`Envelope.ts:33`)

```ts
param.setTargetAtTime(min, releaseTime, Math.max(this.r / 3, 0.005));
```

`setTargetAtTime`'s third arg is a *time constant* (τ), not a target completion time. With τ = R/3, the value reaches ~95% at R but never fully reaches `min` (asymptotic). Filter envelope releases never fully return to `baseCutoff`. The R knob's label is a lie.

**Fixed in Fix 6:** switch to manual `exponentialRampToValueAtTime` so R means actual release duration.

---

### 🟥 #3 — Naive round-robin voice stealing (`SynthEngine.ts:170-174`)

```ts
freqs.forEach(f => {
  const voice = this.voices[this.activeVoiceIndex];
  voice.trigger(f, duration, scheduleTime);
  this.activeVoiceIndex = (this.activeVoiceIndex + 1) % this.numVoices;
});
```

With 6 voices and long release tails, voices are stolen mid-release without a fade-out. `Envelope.trigger`'s `setValueAtTime(min, time)` (line 22) jumps `voiceGain.gain` to 0 instantly, cutting in-progress releases with an audible click.

**Fixed in Fix 3:** brief `linearRampToValueAtTime(min, time + 0.001)` to swallow the discontinuity.

---

### 🟧 #4 — Filter cutoff sits at biquad default (350Hz) until first note

`FilterModule.ts:9-18` creates a `BiquadFilterNode` but never writes `frequency.value = baseCutoff`. The filter envelope's `setValueAtTime(min, time)` at trigger time eventually sets it, but for any audio *before* the first trigger, the filter is at the default cutoff.

Currently inaudible (amp env keeps voiceGain at 0), but fragile — drone modes, pre-roll audio, or any flow that bypasses the amp envelope would expose it.

**Fixed in Fix 9:** write baseCutoff to the AudioParam at construction.

---

### 🟧 #5 / 🟨 #19 — `ClapEngine` doesn't track active noise sources

`KickEngine`, `HatEngine`, `SnareEngine` all track sources in `Set`s for clean disposal via `onended`. `ClapEngine` (line 67-80) creates a noise source but doesn't track it. If you `dispose()` a `ClapEngine` mid-tail, the noise source plays on.

**Fixed in Fix 7:** add `activeSources: Set<AudioBufferSourceNode>` matching the other drum engines.

(#5 and #19 in the raw findings list were the same issue described twice.)

---

### 🟦 #6 — `SynthEngine` constructor defaults are immediately overwritten

Constructor creates 6 voices with hardcoded defaults (`osc1Type = 'sawtooth'`, etc.), then `syncTrackToEngine` immediately calls `applyParams` with the actual state. Wasteful but not broken. Resolved naturally by Fix 2 (lazy init).

---

### 🟧 #7 — Sequencer timer drift on BPM changes (`Sequencer.ts:86-95`)

```ts
this.timer = setInterval(() => {
  const stepTime = (60 / this.bpm) / 4;
  while (this.nextNoteTime < ctx.currentTime + 0.1) {
    callback(this.currentStep, this.nextNoteTime);
    this.currentStep = (this.currentStep + 1) % 16;
    this.nextNoteTime += stepTime;
  }
}, 25);
```

`nextNoteTime` accumulates floating-point error over thousands of steps (~1ms/min — usually negligible). More importantly: if BPM changes mid-playback, the next increment uses the new value but the already-scheduled next step is on the old grid — feels like a "tempo snap" rather than smooth ramp.

**Fixed in Fix 10:** anchor `nextNoteTime` to a `startTime` reference; on BPM change, recompute anchor relative to current step position.

---

### 🟨 #8 — Dead code: `<div v-if="false">` in App.vue (`App.vue:92`)

```html
<div v-if="false" class="focused-flow-section">
  <SignalFlow :engineType="engineType" :color="..." />
</div>
```

`SignalFlow.vue` exists but is rendered only when `v-if="false"` — i.e., never. Either ship it or delete it.

**Fixed in Fix 5:** delete the block and the `SignalFlow.vue` file.

---

### 🟨 #9 — Watchers fire on full-state changes, not deltas (`useSynth.ts:194-209`)

```ts
watch(() => [
  trackStates[i].engineType,
  trackStates[i].synth,
  trackStates[i].kick, /* ... */
], () => { syncTrackToEngine(i); }, { deep: true });
```

A single knob turn re-runs every setter in `applyParams` (13 AudioParam writes for the synth). For knobs that already use `setTargetAtTime` (smooth-ramped), harmless. For ones that don't (`setOsc1Type`, `setOsc1Coarse`), repeated per-frame writes can cause minor stuttering during fast slider drags.

**Deferred to post-doc cleanup.** Requires watching narrower paths and passing only the changed key into `applyParams` — material refactor.

---

### 🟨 #10 — `TrackState` carries all 5 engine configs per track

Each track stores `synth/kick/hat/snare/clap` slices. Mutating any of them with `deep: true` watchers fires `syncTrackToEngine`, which then `applyParams(state[targetType])` — a no-op when the active engine doesn't match the slice. Memory cost is minimal; mental model is muddier.

**Deferred to post-doc cleanup.** Cleanest fix is a tagged-union state shape, which is also a material refactor.

---

### 🟦 #11 — `engineFactories.synth` ignores eager engine cache

Lines 44-49 of `useSynth.ts` create 4 `SynthEngine` instances. Then `engineFactories.synth = (ctx, dest) => new SynthEngine(...)` always builds fresh. Resolved by Fix 2 (lazy init removes the eager cache).

---

### 🟩 #12 — No project persistence

Not a defect, but the obvious next feature. 200+ values of state vanish on reload. `localStorage` watcher on `trackStates` + `sequencer.tracks` would be a one-evening task.

---

### 🟦 #13 — CSS leaks in `App.vue` (`<style>` not `<style scoped>`)

Global theme styles (`.module-group`, `.knob-row`, body styles) leak into every component. Probably intentional for the design system, worth noting.

---

### 🟦 #14 — Unused `engines` in `useSynth` return (`useSynth.ts:345`)

Exported but never destructured in `App.vue`. **Fixed in Fix 5.**

---

### 🟥 #15 — Per-step velocity ignored on synth tracks (`useSynth.ts:316-321`)

```ts
engines[i].trigger(freqs, duration, time, 1.0); // hardcoded
engines[i].trigger(freq, duration, time, 1.0);  // hardcoded
```

`Step.velocity` exists in the model, defaults to 0.8, is reset to 0.8 in `clearTrack`. Drum tracks pass `step.velocity` (line 325); synth tracks don't. Broken at three layers:
1. The call sites hardcode 1.0
2. `SynthEngine.trigger` doesn't take velocity (signature mismatch with the `SoundEngine` interface — see #18)
3. No velocity slider in the Tracker UI for synth rows

**Fixed in Fix 1:** wire velocity end-to-end (model → call site → engine → voice → envelope scaling), add UI slider.

---

### 🟦 #16 — Sequencer is fully reactive (`reactive(new Sequencer())`)

Makes every step in every track reactive (4 × 16 = 64 reactive proxies). Negligible at this scale but worth noting if step count grows.

---

### 🟦 #17 — `Step.velocity` UI gap for synth/chord rows

Velocity slider only renders for drum rows in Tracker.vue. Even after Fix 1, the slider needs to exist for synth/chord rows for users to actually set values. **Addressed in Fix 1.**

---

### 🟧 #18 — `SynthEngine.trigger` signature mismatch with interface (`SynthEngine.ts:163`)

`SoundEngine` interface declares `velocity?: number` (`types.ts:11`); `SynthEngine.trigger` omits it. TypeScript permits via signature compatibility, but it's a quiet bug. **Fixed in Fix 8** (forwards naturally with Fix 1).

---

### 🟧 #20 — Engine `dispose()` on type swap leaves dangling triggers

```ts
if (engine.engineType !== targetType) {
  engine.dispose();
  engine = engineFactories[targetType](sharedCtx, trackGains[i]);
  engines[i] = engine;
}
```

`dispose()` calls `osc.stop()` immediately and `gain.disconnect()`. Any active oscillator's release tail is amputated mid-cycle. The master compressor absorbs most of it, but a `setTargetAtTime(0, ...)` on the engine's master VCA before disposal would make it clean.

**Fixed in Fix 4.**

---

## Original 20 findings — resolution map

| # | Severity | Status | Commit |
|---|----------|--------|--------|
| #1 (minimal scope) | 🟥 | ✅ Fixed | `469b3ef` (lazy-init + double-call guard) |
| #1 (full singleton→composable refactor) | 🟥 | ⏳ Deferred → A1 | — |
| #2 | 🟧 | ✅ Fixed | `469b3ef` (envelope linearRamp release) |
| #3 | 🟥 | ✅ Fixed | `469b3ef` (`STEAL_RAMP = 1ms`) |
| #4 | 🟧 | ✅ Fixed | `469b3ef` + `f9d227f` (init + live writes) |
| #5/#19 | 🟨 | ✅ Fixed | `469b3ef` (ClapEngine `activeSources`) |
| #6 | 🟦 | ✅ Resolved by `5881a6b` (DEFAULT_PARAMS) |
| #7 | 🟧 | ✅ Fixed | `469b3ef` (sequencer anchor + BPM rebase) |
| #8 | 🟨 | ✅ Fixed | `469b3ef` (deleted `v-if="false"` + SignalFlow) |
| #9 | 🟨 | ⏳ Deferred → A2 | — |
| #10 | 🟨 | ✅ Done → A3 (`<TBD>`) | Dense `EngineParamsMap` in `ProjectTrack` |
| #11 | 🟦 | ✅ Resolved by `469b3ef` + `5881a6b` |
| #12 | 🟩 | ✅ Persistence done → F1 (`<TBD>`); named presets open | `src/project/storage.ts` |
| #13 | 🟦 | ⏳ Deferred → A4 | — |
| #14 | 🟦 | ✅ Fixed | `469b3ef` (removed unused `engines` export) |
| #15 | 🟥 | ✅ Fixed | `469b3ef` (velocity wired end-to-end) |
| #16 | 🟦 | ⏳ Deferred → A5 | — |
| #17 | 🟦 | ✅ Fixed | `469b3ef` (velocity slider in Tracker) |
| #18 | 🟧 | ✅ Fixed | `469b3ef` (trigger signature) |
| #20 | 🟧 | ✅ Fixed | `469b3ef` (engine-swap trackGain fade) |

---

## UI-correctness review (added after original 20)

Additional findings from the post-Fix-10 UI/audio behavior pass.

| # | Severity | Status | Detail |
|---|----------|--------|--------|
| UI: Filter Env Amount = "60% of 5000Hz" | 🟥 | ✅ Fixed | `8f3d8bf` — now bipolar ±4 octaves (log) |
| UI: Knob layout shift on drag | 🟧 | ✅ Fixed | `8f3d8bf` — fixed-width value cell |
| UI: "oct" suffix opaque | 🟦 | ✅ Fixed | `8f3d8bf` — `↑2.4`/`↓1.5`/`0` |
| UI: Live cutoff doesn't sweep on sustain | 🟧 | ✅ Fixed | `f9d227f` — `setTargetAtTime` in `applyParams` |
| UI: Trigger LED ignores mute/solo | 🟧 | ✅ Fixed | `f9d227f` — honest check |
| UI: Long ADSR vs short step silently truncated | 🟧 | ✅ Fixed | `f9d227f` — ⚠ warning in EnvelopePanel |
| UI: Track 0 detune asymmetry | 🟦 | ✅ Fixed | `5881a6b` — DEFAULT_PARAMS refactor |

---

<a id="outstanding"></a>
## Outstanding work

### 🟦 UI / cosmetic polish (U-series)

Single dedicated UI-pass branch when appetite strikes. Each item is small (5–30 min) and independent.

| # | Item | Where / Status |
|---|---|---|
| **U1** | ~~Envelope A/D/R UI min=0 but engine clamps to 0.001~~ | ✅ Done (`4a8aecd`) — min=0.001, step=0.001 |
| **U2** | ~~Knob `ms ↔ s` boundary display discontinuity at 1s~~ | ✅ Done (`4a8aecd`) — always renders ms |
| **U3** | ~~Velocity slider asymmetry (drum shows `%`, synth doesn't)~~ | ✅ Done (`4a8aecd`) — synth row now shows % too |
| **U4** | ~~Mixer Volume is linear gain shown as `%` (perception is log)~~ | ✅ Done (`4046ec2`) — slider 0..1 → -54..+6 dB → linear gain via 10^(dB/20). Knob reads in dB. Default slider 0.9 = 0 dB (unity), +6 dB headroom at top. |
| **U5** | ~~Knob double-click reset captures stale `modelValue` after track switch~~ | ✅ Done (`4a8aecd`) — every panel passes engine `DEFAULT_PARAMS` |
| **U6** | ~~Drum engines ignore `step.length`/`step.octave`/`step.note` value~~ | ✅ Closed by design — drums are fire-and-forget; pitch + decay come from per-engine knobs (Tune/Decay), not step data. Vestigial `noteToFreq()` call dropped in `useSynth.ts`; freq/duration now passed as 0 with a comment. |
| **U7** | (resolved by `5881a6b` — Track 0 asymmetry removed) | — |

The U-pass commit (`4a8aecd`) also fixed a latent A1 reactivity regression: `audioState` was a plain `let`, so the `analyser`/`trackGains` computeds in `useSynth.ts` cached their first evaluation (null) and never re-ran after `ensureAudio()` assigned. Converted to `shallowRef`. Tests passed because they call `ensureAudio()` before reading the computed; the browser caught it because the template reads first.

### 🟧 Architectural items (A-series)

**Best tackled after the architectural reference doc lands on `main`** — the doc clarifies the contracts these refactors should respect.

| # | Item | Notes |
|---|---|---|
| **A1** | ~~Full singleton → composable refactor of `useSynth`~~ | ✅ **Done** — lazy `AudioContext`, watchers in `EffectScope`, explicit `ensureAudio()` / `disposeSynth()`. See ARCHITECTURE.md §6 + D8. |
| **A2** | ~~Narrow watcher paths in `useSynth`~~ | ✅ **Done** — per-slice watchers + `diffParams` forward only changed keys. Regression tests in `useSynth.test.ts`. See ARCHITECTURE.md §6 reactivity flow. |
| **A3** | ~~Tagged-union `TrackState`~~ | ✅ **Done** (`<TBD>`) — replaced by dense `ProjectTrack` with `engines: EngineParamsMap` (all 5 engine slots always populated). Active engine narrowed via `activeParams` helper. Engine-swap is a single-field write; per-engine state persists across swaps. See `src/project/types.ts` and `docs/superpowers/specs/2026-05-23-project-model-design.md`. |
| **A4** | ~~CSS scoping audit~~ | ✅ **Done** — App.vue split into unscoped (design system: `module-group`, `knob-row`, `rack-column*`, element theme) + scoped (App.vue-only layout). Convention documented in ARCHITECTURE.md §9. |
| **A5** | ~~Sequencer reactivity audit~~ | ✅ **Done** — audit found 5 scheduler internals (`currentStep`, `timer`, `nextStepIndex`, `scheduleStartTime`, `lastBpm`) being proxied unnecessarily. Moved into a `markRaw`'d `internals` object. UI surface (`tracks`, `bpm`, `isPlaying`) stays reactive. See ARCHITECTURE.md §7 "Reactivity boundary". |

### 🟩 Feature gaps

| # | Item |
|---|---|
| **F1** | `localStorage` persistence — ✅ **persistence DONE** (`<TBD>`); **named presets still open** | Persistence shipped: `loadProject()` restores on page load, `installAutoSave()` debounce-writes on every change, schema versioning + migration registry in place. Named presets (save/load/rename per-engine snapshots) are a separate future branch. |

---

## Key design decisions (for future-me / future-reader)

These are non-obvious choices that future work should respect or knowingly revisit.

- **Filter envelope amount is log-scale octaves, not linear Hz.** Bipolar `±4 octaves`. `peakCutoff = baseCutoff * 2^filterEnvAmount`, clamped to `[20, 20000]` Hz. The previous design (linear `× 5000Hz` factor) felt dramatic at low cutoffs and inaudible at high cutoffs.
- **Envelope `R` is now a linearRamp duration, not a time constant.** `param.linearRampToValueAtTime(min, releaseTime + r)`. The original used `setTargetAtTime` with `τ = R/3`, which never actually reached `min`.
- **1ms `STEAL_RAMP` in `EnvelopeModule.trigger`.** Smooth handoff from a previous voice's residual value to `min`. Shifts attack by 1ms (inaudible) but eliminates voice-steal clicks.
- **Engine-type swap fades trackGain over 20ms before `dispose()`.** `setTimeout` defers the actual dispose. The new engine connects to the same trackGain; `updateMixerGains()` restores it after.
- **Sequencer schedules step times from an anchor + integer step counter**, not by accumulating `nextNoteTime += stepTime`. Eliminates float drift. BPM changes mid-playback rebase the anchor at the last scheduled step so tempo takes effect immediately.
- **Each engine class exposes `static readonly DEFAULT_PARAMS`** of its `*EngineParams` type — single source of truth for "what does a fresh engine sound like." `useSynth` builds `TrackState` via `structuredClone(EngineClass.DEFAULT_PARAMS)` (deep clone is required because nested ADSR objects would otherwise be shared by reference across tracks).
- **`useSynth` warns on second invocation.** The composable shape is misleading — audio state is actually module-scope singleton. Calling `useSynth()` more than once gets fresh local refs but shared engine state, almost always a wiring bug.
