# synth2 I4 — Robustness Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the synth2 kernel provably safe under garbage input and sustained load — no NaN/Inf reaches output, no denormal CPU spikes, no retained per-block allocation, no voice-steal click — adding no new audible features.

**Architecture:** Two-layer NaN safety (root-cause coercion at the `Synth2Kernel.noteOn` trigger boundary + Voice belts; an observable `flushNonFinite` net swept over the kernel output buffer). A `SvfCore` flush-to-zero kills denormal tails. A `flushNonFinite` helper and a seeded fuzz test prove the invariants. A `--expose-gc` soak test locks the zero-alloc discipline; a discontinuity test locks the voice-steal ramp.

**Tech Stack:** TypeScript, Vitest 4.1.7 (Node env, default `forks` pool), npm workspaces (`@fiddle/client`, `@fiddle/shared`). Pure-TS AudioWorklet kernel under `packages/client/src/engine/synth2/kernel/`.

## Global Constraints

- **Branch:** all work on `feat/synth2-i4-robustness` (already created off `main`). NEVER commit to `main`.
- **Reference:** design spec `docs/superpowers/specs/2026-06-18-synth2-i4-robustness-design.md`.
- **`SYNTH2_DESCRIPTORS` is APPEND-ONLY** — I4 adds NO descriptors and changes NO param indices. Reference params by KEY via `PARAM_INDEX`, never by integer literal.
- **Commit trailer (every commit):** end the message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Per-task gate:** after each task, the touched workspace's `npm test` must be green. **Final gate (before handoff):** `npm run typecheck && npm test && npm run build` from repo root (all three workspaces); `npm run build -w @fiddle/client` still emits `packages/client/public/worklets/synth2-processor.js`.
- **Test idioms (match the existing kernel tests):** `import { describe, it, expect } from 'vitest';`, `const SR = 48000;`, `const BLOCK = 128;`. Kernel-level tests reuse the `renderBlocks(kernel, startFrame, blocks)` helper already at the top of `Synth2Kernel.test.ts`.
- **Keep the branch after verify** — the user browser-verifies before merge. Do NOT auto-merge or push.

### Single-file commands (client workspace)

- Run one test file: `npm test -w @fiddle/client -- src/engine/synth2/kernel/<File>.test.ts`
- Run whole client suite: `npm test -w @fiddle/client`
- Typecheck client: `npm run typecheck -w @fiddle/client`

---

## File Structure

**Modified:**
- `packages/client/src/engine/synth2/kernel/Synth2Kernel.ts` — Layer-1 freq/velocity/duration/time coercion in `noteOn`; Layer-2 `flushNonFinite` call + `nonFiniteFlushed` counter in `process`.
- `packages/client/src/engine/synth2/kernel/Voice.ts` — NaN belts in `noteOn` (`freq`, `velocity`, `keyTrackOctaves`) and the `fc` clamp in `renderAdd`.
- `packages/client/src/engine/synth2/kernel/SvfCore.ts` — flush-to-zero of the integrator states in `tick`.
- `packages/client/vite.config.ts` — `test.poolOptions.forks.execArgv: ['--expose-gc']` (import `defineConfig` from `vitest/config`).

**Created:**
- `packages/client/src/engine/synth2/kernel/sanitize.ts` — `flushNonFinite(out, frames)` Layer-2 net helper (one responsibility: sweep a buffer, NaN/Inf → 0, return count).
- `packages/client/src/engine/synth2/kernel/sanitize.test.ts`
- `packages/client/src/engine/synth2/kernel/fuzz.test.ts` — randomized Voice finiteness (pre-net).
- `packages/client/src/engine/synth2/kernel/soak.test.ts` — zero-alloc soak.

**Test additions (existing files):**
- `Synth2Kernel.test.ts` — trigger-coercion, output-net counter, voice-steal blocks.
- `Voice.test.ts` — NaN-belt block.
- `SvfCore.test.ts` — denormal flush block.

---

## Task 1: Layer-1 trigger coercion + Voice NaN belts

Root-cause the one real NaN ingress: the note-event boundary. The kernel choke point authoritatively coerces; the Voice belts guarantee finiteness for any direct caller (tests, the Task 3 fuzz).

