# clap2 Worklet Hand-Clap Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `clap2`, a fourth AudioWorklet drum engine, mirroring the kick2/snare2/hat2 host/kernel/worklet pattern, voiced as a TR-909-style hand-clap (burst of noise transients + reverberant room tail).

**Architecture:** Per-sample pure DSP kernel (no AudioContext) + a `worklet-entry.ts` registering `'clap2'` + a `Clap2Engine` host (`AudioWorkletNode → GainNode → destination`) + a shared `clap2.ts` descriptor table as the single source of truth. Additive: the legacy main-thread `clap` engine is untouched; users opt in by selecting `clap2` on a track. The descriptor flows to the Zod schema, factory, normalize deep-heal, accept-list, kernel block layout, and the descriptor-driven panel.

**Tech Stack:** TypeScript, Vue 3, Web Audio AudioWorklet, esbuild (worklet bundling), Zod (wire schema), Vitest (unit tests), npm workspaces (`@fiddle/shared`, `@fiddle/client`, `@fiddle/server`).

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-23-clap2-design.md`. **Reference:** `docs/DRUM_WORKLETS.md` ("append an engine" checklist).
- **Additive only.** Do not modify the legacy `clap` engine, its descriptor (`clap.ts`), panel (`ClapPanel.vue`), engine (`ClapEngine.ts`), or its schema/accept-list rows. No existing session may change behaviour.
- **No factory presets.** Matches the shipped siblings; the preset picker is a separate deferred feature. Ship clap2 with only its descriptor defaults.
- **Descriptor is APPEND-ONLY** once a row exists: kernel block index = array position. Never insert/reorder rows.
- **Curve math is presentational and lives only in `packages/client/src/ui/knobTaper.ts`.** This plan does not touch it; the panel binds `:curve="d.curve"`.
- **Gate (must be green at the end of every task):** `npm run typecheck && npm test && npm run build` from the repo root.
- **Never `git add -A` / `git add .`.** Stage only the named files. Two untracked PNGs (`studio-initial.png`, `synth2-wave-previews.png`) must never be staged.
- **Branch:** `feat/clap2-worklet-engine` (already created from `main` 6e631ce). Never commit to `main`.
- **Commit trailer on every commit:** `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Exact descriptor values (copy verbatim):** `tone` 500–3000 default 1000 `format:'hz'` `curve:'exp'`; `spread` 0.005–0.040 default 0.012 `format:'ms'` `curve:'exp'`; `bursts` 2–5 default 3 `step:1` `curve:'linear'` (NO `format`); `body` 0.002–0.030 default 0.008 `format:'ms'` `curve:'exp'`; `room` 0.050–0.800 default 0.250 `format:'ms'` `curve:'exp'`; `mix` 0–1 default 0.5 `format:'percent'`; `level` 0–1 default 0.8 `format:'percent'`.

---

## File Structure

**New files:**
- `packages/shared/src/engines/clap2.ts` — descriptor table, `Clap2EngineParams`, `DEFAULT_CLAP2_PARAMS` (Task 1).
- `packages/shared/src/engines/clap2.test.ts` — descriptor ↔ params contract test (Task 1).
- `packages/client/src/engine/clap2/kernel/params.ts` — Float32Array block layout from the descriptor (Task 2).
- `packages/client/src/engine/clap2/kernel/Clap2Kernel.ts` — pure DSP (Task 2).
- `packages/client/src/engine/clap2/kernel/Clap2Kernel.test.ts` — kernel unit tests (Task 2).
- `packages/client/src/engine/clap2/worklet-entry.ts` — `registerProcessor('clap2', …)` (Task 3).
- `packages/client/src/engine/Clap2Engine.ts` — `SoundEngine` host (Task 3).
- `packages/client/src/components/Clap2Panel.vue` — descriptor-driven panel (Task 4).

**Modified files:**
- `packages/shared/src/engines/drum-descriptors.ts` — add optional `step?`, relax `format?` (Task 1).
- `packages/shared/src/engines/index.ts` — export `clap2.js` (Task 1).
- `packages/shared/src/engines/knob-curve.test.ts` — add clap2 to the matrix + exp assertions (Task 1).
- `packages/client/package.json` — append clap2 esbuild bundle to `build:worklet` (Task 3).
- `packages/shared/src/index.ts` — `EngineType` union (Task 4).
- `packages/shared/src/project/types.ts` — `EngineParamsMap` (Task 4).
- `packages/shared/src/project/schema.ts` — `Clap2ParamsSchema`, `EngineTypeSchema`, `EnginesMapSchema`, `Schemas` (Task 4).
- `packages/shared/src/project/factory.ts` — `freshTrack` engines + import (Task 4).
- `packages/shared/src/project/normalize.ts` — `ENGINE_KEYS` (Task 4).
- `packages/shared/src/project/accept-list.ts` — clap2 descriptor paths + import (Task 4).
- `packages/client/src/composables/useSynth.ts` — import, worklet URL, `ENGINE_SLICES`, `engineFactories`, `addModule` (Task 4).
- `packages/client/src/project/preset.ts` — import, `DEFAULTS`, `ALL_ENGINE_TYPES` (Task 4).
- `packages/client/src/project/storage.ts` — import, `reconcileTrack` engines, `ENGINE_KEYS` (Task 4).
- `packages/client/src/views/StudioView.vue` — import `Clap2Panel`, selector button, panel slot (Task 4).

