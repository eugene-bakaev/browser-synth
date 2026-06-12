# Worklet Synth Engine (`synth2`) — Design Spec

**Date:** 2026-06-12
**Status:** Draft — awaiting review. No implementation has started.
**Depends on:** nothing merged-pending; references `normalizeTrackPool` (renamed
`normalizeProject` on the unmerged `fix/single-source-project-contract` branch —
this spec uses "the normalize layer" to mean whichever is current at build time).

---

## 1. Summary

A second melodic synth engine, `synth2`, built around a single
`AudioWorkletProcessor` per engine instance instead of a Web Audio node graph.
The DSP kernel owns every sample: oscillators with continuous waveform morphing,
hard sync, and cross-modulation (FM); loopable envelopes; audio-rate LFOs; and a
slot-based modulation matrix. The existing `synth` engine is **not** replaced,
removed, or modified — `synth2` is a sixth engine type sitting beside it.

The kernel is written in **TypeScript, not WASM**, but behind a WASM-shaped
interface (flat typed arrays in/out, zero allocation in the hot path, no Web
Audio types) so the inner loop can be ported to Rust/WASM later if a worst-case
profile demands it. See §10 for the performance reasoning and the port path.

Work is sliced into four independently shippable iterations (§12); iteration 1
is a walking skeleton that proves every integration seam end-to-end with a
deliberately minimal voice.

## 2. Motivation

The current `SynthEngine` composes native Web Audio nodes (`OscillatorNode`,
`BiquadFilterNode`, `GainNode`) with envelopes expressed as AudioParam
automation ramps. That architecture cannot express:

| Wanted capability | Why the node graph blocks it |
|---|---|
| Oscillator hard sync | `OscillatorNode` exposes no phase to reset |
| Cross-mod / phase-mod / through-zero FM | Needs per-sample ownership of phase accumulators (only linear FM is wirable natively) |
| Continuous waveform morph, reverse saw as a mod shape | Native types are discrete; two native oscs can't be phase-locked for clean crossfade |
| Loopable ADSRs | Envelopes are pre-scheduled `linearRamp` automation; looping means unbounded re-scheduling racing `cancelAndHold` |
| Audio-rate LFO → filter cutoff | `BiquadFilterNode` zippers/goes unstable under per-sample coefficient sweeps |

A custom DSP loop in an `AudioWorkletProcessor` removes every one of these
walls at once. The codebase already contains the embryo of this approach: the
PolyBLEP pulse worklet (`engine/worklets/pulse-processor.js`) plus its
Node-testable twin (`worklets/polyblep.ts`).

Language choice (JS vs WASM) is orthogonal to all of the above and is
explicitly deferred — see §10.

## 3. Goals

- A new engine type `synth2` selectable per track like any other engine,
  fully participating in sync, sessions, file save/open, and the D7
  single-source-of-defaults pattern.
- Voice architecture: **3 morphing oscillators + noise source → mixer → ZDF
  state-variable filter → VCA**, with hard sync, through-zero FM, 3 loopable
  envelopes, 2 wide-range LFOs, and an 8-slot mod matrix.
- All DSP in a pure-TypeScript kernel, unit-testable in Node (Vitest) without a
  browser, bundled into one worklet file at build time.
- Sample-accurate trigger scheduling compatible with the existing lookahead
  `Sequencer` (D6) and the `SoundEngine` contract (§3 of ARCHITECTURE.md).
- Active-voice gating from day one: silent voices cost ~0.

## 4. Non-goals

- **Not** replacing or refactoring the existing `synth` engine, its panel, or
  the drum engines.
- **No WASM/Rust in any iteration of this spec.** The kernel contract is
  WASM-portable; the port is a separate future project triggered by profiling.
- No effects section (delay/reverb/drive), no per-step parameter locks, no
  preset browser, no MPE/microtuning. All possible later; none blocking.
- No tempo-synced LFO rates in v1 (the kernel has no transport knowledge;
  plumbing BPM in is an explicit later iteration note, §12/I4).
- No mod-matrix UI sophistication beyond functional dropdowns + amount knobs
  in v1.

## 5. The instrument (product spec)

### 5.1 Voice signal flow

