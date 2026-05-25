# Oscillator Phase Experiment — Design

**Status:** Draft (brainstormed 2026-05-24)
**Branch:** `feature/osc-phase-experiment` off `main` at `5402942`
**Constraint:** No merge to main, no remote push, until explicit user approval.

## Goal

A/B three oscillator-phase strategies inside `SynthEngine` to decide which (if any) should ship:

1. **free-run** — today's behavior. Oscillators `start()` once at voice construction; relative phase between osc1/osc2 is whatever sub-sample alignment they happened to get.
2. **phase-offset** — free-running, but each osc's starting phase is rotated by a user-controlled angle via a `PeriodicWave` whose Fourier coefficients are pre-rotated.
3. **retrigger-recreate** — `OscillatorNode` is recreated on every note-on with the configured phase baked into a `PeriodicWave`. Inter-osc phase is exactly reproducible per trigger.
4. **retrigger-wavetable** — same lifetime as retrigger-recreate, but the source is an `AudioBufferSourceNode` playing a one-cycle wavetable. Phase = `start(time, offset)`. Opens the door to custom wavetables later.

The user selects modes from a single dropdown and listens. The losing modes get deleted before merge to main.

## Non-goals

- New waveforms beyond `sine`, `square`, `sawtooth`, `triangle`.
- LFO or automation on phase. Phase is a static per-note value.
- Phase modulation (PM) between osc1 and osc2.
- Custom-wavetable loading.
- A graceful "mid-note osc-mode switch" experience. Switching modes while a voice is sustaining silences that voice until the next trigger; documented and acceptable for an experiment.
- A migration that writes the new fields into existing project/preset files at load time — the reconciler handles them implicitly.

## Architecture

### Param shape

Additive to `SynthEngineParams`:

```ts
export type OscMode =
  | 'free-run'
  | 'phase-offset'
  | 'retrigger-recreate'
  | 'retrigger-wavetable';

export interface SynthEngineParams {
  // ... existing fields ...
  oscMode: OscMode;     // default 'free-run'
  osc1Phase: number;    // degrees, 0..360 (wraps); default 0
  osc2Phase: number;    // degrees, 0..360 (wraps); default 0
}
```

`SynthEngine.DEFAULT_PARAMS` is extended with these three defaults. Phase is stored in degrees because that's what the UI shows; modules convert to radians (PeriodicWave) or buffer-offset fraction (wavetable) at their own boundary.

### Schema impact: none

- `PROJECT_SCHEMA_VERSION` stays at `1`. `PRESET_SCHEMA_VERSION` stays at `1`.
- `reconcileWithDefaults` (`src/project/storage.ts:32-60`) already `deepMerge`s every loaded `engines.synth` against `SynthEngine.DEFAULT_PARAMS`. Every existing localStorage project and every existing `.prj.json` / `.chnl.json` silently picks up `oscMode: 'free-run'`, `osc1Phase: 0`, `osc2Phase: 0` at load time.
- Returning users hear identical output until they twist a new knob.

### Module layout

`src/engine/modules/Oscillator.ts` is split into a directory:

```
src/engine/modules/oscillator/
  index.ts                     // re-exports interface, factory, all impls
  types.ts                     // IOscillatorModule + OscMode-keyed factory signature
  WaveformTables.ts            // Fourier (real, imag) coefficients for the four waveforms
  FreeRunOscillator.ts         // today's behavior, lifted verbatim, renamed
  PhaseOffsetOscillator.ts     // PeriodicWave with rotated coefficients; still free-running
  RetriggerOscillator.ts       // creates a fresh OscillatorNode per trigger
  WavetableOscillator.ts       // AudioBufferSourceNode + one-cycle bank
```

Common interface:

```ts
export interface IOscillatorModule {
  readonly outputs: { main: AudioNode };
  setWaveform(type: OscillatorType): void;
  setCoarseTune(octaves: number): void;
  setFineTune(cents: number): void;
  setPhase(degrees: number): void;  // no-op in FreeRun

  // Steady-state path (free-run, phase-offset): schedule a freq change on the live osc.
  setFrequencyAtTime(freq: number, time: number): void;

  // Per-trigger path (retrigger modes): create + start an osc at (time, freq, current phase),
  // schedule stop(releaseTime + 50ms). Free-run and phase-offset implement this as
  // setFrequencyAtTime so SynthVoice.trigger stays mode-agnostic.
  triggerAt(freq: number, time: number, releaseTime: number): void;

  dispose(): void;
}

export function makeOscillator(mode: OscMode, ctx: AudioContext): IOscillatorModule;
```