**Not touched (verify, don't edit):** `engineLabel.ts` — it uppercases `engineType` (`'clap2' → 'CLAP2'`) automatically; no change needed. `migrations.ts` — schemaVersion stays 2; the normalize deep-heal (`healSlice`) covers the new slice additively, so no migration is required.

---

## Task 1: Shared clap2 descriptor + contract tests (additive, no `EngineType` change)

This task adds the descriptor and its tests as **purely additive new exports**. It does NOT touch the `EngineType` union or any exhaustive map, so the whole monorepo stays green. It also makes two additive, backward-compatible changes to the shared descriptor shape for the integer `bursts` knob.

**Files:**
- Modify: `packages/shared/src/engines/drum-descriptors.ts`
- Create: `packages/shared/src/engines/clap2.ts`
- Create: `packages/shared/src/engines/clap2.test.ts`
- Modify: `packages/shared/src/engines/index.ts`
- Modify: `packages/shared/src/engines/knob-curve.test.ts`

**Interfaces:**
- Consumes: `buildDrumDefaults`, `DrumParamDescriptor`, `DrumKnobFormat`, `KnobCurve` from `drum-descriptors.ts` / `knob-curve.ts`.
- Produces: `CLAP2_DESCRIPTORS: readonly DrumParamDescriptor[]`, `interface Clap2EngineParams`, `DEFAULT_CLAP2_PARAMS: Clap2EngineParams` (all consumed by Tasks 2 & 4); the relaxed `DrumParamDescriptor` (optional `format?`, new `step?`).

- [ ] **Step 1: Relax `DrumParamDescriptor` — optional `format?`, add `step?`**

In `packages/shared/src/engines/drum-descriptors.ts`, replace the `format` field and add `step`. Change:

```ts
  /** Panel knob label. */
  label: string;
  /** Panel knob display format. */
  format: DrumKnobFormat;
  /** Optional UI knob response curve (presentational only). Omitted ⇒ 'linear'. */
  curve?: KnobCurve;
```

to:

```ts
  /** Panel knob label. */
  label: string;
  /** Panel knob display format. Omitted ⇒ raw-number readout (Knob.vue renders
   *  val.toString()), used by integer count knobs like clap2's `bursts`. */
  format?: DrumKnobFormat;
  /** Optional linear drag-snap step. Omitted ⇒ the panel's default (max−min)/100.
   *  Only meaningful for LINEAR knobs — the exp/s drag path snaps in position
   *  space (roundSig) and ignores `step`. */
  step?: number;
  /** Optional UI knob response curve (presentational only). Omitted ⇒ 'linear'. */
  curve?: KnobCurve;
```

(Every existing descriptor row sets `format`, so relaxing it to optional changes nothing for kick2/snare2/hat2.)

- [ ] **Step 2: Run the existing shared tests to confirm the relaxation is safe**

Run: `npm run test -w @fiddle/shared`
Expected: PASS (the `format?`/`step?` change is backward-compatible; existing descriptors unaffected).

- [ ] **Step 3: Write the clap2 descriptor contract test (it should fail — module doesn't exist yet)**

Create `packages/shared/src/engines/clap2.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_CLAP2_PARAMS, CLAP2_DESCRIPTORS, type Clap2EngineParams } from './clap2.js';

describe('clap2 descriptor ↔ params derivation contract', () => {
  it('DEFAULT_CLAP2_PARAMS mirrors the descriptor table exactly', () => {
    for (const d of CLAP2_DESCRIPTORS) {
      expect((DEFAULT_CLAP2_PARAMS as unknown as Record<string, number>)[d.key], d.key).toBe(d.default);
    }
    expect(Object.keys(DEFAULT_CLAP2_PARAMS).sort()).toEqual(
      CLAP2_DESCRIPTORS.map((d) => d.key).sort(),
    );
  });

  it('every descriptor default sits within its own [min, max]', () => {
    for (const d of CLAP2_DESCRIPTORS) {
      expect(d.min, d.key).toBeLessThanOrEqual(d.default);
      expect(d.default, d.key).toBeLessThanOrEqual(d.max);
      expect(d.min, d.key).toBeLessThan(d.max);
    }
  });

  it('the params interface and the table agree on field names', () => {
    const sample: Clap2EngineParams = DEFAULT_CLAP2_PARAMS;
    const keys = Object.keys(sample);
    expect(new Set(keys)).toEqual(new Set(CLAP2_DESCRIPTORS.map((d) => d.key)));
  });

  it('bursts is an integer count knob: linear, step 1, no display format', () => {
    const bursts = CLAP2_DESCRIPTORS.find((d) => d.key === 'bursts')!;
    expect(bursts.step).toBe(1);
    expect(bursts.curve ?? 'linear').toBe('linear');
    expect(bursts.format).toBeUndefined();
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npm run test -w @fiddle/shared -- clap2`
Expected: FAIL — cannot resolve `./clap2.js`.

- [ ] **Step 5: Create the clap2 descriptor module**

Create `packages/shared/src/engines/clap2.ts`:

```ts
//
// clap2 — worklet hand-clap engine param table + defaults. Lives in @fiddle/shared
// so server-side validation and the project factory can construct/validate a default
// Project without touching DOM-only engine code.
//
// Synthesis model (Gordon Reid, SOS "Synth Secrets" + the classic TR-909 clap): a
// burst of `bursts` short noise transients spaced by `spread`, each decaying with
// `body`, summed with a longer reverberant `room` tail, balanced by `mix`, the whole
// source bandpass-shaped at `tone` (fixed Q). The kernel reads these from the
// Float32Array param block in descriptor order (see client engine/clap2/kernel/params.ts).

import { buildDrumDefaults, type DrumParamDescriptor } from './drum-descriptors.js';

// APPEND-ONLY (block index = array position; see drum-descriptors.ts).
export const CLAP2_DESCRIPTORS: readonly DrumParamDescriptor[] = [
  { key: 'tone',   min: 500,   max: 3000,  default: 1000,  label: 'Tone',   format: 'hz', curve: 'exp' },
  { key: 'spread', min: 0.005, max: 0.040, default: 0.012, label: 'Spread', format: 'ms', curve: 'exp' },
  { key: 'bursts', min: 2,     max: 5,     default: 3,     label: 'Bursts', step: 1,      curve: 'linear' },
  { key: 'body',   min: 0.002, max: 0.030, default: 0.008, label: 'Body',   format: 'ms', curve: 'exp' },
  { key: 'room',   min: 0.050, max: 0.800, default: 0.250, label: 'Room',   format: 'ms', curve: 'exp' },
  { key: 'mix',    min: 0,     max: 1,     default: 0.5,   label: 'Mix',    format: 'percent' },
  { key: 'level',  min: 0,     max: 1,     default: 0.8,   label: 'Level',  format: 'percent' },
] as const satisfies readonly DrumParamDescriptor[];

export interface Clap2EngineParams {
  /** Bandpass centre frequency, Hz (Q fixed). */
  tone: number;
  /** Spacing between the burst transients, seconds (tight ↔ loose). */
  spread: number;
  /** Number of transients in the burst (2..5, integer). */
  bursts: number;
  /** Per-transient decay time-constant, seconds. */
  body: number;
  /** Reverberant tail decay time-constant, seconds. */
  room: number;
  /** Burst-body ↔ room-tail balance (0..1). */
  mix: number;
  /** Output level (0..1). */
  level: number;
}

export const DEFAULT_CLAP2_PARAMS: Clap2EngineParams =
  buildDrumDefaults<Clap2EngineParams>(CLAP2_DESCRIPTORS);
```

- [ ] **Step 6: Export clap2 from the engines barrel**

In `packages/shared/src/engines/index.ts`, add after the `export * from './hat2.js';` line:

```ts
export * from './clap2.js';
```

- [ ] **Step 7: Add clap2 to the knob-curve assignment test**

In `packages/shared/src/engines/knob-curve.test.ts`:

(a) extend the import on line 2–4 to include `CLAP2_DESCRIPTORS`:

```ts
import {
  SYNTH2_DESCRIPTORS, KICK2_DESCRIPTORS, SNARE2_DESCRIPTORS, HAT2_DESCRIPTORS, CLAP2_DESCRIPTORS,
} from './index.js';
```

(b) add clap2 to the `ALL` matrix:

```ts
const ALL = [
  ['synth2', SYNTH2_DESCRIPTORS],
  ['kick2', KICK2_DESCRIPTORS],
  ['snare2', SNARE2_DESCRIPTORS],
  ['hat2', HAT2_DESCRIPTORS],
  ['clap2', CLAP2_DESCRIPTORS],
] as const;
```

(c) inside the `'the expected drum freq/time params carry exp'` test, append after the hat2 assertions:

```ts
    expect(has(CLAP2_DESCRIPTORS, 'tone')).toBe('exp');
    expect(has(CLAP2_DESCRIPTORS, 'spread')).toBe('exp');
    expect(has(CLAP2_DESCRIPTORS, 'body')).toBe('exp');
    expect(has(CLAP2_DESCRIPTORS, 'room')).toBe('exp');
```

- [ ] **Step 8: Run the full shared gate**

Run: `npm run typecheck -w @fiddle/shared && npm run test -w @fiddle/shared`
Expected: PASS — clap2 contract test green; knob-curve test green (exp rows all have min > 0); existing tests unaffected.

- [ ] **Step 9: Run the whole-repo gate**

Run: `npm run typecheck && npm test && npm run build`
Expected: PASS. (clap2 is not yet referenced by any exhaustive map, so the client/server are unaffected.)

- [ ] **Step 10: Commit**

```bash
git add packages/shared/src/engines/drum-descriptors.ts packages/shared/src/engines/clap2.ts packages/shared/src/engines/clap2.test.ts packages/shared/src/engines/index.ts packages/shared/src/engines/knob-curve.test.ts
git commit -m "feat(clap2): shared descriptor table + contract tests

Additive: CLAP2_DESCRIPTORS (7 params, 909 burst+room), Clap2EngineParams,
DEFAULT_CLAP2_PARAMS. Relaxes DrumParamDescriptor.format to optional and adds
optional step? for the integer Bursts knob (backward-compatible; existing
engines unaffected). No EngineType change yet.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: clap2 DSP kernel (pure, unit-tested, no AudioContext)

Implements the 909 burst+room synthesis as a pure per-sample kernel mirroring `Hat2Kernel` (event ring-buffer, frame-scheduled `noteOn`, mono retrigger, deterministic xorshift32 noise). No `EngineType` dependency — new client files only.

**Files:**
- Create: `packages/client/src/engine/clap2/kernel/params.ts`
- Create: `packages/client/src/engine/clap2/kernel/Clap2Kernel.ts`
- Create: `packages/client/src/engine/clap2/kernel/Clap2Kernel.test.ts`

**Interfaces:**
- Consumes: `CLAP2_DESCRIPTORS` from `@fiddle/shared` (Task 1).
- Produces: `class Clap2Kernel { constructor(sampleRate: number); applyParams(block: Float32Array): void; noteOn(time: number, freq: number, duration: number, velocity: number): void; process(out: Float32Array, frames: number, blockStartFrame: number): void; }`; `PARAM_COUNT`, `PARAM_INDEX`, `BLOCK_LENGTH`, `defaultParamBlock()` from `params.ts` (consumed by Task 3's worklet entry & host engine).

- [ ] **Step 1: Create the param block layout**

Create `packages/client/src/engine/clap2/kernel/params.ts`:

```ts
//
// Float32Array param-block layout for clap2 — GENERATED from the shared descriptor
// table: block[i] is the base value of CLAP2_DESCRIPTORS[i]. Always address via
// PARAM_INDEX['tone'], never positional literals (append-only ABI). Mirrors
// hat2/kernel/params.ts.

import { CLAP2_DESCRIPTORS } from '@fiddle/shared';

export const PARAM_COUNT = CLAP2_DESCRIPTORS.length;

export const PARAM_INDEX: Readonly<Record<string, number>> = Object.fromEntries(
  CLAP2_DESCRIPTORS.map((d, i) => [d.key, i]),
);

export const BLOCK_LENGTH = PARAM_COUNT;

export function defaultParamBlock(): Float32Array {
  const block = new Float32Array(BLOCK_LENGTH);
  CLAP2_DESCRIPTORS.forEach((d, i) => { block[i] = d.default; });
  return block;
}
```

- [ ] **Step 2: Write the failing kernel tests**

Create `packages/client/src/engine/clap2/kernel/Clap2Kernel.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Clap2Kernel } from './Clap2Kernel';
import { PARAM_INDEX, PARAM_COUNT, BLOCK_LENGTH, defaultParamBlock } from './params';
import { CLAP2_DESCRIPTORS } from '@fiddle/shared';

const SR = 48000;
const BLOCK = 128;

function renderBlocks(kernel: Clap2Kernel, startFrame: number, blocks: number): Float32Array {
  const out = new Float32Array(blocks * BLOCK);
  const buf = new Float32Array(BLOCK);
  for (let b = 0; b < blocks; b++) {
    kernel.process(buf, BLOCK, startFrame + b * BLOCK);
    out.set(buf, b * BLOCK);
  }
  return out;
}

function rms(buf: Float32Array, from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / Math.max(1, to - from));
}

