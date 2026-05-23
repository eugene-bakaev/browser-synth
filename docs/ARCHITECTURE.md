# Fiddle Synth — Architecture Reference

**Audience:** future contributors (including future-me). Read this before changing audio engine code, sequencer scheduling, or `useSynth.ts`.

**Companion docs:**
- [`CODE_REVIEW.md`](./CODE_REVIEW.md) — Findings list with resolution status. Source of truth when this doc and a finding conflict.
- Memory: `audio_engine_decisions.md` — Same Decisions appendix content, surfaced into Claude's memory across sessions.

---

## 1. What this app is

A browser-based **4-track step sequencer + synthesizer** built on Vue 3 + Web Audio. Each track runs one of five sound engines (Synth, Kick, Hat, Snare, Clap). 16 steps per track, BPM 40–240, with per-step note/octave/length/velocity/mute/chord-type.

There is **no backend**. All state is in-memory. There is no persistence yet (see [`CODE_REVIEW.md`](./CODE_REVIEW.md) F1).

```
┌──────────────────────────────────────────────────────────────┐
│  Vue 3 UI  (App.vue → SynthPanel / drum panels / Tracker)    │
│       │                                                       │
│       │   v-model:knob bindings                               │
│       ▼                                                       │
│  useSynth.ts  (module-scope singleton)                        │
│    ├─ trackStates: reactive 4× TrackState                     │
│    ├─ engines:     SoundEngine[4]  (lazy-built, hot-swappable)│
│    └─ sequencer:   Sequencer (lookahead scheduler)            │
│       │                                                       │
│       │   applyParams(params)         trigger(freq,dur,t,vel) │
│       ▼                                                       │
│  Engines (SynthEngine, KickEngine, HatEngine, SnareEngine,    │
│           ClapEngine) — each implements SoundEngine           │
│       │                                                       │
│       ▼                                                       │
│  trackGains[i] → DynamicsCompressor → masterGain(0.6)         │
│                → AnalyserNode → ctx.destination               │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. Module map

```
src/
├── App.vue                     # Top-level layout: overview grid OR focused single-track editor
├── main.ts                     # Vue mount
├── composables/
│   └── useSynth.ts             # ⚠ singleton dressed as a composable — see §6
├── sequencer/
│   └── Sequencer.ts            # Lookahead scheduler, 4 × Track[16 × Step]
├── engine/
│   ├── types.ts                # SoundEngine, Module, ModulePort
│   ├── SynthEngine.ts          # 6-voice subtractive synth
│   ├── SynthVoice.ts           # One voice (osc×2 → mixer → filter → VCA)
│   ├── KickEngine.ts           # Pitch-swept sine
│   ├── HatEngine.ts            # Bandpassed noise + metallic oscillators
│   ├── SnareEngine.ts          # Noise + tonal body
│   ├── ClapEngine.ts           # Multi-burst noise
│   ├── PatchBay.ts             # Trivial connect/disconnect helper
│   └── modules/
│       ├── Oscillator.ts       # OscillatorNode + per-osc gain + coarse/fine tune
│       ├── Mixer.ts            # 2-channel pre-filter mix
│       ├── Filter.ts           # Lowpass BiquadFilterNode wrapper
│       ├── Envelope.ts         # Shared ADSR; drives amp env AND filter env
│       └── Noise.ts            # Per-context cached 2s white-noise buffer
├── components/                 # Knob, Tracker, panels (SynthPanel, KickPanel, …), TrackMixer, Visualizer
└── utils/                      # noteToFreq, chord resolution
```

**Test layout:** every engine and the sequencer have colocated `.test.ts` files using `vi.stubGlobal` to mock `AudioContext` / `AudioNode` / `AudioParam`. 59 tests at time of writing.

---

## 3. The `SoundEngine` contract (the most important interface)

```ts
// src/engine/types.ts
export interface SoundEngine {
  readonly engineType: string;
  trigger(freq: number | number[], duration: number, time?: number, velocity?: number): void;
  applyParams(params: Record<string, any>): void;
  dispose(): void;
}
```

**Why it matters:** this is the seam that lets `useSynth` swap engine types per track without `instanceof` checks. New engine types add a class implementing this interface and a factory entry — that's it.

### Contract rules
- **`trigger`** must accept either a single freq (mono) or an array (chord/polyphonic). Drum engines treat the array as "play each one" but in practice always receive a single freq.
- **`trigger.time`** is an `AudioContext.currentTime`-relative timestamp. Engines must use `setValueAtTime` / `linearRampToValueAtTime` etc. at this time — **never** schedule against `ctx.currentTime` directly inside `trigger`, because that defeats the sequencer's lookahead.
- **`trigger.velocity`** is `0..1`. Engines must clamp and apply to amp envelope max (or equivalent loudness control). Defaults to `1.0` if omitted.
- **`applyParams`** is sparse — it accepts a `Record<string, any>` and only updates fields that are present. Pattern across engines:
  ```ts
  if (params.xxx !== undefined) this.setXxx(params.xxx);
  ```
  This shape lets `useSynth` pass `state[engineType]` directly and lets per-knob updates skip serialization gymnastics.
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

`useSynth` builds each track's slice via `structuredClone(EngineClass.DEFAULT_PARAMS)`. **Deep clone is required** — nested ADSR objects would otherwise be shared by reference across all four tracks, and mutating track 0's filterEnv would silently bleed into track 1.

---

## 4. Inside `SynthEngine` (the non-trivial one)

```
SynthEngine
├── ctx: AudioContext (shared from useSynth, NOT owned)
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

