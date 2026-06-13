# synth2 I2b — Oscillator section (oscs 2+3, noise, mixer, TZFM) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Grow the synth2 voice from one oscillator to the full oscillator section — **osc2 + osc3** (morph oscillators), a **noise** channel, a **4-way mixer** (osc1/2/3 + noise levels), and **through-zero FM** (osc1→osc2, osc2→osc3) — all as continuous params on the existing Float32 param block.

**Architecture:** Everything added here is a *continuous* parameter, so it rides the existing descriptor table → param-block → `applyParams` plumbing with **no protocol change** (the engine's `applyParams` already writes any new numeric leaf to the block; schema/accept-list/defaults/param-block all auto-derive from `SYNTH2_DESCRIPTORS`). The shared package gets +14 descriptor rows and an extended params interface; the kernel gets a new `Noise` module, a TZFM input on `MorphOscillator`, and a `Voice` rewire that instantiates osc2/osc3/noise and sums the mixer. The DspModule convention (modules take ParamSlots, never import each other; `Voice.ts` wires all inter-module signal flow) is preserved (spec §6.3).

**Tech Stack:** TypeScript, Web Audio AudioWorklet (pure-TS kernel), Zod (wire schema), Vue 3, Vitest, npm workspaces.

## Context — why, and the one design choice baked in

I2a (polyphony) is merged. I2 was sliced into **I2a poly → I2b oscs → I2c filter** (each its own branch/plan/gate/verify). This is **I2b**.

**Scope decision (confirmed with the user):** hard sync is **deferred to I2c**. Sync is the engine's first *discrete* kernel param (a per-osc boolean the current descriptor block can't carry), and I2c's filter introduces the same need (`filter.model`/`type` enums) — so the discrete-param channel is designed **once** in I2c, for sync + filter together. **I2b therefore contains zero discrete kernel params** and needs no protocol/ABI change.

**Param-namespace choice (permanent — the descriptor table is append-only once merged).** §7 of the spec enumerates the osc/env/lfo/filter/matrix modules but does *not* pin keys for noise or the TZFM amounts. This plan fixes them as:
- osc2/osc3 mirror osc1 exactly: `osc2.{morph,pulseWidth,coarse,fine,level}`, `osc3.{…}`.
- noise as its own module: `noise.level`, `noise.color`.
- TZFM amounts as an `fm` module keyed by **carrier**: `fm.osc2` (= osc1→osc2 index, "fm12"), `fm.osc3` (= osc2→osc3 index, "fm23").

All 14 are continuous + `modulatable: true` (they become matrix destinations in I3 for free).

**Branch:** `feat/synth2-i2b-oscillators` (already created off `main`). Never commit on `main`.

## Out of scope (explicit)
- **Hard sync** + per-osc `sync` booleans + the discrete-param channel → **I2c**.
- `FilterModule`/`ClassicFilter`/env2/keytrack → **I2c**.
- Mod matrix / LFOs / env3 / loop envelopes → **I3**.
- The I1 `sessions.ts` `as unknown as Project` double-cast — orthogonal.

## Approach (what auto-derives vs. what is hand-written)

Adding rows to `SYNTH2_DESCRIPTORS` **automatically** extends: the kernel param-block layout + `PARAM_COUNT` (`client kernel/params.ts`), `DEFAULT_SYNTH2_PARAMS` (`buildDefaults()` groups by `module.field`), `Synth2ParamsSchema` + `SYNTH2_LEAF_SCHEMAS` (generated loop in `schema.ts`), the accept-list synth2 patterns (`...SYNTH2_DESCRIPTORS.map(...)`), and `Synth2Engine.applyParams` (generic numeric-leaf writer). The existing contract tests iterate the table, so they cover the new leaves with no edit.

**Hand-written** changes: the 14 descriptor rows; the `Synth2EngineParams` interface (add `osc2`/`osc3`/`noise`/`fm`); the new `Noise` kernel module; the `MorphOscillator` TZFM input; the `Voice` rewire; the panel UI. `reconcileTrack`'s `deepMerge(DEFAULT_SYNTH2_PARAMS, …)` heals old snapshots automatically once defaults include the new modules.

---