function rmsDiff(a: Float32Array, b: Float32Array, from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < to; i++) { const d = a[i] - b[i]; sum += d * d; }
  return Math.sqrt(sum / Math.max(1, to - from));
}

function withParam(overrides: Record<string, number>): Float32Array {
  const block = defaultParamBlock();
  for (const [k, v] of Object.entries(overrides)) block[PARAM_INDEX[k]] = v;
  return block;
}

function renderHit(overrides: Record<string, number>, seconds: number): Float32Array {
  const kernel = new Clap2Kernel(SR);
  kernel.applyParams(withParam(overrides));
  kernel.noteOn(0, 0, 0, 1);
  return renderBlocks(kernel, 0, Math.ceil((SR * seconds) / BLOCK));
}

describe('clap2 param block layout', () => {
  it('one index per descriptor, in table order', () => {
    expect(PARAM_COUNT).toBe(CLAP2_DESCRIPTORS.length);
    expect(BLOCK_LENGTH).toBe(CLAP2_DESCRIPTORS.length);
    CLAP2_DESCRIPTORS.forEach((d, i) => expect(PARAM_INDEX[d.key]).toBe(i));
    const block = defaultParamBlock();
    CLAP2_DESCRIPTORS.forEach((d, i) => expect(block[i]).toBeCloseTo(d.default, 6));
  });
});

