# synth2 Noise-Color Morph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace synth2's lowpass "color" control with a continuous morph across five textbook noise colors (brown→pink→white→blue→violet), white at center, loudness-matched.

**Architecture:** All DSP lives inside the existing `Noise.next(color)` kernel method (signature unchanged, so `Voice.ts` is untouched). Each color anchor derives from one white draw plus a Paul Kellet pink filter — integration drops the spectral slope 6 dB/oct (brown), differentiation raises it 6 dB/oct (blue/violet) — then the two anchors bracketing the knob are crossfaded with baked per-anchor loudness gains. The `noise.color` descriptor default flips 1 → 0.5 (white); old patch values are reinterpreted in place (no migration).

**Tech Stack:** TypeScript, Vitest, Vue 3, Web Audio AudioWorklet. npm-workspace monorepo (`@fiddle/shared`, `@fiddle/client`).

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-20-synth2-noise-color-morph-design.md`.
- **Append-only descriptors:** `SYNTH2_DESCRIPTORS` row ORDER is the wire/param-block layout — never insert/reorder. Changing a row's `default` VALUE is allowed; changing its position is not.
- **Kernel ABI:** `Noise` stays per-voice, allocation-free (no arrays/`new` in `next()`), and deterministic from its seed.
- **Public API frozen:** keep `new Noise(seed)` and `next(color: number): number` exactly — `Voice.ts` must not change.
- **Color axis (verbatim):** `brown@0.0 · pink@0.25 · white@0.5 · blue@0.75 · violet@1.0`; slopes `-6 / -3 / 0 / +3 / +6` dB/oct.
- **Loudness gains (measured, locked by test):** `PINK_GAIN = 0.32821`, `BROWN_GAIN = 10.05331`, `BLUE_GAIN = 1.68021`, `VIOLET_GAIN = 0.70775`.
- **Branch:** work on `feat/synth2-noise-color` (already created off `main`). Never commit on `main`. Commit only named files (no `git add -A`). End every commit message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Gate (per task + final):** `npm run typecheck && npm test && npm run build` from the repo root; build must still emit `packages/client/public/worklets/synth2-processor.js`.

## File Structure

- `packages/shared/src/engines/synth2-descriptors.ts` — flip `noise.color` default `1 → 0.5`, rewrite its comment (Task 1).
- `packages/shared/src/engines/synth2-descriptors.test.ts` — add a `noise.color` contract assertion (Task 1).
- `packages/client/src/engine/synth2/kernel/Noise.ts` — rewrite internals; same public API (Task 2).
- `packages/client/src/engine/synth2/kernel/Noise.test.ts` — replace tests with determinism/white-identity/slope/loudness/clamp coverage (Task 2).

`Voice.ts`, the mod matrix, accept-list/sync, `normalizeProject`, and `Synth2Panel.vue` need **no code change** — the panel's Color-knob default flows from the descriptor table automatically. They are exercised in the Verification section.

---

### Task 1: Flip `noise.color` to a white-centered morph default

**Files:**
- Modify: `packages/shared/src/engines/synth2-descriptors.ts:86-88` (the `noise.color` row + its comment)
- Test: `packages/shared/src/engines/synth2-descriptors.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `SYNTH2_DESCRIPTORS` row `noise.color` with `default: 0.5` (still `min 0`, `max 1`, `taper 'linear'`, `modulatable true`, `modScale 1`, continuous). `DEFAULT_SYNTH2_PARAMS.noise.color` becomes `0.5` (derived). No new exports.

- [ ] **Step 1: Write the failing test**

Add this `it` block inside the existing `describe('SYNTH2_DESCRIPTORS', ...)` in `packages/shared/src/engines/synth2-descriptors.test.ts` (e.g. right after the `'every default lies within [min, max]'` test):

```ts
  it('noise.color is a continuous 0..1 color morph defaulting to white (0.5)', () => {
    // White lives at the center now (was the old lowpass-open default of 1).
    const d = SYNTH2_DESCRIPTORS.find(x => x.key === 'noise.color')!;
    expect(d.min).toBe(0);
    expect(d.max).toBe(1);
    expect(d.default).toBe(0.5);
    expect(d.taper).toBe('linear');
    expect(d.modulatable).toBe(true);
    expect(d.modScale).toBe(1);
    expect(d.kind).toBeUndefined(); // continuous, still a mod destination
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @fiddle/shared -- synth2-descriptors`
Expected: FAIL — `expected 1 to be 0.5` on the `noise.color` default.

- [ ] **Step 3: Make the minimal change**