### Task 0: Confirm branch
- [ ] **Step 1:** `git rev-parse --abbrev-ref HEAD` → must print `feat/synth2-i2b-oscillators` (already created off `main`). If not, `git checkout main && git checkout -b feat/synth2-i2b-oscillators`.

---

### Task 1: Shared — descriptor table + params interface (osc2, osc3, noise, fm)

**Files:**
- Modify: `packages/shared/src/engines/synth2-descriptors.ts` (append 14 rows after `env1.r`)
- Modify: `packages/shared/src/engines/synth2.ts` (extend `Synth2EngineParams`)
- Test: existing `synth2.test.ts`, `schema.test.ts`, `accept-list.test.ts`, client `Synth2Kernel.test.ts`/`Synth2Engine.test.ts` (should stay green by derivation; the leaf-count test updates by construction)

- [ ] **Step 1: Run the suite first (baseline green).**
Run: `npm test -w @fiddle/shared && npm test -w @fiddle/client`. Note the current totals.

- [ ] **Step 2: Append the descriptor rows** (in `synth2-descriptors.ts`, after the `env1.r` row, preserving append-only order):

```ts
  // --- I2b oscillator section (append-only) ---
  // osc2 — mirrors osc1. Default: detuned saw (+7 cents) for the classic fat default (spec §5.8).
  { key: 'osc2.morph',      min: 0,    max: 3,    default: 2,   taper: 'linear',     modulatable: true, modScale: 1 },
  { key: 'osc2.pulseWidth', min: 0.05, max: 0.95, default: 0.5, taper: 'linear',     modulatable: true, modScale: 1 },
  { key: 'osc2.coarse',     min: -36,  max: 36,   default: 0,   taper: 'linear',     modulatable: true, modScale: 24 / 72 },
  { key: 'osc2.fine',       min: -100, max: 100,  default: 7,   taper: 'linear',     modulatable: true, modScale: 1 },
  { key: 'osc2.level',      min: 0,    max: 1,    default: 0.8, taper: 'linear',     modulatable: true, modScale: 1 },
  // osc3 — mirrors osc1. Default level 0 (silent until dialed in; spec §5.8).
  { key: 'osc3.morph',      min: 0,    max: 3,    default: 2,   taper: 'linear',     modulatable: true, modScale: 1 },
  { key: 'osc3.pulseWidth', min: 0.05, max: 0.95, default: 0.5, taper: 'linear',     modulatable: true, modScale: 1 },
  { key: 'osc3.coarse',     min: -36,  max: 36,   default: 0,   taper: 'linear',     modulatable: true, modScale: 24 / 72 },
  { key: 'osc3.fine',       min: -100, max: 100,  default: 0,   taper: 'linear',     modulatable: true, modScale: 1 },
  { key: 'osc3.level',      min: 0,    max: 1,    default: 0,   taper: 'linear',     modulatable: true, modScale: 1 },
  // noise — 4th mixer channel. color is a one-pole LP amount 0..1 (1 = white) (spec §6.8).
  { key: 'noise.level',     min: 0,    max: 1,    default: 0,   taper: 'linear',     modulatable: true, modScale: 1 },
  { key: 'noise.color',     min: 0,    max: 1,    default: 1,   taper: 'linear',     modulatable: true, modScale: 1 },
  // TZFM index by carrier: fm.osc2 = osc1→osc2, fm.osc3 = osc2→osc3. Range >1 enables
  // through-zero (dt' = dt·(1 + amt·mod) can go negative). Default 0 (off).
  { key: 'fm.osc2',         min: 0,    max: 4,    default: 0,   taper: 'linear',     modulatable: true, modScale: 1 },
  { key: 'fm.osc3',         min: 0,    max: 4,    default: 0,   taper: 'linear',     modulatable: true, modScale: 1 },
```

- [ ] **Step 3: Extend the params interface** in `synth2.ts`:

```ts
export interface Synth2NoiseParams {
  level: number;
  color: number;
}

export interface Synth2FmParams {
  osc2: number; // osc1 → osc2 TZFM index
  osc3: number; // osc2 → osc3 TZFM index
}

export interface Synth2EngineParams {
  osc1: Synth2OscParams;
  osc2: Synth2OscParams;
  osc3: Synth2OscParams;
  noise: Synth2NoiseParams;
  fm: Synth2FmParams;
  env1: Synth2EnvParams;
  mode: 'mono' | 'poly';
}
```