describe('Clap2Kernel', () => {
  it('renders exact silence with no trigger', () => {
    const out = renderBlocks(new Clap2Kernel(SR), 0, 8);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBe(0);
  });

  it('triggers at the exact frame offset inside a block', () => {
    const kernel = new Clap2Kernel(SR);
    kernel.noteOn(64 / SR, 0, 0, 1); // due at absolute frame 64
    const buf = new Float32Array(BLOCK);
    kernel.process(buf, BLOCK, 0);
    for (let i = 0; i < 64; i++) expect(buf[i]).toBe(0); // silent before the hit
    let energyAfter = 0;
    for (let i = 64; i < BLOCK; i++) energyAfter += Math.abs(buf[i]);
    expect(energyAfter).toBeGreaterThan(0); // audible after
  });

  it('produces a decaying envelope (loud at onset, silent a beat later)', () => {
    const out = renderHit({}, 1.0);
    const early = rms(out, 0, Math.floor(SR * 0.02)); // first 20ms
    const late = rms(out, Math.floor(SR * 0.6), Math.floor(SR * 0.62)); // past the 250ms room tail
    expect(early).toBeGreaterThan(0.01);
    expect(late).toBeLessThan(early * 0.1);
  });

  it('stays finite and within range for a full hit', () => {
    const out = renderHit({}, 1.0);
    for (let i = 0; i < out.length; i++) {
      expect(Number.isFinite(out[i])).toBe(true);
      expect(Math.abs(out[i])).toBeLessThan(4);
    }
  });

  it('velocity scales output level', () => {
    function peak(vel: number): number {
      const kernel = new Clap2Kernel(SR);
      kernel.noteOn(0, 0, 0, vel);
      const out = renderBlocks(kernel, 0, Math.ceil((SR * 0.2) / BLOCK));
      let p = 0;
      for (let i = 0; i < out.length; i++) p = Math.max(p, Math.abs(out[i]));
      return p;
    }
    expect(peak(1)).toBeGreaterThan(peak(0.25));
  });

  it('applyParams ignores non-finite entries (keeps the prior value)', () => {
    const kernel = new Clap2Kernel(SR);
    const block = defaultParamBlock();
    block[PARAM_INDEX['level']] = NaN;
    kernel.applyParams(block); // must not poison the level → output stays finite
    kernel.noteOn(0, 0, 0, 1);
    const out = renderBlocks(kernel, 0, Math.ceil((SR * 0.1) / BLOCK));
    let energy = 0;
    for (let i = 0; i < out.length; i++) {
      expect(Number.isFinite(out[i])).toBe(true);
      energy += Math.abs(out[i]);
    }
    expect(energy).toBeGreaterThan(0);
  });

  it('renders a train of transients spaced by `spread` (the claps)', () => {
    const spread = 0.04, body = 0.004;
    const out = renderHit({ bursts: 4, spread, body, room: 0.05, mix: 0, tone: 1000 }, 0.25);
    const win = Math.floor(SR * 0.004); // 4ms window
    const at = (sec: number) => rms(out, Math.floor(sec * SR), Math.floor(sec * SR) + win);
    // Energy peaks AT each clap onset and dips BETWEEN consecutive claps.
    for (let j = 0; j < 3; j++) {
      const onset = at(j * spread);
      const between = at((j + 0.5) * spread);
      expect(onset, `clap ${j} onset vs gap`).toBeGreaterThan(between);
    }
  });

  it('more bursts ⇒ more energy in the burst window', () => {
    const base = { spread: 0.03, body: 0.004, room: 0.05, mix: 0 };
    const burstEnergy = (bursts: number) => {
      const out = renderHit({ ...base, bursts }, 0.25);
      let s = 0;
      const end = Math.floor(0.2 * SR);
      for (let i = 0; i < end; i++) s += out[i] * out[i];
      return s;
    };
    expect(burstEnergy(5)).toBeGreaterThan(burstEnergy(2));
  });

  it('longer room ⇒ more total tail energy', () => {
    const tailEnergy = (room: number) => {
      const out = renderHit({ room, mix: 1, bursts: 2 }, 1.2);
      let s = 0;
      for (let i = 0; i < out.length; i++) s += out[i] * out[i];
      return s;
    };
    expect(tailEnergy(0.8)).toBeGreaterThan(tailEnergy(0.05) * 2);
  });

  it('mix changes the balance (the knob is wired)', () => {
    const m0 = renderHit({ mix: 0 }, 0.2);
    const m1 = renderHit({ mix: 1 }, 0.2);
    expect(rmsDiff(m1, m0, 0, Math.floor(SR * 0.2))).toBeGreaterThan(1e-3);
  });

  it('tone shifts the band (the knob is wired)', () => {
    const lo = renderHit({ tone: 600 }, 0.1);
    const hi = renderHit({ tone: 2800 }, 0.1);
    expect(rmsDiff(hi, lo, 0, Math.floor(SR * 0.05))).toBeGreaterThan(1e-3);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm run test -w @fiddle/client -- Clap2Kernel`
Expected: FAIL — cannot resolve `./Clap2Kernel`.

- [ ] **Step 4: Implement the kernel**

Create `packages/client/src/engine/clap2/kernel/Clap2Kernel.ts`:

```ts
//
// clap2 DSP kernel — pure TS, no AudioContext (unit-testable like Hat2Kernel).
// process(out, frames, blockStartFrame) renders the hand-clap into `out`.
//
// Synthesis (SOS "Synth Secrets" + the classic TR-909 clap): white noise gated by a
// short pulse train — `bursts` (2..5) transients spaced by `spread`, each a fast
// attack + exp(`body`) decay — summed with one longer exp(`room`) reverberant tail,
// the two balanced by `mix`, the whole source bandpass-filtered at `tone` (fixed Q,
// Chamberlin SVF). Monophonic: a retrigger restarts the voice (note pitch/duration
// ignored — a drum voices itself from params). Deterministic xorshift32 noise so
// tests are reproducible.

import { PARAM_COUNT, PARAM_INDEX, defaultParamBlock } from './params';

const MAX_EVENTS = 16;
const BANDPASS_Q = 1.2;   // analog ClapEngine value; fixed (not a knob)
const OUT_TRIM = 0.5;     // headroom: keeps overlapping transients + tail bounded

const I_TONE = PARAM_INDEX['tone'];
const I_SPREAD = PARAM_INDEX['spread'];
const I_BURSTS = PARAM_INDEX['bursts'];
const I_BODY = PARAM_INDEX['body'];
const I_ROOM = PARAM_INDEX['room'];
const I_MIX = PARAM_INDEX['mix'];
const I_LEVEL = PARAM_INDEX['level'];

interface HitEvent {
  frame: number;
  velocity: number;
}

export class Clap2Kernel {
  private readonly block = defaultParamBlock();
  private readonly events: HitEvent[];
  private head = 0;
  private count = 0;

  // Mono voice state (a retrigger restarts it).
  private active = false;
  private t = 0; // seconds since the current hit
  private velocity = 1;

  // Chamberlin state-variable filter state (bandpass of the noise source).
  private svfLow = 0;
  private svfBand = 0;

  // Deterministic xorshift32 noise (seeded so tests are reproducible). Never 0.
  private rng = 0x6d2b79f5;

  constructor(private readonly sampleRate: number) {
    this.events = Array.from({ length: MAX_EVENTS }, () => ({ frame: 0, velocity: 1 }));
  }

  /** Full param block (base values, descriptor order). Non-finite entries ignored. */
  applyParams(block: Float32Array): void {
    const n = Math.min(block.length, PARAM_COUNT);
    for (let i = 0; i < n; i++) {
      const v = block[i];
      if (Number.isFinite(v)) this.block[i] = v;
    }
  }

  /** time in seconds on the AudioContext clock. freq/duration ignored — a drum
   *  voices its own length from params. */
  noteOn(time: number, _freq: number, _duration: number, velocity: number): void {
    const vel = Number.isFinite(velocity) ? (velocity < 0 ? 0 : velocity > 1 ? 1 : velocity) : 1;
    const t = Number.isFinite(time) ? time : 0;
    if (this.count === MAX_EVENTS) {
      this.head = (this.head + 1) % MAX_EVENTS;
      this.count--;
    }
    const ev = this.events[(this.head + this.count) % MAX_EVENTS];
    ev.frame = Math.round(t * this.sampleRate);
    ev.velocity = vel;
    this.count++;
  }

  process(out: Float32Array, frames: number, blockStartFrame: number): void {
    out.fill(0);
    let cursor = 0;
    while (this.count > 0) {
      const ev = this.events[this.head];
      if (ev.frame >= blockStartFrame + frames) break; // due in a future block
      const offset = Math.max(0, ev.frame - blockStartFrame); // past-due → now
      this.render(out, cursor, offset);
      cursor = offset;
      this.trigger(ev.velocity);
      this.head = (this.head + 1) % MAX_EVENTS;
      this.count--;
    }
    this.render(out, cursor, frames);
  }

  private trigger(velocity: number): void {
    this.active = true;
    this.t = 0;
    this.velocity = velocity;
    this.svfLow = 0;
    this.svfBand = 0;
  }

  /** xorshift32 → [-1, 1). */
  private noise(): number {
    let x = this.rng;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rng = x >>> 0;
    return (this.rng / 0xffffffff) * 2 - 1;
  }

  private render(out: Float32Array, from: number, to: number): void {
    if (to <= from || !this.active) return;
    const sr = this.sampleRate;
    const dt = 1 / sr;

    const tone = this.block[I_TONE];
    const spread = Math.max(1e-4, this.block[I_SPREAD]);
    const bursts = Math.max(2, Math.min(5, Math.round(this.block[I_BURSTS])));
    const body = Math.max(1e-3, this.block[I_BODY]);
    const room = Math.max(1e-3, this.block[I_ROOM]);
    const mix = Math.min(1, Math.max(0, this.block[I_MIX]));
    const level = this.block[I_LEVEL];

    // Chamberlin SVF coefficient. Clamp fc below ~sr/6 for stability.
    const fc = Math.min(tone, sr / 6);
    const f = 2 * Math.sin((Math.PI * fc) / sr);
    const q = 1 / BANDPASS_Q;

    // Mix → independent gains so neither the claps nor the room tail ever vanishes
    // at the knob extremes (default 0.5 ≈ a balanced 909 clap).
    const burstGain = 1 - 0.6 * mix; // 1.0 … 0.4
    const roomGain = 0.2 + 0.8 * mix; // 0.2 … 1.0

    const lastOnset = (bursts - 1) * spread;

    for (let i = from; i < to; i++) {
      const t = this.t;

      // Burst train: sum of per-transient AD envelopes; the j-th delayed by j*spread.
      let burst = 0;
      for (let j = 0; j < bursts; j++) {
        const td = t - j * spread;
        if (td >= 0) {
          const atk = td < 0.0005 ? td / 0.0005 : 1; // 0.5ms attack, no onset click
          burst += atk * Math.exp(-td / body);
        }
      }
      const roomEnv = Math.exp(-t / room);
      const env = burst * burstGain + roomEnv * roomGain;

      // Stop once the claps are over and the tail has decayed.
      if (t > lastOnset && env < 1e-4) {
        this.active = false;
        return; // remaining samples stay 0 (out was zero-filled)
      }

      // Bandpass the white noise (Chamberlin SVF; band output).
      const input = this.noise();
      this.svfLow += f * this.svfBand;
      const high = input - this.svfLow - q * this.svfBand;
      this.svfBand += f * high;
      const bp = this.svfBand;

      out[i] += bp * env * this.velocity * level * OUT_TRIM;
      this.t += dt;
    }
  }
}
```

- [ ] **Step 5: Run the kernel tests**

Run: `npm run test -w @fiddle/client -- Clap2Kernel`
Expected: PASS (all layout + kernel tests green). If `stays finite and within range` trips the `< 4` bound, lower `OUT_TRIM` (headroom constant) until it passes — do not change the test bound.

- [ ] **Step 6: Run the whole-repo gate**

Run: `npm run typecheck && npm test && npm run build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/client/src/engine/clap2/kernel/params.ts packages/client/src/engine/clap2/kernel/Clap2Kernel.ts packages/client/src/engine/clap2/kernel/Clap2Kernel.test.ts
git commit -m "feat(clap2): pure DSP kernel (909 burst+room) + unit tests

Mono voice, frame-scheduled event ring-buffer (mirrors Hat2Kernel): a pulse
train of bursts transients spaced by spread (each exp(body) decay) summed with
an exp(room) tail, balanced by mix, bandpass-filtered at tone (fixed-Q
Chamberlin SVF). Deterministic noise. 12 tests: layout, silence, frame offset,
decay, burst-train spacing, burst count, room tail, mix/tone wiring, velocity,
NaN safety, bounded output.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: clap2 host engine + worklet entry + worklet build

Wires the kernel into a worklet processor and a `SoundEngine` host, and adds the esbuild bundle. `SoundEngine.engineType` is typed `string`, so `Clap2Engine` compiles before the `EngineType` union is flipped (Task 4). Nothing references `Clap2Engine` from an exhaustive map yet, so the gate stays green.

**Files:**
- Create: `packages/client/src/engine/clap2/worklet-entry.ts`
- Create: `packages/client/src/engine/Clap2Engine.ts`
- Modify: `packages/client/package.json`

**Interfaces:**
- Consumes: `Clap2Kernel` (Task 2), `PARAM_INDEX`/`defaultParamBlock` from `clap2/kernel/params.ts` (Task 2), `DEFAULT_CLAP2_PARAMS`/`Clap2EngineParams` from `@fiddle/shared` (Task 1), `SoundEngine` from `engine/types`.
- Produces: `class Clap2Engine implements SoundEngine` with `static readonly DEFAULT_PARAMS: Clap2EngineParams`, `constructor(ctx: AudioContext, destination?: AudioNode)`, `applyParams(params: Record<string, any>): void`, `trigger(freq, duration, time?, velocity?): void`, `dispose(): void`, and `readonly engineType = 'clap2'` (consumed by Task 4's `engineFactories`, `DEFAULTS`, `reconcileTrack`). The worklet registers processor name `'clap2'`; bundle output `public/worklets/clap2-processor.js`.

- [ ] **Step 1: Create the worklet entry**

Create `packages/client/src/engine/clap2/worklet-entry.ts`:

```ts
//
// The ONLY clap2 file that touches AudioWorkletGlobalScope. Bundled by esbuild into
// public/worklets/clap2-processor.js (package.json build:worklet) and registered in
// useSynth.buildAudioState via addModule before any Clap2Engine constructs an
// AudioWorkletNode('clap2'). Message protocol mirrors kick2/snare2/hat2:
//   { type: 'params',  block: Float32Array }
//   { type: 'trigger', time, duration, velocity }   seconds on the ctx clock
//   { type: 'dispose' }   → process() returns false, node becomes collectable

import { Clap2Kernel } from './kernel/Clap2Kernel';

type Clap2Message =
  | { type: 'params'; block: Float32Array }
  | { type: 'trigger'; time: number; duration: number; velocity: number }
  | { type: 'dispose' };

// AudioWorkletGlobalScope members — not in the DOM lib TS ships for the page.
declare const sampleRate: number;
declare const currentFrame: number;
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare function registerProcessor(
  name: string,
  ctor: new () => AudioWorkletProcessor & {
    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
  },
): void;

class Clap2Processor extends AudioWorkletProcessor {
  private readonly kernel = new Clap2Kernel(sampleRate);
  private alive = true;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => {
      const msg = e.data as Clap2Message;
      if (msg.type === 'params') {
        this.kernel.applyParams(msg.block);
      } else if (msg.type === 'trigger') {
        this.kernel.noteOn(msg.time, 0, msg.duration, msg.velocity);
      } else if (msg.type === 'dispose') {
        this.alive = false;
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const channels = outputs[0];
    const mono = channels?.[0];
    if (!channels || !mono) return this.alive;
    this.kernel.process(mono, mono.length, currentFrame);
    for (let c = 1; c < channels.length; c++) channels[c].set(mono);
    return this.alive;
  }
}

registerProcessor('clap2', Clap2Processor);
```

- [ ] **Step 2: Create the host engine**

Create `packages/client/src/engine/Clap2Engine.ts`:

```ts
//
// SoundEngine host for the clap2 worklet. One AudioWorkletNode('clap2') per instance;
// all communication is MessagePort messages (no AudioParams). Keeps a Float32Array
// mirror of the param block (descriptor order — clap2/kernel/params) and posts a copy
// whenever applyParams changes anything. External graph shape matches every other
// engine: node → out GainNode → destination, so useSynth's D4 engine-swap fade works
// unchanged.
//
// PREREQUISITE: ctx.audioWorklet.addModule(clap2 worklet URL) must have resolved
// before construction — awaited in useSynth.buildAudioState alongside kick2/snare2/hat2.

import { SoundEngine } from './types';
import { DEFAULT_CLAP2_PARAMS, type Clap2EngineParams } from '@fiddle/shared';
import { PARAM_INDEX, defaultParamBlock } from './clap2/kernel/params';

// Re-export so consumers can `import { Clap2EngineParams } from '../engine/Clap2Engine'`.
export type { Clap2EngineParams } from '@fiddle/shared';

export class Clap2Engine implements SoundEngine {
  readonly engineType = 'clap2';
  readonly ctx: AudioContext;

  static readonly DEFAULT_PARAMS: Clap2EngineParams = DEFAULT_CLAP2_PARAMS;

  private readonly node: AudioWorkletNode;
  private readonly out: GainNode;
  private readonly block = defaultParamBlock();

  constructor(ctx: AudioContext, destination?: AudioNode) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.node = new AudioWorkletNode(ctx, 'clap2', {
      numberOfInputs: 0,
      outputChannelCount: [1],
    });
    this.node.connect(this.out);
    this.out.connect(destination ?? ctx.destination);
  }

  applyParams(params: Record<string, any>): void {
    let changed = false;
    for (const [field, value] of Object.entries(params)) {
      const idx = PARAM_INDEX[field];
      // Math.fround so the no-op check matches the float32 the block stores even
      // when DEFAULT_CLAP2_PARAMS carries a 64-bit fraction.
      if (idx === undefined || typeof value !== 'number') continue;
      const f32 = Math.fround(value);
      if (this.block[idx] === f32) continue;
      this.block[idx] = f32;
      changed = true;
    }
    if (changed) {
      this.node.port.postMessage({ type: 'params', block: this.block.slice() });
    }
  }

  trigger(_freq: number | number[], duration: number, time?: number, velocity: number = 1.0): void {
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const t = time ?? this.ctx.currentTime;
    this.node.port.postMessage({ type: 'trigger', time: t, duration, velocity });
  }

  dispose(): void {
    this.node.port.postMessage({ type: 'dispose' });
    this.node.disconnect();
    this.out.disconnect();
  }
}
```

- [ ] **Step 3: Add the clap2 worklet bundle to `build:worklet`**

In `packages/client/package.json`, the `build:worklet` script currently ends with the hat2 bundle. Append the clap2 bundle so the full value becomes (one line — append ` && esbuild src/engine/clap2/worklet-entry.ts --bundle --format=esm --outfile=public/worklets/clap2-processor.js` to the existing script):

```json
    "build:worklet": "esbuild src/engine/synth2/worklet-entry.ts --bundle --format=esm --outfile=public/worklets/synth2-processor.js && esbuild src/engine/kick2/worklet-entry.ts --bundle --format=esm --outfile=public/worklets/kick2-processor.js && esbuild src/engine/snare2/worklet-entry.ts --bundle --format=esm --outfile=public/worklets/snare2-processor.js && esbuild src/engine/hat2/worklet-entry.ts --bundle --format=esm --outfile=public/worklets/hat2-processor.js && esbuild src/engine/clap2/worklet-entry.ts --bundle --format=esm --outfile=public/worklets/clap2-processor.js",
```

- [ ] **Step 4: Verify the worklet bundles**

Run: `npm run build:worklet -w @fiddle/client`
Expected: PASS — produces `packages/client/public/worklets/clap2-processor.js` (no esbuild errors).

- [ ] **Step 5: Run the whole-repo gate**

Run: `npm run typecheck && npm test && npm run build`
Expected: PASS. `Clap2Engine` typechecks (`engineType: string`); it is not yet referenced by any exhaustive map.

- [ ] **Step 6: Commit**

The generated bundle `public/worklets/clap2-processor.js` is a build artifact — check whether the sibling bundles are tracked (`git status --short packages/client/public/worklets/`). Mirror the siblings: if `hat2-processor.js` is tracked, stage `clap2-processor.js` too; if it's git-ignored, do not stage it.

```bash
git add packages/client/src/engine/clap2/worklet-entry.ts packages/client/src/engine/Clap2Engine.ts packages/client/package.json
# If the sibling *-processor.js bundles are tracked, also:
#   git add packages/client/public/worklets/clap2-processor.js
git commit -m "feat(clap2): worklet entry + host engine + esbuild bundle

registerProcessor('clap2') over the Clap2Kernel; Clap2Engine mirrors Hat2Engine
(AudioWorkletNode → out GainNode → destination, param-block diff/post, trigger
message). Appends the clap2 esbuild bundle to build:worklet. Not yet wired into
the EngineType union (Task 4).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Flip the `EngineType` union + complete every map + panel + StudioView + persistence

This is the atomic integration task. The instant `'clap2'` joins the `EngineType` union, every exhaustive map (`engineFactories`, `DEFAULTS`, `EngineParamsMap`, `EnginesMapSchema`, `freshTrack`, `reconcileTrack`) becomes type-incomplete — so they MUST all be completed in this one task for the gate to pass. All prerequisites exist: descriptor (Task 1), kernel (Task 2), `Clap2Engine` (Task 3). After this task the controller browser-verifies.

**Files:**
- Modify: `packages/shared/src/index.ts`, `packages/shared/src/project/types.ts`, `packages/shared/src/project/schema.ts`, `packages/shared/src/project/factory.ts`, `packages/shared/src/project/normalize.ts`, `packages/shared/src/project/accept-list.ts`
- Modify: `packages/client/src/composables/useSynth.ts`, `packages/client/src/project/preset.ts`, `packages/client/src/project/storage.ts`, `packages/client/src/views/StudioView.vue`
- Create: `packages/client/src/components/Clap2Panel.vue`

**Interfaces:**
- Consumes: everything produced by Tasks 1–3 (`CLAP2_DESCRIPTORS`, `DEFAULT_CLAP2_PARAMS`, `Clap2EngineParams`, `Clap2Engine`).
- Produces: a fully selectable, playable, persistable `clap2` engine. No new exported interface.

- [ ] **Step 1: Add `'clap2'` to the `EngineType` union (shared)**

In `packages/shared/src/index.ts`, change line 6:

```ts
export type EngineType = 'synth' | 'kick' | 'hat' | 'snare' | 'clap' | 'synth2' | 'kick2' | 'snare2' | 'hat2' | 'clap2';
```

- [ ] **Step 2: Add `clap2` to `EngineParamsMap` (shared types)**

In `packages/shared/src/project/types.ts`: add `Clap2EngineParams` to the type import block (after `Hat2EngineParams,`):

```ts
  Hat2EngineParams,
  Clap2EngineParams,
} from '../engines/index.js';
```

and add the map entry (after `hat2: Hat2EngineParams;`):

```ts
  hat2: Hat2EngineParams;
  clap2: Clap2EngineParams;
}
```

- [ ] **Step 3: Add the clap2 Zod schema + union + map + Schemas (shared schema)**

In `packages/shared/src/project/schema.ts`:

(a) import `CLAP2_DESCRIPTORS` near the other descriptor imports at the top (with the existing `HAT2_DESCRIPTORS` import — find `import { HAT2_DESCRIPTORS }` and add a sibling line; the exact import style in this file is `import { SYNTH2_DESCRIPTORS, ... } from '../engines/synth2-descriptors.js'` etc. Add):

```ts
import { CLAP2_DESCRIPTORS } from '../engines/clap2.js';
```

(b) after the `Hat2ParamsSchema` definition (around line 113), add:

```ts
// clap2: GENERATED from the descriptor table (single source of truth), same as
// kick2/snare2/hat2 — one z.number().min().max() leaf per row; ranges track clap2.ts.
const Clap2ParamsSchema = z.object(
  Object.fromEntries(
    CLAP2_DESCRIPTORS.map((d) => [d.key, z.number().min(d.min).max(d.max)]),
  ) as Record<string, z.ZodNumber>,
);
```

(c) add `z.literal('clap2'),` to `EngineTypeSchema` (after `z.literal('hat2'),`):

```ts
  z.literal('hat2'),
  z.literal('clap2'),
]);
```

(d) add to `EnginesMapSchema` (after `hat2: Hat2ParamsSchema,`):

```ts
  hat2: Hat2ParamsSchema,
  clap2: Clap2ParamsSchema,
});
```

(e) add to the `Schemas` export (after `Hat2Params: Hat2ParamsSchema,`):

```ts
  Hat2Params: Hat2ParamsSchema,
  Clap2Params: Clap2ParamsSchema,
