# Oscillator Phase Experiment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a swappable oscillator section to `SynthEngine` so the user can A/B four phase strategies — free-run, phase-offset (rotated PeriodicWave), retrigger-recreate (fresh OscillatorNode per trigger), and retrigger-wavetable (AudioBufferSourceNode + one-cycle bank) — and decide which one(s) should ship.

**Architecture:** Polymorphic `IOscillatorModule` with one impl class per `OscMode`. `SynthVoice` swaps impls via `replaceOscillators(mode)` on mode change. `SynthVoice.trigger` calls a uniform `osc.triggerAt(freq, time, releaseTime)` — FreeRun/PhaseOffset delegate to `setFrequencyAtTime` so the steady-state path is unchanged; Retrigger/Wavetable construct a fresh source per trigger. Param shape is purely additive (`oscMode`, `osc1Phase`, `osc2Phase`) — no schema bump, existing projects/presets reconcile to `oscMode: 'free-run'` and sound identical.

**Tech Stack:** Vue 3 + TypeScript + Vite + Vitest. WebAudio `PeriodicWave` for phase-rotated harmonics; `AudioBufferSourceNode` with `start(time, offset)` for wavetable phase. jsdom only for the wavetable-buffer test file (already a devDependency).

**Spec:** `docs/superpowers/specs/2026-05-24-osc-phase-experiment-design.md` — read it first.

**Baseline:** branch `feature/osc-phase-experiment` at `b971dce` (one commit: the spec doc on top of `main` at `5402942`), 172 tests passing, `vue-tsc --noEmit` + `vite build` clean.

---

## File Structure (locked before tasks)

```
src/engine/modules/
├── Oscillator.ts                                       # DELETE (T1) — code moves to oscillator/FreeRunOscillator.ts
└── oscillator/                                         # CREATE (T1)
    ├── index.ts                                        # CREATE (T1) — re-exports
    ├── types.ts                                        # CREATE (T1) — IOscillatorModule, OscMode, makeOscillator
    ├── FreeRunOscillator.ts                            # CREATE (T1) — verbatim of today's class + triggerAt + setPhase
    ├── FreeRunOscillator.test.ts                       # CREATE (T1)
    ├── WaveformTables.ts                               # CREATE (T2) — base Fourier (a,b) for 4 waveforms; rotatePhase()
    ├── WaveformTables.test.ts                          # CREATE (T2)
    ├── PhaseOffsetOscillator.ts                        # CREATE (T2) — rotated PeriodicWave, free-running
    ├── PhaseOffsetOscillator.test.ts                   # CREATE (T2)
    ├── RetriggerOscillator.ts                          # CREATE (T3) — fresh OscillatorNode per trigger
    ├── RetriggerOscillator.test.ts                     # CREATE (T3)
    ├── WavetableOscillator.ts                          # CREATE (T4) — one-cycle bank + AudioBufferSourceNode per trigger
    └── WavetableOscillator.test.ts                     # CREATE (T4, jsdom-scoped)

src/engine/
├── SynthVoice.ts                                       # MODIFY (T1) — IOscillatorModule typing + triggerAt; (T2) replaceOscillators
├── SynthVoice.test.ts                                  # CREATE (T2)
├── SynthEngine.ts                                      # MODIFY (T2) — oscMode/osc1Phase/osc2Phase fields + setters; T3/T4 wire factory
└── SynthEngine.test.ts                                 # MODIFY (T2/T3/T4) — extend with new branches

src/components/
├── Knob.vue                                            # MODIFY (T2) — add 'degrees' to format union
├── OscillatorPanel.vue                                 # MODIFY (T2) — mode select + Phase knob per osc + .inert style
├── SynthPanel.vue                                      # MODIFY (T2) — pass-through for oscMode, osc1Phase, osc2Phase
└── App.vue                                             # MODIFY (T2) — bind oscMode/osc1Phase/osc2Phase from useSynth

src/composables/
└── useSynth.ts                                         # MODIFY (T2) — 3 new trackParams + export

src/project/
└── preset.test.ts                                      # MODIFY (T2) — extend round-trip with new fields
```

---

## Task Overview

| # | Title | Branch |
|---|---|---|
| T1 | Module extraction (mechanical, zero behavior change) | `task/osc-module-extraction` |
| T2 | Phase-offset mode + types + UI + plumbing | `task/osc-phase-offset` |
| T3 | Retrigger-recreate mode | `task/osc-retrigger-recreate` |
| T4 | Wavetable mode + lazy bank | `task/osc-wavetable` |

**Per-task workflow:**
1. Start from `feature/osc-phase-experiment` clean tree.
2. Create sub-branch: `git checkout -b task/<short-name>`.
3. Implement task steps (TDD where applicable).
4. Run gates: `npm test`, `npx vue-tsc --noEmit`, `npm run build`. All green.
5. Browser smoke (Playwright MCP) per the task's verification steps.
6. Commit on sub-branch with a descriptive message.
7. `git checkout feature/osc-phase-experiment && git merge --no-ff task/<short-name> -m "Merge T<N>: <subject>"`.
8. Move to next task.

**Constraints (preserve verbatim):**
- No merge to `main` until explicit user approval.
- No remote push until explicit instruction.

---

## Task 1: Module extraction (mechanical, zero behavior change)

**Sub-branch:** `task/osc-module-extraction`

**Files:**
- Create: `src/engine/modules/oscillator/types.ts`
- Create: `src/engine/modules/oscillator/FreeRunOscillator.ts`
- Create: `src/engine/modules/oscillator/FreeRunOscillator.test.ts`
- Create: `src/engine/modules/oscillator/index.ts`
- Modify: `src/engine/SynthVoice.ts` (import path, type as `IOscillatorModule`, switch trigger to call `triggerAt`)
- Delete: `src/engine/modules/Oscillator.ts`

**Goal:** Land the interface + factory + free-run impl + the uniform `triggerAt` voice-trigger path. Free-run is the only mode reachable at the end of T1; every other `OscMode` value falls through to `FreeRunOscillator` in the factory. All existing 172 tests pass with zero behavior change. T2+ add new files and flip factory branches.

### Steps

- [ ] **Step 1: Create the sub-branch**

```bash
git checkout feature/osc-phase-experiment
git checkout -b task/osc-module-extraction
```

- [ ] **Step 2: Create the types file**

Create `src/engine/modules/oscillator/types.ts`:

```ts
// AudioNode + OscillatorType come from lib.dom — no imports needed.

export type OscMode =
  | 'free-run'
  | 'phase-offset'
  | 'retrigger-recreate'
  | 'retrigger-wavetable';

export interface IOscillatorModule {
  readonly outputs: { main: AudioNode };
  setWaveform(type: OscillatorType): void;
  setCoarseTune(octaves: number): void;
  setFineTune(cents: number): void;
  setPhase(degrees: number): void;

  // Steady-state path (free-run, phase-offset): schedule a freq change on the
  // already-running oscillator.
  setFrequencyAtTime(freq: number, time: number): void;

  // Per-trigger path. Free-run / phase-offset implement this as a thin
  // setFrequencyAtTime so SynthVoice.trigger can call triggerAt uniformly.
  // Retrigger / wavetable modes create + start a fresh source here, and
  // schedule stop(releaseTime + 50ms).
  triggerAt(freq: number, time: number, releaseTime: number): void;

  dispose(): void;
}
```