In `packages/shared/src/engines/synth2-descriptors.ts`, replace the noise comment + `noise.color` row (currently lines 86–88):

```ts
  // noise — 4th mixer channel. color morphs five textbook noise colors, white at
  // center (spec 2026-06-20): 0 brown(-6 dB/oct) · 0.25 pink(-3) · 0.5 white(0) ·
  // 0.75 blue(+3) · 1 violet(+6). Loudness-matched so the knob is purely tonal.
  { key: 'noise.level',     min: 0,    max: 1,    default: 0,   taper: 'linear',     modulatable: true, modScale: 1 },
  { key: 'noise.color',     min: 0,    max: 1,    default: 0.5, taper: 'linear',     modulatable: true, modScale: 1 },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w @fiddle/shared -- synth2-descriptors`
Expected: PASS (whole file green, including the existing `default within [min,max]` test).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/engines/synth2-descriptors.ts packages/shared/src/engines/synth2-descriptors.test.ts
git commit -m "$(cat <<'EOF'
feat(synth2): default noise.color to white-centered morph (0.5)

Reinterpret the 0..1 noise.color field as a color-morph position with white
at center (was lowpass-open default 1). Append-only order unchanged.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Rewrite `Noise` as a five-color morph

**Files:**
- Modify: `packages/client/src/engine/synth2/kernel/Noise.ts` (full internal rewrite; same public API)
- Test: `packages/client/src/engine/synth2/kernel/Noise.test.ts` (full replace)

**Interfaces:**
- Consumes: nothing (self-contained kernel module).
- Produces: unchanged public surface — `class Noise { constructor(seed: number); next(color: number): number }`. `next(color)` now returns the color-morphed sample; `next(0.5)` equals the raw xorshift32 white sample bit-for-bit. `Voice.ts`'s call `this.noise.next(this.noiseColor.next())` is unaffected.

- [ ] **Step 1: Write the failing tests (replace the whole test file)**

Replace the entire contents of `packages/client/src/engine/synth2/kernel/Noise.test.ts` with:

```ts
import { describe, it, expect } from 'vitest';
import { Noise } from './Noise';

// The exact xorshift32 white stream Noise draws from — lets us assert the white
// anchor (color 0.5) is reproduced bit-for-bit.
function whiteStream(seed: number): () => number {
  let state = (seed | 0) || 0x9e3779b9;
  return () => {
    let x = state;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    state = x >>> 0;
    return (state / 0xffffffff) * 2 - 1;
  };
}

// Root-mean-square energy of `n` samples at a fixed color.
function rmsOf(noise: Noise, color: number, n = 100_000): number {
  let sumsq = 0;
  for (let i = 0; i < n; i++) { const v = noise.next(color); sumsq += v * v; }
  return Math.sqrt(sumsq / n);
}

// Mean absolute sample-to-sample difference — a cheap high-frequency-energy proxy.
function hfOf(noise: Noise, color: number, n = 100_000): number {
  let prev = 0, acc = 0;
  for (let i = 0; i < n; i++) { const v = noise.next(color); acc += Math.abs(v - prev); prev = v; }
  return acc / n;
}

describe('Noise', () => {
  it('is deterministic for a given seed and color', () => {
    const a = new Noise(12345), b = new Noise(12345);
    for (let i = 0; i < 100; i++) expect(a.next(0.7)).toBe(b.next(0.7));
  });

  it('different seeds diverge', () => {
    const a = new Noise(1), b = new Noise(2);
    let same = 0;
    for (let i = 0; i < 100; i++) if (a.next(0.5) === b.next(0.5)) same++;
    expect(same).toBeLessThan(5);
  });

  it('color 0.5 is white: reproduces the raw xorshift stream bit-for-bit', () => {
    const n = new Noise(2024);
    const w = whiteStream(2024);
    for (let i = 0; i < 1000; i++) expect(n.next(0.5)).toBe(w());
  });

  it('white (0.5) stays within [-1, 1] and is roughly zero-mean', () => {
    const n = new Noise(99);
    let sum = 0, max = 0;
    for (let i = 0; i < 10000; i++) { const v = n.next(0.5); sum += v; max = Math.max(max, Math.abs(v)); }
    expect(max).toBeLessThanOrEqual(1);
    expect(Math.abs(sum / 10000)).toBeLessThan(0.05);
  });

  it('spectral slope rises monotonically: brown < pink < white < blue < violet', () => {
    // High-frequency energy must increase across the color axis. Fresh instance
    // per anchor so warm-up is identical.
    const hf = [0, 0.25, 0.5, 0.75, 1].map(c => hfOf(new Noise(7), c));
    for (let i = 1; i < hf.length; i++) expect(hf[i]).toBeGreaterThan(hf[i - 1]);
  });

  it('all anchors are loudness-matched to white (RMS within 15%)', () => {
    // This is the calibration oracle for PINK/BROWN/BLUE/VIOLET_GAIN.
    const whiteRms = rmsOf(new Noise(11), 0.5);
    for (const c of [0, 0.25, 0.5, 0.75, 1]) {
      const r = rmsOf(new Noise(11), c);
      expect(Math.abs(r / whiteRms - 1), `color ${c}`).toBeLessThan(0.15);
    }
  });

  it('morphs continuously: HF is non-decreasing across a fine color sweep', () => {
    // The symmetric crossfade is C0-continuous, so brightness must rise smoothly
    // with no dip at the anchor joins (0.25 / 0.5 / 0.75). Small negative tolerance
    // absorbs sampling noise.
    const grid = Array.from({ length: 11 }, (_, i) => i / 10); // 0, 0.1, … 1.0
    const hf = grid.map(c => hfOf(new Noise(7), c));
    for (let i = 1; i < hf.length; i++) {
      expect(hf[i] - hf[i - 1], `join ${grid[i - 1]}→${grid[i]}`).toBeGreaterThan(-0.01);
    }
  });

  it('clamps out-of-range and non-finite color (never emits NaN)', () => {
    const n = new Noise(5);
    for (let i = 0; i < 100; i++) {
      expect(Number.isFinite(n.next(-1))).toBe(true);
      expect(Number.isFinite(n.next(2))).toBe(true);
      expect(Number.isFinite(n.next(NaN))).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @fiddle/client -- Noise.test`