```

- [ ] **Step 4: Seed clap2 in the factory (shared)**

In `packages/shared/src/project/factory.ts`: add `DEFAULT_CLAP2_PARAMS,` to the import block (after `DEFAULT_HAT2_PARAMS,`), and add the engine slice to `freshTrack` (after `hat2: structuredClone(DEFAULT_HAT2_PARAMS),`):

```ts
      hat2:   structuredClone(DEFAULT_HAT2_PARAMS),
      clap2:  structuredClone(DEFAULT_CLAP2_PARAMS),
    },
```

- [ ] **Step 5: Add clap2 to the normalize deep-heal key list (shared)**

In `packages/shared/src/project/normalize.ts`, line 24:

```ts
const ENGINE_KEYS = ['synth', 'kick', 'hat', 'snare', 'clap', 'synth2', 'kick2', 'snare2', 'hat2', 'clap2'] as const;
```

(The deep-heal template comes from `freshTrack().engines`, so once Step 4 adds the slice, the heal covers clap2 automatically — old sessions get a default clap2 slice without dropping ops. This closes the *synth2 old-session sync gap* for clap2.)

- [ ] **Step 6: Add clap2 accept-list sync paths (shared)**

In `packages/shared/src/project/accept-list.ts`: add `CLAP2_DESCRIPTORS` to the imports (after the `HAT2_DESCRIPTORS` import line), and add the generated paths after the hat2 line (line 81):

```ts
  // hat2 params — GENERATED from the descriptor table (same as kick2/snare2).
  ...HAT2_DESCRIPTORS.map(d => ['tracks', '*', 'engines', 'hat2', d.key]),
  // clap2 params — GENERATED from the descriptor table (same as kick2/snare2/hat2).
  ...CLAP2_DESCRIPTORS.map(d => ['tracks', '*', 'engines', 'clap2', d.key]),