`buildDefaults()` is unchanged — it already groups every descriptor by `module.field`, so it now produces `osc2/osc3/noise/fm` objects automatically; the trailing `mode: 'mono'` stays.

- [ ] **Step 4: Run all derivations green.**
Run: `npm test -w @fiddle/shared`. The leaf-count test (`synth2.test.ts`) asserts `leafCount === SYNTH2_DESCRIPTORS.length`; both sides grew by 14 (5+5+2+2 leaves vs 14 rows), so it stays true. `schema.test.ts` (defaults parse) + `accept-list.test.ts` (every descriptor key writable) cover the new leaves by iterating the table.
Run: `npm test -w @fiddle/client` — `Synth2Kernel.test.ts` (`PARAM_COUNT === SYNTH2_DESCRIPTORS.length`, index map) and `Synth2Engine.test.ts` ("full slice coverage" iterates descriptors) stay green; I1 osc1/env1 indices are unchanged (append-only).
Run: `npm run typecheck` (all workspaces) — the `Synth2EngineParams` change must typecheck against `Synth2Engine.DEFAULT_PARAMS`, the panel, and `reconcileTrack`.

If any contract test hard-codes the old descriptor count or the old interface shape, update it to the new reality (the count is derived, so this should not happen — but if a test enumerates module names, add osc2/osc3/noise/fm).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/engines/synth2-descriptors.ts packages/shared/src/engines/synth2.ts
git commit -m "feat(shared): synth2 descriptor table + params for osc2/osc3/noise/fm (I2b)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Kernel — `Noise` module (seeded xorshift32 + one-pole color LP)

White noise from a per-voice xorshift32 PRNG (deterministic for tests); `color` is a one-pole lowpass, 0 = dark, 1 = white (spec §6.8).

**Files:**
- Create: `packages/client/src/engine/synth2/kernel/Noise.ts`
- Test: `packages/client/src/engine/synth2/kernel/Noise.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from 'vitest';
import { Noise } from './Noise';

describe('Noise', () => {
  it('is deterministic for a given seed', () => {
    const a = new Noise(12345), b = new Noise(12345);
    for (let i = 0; i < 100; i++) expect(a.next(1)).toBe(b.next(1)); // color 1 = white
  });

  it('different seeds diverge', () => {
    const a = new Noise(1), b = new Noise(2);
    let same = 0;
    for (let i = 0; i < 100; i++) if (a.next(1) === b.next(1)) same++;
    expect(same).toBeLessThan(5);
  });

  it('white output stays within [-1, 1] and is roughly zero-mean', () => {
    const n = new Noise(99);
    let sum = 0, max = 0;
    for (let i = 0; i < 10000; i++) { const v = n.next(1); sum += v; max = Math.max(max, Math.abs(v)); }
    expect(max).toBeLessThanOrEqual(1);
    expect(Math.abs(sum / 10000)).toBeLessThan(0.05);
  });

  it('color < 1 lowpasses: less high-frequency energy than white', () => {
    // crude HF metric: mean |sample-to-sample difference|
    const white = new Noise(7), dark = new Noise(7);
    let dw = 0, dd = 0, pw = 0, pd = 0;
    for (let i = 0; i < 5000; i++) { const w = white.next(1); dw += Math.abs(w - pw); pw = w; const d = dark.next(0.02); dd += Math.abs(d - pd); pd = d; }
    expect(dd).toBeLessThan(dw); // dark has gentler sample-to-sample motion
  });
});
```

- [ ] **Step 2: Run red.** `npm test -w @fiddle/client -- Noise` → FAIL (no module).

- [ ] **Step 3: Implement** `Noise.ts`:

```ts
// Per-voice white-noise source with a one-pole "color" lowpass (spec §6.8).
// Seeded xorshift32 → deterministic under test. color: 1 = white (no filtering),
// →0 = progressively darker. Pure, allocation-free (kernel ABI §6.7).

export class Noise {
  private state: number;
  private lp = 0; // one-pole lowpass memory

  constructor(seed: number) {
    // Avoid the zero fixed-point of xorshift; keep it a 32-bit uint.
    this.state = (seed | 0) || 0x9e3779b9;
  }

  /** @param color 0..1 lowpass amount (1 = white). One sample in [-1, 1). */
  next(color: number): number {
    let x = this.state;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.state = x >>> 0;
    const white = (this.state / 0xffffffff) * 2 - 1; // [-1, 1)
    // One-pole LP: coefficient grows toward 1 as color→0 (darker). At color=1 the
    // pole is at 0 (pass-through = white). Clamp color into (0,1].
    const c = color < 0 ? 0 : color > 1 ? 1 : color;
    const a = 1 - c; // a=0 → white, a→1 → heavy LP
    this.lp = this.lp + (1 - a) * (white - this.lp);
    return this.lp;
  }
}
```

(Note for the implementer: the exact one-pole formulation can vary; what the test pins is **determinism**, **bounded ±1**, **zero-mean-ish**, and **color<1 reduces HF**. If your formulation needs a different coefficient mapping to satisfy the HF test, keep `color=1`⇒white pass-through and `color→0`⇒darker, and keep it allocation-free.)

- [ ] **Step 4: Run green.** `npm test -w @fiddle/client -- Noise` → PASS; `npm run typecheck -w @fiddle/client` clean.

- [ ] **Step 5: Commit**
```bash
git add packages/client/src/engine/synth2/kernel/Noise.ts packages/client/src/engine/synth2/kernel/Noise.test.ts
git commit -m "feat(client): synth2 Noise kernel module (seeded xorshift32 + color LP)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Kernel — TZFM input on `MorphOscillator`

Add a through-zero FM input. The carrier's per-sample phase increment is scaled by the modulator: `dt' = dt × (1 + fmAmount × fmInput)`, allowing negative `dt'` (phase runs backward = through-zero) (spec §6.8). Backward-compatible: osc1 keeps calling `next(freq)`.

**Files:**
- Modify: `packages/client/src/engine/synth2/kernel/MorphOscillator.ts`
- Test: `packages/client/src/engine/synth2/kernel/MorphOscillator.test.ts`

- [ ] **Step 1: Failing tests** (add to the existing describe):

```ts
import { Noise } from './Noise'; // not needed; remove if unused