**Files:**
- Modify: `packages/client/src/engine/synth2/kernel/Synth2Kernel.ts:89-101` (`noteOn`)
- Modify: `packages/client/src/engine/synth2/kernel/Voice.ts:147-168` (`noteOn`) and `Voice.ts:210-211` (`fc` clamp)
- Test: `packages/client/src/engine/synth2/kernel/Synth2Kernel.test.ts`, `packages/client/src/engine/synth2/kernel/Voice.test.ts`

**Interfaces:**
- Consumes: existing `Synth2Kernel.noteOn(time, freq, duration, velocity, mono)`, `Voice.noteOn(freq, velocity, gateFrames)`, `KEYTRACK_REF_HZ` (already defined `Voice.ts:22`).
- Produces: no signature changes. Behavior contract: `noteOn` with non-finite/`≤0` `freq` enqueues NO event; NaN `velocity` → `1`; non-finite `duration` → 1-frame gate; `Voice` stays finite for any input.

- [ ] **Step 1: Write the failing kernel-ingress test** — append to `Synth2Kernel.test.ts`:

```ts
describe('Synth2Kernel trigger coercion (I4 Layer 1)', () => {
  const finite = (a: Float32Array) => a.every(Number.isFinite);

  it('drops a non-finite or non-positive freq: no note, output stays exact zero', () => {
    for (const bad of [NaN, 0, -1, -440, Infinity, -Infinity]) {
      const k = new Synth2Kernel(SR);
      k.noteOn(0, bad, 0.5, 1);
      const out = renderBlocks(k, 0, 4);
      for (let i = 0; i < out.length; i++) expect(out[i]).toBe(0);
    }
  });

  it('a NaN velocity still produces finite, audible output (NaN -> 1)', () => {
    const k = new Synth2Kernel(SR);
    k.noteOn(0, 440, 0.5, NaN);
    const out = renderBlocks(k, 0, 8);
    expect(finite(out)).toBe(true);
    let energy = 0; for (const x of out) energy += Math.abs(x);
    expect(energy).toBeGreaterThan(0);
  });

  it('a non-finite duration falls back to a finite gate (output finite)', () => {
    const k = new Synth2Kernel(SR);
    k.noteOn(0, 440, NaN, 1);
    const out = renderBlocks(k, 0, 8);
    expect(finite(out)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `npm test -w @fiddle/client -- src/engine/synth2/kernel/Synth2Kernel.test.ts`
Expected: FAIL — the NaN-freq case leaks NaN (via `Math.log2(freq)`), the NaN-velocity case leaks NaN into the output.

- [ ] **Step 3: Implement the kernel choke point** — replace `Synth2Kernel.noteOn` (`Synth2Kernel.ts:89-101`) with:

```ts
  /** time/duration in seconds on the AudioContext clock (SoundEngine contract). */
  noteOn(time: number, freq: number, duration: number, velocity: number, mono = true): void {
    // I4 Layer 1 (root cause): coerce the trigger boundary. A meaningless pitch
    // makes no note; garbage velocity/duration/time become safe finite values.
    if (!Number.isFinite(freq) || freq <= 0) return; // reject — no note
    const vel = Number.isFinite(velocity)
      ? (velocity < 0 ? 0 : velocity > 1 ? 1 : velocity)
      : 1; // NaN -> full
    const dur = Number.isFinite(duration) && duration > 0 ? duration : 0;
    const t = Number.isFinite(time) ? time : 0;

    if (this.count === MAX_EVENTS) { // drop oldest
      this.head = (this.head + 1) % MAX_EVENTS;
      this.count--;
    }
    const ev = this.events[(this.head + this.count) % MAX_EVENTS];
    ev.frame = Math.round(t * this.sampleRate);
    ev.freq = freq;
    ev.gateFrames = Math.max(1, Math.round(dur * this.sampleRate));
    ev.velocity = vel;
    ev.mono = mono;
    this.count++;
  }