`releaseTime = scheduleTime + duration + ampEnv.r`, computed in `SynthVoice.trigger`. Retrigger modules use it to schedule `stop()`; free-run/phase-offset ignore it.

### SynthVoice integration

`SynthVoice` holds `osc1: IOscillatorModule` and `osc2: IOscillatorModule`, typed by the interface. The PatchBay wiring (osc → mixer ch1/ch2) stays the same, but the connect/disconnect points move into the module so a mode switch can swap implementations without rebuilding the voice.

Two new SynthVoice surfaces:

- `replaceOscillators(mode: OscMode)`: dispose `osc1`/`osc2`, build new ones via `makeOscillator(mode, ctx)`, reconnect their outputs into `mixer.inputs.ch1`/`mixer.inputs.ch2`.
- `trigger(...)` (existing) calls `osc1.triggerAt(...)` and `osc2.triggerAt(...)` *instead of* `setFrequencyAtTime`. For free-run/phase-offset modules, `triggerAt` delegates to `setFrequencyAtTime` — same audible behavior as today.

### SynthEngine integration

`SynthEngine.applyParams` picks up three new branches:

```ts
if (params.oscMode !== undefined) this.setOscMode(params.oscMode);
if (params.osc1Phase !== undefined) this.setOsc1Phase(params.osc1Phase);
if (params.osc2Phase !== undefined) this.setOsc2Phase(params.osc2Phase);
```

- `setOscMode(mode)`: caches mode, calls `voice.replaceOscillators(mode)` on every voice. After replace, re-applies the cached osc params (waveform, coarse, fine, phase) so the fresh modules start in the same state.
- `setOsc1Phase(deg) / setOsc2Phase(deg)`: caches the value, forwards to each voice's `osc1.setPhase(deg)` / `osc2.setPhase(deg)`. Wrap into [0, 360).

The existing per-slice synth watcher in `buildAudioState` (`src/composables/useSynth.ts:189-201`) diffs `engines.synth` and routes the changed fields to `engine.applyParams(changed)`. No watcher-shape changes — the new fields ride the existing diff plumbing.

### Audio graph behavior per mode

**Free-run.** Unchanged. `ctx.createOscillator()` once per voice, `start()` once, `setFrequencyAtTime(freq, time)` on retrigger. `setPhase` and `triggerAt`-as-phase are no-ops.

**Phase-offset.** Oscillator is created once and `start()`-ed once (free-running). `setWaveform(type)` and `setPhase(deg)` together build a `PeriodicWave` whose harmonic coefficients are rotated. Given a base waveform with harmonics `(a_k, b_k)` and rotation `θ = phase * π / 180`:

```
real[k] =  a_k * cos(k·θ) + b_k * sin(k·θ)
imag[k] = -a_k * sin(k·θ) + b_k * cos(k·θ)
```

`WaveformTables.ts` provides base `(a, b)` arrays for the four standard waveforms up to ~32 harmonics. The PeriodicWave is rebuilt and applied via `osc.setPeriodicWave()` on every phase or waveform change. Because the osc is free-running, twisting the phase knob during sustain produces a smooth glide over the next cycle — no click.

**Retrigger-recreate.** Constructor sets up only the output `GainNode`; no oscillator is created until first trigger. `triggerAt(freq, time, releaseTime)`:

1. `osc = ctx.createOscillator()`
2. `osc.setPeriodicWave(currentPeriodicWave)` — same rotation logic as phase-offset, baked at trigger time.
3. `osc.frequency.setValueAtTime(freq * 2^coarseTune, time)`, `osc.detune.setValueAtTime(fineCents, time)`.
4. `osc.connect(outputGain)`.
5. `osc.start(time)`, `osc.stop(releaseTime + 0.05)`. `onended` lets the node be GC'd.

The previous trigger's osc continues playing until its own scheduled `stop`, which is past the previous note's amp envelope release. No explicit voice stealing is needed at the osc layer — the amp envelope's `cancelAndHoldAtTime` (existing) takes care of the audible tail. Because osc1 and osc2 are both started at the same `time` with phases baked into their PeriodicWaves, the inter-osc phase relationship is **exactly reproducible across triggers** — that's the experiment's core claim.

**Retrigger-wavetable.** A class-level singleton bank is rendered lazily on first construction:

```ts
WavetableOscillator.ensureBank(ctx);  // builds 4 one-cycle AudioBuffers (2048 samples each)
```

`triggerAt(freq, time, releaseTime)`:

1. `src = ctx.createBufferSource()`, `src.buffer = bank[currentWaveform]`.
2. `src.loop = true`, `src.loopStart = 0`, `src.loopEnd = bufferDuration`.
3. `src.playbackRate.setValueAtTime(freq * bufferLength / ctx.sampleRate * 2^coarseTune, time)`.
4. `src.detune.setValueAtTime(fineCents, time)`.
5. `src.connect(outputGain)`.
6. `src.start(time, (phase / 360) * bufferDuration)`.
7. `src.stop(releaseTime + 0.05)`.