```
            ┌──────────── hard sync (phase reset) ─────────────┐
            │                       │                          │
  osc1 ─────┴─→ TZFM ─→ osc2 ──────┴─→ TZFM ─→ osc3           │
   │              (fm12)  │              (fm23)  │             │
   ├──────────────────────┼──────────────────────┤             │
   ▼                      ▼                      ▼             │
  level1                level2                 level3        noise → noiseLevel
   └──────────────────────┴───────────┬──────────┴─────────────┘
                                      ▼
                          ZDF SVF filter (LP/BP/HP)
                                      ▼
                                  VCA (env1)
                                      ▼
                              voice sum → engine gain → trackGain
```

- **osc1 is the sync/FM master.** `osc2.sync` resets osc2's phase on each osc1
  cycle wrap; `osc3.sync` resets osc3 on each **osc2** wrap (chainable).
- **FM routes:** `fm12` (osc1 output → osc2 phase increment, through-zero),
  `fm23` (osc2 → osc3). Both are mod-matrix destinations, so an envelope or
  LFO can play the FM index.
- **Noise** is a 4th mixer channel and also a mod-matrix *source*.

### 5.2 Oscillator

Each of the 3 oscillators:

- **`morph` (0..3, continuous):** sine → triangle → saw → pulse. Adjacent
  shapes crossfade on a **shared phase accumulator** (this is what native nodes
  can't do). Saw and pulse segments are PolyBLEP-corrected; triangle uses
  polyBLAMP (integrated-BLEP) correction. A **reverse saw** is the saw segment
  with negated slope — audibly identical as an audio source, but exposed as a
  distinct **LFO shape** (§5.5) where ramp-up vs ramp-down genuinely differ.
- **`pulseWidth` (0.05..0.95):** active in the pulse region of morph;
  a-rate-modulatable from the matrix (lifting today's k-rate limitation).
- **`coarse` (−36..+36 semitones, integer), `fine` (−100..+100 cents).**
- **`level` (0..1)** into the voice mixer.
- **`sync` (boolean)** — see master/slave chain above; ignored on osc1.

### 5.3 Filter

Trapezoidal-integration **zero-delay-feedback state-variable filter** (Andy
Simper / Cytomic SVF formulation): cheap (~10 flops/sample), stable under
audio-rate cutoff modulation (the express reason to abandon the biquad), and
yields LP/BP/HP from one state.

- `cutoff` 20..20000 Hz (log knob), `resonance` 0..1, `filterType`
  `'lp' | 'bp' | 'hp'`.
- `keyTrack` 0..1: cutoff follows note pitch (1 = 100%).
- Hardwired `env2 → cutoff` amount in **bipolar octaves ±4** (`filterEnvAmount`),
  consistent with D1. Matrix can add further cutoff modulation on top.

### 5.4 Envelopes (3 × loopable ADSR)

State-machine per voice (idle/attack/decay/sustain/release), computed
per-sample — no AudioParam automation anywhere.

- `env1` is hardwired to the VCA (velocity scales its peak, preserving the
  existing `trigger.velocity` contract). `env2` is hardwired to cutoff (see
  above). All three (including env1) are selectable mod-matrix sources.
- Fields per envelope: `a`, `d`, `s`, `r` (same units/semantics as the
  existing engine: a/d/r in seconds, s 0..1) **plus `loop: boolean`**.
- **Loop semantics:** while the gate is held and `loop` is on, the envelope
  cycles attack → decay → attack → … (sustain level is ignored as a resting
  stage but still shapes the decay target). Gate-off always enters release
  from the current value. With `loop` off it is a textbook ADSR. This makes a
  looping envelope behave as a syncable, shapeable LFO that retriggers per note.
- Retrigger uses a 1 ms ramp-from-held-value, preserving the D3 STEAL_RAMP
  click guarantee inside the kernel.

### 5.5 LFOs (2)

- `rate` 0.01 Hz .. 2000 Hz (log knob) — the top of the range **is** the
  audio-rate modulation feature; at >20 Hz routed to pitch/cutoff/PW these are
  FM/filter-FM effects.
- `shape` (0..4 morph): sine → triangle → saw-up → saw-down → square.
  (Saw-down is the reverse saw, meaningful here.)
- Per-voice phase, retriggered on note-on (free-running/global LFOs are a
  later option, out of v1).

### 5.6 Modulation matrix (8 slots)

Each slot: `{ source, dest, amount }`, `amount` −1..+1 bipolar.

- **Sources:** `none, lfo1, lfo2, env1, env2, env3, velocity, noise`.
- **Destinations:** `none, pitch (all oscs), osc1Pitch, osc2Pitch, osc3Pitch,
  osc1Morph, osc2Morph, osc3Morph, osc1Pw, osc2Pw, osc3Pw, osc1Level,
  osc2Level, osc3Level, noiseLevel, cutoff, resonance, fm12, fm23, lfo1Rate,
  lfo2Rate, amp`.
- **Scaling per destination class:** pitch destinations are exponential,
  ±24 semitones at |amount| = 1; cutoff is ±4 octaves; rate destinations are
  exponential ±4 octaves; everything else is linear added to the base param,
  clamped to the param's range. Multiple slots targeting one destination sum
  before clamping.
- Matrix evaluation is per-sample for audio-rate correctness (sources are
  already per-sample values; the summing is a handful of multiply-adds).

### 5.7 Global

- `mode: 'mono' | 'poly'` — same sequencer-level semantics as the existing
  engine (mono reuses voice 0; poly round-robins).
- **Polyphony: 8 voices**, allocated round-robin among *free* voices first,
  stealing the oldest active voice only when none are free (a strict upgrade
  on the existing blind round-robin, cheap to do once voices track activity
  for gating anyway).

### 5.8 Defaults

Defaults make a sound immediately recognizable as "the new engine": osc1 saw
(morph 2.0), osc2 saw +7 cents, osc3 level 0, noise 0, cutoff 2000 Hz,
res 0.15, filterEnvAmount +2.4 oct, env1/env2 = existing synth defaults with
`loop: false`, env3 idle-ish (a 0.2/d 0.3/s 0/r 0.3, loop false), LFO1
5 Hz sine, LFO2 0.5 Hz triangle, matrix all slots `none/none/0`, mode mono.
Canonical values live in `DEFAULT_SYNTH2_PARAMS` in `@fiddle/shared` (D7).

## 6. Technical architecture

### 6.1 Process topology

**One `AudioWorkletNode` per engine instance (per `synth2` track), all 8
voices computed inside its kernel.** Rejected: one node per voice (×8 node and
port overhead, blocks voices from sharing per-block work) and one node for all
tracks (breaks the per-track engine lifecycle, trackGain routing, and D4
engine-swap fade).

The node's output feeds a native `GainNode` owned by the engine (its
`masterVCA` equivalent), which connects to the destination passed by
`useSynth` — identical external shape to every other engine, so D4's fade-out
on engine swap works unchanged.

### 6.2 Code layout

```
packages/client/src/engine/
  Synth2Engine.ts            # SoundEngine impl: node lifecycle, port protocol, applyParams diffing
  synth2/
    kernel/                  # PURE TS — no Web Audio, no DOM, no allocation in process path
      Synth2Kernel.ts        # top-level: voice pool, event queue, block renderer
      Voice.ts               # per-voice: oscs, envs, lfos, filter, matrix evaluation
      MorphOscillator.ts     # shared-phase morph + PolyBLEP/BLAMP (+ sync & TZFM inputs)
      SvfFilter.ts           # ZDF SVF
      LoopEnvelope.ts        # ADSR state machine with loop mode
      Lfo.ts
      ModMatrix.ts
      params.ts              # Float32Array param block layout + indices (the WASM-shaped ABI)
    worklet-entry.ts         # registerProcessor wrapper; the ONLY file touching AudioWorkletGlobalScope
```

The kernel is imported by **both** `worklet-entry.ts` (bundled for the audio
thread) and Vitest specs (run in Node). This kills the duplicated-math problem
the pulse worklet accepted for its 8 lines — a full kernel cannot be
maintained twice.

### 6.3 Worklet bundling

`worklet-entry.ts` is bundled to a **single self-contained ES module file** at
build time and loaded via `ctx.audioWorklet.addModule(url)` in
`useSynth.buildAudioState`, alongside the existing pulse worklet registration.
Vite's `?worker&url`-style single-file emission (or an explicit
`vite-plugin`/`esbuild` pre-bundle step mirroring how the server bundles) —
the iteration-1 task is to pick whichever produces one dependency-free file in
both dev and production builds and lock it in. Acceptance test: engine
produces sound in `npm run dev` **and** in `npm run build` + preview.