```

- [ ] **Step 7: Run the shared gate**

Run: `npm run typecheck -w @fiddle/shared && npm run test -w @fiddle/shared`
Expected: PASS — the shared package is now fully clap2-aware. (If a schema round-trip test enumerates engines, it now includes clap2 and stays green because factory + schema + map agree.)

- [ ] **Step 8: Wire clap2 into useSynth (client audio graph)**

In `packages/client/src/composables/useSynth.ts`:

(a) import after the `Hat2Engine` import (line 12):

```ts
import { Hat2Engine } from '../engine/Hat2Engine';
import { Clap2Engine } from '../engine/Clap2Engine';
```

(b) worklet URL after the hat2 URL (line 34):

```ts
// clap2 worklet — same esbuild-bundled static-asset story as hat2.
const clap2WorkletUrl = '/worklets/clap2-processor.js';
```

(c) `ENGINE_SLICES` (line 69) — append `'clap2'`:

```ts
const ENGINE_SLICES: EngineType[] = ['synth', 'kick', 'hat', 'snare', 'clap', 'synth2', 'kick2', 'snare2', 'hat2', 'clap2'];
```

(d) `engineFactories` (after the `hat2:` line 80):

```ts
  hat2:   (ctx, dest) => new Hat2Engine(ctx, dest),
  clap2:  (ctx, dest) => new Clap2Engine(ctx, dest),
};
```

(e) `addModule` after the hat2 addModule (line 555):

```ts
  // clap2 worklet must likewise be registered before any Clap2Engine constructs an
  // AudioWorkletNode('clap2').
  await ctx.audioWorklet.addModule(clap2WorkletUrl);