Expected: FAIL — the current lowpass `Noise` fails `color 0.5 is white …` (0.5 lowpasses, not white) and `spectral slope rises monotonically …`.

- [ ] **Step 3: Rewrite the implementation**

Replace the entire contents of `packages/client/src/engine/synth2/kernel/Noise.ts` with:

```ts
// Per-voice colored-noise source (spec 2026-06-20). A white xorshift32 draw is
// morphed across five textbook noise colors by spectral slope; `color` 0..1 picks
// the position with white at center:
//   0.0 brown(-6 dB/oct) · 0.25 pink(-3) · 0.5 white(0) · 0.75 blue(+3) · 1.0 violet(+6)
// Every anchor derives from the one white draw plus a Paul Kellet pink filter:
// integration lowers the slope 6 dB/oct (brown), differentiation raises it 6 dB/oct
// (blue, violet). Per-anchor gains match each color's RMS to white so the knob is
// purely tonal. Pure, allocation-free, deterministic from the seed (kernel ABI §6.7).

// White-RMS / raw-anchor-RMS, measured over a long white run. Locked by the
// 'all anchors are loudness-matched to white' test in Noise.test.ts.
const PINK_GAIN = 0.32821;
const BROWN_GAIN = 10.05331;
const BLUE_GAIN = 1.68021;
const VIOLET_GAIN = 0.70775;

export class Noise {
  private state: number;
  // Paul Kellet refined pink-filter accumulators.
  private b0 = 0;
  private b1 = 0;
  private b2 = 0;
  private b3 = 0;
  private b4 = 0;
  private b5 = 0;
  private b6 = 0;
  // brown leaky-integrator memory.
  private brownState = 0;
  // previous gain-normalized pink / white, for the blue / violet first differences.
  private pinkPrev = 0;
  private whitePrev = 0;

  constructor(seed: number) {
    // Avoid the zero fixed-point of xorshift; keep it a 32-bit uint.
    this.state = (seed | 0) || 0x9e3779b9;
  }

  /**
   * One colored sample. `color` 0..1 morphs brown→pink→white→blue→violet (white at
   * 0.5). Output RMS ≈ white at every position; transient peaks may exceed ±1 for
   * some colors (we match loudness, not peak — downstream level + filter absorb it).
   */
  next(color: number): number {
    // White draw — generator unchanged from the original implementation.
    let x = this.state;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.state = x >>> 0;
    const white = (this.state / 0xffffffff) * 2 - 1; // [-1, 1)

    // pink — Paul Kellet refined filter (-3 dB/oct).
    this.b0 = 0.99886 * this.b0 + white * 0.0555179;
    this.b1 = 0.99332 * this.b1 + white * 0.0750759;
    this.b2 = 0.96900 * this.b2 + white * 0.1538520;
    this.b3 = 0.86650 * this.b3 + white * 0.3104856;
    this.b4 = 0.55000 * this.b4 + white * 0.5329522;
    this.b5 = -0.7616 * this.b5 - white * 0.0168980;
    const pinkRaw = this.b0 + this.b1 + this.b2 + this.b3 + this.b4 + this.b5 + this.b6 + white * 0.5362;
    this.b6 = white * 0.115926;
    const pink = pinkRaw * PINK_GAIN;

    // brown — leaky integrator (-6 dB/oct), bounded so DC can't run away.
    this.brownState = (this.brownState + 0.02 * white) / 1.02;
    const brown = this.brownState * BROWN_GAIN;

    // blue / violet — first differences (+6 dB/oct each) of normalized pink / white.
    const blue = (pink - this.pinkPrev) * BLUE_GAIN;
    const violet = (white - this.whitePrev) * VIOLET_GAIN;
    this.pinkPrev = pink;
    this.whitePrev = white;

    // Crossfade the two anchors bracketing `color` on the 5-point axis
    // (brown@0, pink@0.25, white@0.5, blue@0.75, violet@1). The symmetric
    // (1-t)·A + t·B form is bit-exact at the joins, so color 0.5 returns white.
    // Non-finite color → white (defensive; ParamSlot already pre-clamps).
    const c = Number.isFinite(color) ? (color < 0 ? 0 : color > 1 ? 1 : color) : 0.5;
    if (c <= 0.25) { const t = c / 0.25;          return (1 - t) * brown + t * pink; }
    if (c <= 0.5)  { const t = (c - 0.25) / 0.25; return (1 - t) * pink  + t * white; }
    if (c <= 0.75) { const t = (c - 0.5) / 0.25;  return (1 - t) * white + t * blue; }
    const t = (c - 0.75) / 0.25;                  return (1 - t) * blue  + t * violet;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w @fiddle/client -- Noise.test`