### 6.4 Trigger & param protocol (main thread → kernel)

All communication is via the node's `MessagePort`; **no AudioParams** on the
worklet node. Rationale: the param surface is ~60 leaves (AudioParam-per-param
is unwieldy), the sequencer already schedules ahead of time (so message
latency is absorbed by lookahead), and matrix-driven modulation happens inside
the kernel anyway. AudioParams would buy host-side automation ramps we don't
use.

Messages:

- `{ type: 'trigger', time, freqs: number[], duration, velocity }` —
  `time` is the `AudioContext` timestamp from the sequencer (contract §3
  rule: never `ctx.currentTime` inside trigger). The kernel queues the event
  and starts the voice at the exact frame offset within the render quantum
  where `time` falls, using `currentTime`/`currentFrame` from
  `AudioWorkletGlobalScope`. Events arriving for a `time` already in the past
  start immediately (graceful, same as AudioParam behavior).
- `{ type: 'params', values: Float32Array }` — the **full flat param block**
  (layout defined in `kernel/params.ts`; enums and booleans encoded as
  floats). `Synth2Engine.applyParams` keeps a local typed-array mirror, writes
  changed indices, posts the block. Posting the whole block (~60 floats,
  <300 bytes) per knob-change is simpler than diff messages and irrelevant in
  bandwidth; the kernel diffs against its previous block to decide which
  smoothers to retarget.