```

- [ ] **Step 9: Wire clap2 into preset defaults (client)**

In `packages/client/src/project/preset.ts`: import after `Hat2Engine` (line 11):

```ts
import { Hat2Engine } from '../engine/Hat2Engine';
import { Clap2Engine } from '../engine/Clap2Engine';
```

add to `DEFAULTS` (after `hat2:` line 51):

```ts
  hat2:   Hat2Engine.DEFAULT_PARAMS,
  clap2:  Clap2Engine.DEFAULT_PARAMS,
};
```

append `'clap2'` to `ALL_ENGINE_TYPES` (line 54):

```ts
const ALL_ENGINE_TYPES: EngineType[] = ['synth', 'kick', 'hat', 'snare', 'clap', 'synth2', 'kick2', 'snare2', 'hat2', 'clap2'];
```

- [ ] **Step 10: Wire clap2 into storage reconcile (client)**

In `packages/client/src/project/storage.ts`: import after `Hat2Engine` (line 11):

```ts
import { Hat2Engine } from '../engine/Hat2Engine';
import { Clap2Engine } from '../engine/Clap2Engine';
```

add to `reconcileTrack` engines (after `hat2:` line 49):

```ts
      hat2:   deepMerge(Hat2Engine.DEFAULT_PARAMS,   loadedEngines.hat2),
      clap2:  deepMerge(Clap2Engine.DEFAULT_PARAMS,  loadedEngines.clap2),
    },
```

append `'clap2'` to `ENGINE_KEYS` (line 149):

```ts
const ENGINE_KEYS = ['synth', 'kick', 'hat', 'snare', 'clap', 'synth2', 'kick2', 'snare2', 'hat2', 'clap2'] as const;
```

- [ ] **Step 11: Create the clap2 panel**

Create `packages/client/src/components/Clap2Panel.vue` (modelled on `Hat2Panel.vue`; the only differences are the descriptor name, the `:step` binding for the integer `bursts` knob, the `useKnobSync('clap2')` key, the `params` prop type, and the heading):

```vue
<template>
  <div class="rack-columns">
    <!-- Column 1: Drum Controls — knobs generated from the descriptor table -->
    <div class="rack-column">
      <div class="module-group hat-panel">
        <h3>Clap 2 · Worklet</h3>
        <div class="knob-row">
          <Knob
            v-for="d in CLAP2_DESCRIPTORS"
            :key="d.key"
            :label="d.label"
            :min="d.min"
            :max="d.max"
            :step="d.step ?? (d.max - d.min) / 100"
            :defaultValue="d.default"
            :format="d.format"
            :curve="d.curve"
            v-model="params[d.key as keyof typeof params]"
            :syncPath="ks.pathFor(d.key)"
            @gesture-end="ks.end(d.key)"
          />
        </div>
      </div>
    </div>

    <!-- Column 2: Visualizer -->
    <div class="rack-column">
      <Visualizer :analyser="analyser" :color="color" />
    </div>
  </div>
