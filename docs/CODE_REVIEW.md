# Code Review: Fiddle Synth

**Date:** 2026-05-23
**Reviewer:** Claude (Opus 4.7)
**Scope:** Full architecture and code review of `src/` (engine, sequencer, composables, components, utils, tests).
**Branch reviewed:** `main` at `9063585` (pre-fix baseline).

This document is the source-of-truth list of findings. Items implemented in branch `review/audio-engine-fixes` are marked with their corresponding fix number. The remainder are tracked as follow-up work.

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

## Priority summary

### Fixed in branch `review/audio-engine-fixes` (top 10 by impact)

| # | Severity | Title |
|---|----------|-------|
| Fix 1 | 🟥 | Wire per-step velocity to synth tracks (#15, #17, #18) |
| Fix 2 | 🟥 | Lazy-init engines + guard against double useSynth() (#1 minimal scope, #6, #11) |
| Fix 3 | 🟥 | Smooth voice-stealing (#3) |
| Fix 4 | 🟧 | Smooth engine-type swap (#20) |
| Fix 5 | 🟨 | Delete dead code (#8, #14, unreferenced SignalFlow) |
| Fix 6 | 🟧 | Envelope release time semantics (#2) |
| Fix 7 | 🟨 | Track ClapEngine noise sources (#5/#19) |
| Fix 8 | 🟧 | SynthEngine.trigger signature (#18) — folded into Fix 1 |
| Fix 9 | 🟧 | Initialize filter cutoff to baseCutoff (#4) |
| Fix 10 | 🟧 | Anchor sequencer time + handle BPM changes (#7) |

### Deferred to post-architectural-doc work

| # | Severity | Title |
|---|----------|-------|
| #1 (full) | 🟥 | Full singleton → composable refactor |
| #9 | 🟨 | Narrow watcher paths in useSynth |
| #10 | 🟨 | Tagged-union TrackState |
| #12 | 🟩 | LocalStorage persistence |
| #13 | 🟦 | CSS scoping audit |
| #16 | 🟦 | Sequencer reactivity audit |