- `{ type: 'dispose' }` — kernel returns `false` from `process()` (lets the
  node be GC'd); `Synth2Engine.dispose()` also disconnects the output gain.
  D4's fade-to-zero before dispose is handled by `useSynth` exactly as for
  other engines.

Continuous params are smoothed in-kernel by ~5 ms one-pole smoothers
(replacing the `setTargetAtTime(…, 0.01)` idiom); discrete params (enums,
booleans, matrix routing) switch at block boundaries.

### 6.5 Kernel contract (the WASM-shaped ABI)

The kernel's hot path is constrained to be mechanically portable to Rust:

1. `process(outL: Float32Array, outR: Float32Array, frames: number)` renders
   into caller-owned buffers. (v1 output is mono duplicated; the signature is
   stereo-ready.)
2. All state in preallocated typed arrays / scalar fields; **zero allocation
   and zero closure creation** after construction. No `Array.prototype`
   iteration helpers in the loop.
3. Params arrive as one `Float32Array` block; trigger events as scalar
   arguments pushed into a preallocated ring buffer.
4. No Web Audio, DOM, or `postMessage` types anywhere under `kernel/` —
   enforced by the existing `noUnusedLocals`-style discipline plus a lint-free
   import rule checked in review (kernel files import only from `kernel/`).

A future Rust port replaces the kernel module behind `worklet-entry.ts` with
`WebAssembly.instantiate` + shared `Float32Array` views; `Synth2Engine`, the
protocol, the schema, and the panel are untouched.

### 6.6 DSP algorithm notes

- **Morph oscillator:** one phase accumulator; the four shapes are generated
  from it and the two adjacent shapes for the current morph position are
  crossfaded equal-power. PolyBLEP corrections applied where the active
  segments have discontinuities (saw wrap, pulse edges); triangle slope
  discontinuity uses polyBLAMP. Reuses/extends the existing `polyblep.ts`
  math (which gains a kernel home and keeps its tests).
- **Hard sync:** on master phase wrap, slave phase resets to
  `masterPhaseOverflow × slaveDt / masterDt` (sub-sample-accurate reset), with
  a PolyBLEP correction at the reset discontinuity to keep sync sweeps
  band-limited. This is the classic BLEP-sync technique; "good enough over
  perfect" — minor residual aliasing at extreme settings is accepted in v1.
- **Through-zero FM:** modulator output scales the carrier's per-sample phase
  increment: `dt' = dt × (1 + fmAmount × mod)`, allowing negative `dt'`
  (phase runs backward = through-zero).
- **Noise:** white noise from a per-voice xorshift32 PRNG (seeded per voice;
  deterministic for tests); `noiseColor` is a one-pole lowpass 0..1.
- **Denormal safety:** flush filter/envelope state below 1e-15 to 0 once per
  block.

## 7. Shared-package integration

All additive; nothing existing changes shape.

1. **`EngineType`** union (`shared/src/index.ts`): add `'synth2'`.
2. **`shared/src/engines/synth2.ts`:** `Synth2EngineParams` interface +
   `DEFAULT_SYNTH2_PARAMS` (D7). Nested objects: `env1/env2/env3`
   (`{a,d,s,r,loop}`), `lfo1/lfo2` (`{rate,shape}`), `matrix` — a **fixed
   8-element array** of `{source,dest,amount}` (fixed-size like the step
   buffer and track pool, keeping the wire shape and accept-list bounds
   static, per D15's precedent).
3. **`EngineParamsMap`** (`project/types.ts`): add `synth2` key.
4. **Zod schema** (`project/schema.ts`): `Synth2ParamsSchema` with enums for
   `filterType`, matrix `source`/`dest`, morph ranges, etc.; registered in
   `EnginesMap` and the `EngineType` union schema.
5. **Accept-list** (`project/accept-list.ts`): leaf patterns for every param,
   including `['tracks','*','engines','synth2','matrix','*','source'|'dest'|'amount']`
   and `['tracks','*','engines','synth2','env1'|'env2'|'env3', leaf]`.
   `resolveLeafSchema` gains `synth2` branches mirroring the existing
   synth-ADSR special case, plus matrix-slot index bounds (0..7) added to
   `indicesInRange`.
6. **Factory** (`project/factory.ts`): fresh tracks carry the `synth2` slice.
7. **Normalize layer:** heal a missing `engines.synth2` slice from defaults at
   every boundary (old DB snapshots and saved files predate the engine). No
   `schemaVersion` bump — additive heal, same policy as prior added fields.
   ⚠️ Known latent issue (memory + backlog): the *sync* path skips deep track
   migration that the offline path performs; `synth2` healing must be wired
   into whichever normalize entrypoint each boundary actually calls, and
   iteration 1 includes a regression test for "old snapshot without synth2
   loads via WS".

## 8. Client integration

- **`Synth2Engine`** implements `SoundEngine` (`engineType: 'synth2'`); added
  to `engineFactories` and `ENGINE_SLICES` in `useSynth.ts`.
- **Worklet registration** in `buildAudioState` next to the pulse worklet's
  `addModule` (both awaited before any engine construction — same invariant
  the OscillatorModule comment documents).
- **`Synth2Panel.vue`**, bound via the D14 slice pattern
  (`:params="focusedTrack!.engines.synth2"`, `v-model="params.<field>"`,
  knob sync paths via D13 — no per-field computeds). Layout: osc 1/2/3
  columns, filter + envs row, LFOs + 8 matrix slot rows (each: source
  dropdown, dest dropdown, amount knob).
- **`engineLabel.ts`**: label entry (working name `SYN2`; rename is a
  one-liner before merge if a better name lands).
- **File save/open**: no work beyond normalize healing (files are whole
  `Project` JSON).

## 9. Sync & collaboration notes

- Every param is a flat JSON leaf (numbers, booleans, small string enums) —
  LWW per-leaf semantics are exactly as musically acceptable as for existing
  engines (D9). Matrix slots are three independent leaves; a remote peer
  changing `dest` while you drag `amount` converges per-leaf, which is fine.
- Param count (~60/track) raises snapshot size modestly; the sparse-snapshot
  design (2026-06-06) already handles default-elision if it becomes
  noticeable. Not a v1 concern.
- All `useSynth` watchers for the `synth2` slice follow the **`flush: 'sync'`
  rule (D10)** — non-negotiable, see `sync_suppression_mechanism`.

## 10. Performance & the WASM decision

- **Budget:** ~250–300 flops/voice/sample for the full voice. Worst case
  (32 `synth2` tracks × 8 voices = 256 voices) is not a JS-feasible target —
  **and not a WASM-feasible one either** (2–4× doesn't absorb a 256-voice
  pathology). The design lever is **voice gating**: a voice whose env1 has
  reached idle is skipped entirely; an engine with zero active voices renders
  silence for ~nothing (and `process()` keeps returning `true` only while the
  node is alive — we do not suspend, to keep trigger latency at zero).
  Realistic dense sessions sound 30–60 voices ⇒ comfortably inside the JS
  budget established in design discussion (~1–3 GFLOPS available, <0.5 needed).
- **Discipline:** zero allocation in `process()` (enforced by review +
  a soak test asserting no GC-visible growth), no polymorphic call sites in
  the loop, all per-block constants hoisted.
- **Measurement before porting:** iteration 4 includes a profiling harness — a
  worst-case session (max synth2 tracks, dense 64-step patterns, long
  releases, all matrix slots active) measured via `chrome://tracing` audio
  thread occupancy. **Decision rule:** if worst-case realistic sessions
  exceed ~60% of the render budget, schedule the Rust/WASM kernel port (the
  ABI in §6.5 makes it a kernel-swap, not a redesign). Otherwise WASM stays
  shelved.

## 11. Testing strategy

Kernel-first, browser-last (repo convention: no `.vue` mounting).

- **Kernel unit tests (Vitest, Node):** render buffers offline and assert —
  pitch via zero-crossing/autocorrelation (osc at 440 Hz within ±1 cent);
  morph continuity (no discontinuity in output as morph sweeps); sync (slave
  spectrum locked to master fundamental); TZFM (sidebands present, silent at
  index 0); envelope segment timing and **loop cycling** (peaks at expected
  periods); LFO rate accuracy incl. audio-rate; matrix scaling/clamping; voice
  gating (silent voice contributes exact zeros); determinism (seeded noise);
  no NaN/Inf under randomized param fuzzing.
- **Protocol tests:** `Synth2Engine` against a stubbed `AudioWorkletNode` —
  param block layout round-trips, trigger messages carry sequencer time,
  dispose sequencing.
- **Shared contract tests:** schema validates defaults; accept-list accepts
  every panel-reachable path and rejects out-of-range matrix indices;
  normalize heals a snapshot missing `engines.synth2` (incl. the WS-path
  regression test from §7 item 7).
- **Browser verification (per AGENTS.md):** Playwright MCP drive of the dev
  app — select `synth2`, place steps, play, twist knobs, check console clean;
  close the tab/session after.

## 12. Iteration plan (agile slices)

Each iteration lands on its own branch, passes the merge gate
(`typecheck && test && build`), gets browser verification, and is a usable
instrument at every stop. No iteration starts until the previous one is merged
by the user.

**I1 — Walking skeleton (the risk-killer).**
`synth2` end-to-end with a deliberately tiny voice: **1 morph oscillator +
env1 (non-looping) + voice gating, mono only**. Proves: worklet bundling in
dev *and* prod build, addModule lifecycle, trigger/param port protocol with
sample-accurate starts, all shared-package plumbing (§7), minimal panel
(morph/tune/level + env1), engine swap fade (D4), sync round-trip of synth2
leaves between two clients, old-snapshot healing. *Exit criterion: a second
user in the same session hears your synth2 track and can turn your morph knob.*

**I2 — The oscillator section.**
Oscs 2+3, noise channel, mixer levels, hard sync chain, TZFM (`fm12`/`fm23`),
poly mode + 8-voice allocator, SVF filter with env2 (loop still disabled) and
keytrack. This iteration delivers the headline sound-design features (sync +
cross-mod + morph).

**I3 — The modulation system.**
Loop mode on all three envelopes, env3, both LFOs (full 0.01 Hz–2 kHz range),
the 8-slot mod matrix with all sources/destinations and per-class scaling,
panel rows for matrix/LFOs. This iteration delivers audio-rate modulation and
loopable ADSRs.

**I4 — Hardening & headroom.**
Profiling harness + worst-case session measurement (→ WASM go/no-go data),
allocation soak test, denormal sweep, voice-steal audibility pass, default
patch tuning, optional niceties *if cheap*: tempo-synced LFO rates (BPM is
already on `project`), free-running LFO mode, stereo voice spread.

## 13. Risks

| Risk | Mitigation |
|---|---|
| Worklet bundling differs dev vs prod (the classic Vite worklet trap) | I1 exit criterion explicitly covers both; lock the working recipe in a comment + this spec |
| Port-message timing vs very short lookahead | Sequencer lookahead (~0.1 s) ≫ message latency (<1 frame); late events degrade gracefully to immediate start |
| Kernel CPU surprises (morph × 3 oscs × matrix) | Gating from I1; per-iteration micro-bench in Vitest (frames/sec of kernel render in Node as a coarse canary) |
| Param-block ABI churn across iterations | `params.ts` layout is append-only; index constants, never positional literals, at call sites |
| Accept-list/schema drift (60 new leaves) | Contract test generates paths from `DEFAULT_SYNTH2_PARAMS` shape and asserts acceptance — list can't silently miss a panel knob |
| The latent sync-path migration gap bites old sessions | Explicit WS-path healing regression test in I1 (§7.7) |

## 14. Open questions (non-blocking, decide before/at the relevant iteration)

1. Engine display name (`SYN2` placeholder) — decide before I1 merge.
2. Free-running vs retriggered LFOs as a per-LFO toggle — default retriggered;
   toggle is an I4 nicety.
3. Stereo: keep kernel signature stereo-ready (done in §6.5) but decide in I4
   whether voice spread ships.
4. Whether `filterType` should be a continuous LP↔BP↔HP morph (the SVF gives
   it almost free) instead of an enum — leaning enum for v1 UI simplicity;
   revisit in I2.