The bank survives across voice rebuilds (it lives on the class, indexed by sample rate). If `ctx.sampleRate` ever changes mid-session (it doesn't in this app), the bank is regenerated.

### Mid-note mode transition

When `setOscMode` fires while a voice is sustaining, that voice's amp envelope keeps running but the osc source goes silent (retrigger modes have nothing to play until next trigger; free-run/phase-offset rebuild the osc which starts fresh but isn't being triggered). This is acceptable for an experiment. The user will not perceive it as a defect if they aren't actively holding a note while toggling the mode — which the play-step-sequencer UX makes near-impossible anyway.

## UI

### OscillatorPanel layout

```
┌─ Oscillators ─────────────────────────────────────────┐
│  OSC MODE:  [free-run ▾]                              │
│  ──────────────────────────────────────────────────── │
│  OSC 1                          OSC 2                 │
│  [sawtooth ▾]                   [sawtooth ▾]          │
│  (Coarse) (Fine) (Phase)        (Coarse) (Fine) (Phase) │
└───────────────────────────────────────────────────────┘
```

- `<select v-model="oscMode">` row above the OSC 1 / OSC 2 row. Plain native select, matching the existing waveform dropdown style.
- One `<Knob label="Phase" :min="0" :max="360" :step="1" format="degrees" v-model="osc1Phase" />` added to each `.osc-knobs` row after Fine. Same for `osc2Phase`.

### Phase-knob inert state

When `oscMode === 'free-run'`, the phase knobs render at half opacity (`.inert { opacity: 0.4; }`) to signal they currently have no audible effect. They remain interactive — twisting them still writes to the stored param, so flipping to phase-offset or retrigger picks up the value.

### Knob format

`Knob.vue` already supports a `format` string. The implementation adds `'degrees'` as a new format → appends `°` to the displayed value.

### Plumbing

- `OscillatorPanel.vue`: three new `defineModel`s — `oscMode`, `osc1Phase`, `osc2Phase`.
- `SynthPanel.vue`: pass the three through.
- `App.vue`: bind the three from the `useSynth()` destructure into `<SynthPanel>`.
- `useSynth.ts`: three new `trackParam('synth', 'oscMode' | 'osc1Phase' | 'osc2Phase', default)` writable computeds. Export them.

## Testing

All tests colocated next to source, vitest, node env unless stated. Mocked `AudioContext` follows the established pattern in `SynthEngine.test.ts` (`MockAudioContext`, `MockOscillatorNode`, `MockGainNode`, etc.) and is extended with `MockPeriodicWave` and `MockAudioBufferSourceNode` as needed.

### Per-module tests

**`src/engine/modules/oscillator/WaveformTables.test.ts`**

Tests use `Math.abs(a - b) < 1e-9` as the tolerance for coefficient comparisons (floating-point trig rounding).
- Sawtooth at phase 0 matches the reference Fourier series `b_k = 2/(πk)` (alternating sign) up to harmonic 32, within tolerance.
- Sawtooth at phase 180° equals sawtooth at phase 0 with `imag` negated (rotation-formula sanity), within tolerance.
- Phase 360° == phase 0° within tolerance (wrap consistency, since `cos(2π) ≈ 1` not `=== 1`).