describe('MorphOscillator TZFM', () => {
  // helper makeOsc(...) already exists in this file for the I1 tests; reuse it.
  it('fmAmount 0 (or fmInput 0) is identical to no FM', () => {
    const a = makeOsc({ morph: 2 }), b = makeOsc({ morph: 2 });
    for (let i = 0; i < 256; i++) {
      expect(b.next(220, 0.9, 0)).toBeCloseTo(a.next(220), 10); // fmInput 0.9 but amount 0
    }
  });

  it('FM injects spectral sidebands (output differs from unmodulated)', () => {
    const plain = makeOsc({ morph: 0 });       // sine carrier
    const fm = makeOsc({ morph: 0 });
    const modA = makeOsc({ morph: 0, coarse: 0 }); // sine modulator at same base
    const modB = makeOsc({ morph: 0, coarse: 0 });
    let diff = 0;
    for (let i = 0; i < 2048; i++) {
      const mA = modA.next(220), mB = modB.next(220);
      const p = plain.next(220);
      const f = fm.next(220, mB, 2); // deep index
      diff += Math.abs(f - p);
      void mA;
    }
    expect(diff).toBeGreaterThan(1); // clearly modulated
  });

  it('stays finite under deep through-zero modulation (no NaN/Inf)', () => {
    const car = makeOsc({ morph: 2 }), mod = makeOsc({ morph: 2 });
    for (let i = 0; i < 4096; i++) {
      const v = car.next(330, mod.next(330), 4);
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});
```

(If the I1 test file has no `makeOsc` helper, add a small one that builds `ParamSlot`s for morph/pw/coarse/fine from constants and returns `new MorphOscillator(...)`, mirroring the existing I1 setup in that file.)

- [ ] **Step 2: Run red.** `npm test -w @fiddle/client -- MorphOscillator` → FAIL (arity / behavior).

- [ ] **Step 3: Implement.** Change `next` to accept optional FM, and modulate `dt`. Handle wrap for negative `dt'` (phase can step below 0):

```ts
  /**
   * @param baseFreq carrier base frequency (Hz)
   * @param fmInput  modulator sample this tick (default 0 — e.g. osc1 has no FM in)
   * @param fmAmount through-zero FM index (default 0)
   */
  next(baseFreq: number, fmInput = 0, fmAmount = 0): number {
    const semis = this.coarse.next() + this.fine.next() / 100;
    const f = baseFreq * Math.pow(2, semis / 12);
    const dt0 = f / this.sampleRate;
    // Through-zero FM: scale the phase increment; dt may go negative.
    const dt = dt0 * (1 + fmAmount * fmInput);
    const pw = this.pulseWidth.next();
    const m = this.morph.next();

    // … existing square-integrator + shape-crossfade body, using `dt` …

    this.phase += dt;
    // Wrap for either direction (TZFM can push phase below 0 or past 1).
    if (this.phase >= 1) this.phase -= 1;
    else if (this.phase < 0) this.phase += 1;
    return out;
  }
```

Keep the existing PolyBLEP/triangle body exactly; it already uses `dt`. PolyBLEP under negative `dt` may leave minor residual aliasing at extreme FM — accepted in v1 (spec §6.8 "good enough over perfect"). Do NOT change `reset()`.

IMPORTANT: `coarse.next()`/`fine.next()`/`pulseWidth.next()`/`morph.next()` must still each be called exactly once per sample (ParamSlot contract) — they already are; don't reorder them out of the per-sample path.

- [ ] **Step 4: Run green.** `npm test -w @fiddle/client -- MorphOscillator` → PASS (new + all I1 cases — osc1 calls `next(freq)` and defaults give identical output). `npm run typecheck -w @fiddle/client` clean.

- [ ] **Step 5: Commit**
```bash
git add packages/client/src/engine/synth2/kernel/MorphOscillator.ts packages/client/src/engine/synth2/kernel/MorphOscillator.test.ts
git commit -m "feat(client): synth2 MorphOscillator gains a through-zero FM input

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Kernel — `Voice` rewires osc2/osc3 + noise + mixer + TZFM

The patch file (spec §6.3): instantiate osc2, osc3, noise; read the new ParamSlots; sum the 4-channel mixer; route TZFM osc1→osc2→osc3. Per-voice noise seed for determinism.

**Files:**
- Modify: `packages/client/src/engine/synth2/kernel/Voice.ts`
- Modify: `packages/client/src/engine/synth2/kernel/Synth2Kernel.ts` (pass a per-voice seed)
- Test: `packages/client/src/engine/synth2/kernel/Synth2Kernel.test.ts` (mixer/level/noise/TZFM behavior, end-to-end through the kernel)

- [ ] **Step 1: Failing tests** (add a `Synth2Kernel oscillator section` describe). These drive the kernel (which owns voices), asserting observable audio behavior:

```ts
describe('Synth2Kernel oscillator section', () => {
  function renderEnergy(setup: (b: Float32Array) => void): number {
    const k = new Synth2Kernel(SR);
    const block = defaultParamBlock();
    setup(block);
    k.applyParams(block);
    k.noteOn(0, 220, 1, 1, true);
    const out = renderBlocks(k, 0, 16);
    let e = 0; for (let i = 0; i < out.length; i++) e += Math.abs(out[i]);
    return e;
  }

  it('osc2 level contributes audio (energy rises when osc2.level goes up from 0)', () => {
    const lo = renderEnergy(b => { b[PARAM_INDEX['osc2.level']] = 0; });
    const hi = renderEnergy(b => { b[PARAM_INDEX['osc2.level']] = 1; });
    expect(hi).toBeGreaterThan(lo * 1.05);
  });

  it('osc3 is silent at level 0 and audible above it', () => {
    const off = renderEnergy(b => { b[PARAM_INDEX['osc1.level']] = 0; b[PARAM_INDEX['osc2.level']] = 0; b[PARAM_INDEX['osc3.level']] = 0; });
    const on  = renderEnergy(b => { b[PARAM_INDEX['osc1.level']] = 0; b[PARAM_INDEX['osc2.level']] = 0; b[PARAM_INDEX['osc3.level']] = 1; });
    expect(off).toBeLessThan(1e-3);
    expect(on).toBeGreaterThan(0.1);
  });

  it('noise contributes broadband energy when noise.level > 0', () => {
    const off = renderEnergy(b => { b[PARAM_INDEX['osc1.level']] = 0; b[PARAM_INDEX['noise.level']] = 0; });
    const on  = renderEnergy(b => { b[PARAM_INDEX['osc1.level']] = 0; b[PARAM_INDEX['noise.level']] = 1; });
    expect(off).toBeLessThan(1e-3);
    expect(on).toBeGreaterThan(0.1);
  });

  it('per-voice noise seeds differ (two poly voices are not bit-identical noise)', () => {
    const k = new Synth2Kernel(SR);
    const block = defaultParamBlock();
    block[PARAM_INDEX['osc1.level']] = 0; block[PARAM_INDEX['osc2.level']] = 0;
    block[PARAM_INDEX['noise.level']] = 1;
    k.applyParams(block);
    k.noteOn(0, 220, 1, 1, false); // poly → voice A
    k.noteOn(0, 440, 1, 1, false); // poly → voice B
    const out = renderBlocks(k, 0, 8);
    // Two independent noise voices summed → not a clean doubling of one stream.
    // Assert the buffer isn't trivially periodic/zero: it has substantial energy.
    let e = 0; for (let i = 0; i < out.length; i++) e += Math.abs(out[i]);
    expect(e).toBeGreaterThan(0.1);
  });

  it('TZFM changes osc2 output (fm.osc2 > 0 alters the spectrum vs fm.osc2 = 0)', () => {
    const noFm = renderEnergy(b => { b[PARAM_INDEX['fm.osc2']] = 0; });
    const fm   = renderEnergy(b => { b[PARAM_INDEX['fm.osc2']] = 3; });
    expect(Math.abs(fm - noFm)).toBeGreaterThan(0.01); // measurable change
  });
});
```

- [ ] **Step 2: Run red.** `npm test -w @fiddle/client -- Synth2Kernel` → FAIL (osc2/osc3/noise unwired; energy doesn't respond).

- [ ] **Step 3: Implement `Voice.ts`.** Add osc2/osc3/noise, the mixer-level slots, and the fm slots; wire the signal flow in `renderAdd`:

```ts
import { Noise } from './Noise';
// … existing imports …

export class Voice {
  readonly slots: ParamSlot[];

  private readonly osc1: MorphOscillator;
  private readonly osc2: MorphOscillator;
  private readonly osc3: MorphOscillator;
  private readonly env1: LoopEnvelope;
  private readonly osc1Level: ParamSlot;
  private readonly osc2Level: ParamSlot;
  private readonly osc3Level: ParamSlot;
  private readonly noiseLevel: ParamSlot;
  private readonly noiseColor: ParamSlot;
  private readonly fmOsc2: ParamSlot;
  private readonly fmOsc3: ParamSlot;
  private readonly noise: Noise;
  private freq = 440;
  private velocity = 1;

  constructor(sampleRate: number, seed = 1) {
    this.slots = SYNTH2_DESCRIPTORS.map(d => new ParamSlot(d, sampleRate));
    const slot = (key: string): ParamSlot => this.slots[PARAM_INDEX[key]];

    this.osc1 = new MorphOscillator(slot('osc1.morph'), slot('osc1.pulseWidth'), slot('osc1.coarse'), slot('osc1.fine'), sampleRate);
    this.osc2 = new MorphOscillator(slot('osc2.morph'), slot('osc2.pulseWidth'), slot('osc2.coarse'), slot('osc2.fine'), sampleRate);
    this.osc3 = new MorphOscillator(slot('osc3.morph'), slot('osc3.pulseWidth'), slot('osc3.coarse'), slot('osc3.fine'), sampleRate);
    this.osc1Level = slot('osc1.level');
    this.osc2Level = slot('osc2.level');
    this.osc3Level = slot('osc3.level');
    this.noiseLevel = slot('noise.level');
    this.noiseColor = slot('noise.color');
    this.fmOsc2 = slot('fm.osc2');
    this.fmOsc3 = slot('fm.osc3');
    this.noise = new Noise(seed);
    this.env1 = new LoopEnvelope(slot('env1.a'), slot('env1.d'), slot('env1.s'), slot('env1.r'), sampleRate);
  }

  get active(): boolean { return this.env1.active; }

  noteOn(freq: number, velocity: number, gateFrames: number): void {
    this.freq = freq;
    this.velocity = velocity < 0 ? 0 : velocity > 1 ? 1 : velocity;
    if (!this.env1.active) { this.osc1.reset(); this.osc2.reset(); this.osc3.reset(); }
    this.env1.noteOn(gateFrames);
  }

  renderAdd(out: Float32Array, from: number, to: number): void {
    for (let n = from; n < to; n++) {
      const e = this.env1.next();
      // TZFM chain: osc1 → osc2 → osc3. Each ParamSlot.next() called exactly once/sample.
      const o1 = this.osc1.next(this.freq);
      const o2 = this.osc2.next(this.freq, o1, this.fmOsc2.next());
      const o3 = this.osc3.next(this.freq, o2, this.fmOsc3.next());
      const nz = this.noise.next(this.noiseColor.next());
      const mix =
        o1 * this.osc1Level.next() +
        o2 * this.osc2Level.next() +
        o3 * this.osc3Level.next() +
        nz * this.noiseLevel.next();
      out[n] += mix * e * this.velocity;
    }
  }
}
```

CRITICAL (ParamSlot contract + kernel ABI): every slot's `next()` is called exactly once per sample (osc internals call their own morph/pw/coarse/fine; here we call the 4 level slots, 2 fm slots, noise color, env1). No allocation in `renderAdd`. No `Array` iteration helpers in the loop.

In `Synth2Kernel.ts`, pass a per-voice seed so poly voices decorrelate:

```ts
this.voices = Array.from({ length: VOICE_COUNT }, (_, i) => new Voice(sampleRate, (i + 1) * 0x9e3779b9));
```

- [ ] **Step 4: Run green.** `npm test -w @fiddle/client -- Synth2Kernel` → PASS (new oscillator-section suite + all I1/I2a cases; the default block still sounds because osc1.level 0.8 + osc2.level 0.8 are summed). `npm run typecheck -w @fiddle/client` clean. Spot-check `renderAdd` for zero allocation.

- [ ] **Step 5: Commit**
```bash
git add packages/client/src/engine/synth2/kernel/Voice.ts packages/client/src/engine/synth2/kernel/Synth2Kernel.ts packages/client/src/engine/synth2/kernel/Synth2Kernel.test.ts
git commit -m "feat(client): synth2 Voice adds osc2/osc3, noise, 4-way mixer, TZFM chain

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: UI — Synth2Panel gains osc2/osc3, noise, mixer, FM controls

Extend the panel with the new knobs, following the existing D14 slice/D13 knob-sync pattern already used for osc1/env1 (`v-model="params.<mod>.<field>"`, `:syncPath="ks.pathFor([...])"`, `@gesture-end="ks.end([...])"`). No new sync wiring — the engine-slice watcher already emits any changed numeric leaf.

**Files:**
- Modify: `packages/client/src/components/Synth2Panel.vue`
- Test: `packages/client/src/components/Synth2Panel.test.ts` (extend)

- [ ] **Step 1: Failing test.** Extend the existing component test to assert the new knobs render and bind. Follow the repo's `createApp`+jsdom convention already in this file. Example:

```ts
  it('renders osc2/osc3/noise/fm controls bound to params', async () => {
    const params: any = structuredClone(Synth2Engine.DEFAULT_PARAMS);
    const el = mountPanel(params); // reuse the file's existing mount helper
    // Knob labels are unique enough to find; assert presence of the new sections.
    const text = el.textContent || '';
    expect(text).toContain('OSC 2');
    expect(text).toContain('OSC 3');
    expect(text).toContain('NOISE');
    // FM knobs present
    expect(text.toUpperCase()).toContain('FM');
  });
```

(If the existing test file's helper is named differently, reuse it; do not invent a new harness shape.)

- [ ] **Step 2: Run red.** `npm test -w @fiddle/client -- Synth2Panel` → FAIL.

- [ ] **Step 3: Implement.** Add to `Synth2Panel.vue`:
- **OSC 2** and **OSC 3** module-groups mirroring the existing OSC 1 group (Morph/PW/Coarse/Fine/Level knobs), bound to `params.osc2.*` / `params.osc3.*` with `ks.pathFor(['osc2','morph'])` etc. Knob ranges come from the descriptors (morph 0–3, pw 0.05–0.95, coarse −36–36, fine −100–100, level 0–1).
- **NOISE** group: Level (0–1) + Color (0–1) → `params.noise.level` / `params.noise.color`.
- **FM** group: two knobs (0–4) → `params.fm.osc2` (label e.g. "FM 1→2") and `params.fm.osc3` ("FM 2→3").
Place them sensibly in the existing `.rack-columns` layout (e.g., osc2/osc3 in their own column(s), noise+fm grouped). Keep `DEFAULTS = Synth2Engine.DEFAULT_PARAMS` for each knob's `:defaultValue`.

- [ ] **Step 4: Run green.** `npm test -w @fiddle/client -- Synth2Panel` → PASS; `npm run typecheck -w @fiddle/client` clean.

- [ ] **Step 5: Commit**
```bash
git add packages/client/src/components/Synth2Panel.vue packages/client/src/components/Synth2Panel.test.ts
git commit -m "feat(client): Synth2Panel adds osc2/osc3, noise, mixer levels, FM knobs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Full gate + browser verification

- [ ] **Step 1: Full merge gate.**
Run: `npm run typecheck && npm test && npm run build`. All 3 workspaces typecheck clean; all tests pass; build emits `packages/client/public/worklets/synth2-processor.js` (and `dist/`). The new descriptor count flows through the worklet bundle.

- [ ] **Step 2: Allocation spot-check.** Re-read `Voice.renderAdd` and `Noise.next`: no `new`, no array literals/helpers, no closures per sample — all state preallocated.

- [ ] **Step 3: Browser (Playwright MCP, then close).**
  1. Dev server already on :5173 (rebuild worklet via `npm run build` first so the new params are in the bundle). Open a session; add a synth2 track; focus it.
  2. Synth2Panel shows OSC 1/2/3, NOISE, FM controls; default sounds (osc1+osc2 detuned saws) on Play.
  3. Raise **osc3.level** → sound thickens; raise **noise.level** → broadband hiss added; sweep **noise.color** → timbre darkens/brightens.
  4. Raise **FM 1→2** → osc2 timbre changes (sidebands); at high settings still stable, no clicks/NaN (silence-free).
  5. Console clean (ignore the pre-existing favicon 404). Two-client: change osc2/osc3/noise/fm knobs in client A → client B converges (continuous leaves sync via the existing watcher).
  6. **Close the browser/session.**

- [ ] **Step 4: Leave the branch for user review** — do NOT merge. Report gate + verification; user browser-verifies (hear the FM/noise) and merges.

---

## Self-review (coverage vs I2b scope)
- osc2 + osc3 (morph/pw/coarse/fine/level): Task 1 (descriptors+types) + Task 4 (Voice wiring) + Task 5 (UI). ✔
- noise channel (level + color, seeded per voice): Task 1 + Task 2 (module) + Task 4 (wiring/seed) + Task 5 (UI). ✔
- mixer levels (4-way sum): Task 4 (`renderAdd`) + Task 5 (UI). ✔
- TZFM fm.osc2/fm.osc3 (osc1→osc2→osc3, `dt'=dt·(1+amt·mod)`): Task 1 + Task 3 (oscillator input) + Task 4 (chain) + Task 5 (UI). ✔
- All new params are continuous → auto schema/accept-list/defaults/param-block/sync; contract tests cover by iterating the table. ✔
- Hard sync + discrete-param channel: **explicitly deferred to I2c**. ✔
- Append-only discipline: 14 rows appended after `env1.r`; osc1/env1 indices unchanged. ✔
- Type consistency across tasks: `MorphOscillator.next(baseFreq, fmInput=0, fmAmount=0)`; `Noise(seed).next(color)`; `Voice(sampleRate, seed)`; keys `osc2.*`/`osc3.*`/`noise.level`/`noise.color`/`fm.osc2`/`fm.osc3`. ✔