```

- [ ] **Step 4: Implement the Voice belts** — in `Voice.noteOn` (`Voice.ts:147-150`), replace the first three lines of the body:

```ts
  noteOn(freq: number, velocity: number, gateFrames: number): void {
    // I4 belt: guarantee finite, in-range internals for any direct caller. The
    // kernel choke point is the authoritative coercion and runs first in
    // production; this only secures Voice against bad input reaching it directly.
    this.freq = Number.isFinite(freq) && freq > 0 ? freq : KEYTRACK_REF_HZ;
    this.velocity = velocity >= 0 ? (velocity > 1 ? 1 : velocity) : 0; // NaN -> 0
    this.keyTrackOctaves = Math.log2(this.freq / KEYTRACK_REF_HZ); // this.freq now safe
```

(Leave the rest of `noteOn` — the prev-source resets, `lfo.reset()`, the `if (!this.env1.active)` block, the three `env*.noteOn` calls — unchanged. Delete the original `this.freq = freq;`, `this.velocity = …`, and `this.keyTrackOctaves = Math.log2(freq / KEYTRACK_REF_HZ);` lines they replace.)

Then make the `fc` clamp NaN-safe (`Voice.ts:210-211`):

```ts
      let fc = this.cutoffSlot.next() * Math.pow(2, octShift); // I4: Math.pow -> approx (cf. SvfCore tan)
      fc = fc > 20000 ? 20000 : fc >= 20 ? fc : 20; // NaN-safe clamp: NaN -> 20
```

- [ ] **Step 5: Write the Voice-belt test** — append to `Voice.test.ts`:

```ts
describe('Voice NaN belts (I4 Layer 1)', () => {
  const SR = 48000;
  it('renders finite audio even when noteOn gets a bad freq/velocity', () => {
    for (const f of [NaN, 0, -1, Infinity, -Infinity]) {
      const v = new Voice(SR, 1);
      v.noteOn(f, NaN, SR);
      const out = new Float32Array(2048);
      v.renderAdd(out, 0, 2048);
      expect(out.every(Number.isFinite)).toBe(true);
    }
  });
});
```

- [ ] **Step 6: Run both test files; verify they pass and nothing regressed**

Run: `npm test -w @fiddle/client -- src/engine/synth2/kernel/Synth2Kernel.test.ts src/engine/synth2/kernel/Voice.test.ts`
Expected: PASS (all blocks, including the pre-existing ones).

- [ ] **Step 7: Commit**

```bash
git add packages/client/src/engine/synth2/kernel/Synth2Kernel.ts \
        packages/client/src/engine/synth2/kernel/Voice.ts \
        packages/client/src/engine/synth2/kernel/Synth2Kernel.test.ts \
        packages/client/src/engine/synth2/kernel/Voice.test.ts
git commit -m "$(cat <<'EOF'
fix(synth2): NaN-safe trigger coercion + Voice belts (I4 Layer 1)

Reject non-finite/<=0 freq at Synth2Kernel.noteOn (no note); NaN velocity
-> 1; non-finite duration/time -> safe finite. Voice belts guarantee
finiteness for direct callers (freq fallback to ref pitch, NaN-safe
velocity + fc clamp). Closes the one real NaN ingress: the note boundary.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Layer-2 output net + `nonFiniteFlushed` counter

A production safety net swept over the render buffer. Extracted as `flushNonFinite` so it is unit-testable directly (the kernel can't easily be coerced into emitting NaN after Task 1).

**Files:**
- Create: `packages/client/src/engine/synth2/kernel/sanitize.ts`
- Create: `packages/client/src/engine/synth2/kernel/sanitize.test.ts`
- Modify: `packages/client/src/engine/synth2/kernel/Synth2Kernel.ts` (import + field + getter + `process` call)
- Test: `packages/client/src/engine/synth2/kernel/Synth2Kernel.test.ts`

**Interfaces:**
- Produces: `flushNonFinite(out: Float32Array, frames: number): number` (count of samples replaced); `Synth2Kernel.nonFiniteFlushed: number` (read-only getter, cumulative).
- Consumes: existing `Synth2Kernel.process`.

- [ ] **Step 1: Write the failing helper test** — create `sanitize.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { flushNonFinite } from './sanitize';

describe('flushNonFinite (I4 Layer 2 net)', () => {
  it('replaces NaN/Inf with 0, counts them, leaves finite samples', () => {
    const b = new Float32Array([0.5, NaN, -0.3, Infinity, -Infinity, 0.1]);
    expect(flushNonFinite(b, b.length)).toBe(3);
    expect(Array.from(b)).toEqual([0.5, 0, -0.3, 0, 0, 0.1]);
  });

  it('returns 0 and is a no-op on an all-finite buffer', () => {
    const b = new Float32Array([0, 0.2, -0.2]);
    expect(flushNonFinite(b, b.length)).toBe(0);
    expect(Array.from(b)).toEqual([0, 0.2, -0.2]);
  });

  it('only sweeps the first `frames` samples', () => {
    const b = new Float32Array([NaN, NaN, NaN, NaN]);
    expect(flushNonFinite(b, 2)).toBe(2);
    expect(b[2]).toBeNaN();
  });
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `npm test -w @fiddle/client -- src/engine/synth2/kernel/sanitize.test.ts`
Expected: FAIL — `Cannot find module './sanitize'`.

- [ ] **Step 3: Implement the helper** — create `sanitize.ts`:

```ts
//
// I4 Layer 2 (spec §4): production safety net. Sweep a render buffer and
// replace any non-finite sample with 0, returning how many were flushed
// (observability — a non-zero count in normal operation signals an unguarded
// NaN source that the Layer-1 root-cause coercion missed). One Number.isFinite
// per output sample: 128/block, independent of voice count.
//

export function flushNonFinite(out: Float32Array, frames: number): number {
  let flushed = 0;
  for (let i = 0; i < frames; i++) {
    if (!Number.isFinite(out[i])) {
      out[i] = 0;
      flushed++;
    }
  }
  return flushed;
}
```

- [ ] **Step 4: Run the helper test; verify it passes**

Run: `npm test -w @fiddle/client -- src/engine/synth2/kernel/sanitize.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire the net into the kernel** — in `Synth2Kernel.ts`:

Add the import beside the others (near `Synth2Kernel.ts:18`):

```ts
import { flushNonFinite } from './sanitize';
```

Add a field + getter inside the class (next to the other private fields, near `Synth2Kernel.ts:40-41`):

```ts
  private _nonFiniteFlushed = 0;
  /** Cumulative count of non-finite output samples the Layer-2 net flushed to 0
   *  (I4). 0 in normal operation; a positive value means a NaN source slipped
   *  past the Layer-1 coercion. */
  get nonFiniteFlushed(): number { return this._nonFiniteFlushed; }
```

Add the sweep as the final statement of `process` (after `this.renderActive(out, cursor, frames);`, `Synth2Kernel.ts:117`):

```ts
    this.renderActive(out, cursor, frames);
    this._nonFiniteFlushed += flushNonFinite(out, frames); // I4 Layer 2 net
```

- [ ] **Step 6: Write the kernel-counter test** — append to `Synth2Kernel.test.ts`:

```ts
describe('Synth2Kernel output net (I4 Layer 2)', () => {
  it('nonFiniteFlushed stays 0 across a normal, valid-input render', () => {
    const k = new Synth2Kernel(SR);
    k.noteOn(0, 440, 0.5, 1);
    renderBlocks(k, 0, 16);
    expect(k.nonFiniteFlushed).toBe(0);
  });
});
```

- [ ] **Step 7: Run the kernel suite; verify it passes**

Run: `npm test -w @fiddle/client -- src/engine/synth2/kernel/Synth2Kernel.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/client/src/engine/synth2/kernel/sanitize.ts \
        packages/client/src/engine/synth2/kernel/sanitize.test.ts \
        packages/client/src/engine/synth2/kernel/Synth2Kernel.ts \
        packages/client/src/engine/synth2/kernel/Synth2Kernel.test.ts
git commit -m "$(cat <<'EOF'
feat(synth2): Layer-2 output NaN net + nonFiniteFlushed counter (I4)

flushNonFinite sweeps the render buffer (NaN/Inf -> 0) after rendering;
the cumulative count is exposed for observability and stays 0 in normal
operation. Defense-in-depth behind the Layer-1 coercion.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Randomized fuzz test (pre-net finiteness)

The acceptance test for Layer 1: random params (incl. out-of-range probes), all matrix slots wired, random discrete state, and garbage triggers must never make a **Voice** emit a non-finite sample. It asserts at the Voice layer — upstream of the Task 2 net — so the net cannot mask a regression. Test-only; if it fails, a Layer-1 gap exists — root-cause it (systematic-debugging) before proceeding.

**Files:**
- Create: `packages/client/src/engine/synth2/kernel/fuzz.test.ts`

**Interfaces:**
- Consumes: `Voice` (`new Voice(SR, seed)`, `slots[i].setBase`, `setSync`, `setFilterType`, `setFilterModel`, `setEnvLoop`, `setMatrixSlot(i, srcIndex, destSlot, amount)`, `noteOn`, `renderAdd`), `SYNTH2_DESCRIPTORS`, `MOD_SOURCES` from `@fiddle/shared`. Note `Voice.setMatrixSlot` takes a RAW `destSlot` index (or `-1`), not the kernel's `+1` encoding.

- [ ] **Step 1: Write the fuzz test** — create `fuzz.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Voice } from './Voice';
import { SYNTH2_DESCRIPTORS, MOD_SOURCES } from '@fiddle/shared';

const SR = 48000;

// Deterministic RNG (mulberry32) so any failure reproduces from the seed.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BAD_FREQS = [NaN, 0, -1, -440, Infinity, -Infinity, 1e9];
const BAD_VELS = [NaN, -1, 2, Infinity, -Infinity];

describe('Voice fuzz — finite output under randomized params/triggers (I4)', () => {
  it('never emits a non-finite sample across 400 random configurations', () => {
    const rand = rng(0xc0ffee);
    const out = new Float32Array(1024);

    for (let iter = 0; iter < 400; iter++) {
      const v = new Voice(SR, ((iter + 1) * 2654435761) >>> 0);

      // Random param bases; 30% of the time probe outside [min,max] (setBase
      // clamps — this exercises the clamp path).
      SYNTH2_DESCRIPTORS.forEach((d, i) => {
        const span = d.max - d.min || 1;
        const over = rand() < 0.3 ? (rand() - 0.5) * span * 4 : 0;
        v.slots[i].setBase(d.min + rand() * span + over);
      });

      // Random discrete state.
      v.setSync(rand() < 0.5, rand() < 0.5);
      v.setFilterType(Math.floor(rand() * 3));
      v.setFilterModel(rand() < 0.5 ? 0 : 1);
      v.setEnvLoop(rand() < 0.5, rand() < 0.5, rand() < 0.5);

      // All 8 matrix slots wired (raw dest slot index, or -1 for none).
      for (let s = 0; s < 8; s++) {
        const src = Math.floor(rand() * MOD_SOURCES.length);
        const dest = rand() < 0.2 ? -1 : Math.floor(rand() * SYNTH2_DESCRIPTORS.length);
        v.setMatrixSlot(s, src, dest, (rand() - 0.5) * 4);
      }

      // Fuzzed trigger: mix valid and garbage freq/velocity.
      const freq = rand() < 0.5 ? 20 + rand() * 19000 : BAD_FREQS[Math.floor(rand() * BAD_FREQS.length)];
      const vel = rand() < 0.5 ? rand() : BAD_VELS[Math.floor(rand() * BAD_VELS.length)];
      v.noteOn(freq, vel, Math.floor(1 + rand() * SR));

      out.fill(0);
      v.renderAdd(out, 0, out.length);
      for (let i = 0; i < out.length; i++) {
        if (!Number.isFinite(out[i])) {
          throw new Error(`non-finite output at iter=${iter} sample=${i} value=${out[i]}`);
        }
      }
    }
    expect(true).toBe(true); // reached only if every iteration stayed finite
  });
});
```

- [ ] **Step 2: Run it**

Run: `npm test -w @fiddle/client -- src/engine/synth2/kernel/fuzz.test.ts`
Expected: PASS. (This is the acceptance test for Task 1; it would have failed before Task 1's belts. If it FAILS now, the thrown error names the iteration/sample — reproduce with that seed, trace the NaN to its source per systematic-debugging, fix the source + add the guard, then re-run.)

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/engine/synth2/kernel/fuzz.test.ts
git commit -m "$(cat <<'EOF'
test(synth2): randomized Voice fuzz asserts finite output pre-net (I4)

400 seeded configurations of random params (incl. out-of-range), all 8
matrix slots wired, random discrete state, and garbage freq/velocity --
the Voice must never emit a non-finite sample. Asserts upstream of the
Layer-2 net so it cannot be masked.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: SvfCore denormal sweep (flush-to-zero)

Measure first: prove the integrator state lingers in the subnormal range after the signal goes silent (V8 has no flush-to-zero), then fix with a threshold flush. One `SvfCore` fix covers both `ClassicFilter` and `MorphFilter` (both wrap `SvfCore`).

**Files:**
- Modify: `packages/client/src/engine/synth2/kernel/SvfCore.ts:48-49` (`tick`)
- Test: `packages/client/src/engine/synth2/kernel/SvfCore.test.ts`

**Interfaces:**
- Consumes: existing `SvfCore` (`tick(input, cutoffHz, resonance)`, public `low`/`band`/`high`). No signature change.
- Behavior contract: after the input goes silent, the outputs reach **exact 0** within ~1s of samples (not a denormal tail).

- [ ] **Step 1: Write the failing denormal test** — append to `SvfCore.test.ts`:

```ts
it('flushes to exact zero after the signal goes silent (no denormal tail)', () => {
  const svf = new SvfCore(SR);
  // Excite, then feed silence at high resonance (slowest decay = worst case).
  for (let i = 0; i < 2000; i++) svf.tick(Math.sin((2 * Math.PI * 220 * i) / SR), 1000, 0.9);
  let zeroed = false;
  for (let i = 0; i < SR; i++) { // up to 1s of silence
    svf.tick(0, 1000, 0.9);
    if (svf.low === 0 && svf.band === 0 && svf.high === 0) { zeroed = true; break; }
  }
  expect(zeroed).toBe(true);
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `npm test -w @fiddle/client -- src/engine/synth2/kernel/SvfCore.test.ts`
Expected: FAIL — without the flush the state decays through subnormals (~1e-114 after the window) and the outputs never reach exact 0; `zeroed` stays `false`.

- [ ] **Step 3: Implement flush-to-zero** — in `SvfCore.tick`, immediately after the two integrator updates (`SvfCore.ts:48-49`):

```ts
    this.ic1eq = 2 * v1 - this.ic1eq;
    this.ic2eq = 2 * v2 - this.ic2eq;
    // I4 denormal sweep: V8 has no flush-to-zero, so a silent input lets the
    // integrator state decay through the subnormal range (~100x slower on some
    // CPUs). 1e-25 is far above the subnormal boundary (~2.2e-308) yet
    // inaudible. Inline comparisons (no Math.abs call) keep the hot loop lean.
    if (this.ic1eq < 1e-25 && this.ic1eq > -1e-25) this.ic1eq = 0;
    if (this.ic2eq < 1e-25 && this.ic2eq > -1e-25) this.ic2eq = 0;
```

(Leave the `this.low`/`this.band`/`this.high` assignments below unchanged.)

- [ ] **Step 4: Run the SvfCore suite; verify it passes (and nothing regressed)**

Run: `npm test -w @fiddle/client -- src/engine/synth2/kernel/SvfCore.test.ts`
Expected: PASS — the new test plus the existing `silence in -> silence out`, the LP/HP/BP, and the `stays finite and bounded` tests (the flush is far below any audible level and cannot alter them).

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/engine/synth2/kernel/SvfCore.ts \
        packages/client/src/engine/synth2/kernel/SvfCore.test.ts
git commit -m "$(cat <<'EOF'
fix(synth2): flush SvfCore integrator state to zero (I4 denormal sweep)

After silence the ZDF integrator state decayed through subnormals (V8 has
no FTZ), risking ~100x CPU spikes. Threshold-flush both states at 1e-25
each tick -- inaudible, fixes ClassicFilter and MorphFilter at once.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Zero-alloc soak test + `--expose-gc` wiring

Codify the spec §10 zero-allocation discipline. **Scope note (honest framing):** GC-before-and-after measures *retained* growth (leaks) — transient garbage is collected and not seen. True transient zero-allocation is enforced by code review; this test guards against the common regression of accidentally retaining per-block state. The test self-skips if `global.gc` is absent; the `vite.config.ts` change exposes it under the default `forks` pool so `npm test` runs it.

**Files:**
- Modify: `packages/client/vite.config.ts`
- Create: `packages/client/src/engine/synth2/kernel/soak.test.ts`

**Interfaces:**
- Consumes: `Synth2Kernel` (`applyParams`, `noteOn(time, freq, duration, velocity, mono)`, `process`), `defaultParamBlock`, `PARAM_INDEX`, `MATRIX_BASE`, `MATRIX_STRIDE` from `./params`, `MOD_SOURCES` from `@fiddle/shared`. Matrix `destEnc` encoding = `PARAM_INDEX[key] + 1` (kernel decodes `destSlot = destEnc - 1`).

- [ ] **Step 1: Wire `--expose-gc` into the client vitest config** — edit `packages/client/vite.config.ts`. Change the import line `import { defineConfig } from 'vite'` to:

```ts
import { defineConfig } from 'vitest/config'
```

and add a `test` block to the config object (sibling of `plugins` and `server`), leaving `plugins`/`server` exactly as they are:

```ts
  test: {
    // I4: expose global.gc to the test workers so the zero-alloc soak test can
    // force collection and measure retained heap growth. Harmless to every
    // other test. Vitest 4's default pool is 'forks'.
    poolOptions: { forks: { execArgv: ['--expose-gc'] } },
  },
```

- [ ] **Step 2: Write the soak test** — create `soak.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Synth2Kernel } from './Synth2Kernel';
import { defaultParamBlock, PARAM_INDEX, MATRIX_BASE, MATRIX_STRIDE } from './params';
import { MOD_SOURCES } from '@fiddle/shared';

const SR = 48000;
const BLOCK = 128;

// GC-before-and-after measures RETAINED growth (leaks); transient garbage is
// collected and not counted. Transient zero-alloc is a code-review invariant
// (spec sec 10); this locks against accidental per-block retention.
const gc = (globalThis as { gc?: () => void }).gc;
const maybe = gc ? it : it.skip; // run with --expose-gc (vite.config wires it)

describe('Synth2Kernel zero-alloc soak (I4)', () => {
  maybe('does not retain heap across 10k process() blocks (8 voices, dense matrix)', () => {
    const kernel = new Synth2Kernel(SR);

    // Dense config: all 8 matrix slots wired (lfo1 -> filter.cutoff).
    const block = defaultParamBlock();
    for (let s = 0; s < 8; s++) {
      const base = MATRIX_BASE + s * MATRIX_STRIDE;
      block[base] = MOD_SOURCES.indexOf('lfo1');         // srcIdx
      block[base + 1] = PARAM_INDEX['filter.cutoff'] + 1; // destEnc (= slot + 1)
      block[base + 2] = 0.5;                              // amount
    }
    kernel.applyParams(block);

    // 8 poly voices, long gates so they stay active through the whole run.
    for (let i = 0; i < 8; i++) kernel.noteOn(0, 110 * (i + 1), 100, 1, false);

    const buf = new Float32Array(BLOCK);
    const run = (n: number) => { for (let b = 0; b < n; b++) kernel.process(buf, BLOCK, b * BLOCK); };

    run(200);                 // warm up the JIT
    gc!();
    const before = process.memoryUsage().heapUsed;
    run(10000);
    gc!();
    const after = process.memoryUsage().heapUsed;

    // A real per-block retention (e.g. a 512-byte array x 10k = 5 MB) dwarfs this;
    // the generous absolute bound absorbs JIT/harness noise.
    expect(after - before).toBeLessThan(512 * 1024);
  });
});
```

- [ ] **Step 3: Run the soak test; verify it passes with gc exposed**

Run: `npm test -w @fiddle/client -- src/engine/synth2/kernel/soak.test.ts`
Expected: PASS (1 test; NOT skipped — the config exposes `global.gc`). If it shows as skipped, the `vite.config.ts` `execArgv` wiring did not take effect — fix that before continuing.

- [ ] **Step 4: Typecheck the client (the config import changed)**

Run: `npm run typecheck -w @fiddle/client`
Expected: PASS (no type errors from the `vitest/config` import or the `test` block).

- [ ] **Step 5: Commit**

```bash
git add packages/client/vite.config.ts \
        packages/client/src/engine/synth2/kernel/soak.test.ts
git commit -m "$(cat <<'EOF'
test(synth2): zero-alloc soak + --expose-gc wiring (I4)

10k process() blocks with 8 voices and all matrix slots active, asserting
no retained heap growth (leaks); transient zero-alloc stays a review
invariant. vite.config exposes global.gc to the forks pool so npm test
runs it; the test self-skips without gc.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Voice-steal discontinuity lock

Measure first: confirm the 1 ms `LoopEnvelope` steal ramp keeps the output continuous when the allocator steals an active voice. Regression lock — expected to pass with no production change. Only if it fails: reduce `STEAL_SECONDS` (`LoopEnvelope.ts:24`) and re-measure.

**Files:**
- Test: `packages/client/src/engine/synth2/kernel/Synth2Kernel.test.ts`
- Modify ONLY IF the test fails: `packages/client/src/engine/synth2/kernel/LoopEnvelope.ts:24` (`STEAL_SECONDS`)

**Interfaces:**
- Consumes: `Synth2Kernel.noteOn(time, freq, duration, velocity, mono)` with `mono=false` (poly: 9th note steals the oldest of 8 active voices via `allocate` -> `pickVoice`), `renderBlocks` helper.

- [ ] **Step 1: Write the steal test** — append to `Synth2Kernel.test.ts`:

```ts
describe('Synth2Kernel voice-steal click guard (I4)', () => {
  it('stealing the oldest active voice causes no output discontinuity spike', () => {
    const kernel = new Synth2Kernel(SR);
    // Fill all 8 voices; long gates keep them active, low freqs sum smoothly.
    for (let i = 0; i < 8; i++) kernel.noteOn(0, 80 + i * 7, 10, 1, false);
    renderBlocks(kernel, 0, 200); // settle into sustain

    // Reference: steady-state max per-sample slope.
    const steady = renderBlocks(kernel, 200 * BLOCK, 8);
    let steadyMaxDiff = 0;
    for (let i = 1; i < steady.length; i++) {
      steadyMaxDiff = Math.max(steadyMaxDiff, Math.abs(steady[i] - steady[i - 1]));
    }

    // 9th poly note steals the oldest active voice mid-stream.
    const startFrame = 208 * BLOCK;
    kernel.noteOn(startFrame / SR, 300, 10, 1, false);
    const around = renderBlocks(kernel, startFrame, 8);
    let stealMaxDiff = 0;
    for (let i = 1; i < around.length; i++) {
      stealMaxDiff = Math.max(stealMaxDiff, Math.abs(around[i] - around[i - 1]));
    }

    // The 1ms steal ramp must bound the boundary jump near the normal slope.
    expect(stealMaxDiff).toBeLessThan(steadyMaxDiff * 4 + 0.05);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npm test -w @fiddle/client -- src/engine/synth2/kernel/Synth2Kernel.test.ts`
Expected: PASS (the steal ramp already bounds the discontinuity). If it FAILS, the steal ramp is letting a click through: reduce `STEAL_SECONDS` in `LoopEnvelope.ts:24` (e.g. `0.001` -> `0.002` for a gentler ramp), re-run, and confirm the existing `LoopEnvelope` tests still pass. Do not loosen the test threshold to force a pass.

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/engine/synth2/kernel/Synth2Kernel.test.ts
# include LoopEnvelope.ts in the add ONLY if Step 2 required tuning it
git commit -m "$(cat <<'EOF'
test(synth2): lock voice-steal continuity (no click) (I4)

Fill 8 voices, steal the oldest with a 9th poly note, assert the output's
max per-sample slope across the steal boundary stays near steady-state --
the 1ms env steal ramp prevents a click.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Final Verification (after all tasks)

- [ ] **Full gate from repo root:**

```bash
npm run typecheck && npm test && npm run build
```

Expected: typecheck clean; all three workspaces green (client count up by the I4 additions, including the non-skipped soak test); build completes and emits `packages/client/public/worklets/synth2-processor.js`.

- [ ] **Confirm the soak test ran (not skipped):** in the client test output, the `zero-alloc soak` test is a pass, not a skip. If skipped, `global.gc` is not exposed — revisit Task 5 Step 1.

- [ ] **Browser smoke (Playwright MCP, per AGENTS.md):** `npm run dev`; open a session; add/select a synth2 track; place a few steps; Play; twist Cutoff/Resonance/Morph and the matrix; confirm audio is clean and the console has no errors. Switch the filter model CLASSIC<->MORPH while playing. **Close the tab/session when done.**

- [ ] **Keep the branch** — do not merge or push; the user browser-verifies first.

---

## Self-Review notes (author check — already applied)

- **Spec coverage:** Unit A → Tasks 1–3; Unit B → Task 4; Unit C → Task 5; Unit D → Task 6. Layer-1 + Layer-2 + observable fuzz all present and in the spec's stated order.
- **Type/name consistency:** `flushNonFinite(out, frames): number`, `nonFiniteFlushed` getter, `KEYTRACK_REF_HZ`, matrix `destEnc = index + 1` encoding (kernel/soak) vs raw `destSlot` (Voice fuzz) — used consistently across tasks; the fuzz/soak interface notes call out the encoding difference explicitly.
- **Placeholders:** none — every code/test step carries full code and an exact run command with expected result.