**`src/engine/modules/oscillator/FreeRunOscillator.test.ts`** (essentially today's existing tests for `OscillatorModule`, moved)
- `setFrequencyAtTime(440, 0)` calls `osc.frequency.setValueAtTime(440, 0)`.
- `setCoarseTune(1)` doubles the next scheduled freq.
- `setPhase()` is a documented no-op.

**`src/engine/modules/oscillator/PhaseOffsetOscillator.test.ts`**
- `setWaveform('sawtooth')` triggers one `createPeriodicWave` with the right `real`/`imag` for phase=0.
- `setPhase(90)` triggers a fresh `createPeriodicWave` with rotated arrays; `setPeriodicWave` is called on the osc.
- `setFrequencyAtTime(440, 0)` shape unchanged from FreeRun.

**`src/engine/modules/oscillator/RetriggerOscillator.test.ts`**
- `triggerAt(440, 1.0, 1.5)` creates a fresh `OscillatorNode`, calls `setPeriodicWave` with the current phase, schedules `start(1.0)` and `stop(1.55)`.
- Two consecutive `triggerAt` calls create two distinct osc nodes (verified via mock factory call count).
- `setPhase(90)` between two triggers appears in the second trigger's PeriodicWave only — phase changes do not retroactively affect already-scheduled triggers.

**`src/engine/modules/oscillator/WavetableOscillator.test.ts`** (`// @vitest-environment jsdom` — needs `AudioBuffer` shape)

Buffer sample comparisons use `Math.abs(a - b) < 1e-3` (linear-amplitude tolerance, generous because the sine buffer is rendered numerically).
- `ensureBank(ctx)` builds four buffers on first call; subsequent calls are no-op (singleton).
- Sample 0 of the sine buffer is `≈ 0`; sample at quarter-buffer index is `≈ 1`.
- `triggerAt(220, 0, 2.0)` calls `start(0, (currentPhase/360) * bufferDuration)`, sets `playbackRate` for `220 * bufferLength / sampleRate`, schedules `stop(2.05)`.

### Engine-level tests

**`src/engine/SynthEngine.test.ts` (extend existing)**
- `setOscMode('phase-offset')` calls `replaceOscillators('phase-offset')` on each of the 6 voices.
- `applyParams({ oscMode, osc1Phase, osc2Phase })` routes each field to the right setter.
- All 14 existing tests remain green (free-run is the unchanged default path).

**`src/engine/SynthVoice.test.ts` (new)**
- A mode switch disposes the prior osc1/osc2 and reconnects new ones into mixer ch1/ch2.
- Existing PatchBay connections (mixer → filter, filter → voiceGain) survive the swap.

### Persistence tests

**`src/project/preset.test.ts` (extend)**
- A pre-experiment preset (oscMode/phase absent from the JSON) round-trips through `deserializePreset` and gains the defaults via the existing reconciler — schema is unchanged, behavior is identical to a fresh patch in free-run mode.

## Branch & task layout

`feature/osc-phase-experiment` off `main` at `5402942`.

Task branches off the feature branch, each gated and `--no-ff` merged back:

- **T1 — `task/osc-module-extraction`.** Mechanical refactor: split `src/engine/modules/Oscillator.ts` into the new directory, define `IOscillatorModule` (including `triggerAt` and `setPhase`), implement `FreeRunOscillator` as a verbatim copy of today's class with `triggerAt(freq, time, _releaseTime)` delegating to `setFrequencyAtTime(freq, time)` and `setPhase` as a documented no-op. Add the `makeOscillator` factory, wired to `FreeRunOscillator` for every `OscMode` value. **`SynthVoice.trigger` is switched to call `osc1.triggerAt(...)` / `osc2.triggerAt(...)`** in this task — for FreeRun the call shape is identical to today, so no audible change. All existing tests pass; zero behavior change. This lands the refactor scaffold + interface-uniform voice trigger so subsequent tasks only add files.
- **T2 — `task/osc-phase-offset`.** Add `WaveformTables.ts` and `PhaseOffsetOscillator`. Wire `oscMode: 'phase-offset'` in the factory. Add `oscMode`, `osc1Phase`, `osc2Phase` to `SynthEngineParams` + `DEFAULT_PARAMS`. Add the three `trackParam`s in `useSynth.ts`. Add the UI (mode select + per-osc Phase knob, `.inert` style). Add `setOscMode`/`setOsc1Phase`/`setOsc2Phase` to `SynthEngine` and `replaceOscillators` to `SynthVoice`. Browser-verify: pick a track, switch to phase-offset, twist osc2 phase, hear the timbre change.
- **T3 — `task/osc-retrigger-recreate`.** Add `RetriggerOscillator`. Wire `oscMode: 'retrigger-recreate'` in the factory. `SynthVoice.trigger` already calls `triggerAt` from T1, so no voice changes here. Browser-verify: play a sequence in retrigger-recreate mode, confirm the inter-osc phase is locked across triggers (visible on the oscilloscope if you set osc1 phase = 0 and osc2 phase = 90).
- **T4 — `task/osc-wavetable`.** Add `WavetableOscillator` + the bank renderer. Wire `oscMode: 'retrigger-wavetable'`. Add the jsdom-scoped test file. Browser-verify same as T3 plus compare the sound qualitatively to recreate.

### Gates (per task)

- `npm test` — green. Baseline is 172; T1 leaves it at 172, T2/T3/T4 each add ~5-7 new tests.
- `npx vue-tsc --noEmit` — clean.
- `npm run build` — clean.
- Browser smoke per task description above (Playwright MCP).

### Merge & release policy

- Each task branch is `--no-ff` merged into `feature/osc-phase-experiment` after its gates and browser smoke pass.
- No remote push, no merge to `main`, until the user picks a winner. The likely outcome is: keep one or two modes (free-run + winner) and delete the rest before merging to main.
