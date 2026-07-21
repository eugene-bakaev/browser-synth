# clap2 Voicing Re-voice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-voice the clap2 worklet engine into a convincing TR-909 drum-machine clap by fixing the uniform burst train, sharpening the attack, broadening the spectrum, re-voicing the room tail, and adding per-note variation — without rebuilding the engine.

**Architecture:** All DSP changes live in the pure `Clap2Kernel` (unit-testable, no AudioContext). The kernel gains a seedable, free-running scatter PRNG (per-session entropy in the worklet, fixed default for tests). The even `j*spread` equal-amplitude train becomes a non-uniform, amplitude-decaying, per-note-jittered pattern; the Chamberlin SVF gains an HF attack-injection path; the room gain floor is dropped. Defaults and exact constants are ear-tuned in a final audio-lab loop, then the audit checks are recalibrated.

**Tech Stack:** TypeScript, Web Audio AudioWorklet, Vitest, the in-repo `@fiddle/audio-lab` offline renderer.

## Global Constraints

- Target sound: **TR-909 drum-machine clap** — tight burst of distinct decaying slaps into a short bright final slap, not reverb, not a dry single hand-clap.
- Descriptor `CLAP2_DESCRIPTORS` is **APPEND-ONLY**: changing a `default` and *widening* a `min`/`max` is safe; **narrowing a range is forbidden** (breaks already-saved sessions). This plan changes only defaults; it appends **no** knobs (the "append 1–2 if essential" option is deferred unless ear-tuning proves a lever essential — out of scope here).
- Scatter + noise PRNGs must **free-run** across note-ons (never re-seeded on trigger) and carry **per-session entropy** in production, but the kernel constructor's **fixed default seed** keeps unit tests and the audit reproducible. Mirror the synth2 pattern (`Synth2Kernel.ts` → per-session `(Math.random()*0x1_0000_0000)>>>0`; `Noise`/`Lfo` free-run).
- The worklet is **prebuilt, no HMR**: browser verification needs a worklet rebuild + a full page reload, confirming the served `public/worklets/clap2-processor.js` reflects the change.
- Local testing uses `npm run dev:obs` (LOCAL Docker DB) — **never** `npm run dev` (prod Supabase, data-loss risk).
- Branch: `feat/clap2-voicing` (already created off `main`). Never commit to `main`.
- Every commit ends with the trailer:
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01WVnY6qN9VAPu6AHGBHnNfP
  ```
- **Objective targets** the ear-loop drives to (proxies for "convincing 909 clap"; not a substitute for the user's final ear-approval):
  - onset detector resolves **≥2 distinct slaps** at default params (today: always 1);
  - consecutive per-note renders **differ**; same seed **reproduces**;
  - slap peak envelope **decreases** across the train;
  - attack/onset spectral centroid higher than the body; spectrum broader than the current narrow peak;
  - at `mix=0`, room-tail energy ≈ 0; tail decays shorter than the current default;
  - **no CLIPPING** on any leg (health check green); all existing directional audit checks stay green.

---

## File Structure

- `packages/client/src/engine/clap2/kernel/Clap2Kernel.ts` — all DSP changes (seed, scatter PRNG, non-uniform pattern, attack, HF spectrum path, room/mix-floor). One file, one responsibility (the clap DSP). Tasks 1–4.
- `packages/client/src/engine/clap2/kernel/Clap2Kernel.test.ts` — unit tests for every mechanism. Tasks 1–4.
- `packages/client/src/engine/clap2/worklet-entry.ts` — pass per-session entropy into the kernel constructor. Task 1.
- `packages/shared/src/engines/clap2.ts` — descriptor `default` changes (ear-tuned). Task 5.
- `packages/audio-lab/src/audit/checks/clap2.checks.ts` — recalibrate directional checks, add an onset-separation check, fix stale inline notes. Task 6.
- `docs/BACKLOG.md` — update/close the F8 voicing item. Task 6.

**Not touched (verify, don't edit):** `packages/audio-lab/src/render/engine.ts` — its `clap2.create: (sr) => new Clap2Kernel(sr)` calls the constructor with no seed, so the **fixed default seed** keeps every audit render reproducible with zero render-path change. `packages/shared/src/engines/clap2.ts` param **ranges** (only `default`s change). No schema/accept-list/panel/factory changes (no knobs appended).

---

## Task 1: Seedable, free-running kernel + per-session entropy

**Files:**
- Modify: `packages/client/src/engine/clap2/kernel/Clap2Kernel.ts`
- Modify: `packages/client/src/engine/clap2/worklet-entry.ts:32`
- Test: `packages/client/src/engine/clap2/kernel/Clap2Kernel.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `new Clap2Kernel(sampleRate: number, seed?: number)` — optional second arg, default `0x6d2b79f5` (keeps today's noise stream byte-identical when defaulted). Task 2 adds a second PRNG stream off the same seed.

- [ ] **Step 1: Write the failing tests**

Add to `packages/client/src/engine/clap2/kernel/Clap2Kernel.test.ts` (inside the top-level `describe('Clap2Kernel', …)` block, after the existing tests). Note the new helper takes a seed:

```ts
  function renderHitSeeded(seed: number, seconds: number): Float32Array {
    const kernel = new Clap2Kernel(SR, seed);
    kernel.applyParams(defaultParamBlock());
    kernel.noteOn(0, 0, 0, 1);
    return renderBlocks(kernel, 0, Math.ceil((SR * seconds) / BLOCK));
  }

  it('is reproducible for a given seed', () => {
    const a = renderHitSeeded(12345, 0.2);
    const b = renderHitSeeded(12345, 0.2);
    expect(rmsDiff(a, b, 0, a.length)).toBe(0); // identical stream
  });

  it('different seeds produce different renders (per-session entropy is real)', () => {
    const a = renderHitSeeded(111, 0.2);
    const b = renderHitSeeded(222, 0.2);
    expect(rmsDiff(a, b, 0, a.length)).toBeGreaterThan(1e-3);
  });

  it('the default seed is stable (audit/render reproducibility)', () => {
    const a = renderHit({}, 0.2);
    const b = renderHit({}, 0.2);
    expect(rmsDiff(a, b, 0, a.length)).toBe(0);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @fiddle/client -- Clap2Kernel`
Expected: FAIL — `new Clap2Kernel(SR, 111)` currently ignores the second arg, so seeds 111 and 222 render identically (`different seeds` fails; `TS2554` may also surface if strict-arity is on — the constructor takes one param today).

- [ ] **Step 3: Make the noise seed a constructor parameter**

In `packages/client/src/engine/clap2/kernel/Clap2Kernel.ts`, change the rng field and constructor. Replace:

```ts
  // Deterministic xorshift32 noise (seeded so tests are reproducible). Never 0.
  private rng = 0x6d2b79f5;

  constructor(private readonly sampleRate: number) {
    this.events = Array.from({ length: MAX_EVENTS }, () => ({ frame: 0, velocity: 1 }));
  }
```

with:

```ts
  // Deterministic xorshift32 noise — free-runs across note-ons (never re-seeded on
  // trigger) so consecutive hits differ; seeded from the constructor so the worklet
  // can inject per-session entropy while tests/audit stay reproducible on the default.
  private rng: number;

  constructor(private readonly sampleRate: number, seed = 0x6d2b79f5) {
    this.rng = (seed >>> 0) || 0x6d2b79f5; // unsign; avoid the xorshift zero fixed-point
    this.events = Array.from({ length: MAX_EVENTS }, () => ({ frame: 0, velocity: 1 }));
  }
```

- [ ] **Step 4: Inject per-session entropy in the worklet**

In `packages/client/src/engine/clap2/worklet-entry.ts`, change line 32. Replace:

```ts
  private readonly kernel = new Clap2Kernel(sampleRate);
```

with:

```ts
  // Per-session entropy so the free-running noise (and Task-2 scatter) differ across
  // sessions/reloads; the kernel's default seed keeps offline tests/audit reproducible.
  private readonly kernel = new Clap2Kernel(sampleRate, (Math.random() * 0x1_0000_0000) >>> 0);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w @fiddle/client -- Clap2Kernel`
Expected: PASS — all three new tests green, all pre-existing Clap2Kernel tests still green.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck -w @fiddle/client`
Expected: clean (the worklet constructor call now matches the 2-arg signature).

- [ ] **Step 7: Commit**

```bash
git add packages/client/src/engine/clap2/kernel/Clap2Kernel.ts \
        packages/client/src/engine/clap2/kernel/Clap2Kernel.test.ts \
        packages/client/src/engine/clap2/worklet-entry.ts
git commit -F - <<'EOF'
feat(clap2): seedable kernel + per-session entropy (free-running noise)

Constructor gains an optional seed (default 0x6d2b79f5, byte-identical to
today's noise); the worklet injects per-session entropy so clap texture
differs across sessions while offline tests/audit stay reproducible on the
default. The noise PRNG still free-runs across note-ons.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WVnY6qN9VAPu6AHGBHnNfP
EOF
```

---

## Task 2: Non-uniform, amplitude-decaying, per-note-jittered slap pattern + sharper attack

**Files:**
- Modify: `packages/client/src/engine/clap2/kernel/Clap2Kernel.ts`
- Test: `packages/client/src/engine/clap2/kernel/Clap2Kernel.test.ts`

**Interfaces:**
- Consumes: the constructor `seed` from Task 1.
- Produces: per-trigger pattern state `slapOffset: Float32Array(5)`, `slapAmp: Float32Array(5)`, `slapCount: number` (internal); a second free-running PRNG `scatterRng` seeded from the constructor seed. No public API change.

This replaces the even `j*spread`, unit-amplitude, 0.5 ms-attack train with a designed non-uniform pattern (increasing gaps, decreasing amplitude), a small per-note random jitter drawn at trigger time (so the pattern is fixed within a hit but varies hit-to-hit), and a sharper ~0.15 ms attack — so the slaps separate instead of reading as one blob. Constants here are ear-tuned starting points (Task 5 refines them).

- [ ] **Step 1: Write the failing tests**

Add to `Clap2Kernel.test.ts` inside `describe('Clap2Kernel', …)`. Also add this peak-envelope helper near the other helpers at the top of the file:

```ts
function slapPeaks(buf: Float32Array, onsetsSec: number[], winSec: number): number[] {
  return onsetsSec.map((sec) => {
    const from = Math.floor(sec * SR), to = from + Math.floor(winSec * SR);
    let p = 0;
    for (let i = from; i < Math.min(to, buf.length); i++) p = Math.max(p, Math.abs(buf[i]));
    return p;
  });
}
```

Tests:

```ts
  it('slaps separate: energy dips between consecutive slaps (default params)', () => {
    // Render a pure-burst clap (room off) and scan for a peak-dip-peak pattern.
    const out = renderHit({ mix: 0 }, 0.3);
    const win = Math.floor(SR * 0.001);
    const at = (sec: number) => rms(out, Math.floor(sec * SR), Math.floor(sec * SR) + win);
    // The first slap is at t=0; there must be at least one later slap with a
    // measurable energy dip before it (i.e. the train is not one continuous blob).
    let sawDipThenPeak = false;
    let prev = at(0);
    let dipped = false;
    for (let s = 1; s <= 40; s++) {
      const e = at(s * 0.0015);
      if (e < prev * 0.5) dipped = true;
      if (dipped && e > prev * 1.5) { sawDipThenPeak = true; break; }
      prev = e;
    }
    expect(sawDipThenPeak).toBe(true);
  });

  it('slap amplitude decreases across the train', () => {
    const kernel = new Clap2Kernel(SR, 999);
    kernel.applyParams(withParam({ mix: 0, bursts: 4, spread: 0.02 }));
    kernel.noteOn(0, 0, 0, 1);
    const out = renderBlocks(kernel, 0, Math.ceil((SR * 0.2) / BLOCK));
    // Compare the first slap window's peak to the last slap window's peak.
    const firstPeak = slapPeaks(out, [0.0005], 0.004)[0];
    const laterPeak = slapPeaks(out, [0.05], 0.02)[0]; // well after the early slaps
    expect(firstPeak).toBeGreaterThan(laterPeak);
  });

  it('hit-to-hit variation: two triggers on one kernel differ (scatter free-runs)', () => {
    const kernel = new Clap2Kernel(SR, 7);
    kernel.applyParams(withParam({ mix: 0 }));
    kernel.noteOn(0, 0, 0, 1);
    const hit1 = renderBlocks(kernel, 0, Math.ceil((SR * 0.15) / BLOCK));
    kernel.noteOn(0, 0, 0, 1); // retrigger — scatter must NOT reset
    const hit2 = renderBlocks(kernel, Math.ceil((SR * 0.15) / BLOCK) * BLOCK, Math.ceil((SR * 0.15) / BLOCK));
    expect(rmsDiff(hit1, hit2, 0, hit1.length)).toBeGreaterThan(1e-3);
  });

  it('same seed reproduces the scattered pattern', () => {
    const render = (seed: number) => {
      const k = new Clap2Kernel(SR, seed);
      k.applyParams(withParam({ mix: 0 }));
      k.noteOn(0, 0, 0, 1);
      return renderBlocks(k, 0, Math.ceil((SR * 0.15) / BLOCK));
    };
    expect(rmsDiff(render(42), render(42), 0, render(42).length)).toBe(0);
  });
```

Also **replace** the existing `it('renders a train of transients spaced by \`spread\`…')` test — its assertion assumes onsets fall exactly at `j*spread`, which the non-uniform pattern breaks. Replace that whole test with:

```ts
  it('renders multiple distinct slaps (not exactly even-spaced)', () => {
    const out = renderHit({ bursts: 4, spread: 0.02, body: 0.004, room: 0.05, mix: 0, tone: 1000 }, 0.25);
    const win = Math.floor(SR * 0.001);
    const at = (sec: number) => rms(out, Math.floor(sec * SR), Math.floor(sec * SR) + win);
    // First slap at t=0 is loud; there is a later, separated slap within the burst
    // window (past 8ms, before 100ms) whose local energy exceeds its neighbours.
    const early = at(0);
    let laterPeak = 0;
    for (let s = 6; s <= 60; s++) laterPeak = Math.max(laterPeak, at(s * 0.0015));
    expect(early).toBeGreaterThan(0.005);
    expect(laterPeak).toBeGreaterThan(0.002);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @fiddle/client -- Clap2Kernel`
Expected: FAIL — the current even/unit-amplitude train produces a continuous blob (`slaps separate` fails, no dip-then-peak), equal-amplitude slaps (`amplitude decreases` fails), and no per-note variation in the pattern (`hit-to-hit variation` fails — only the noise differs today, but the pattern is identical; this test asserts a larger divergence than noise alone once scatter is added). The replaced even-spacing test compiles but the old one is gone.

- [ ] **Step 3: Add the scatter PRNG and per-trigger pattern state**

In `Clap2Kernel.ts`, add fields alongside the existing rng (after the `private rng: number;` line):

```ts
  // Independent free-running PRNG for the per-note slap jitter, decorrelated from the
  // noise stream (different seed derivation). Free-runs across triggers like the noise.
  private scatterRng: number;

  // Per-trigger pattern, drawn in trigger(): absolute slap onset offsets (s) and
  // per-slap amplitudes. Fixed within a hit, re-drawn (jittered) every hit.
  private readonly slapOffset = new Float32Array(5);
  private readonly slapAmp = new Float32Array(5);
  private slapCount = 0;
```

Seed `scatterRng` in the constructor (add one line after `this.rng = …`):

```ts
    this.scatterRng = ((seed >>> 0) ^ 0x9e3779b9) >>> 0 || 0x85ebca6b; // decorrelated from rng
```

Add a `scatter()` generator method next to `noise()`:

```ts
  /** xorshift32 scatter draw → [-1, 1). Independent of the noise stream. */
  private scatter(): number {
    let x = this.scatterRng;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.scatterRng = x >>> 0;
    return (this.scatterRng / 0xffffffff) * 2 - 1;
  }
```

Add the pattern constants near the top-of-file constants (`MAX_EVENTS`, `BANDPASS_Q`, `OUT_TRIM`):

```ts
const ATTACK = 0.00015;                       // 0.15 ms per-slap attack (was 0.5 ms; sharper)
const BASE_GAP = [1.0, 1.3, 1.7, 2.2];        // inter-slap gap multipliers (× spread), widening
const AMP_DECAY = 0.78;                        // each slap ~0.78× the previous
const JITTER_GAP = 0.18;                       // ±18% per-note gap jitter
const JITTER_AMP = 0.22;                       // ±22% per-note amplitude jitter
```

- [ ] **Step 4: Draw the pattern at trigger time**

In `Clap2Kernel.ts`, replace the `trigger` method:

```ts
  private trigger(velocity: number): void {
    this.active = true;
    this.t = 0;
    this.velocity = velocity;
    this.svfLow = 0;
    this.svfBand = 0;

    // Draw the non-uniform, amplitude-decaying, per-note-jittered slap pattern.
    const bursts = Math.max(2, Math.min(5, Math.round(this.block[I_BURSTS])));
    const spread = Math.max(1e-4, this.block[I_SPREAD]);
    this.slapCount = bursts;
    let off = 0;
    for (let j = 0; j < bursts; j++) {
      this.slapOffset[j] = off;
      const gap = BASE_GAP[Math.min(j, BASE_GAP.length - 1)] * (1 + JITTER_GAP * this.scatter());
      off += spread * Math.max(0.2, gap);
      const amp = Math.pow(AMP_DECAY, j) * (1 + JITTER_AMP * this.scatter());
      this.slapAmp[j] = Math.max(0.05, amp);
    }
  }
```

- [ ] **Step 5: Consume the pattern in render()**

In `Clap2Kernel.ts` `render()`, delete the now-unused local `bursts`/`spread`/`lastOnset` derivations for the train (keep `body`, `room`, `mix`, `tone`, `level`, gains) and replace the burst loop + `lastOnset` handling. Replace this block:

```ts
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
```

with:

```ts
    const lastOnset = this.slapOffset[this.slapCount - 1];

    for (let i = from; i < to; i++) {
      const t = this.t;

      // Burst train: sum of per-slap AD envelopes at the drawn (non-uniform, jittered)
      // offsets and decaying amplitudes — the j-th slap starts at slapOffset[j].
      let burst = 0;
      for (let j = 0; j < this.slapCount; j++) {
        const td = t - this.slapOffset[j];
        if (td >= 0) {
          const atk = td < ATTACK ? td / ATTACK : 1; // sharp attack, no onset click
          burst += this.slapAmp[j] * atk * Math.exp(-td / body);
        }
      }
```

Also remove the now-dead `const bursts = …`, `const spread = …` lines at the top of `render()` (they are computed in `trigger()` now); leave `body`, `room`, `mix`, `tone`, `level` in place. Verify `lastOnset` is still referenced by the stop condition `if (t > lastOnset && env < 1e-4)` (it is — unchanged).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -w @fiddle/client -- Clap2Kernel`
Expected: PASS — the new separation / amplitude-decay / variation / reproducibility tests green, plus the replaced multi-slap test; the pre-existing `more bursts ⇒ more energy`, `longer room ⇒ more tail`, `mix changes the balance`, `tone shifts the band`, `velocity scales`, `decaying envelope`, `stays finite` tests still green.

- [ ] **Step 7: Commit**

```bash
git add packages/client/src/engine/clap2/kernel/Clap2Kernel.ts \
        packages/client/src/engine/clap2/kernel/Clap2Kernel.test.ts
git commit -F - <<'EOF'
feat(clap2): non-uniform, decaying, jittered slap pattern + sharper attack

Replace the even j*spread unit-amplitude 0.5ms-attack train with a designed
non-uniform pattern (widening gaps, ~0.78x amplitude decay), a per-note gap/
amplitude jitter drawn at trigger from a free-running scatter PRNG, and a
0.15ms attack — so the slaps separate instead of reading as one blob. Fixes
the audit's "burst train never dips below the onset floor" finding.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WVnY6qN9VAPu6AHGBHnNfP
EOF
```

---

## Task 3: Spectral reshape — broadened bandpass + HF attack injection

**Files:**
- Modify: `packages/client/src/engine/clap2/kernel/Clap2Kernel.ts`
- Test: `packages/client/src/engine/clap2/kernel/Clap2Kernel.test.ts`

**Interfaces:**
- Consumes: the per-trigger `slapAmp`/`slapOffset` pattern from Task 2.
- Produces: no public API change. Adds a highpass (bright) signal path summed alongside the bandpass body path.

The single narrow fixed-Q bandpass is spectrally thin. Broaden it (lower resonance → wider band, models a hand-cavity formant rather than a whistle) and add a fast-decaying **highpass** injection at each slap's attack for the bright snap real claps have. The Chamberlin SVF already computes `high`; we reuse it.

- [ ] **Step 1: Write the failing tests**

Add a centroid helper near the top of `Clap2Kernel.test.ts`:

```ts
// Crude spectral-centroid proxy: mean |first difference| / mean |signal| rises with
// brightness (more HF ⇒ larger sample-to-sample change relative to amplitude).
function brightness(buf: Float32Array, from: number, to: number): number {
  let diff = 0, mag = 0;
  for (let i = from + 1; i < to; i++) { diff += Math.abs(buf[i] - buf[i - 1]); mag += Math.abs(buf[i]); }
  return diff / Math.max(1e-9, mag);
}
```

Tests:

```ts
  it('the attack is brighter than the body (HF injection on onset)', () => {
    const out = renderHit({ mix: 0, tone: 1000, body: 0.01 }, 0.1);
    const attackBright = brightness(out, 0, Math.floor(SR * 0.002));      // first 2ms
    const bodyBright = brightness(out, Math.floor(SR * 0.02), Math.floor(SR * 0.04)); // 20–40ms
    expect(attackBright).toBeGreaterThan(bodyBright);
  });

  it('tone still shifts the band (knob remains wired after broadening)', () => {
    const lo = renderHit({ tone: 600 }, 0.1);
    const hi = renderHit({ tone: 2800 }, 0.1);
    expect(rmsDiff(hi, lo, 0, Math.floor(SR * 0.05))).toBeGreaterThan(1e-3);
  });

  it('stays finite and bounded with the HF path added', () => {
    const out = renderHit({ tone: 2800, bursts: 5, mix: 0.5 }, 0.4);
    for (let i = 0; i < out.length; i++) {
      expect(Number.isFinite(out[i])).toBe(true);
      expect(Math.abs(out[i])).toBeLessThan(4);
    }
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @fiddle/client -- Clap2Kernel`
Expected: FAIL — with no HF path, the attack is not measurably brighter than the body (`attack is brighter` fails). The other two are guards that should already hold; they lock behavior across the change.

- [ ] **Step 3: Broaden the bandpass**

In `Clap2Kernel.ts`, change the resonance constant. Replace:

```ts
const BANDPASS_Q = 1.2;   // analog ClapEngine value; fixed (not a knob)
```

with:

```ts
const BANDPASS_Q = 0.7;   // broadened (was 1.2): a wider hand-cavity formant, not a whistle
const HF_INJECT = 0.5;    // highpass (bright) blend on the slap attacks
const BRIGHT_TC = 0.0012; // 1.2 ms bright-path decay — snap on the attack, gone by the body
```

- [ ] **Step 4: Add the HF attack-injection path in render()**

In `render()`, the per-sample burst loop already sums the body envelope. Add a parallel bright accumulator in the same slap loop, then sum a highpass-injected term into the output. Change the burst loop to also accumulate `bright`:

```ts
      let burst = 0;
      let bright = 0;
      for (let j = 0; j < this.slapCount; j++) {
        const td = t - this.slapOffset[j];
        if (td >= 0) {
          const atk = td < ATTACK ? td / ATTACK : 1; // sharp attack, no onset click
          burst += this.slapAmp[j] * atk * Math.exp(-td / body);
          bright += this.slapAmp[j] * atk * Math.exp(-td / BRIGHT_TC); // fast bright env
        }
      }
```

Then, where the SVF is evaluated, capture the highpass output `high` (already computed) and add its injected contribution to the output. Replace the existing tail of the loop:

```ts
      // Bandpass the white noise (Chamberlin SVF; band output).
      const input = this.noise();
      this.svfLow += f * this.svfBand;
      const high = input - this.svfLow - q * this.svfBand;
      this.svfBand += f * high;
      const bp = this.svfBand;

      out[i] += bp * env * this.velocity * level * OUT_TRIM;
      this.t += dt;
```

with:

```ts
      // Two signal paths: bandpassed noise carries the body/room env; the SVF
      // highpass carries a fast bright "snap" on each slap attack.
      const input = this.noise();
      this.svfLow += f * this.svfBand;
      const high = input - this.svfLow - q * this.svfBand;
      this.svfBand += f * high;
      const bp = this.svfBand;

      const sample = bp * env + high * bright * burstGain * HF_INJECT;
      out[i] += sample * this.velocity * level * OUT_TRIM;
      this.t += dt;
```

(The bright term is gated by `burstGain` so `mix` still balances it with the room tail, and by `bright` so it only fires on the attacks.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w @fiddle/client -- Clap2Kernel`
Expected: PASS — `attack is brighter` now holds, `tone still shifts`, `stays finite and bounded`, and all prior tests remain green. If `stays finite` trips near ±4 at extreme params, reduce `HF_INJECT` (e.g. 0.4) — the OUT_TRIM headroom must hold.

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/engine/clap2/kernel/Clap2Kernel.ts \
        packages/client/src/engine/clap2/kernel/Clap2Kernel.test.ts
git commit -F - <<'EOF'
feat(clap2): broaden the bandpass + add HF attack injection

Lower the SVF resonance (1.2 -> 0.7) so the band models a hand-cavity
formant rather than a narrow whistle, and blend the SVF highpass output
into each slap's attack (fast 1.2ms bright env) for the snap real claps
have. Both paths stay bounded within OUT_TRIM headroom.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WVnY6qN9VAPu6AHGBHnNfP
EOF
```

---

## Task 4: Room re-voice — drop the mix floor so mix=0 is pure slaps

**Files:**
- Modify: `packages/client/src/engine/clap2/kernel/Clap2Kernel.ts`
- Test: `packages/client/src/engine/clap2/kernel/Clap2Kernel.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: no API change. Changes the internal `burstGain`/`roomGain` mix mapping only (not a descriptor range).

The audit confirmed `roomGain = 0.2 + 0.8·mix` floors at 0.2 — the tail never fully turns off. For a 909 clap the tail should be a short bright final slap, and `mix=0` should be pure slaps. Make `roomGain = mix` (floors at 0) and keep a gentle burst crossfade.

- [ ] **Step 1: Write the failing test**

Add to `Clap2Kernel.test.ts` inside `describe('Clap2Kernel', …)`:

```ts
  it('mix=0 has (almost) no room tail — pure slaps', () => {
    // With mix=0 the burst train ends by ~lastOnset+body; the tail region must be
    // near-silent (no 0.2-floor room bleed).
    const out = renderHit({ mix: 0, bursts: 3, spread: 0.02, body: 0.006, room: 0.4 }, 0.6);
    const tail = rms(out, Math.floor(SR * 0.3), Math.floor(SR * 0.5)); // 300–500ms
    expect(tail).toBeLessThan(1e-4);
  });

  it('mix still moves energy into the tail (knob remains wired)', () => {
    const tailRms = (mix: number) => {
      const out = renderHit({ mix, bursts: 2, room: 0.4 }, 0.6);
      return rms(out, Math.floor(SR * 0.2), Math.floor(SR * 0.4));
    };
    expect(tailRms(0.9)).toBeGreaterThan(tailRms(0.1) * 2);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @fiddle/client -- Clap2Kernel`
Expected: FAIL — the current `roomGain = 0.2 + 0.8*mix` leaves ~0.2 of room tail at `mix=0`, so the 300–500ms tail RMS exceeds `1e-4` (`mix=0 … pure slaps` fails).

- [ ] **Step 3: Drop the room floor**

In `Clap2Kernel.ts` `render()`, replace:

```ts
    // Mix → independent gains so neither the claps nor the room tail ever vanishes
    // at the knob extremes (default 0.5 ≈ a balanced 909 clap).
    const burstGain = 1 - 0.6 * mix; // 1.0 … 0.4
    const roomGain = 0.2 + 0.8 * mix; // 0.2 … 1.0
```

with:

```ts
    // Mix → a burst/room crossfade. roomGain floors at 0 (was 0.2) so mix=0 is
    // pure slaps — no room bleed (fixes the audit's "tail never fully off").
    const burstGain = 1 - 0.5 * mix; // 1.0 … 0.5
    const roomGain = mix;            // 0.0 … 1.0
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w @fiddle/client -- Clap2Kernel`
Expected: PASS — `mix=0 … pure slaps` and `mix still moves energy` green; all prior tests still green (the pre-existing `mix changes the balance` compares mix 0 vs 1, still a large diff; `longer room ⇒ more tail` uses mix=1, unaffected).

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/engine/clap2/kernel/Clap2Kernel.ts \
        packages/client/src/engine/clap2/kernel/Clap2Kernel.test.ts
git commit -F - <<'EOF'
feat(clap2): drop the room-gain floor so mix=0 is pure slaps

roomGain = mix (was 0.2 + 0.8*mix): the tail now fully turns off at mix=0,
fixing the audit's "room tail never fully off" finding, while mix still
crossfades slaps <-> tail across its range.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WVnY6qN9VAPu6AHGBHnNfP
EOF
```

---

## Task 5: Ear-tuning loop + descriptor defaults (human ear-approval gate)

**Files:**
- Modify: `packages/shared/src/engines/clap2.ts` (descriptor `default`s only)
- Modify (if a default-dependent expectation shifts): `packages/client/src/engine/clap2/kernel/Clap2Kernel.test.ts`

**Interfaces:**
- Consumes: the tuned kernel from Tasks 1–4.
- Produces: final `default` values for `tone`/`spread`/`bursts`/`body`/`room`/`mix` (ranges unchanged) that make the **out-of-the-box** clap hit the objective targets.

This task is a controller-run audio-lab loop with a **human ear-approval gate** — it is NOT a fresh subagent and NOT a red-green unit cycle. Constants tuned in Tasks 2–4 (`ATTACK`, `BASE_GAP`, `AMP_DECAY`, `JITTER_*`, `BANDPASS_Q`, `HF_INJECT`, `BRIGHT_TC`) may also be nudged here if the ear/metrics demand, re-running the Task-2/3/4 tests after any kernel edit.

- [ ] **Step 1: Render the current default clap and read the metrics**

Run:
```bash
npm run lab -- render-engine clap2 --notes "A3:0:0.6" --mono --label clap2-default
```
Open the run's `report.json` (`onsets`, `attackSeconds`, `decaySeconds`, `meanCentroidHz`, `healthFlags`) and `spectrogram.png` / `waveform.png` (Read tool). Record: does `onsets` show ≥2? is `healthFlags` free of `NON_FINITE`/`CLIPPING`?

- [ ] **Step 2: Sweep the levers against the objective targets**

Render variations and compare (each writes its own run dir):
```bash
npm run lab -- render-engine clap2 --set spread=0.018 --set body=0.006 --set bursts=4 --notes "A3:0:0.6" --mono --label clap2-tight
npm run lab -- render-engine clap2 --set spread=0.03  --set mix=0.35 --notes "A3:0:0.6" --mono --label clap2-loose
npm run lab -- render-engine clap2 --notes "A3:0:0.3,A3:0.4:0.3" --mono --label clap2-two-hits   # confirm hit-to-hit variation
```
Drive toward the Global-Constraints objective targets: onsets ≥2, decreasing slap peaks (waveform), attack brighter than body (spectrogram), mix=0 tail silent, no CLIPPING. Iterate constants in the kernel if a target can't be met by defaults alone (then re-run `npm test -w @fiddle/client -- Clap2Kernel`).

- [ ] **Step 3: Set the tuned defaults**

Edit `packages/shared/src/engines/clap2.ts` — change only the `default` fields to the ear-tuned winners from Step 2 (example values; use the actual winners). Ranges stay exactly as they are (no narrowing). E.g.:

```ts
  { key: 'tone',   min: 500,   max: 3000,  default: 1200,  label: 'Tone',   format: 'hz', curve: 'exp' },
  { key: 'spread', min: 0.005, max: 0.040, default: 0.020, label: 'Spread', format: 'ms', curve: 'exp' },
  { key: 'bursts', min: 2,     max: 5,     default: 4,     label: 'Bursts', step: 1,      curve: 'linear' },
  { key: 'body',   min: 0.002, max: 0.030, default: 0.006, label: 'Body',   format: 'ms', curve: 'exp' },
  { key: 'room',   min: 0.050, max: 0.800, default: 0.180, label: 'Room',   format: 'ms', curve: 'exp' },
  { key: 'mix',    min: 0,     max: 1,     default: 0.35,  label: 'Mix',    format: 'percent' },
  { key: 'level',  min: 0,     max: 1,     default: 0.8,   label: 'Level',  format: 'percent' },
```

- [ ] **Step 4: Re-run the full client suite; fix any default-dependent expectation**

Run: `npm test -w @fiddle/client -- Clap2Kernel` then `npm test -w @fiddle/shared -- clap2`
Expected: PASS. If a test that renders `{}` (defaults) now shifts (e.g. the `decaying envelope` window past a shorter room), adjust that test's window/threshold to match the new default voice — keeping a real behavioral assertion, not gutting it. The shared `clap2 descriptor ↔ params derivation contract` test must stay green (defaults still derive `DEFAULT_CLAP2_PARAMS`).

- [ ] **Step 5: Rebuild the worklet and browser-verify (human ear-approval gate)**

```bash
npm run build:worklet -w @fiddle/client   # rebuild public/worklets/clap2-processor.js
```
Confirm the served file mtime updated, then in the running `dev:obs` (LOCAL Docker DB): add a clap2 track, play a pattern, **reload** the page (worklet has no HMR), and **the user listens and approves the sound**. Console must be clean. Render WAVs for the user on request. **Do not proceed to Task 6 until the user approves the voice.**

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/engines/clap2.ts packages/client/src/engine/clap2/kernel/Clap2Kernel.ts \
        packages/client/src/engine/clap2/kernel/Clap2Kernel.test.ts
git commit -F - <<'EOF'
feat(clap2): ear-tuned voicing defaults (909 clap)

Set the descriptor defaults and final DSP constants to the ear-tuned voice
that meets the objective targets (>=2 separated slaps, decreasing amplitude,
brighter attack, mix=0 pure slaps, no clipping) and passed in-browser ear
approval. Descriptor ranges unchanged (append-only; no narrowing).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WVnY6qN9VAPu6AHGBHnNfP
EOF
```

---

## Task 6: Recalibrate the audit + close F8

**Files:**
- Modify: `packages/audio-lab/src/audit/checks/clap2.checks.ts`
- Modify: `docs/BACKLOG.md`

**Interfaces:**
- Consumes: the final voice + defaults from Task 5.
- Produces: an audit table that passes twice, with an added onset-separation check.

The directional checks (`decaySeconds`/`rmsDb`/`meanCentroidHz`/`peakDb`) should survive the re-voice, but their calibrated `minDelta`s and the stale inline notes need re-verification against the new voice. The re-voice's central win — slaps now separate — should be locked with an `onsetCount` check (today's "always 1" observation is now false).

- [ ] **Step 1: Run the audit and record clap2 results**

Run: `npm run lab:audit`
Read the clap2 rows. Expected: the 8 existing checks likely still PASS (directional metrics are robust), but note any that FAIL and by how much (the run writes failure dirs).

- [ ] **Step 2: Add the onset-separation check + recalibrate any failing check**

In `packages/audio-lab/src/audit/checks/clap2.checks.ts`, append an onset-separation check to the `clap2Checks` array (the slaps now separate, so the onset detector resolves ≥2 at default):

```ts
  d('onset.separation', 'the default clap resolves as ≥2 distinct slaps (not one blob)', { kind: 'absolute', metric: 'onsetCount', min: 2 }, { mix: 0 }),
```

For any directional check that FAILED in Step 1, adjust only its `from`/`to`/`minDelta` (or metric, as the original calibration did) to the real magnitude under the new voice — never weaken it to a triviality. Keep each check's intent.

- [ ] **Step 3: Update the stale inline notes**

In the header comment of `clap2.checks.ts`, correct the now-false observations: the `bursts.dir` note that `onsetCount` is "always 1" (it is now ≥2 — that's the new `onset.separation` check), and remove/replace the "clap2's known aesthetic problem … is untouched here" line to note the 2026-07-21 re-voice landed. Keep the calibration methodology notes that still hold.

- [ ] **Step 4: Run the audit twice to confirm stability**

Run: `npm run lab:audit` (twice)
Expected: clap2 rows PASS on both runs (the new `onset.separation` included), no `NON_FINITE`, health within `PERC`. If `onsetCount` is flaky across the two runs because of the per-note scatter, the audit uses the **default seed** (reproducible) — a flake would indicate the onset detector sits on a threshold; in that case lower the check to `min: 2` with a wider `spread` override (e.g. `{ mix: 0, spread: 0.03 }`) so the slaps sit comfortably above the detector floor, and re-run twice.

- [ ] **Step 5: Update the BACKLOG F8 item**

In `docs/BACKLOG.md`, mark the "clap2 voicing — doesn't sound like a convincing hand-clap" item resolved: status `resolved 2026-07-21` on `feat/clap2-voicing`, one line summarizing the re-voice (non-uniform jittered slaps + sharper attack + broadened band + HF injection + dropped room floor + per-session entropy), and note the objective targets + user ear-approval were met.

- [ ] **Step 6: Commit**

```bash
git add packages/audio-lab/src/audit/checks/clap2.checks.ts docs/BACKLOG.md
git commit -F - <<'EOF'
test(clap2): recalibrate audit for the re-voice + add onset-separation check

Add clap2.onset.separation (onsetCount >= 2 at default — the slaps now
separate), recalibrate any directional check the new voice shifted, correct
the stale "onsets always 1" / "aesthetic problem untouched" notes, and mark
BACKLOG F8 resolved. lab:audit green x2.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WVnY6qN9VAPu6AHGBHnNfP
EOF
```

---

## Self-Review

**Spec coverage:**
- Target 909 clap → Global Constraints + Task 5 ear-loop. ✓
- Lever (a) non-uniform + randomized slaps → Task 2. ✓
- Lever (b) sharper attack → Task 2 (`ATTACK`). ✓
- Lever (c) broadened bandpass + HF injection → Task 3. ✓
- Lever (d) room re-voice + drop mix floor → Task 4 (floor) + Task 5 (shorter room default). ✓
- Seeding (per-session entropy, free-running, fixed default) → Task 1. ✓
- Knob policy (no knobs appended; defaults only) → Global Constraints + Task 5. ✓
- Test & audit impact (seed-controlled tests, recalibrate, onset check, stale notes) → Tasks 1–4 tests + Task 6. ✓
- Verification loop (audio-lab drive + user browser ear-approval) → Task 5. ✓
- Scope boundaries (no v1 clap, no other engines, no presets, mono) → not touched by any task. ✓

**Placeholder scan:** No TBD/TODO. Exact DSP constants and defaults are concrete starting values (real, runnable) that Task 5 refines by ear — an explicit, gated tuning step, not a placeholder. Fixed a stray incorrect placeholder-line instruction in Task 3 Step 4 by giving the real source hunk to replace.

**Type consistency:** `Clap2Kernel(sampleRate, seed?)` used consistently (Tasks 1–5). `slapOffset`/`slapAmp`/`slapCount`/`scatterRng`/`scatter()` defined in Task 2, consumed in Tasks 2–4. `ATTACK`/`AMP_DECAY`/`BASE_GAP`/`JITTER_*` (Task 2), `BANDPASS_Q`/`HF_INJECT`/`BRIGHT_TC` (Task 3), `burstGain`/`roomGain` (Task 4) names consistent. Metric ids (`onsetCount`, `decaySeconds`, `rmsDb`, `meanCentroidHz`, `peakDb`) match `audit/types.ts`. Lab command surface (`render-engine clap2 --set key=value --notes … --mono --label`) matches the audio-lab skill.
