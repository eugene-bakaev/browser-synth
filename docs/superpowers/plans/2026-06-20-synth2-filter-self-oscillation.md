# synth2 Filter Self-Oscillation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let synth2's resonance knob reach true self-oscillation (a sustained, in-tune sine) and add an opt-in `filter.drive` saturation control, building on the existing Cytomic ZDF `SvfCore`.

**Architecture:** All DSP lives in `SvfCore` — the resonance→`k` map reserves the top of the knob (res > 0.9) to ramp `k` below zero, a `tanh` feedback saturator (the `drive` knob, plus a minimal limiter) bounds the resulting limit cycle, and a tiny noise floor injected *only* in the oscillation zone seeds it from silence. `drive` threads through the `FilterModule` seam (`ClassicFilter`/`MorphFilter`) and one appended descriptor row carries the new param through defaults, schema, accept-list, sync, and the panel automatically.

**Tech Stack:** TypeScript, Web Audio AudioWorklet, Vue 3, Vitest, npm workspaces (`@fiddle/client`, `@fiddle/shared`).

**Spec:** `docs/superpowers/specs/2026-06-20-synth2-filter-self-oscillation-design.md`

## Global Constraints

- **Branch:** `feat/synth2-filter-self-osc` (already created off `main`). Never commit on `main`.
- **Gate (green before any merge):** `npm run typecheck && npm test && npm run build` across all workspaces; the build still emits `packages/client/public/worklets/synth2-processor.js`.
- **Approach A invariant:** `resonance ≤ 0.9` with `drive = 0` must stay **bit-identical** to today's filter. Self-oscillation, saturation, and noise injection are all gated to where the user asks for them.
- **`SYNTH2_DESCRIPTORS` is APPEND-ONLY:** the new row goes at the **end** of the array. Never insert or reorder existing rows. (Changing an existing row's `default` value is allowed; this plan changes none.)
- **Kernel invariants:** allocation-free hot path (no `new`/array growth in `tick`/`process`), deterministic (fixed seed → identical stream), per-voice state only.
- **Commits:** stage only the named files (never `git add -A`/`git add .`). End every commit message with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **Done = browser-verified:** a Playwright MCP pass with a clean console is mandatory before reporting client work complete; close the browser afterward. Green unit tests are not a substitute.

## File Structure

| File | Responsibility | Task |
|------|----------------|------|
| `packages/client/src/engine/synth2/kernel/SvfCore.ts` | The self-oscillation DSP: `drive` arg, reserve-top `k` map, feedback saturator, gated noise injection, input NaN-sanitize. | 1 |
| `packages/client/src/engine/synth2/kernel/SvfCore.test.ts` | Back-compat lock + oscillation/tuning/startup/drive/NaN tests; retarget the res-1.0 flush test. | 1 |
| `packages/client/src/engine/synth2/kernel/FilterModule.ts` | Interface: `process` gains `drive`. | 2 |
| `packages/client/src/engine/synth2/kernel/ClassicFilter.ts` | Thread `drive` into `svf.tick`. | 2 |
| `packages/client/src/engine/synth2/kernel/MorphFilter.ts` | Thread `drive` into `svf.tick`. | 2 |
| `packages/client/src/engine/synth2/kernel/ClassicFilter.test.ts` / `MorphFilter.test.ts` | Passthrough tests (drive reaches the SVF). | 2 |
| `packages/shared/src/engines/synth2-descriptors.ts` | Append the `filter.drive` row. | 3 |
| `packages/shared/src/engines/synth2.ts` | Add `drive: number` to `Synth2FilterParams`. | 3 |
| `packages/shared/src/engines/synth2-descriptors.test.ts` | Append-only key list + `filter.drive` contract test. | 3 |
| `packages/shared/src/project/accept-list.test.ts` | Explicit `filter.drive` accept/validate assertion. | 3 |
| `packages/client/src/engine/synth2/kernel/Voice.ts` | `driveSlot` + pass `drive` into `activeFilter.process`. | 4 |
| `packages/client/src/engine/synth2/kernel/Voice.test.ts` | Integration: muted-osc + res 1 + drive → sustained output. | 4 |
| `packages/client/src/components/Synth2Panel.vue` | The `Drive` knob in the filter row. | 5 |
| `packages/client/src/components/Synth2Panel.test.ts` | The filter section renders a `Drive` knob. | 5 |

**Task order / deps:** 1 → 2 → 3 → 4 → 5. (Task 3 is shared-only and independent of 1/2; 4 depends on 2+3; 5 depends on 3.)

---

### Task 1: `SvfCore` self-oscillation DSP

**Files:**
- Modify: `packages/client/src/engine/synth2/kernel/SvfCore.ts` (full internal rewrite of `tick`; public API `tick(input, cutoffHz, resonance, drive?)` + `reset()` unchanged in spirit).
- Test: `packages/client/src/engine/synth2/kernel/SvfCore.test.ts` (retarget one existing test; add new ones).

**Interfaces:**
- Consumes: nothing new.
- Produces: `SvfCore.tick(input: number, cutoffHz: number, resonance: number, drive?: number): void` — `drive` defaults to 0. `reset()` re-seeds the internal RNG. Outputs `low`/`band`/`high` as before. At `resonance > 0.9` the filter self-oscillates (bounded); at `resonance ≤ 0.9` with `drive = 0` it is bit-identical to today.

- [ ] **Step 1: Retarget the existing res-1.0 flush test (it now oscillates).**

In `SvfCore.test.ts`, the "flushes to exact zero after the signal goes silent" test drives `res = 1.0`, which now self-oscillates and never flushes. Retarget it to `0.9` (the highest non-oscillating resonance — still the worst case for the denormal flush). Apply both edits:

Replace:
```ts
    // Excite, then feed silence at max resonance (highest Q = longest ring =
    // slowest decay = worst case for reaching exact zero).
    for (let i = 0; i < 2000; i++) svf.tick(Math.sin((2 * Math.PI * 220 * i) / SR), 1000, 1.0);
```
with:
```ts
    // Excite, then feed silence at the highest NON-oscillating resonance (0.9 —
    // longest ring / slowest decay below the self-oscillation zone, worst case
    // for reaching exact zero). res>0.9 now self-oscillates by design.
    for (let i = 0; i < 2000; i++) svf.tick(Math.sin((2 * Math.PI * 220 * i) / SR), 1000, 0.9);
```
and replace:
```ts
      svf.tick(0, 1000, 1.0);
```
with:
```ts
      svf.tick(0, 1000, 0.9);
```

- [ ] **Step 2: Write the new failing tests.**

Append to `SvfCore.test.ts` (inside the file, after the existing `describe('SvfCore', …)` block or as a new `describe`). Add this `noiseBuf` helper near the top helpers and the tests:

```ts
function noiseBuf(n: number): Float32Array {
  const b = new Float32Array(n); let s = 22222;
  for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; b[i] = (s / 0x3fffffff) - 1; }
  return b;
}

// The ORIGINAL linear SvfCore math (pre-self-oscillation), recomputed here as an
// independent oracle to prove res<=0.9 + drive=0 is bit-unchanged.
function refLinearLow(input: Float32Array, cutoff: number, res: number): number[] {
  let ic1 = 0, ic2 = 0; const out: number[] = [];
  const fc = Math.min(Math.max(cutoff, 20), SR * 0.45);
  const g = Math.tan((Math.PI * fc) / SR);
  const k = 1 / (0.5 + res * 9.5);
  const a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2;
  for (let i = 0; i < input.length; i++) {
    const v3 = input[i] - ic2;
    const v1 = a1 * ic1 + a2 * v3;
    const v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2;
    if (ic1 < 1e-25 && ic1 > -1e-25) ic1 = 0;
    if (ic2 < 1e-25 && ic2 > -1e-25) ic2 = 0;
    out.push(v2);
  }
  return out;
}

describe('SvfCore self-oscillation (2026-06-20)', () => {
  it('res<=0.9 with drive 0 is bit-identical to the original linear SVF', () => {
    const x = noiseBuf(4000);
    for (const res of [0, 0.15, 0.5, 0.9]) {
      const ref = refLinearLow(x, 1200, res);
      const svf = new SvfCore(SR);
      for (let i = 0; i < x.length; i++) {
        svf.tick(x[i], 1200, res); // drive defaults 0
        expect(svf.low, `res ${res} sample ${i}`).toBe(ref[i]); // EXACT
      }
    }
  });

  it('self-oscillates at res=1 from silence: sustains and stays bounded', () => {
    const svf = new SvfCore(SR); svf.reset();
    let s = 0, c = 0, peak = 0;
    const N = SR; // 1s of pure silence
    for (let i = 0; i < N; i++) {
      svf.tick(0, 1000, 1.0);
      if (i > SR * 0.5) { s += svf.low * svf.low; c++; if (Math.abs(svf.low) > peak) peak = Math.abs(svf.low); }
    }
    const rms = Math.sqrt(s / c);
    expect(rms).toBeGreaterThan(0.01);   // didn't die
    expect(peak).toBeLessThan(10);        // didn't blow up
    expect(Number.isFinite(rms)).toBe(true);
  });

  it('does NOT self-oscillate at moderate resonance (rings then decays)', () => {
    const svf = new SvfCore(SR); svf.reset();
    for (let i = 0; i < 2000; i++) svf.tick(Math.sin((2 * Math.PI * 300 * i) / SR), 1000, 0.5);
    let maxAfter = 0;
    for (let i = 0; i < SR; i++) { svf.tick(0, 1000, 0.5); if (i > SR * 0.5 && Math.abs(svf.low) > maxAfter) maxAfter = Math.abs(svf.low); }
    expect(maxAfter).toBeLessThan(1e-6); // decayed to ~0
  });

  it('oscillation frequency tracks the cutoff (in tune, within 30 cents)', () => {
    for (const cutoff of [110, 262, 440]) {
      const svf = new SvfCore(SR); svf.reset();
      for (let i = 0; i < SR; i++) svf.tick(0, cutoff, 1.0); // settle 1s
      let prev = 0, crossings = 0; const M = SR; // measure 1s
      for (let i = 0; i < M; i++) { svf.tick(0, cutoff, 1.0); const y = svf.low; if (prev <= 0 && y > 0) crossings++; prev = y; }
      const measuredHz = crossings / (M / SR);
      const cents = 1200 * Math.log2(measuredHz / cutoff);
      expect(Math.abs(cents), `cutoff ${cutoff} → ${measuredHz}Hz`).toBeLessThan(30);
    }
  });

  it('starts oscillating from pure silence within ~200ms', () => {
    const svf = new SvfCore(SR); svf.reset();
    let firstAudible = -1;
    for (let i = 0; i < SR; i++) { svf.tick(0, 1000, 1.0); if (firstAudible < 0 && Math.abs(svf.low) > 0.05) firstAudible = i; }
    expect(firstAudible).toBeGreaterThanOrEqual(0);
    expect(firstAudible).toBeLessThan(SR * 0.2);
  });

  it('drive shapes the oscillation (more harmonic content) and stays bounded', () => {
    const measure = (drive: number) => {
      const svf = new SvfCore(SR); svf.reset();
      for (let i = 0; i < SR; i++) svf.tick(0, 1000, 1.0, drive); // settle
      let prev = 0, sumAbsDiff = 0, s = 0, peak = 0; const M = SR;
      for (let i = 0; i < M; i++) { svf.tick(0, 1000, 1.0, drive); const y = svf.low; sumAbsDiff += Math.abs(y - prev); prev = y; s += y * y; if (Math.abs(y) > peak) peak = Math.abs(y); }
      const rms = Math.sqrt(s / M) || 1e-12;
      return { hfPerRms: (sumAbsDiff / M) / rms, peak };
    };
    const lo = measure(0), hi = measure(1);
    expect(hi.hfPerRms).toBeGreaterThan(lo.hfPerRms); // saturated → relatively more HF
    expect(hi.peak).toBeLessThan(10);                  // bounded
    expect(lo.peak).toBeLessThan(10);
  });

  it('stays finite with NaN input / extreme finite cutoff at res=1, drive=1', () => {
    const svf = new SvfCore(SR); svf.reset();
    for (let i = 0; i < 2000; i++) {
      svf.tick(i % 7 === 0 ? NaN : 0, i % 3 ? 1e9 : -5, 1.0, 1);
      expect(Number.isFinite(svf.low)).toBe(true);
      expect(Number.isFinite(svf.band)).toBe(true);
      expect(Number.isFinite(svf.high)).toBe(true);
    }
  });
});
```

- [ ] **Step 3: Run the new tests to verify they fail.**

Run: `npm test -w @fiddle/client -- SvfCore`
Expected: the back-compat-lock test passes (no code change yet), but `self-oscillates…`, `tracks the cutoff…`, `starts oscillating…`, and `drive shapes…` FAIL (filter decays to silence at res=1 today; no `drive` effect). The retargeted flush test passes.

- [ ] **Step 4: Implement the DSP — replace `SvfCore.ts` in full.**

```ts
//
// Shared zero-delay-feedback state-variable filter core (spec §5.3, Andy
// Simper / Cytomic trapezoidal formulation). One state pair, three
// simultaneous outputs (low/band/high). Stable under per-sample cutoff
// modulation — the reason the engine abandons the biquad (§5.2). Pure DSP, no
// allocation after construction.
//
// Self-oscillation (spec 2026-06-20): resonance > 0.9 ramps the damping k below
// zero into a self-oscillating regime; a tanh feedback saturator on the band
// integrator state (also the `drive` character control) bounds the limit cycle,
// and a tiny noise floor — injected ONLY in that zone — seeds and sustains it
// from silence. resonance <= 0.9 with drive 0 is bit-identical to the original
// linear filter (Approach A).
//

const K09 = 1 / 9.05;        // k at resonance 0.9 (= 1/(0.5+0.9*9.5)) — ramp anchor
const K_MIN = -0.02;         // k at resonance 1.0 — slightly unstable ⇒ reliable osc
const SEED = 1e-4;           // oscillation-zone noise-floor amplitude (startup seed)
const DRIVE_RANGE = 4;       // drive 0..1 → saturator pre-gain D = 1..5
const RNG_SEED = 0x9e3779b9; // fixed xorshift32 seed ⇒ deterministic per note-on

export class SvfCore {
  /** Outputs, valid after the most recent tick(). */
  low = 0;
  band = 0;
  high = 0;

  private ic1eq = 0; // integrator 1 state (band)
  private ic2eq = 0; // integrator 2 state (low)
  private rng = RNG_SEED; // xorshift32 state for the oscillation-zone noise floor
  private readonly nyquistish: number;

  constructor(private readonly sampleRate: number) {
    // Keep tan(pi*fc/SR) finite: clamp cutoff below Nyquist.
    this.nyquistish = sampleRate * 0.45;
  }

  /** Note-on / voice-steal: clear integrator state, outputs, and re-seed the RNG. */
  reset(): void {
    this.ic1eq = 0;
    this.ic2eq = 0;
    this.rng = RNG_SEED;
    this.low = 0;
    this.band = 0;
    this.high = 0;
  }

  /** Advance one sample. cutoffHz is the final (post keytrack/env) cutoff;
   *  resonance 0..1 (>0.9 self-oscillates); drive 0..1 adds feedback saturation. */
  tick(input: number, cutoffHz: number, resonance: number, drive = 0): void {
    const inSafe = Number.isFinite(input) ? input : 0;
    const fc = cutoffHz < 20 ? 20 : cutoffHz > this.nyquistish ? this.nyquistish : cutoffHz;
    const g = Math.tan((Math.PI * fc) / this.sampleRate);

    // Resonance → damping k. res<=0.9 reproduces the original q=0.5+9.5r map
    // EXACTLY (Approach A); the top 10% ramps k from k(0.9) to a small negative
    // floor, continuous at the 0.9 join.
    const res = resonance < 0 ? 0 : resonance > 1 ? 1 : resonance;
    let k: number;
    let oscZone: number;
    if (res <= 0.9) {
      k = 1 / (0.5 + res * 9.5);
      oscZone = 0;
    } else {
      oscZone = (res - 0.9) / 0.1;          // 0..1 across the oscillation zone
      k = K09 + oscZone * (K_MIN - K09);    // continuous at 0.9; < 0 near the top
    }

    // Startup/sustain excitation: a tiny noise floor, ONLY in the oscillation
    // zone (so res<=0.9 is bit-unchanged). Seeds the oscillator from silence when
    // all oscillators are muted, and continuously re-excites it (analog thermal
    // noise). xorshift32 → bipolar ~[-1,1).
    let x = inSafe;
    if (oscZone > 0) {
      let s = this.rng;
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
      this.rng = s >>> 0;
      x += SEED * oscZone * ((this.rng / 0x80000000) - 1);
    }

    const a1 = 1 / (1 + g * (g + k));
    const a2 = g * a1;
    const a3 = g * a2;
    const v3 = x - this.ic2eq;
    const v1 = a1 * this.ic1eq + a2 * v3;
    const v2 = this.ic2eq + a2 * this.ic1eq + a3 * v3;
    this.ic1eq = 2 * v1 - this.ic1eq;
    this.ic2eq = 2 * v2 - this.ic2eq;

    // Feedback saturator: soft-clip the band integrator state to bound the limit
    // cycle and add `drive` grit. Blend B = 0 (res<=0.9 AND drive==0) ⇒ fully
    // bypassed ⇒ bit-linear. tanh(D*x)/D keeps small-signal gain ≈ 1 so `drive`
    // adds harmonics at large amplitude rather than boosting resonance.
    let blend = drive + oscZone;
    if (blend > 1) blend = 1;
    if (blend > 0) {
      const D = 1 + drive * DRIVE_RANGE;
      const sat = Math.tanh(D * this.ic1eq) / D;
      this.ic1eq += blend * (sat - this.ic1eq);
    }

    // I4 denormal sweep: V8 has no flush-to-zero; a silent input would otherwise
    // let the integrator state decay through the subnormal range (~100x slower).
    if (this.ic1eq < 1e-25 && this.ic1eq > -1e-25) this.ic1eq = 0;
    if (this.ic2eq < 1e-25 && this.ic2eq > -1e-25) this.ic2eq = 0;

    this.low = v2;
    this.band = v1;
    this.high = x - k * v1 - v2;
  }
}
```

- [ ] **Step 5: Run the SvfCore tests until green.**

Run: `npm test -w @fiddle/client -- SvfCore`
Expected: PASS. If the tuning test is off (measured Hz outside 30 cents) or the oscillation doesn't sustain/start, nudge the calibration constants and re-run: `K_MIN` more negative → faster/stronger oscillation; `SEED` larger → faster startup; `DRIVE_RANGE` larger → more drive effect. If the existing "stays finite and bounded sweeping cutoff at high resonance" (res 0.95) test trips its `< 20` bound, that's the saturator not biting enough at partial blend — verify it still holds (it should; the saturator contracts large states). Do NOT relax the back-compat-lock `toBe` exactness — if it fails, the res≤0.9 path was altered and must be restored.

- [ ] **Step 6: Commit.**

```bash
git add packages/client/src/engine/synth2/kernel/SvfCore.ts packages/client/src/engine/synth2/kernel/SvfCore.test.ts
git commit -m "feat(synth2): SvfCore self-oscillation + drive saturator

Reserve resonance>0.9 to ramp damping k below zero into self-oscillation;
a tanh feedback saturator (the drive control + a minimal limiter) bounds
the limit cycle, and an oscillation-zone-only noise floor seeds it from
silence. res<=0.9 with drive 0 stays bit-identical (locked by test).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Thread `drive` through the `FilterModule` seam

**Files:**
- Modify: `packages/client/src/engine/synth2/kernel/FilterModule.ts` (interface).
- Modify: `packages/client/src/engine/synth2/kernel/ClassicFilter.ts`.
- Modify: `packages/client/src/engine/synth2/kernel/MorphFilter.ts`.
- Test: `packages/client/src/engine/synth2/kernel/ClassicFilter.test.ts`, `…/MorphFilter.test.ts`.

**Interfaces:**
- Consumes: `SvfCore.tick(input, cutoffHz, resonance, drive)` from Task 1.
- Produces: `FilterModule.process(input, cutoffHz, resonance, morph, drive): number` — `drive` is the new 5th parameter (after `morph`). `ClassicFilter`/`MorphFilter` default `drive = 0` so existing 3- and 4-arg call sites keep compiling.

- [ ] **Step 1: Write the failing passthrough tests.**

Append to `ClassicFilter.test.ts` (inside `describe('ClassicFilter', …)`):
```ts
  it('passes drive through to the SVF (drive changes the self-osc output)', () => {
    const a = new ClassicFilter(SR); a.setType(0); a.reset();
    const b = new ClassicFilter(SR); b.setType(0); b.reset();
    let diff = 0;
    for (let i = 0; i < 4000; i++) {
      const ya = a.process(0, 1000, 1.0, 0, 0); // res 1, drive 0
      const yb = b.process(0, 1000, 1.0, 0, 1); // res 1, drive 1
      diff += Math.abs(ya - yb);
    }
    expect(diff).toBeGreaterThan(0);
  });
```
Append to `MorphFilter.test.ts` (inside `describe('MorphFilter', …)`):
```ts
  it('passes drive through to the SVF (drive changes the self-osc output)', () => {
    const a = new MorphFilter(SR); a.reset();
    const b = new MorphFilter(SR); b.reset();
    let diff = 0;
    for (let i = 0; i < 4000; i++) {
      const ya = a.process(0, 1000, 1.0, 0, 0); // morph 0 (low), drive 0
      const yb = b.process(0, 1000, 1.0, 0, 1); // morph 0 (low), drive 1
      diff += Math.abs(ya - yb);
    }
    expect(diff).toBeGreaterThan(0);
  });
```

- [ ] **Step 2: Run to verify they fail.**

Run: `npm test -w @fiddle/client -- ClassicFilter MorphFilter`
Expected: FAIL — `process` currently takes no `drive` arg, so the 5th argument is ignored and `diff === 0` (or a TS error once the interface changes). (Before the impl change, `diff === 0`.)

- [ ] **Step 3: Update the interface.**

In `FilterModule.ts`, replace the `process` signature and doc:
```ts
  /** One sample. cutoffHz is the final cutoff (keytrack + env already applied);
   *  resonance is 0..1 (>0.9 self-oscillates); morph is the 0..2 LP→BP→HP blend
   *  used by MorphFilter (ClassicFilter ignores it and uses its block-set type);
   *  drive is 0..1 feedback saturation. Returns the output. */
  process(input: number, cutoffHz: number, resonance: number, morph: number, drive: number): number;
```

- [ ] **Step 4: Thread `drive` in both implementations.**

In `ClassicFilter.ts`, replace `process`:
```ts
  process(input: number, cutoffHz: number, resonance: number, _morph = 0, drive = 0): number {
    this.svf.tick(input, cutoffHz, resonance, drive);
    return this.type === 0 ? this.svf.low : this.type === 1 ? this.svf.band : this.svf.high;
  }
```
In `MorphFilter.ts`, replace `process`:
```ts
  process(input: number, cutoffHz: number, resonance: number, morph: number, drive = 0): number {
    const m = morph < 0 ? 0 : morph > 2 ? 2 : morph;
    this.svf.tick(input, cutoffHz, resonance, drive);
    let a: number, b: number, frac: number;
    if (m <= 1) { a = this.svf.low; b = this.svf.band; frac = m; }       // LP → BP
    else        { a = this.svf.band; b = this.svf.high; frac = m - 1; }  // BP → HP
    const g = frac * (Math.PI / 2);
    return Math.cos(g) * a + Math.sin(g) * b;                            // equal-power
  }
```

- [ ] **Step 5: Run the filter tests until green.**

Run: `npm test -w @fiddle/client -- ClassicFilter MorphFilter`
Expected: PASS, including the existing "reset == fresh filter" tests (they run at res 0.5 / drive 0 → saturator bypassed → unchanged).

- [ ] **Step 6: Commit.**

```bash
git add packages/client/src/engine/synth2/kernel/FilterModule.ts packages/client/src/engine/synth2/kernel/ClassicFilter.ts packages/client/src/engine/synth2/kernel/MorphFilter.ts packages/client/src/engine/synth2/kernel/ClassicFilter.test.ts packages/client/src/engine/synth2/kernel/MorphFilter.test.ts
git commit -m "feat(synth2): thread filter drive through the FilterModule seam

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Append the `filter.drive` descriptor + params interface

**Files:**
- Modify: `packages/shared/src/engines/synth2-descriptors.ts` (append one row).
- Modify: `packages/shared/src/engines/synth2.ts` (`Synth2FilterParams`).
- Test: `packages/shared/src/engines/synth2-descriptors.test.ts`, `packages/shared/src/project/accept-list.test.ts`.

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: descriptor key `filter.drive` (min 0, max 1, default 0, linear, modulatable, modScale 1) ⇒ `DEFAULT_SYNTH2_PARAMS.filter.drive === 0`, a `0..1` Zod leaf, a writable accept-list path, and a member of `MOD_DESTS`. `Synth2FilterParams.drive: number`.

- [ ] **Step 1: Write the failing contract tests.**

In `synth2-descriptors.test.ts`, update the append-only key-list test (add `'filter.drive'` as the final entry):
```ts
      'filter.morph', 'filter.model',
      'filter.drive',
    ]);
```
Add a new `it` inside `describe('morph filter descriptor rows (I3d)', …)` (or a new describe — its `byKey` is in scope if added to that block):
```ts
  it('filter.drive is a continuous 0..1 modulatable saturation (auto mod dest), default 0', () => {
    expect(byKey['filter.drive']).toMatchObject({
      min: 0, max: 1, default: 0, taper: 'linear', modulatable: true, modScale: 1,
    });
    expect(byKey['filter.drive'].kind).toBeUndefined();
    expect(MOD_DESTS).toContain('filter.drive');
  });
```
In `accept-list.test.ts`, add inside `describe('synth2 accept-list (generated from descriptors)', …)`:
```ts
  it('accepts the synth2 filter.drive leaf and validates its 0..1 range (self-osc)', () => {
    expect(pathIsWritable('tracks.0.engines.synth2.filter.drive')).toBe(true);
    expect(validatePathAndValue('tracks.0.engines.synth2.filter.drive', 0.5)).toEqual({ ok: true });
    expect(validatePathAndValue('tracks.0.engines.synth2.filter.drive', 1.5).ok).toBe(false);
  });
```

- [ ] **Step 2: Run to verify failure.**

Run: `npm test -w @fiddle/shared -- synth2-descriptors accept-list`
Expected: FAIL — `filter.drive` is not in the table yet (key-list mismatch, `byKey['filter.drive']` undefined, path not writable). The table↔interface test in `synth2.test.ts` will also fail once the row exists without the interface field — that's fixed in Step 3.

- [ ] **Step 3: Append the descriptor row.**

In `synth2-descriptors.ts`, the array currently ends:
```ts
  { key: 'filter.morph', min: 0, max: 2, default: 0, taper: 'linear', modulatable: true,  modScale: 1 },
  { key: 'filter.model', min: 0, max: 1, default: 0, taper: 'linear', modulatable: false, modScale: 0, kind: 'enum', enumValues: ['classic', 'morph'] },
];
```
Insert the new row **after `filter.model`, before the closing `];`** (append-only):
```ts
  { key: 'filter.model', min: 0, max: 1, default: 0, taper: 'linear', modulatable: false, modScale: 0, kind: 'enum', enumValues: ['classic', 'morph'] },
  // --- filter self-oscillation (2026-06-20, append-only). filter.drive is the
  // opt-in feedback-saturation amount (0 = clean = today). Continuous + modulatable
  // (auto-joins MOD_DESTS) so an LFO/env can sweep the grit. The self-oscillation
  // itself lives at the top of filter.resonance (>0.9), needing no new param.
  { key: 'filter.drive', min: 0, max: 1, default: 0, taper: 'linear', modulatable: true,  modScale: 1 },
];
```

- [ ] **Step 4: Add the interface field.**

In `synth2.ts`, add `drive` to `Synth2FilterParams`:
```ts
export interface Synth2FilterParams {
  cutoff: number;     // Hz
  resonance: number;  // 0..1 (>0.9 self-oscillates)
  keyTrack: number;   // 0..1 — cutoff follows note pitch
  envAmount: number;  // bipolar octaves (±4): env2 → cutoff depth
  type: 'lp' | 'bp' | 'hp';
  morph: number;               // 0 LP → 1 BP → 2 HP (continuous MorphFilter blend)
  model: 'classic' | 'morph';  // which FilterModule the voice uses
  drive: number;               // 0..1 feedback saturation (self-osc character)
}
```

- [ ] **Step 5: Run the shared gate until green.**

Run: `npm test -w @fiddle/shared && npm run typecheck -w @fiddle/shared`
Expected: PASS — including `synth2.test.ts`'s table↔interface agreement (now that `drive` exists in both) and the auto-iterating accept-list test.

- [ ] **Step 6: Commit.**

```bash
git add packages/shared/src/engines/synth2-descriptors.ts packages/shared/src/engines/synth2.ts packages/shared/src/engines/synth2-descriptors.test.ts packages/shared/src/project/accept-list.test.ts
git commit -m "feat(synth2): append filter.drive descriptor + params field

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Wire `filter.drive` into the Voice

**Files:**
- Modify: `packages/client/src/engine/synth2/kernel/Voice.ts` (add `driveSlot`; pass into `process`).
- Test: `packages/client/src/engine/synth2/kernel/Voice.test.ts`.

**Interfaces:**
- Consumes: `slot('filter.drive')` (Task 3), `FilterModule.process(…, drive)` (Task 2).
- Produces: a Voice whose filter self-oscillates audibly when `filter.resonance` is at max and the osc levels are 0.

- [ ] **Step 1: Write the failing integration test.**

The exact ParamSlot-access pattern mirrors the existing morph/type tests in `Voice.test.ts` (which use `v.slots[idx].setBase(...)` and `PARAM_INDEX`). Append to `Voice.test.ts`:
```ts
  it('self-oscillates with oscillators muted when resonance is maxed (filter as a sine)', () => {
    const v = new Voice(SR, 1);
    // Mute all sound sources so the only possible output is the filter itself.
    for (const key of ['osc1.level', 'osc2.level', 'osc3.level', 'noise.level'] as const) {
      v.slots[PARAM_INDEX[key]].setBase(0);
    }
    v.slots[PARAM_INDEX['filter.resonance']].setBase(1); // into the oscillation zone
    v.setFilterModel(0); v.setFilterType(0);             // classic LP
    v.noteOn(220, 1, SR); // noteOn(freq, velocity, gateFrames)
    const out = new Float32Array(SR);
    v.renderAdd(out, 0, SR); // renderAdd(out, from, to) — render 1s
    let s = 0; for (let i = SR * 0.5; i < SR; i++) s += out[i] * out[i];
    const rms = Math.sqrt(s / (SR * 0.5));
    expect(rms).toBeGreaterThan(0.005); // the filter is singing despite muted oscs
  });
```
(Verified against the file: `Voice.test.ts` already imports `PARAM_INDEX` from `./params`; the real signatures are `renderAdd(out, from, to)` and `noteOn(freq, velocity, gateFrames)`; `v.slots[idx].setBase(value)` is the existing param-override pattern.)

- [ ] **Step 2: Run to verify it fails.**

Run: `npm test -w @fiddle/client -- Voice`
Expected: FAIL — the Voice doesn't pass `drive` and (more importantly) doesn't yet read a drive slot; but the dominant failure is that today's call passes only 4 args. With muted oscs and res 1, the filter currently decays → `rms ≈ 0`. (Even at res 1 self-oscillation now works in `SvfCore`, but the Voice must route the resonance value — it already does — so this test mostly proves the Voice path reaches the oscillating `SvfCore`. It should already partially work after Task 1/2; the new line below makes `drive` live.)

- [ ] **Step 3: Add the drive slot and pass it into the filter.**

In `Voice.ts`, add the slot alongside the other filter slots (after line 106, `this.envAmountSlot = slot('filter.envAmount');`):
```ts
    this.envAmountSlot = slot('filter.envAmount');
    this.driveSlot = slot('filter.drive');
```
Declare the field near the other filter slot fields (with `private readonly resSlot: ParamSlot;` etc.):
```ts
  private readonly driveSlot: ParamSlot;
```
Update the filter process call (currently `const filtered = this.activeFilter.process(mix, fc, this.resSlot.next(), this.morphSlot.next());`):
```ts
      const filtered = this.activeFilter.process(
        mix, fc, this.resSlot.next(), this.morphSlot.next(), this.driveSlot.next(),
      );
```

- [ ] **Step 4: Run the Voice tests until green.**

Run: `npm test -w @fiddle/client -- Voice`
Expected: PASS, including all existing Voice reset/route tests (they run at the default resonance 0.15 → oscZone 0 → no injection/saturation → unchanged).

- [ ] **Step 5: Commit.**

```bash
git add packages/client/src/engine/synth2/kernel/Voice.ts packages/client/src/engine/synth2/kernel/Voice.test.ts
git commit -m "feat(synth2): route filter.drive through the Voice into the filter

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Add the `Drive` knob to Synth2Panel

**Files:**
- Modify: `packages/client/src/components/Synth2Panel.vue` (filter knob-row).
- Test: `packages/client/src/components/Synth2Panel.test.ts`.

**Interfaces:**
- Consumes: `DEFAULTS.filter.drive` (= 0, from Task 3) and `params.filter.drive`.
- Produces: a `Drive` knob in the filter section bound to `params.filter.drive`.

- [ ] **Step 1: Write the failing component test.**

Append to `describe('Synth2Panel filter section', …)` in `Synth2Panel.test.ts`:
```ts
  it('renders a Drive knob in the filter column', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    const modelSelector = el.querySelector('.filter-model-selector')!;
    const filterGroup = modelSelector.closest('.module-group')!;
    const labels = Array.from(filterGroup.querySelectorAll<HTMLLabelElement>('.knob-label'))
      .map((n) => n.textContent?.trim());
    expect(labels).toContain('Drive');
  });
```

- [ ] **Step 2: Run to verify it fails.**

Run: `npm test -w @fiddle/client -- Synth2Panel`
Expected: FAIL — no `Drive` knob-label in the filter group yet.

- [ ] **Step 3: Add the knob.**

In `Synth2Panel.vue`, the filter knob-row currently holds Cutoff / Res / KeyTrk / EnvAmt. Add the Drive knob immediately after the EnvAmt knob (the line with `label="EnvAmt"`), inside the same `<div class="knob-row">`:
```html
          <Knob label="Drive" :min="0" :max="1" :step="0.01" format="percent" :defaultValue="DEFAULTS.filter.drive" v-model="params.filter.drive" :syncPath="ks.pathFor(['filter', 'drive'])" @gesture-end="ks.end(['filter', 'drive'])" />
```

- [ ] **Step 4: Run the panel tests until green.**

Run: `npm test -w @fiddle/client -- Synth2Panel`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add packages/client/src/components/Synth2Panel.vue packages/client/src/components/Synth2Panel.test.ts
git commit -m "feat(synth2): add filter Drive knob to Synth2Panel

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Verification (end-to-end)

- [ ] **Full gate (must be green before merge):**

```bash
npm run typecheck && npm test && npm run build
```
Confirm the build emits `packages/client/public/worklets/synth2-processor.js`.

- [ ] **Allocation discipline:** spot-check `SvfCore.tick` and `Voice` render — no `new`/array growth added in the hot path (only scalar state + constants). The soak/fuzz suites (`soak.test.ts`, `fuzz.test.ts`) should stay green.

- [ ] **Browser (Playwright MCP, then CLOSE the session):**
  1. `npm run dev` (reuse the user's server if already running); open/create a session; add a synth2 track.
  2. Filter model **CLASSIC**, type **LP**. Pull osc1/osc2/osc3 **Level** and **NOISE level** to 0; set **KeyTrk = 100%**, **Cutoff ≈ 262 Hz**, **Res → max**.
  3. Play notes → the filter sings a sustained sine that tracks pitch; sweep **Cutoff** → pitch follows. Confirm it is roughly in tune (user's ear is the final judge).
  4. Raise **Drive** → the tone gets grittier/saturated with **no volume blow-up**.
  5. Set **Res back to ~mid** → normal filtering returns (no oscillation).
  6. Confirm a **clean console** (only the pre-existing favicon 404 is acceptable).
  7. **Close the browser/session** (AGENTS.md cleanup rule).

- [ ] **Keep the branch after verify** — the user browser-verifies before merge; do not auto-merge.

## Self-review notes (author)

- **Spec coverage:** §5.1 → Task 1 (k map + back-compat lock); §5.2 → Task 1 (saturator) + Task 2 (drive seam); §5.3 → Task 1 (gated noise injection + startup test); §5.4 → Task 1 (tuning test); §6 files/back-compat → Tasks 2–5; §7 tests → every task's test block + Verification (browser). No spec section left unimplemented.
- **Back-compat invariant** is enforced by an independent-oracle `toBe` test (Task 1, Step 2), not just by inspection.
- **Calibration constants** (`K_MIN`, `SEED`, `DRIVE_RANGE`) are concrete starting values locked by behavior tests; Step 5 of Task 1 documents how to nudge them — the same calibrate-by-test discipline used for the noise-color gains.