- [ ] **Step 3: Create FreeRunOscillator (verbatim of today's class + triggerAt + setPhase no-op)**

Create `src/engine/modules/oscillator/FreeRunOscillator.ts`:

```ts
import type { ModulePort, Module } from '../../types';
import type { IOscillatorModule } from './types';

export class FreeRunOscillator implements IOscillatorModule, Module {
  readonly name = 'Oscillator';
  private osc: OscillatorNode;
  private gain: GainNode;

  coarseTune: number = 0; // -3..+3 octaves
  private baseFreq: number = 440;

  readonly inputs: Record<string, ModulePort> = {};
  readonly outputs: { main: GainNode };

  constructor(ctx: AudioContext) {
    this.osc = ctx.createOscillator();
    this.gain = ctx.createGain();
    this.osc.connect(this.gain);
    this.osc.start();
    this.outputs = { main: this.gain };
  }

  setFrequencyAtTime(freq: number, time: number) {
    this.baseFreq = freq;
    const finalFreq = this.baseFreq * Math.pow(2, this.coarseTune);
    this.osc.frequency.setValueAtTime(finalFreq, time);
  }

  // Free-run delegates triggerAt to setFrequencyAtTime — the steady-state
  // path is identical to today's behavior; releaseTime is unused because the
  // osc never stops until dispose().
  triggerAt(freq: number, time: number, _releaseTime: number) {
    this.setFrequencyAtTime(freq, time);
  }

  setCoarseTune(octaves: number) {
    this.coarseTune = octaves;
    this.setFrequencyAtTime(this.baseFreq, this.osc.context.currentTime);
  }

  setFineTune(cents: number) {
    this.osc.detune.setValueAtTime(cents, this.osc.context.currentTime);
  }

  setWaveform(type: OscillatorType) {
    this.osc.type = type;
  }

  // Documented no-op — free-run mode does not control phase.
  setPhase(_degrees: number) {
    /* no-op */
  }

  dispose() {
    try {
      this.osc.stop();
    } catch {
      // already stopped
    }
    this.osc.disconnect();
    this.gain.disconnect();
  }
}
```

- [ ] **Step 4: Create the test for FreeRunOscillator**

Create `src/engine/modules/oscillator/FreeRunOscillator.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { FreeRunOscillator } from './FreeRunOscillator';

class MockAudioParam {
  value = 0;
  setValueAtTime = vi.fn();
}
class MockOscillatorNode {
  frequency = new MockAudioParam();
  detune = new MockAudioParam();
  type: OscillatorType = 'sine';
  start = vi.fn();
  stop = vi.fn();
  connect = vi.fn();
  disconnect = vi.fn();
  context = { currentTime: 0 };
}
class MockGainNode {
  gain = new MockAudioParam();
  connect = vi.fn();
  disconnect = vi.fn();
}
class MockAudioContext {
  currentTime = 0;
  createOscillator() { return new MockOscillatorNode(); }
  createGain() { return new MockGainNode(); }
}
vi.stubGlobal('AudioContext', MockAudioContext);

describe('FreeRunOscillator', () => {
  it('starts the underlying osc once at construction', () => {
    const ctx = new (AudioContext as any)();
    const osc = new FreeRunOscillator(ctx);
    expect((osc as any).osc.start).toHaveBeenCalledTimes(1);
  });

  it('setFrequencyAtTime applies coarseTune factor to the scheduled value', () => {
    const ctx = new (AudioContext as any)();
    const osc = new FreeRunOscillator(ctx);
    osc.setCoarseTune(1); // +1 octave
    osc.setFrequencyAtTime(440, 0);
    const setSpy = (osc as any).osc.frequency.setValueAtTime;
    expect(setSpy).toHaveBeenLastCalledWith(880, 0);
  });

  it('triggerAt delegates to setFrequencyAtTime (releaseTime ignored)', () => {
    const ctx = new (AudioContext as any)();
    const osc = new FreeRunOscillator(ctx);
    const spy = vi.spyOn(osc, 'setFrequencyAtTime');
    osc.triggerAt(330, 1.5, 99);
    expect(spy).toHaveBeenCalledWith(330, 1.5);
  });

  it('setPhase is a documented no-op (does not throw)', () => {
    const ctx = new (AudioContext as any)();
    const osc = new FreeRunOscillator(ctx);
    expect(() => osc.setPhase(90)).not.toThrow();
  });

  it('dispose stops + disconnects the osc', () => {
    const ctx = new (AudioContext as any)();
    const osc = new FreeRunOscillator(ctx);
    osc.dispose();
    expect((osc as any).osc.stop).toHaveBeenCalled();
    expect((osc as any).osc.disconnect).toHaveBeenCalled();
  });
});
```

- [ ] **Step 5: Create the index.ts re-exports + makeOscillator factory**

Create `src/engine/modules/oscillator/index.ts`:

```ts
import { FreeRunOscillator } from './FreeRunOscillator';
import type { IOscillatorModule, OscMode } from './types';

export type { IOscillatorModule, OscMode } from './types';
export { FreeRunOscillator } from './FreeRunOscillator';

// Dispatch by mode. T1 wires FreeRun for every value — the non-free-run
// branches will be replaced in T2/T3/T4. The fall-through default keeps the
// app shippable mid-experiment if an unknown mode string sneaks in.
export function makeOscillator(mode: OscMode, ctx: AudioContext): IOscillatorModule {
  switch (mode) {
    case 'free-run':
    case 'phase-offset':
    case 'retrigger-recreate':
    case 'retrigger-wavetable':
    default:
      return new FreeRunOscillator(ctx);
  }
}
```

- [ ] **Step 6: Update SynthVoice to use IOscillatorModule + makeOscillator + triggerAt**

In `src/engine/SynthVoice.ts`:

Replace the import block at the top (lines 1-6) with:

```ts
import { PatchBay } from './PatchBay';
import { makeOscillator, type IOscillatorModule } from './modules/oscillator';
import { MixerModule } from './modules/Mixer';
import { FilterModule } from './modules/Filter';
import { EnvelopeModule } from './modules/Envelope';
```

Change the field types (around lines 11-12):

```ts
  osc1: IOscillatorModule;
  osc2: IOscillatorModule;
```

In the constructor, replace the two `new OscillatorModule(ctx)` lines with:

```ts
    this.osc1 = makeOscillator('free-run', ctx);
    this.osc2 = makeOscillator('free-run', ctx);
```

In `trigger(...)` (around lines 53-58), replace the two `setFrequencyAtTime` calls with `triggerAt` and compute `releaseTime`:

```ts
  trigger(freq: number, duration: number, time: number, velocity: number = 1.0) {
    // releaseTime: the moment the amp envelope is fully released. Retrigger-
    // mode oscillators use this to schedule stop(releaseTime + 50ms safety).
    // Free-run / phase-offset ignore it (their triggerAt delegates to
    // setFrequencyAtTime).
    const releaseTime = time + duration + this.ampEnv.r;

    this.osc1.triggerAt(freq, time, releaseTime);
    this.osc2.triggerAt(freq, time, releaseTime);

    // (rest of method unchanged)
```

- [ ] **Step 7: Delete the old Oscillator module file**

```bash
rm src/engine/modules/Oscillator.ts
```

- [ ] **Step 8: Run gates**

Run: `npx vue-tsc --noEmit`
Expected: clean (no errors).

Run: `npm test`
Expected: 172 tests pass (no new tests yet for FreeRunOscillator counted — wait, the new test file adds 5; baseline becomes 177). If tests reference the old `OscillatorModule` import path, update those imports to `./oscillator/FreeRunOscillator`.

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 9: Browser smoke**

Run `npm run dev`; open the app; play a beat with the default synth track. Sound should be identical to before T1 (the change is purely a code rename + uniform call path).

- [ ] **Step 10: Commit + merge back**

```bash
git add src/engine/modules/oscillator/ src/engine/SynthVoice.ts
git rm src/engine/modules/Oscillator.ts
git commit -m "$(cat <<'EOF'
refactor(synth): extract OscillatorModule to oscillator/ directory + IOscillatorModule interface

Mechanical T1 of feature/osc-phase-experiment. No behavior change.

- src/engine/modules/Oscillator.ts → src/engine/modules/oscillator/FreeRunOscillator.ts
- New IOscillatorModule interface (+ OscMode union) in oscillator/types.ts
- makeOscillator(mode, ctx) factory dispatches to FreeRunOscillator for every
  OscMode value. T2/T3/T4 will replace the non-free-run branches.
- SynthVoice typed as IOscillatorModule; trigger() now calls osc.triggerAt
  (FreeRun delegates to setFrequencyAtTime so steady-state behavior is
  identical) so non-free-run impls can construct fresh sources per trigger.
EOF
)"

git checkout feature/osc-phase-experiment
git merge --no-ff task/osc-module-extraction -m "Merge T1: oscillator module extraction"
```

---

## Task 2: Phase-offset mode + types + UI + plumbing

**Sub-branch:** `task/osc-phase-offset`

**Files:**
- Create: `src/engine/modules/oscillator/WaveformTables.ts`
- Create: `src/engine/modules/oscillator/WaveformTables.test.ts`
- Create: `src/engine/modules/oscillator/PhaseOffsetOscillator.ts`
- Create: `src/engine/modules/oscillator/PhaseOffsetOscillator.test.ts`
- Create: `src/engine/SynthVoice.test.ts`
- Modify: `src/engine/modules/oscillator/index.ts` (factory: wire `'phase-offset'`)
- Modify: `src/engine/SynthEngine.ts` (params + DEFAULT_PARAMS + setters + applyParams branches)
- Modify: `src/engine/SynthEngine.test.ts` (new branches)
- Modify: `src/engine/SynthVoice.ts` (`replaceOscillators(mode)` + cached state)
- Modify: `src/composables/useSynth.ts` (3 new trackParams + export)
- Modify: `src/components/Knob.vue` (add `'degrees'` to format union)
- Modify: `src/components/OscillatorPanel.vue` (mode select + Phase knobs + `.inert` style)
- Modify: `src/components/SynthPanel.vue` (pass-through defineModels)
- Modify: `src/App.vue` (bind from useSynth into SynthPanel)
- Modify: `src/project/preset.test.ts` (round-trip including new fields)

**Goal:** Add `oscMode: 'phase-offset'` as a fully-working mode end-to-end: user picks it from the dropdown, twists the Phase knob on osc1/osc2, and hears the timbre change. Existing free-run remains the default.

### Steps

- [ ] **Step 1: Create the sub-branch**

```bash
git checkout feature/osc-phase-experiment
git checkout -b task/osc-phase-offset
```

- [ ] **Step 2: Create WaveformTables with reference Fourier series + rotation helper**

Create `src/engine/modules/oscillator/WaveformTables.ts`:

```ts
// Reference Fourier coefficient tables for the four standard waveforms,
// truncated to 32 harmonics (matches PeriodicWave's audible range and keeps
// table size tiny). The PeriodicWave layout requires a 0-DC entry, so each
// array has length 33: index 0 is the DC offset (always 0 for these
// waveforms), indices 1..32 are the k-th harmonic.
//
// (real, imag) follows the PeriodicWave convention:
//   sample(t) = sum_k(real[k] * cos(k * 2π * f * t) + imag[k] * sin(...))

const N = 33;

function makeArrays(): { real: Float32Array; imag: Float32Array } {
  return { real: new Float32Array(N), imag: new Float32Array(N) };
}

function sineCoefficients(): { real: Float32Array; imag: Float32Array } {
  const { real, imag } = makeArrays();
  imag[1] = 1; // single fundamental
  return { real, imag };
}

function sawtoothCoefficients(): { real: Float32Array; imag: Float32Array } {
  // Bandlimited sawtooth: imag[k] = 2/(π*k) * (-1)^(k+1) for k >= 1
  // (matches the standard descending sawtooth shape used by OscillatorNode).
  const { real, imag } = makeArrays();
  for (let k = 1; k < N; k++) {
    imag[k] = (2 / (Math.PI * k)) * ((k % 2 === 1) ? 1 : -1);
  }
  return { real, imag };
}

function squareCoefficients(): { real: Float32Array; imag: Float32Array } {
  // Bandlimited square: imag[k] = 4/(π*k) for odd k, 0 for even.
  const { real, imag } = makeArrays();
  for (let k = 1; k < N; k++) {
    if (k % 2 === 1) imag[k] = 4 / (Math.PI * k);
  }
  return { real, imag };
}

function triangleCoefficients(): { real: Float32Array; imag: Float32Array } {
  // Bandlimited triangle: imag[k] = 8/(π² * k²) * (-1)^((k-1)/2) for odd k.
  const { real, imag } = makeArrays();
  for (let k = 1; k < N; k++) {
    if (k % 2 === 1) {
      imag[k] = (8 / (Math.PI * Math.PI * k * k)) * (((k - 1) / 2) % 2 === 0 ? 1 : -1);
    }
  }
  return { real, imag };
}

const TABLES: Record<OscillatorType, { real: Float32Array; imag: Float32Array }> = {
  sine: sineCoefficients(),
  sawtooth: sawtoothCoefficients(),
  square: squareCoefficients(),
  triangle: triangleCoefficients(),
  // 'custom' is reachable through OscillatorType but our UI never selects it.
  // Fall back to sine so a stale enum value doesn't crash.
  custom: sineCoefficients(),
};

// Returns base coefficients for the given waveform. Caller is responsible for
// passing the result through rotatePhase before handing to PeriodicWave.
export function baseTable(type: OscillatorType): { real: Float32Array; imag: Float32Array } {
  const t = TABLES[type] ?? TABLES.sine;
  // Hand back copies so callers can mutate freely without poisoning the cache.
  return { real: new Float32Array(t.real), imag: new Float32Array(t.imag) };
}

// Rotate each harmonic by k·θ where θ = degrees * π / 180. For the k-th
// harmonic (a, b):
//   real' =  a·cos(kθ) + b·sin(kθ)
//   imag' = -a·sin(kθ) + b·cos(kθ)
// Mutates the input arrays in place and returns them.
export function rotatePhase(
  base: { real: Float32Array; imag: Float32Array },
  degrees: number,
): { real: Float32Array; imag: Float32Array } {
  const theta = (degrees * Math.PI) / 180;
  for (let k = 1; k < base.real.length; k++) {
    const a = base.real[k];
    const b = base.imag[k];
    const c = Math.cos(k * theta);
    const s = Math.sin(k * theta);
    base.real[k] =  a * c + b * s;
    base.imag[k] = -a * s + b * c;
  }
  return base;
}
```

- [ ] **Step 3: Create WaveformTables test**

Create `src/engine/modules/oscillator/WaveformTables.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { baseTable, rotatePhase } from './WaveformTables';

const EPS = 1e-9;

function arrayCloseTo(a: Float32Array, b: Float32Array, eps = EPS): void {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) {
    expect(Math.abs(a[i] - b[i])).toBeLessThan(eps);
  }
}

describe('WaveformTables', () => {
  it('sawtooth at phase 0 matches the reference Fourier series', () => {
    const { real, imag } = baseTable('sawtooth');
    expect(real[0]).toBe(0);
    for (let k = 1; k < 33; k++) {
      expect(real[k]).toBe(0);
      const expected = (2 / (Math.PI * k)) * ((k % 2 === 1) ? 1 : -1);
      expect(Math.abs(imag[k] - expected)).toBeLessThan(EPS);
    }
  });

  it('rotatePhase by 180° on sawtooth equals base sawtooth with imag negated', () => {
    const rotated = rotatePhase(baseTable('sawtooth'), 180);
    const base = baseTable('sawtooth');
    // After 180° rotation: cos(kπ) = ±1, sin(kπ) = 0, so real' = a·(±1) and
    // imag' = b·(±1). For sawtooth (a=0), real stays 0 and imag flips sign on
    // every odd k where cos(kπ) = -1.
    for (let k = 1; k < 33; k++) {
      // expected imag = b * cos(kπ) = b * (-1)^k
      const expected = base.imag[k] * ((k % 2 === 0) ? 1 : -1);
      expect(Math.abs(rotated.imag[k] - expected)).toBeLessThan(EPS);
      expect(Math.abs(rotated.real[k])).toBeLessThan(EPS);
    }
  });

  it('rotatePhase by 360° equals rotatePhase by 0° within tolerance', () => {
    const rotated360 = rotatePhase(baseTable('square'), 360);
    const base = baseTable('square');
    arrayCloseTo(rotated360.real, base.real);
    arrayCloseTo(rotated360.imag, base.imag);
  });

  it('returns independent copies so caller mutation does not poison the cache', () => {
    const a = baseTable('sine');
    a.imag[1] = 999;
    const b = baseTable('sine');
    expect(b.imag[1]).toBe(1);
  });
});
```

- [ ] **Step 4: Create PhaseOffsetOscillator**

Create `src/engine/modules/oscillator/PhaseOffsetOscillator.ts`:

```ts
import type { IOscillatorModule } from './types';
import { baseTable, rotatePhase } from './WaveformTables';

export class PhaseOffsetOscillator implements IOscillatorModule {
  private osc: OscillatorNode;
  private gain: GainNode;

  private ctx: AudioContext;
  private waveform: OscillatorType = 'sawtooth';
  private phaseDeg: number = 0;
  private coarseTune: number = 0;
  private baseFreq: number = 440;

  readonly outputs: { main: GainNode };

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.osc = ctx.createOscillator();
    this.gain = ctx.createGain();
    this.osc.connect(this.gain);
    this.outputs = { main: this.gain };
    this.applyWave();
    this.osc.start();
  }

  private applyWave() {
    const rotated = rotatePhase(baseTable(this.waveform), this.phaseDeg);
    const wave = this.ctx.createPeriodicWave(rotated.real, rotated.imag, {
      disableNormalization: false,
    });
    this.osc.setPeriodicWave(wave);
  }

  setWaveform(type: OscillatorType) {
    this.waveform = type;
    this.applyWave();
  }

  setPhase(degrees: number) {
    // Wrap into [0, 360). Negative values OK from a knob but we normalize for
    // determinism in tests + log output.
    this.phaseDeg = ((degrees % 360) + 360) % 360;
    this.applyWave();
  }

  setCoarseTune(octaves: number) {
    this.coarseTune = octaves;
    this.setFrequencyAtTime(this.baseFreq, this.ctx.currentTime);
  }

  setFineTune(cents: number) {
    this.osc.detune.setValueAtTime(cents, this.ctx.currentTime);
  }

  setFrequencyAtTime(freq: number, time: number) {
    this.baseFreq = freq;
    const finalFreq = this.baseFreq * Math.pow(2, this.coarseTune);
    this.osc.frequency.setValueAtTime(finalFreq, time);
  }

  // Free-running: trigger is a frequency schedule, identical to FreeRun.
  triggerAt(freq: number, time: number, _releaseTime: number) {
    this.setFrequencyAtTime(freq, time);
  }

  dispose() {
    try {
      this.osc.stop();
    } catch {
      // already stopped
    }
    this.osc.disconnect();
    this.gain.disconnect();
  }
}
```

- [ ] **Step 5: Create PhaseOffsetOscillator test**

Create `src/engine/modules/oscillator/PhaseOffsetOscillator.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { PhaseOffsetOscillator } from './PhaseOffsetOscillator';

class MockAudioParam {
  value = 0;
  setValueAtTime = vi.fn();
}
class MockOscillatorNode {
  frequency = new MockAudioParam();
  detune = new MockAudioParam();
  type: OscillatorType = 'sine';
  start = vi.fn();
  stop = vi.fn();
  connect = vi.fn();
  disconnect = vi.fn();
  setPeriodicWave = vi.fn();
  context = { currentTime: 0 };
}
class MockGainNode {
  gain = new MockAudioParam();
  connect = vi.fn();
  disconnect = vi.fn();
}
class MockAudioContext {
  currentTime = 0;
  createPeriodicWave = vi.fn().mockImplementation((real: Float32Array, imag: Float32Array) => ({ real, imag }));
  createOscillator() { return new MockOscillatorNode(); }
  createGain() { return new MockGainNode(); }
}
vi.stubGlobal('AudioContext', MockAudioContext);

describe('PhaseOffsetOscillator', () => {
  it('applies a PeriodicWave on construction and start()s the osc', () => {
    const ctx = new (AudioContext as any)();
    const osc = new PhaseOffsetOscillator(ctx);
    expect(ctx.createPeriodicWave).toHaveBeenCalledTimes(1);
    expect((osc as any).osc.setPeriodicWave).toHaveBeenCalledTimes(1);
    expect((osc as any).osc.start).toHaveBeenCalledTimes(1);
  });

  it('setWaveform rebuilds the PeriodicWave', () => {
    const ctx = new (AudioContext as any)();
    const osc = new PhaseOffsetOscillator(ctx);
    ctx.createPeriodicWave.mockClear();
    osc.setWaveform('square');
    expect(ctx.createPeriodicWave).toHaveBeenCalledTimes(1);
    expect((osc as any).osc.setPeriodicWave).toHaveBeenCalled();
  });

  it('setPhase rebuilds the PeriodicWave with rotated coefficients', () => {
    const ctx = new (AudioContext as any)();
    const osc = new PhaseOffsetOscillator(ctx);
    ctx.createPeriodicWave.mockClear();
    osc.setPhase(90);
    expect(ctx.createPeriodicWave).toHaveBeenCalledTimes(1);
    // The rotated arrays passed should differ from the phase=0 baseline.
    const [real, imag] = ctx.createPeriodicWave.mock.calls[0];
    expect(real).toBeInstanceOf(Float32Array);
    expect(imag).toBeInstanceOf(Float32Array);
    // For sawtooth at 90°, imag[1] is not equal to the unrotated value.
    expect(imag[1]).not.toBe(2 / Math.PI);
  });

  it('setPhase wraps negative and >360 inputs into [0, 360)', () => {
    const ctx = new (AudioContext as any)();
    const osc = new PhaseOffsetOscillator(ctx);
    osc.setPhase(-90);
    expect((osc as any).phaseDeg).toBe(270);
    osc.setPhase(450);
    expect((osc as any).phaseDeg).toBe(90);
  });

  it('triggerAt delegates to setFrequencyAtTime', () => {
    const ctx = new (AudioContext as any)();
    const osc = new PhaseOffsetOscillator(ctx);
    const spy = vi.spyOn(osc, 'setFrequencyAtTime');
    osc.triggerAt(220, 0.5, 99);
    expect(spy).toHaveBeenCalledWith(220, 0.5);
  });
});
```

- [ ] **Step 6: Add `oscMode`, `osc1Phase`, `osc2Phase` to SynthEngineParams + DEFAULT_PARAMS**

In `src/engine/SynthEngine.ts`:

After the existing imports add:

```ts
import type { OscMode } from './modules/oscillator';
```

Extend `SynthEngineParams` (around line 11-28) with three additive fields, keeping all existing fields in place:

```ts
export interface SynthEngineParams {
  // ... existing fields ...
  mode: 'mono' | 'poly';

  // Experimental: which oscillator-phase strategy to use.
  // 'free-run' = today's behavior; 'phase-offset' = rotated PeriodicWave;
  // 'retrigger-recreate' = fresh OscillatorNode per trigger;
  // 'retrigger-wavetable' = AudioBufferSourceNode + one-cycle bank.
  // Per-osc phase knobs (in degrees, 0..360) apply in 'phase-offset' and
  // retrigger modes; free-run ignores them.
  oscMode: OscMode;
  osc1Phase: number;
  osc2Phase: number;
}
```

Extend `DEFAULT_PARAMS` (around line 40-56):

```ts
  static readonly DEFAULT_PARAMS: SynthEngineParams = {
    // ... existing fields ...
    mode: 'mono',
    oscMode: 'free-run',
    osc1Phase: 0,
    osc2Phase: 0,
  };
```

Also add cached private fields (alongside the existing osc1Type / osc1Coarse / etc., around lines 60-72):

```ts
  private oscMode: OscMode = SynthEngine.DEFAULT_PARAMS.oscMode;
  private osc1Phase: number = SynthEngine.DEFAULT_PARAMS.osc1Phase;
  private osc2Phase: number = SynthEngine.DEFAULT_PARAMS.osc2Phase;
```

- [ ] **Step 7: Add SynthEngine setters + applyParams branches**

In `src/engine/SynthEngine.ts`, add three setters after the existing oscillator setters:

```ts
  setOscMode(mode: OscMode) {
    if (mode === this.oscMode) return;
    this.oscMode = mode;
    // Each voice rebuilds its osc1/osc2 from the factory, then re-applies
    // the cached osc/phase/coarse/fine/waveform state so the swap is seamless.
    this.voices.forEach(voice => voice.replaceOscillators(
      mode,
      {
        osc1Type: this.osc1Type,
        osc2Type: this.osc2Type,
        osc1Coarse: this.osc1Coarse,
        osc1Fine: this.osc1Fine,
        osc2Coarse: this.osc2Coarse,
        osc2Fine: this.osc2Fine,
        osc1Phase: this.osc1Phase,
        osc2Phase: this.osc2Phase,
      },
    ));
  }

  setOsc1Phase(degrees: number) {
    this.osc1Phase = ((degrees % 360) + 360) % 360;
    this.voices.forEach(voice => voice.osc1.setPhase(this.osc1Phase));
  }

  setOsc2Phase(degrees: number) {
    this.osc2Phase = ((degrees % 360) + 360) % 360;
    this.voices.forEach(voice => voice.osc2.setPhase(this.osc2Phase));
  }
```

Add three branches to `applyParams` (around lines 182-196):

```ts
    if (params.oscMode !== undefined) this.setOscMode(params.oscMode);
    if (params.osc1Phase !== undefined) this.setOsc1Phase(params.osc1Phase);
    if (params.osc2Phase !== undefined) this.setOsc2Phase(params.osc2Phase);
```

Order doesn't matter — they're independent of the existing branches.

- [ ] **Step 8: Add `replaceOscillators` to SynthVoice**

In `src/engine/SynthVoice.ts`, extend the top-of-file import block to also export the `OscMode` type (already importing `makeOscillator` since T1):

```ts
import { makeOscillator, type IOscillatorModule, type OscMode } from './modules/oscillator';
```

Add a method (after `applyParams`, before `dispose`):

```ts
  // Tear down osc1/osc2, rebuild them via the factory at `mode`, then reapply
  // the cached state so the audible content survives the swap. PatchBay
  // edges are re-established into mixer ch1/ch2.
  replaceOscillators(
    mode: OscMode,
    state: {
      osc1Type: OscillatorType;
      osc2Type: OscillatorType;
      osc1Coarse: number;
      osc1Fine: number;
      osc2Coarse: number;
      osc2Fine: number;
      osc1Phase: number;
      osc2Phase: number;
    },
  ) {
    // Dispose old osc modules.
    this.osc1.dispose();
    this.osc2.dispose();

    // Build new ones from the factory (imported at top of file).
    this.osc1 = makeOscillator(mode, this.ctx);
    this.osc2 = makeOscillator(mode, this.ctx);

    // Re-apply cached state.
    this.osc1.setWaveform(state.osc1Type);
    this.osc1.setCoarseTune(state.osc1Coarse);
    this.osc1.setFineTune(state.osc1Fine);
    this.osc1.setPhase(state.osc1Phase);
    this.osc2.setWaveform(state.osc2Type);
    this.osc2.setCoarseTune(state.osc2Coarse);
    this.osc2.setFineTune(state.osc2Fine);
    this.osc2.setPhase(state.osc2Phase);

    // Re-wire into mixer ch1/ch2 using the existing PatchBay.
    this.patchBay.connect(this.osc1.outputs.main, this.mixer.inputs.ch1);
    this.patchBay.connect(this.osc2.outputs.main, this.mixer.inputs.ch2);
  }
```

This requires lifting `patchBay` from `private` to at least `protected` (or removing the modifier — the field is currently `private patchBay: PatchBay`). Change the declaration to:

```ts
  private patchBay: PatchBay;  // unchanged — replaceOscillators lives on this class so private is fine
```

(`private` is class-scoped, so `replaceOscillators` can access it directly.)

- [ ] **Step 9: Wire `'phase-offset'` into the factory**

In `src/engine/modules/oscillator/index.ts` extend the switch:

```ts
import { PhaseOffsetOscillator } from './PhaseOffsetOscillator';
// ... existing exports ...

export function makeOscillator(mode: OscMode, ctx: AudioContext): IOscillatorModule {
  switch (mode) {
    case 'phase-offset':
      return new PhaseOffsetOscillator(ctx);
    case 'free-run':
    case 'retrigger-recreate':       // T3 wires this branch
    case 'retrigger-wavetable':      // T4 wires this branch
    default:
      return new FreeRunOscillator(ctx);
  }
}
```

- [ ] **Step 10: Create SynthVoice.test.ts (mode-swap test)**

Create `src/engine/SynthVoice.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { SynthVoice } from './SynthVoice';

// Minimal Web Audio mocks — same pattern as SynthEngine.test.ts.
class MockAudioParam {
  value = 0;
  setValueAtTime = vi.fn();
  setTargetAtTime = vi.fn();
  cancelScheduledValues = vi.fn();
  cancelAndHoldAtTime = vi.fn();
  linearRampToValueAtTime = vi.fn();
}
class MockOscillatorNode {
  frequency = new MockAudioParam();
  detune = new MockAudioParam();
  type: OscillatorType = 'sine';
  start = vi.fn();
  stop = vi.fn();
  connect = vi.fn();
  disconnect = vi.fn();
  setPeriodicWave = vi.fn();
  context = { currentTime: 0 };
}
class MockGainNode {
  gain = new MockAudioParam();
  connect = vi.fn();
  disconnect = vi.fn();
}
class MockBiquadFilterNode {
  type = 'lowpass';
  frequency = new MockAudioParam();
  Q = new MockAudioParam();
  connect = vi.fn();
  disconnect = vi.fn();
}
class MockAudioContext {
  currentTime = 0;
  createOscillator() { return new MockOscillatorNode(); }
  createGain() { return new MockGainNode(); }
  createBiquadFilter() { return new MockBiquadFilterNode(); }
  createPeriodicWave = vi.fn().mockImplementation(() => ({}));
}
vi.stubGlobal('AudioContext', MockAudioContext);

describe('SynthVoice', () => {
  it('replaceOscillators disposes the old osc1/osc2 and rewires new ones', () => {
    const ctx = new (AudioContext as any)();
    const dest = new MockGainNode();
    const voice = new SynthVoice(ctx as any, dest as any);

    const oldOsc1 = voice.osc1;
    const oldOsc2 = voice.osc2;
    const dispose1 = vi.spyOn(oldOsc1, 'dispose');
    const dispose2 = vi.spyOn(oldOsc2, 'dispose');

    voice.replaceOscillators('phase-offset', {
      osc1Type: 'sawtooth',
      osc2Type: 'sawtooth',
      osc1Coarse: 0,
      osc1Fine: 0,
      osc2Coarse: 0,
      osc2Fine: 0,
      osc1Phase: 0,
      osc2Phase: 0,
    });

    expect(dispose1).toHaveBeenCalled();
    expect(dispose2).toHaveBeenCalled();
    expect(voice.osc1).not.toBe(oldOsc1);
    expect(voice.osc2).not.toBe(oldOsc2);
  });
});
```

- [ ] **Step 11: Extend SynthEngine.test.ts with new branches**

In `src/engine/SynthEngine.test.ts`, add (alongside the existing tests):

```ts
  it('setOscMode replaces oscillators on every voice', () => {
    const engine = new SynthEngine();
    const spies = engine.voices.map(v => vi.spyOn(v, 'replaceOscillators'));
    engine.setOscMode('phase-offset');
    spies.forEach(s => expect(s).toHaveBeenCalledTimes(1));
  });

  it('setOscMode is idempotent when called with the current mode', () => {
    const engine = new SynthEngine();
    engine.setOscMode('free-run'); // already the default
    const spies = engine.voices.map(v => vi.spyOn(v, 'replaceOscillators'));
    engine.setOscMode('free-run');
    spies.forEach(s => expect(s).not.toHaveBeenCalled());
  });

  it('applyParams routes oscMode/osc1Phase/osc2Phase to their setters', () => {
    const engine = new SynthEngine();
    const setMode = vi.spyOn(engine, 'setOscMode');
    const setP1 = vi.spyOn(engine, 'setOsc1Phase');
    const setP2 = vi.spyOn(engine, 'setOsc2Phase');
    engine.applyParams({ oscMode: 'phase-offset', osc1Phase: 90, osc2Phase: 270 });
    expect(setMode).toHaveBeenCalledWith('phase-offset');
    expect(setP1).toHaveBeenCalledWith(90);
    expect(setP2).toHaveBeenCalledWith(270);
  });
```

- [ ] **Step 12: Add `'degrees'` format to Knob.vue**

In `src/components/Knob.vue` (props block around line 70):

```ts
  format?: 'hz' | 'ms' | 'percent' | 'cents' | 'octave' | 'ratio' | 'db' | 'degrees';
```

Add a case to `formattedValue` (around line 124):

```ts
    case 'degrees':
      return Math.round(val) + '°';
```

- [ ] **Step 13: Add three trackParams + exports in useSynth.ts**

In `src/composables/useSynth.ts` after the existing synth params block (around line 292):

```ts
  const oscMode = trackParam('synth', 'oscMode', 'free-run' as const);
  const osc1Phase = trackParam('synth', 'osc1Phase', 0);
  const osc2Phase = trackParam('synth', 'osc2Phase', 0);
```

Add them to the `return` object (around line 385-407, alongside the other synth params):

```ts
    oscMode,
    osc1Phase,
    osc2Phase,
```

- [ ] **Step 14: Add UI to OscillatorPanel.vue**

Replace `src/components/OscillatorPanel.vue` entirely with:

```vue
<template>
  <div class="module-group">
    <h3>Oscillators</h3>

    <div class="osc-mode-row">
      <label>OSC MODE</label>
      <select v-model="oscMode">
        <option value="free-run">free-run</option>
        <option value="phase-offset">phase-offset</option>
        <option value="retrigger-recreate">retrigger-recreate</option>
        <option value="retrigger-wavetable">retrigger-wavetable</option>
      </select>
    </div>

    <div class="osc-row">
      <div class="osc-unit">
        <h4>OSC 1</h4>
        <select v-model="osc1Type">
          <option v-for="t in waveforms" :key="t" :value="t">{{ t }}</option>
        </select>
        <div class="osc-knobs">
          <Knob label="Coarse" :min="-3" :max="3" :step="1" :defaultValue="DEFAULTS.osc1Coarse" format="octave" v-model="osc1Coarse" />
          <Knob label="Fine" :min="-100" :max="100" :step="1" :defaultValue="DEFAULTS.osc1Fine" format="cents" v-model="osc1Fine" />
          <div :class="{ inert: oscMode === 'free-run' }">
            <Knob label="Phase" :min="0" :max="360" :step="1" :defaultValue="DEFAULTS.osc1Phase" format="degrees" v-model="osc1Phase" />
          </div>
        </div>
      </div>
      <div class="osc-unit">
        <h4>OSC 2</h4>
        <select v-model="osc2Type">
          <option v-for="t in waveforms" :key="t" :value="t">{{ t }}</option>
        </select>
        <div class="osc-knobs">
          <Knob label="Coarse" :min="-3" :max="3" :step="1" :defaultValue="DEFAULTS.osc2Coarse" format="octave" v-model="osc2Coarse" />
          <Knob label="Fine" :min="-100" :max="100" :step="1" :defaultValue="DEFAULTS.osc2Fine" format="cents" v-model="osc2Fine" />
          <div :class="{ inert: oscMode === 'free-run' }">
            <Knob label="Phase" :min="0" :max="360" :step="1" :defaultValue="DEFAULTS.osc2Phase" format="degrees" v-model="osc2Phase" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import Knob from './Knob.vue';
import { SynthEngine } from '../engine/SynthEngine';
import type { OscMode } from '../engine/modules/oscillator';

const DEFAULTS = SynthEngine.DEFAULT_PARAMS;

defineProps<{
  waveforms: OscillatorType[];
}>();

const oscMode = defineModel<OscMode>('oscMode', { required: true });
const osc1Type = defineModel<OscillatorType>('osc1Type', { required: true });
const osc1Coarse = defineModel<number>('osc1Coarse', { required: true });
const osc1Fine = defineModel<number>('osc1Fine', { required: true });
const osc1Phase = defineModel<number>('osc1Phase', { required: true });

const osc2Type = defineModel<OscillatorType>('osc2Type', { required: true });
const osc2Coarse = defineModel<number>('osc2Coarse', { required: true });
const osc2Fine = defineModel<number>('osc2Fine', { required: true });
const osc2Phase = defineModel<number>('osc2Phase', { required: true });
</script>

<style scoped>
.osc-mode-row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.osc-mode-row label { font-size: 0.7rem; color: #888; font-weight: bold; letter-spacing: 0.05em; }
.osc-mode-row select { background: #000; color: #fff; border: 1px solid #444; padding: 4px 6px; border-radius: 3px; flex: 1; font-size: 0.75rem; }

.osc-row { display: flex; flex-direction: column; gap: 12px; }
.osc-unit { background: #333; padding: 10px; border-radius: 4px; display: flex; flex-direction: column; }
.osc-unit h4 { margin: 0 0 10px 0; font-size: 0.8rem; color: #888; }
.osc-knobs { display: flex; gap: 15px; }
select { background: #000; color: #fff; border: 1px solid #444; padding: 5px; margin-bottom: 10px; border-radius: 3px; }

/* Phase knobs only matter in modes other than free-run. Render dim to signal
   they currently have no audible effect, but keep them interactive so a
   pre-set value sticks when the user flips to phase-offset / retrigger. */
.inert { opacity: 0.4; }
</style>
```

- [ ] **Step 15: Add pass-through in SynthPanel.vue**

In `src/components/SynthPanel.vue`, add three `defineModel`s + three `v-model:` bindings on the existing `OscillatorPanel` invocation.

After existing `defineModel` lines, add:

```ts
const oscMode = defineModel<'free-run' | 'phase-offset' | 'retrigger-recreate' | 'retrigger-wavetable'>('oscMode', { required: true });
const osc1Phase = defineModel<number>('osc1Phase', { required: true });
const osc2Phase = defineModel<number>('osc2Phase', { required: true });
```

In the template, update the `<OscillatorPanel ... />` invocation to include:

```vue
<OscillatorPanel
  v-model:oscMode="oscMode"
  v-model:osc1Type="osc1Type"
  v-model:osc1Coarse="osc1Coarse"
  v-model:osc1Fine="osc1Fine"
  v-model:osc1Phase="osc1Phase"
  v-model:osc2Type="osc2Type"
  v-model:osc2Coarse="osc2Coarse"
  v-model:osc2Fine="osc2Fine"
  v-model:osc2Phase="osc2Phase"
  :waveforms="waveforms"
/>
```

- [ ] **Step 16: Bind from useSynth in App.vue**

In `src/App.vue`:

Add to the `useSynth()` destructure (around line 232):

```ts
  oscMode,
  osc1Phase,
  osc2Phase,
```

Add to the `<SynthPanel>` invocation (around line 120):

```vue
v-model:oscMode="oscMode"
v-model:osc1Phase="osc1Phase"
v-model:osc2Phase="osc2Phase"
```

- [ ] **Step 17: Extend preset round-trip test**

In `src/project/preset.test.ts`, add:

```ts
  it('legacy preset (no oscMode/phase fields) round-trips with default oscMode=free-run', () => {
    const legacy = {
      schemaVersion: 1,
      engineType: 'synth',
      params: {
        osc1Type: 'sawtooth',
        osc2Type: 'sawtooth',
        // Note: oscMode, osc1Phase, osc2Phase intentionally absent.
      },
    };
    const text = JSON.stringify(legacy);
    const restored = deserializePreset(text);
    expect((restored.params as any).oscMode).toBe('free-run');
    expect((restored.params as any).osc1Phase).toBe(0);
    expect((restored.params as any).osc2Phase).toBe(0);
  });
```

Place this near the other deserialize tests; it asserts the reconciler fills the new fields from `SynthEngine.DEFAULT_PARAMS`.

- [ ] **Step 18: Run gates**

Run: `npx vue-tsc --noEmit`
Expected: clean.

Run: `npm test`
Expected: ~177 baseline (after T1) + ~10 new = ~187 tests pass.

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 19: Browser smoke**

Run `npm run dev`. Focus track 1 (synth). Confirm:
1. Free-run is the default; sound matches today.
2. OSC MODE dropdown shows 4 options. Pick `phase-offset`. Phase knobs go full opacity.
3. Twist OSC 2 Phase to ~180°. The OSC 1 + OSC 2 mix should sound noticeably different vs OSC 2 Phase=0° (timbral cancellation if sawtooths are tuned to unison).
4. Refresh the page. The mode + phase values persist.
5. SAVE PRESET → INIT PATCH → LOAD PRESET round-trips the new fields.
6. Switch back to `free-run`. Phase knobs go to 40% opacity but remain draggable.

- [ ] **Step 20: Commit + merge back**

```bash
git add src/engine/modules/oscillator/WaveformTables.ts src/engine/modules/oscillator/WaveformTables.test.ts \
        src/engine/modules/oscillator/PhaseOffsetOscillator.ts src/engine/modules/oscillator/PhaseOffsetOscillator.test.ts \
        src/engine/SynthVoice.test.ts \
        src/engine/modules/oscillator/index.ts src/engine/SynthEngine.ts src/engine/SynthEngine.test.ts \
        src/engine/SynthVoice.ts src/composables/useSynth.ts \
        src/components/Knob.vue src/components/OscillatorPanel.vue src/components/SynthPanel.vue \
        src/App.vue src/project/preset.test.ts
git commit -m "$(cat <<'EOF'
feat(synth): phase-offset oscillator mode + UI

T2 of feature/osc-phase-experiment.

- Adds oscMode/osc1Phase/osc2Phase to SynthEngineParams (additive — no
  schema bump; reconcileWithDefaults handles missing fields).
- New PhaseOffsetOscillator: free-running OscillatorNode driven by a
  PeriodicWave whose Fourier coefficients are rotated by the configured
  phase angle. Rebuilds on setWaveform / setPhase.
- WaveformTables.ts: reference Fourier (real, imag) for sine/square/saw/
  triangle, 32 harmonics, plus rotatePhase() helper.
- SynthVoice.replaceOscillators(mode, state) tears down osc1/osc2 and
  rebuilds via the factory, re-applying cached waveform/coarse/fine/phase.
- SynthEngine.setOscMode + setOsc1Phase + setOsc2Phase wired through
  applyParams; the per-slice synth watcher routes them automatically.
- UI: osc mode dropdown above the OSC row; Phase knob per osc; .inert
  styling at 40% opacity when mode is 'free-run'.
- Knob.vue grows a 'degrees' format string.
- Preset round-trip test confirms legacy presets gain default oscMode/phase
  values via the reconciler.
EOF
)"

git checkout feature/osc-phase-experiment
git merge --no-ff task/osc-phase-offset -m "Merge T2: phase-offset oscillator mode"
```

---

## Task 3: Retrigger-recreate mode

**Sub-branch:** `task/osc-retrigger-recreate`

**Files:**
- Create: `src/engine/modules/oscillator/RetriggerOscillator.ts`
- Create: `src/engine/modules/oscillator/RetriggerOscillator.test.ts`
- Modify: `src/engine/modules/oscillator/index.ts` (factory: wire `'retrigger-recreate'`)

**Goal:** Add the recreate-per-trigger module. SynthVoice already calls `osc.triggerAt(freq, time, releaseTime)` since T1, so no voice changes here.

### Steps

- [ ] **Step 1: Create the sub-branch**

```bash
git checkout feature/osc-phase-experiment
git checkout -b task/osc-retrigger-recreate
```

- [ ] **Step 2: Create RetriggerOscillator**

Create `src/engine/modules/oscillator/RetriggerOscillator.ts`:

```ts
import type { IOscillatorModule } from './types';
import { baseTable, rotatePhase } from './WaveformTables';

const STOP_TAIL_SECONDS = 0.05; // safety margin past ampEnv release

export class RetriggerOscillator implements IOscillatorModule {
  private ctx: AudioContext;
  // Output sink — patch bay connects to this; the per-trigger osc connects
  // into this gain on each trigger. Stays alive for the module's lifetime.
  private outGain: GainNode;

  private waveform: OscillatorType = 'sawtooth';
  private phaseDeg: number = 0;
  private coarseTune: number = 0;
  private fineCents: number = 0;

  readonly outputs: { main: GainNode };

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.outGain = ctx.createGain();
    this.outputs = { main: this.outGain };
  }

  setWaveform(type: OscillatorType) {
    this.waveform = type;
  }

  setPhase(degrees: number) {
    this.phaseDeg = ((degrees % 360) + 360) % 360;
  }

  setCoarseTune(octaves: number) {
    this.coarseTune = octaves;
  }

  setFineTune(cents: number) {
    this.fineCents = cents;
  }

  // No live osc to schedule against — the retrigger model rebuilds the
  // osc on each note-on, so a mid-note frequency change has no source to
  // write to. We just cache the value; the next trigger will use it.
  setFrequencyAtTime(_freq: number, _time: number) {
    /* no-op — see class comment */
  }

  triggerAt(freq: number, time: number, releaseTime: number) {
    const osc = this.ctx.createOscillator();

    // Build the phase-rotated PeriodicWave for this trigger.
    const rotated = rotatePhase(baseTable(this.waveform), this.phaseDeg);
    const wave = this.ctx.createPeriodicWave(rotated.real, rotated.imag, {
      disableNormalization: false,
    });
    osc.setPeriodicWave(wave);

    const finalFreq = freq * Math.pow(2, this.coarseTune);
    osc.frequency.setValueAtTime(finalFreq, time);
    osc.detune.setValueAtTime(this.fineCents, time);

    osc.connect(this.outGain);
    osc.start(time);
    osc.stop(releaseTime + STOP_TAIL_SECONDS);
    // GC happens automatically via the ended event; no manual bookkeeping.
  }

  dispose() {
    this.outGain.disconnect();
  }
}
```

- [ ] **Step 3: Create RetriggerOscillator test**

Create `src/engine/modules/oscillator/RetriggerOscillator.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { RetriggerOscillator } from './RetriggerOscillator';

class MockAudioParam {
  value = 0;
  setValueAtTime = vi.fn();
}
class MockOscillatorNode {
  frequency = new MockAudioParam();
  detune = new MockAudioParam();
  start = vi.fn();
  stop = vi.fn();
  connect = vi.fn();
  disconnect = vi.fn();
  setPeriodicWave = vi.fn();
}
class MockGainNode {
  gain = new MockAudioParam();
  connect = vi.fn();
  disconnect = vi.fn();
}
class MockAudioContext {
  currentTime = 0;
  createOscillator = vi.fn().mockImplementation(() => new MockOscillatorNode());
  createGain = vi.fn().mockImplementation(() => new MockGainNode());
  createPeriodicWave = vi.fn().mockImplementation((real: Float32Array, imag: Float32Array) => ({ real, imag }));
}
vi.stubGlobal('AudioContext', MockAudioContext);

describe('RetriggerOscillator', () => {
  it('does not create an oscillator at construction', () => {
    const ctx = new (AudioContext as any)();
    new RetriggerOscillator(ctx);
    expect(ctx.createOscillator).not.toHaveBeenCalled();
  });

  it('triggerAt creates a fresh osc, sets the rotated PeriodicWave, and schedules start+stop', () => {
    const ctx = new (AudioContext as any)();
    const osc = new RetriggerOscillator(ctx);
    osc.triggerAt(440, 1.0, 1.5);

    expect(ctx.createOscillator).toHaveBeenCalledTimes(1);
    const created = ctx.createOscillator.mock.results[0].value as any;
    expect(created.setPeriodicWave).toHaveBeenCalledTimes(1);
    expect(created.frequency.setValueAtTime).toHaveBeenCalledWith(440, 1.0);
    expect(created.start).toHaveBeenCalledWith(1.0);
    // stop = releaseTime + 50ms safety
    expect(created.stop).toHaveBeenCalledWith(1.55);
  });

  it('two consecutive triggerAt calls create two distinct osc nodes', () => {
    const ctx = new (AudioContext as any)();
    const osc = new RetriggerOscillator(ctx);
    osc.triggerAt(440, 0, 0.5);
    osc.triggerAt(523, 0.5, 1.0);
    expect(ctx.createOscillator).toHaveBeenCalledTimes(2);
  });

  it('setPhase between triggers affects only subsequent triggers', () => {
    const ctx = new (AudioContext as any)();
    const osc = new RetriggerOscillator(ctx);
    osc.triggerAt(440, 0, 0.5);
    const firstPhase = ctx.createPeriodicWave.mock.calls[0];
    osc.setPhase(90);
    osc.triggerAt(440, 0.5, 1.0);
    const secondPhase = ctx.createPeriodicWave.mock.calls[1];
    // Coefficients should differ between trigger 1 (phase=0) and trigger 2 (phase=90).
    expect(firstPhase[1][1]).not.toBe(secondPhase[1][1]);
  });

  it('coarseTune is applied at trigger time', () => {
    const ctx = new (AudioContext as any)();
    const osc = new RetriggerOscillator(ctx);
    osc.setCoarseTune(1); // +1 octave
    osc.triggerAt(440, 0, 0.5);
    const created = ctx.createOscillator.mock.results[0].value as any;
    expect(created.frequency.setValueAtTime).toHaveBeenCalledWith(880, 0);
  });
});
```

- [ ] **Step 4: Wire `'retrigger-recreate'` in the factory**

In `src/engine/modules/oscillator/index.ts`:

```ts
import { RetriggerOscillator } from './RetriggerOscillator';
// ... existing imports ...

export function makeOscillator(mode: OscMode, ctx: AudioContext): IOscillatorModule {
  switch (mode) {
    case 'phase-offset':
      return new PhaseOffsetOscillator(ctx);
    case 'retrigger-recreate':
      return new RetriggerOscillator(ctx);
    case 'free-run':
    case 'retrigger-wavetable':       // T4 wires this branch
    default:
      return new FreeRunOscillator(ctx);
  }
}
```

- [ ] **Step 5: Run gates**

Run: `npx vue-tsc --noEmit`
Expected: clean.

Run: `npm test`
Expected: previous baseline + 5 new tests pass.

Run: `npm run build`
Expected: clean.

- [ ] **Step 6: Browser smoke**

Run `npm run dev`. Focus a synth track, pick `retrigger-recreate` from the mode dropdown. Set both phases to 0 first; play a sequence — sound is similar to phase-offset but every note starts at the exact same phase. Now set osc1 phase to 0, osc2 phase to 180 — the two oscs should fully cancel each other on every trigger (since they're at the same freq + opposite phase). This is the perceptual proof that retrigger mode locks inter-osc phase.

- [ ] **Step 7: Commit + merge back**

```bash
git add src/engine/modules/oscillator/RetriggerOscillator.ts \
        src/engine/modules/oscillator/RetriggerOscillator.test.ts \
        src/engine/modules/oscillator/index.ts
git commit -m "$(cat <<'EOF'
feat(synth): retrigger-recreate oscillator mode

T3 of feature/osc-phase-experiment.

- New RetriggerOscillator: no live osc at construction; each triggerAt()
  creates a fresh OscillatorNode with the phase-rotated PeriodicWave baked
  in, connects to the persistent output gain, schedules start(time) +
  stop(releaseTime + 50ms safety). The previous trigger's osc keeps its
  own scheduled lifetime; no manual cleanup needed (onended GCs it).
- Because both osc1 and osc2 start at the same `time` with their phases
  baked into their PeriodicWaves, the inter-osc phase relationship is
  exactly reproducible across triggers — the experimental claim.
- Factory wires 'retrigger-recreate' to the new class.
EOF
)"

git checkout feature/osc-phase-experiment
git merge --no-ff task/osc-retrigger-recreate -m "Merge T3: retrigger-recreate oscillator mode"
```

---

## Task 4: Wavetable mode + lazy bank

**Sub-branch:** `task/osc-wavetable`

**Files:**
- Create: `src/engine/modules/oscillator/WavetableOscillator.ts`
- Create: `src/engine/modules/oscillator/WavetableOscillator.test.ts` (`// @vitest-environment jsdom`)
- Modify: `src/engine/modules/oscillator/index.ts` (factory: wire `'retrigger-wavetable'`)

**Goal:** Add the AudioBufferSourceNode + lazy one-cycle bank mode. Bank rendered once per AudioContext (class-level singleton), reused across all voices.

### Steps

- [ ] **Step 1: Create the sub-branch**

```bash
git checkout feature/osc-phase-experiment
git checkout -b task/osc-wavetable
```

- [ ] **Step 2: Create WavetableOscillator**

Create `src/engine/modules/oscillator/WavetableOscillator.ts`:

```ts
import type { IOscillatorModule } from './types';

const BUFFER_LENGTH = 2048;
const STOP_TAIL_SECONDS = 0.05;

type Bank = Record<OscillatorType, AudioBuffer>;

// Render one cycle of `type` into an AudioBuffer. Sample i = sin(2π·i/N) for
// sine; for sawtooth/square/triangle, we sum the bandlimited Fourier series
// (same coefficients as WaveformTables, but evaluated in the time domain).
function renderOneCycle(ctx: AudioContext, type: OscillatorType): AudioBuffer {
  const buf = ctx.createBuffer(1, BUFFER_LENGTH, ctx.sampleRate);
  const data = buf.getChannelData(0);
  const N = 32; // harmonics

  for (let i = 0; i < BUFFER_LENGTH; i++) {
    const t = i / BUFFER_LENGTH; // 0..1 across one cycle
    const phase = 2 * Math.PI * t;
    let s = 0;
    if (type === 'sine') {
      s = Math.sin(phase);
    } else if (type === 'sawtooth') {
      for (let k = 1; k <= N; k++) {
        const sign = (k % 2 === 1) ? 1 : -1;
        s += sign * (2 / (Math.PI * k)) * Math.sin(k * phase);
      }
    } else if (type === 'square') {
      for (let k = 1; k <= N; k += 2) {
        s += (4 / (Math.PI * k)) * Math.sin(k * phase);
      }
    } else if (type === 'triangle') {
      for (let k = 1; k <= N; k += 2) {
        const sign = (((k - 1) / 2) % 2 === 0) ? 1 : -1;
        s += sign * (8 / (Math.PI * Math.PI * k * k)) * Math.sin(k * phase);
      }
    } else {
      s = Math.sin(phase); // unknown / 'custom' falls back to sine
    }
    data[i] = s;
  }
  return buf;
}

export class WavetableOscillator implements IOscillatorModule {
  private static bank: Bank | null = null;
  private static bankSampleRate: number = 0;

  // Lazy: render once per ctx (sample-rate-keyed; our app never changes it).
  static ensureBank(ctx: AudioContext): Bank {
    if (WavetableOscillator.bank && WavetableOscillator.bankSampleRate === ctx.sampleRate) {
      return WavetableOscillator.bank;
    }
    WavetableOscillator.bank = {
      sine: renderOneCycle(ctx, 'sine'),
      sawtooth: renderOneCycle(ctx, 'sawtooth'),
      square: renderOneCycle(ctx, 'square'),
      triangle: renderOneCycle(ctx, 'triangle'),
      custom: renderOneCycle(ctx, 'sine'),
    };
    WavetableOscillator.bankSampleRate = ctx.sampleRate;
    return WavetableOscillator.bank;
  }

  private ctx: AudioContext;
  private outGain: GainNode;
  private waveform: OscillatorType = 'sawtooth';
  private phaseDeg: number = 0;
  private coarseTune: number = 0;
  private fineCents: number = 0;

  readonly outputs: { main: GainNode };

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    WavetableOscillator.ensureBank(ctx);
    this.outGain = ctx.createGain();
    this.outputs = { main: this.outGain };
  }

  setWaveform(type: OscillatorType) { this.waveform = type; }
  setPhase(deg: number) { this.phaseDeg = ((deg % 360) + 360) % 360; }
  setCoarseTune(oct: number) { this.coarseTune = oct; }
  setFineTune(cents: number) { this.fineCents = cents; }
  setFrequencyAtTime(_freq: number, _time: number) { /* no-op — see RetriggerOscillator note */ }

  triggerAt(freq: number, time: number, releaseTime: number) {
    const bank = WavetableOscillator.ensureBank(this.ctx);
    const buf = bank[this.waveform] ?? bank.sine;

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.loopStart = 0;
    src.loopEnd = buf.duration;

    // playbackRate so that one buffer cycle = one cycle of `freq`.
    // buffer is one cycle long at ctx.sampleRate / BUFFER_LENGTH "natural Hz".
    const naturalHz = this.ctx.sampleRate / BUFFER_LENGTH;
    const rate = (freq * Math.pow(2, this.coarseTune)) / naturalHz;
    src.playbackRate.setValueAtTime(rate, time);
    src.detune.setValueAtTime(this.fineCents, time);

    src.connect(this.outGain);

    const offset = (this.phaseDeg / 360) * buf.duration;
    src.start(time, offset);
    src.stop(releaseTime + STOP_TAIL_SECONDS);
  }

  dispose() {
    this.outGain.disconnect();
  }
}
```

- [ ] **Step 3: Create WavetableOscillator test (jsdom-scoped)**

Create `src/engine/modules/oscillator/WavetableOscillator.test.ts`:

```ts
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WavetableOscillator } from './WavetableOscillator';

class MockAudioParam {
  setValueAtTime = vi.fn();
}
class MockAudioBuffer {
  constructor(public numberOfChannels: number, public length: number, public sampleRate: number) {}
  duration = this.length / this.sampleRate;
  private data = new Float32Array(this.length);
  getChannelData(_ch: number) { return this.data; }
}
class MockBufferSourceNode {
  buffer: MockAudioBuffer | null = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  playbackRate = new MockAudioParam();
  detune = new MockAudioParam();
  start = vi.fn();
  stop = vi.fn();
  connect = vi.fn();
  disconnect = vi.fn();
}
class MockGainNode {
  gain = new MockAudioParam();
  connect = vi.fn();
  disconnect = vi.fn();
}
class MockAudioContext {
  currentTime = 0;
  sampleRate = 48000;
  createBuffer(numChan: number, len: number, sr: number) { return new MockAudioBuffer(numChan, len, sr); }
  createBufferSource = vi.fn().mockImplementation(() => new MockBufferSourceNode());
  createGain() { return new MockGainNode(); }
}
vi.stubGlobal('AudioContext', MockAudioContext);

beforeEach(() => {
  // Bank is class-level; reset between tests so ensureBank logic is testable.
  (WavetableOscillator as any).bank = null;
  (WavetableOscillator as any).bankSampleRate = 0;
});

describe('WavetableOscillator', () => {
  it('ensureBank builds four buffers on first call and is a no-op on the second', () => {
    const ctx = new (AudioContext as any)();
    const spy = vi.spyOn(ctx, 'createBuffer');
    WavetableOscillator.ensureBank(ctx);
    const callsAfterFirst = spy.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThanOrEqual(4); // 4 base waveforms + maybe 'custom' alias
    WavetableOscillator.ensureBank(ctx);
    expect(spy.mock.calls.length).toBe(callsAfterFirst); // singleton: no further calls
  });

  it('sine buffer sample 0 is approximately 0 and quarter-buffer is approximately 1', () => {
    const ctx = new (AudioContext as any)();
    const bank = WavetableOscillator.ensureBank(ctx);
    const sineData = bank.sine.getChannelData(0);
    expect(Math.abs(sineData[0] - 0)).toBeLessThan(1e-3);
    expect(Math.abs(sineData[Math.floor(sineData.length / 4)] - 1)).toBeLessThan(1e-3);
  });

  it('triggerAt creates a BufferSource with the right buffer, playbackRate, start offset, and stop time', () => {
    const ctx = new (AudioContext as any)();
    const osc = new WavetableOscillator(ctx);
    osc.setWaveform('sine');
    osc.setPhase(90);
    osc.triggerAt(440, 0, 1.0);

    expect(ctx.createBufferSource).toHaveBeenCalledTimes(1);
    const src = ctx.createBufferSource.mock.results[0].value as any;

    // playbackRate = 440 / (sampleRate / BUFFER_LENGTH) = 440 / (48000 / 2048)
    const expectedRate = 440 / (48000 / 2048);
    expect(src.playbackRate.setValueAtTime).toHaveBeenCalledWith(expectedRate, 0);

    // start(time, offset) with offset = (90/360) * bufferDuration
    const bufferDuration = 2048 / 48000;
    const expectedOffset = (90 / 360) * bufferDuration;
    const startCall = src.start.mock.calls[0];
    expect(startCall[0]).toBe(0);
    expect(Math.abs((startCall[1] as number) - expectedOffset)).toBeLessThan(1e-9);

    expect(src.stop).toHaveBeenCalledWith(1.05);
  });

  it('coarseTune is folded into playbackRate', () => {
    const ctx = new (AudioContext as any)();
    const osc = new WavetableOscillator(ctx);
    osc.setCoarseTune(1); // +1 octave
    osc.triggerAt(440, 0, 1.0);
    const src = ctx.createBufferSource.mock.results[0].value as any;
    const expectedRate = 880 / (48000 / 2048);
    expect(src.playbackRate.setValueAtTime).toHaveBeenCalledWith(expectedRate, 0);
  });
});
```

- [ ] **Step 4: Wire `'retrigger-wavetable'` in the factory**

In `src/engine/modules/oscillator/index.ts`:

```ts
import { WavetableOscillator } from './WavetableOscillator';
// ... existing imports ...

export function makeOscillator(mode: OscMode, ctx: AudioContext): IOscillatorModule {
  switch (mode) {
    case 'phase-offset':
      return new PhaseOffsetOscillator(ctx);
    case 'retrigger-recreate':
      return new RetriggerOscillator(ctx);
    case 'retrigger-wavetable':
      return new WavetableOscillator(ctx);
    case 'free-run':
    default:
      return new FreeRunOscillator(ctx);
  }
}
```

- [ ] **Step 5: Run gates**

Run: `npx vue-tsc --noEmit`
Expected: clean.

Run: `npm test`
Expected: previous baseline + 4 new tests pass.

Run: `npm run build`
Expected: clean.

- [ ] **Step 6: Browser smoke**

Run `npm run dev`. Pick `retrigger-wavetable` from the mode dropdown. Repeat the T3 smoke (phase=0 both, phase=0/180 cancellation). Compare A/B against `retrigger-recreate` qualitatively — both should reset phase identically; wavetable's harmonic content is slightly different because it's a time-domain sum of 32 harmonics in a 2048-sample buffer (audibly very close to PeriodicWave for these waveforms).

- [ ] **Step 7: Commit + merge back**

```bash
git add src/engine/modules/oscillator/WavetableOscillator.ts \
        src/engine/modules/oscillator/WavetableOscillator.test.ts \
        src/engine/modules/oscillator/index.ts
git commit -m "$(cat <<'EOF'
feat(synth): retrigger-wavetable oscillator mode

T4 of feature/osc-phase-experiment.

- New WavetableOscillator: AudioBufferSourceNode playing a one-cycle 2048-
  sample wavetable, started at start(time, offset) where offset =
  (phase/360) * bufferDuration. playbackRate = freq / (sampleRate /
  BUFFER_LENGTH) so one loop = one cycle of `freq`.
- Class-level singleton bank: one AudioBuffer per waveform, rendered
  lazily on first ensureBank(ctx). Sample-rate-keyed (our app doesn't
  change it). Shared across all voices.
- jsdom-scoped test file (// @vitest-environment jsdom) because the test
  needs AudioBuffer / BufferSource shapes; the rest of the engine tests
  remain in node env.
- Factory wires 'retrigger-wavetable' to the new class. All four
  OscMode values now reach their intended implementation.
EOF
)"

git checkout feature/osc-phase-experiment
git merge --no-ff task/osc-wavetable -m "Merge T4: retrigger-wavetable oscillator mode"
```

---

## After all four tasks

End state:
- `feature/osc-phase-experiment` has 5 commits on top of `main`: the spec (`b971dce`) and four `--no-ff` merge commits (T1, T2, T3, T4).
- 172 baseline + ~24 new tests = ~196 tests passing.
- `vue-tsc --noEmit` + `vite build` clean.
- All four `OscMode` values are reachable and audibly distinct.

**Do not** merge to `main` or push to remote. Hand the branch back to the user to A/B the modes and pick a winner. The follow-up cleanup (delete the losing modes' files, simplify the mode select / param shape) is its own future task once the user decides.

---

## Self-review notes

- Every step ships actual code, not pseudocode.
- File paths are absolute within the repo and consistent across tasks (same `src/engine/modules/oscillator/` directory throughout).
- Type names (`IOscillatorModule`, `OscMode`, `makeOscillator`) are introduced in T1 and referenced verbatim in T2/T3/T4.
- The `replaceOscillators` signature defined in T2 matches its call site in `SynthEngine.setOscMode`.
- Tests in T1 cover FreeRun behavior; T2 covers WaveformTables + PhaseOffset + SynthVoice swap + SynthEngine new branches; T3 covers RetriggerOscillator; T4 covers WavetableOscillator with the jsdom scope only on the one file that needs it.
- The factory's `default` case keeps the app shippable mid-experiment if a stale mode string reaches it; T1 wires every case to FreeRun, T2 peels off 'phase-offset', T3 peels off 'retrigger-recreate', T4 peels off 'retrigger-wavetable'.
- No schema bump; reconciler tests already pass without changes thanks to `deepMerge`-against-`DEFAULT_PARAMS`. The new test in T2 (`legacy preset round-trips with default oscMode`) is the only explicit assertion of this behavior.