## 6. `useSynth.ts` — the "singleton-dressed-as-a-composable"

> **⚠ Read this section before refactoring `useSynth`. The shape is misleading on purpose.**

`useSynth()` looks like a Vue composable but the audio state lives at **module scope**:

```ts
const sharedCtx = new AudioContext();   // module-scope
const trackStates = reactive([…]);       // module-scope
const engines: SoundEngine[] = [];       // module-scope, lazy-filled
const sequencer = reactive(new Sequencer()); // module-scope
// watchers registered at module load
```

`useSynth()` itself only:
1. Bumps an invocation counter and warns on the second call (almost always a wiring bug — local refs would be fresh but audio state shared).
2. Builds **local** `ref` / `computed` for the currently-focused track (e.g. `osc1Type` is a `trackParam('synth', 'osc1Type', …)` that reads/writes the active track's slice).
3. Returns those bindings.

### Why this shape
A real composable would re-create the AudioContext on every call, register duplicate watchers, and break HMR. The current pattern is the minimum viable thing that:
- Survives HMR (module is cached, audio state persists)
- Only creates one AudioContext for the page
- Lets `App.vue` swap focused tracks without rewiring audio

The full refactor (factor module-scope state into a real composable with `onUnmounted` teardown) is tracked as **A1** in [`CODE_REVIEW.md`](./CODE_REVIEW.md). Until that lands, treat `useSynth` as a singleton accessor and respect the warn-on-double-call.

### Reactivity flow per knob turn
1. User turns `Knob` → `v-model` writes to a `trackParam`-bound computed.
2. Setter writes into `trackStates[activeTrackIndex][engineType][param]`.
3. The deep-watcher on `trackStates[i].synth` (etc.) fires `syncTrackToEngine(i)`.
4. `syncTrackToEngine` calls `engines[i].applyParams(state[targetType])`.
5. The engine's setters write to AudioParams using `setTargetAtTime` (smooth) where possible.

**Known inefficiency (A2):** the deep watcher fires every setter on every knob turn — 13 `applyParams` writes per turn for the synth. Smooth-ramped params absorb it; non-ramped ones (`osc1Type`, `osc1Coarse`) can stutter on fast drags. Acceptable today, refactor when it matters.

---

## 7. `Sequencer.ts` — lookahead scheduler

Standard Chris-Wilson-style lookahead pattern:

```ts
this.timer = setInterval(() => {
  const stepTime = (60 / this.bpm) / 4;       // 16th note in seconds
  const lookaheadTime = ctx.currentTime + 0.1; // schedule 100ms ahead
  let nextStepTime = this.scheduleStartTime + this.nextStepIndex * stepTime;
  while (nextStepTime < lookaheadTime) {
    callback(this.currentStep, nextStepTime);  // ← engines schedule against THIS time
    this.currentStep = (this.currentStep + 1) % 16;
    this.nextStepIndex += 1;
    nextStepTime = this.scheduleStartTime + this.nextStepIndex * stepTime;
  }
}, 25);
```

### Two non-obvious choices

**Anchor + integer counter, not accumulator.** `nextStepTime = scheduleStartTime + nextStepIndex × stepTime` — no float drift over thousands of steps. The naive `nextNoteTime += stepTime` drifts ~1ms/min, usually negligible but trivially avoidable. See Decision D6.

**BPM-change rebase.** When `bpm` changes mid-playback, we rebase `scheduleStartTime` to the last scheduled step's time and reset `nextStepIndex = 1`. The very next step uses the new `stepTime` forward. Without this, the next step would land on the old grid and feel like a one-step tempo lag.

### Callback contract
The callback `(stepIndex, time) => void` is invoked **for the audio time at which the step should sound**. Engines must schedule sound-emitting calls against `time`, not `ctx.currentTime`. Violating this defeats the lookahead and produces jitter.

---

## 8. Master signal chain

In `useSynth.ts` at module load:

```
SynthEngine[0]    ─→ trackGains[0] ─┐
KickEngine        ─→ trackGains[1] ─┤
HatEngine         ─→ trackGains[2] ─┼─→ DynamicsCompressor ─→ masterGain(0.6) ─→ AnalyserNode ─→ destination
SnareEngine       ─→ trackGains[3] ─┘                                              │
                                                                                    └─→ (Visualizer reads frequency data)
```

- **`trackGains[i]`** — per-track mute/solo/volume node. `updateMixerGains()` does smooth `setTargetAtTime(target, t, 0.015)` writes.
- **`DynamicsCompressor`** — threshold -12dB, ratio 12:1, attack 3ms, release 250ms. Absorbs transient peaks from simultaneous drum hits before they reach the master gain.
- **`masterGain.gain = 0.6`** — fixed headroom. Compressor sits *before* master gain by design; compressing after the master gain would either be too quiet to engage or already clipped.
- **`AnalyserNode`** — shared by `Visualizer.vue` for waveform/spectrum display. `fftSize = 1024`.

### Engine-swap fade
When `state.engineType` changes, `syncTrackToEngine` fades `trackGains[i]` to 0 over ~20ms, then `setTimeout`-defers `dispose()` on the old engine. The new engine connects to the same `trackGain`; `updateMixerGains()` restores volume after. Prevents the click from `osc.stop()` + `disconnect()` on the outgoing engine. See Decision D4.

---

## 9. Component layer

```
App.vue
├── Tracker.vue          ← step grid + chord/mute/velocity controls (used in both overview and focused views)
├── SynthPanel.vue       ← osc/mixer/filter/env knobs for the synth engine
│   ├── OscillatorPanel.vue
│   ├── FilterPanel.vue
│   ├── EnvelopePanel.vue   ← shows ⚠ when A+D > shortest active note
│   └── MixerPanel.vue
├── KickPanel.vue / HatPanel.vue / SnarePanel.vue / ClapPanel.vue  ← drum knob clusters
├── TrackMixer.vue       ← 4-track volume/mute/solo strip
├── Visualizer.vue       ← reads AnalyserNode for waveform/spectrum
└── Knob.vue             ← the reusable rotary control; supports formats: hz, ms, %, octave, semitones, db, none
```

**State direction:** unidirectional via `v-model` on `useSynth()`-returned computeds. Panels never reach into `trackStates` directly.

**CSS scoping:** `App.vue` uses unscoped `<style>` for theme classes (`.module-group`, `.knob-row`, etc.). Intentional for the design system. Audit tracked as A4.

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
- **Defaults:** new engines must declare `static readonly DEFAULT_PARAMS` and use it to initialize private fields. `useSynth.ts` `TrackState` must reference the engine's `*EngineParams` type, not duplicate the shape.

---

## 12. Where to start when…

| Task | First file to read |
|---|---|
| Add a new engine type | `engine/KickEngine.ts` (smallest), `engine/types.ts`, `composables/useSynth.ts` (`engineFactories`, `TrackState`, `trackParam` wiring) |
| Add a new knob to the synth | `components/SynthPanel.vue` (template/v-model), `composables/useSynth.ts` (`trackParam` line), `engine/SynthEngine.ts` (setter + `applyParams` line), `engine/SynthVoice.ts` (param application) |
| Change envelope behavior | `engine/modules/Envelope.ts` (+ Decision D2/D3 in appendix) |
| Change sequencer timing | `sequencer/Sequencer.ts` (+ Decision D6) |
| Add persistence | F1 in `CODE_REVIEW.md`; serialize `trackStates` + `sequencer.tracks` to localStorage, restore on mount |
| Refactor `useSynth` | A1 in `CODE_REVIEW.md`; preserve the "one AudioContext, watchers survive HMR" property |

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

### D8 — `useSynth` is a module-scope singleton with a composable shape

**Decision.** AudioContext, engines, sequencer, and watchers live at module scope. `useSynth()` returns fresh local refs but shares all audio state. Second invocation warns.

**Rejected alternative.** True composable: instantiate AudioContext + engines inside `useSynth()`, tear down on unmount.

**Why.** The true-composable version re-creates the AudioContext on every call (browsers limit concurrent contexts), duplicates watchers (doubling work per knob turn), and loses state on HMR. The current shape is a deliberate compromise documented and guarded with a warn-on-double-call. Full refactor tracked as A1 in `CODE_REVIEW.md`.

---

*Last updated: 2026-05-23. When the contracts in §3 or §11 change, update this doc — the in-repo `CODE_REVIEW.md` and the memory `audio_engine_decisions.md` are the other two places that need to stay in sync.*