</template>

<script setup lang="ts">
import Knob from './Knob.vue';
import Visualizer from './Visualizer.vue';
import { CLAP2_DESCRIPTORS } from '@fiddle/shared';
import { useKnobSync } from '../sync/knobSync';
import type { EngineParamsMap } from '../project';

const ks = useKnobSync('clap2');

defineProps<{
  params: EngineParamsMap['clap2'];
  analyser: AnalyserNode | null;
  color: string;
}>();
</script>

<style scoped>
/* clap2 has 7 knobs — wrap them into rows instead of overflowing the rack column
   (the default .knob-row is flex-nowrap). Scoped, so only this panel is affected. */
.knob-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 10px;
  justify-content: flex-start;
}
</style>
```

- [ ] **Step 12: Wire the panel + selector into StudioView**

In `packages/client/src/views/StudioView.vue`:

(a) add the engine-selector button after the HAT2 button (after line 141, before the closing `</div>` at 142):

```html
          <button
            :class="{ active: focusedTrack!.engineType === 'clap2' }"
            @click="focusedTrack!.engineType = 'clap2'"
            :style="focusedTrack!.engineType === 'clap2' ? { borderColor: trackColor(activeTrackIndex), color: trackColor(activeTrackIndex) } : {}"
          >
            CLAP2
          </button>
```

(b) add the panel slot after the hat2 `<template v-else-if>` block (after line 246):

```html
            <template v-else-if="focusedTrack!.engineType === 'clap2'">
              <Clap2Panel
                :params="focusedTrack!.engines.clap2"
                :analyser="activeAnalyser"
                :color="trackColor(activeTrackIndex)"
              />
            </template>
```

(c) import the panel after the `Hat2Panel` import (line 308):

```ts
import Hat2Panel from '../components/Hat2Panel.vue';
import Clap2Panel from '../components/Clap2Panel.vue';
```

- [ ] **Step 13: Run the whole-repo gate**

Run: `npm run typecheck && npm test && npm run build`
Expected: PASS — every exhaustive map now includes clap2; the client builds; the worklet bundle is produced. If typecheck reports a missing `clap2` key anywhere, an exhaustive map was missed — add it.

- [ ] **Step 14: Commit**

```bash
git add packages/shared/src/index.ts packages/shared/src/project/types.ts packages/shared/src/project/schema.ts packages/shared/src/project/factory.ts packages/shared/src/project/normalize.ts packages/shared/src/project/accept-list.ts packages/client/src/composables/useSynth.ts packages/client/src/project/preset.ts packages/client/src/project/storage.ts packages/client/src/components/Clap2Panel.vue packages/client/src/views/StudioView.vue
git commit -m "feat(clap2): wire engine end-to-end (union, schema, factory, heal, sync, UI)

Flip EngineType union to include clap2 and complete every exhaustive map:
shared EngineParamsMap/schema/factory/normalize/accept-list; client
engineFactories/ENGINE_SLICES/addModule, preset DEFAULTS, storage reconcile;
Clap2Panel (descriptor-driven, integer Bursts via :step), StudioView selector +
panel slot. clap2 is now selectable, playable, and persisted.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 15: Controller browser verification (MANDATORY — not a subagent step)**

Per AGENTS.md / browser-verify-before-done, the controller verifies in a real browser (Playwright MCP) after Task 4:
1. Start the dev server if not running (`npm run dev` — note whether you started it, to stop only what you started).
2. Open the app, create/open a session, set a track's engine to **CLAP2**.
3. Place a few steps, Play — confirm an audible 909-style hand-clap (a short burst then a room tail).
4. Drag each knob and confirm it re-renders and audibly changes: **Spread** loosens/tightens the burst, **Bursts** snaps to integers 2–5 and reads as a plain number (not a percent), **Room** lengthens the tail, **Tone** shifts the colour, **Body**, **Mix**, **Level**.
5. Confirm the descriptor knobs show the perceptual taper (dial angle vs curve math) — e.g. Tone mid-dial ≈ geometric mean of 500–3000 ≈ 1225 Hz, not 1750.
6. Reload the session and confirm clap2 params persist (no reset to defaults; no console error).
7. Confirm a clean console (no Vue/NaN/worklet errors; benign favicon 404 ok).
8. Close the browser tab; stop only dev servers you started.

---

## Self-Review (against the spec)

**1. Spec coverage:**
- "Mirrors kick2/snare2/hat2 host/kernel/worklet" → Tasks 2 (kernel), 3 (worklet+host), descriptor Task 1. ✓
- "909 burst + room synthesis" → Task 2 kernel (pulse train + room tail + bandpass). ✓
- "7-param append-only descriptor (tone/spread/bursts/body/room/mix/level)" → Task 1 `CLAP2_DESCRIPTORS`. ✓
- "Integer Bursts knob via two additive `DrumParamDescriptor` fields (`step?`, `format?`)" → Task 1 Step 1 + Step 5 descriptor + Task 4 panel `:step`. ✓
- "Additive; legacy clap untouched" → no task edits `clap.*`; global constraint. ✓
- "No factory presets" → no preset library task. ✓
- "Reuses knob tapers via `:curve`" → Task 4 panel binds `:curve="d.curve"`; no knobTaper edits. ✓
- "Append-an-engine touch-points" (DRUM_WORKLETS) → Task 4 covers EngineType, EngineParamsMap, schema (EngineTypeSchema/EnginesMap/Schemas), factory, normalize ENGINE_KEYS, accept-list, useSynth (engineFactories/ENGINE_SLICES/addModule), preset (DEFAULTS/ALL_ENGINE_TYPES), storage (reconcileTrack/ENGINE_KEYS), panel + StudioView, build:worklet (Task 3). `engineLabel` confirmed no-change. ✓
- "Old-session deep-heal covers clap2" → Task 4 Step 5 note (template-driven heal). ✓
- "Testing: kernel unit tests + descriptor contract + gate + browser-verify" → Tasks 1, 2 tests + Task 4 Step 15. ✓

**2. Placeholder scan:** No TBD/TODO. Every code step shows complete code. `OUT_TRIM` and the `mix` gain formula are concrete constants with a stated tuning note (test bound is fixed; trim is the adjustable headroom). No "handle edge cases" hand-waves.

**3. Type consistency:** `Clap2EngineParams`, `CLAP2_DESCRIPTORS`, `DEFAULT_CLAP2_PARAMS`, `Clap2Engine`, `Clap2Kernel`, processor name `'clap2'`, worklet file `clap2-processor.js`, engine key `clap2` used identically across all tasks. `Clap2Engine.DEFAULT_PARAMS` referenced by preset/storage matches the static defined in Task 3. `engineFactories`/`DEFAULTS`/`reconcileTrack`/`EnginesMapSchema`/`EngineParamsMap`/`freshTrack` all gain exactly the `clap2` key, consistent with the union flip in Task 4 Step 1.