Expected: PASS — all eight tests green.

- [ ] **Step 5: Run the full gate**

Run: `npm run typecheck && npm test && npm run build`
Expected: PASS across `@fiddle/shared`, `@fiddle/client`, `@fiddle/server`; build emits `packages/client/public/worklets/synth2-processor.js`. In particular `Synth2Kernel.test.ts`'s "noise contributes broadband energy when `noise.level > 0`" stays green (white/brown are still broadband and loudness-matched).

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/engine/synth2/kernel/Noise.ts packages/client/src/engine/synth2/kernel/Noise.test.ts
git commit -m "$(cat <<'EOF'
feat(synth2): morph noise across five textbook colors

Replace the lowpass color control with a brown→pink→white→blue→violet morph
(white at 0.5). Anchors derive from one white draw + a Kellet pink filter via
integration/differentiation; loudness-matched crossfade. Public Noise API and
Voice wiring unchanged.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Verification (end-to-end)

- **Gate (must be green before merge):** `npm run typecheck && npm test && npm run build` from the repo root; build still emits `worklets/synth2-processor.js`.
- **Zero-alloc invariant:** spot-check that `Noise.next()` only touches scalar fields — no arrays, no `new`, no closures created per sample. (Soak test is separate; don't regress it.)
- **No-change confirmation:** `git diff` must show NO edits to `Voice.ts`, the accept-list, `normalizeProject`, or `Synth2Panel.vue` logic — the morph is contained to `Noise.ts` + the one descriptor default.
- **Browser (Playwright MCP, then close the session) — MANDATORY before reporting done:**
  1. `npm run dev` (reuse the running dev server if one exists; if you start one, stop only the one you started).
  2. Open/create a session; add a synth2 track; open the Synth2 panel.
  3. Raise **Noise Level**; with osc levels low, **sweep the Color knob** full range and confirm the audible morph: dark/rumbly (brown, far left) → neutral hiss (white, center) → bright/thin (violet, far right), with **no perceived loudness jump** across the sweep.
  4. Confirm the Color knob's default sits at center (white).
  5. Confirm a **clean console** (no errors/warnings) and report observations.
  6. **Close the browser/session** (AGENTS.md cleanup rule).
- Keep the branch after verify — the user browser-verifies before merge. Do NOT auto-merge or push.

## Out of scope (YAGNI)

- Noise spectrum/waveform preview in the panel (a random signal has no meaningful time-domain trace like the osc/LFO `WavePreview`).
- A color-name readout (brown/pink/white/blue/violet) under the knob.
- The rejected alternate DSP topologies (single tilt filter; discrete stepped colors).
- Migration/versioning of old `noise.color` values (reinterpret-in-place was chosen).
