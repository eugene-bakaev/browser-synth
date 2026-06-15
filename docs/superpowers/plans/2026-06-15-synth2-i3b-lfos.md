# synth2 I3b — LFOs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two per-voice, retriggered LFOs that fill the already-routed-but-inert `lfo1`/`lfo2` modulation-matrix sources, so the matrix can produce continuous cyclic modulation (audible the moment a slot routes `lfo1`/`lfo2`).

**Architecture:** Append 4 `modulatable` rows to the single-source descriptor table (`lfo1.rate`, `lfo1.shape`, `lfo2.rate`, `lfo2.shape`) — schema, accept-list, defaults, the kernel param-block layout, and `MOD_DESTS` all derive from that table, so most of the wiring is free. One genuinely new kernel module (`Lfo.ts`, a `DspModule`) produces a bipolar −1..+1 morphed waveform; `Voice.ts` instantiates two LFOs, retriggers their phase on note-on, and feeds their previous-sample output into the existing mod-matrix source array (the same previous-sample pattern I3a uses for env1/env2/noise, which keeps LFO→LFO feedback cycle-free). The panel gains an LFO column.

**Tech Stack:** TypeScript monorepo (`@fiddle/shared`, `@fiddle/client`), Vue 3 SFCs, Vitest, AudioWorklet kernel (pure TS, allocation-free hot path).

**Spec:** `docs/superpowers/specs/2026-06-15-synth2-i3b-lfos-design.md` (refines `2026-06-12-worklet-synth-engine-design.md` §5.5).

**Predecessor:** I3a (mod matrix core), merged `e37698b`. Branch for this work: `feat/synth2-i3b-lfos` (already created off `main`).

**Commit convention:** every commit message ends with a blank line then the trailer
`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. The commit commands below show the subject; append that trailer.

---

## Key invariants (do not violate)

- **`SYNTH2_DESCRIPTORS` is APPEND-ONLY.** The array index is the Float32Array param-block index and the wire ABI. Add the 4 new rows at the **end** (after `filter.type`). Never insert or reorder.
- **`MOD_SOURCES` is unchanged.** `lfo1`/`lfo2` already exist there (positions 1–2, inert since I3a). This slice only adds their DSP — do **not** touch `MOD_SOURCES`.
- **Hot path stays allocation-free.** `Lfo.next()` and `Voice.renderAdd()` must not allocate.
- **Schema / accept-list / params.ts / Synth2Engine encode / useSynth watchers are all descriptor-derived.** The new rows flow through them with **no production edits** — Tasks 3, 6 add only *tests* that lock the derivation. If you find yourself editing production code in those tasks, stop: you've misread the derivation.

## File structure (what changes)

| File | Responsibility | Change |
|---|---|---|
| `packages/shared/src/engines/synth2-descriptors.ts` | THE descriptor table | **+4 rows** (Task 1) |
| `packages/shared/src/engines/synth2.ts` | params interface + defaults | **+`Synth2LfoParams`, +`lfo1`/`lfo2` fields** (Task 2) |
| `packages/shared/src/project/schema.ts` | Zod schema | none — derived (Task 3 tests only) |
| `packages/shared/src/project/accept-list.ts` | writable paths + leaf validation | none — derived (Task 3 tests only) |
| `packages/client/src/engine/synth2/kernel/Lfo.ts` | **NEW** LFO DSP module | create (Task 4) |
| `packages/client/src/engine/synth2/kernel/Voice.ts` | THE PATCH — wires modules | **instantiate + route 2 LFOs** (Task 5) |
| `packages/client/src/engine/synth2/kernel/params.ts` | block layout | none — derived (verified Task 6) |
| `packages/client/src/engine/Synth2Engine.ts` | param encode | none — derived (Task 6 test only) |
| `packages/client/src/composables/useSynth.ts` | sync watchers | none — derived (Task 6 test only) |
| `packages/client/src/components/Synth2Panel.vue` | UI | **+LFO column** (Task 7) |

## Gate (run before every commit, must be green)

```bash
npm run typecheck && npm test
```
Full build check (run at end of Task 7 and the final review):
```bash
npm run build
```

---

### Task 1: Shared — append 4 LFO descriptor rows

**Files:**
- Modify: `packages/shared/src/engines/synth2-descriptors.ts` (append after the `filter.type` row)
- Test: `packages/shared/src/engines/synth2-descriptors.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/shared/src/engines/synth2-descriptors.test.ts`, inside the existing `describe('mod matrix enums (I3a)', …)` block or a new `describe('LFO descriptor rows (I3b)', …)` block at the end of the file:

```ts
describe('LFO descriptor rows (I3b)', () => {
  it('appends exactly four LFO rows at the tail (append-only)', () => {
    const tail = SYNTH2_DESCRIPTORS.slice(-4).map(d => d.key);
    expect(tail).toEqual(['lfo1.rate', 'lfo1.shape', 'lfo2.rate', 'lfo2.shape']);
  });

  it('LFO rate is exponential ±4 oct, shape is linear full-range, both modulatable', () => {
    const byKey = Object.fromEntries(SYNTH2_DESCRIPTORS.map(d => [d.key, d]));
    for (const k of ['lfo1.rate', 'lfo2.rate']) {
      expect(byKey[k].min).toBe(0.01);
      expect(byKey[k].max).toBe(2000);
      expect(byKey[k].taper).toBe('expOctaves');
      expect(byKey[k].modScale).toBe(4);
      expect(byKey[k].modulatable).toBe(true);
    }
    for (const k of ['lfo1.shape', 'lfo2.shape']) {
      expect(byKey[k].min).toBe(0);
      expect(byKey[k].max).toBe(4);
      expect(byKey[k].taper).toBe('linear');
      expect(byKey[k].modScale).toBe(1);
      expect(byKey[k].modulatable).toBe(true);
    }
    expect(byKey['lfo1.rate'].default).toBe(5);
    expect(byKey['lfo1.shape'].default).toBe(0);
    expect(byKey['lfo2.rate'].default).toBe(0.5);
    expect(byKey['lfo2.shape'].default).toBe(1);
  });

  it('makes the LFO rate/shape keys modulation destinations (derived MOD_DESTS)', () => {
    for (const k of ['lfo1.rate', 'lfo1.shape', 'lfo2.rate', 'lfo2.shape']) {
      expect(MOD_DESTS).toContain(k);
    }
  });

  it('leaves MOD_SOURCES untouched (lfo1/lfo2 already existed inert)', () => {
    expect(MOD_SOURCES).toEqual(['none', 'lfo1', 'lfo2', 'env1', 'env2', 'env3', 'velocity', 'noise']);
  });
});
```

Make sure `MOD_DESTS` and `MOD_SOURCES` are imported at the top of the test file (the I3a block already imports them — verify).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @fiddle/shared -- synth2-descriptors`
Expected: FAIL — the tail keys are `filter.type`-and-before; `lfo1.rate` etc. don't exist.

- [ ] **Step 3: Append the four rows**

In `packages/shared/src/engines/synth2-descriptors.ts`, immediately after the `filter.type` row (the current last element of `SYNTH2_DESCRIPTORS`), before the closing `];`, add:

```ts
  // --- I3b LFOs (append-only). Two per-voice retriggered LFOs filling the
  // inert lfo1/lfo2 mod sources. rate as a mod DEST is exponential ±4 oct (like
  // filter.cutoff); its base value is plain Hz (log response is a panel-knob
  // mapping). shape is a continuous 0..4 morph (sine→tri→saw-up→saw-down→square),
  // linear/full-range like osc morph. Both modulatable so the matrix can sweep
  // them (incl. LFO→LFO). MOD_SOURCES is unchanged — lfo1/lfo2 already exist there.
  { key: 'lfo1.rate',  min: 0.01, max: 2000, default: 5,   taper: 'expOctaves', modulatable: true, modScale: 4 },
  { key: 'lfo1.shape', min: 0,    max: 4,    default: 0,   taper: 'linear',     modulatable: true, modScale: 1 },
  { key: 'lfo2.rate',  min: 0.01, max: 2000, default: 0.5, taper: 'expOctaves', modulatable: true, modScale: 4 },
  { key: 'lfo2.shape', min: 0,    max: 4,    default: 1,   taper: 'linear',     modulatable: true, modScale: 1 },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w @fiddle/shared -- synth2-descriptors`
Expected: PASS.

- [ ] **Step 5: Run the gate and commit**

```bash
npm run typecheck && npm test
git add packages/shared/src/engines/synth2-descriptors.ts packages/shared/src/engines/synth2-descriptors.test.ts
git commit -m "feat(shared): append lfo1/lfo2 rate+shape descriptor rows (I3b)"
```
Expected: gate green (note: `synth2.test.ts` `leafCount` assertion still passes because it counts module leaves against `SYNTH2_DESCRIPTORS.length`, and both grew by 4).

---

### Task 2: Shared — `Synth2LfoParams` interface + `lfo1`/`lfo2` fields

**Files:**
- Modify: `packages/shared/src/engines/synth2.ts`
- Test: `packages/shared/src/engines/synth2.test.ts`

Defaults are GENERATED by `buildDefaults()` (it groups descriptor rows by module prefix), so `params.lfo1.rate` etc. already populate once Task 1 landed. This task adds the **TypeScript interface** so consumers get real field names, plus a defaults test.

- [ ] **Step 1: Write the failing test**

Add to `packages/shared/src/engines/synth2.test.ts`, inside `describe('DEFAULT_SYNTH2_PARAMS', …)`:

```ts
  it('defaults LFO1 to 5 Hz sine and LFO2 to 0.5 Hz triangle (I3b)', () => {
    expect(DEFAULT_SYNTH2_PARAMS.lfo1).toEqual({ rate: 5, shape: 0 });
    expect(DEFAULT_SYNTH2_PARAMS.lfo2).toEqual({ rate: 0.5, shape: 1 });
  });
```

- [ ] **Step 2: Run typecheck to verify it fails**

Run: `npm run typecheck`
Expected: FAIL — `Property 'lfo1' does not exist on type 'Synth2EngineParams'` (and `lfo2`). Note: `npm test` alone would *pass* here, because `buildDefaults()` already emits `lfo1`/`lfo2` at runtime (Task 1) and Vitest/esbuild doesn't type-check — so the typed-access failure only shows up in `tsc`. The interface addition in Step 3 is what makes the typed access compile.

- [ ] **Step 3: Extend the params interface**

In `packages/shared/src/engines/synth2.ts`, add the interface near the other module interfaces (e.g. after `Synth2FmParams`):

```ts
export interface Synth2LfoParams {
  rate: number;   // Hz (0.01..2000)
  shape: number;  // 0..4 morph: sine → tri → saw-up → saw-down → square
}
```

Then add the two fields to `Synth2EngineParams` (place them after `fm`, mirroring descriptor grouping):

```ts
  fm: Synth2FmParams;
  lfo1: Synth2LfoParams;
  lfo2: Synth2LfoParams;
  env1: Synth2EnvParams;
```

Do **not** change `buildDefaults()` — it already produces `lfo1`/`lfo2` from the descriptor rows.

- [ ] **Step 4: Run typecheck + test to verify both pass**

Run: `npm run typecheck && npm test -w @fiddle/shared -- synth2.test`
Expected: PASS. Typecheck is now clean, and the existing `mirrors the descriptor table exactly` test (which iterates `SYNTH2_DESCRIPTORS`) plus the new defaults test are green.

- [ ] **Step 5: Run the gate and commit**

```bash
npm run typecheck && npm test
git add packages/shared/src/engines/synth2.ts packages/shared/src/engines/synth2.test.ts
git commit -m "feat(shared): Synth2LfoParams + lfo1/lfo2 on Synth2EngineParams (I3b)"
```

---

### Task 3: Shared — schema + accept-list contract tests (no production edits)

**Files:**
- Test: `packages/shared/src/project/schema.test.ts`
- Test: `packages/shared/src/project/accept-list.test.ts`

`schema.ts` (`synth2Modules` loop) and `accept-list.ts` (line ~73 `SYNTH2_DESCRIPTORS.map(...)` + `resolveLeafSchema` `SYNTH2_LEAF_SCHEMAS` branch) are fully descriptor-derived, so they already accept the LFO leaves. These tests **lock that derivation** so a future refactor can't silently drop it. **No production code changes in this task.**

- [ ] **Step 1: Write the failing tests**

Add to `packages/shared/src/project/schema.test.ts` (import `SYNTH2_LEAF_SCHEMAS` from `./schema.js` if not already imported):

```ts
describe('synth2 LFO leaf schemas (I3b)', () => {
  it('generates lfo rate/shape leaf schemas from the descriptor table', () => {
    expect(SYNTH2_LEAF_SCHEMAS['lfo1.rate'].safeParse(5).success).toBe(true);
    expect(SYNTH2_LEAF_SCHEMAS['lfo1.rate'].safeParse(0).success).toBe(false);     // < 0.01
    expect(SYNTH2_LEAF_SCHEMAS['lfo1.rate'].safeParse(2001).success).toBe(false);  // > 2000
    expect(SYNTH2_LEAF_SCHEMAS['lfo2.shape'].safeParse(0).success).toBe(true);
    expect(SYNTH2_LEAF_SCHEMAS['lfo2.shape'].safeParse(4).success).toBe(true);
    expect(SYNTH2_LEAF_SCHEMAS['lfo2.shape'].safeParse(4.1).success).toBe(false);  // > 4
  });
});
```

Add to `packages/shared/src/project/accept-list.test.ts` (import `validatePathAndValue`, `pathIsWritable` from `./accept-list.js` if not already):

```ts
describe('synth2 LFO accept-list (I3b)', () => {
  it('accepts in-range lfo leaves and rejects out-of-range / bad paths', () => {
    expect(pathIsWritable('tracks.0.engines.synth2.lfo1.rate')).toBe(true);
    expect(pathIsWritable('tracks.0.engines.synth2.lfo2.shape')).toBe(true);
    expect(validatePathAndValue('tracks.0.engines.synth2.lfo1.rate', 12).ok).toBe(true);
    expect(validatePathAndValue('tracks.0.engines.synth2.lfo1.rate', 9000).ok).toBe(false);
    expect(validatePathAndValue('tracks.0.engines.synth2.lfo2.shape', 2).ok).toBe(true);
    expect(validatePathAndValue('tracks.0.engines.synth2.lfo2.shape', 5).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run to confirm they PASS immediately**

Run: `npm test -w @fiddle/shared -- schema accept-list`
Expected: PASS on first run (derivation already covers LFO leaves). This is the rare case where the test passes without an implementation step — that is the point: it *proves* the derivation. If either FAILS, the derivation is broken — investigate `schema.ts`/`accept-list.ts` rather than hand-listing leaves.

- [ ] **Step 3: Run the gate and commit**

```bash
npm run typecheck && npm test
git add packages/shared/src/project/schema.test.ts packages/shared/src/project/accept-list.test.ts
git commit -m "test(shared): lock lfo leaf schema + accept-list derivation (I3b)"
```

---

### Task 4: Kernel — `Lfo.ts` DSP module

**Files:**
- Create: `packages/client/src/engine/synth2/kernel/Lfo.ts`
- Test: `packages/client/src/engine/synth2/kernel/Lfo.test.ts`

Follows the `DspModule` convention (constructor takes its `ParamSlot`s; `reset()`; per-sample `next()`), mirroring `Noise.ts`. Bipolar −1..+1 output; computes the morphed waveform at the **current** phase, then advances (so the first sample after `reset()` is the waveform's phase-0 value).

- [ ] **Step 1: Write the failing test**

Create `packages/client/src/engine/synth2/kernel/Lfo.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Lfo } from './Lfo';
import { ParamSlot } from './ParamSlot';
import type { Synth2ParamDescriptor } from '@fiddle/shared';

const SR = 48000;

// Build a ParamSlot whose default IS the value we want (constructor sets
// current=target=default, so next() returns it with no smoother ramp).
const desc = (
  min: number, max: number, def: number,
  taper: 'linear' | 'expOctaves', modScale: number,
): Synth2ParamDescriptor => ({ key: 'lfo.test', min, max, default: def, taper, modulatable: true, modScale });

const lfoWith = (rate: number, shape: number) =>
  new Lfo(
    new ParamSlot(desc(0.01, 2000, rate, 'expOctaves', 4), SR),
    new ParamSlot(desc(0, 4, shape, 'linear', 1), SR),
    SR,
  );

const collect = (lfo: Lfo, n: number) => {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = lfo.next();
  return out;
};

describe('Lfo', () => {
  it('first sample after construction is the phase-0 waveform value', () => {
    expect(lfoWith(5, 0).next()).toBeCloseTo(0, 6);   // sine(0) = 0
    expect(lfoWith(5, 2).next()).toBeCloseTo(-1, 6);  // saw-up at phase 0 = -1
    expect(lfoWith(5, 4).next()).toBeCloseTo(1, 6);   // square first half = +1
  });

  it('completes one cycle per (sampleRate / rate) samples', () => {
    // 100 Hz sine: count positive-going zero crossings over 1 second ≈ 100.
    const lfo = lfoWith(100, 0);
    const buf = collect(lfo, SR);
    let crossings = 0;
    for (let i = 1; i < buf.length; i++) if (buf[i - 1] < 0 && buf[i] >= 0) crossings++;
    expect(crossings).toBeGreaterThanOrEqual(99);
    expect(crossings).toBeLessThanOrEqual(101);
  });

  it('every shape stays bipolar within [-1, 1]', () => {
    for (const shape of [0, 1, 2, 3, 4, 0.5, 2.5, 3.7]) {
      const buf = collect(lfoWith(37, shape), 4000);
      for (const v of buf) { expect(v).toBeLessThanOrEqual(1); expect(v).toBeGreaterThanOrEqual(-1); }
    }
  });

  it('square (shape 4) emits only ±1', () => {
    for (const v of collect(lfoWith(50, 4), 2000)) expect(Math.abs(v)).toBeCloseTo(1, 6);
  });

  it('shape 0.5 is the linear crossfade of sine and triangle', () => {
    // Same rate + both reset to phase 0 ⇒ phases stay in lockstep.
    const sine = lfoWith(7, 0), tri = lfoWith(7, 1), mid = lfoWith(7, 0.5);
    for (let i = 0; i < 3000; i++) {
      const s = sine.next(), t = tri.next(), m = mid.next();
      expect(m).toBeCloseTo(0.5 * s + 0.5 * t, 5);
    }
  });

  it('reset() returns the phase to 0', () => {
    const lfo = lfoWith(123, 0);
    collect(lfo, 137);            // advance to some mid-cycle phase
    lfo.reset();
    expect(lfo.next()).toBeCloseTo(0, 6); // sine(0) again
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @fiddle/client -- Lfo`
Expected: FAIL — `Cannot find module './Lfo'`.

- [ ] **Step 3: Implement `Lfo.ts`**

Create `packages/client/src/engine/synth2/kernel/Lfo.ts`:

```ts
// Per-voice LFO (spec §5.5): a bipolar −1..+1 morphed waveform that feeds the
// mod matrix as the lfo1/lfo2 sources. shape 0..4 linearly crossfades the
// adjacent waveforms sine → triangle → saw-up → saw-down → square. Naive
// (non-band-limited) by decision — band-limiting is a filed future follow-up.
// Pure, allocation-free (kernel ABI). next() must be called exactly once per
// rendered sample: it advances both ParamSlots' smoothers and the phase.

import type { ParamSlot } from './ParamSlot';

const TWO_PI = Math.PI * 2;

export class Lfo {
  private phase = 0; // [0, 1)

  constructor(
    private readonly rateSlot: ParamSlot,
    private readonly shapeSlot: ParamSlot,
    private readonly sampleRate: number,
  ) {}

  /** Note-on / voice-steal retrigger: restart the waveform. */
  reset(): void {
    this.phase = 0;
  }

  /** One bipolar −1..+1 sample. Computes at the current phase, then advances. */
  next(): number {
    const value = Lfo.wave(this.shapeSlot.next(), this.phase);
    const rate = this.rateSlot.next();
    this.phase += rate / this.sampleRate;
    if (this.phase >= 1) this.phase -= 1; // rate ≤ 2000 ≪ SR ⇒ at most one wrap
    return value;
  }

  /** Morphed shape s∈[0,4] at phase p∈[0,1): linear crossfade of two neighbours. */
  private static wave(s: number, p: number): number {
    const c = s < 0 ? 0 : s > 4 ? 4 : s;
    const i = Math.min(3, Math.floor(c)); // 0..3; i+1 reaches 4 (square)
    const f = c - i;
    return Lfo.base(i, p) * (1 - f) + Lfo.base(i + 1, p) * f;
  }

  /** A single naive waveform at phase p∈[0,1), bipolar −1..+1. */
  private static base(shape: number, p: number): number {
    switch (shape) {
      case 0: return Math.sin(TWO_PI * p);                       // sine
      case 1: return 1 - 4 * Math.abs(((p + 0.25) % 1) - 0.5);   // triangle (0 at p=0)
      case 2: return 2 * p - 1;                                   // saw-up
      case 3: return 1 - 2 * p;                                   // saw-down
      default: return p < 0.5 ? 1 : -1;                           // square (case 4)
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w @fiddle/client -- Lfo`
Expected: PASS (all 6 tests).

- [ ] **Step 5: Run the gate and commit**

```bash
npm run typecheck && npm test
git add packages/client/src/engine/synth2/kernel/Lfo.ts packages/client/src/engine/synth2/kernel/Lfo.test.ts
git commit -m "feat(client): Lfo kernel module — morphed bipolar LFO (I3b)"
```

---

### Task 5: Kernel — wire two LFOs into `Voice.ts`

**Files:**
- Modify: `packages/client/src/engine/synth2/kernel/Voice.ts`
- Test: `packages/client/src/engine/synth2/kernel/Voice.test.ts`

Reuse I3a's previous-sample source pattern exactly: feed `lfo1Prev`/`lfo2Prev` into `sources[]` at the loop top (before `matrix.apply`), capture the new values at the loop bottom, and reset both phase and prev on note-on.

- [ ] **Step 1: Write the failing test**

Add to `packages/client/src/engine/synth2/kernel/Voice.test.ts`, in a new `describe('Voice LFO sources (I3b)', …)` block:

```ts
describe('Voice LFO sources (I3b)', () => {
  const SR = 48000;

  it('routes lfo1 → osc1.level so the LFO audibly modulates the output', () => {
    const levelIdx = PARAM_INDEX['osc1.level'];
    const lfo1Src = MOD_SOURCES.indexOf('lfo1');
    const render = (route: boolean) => {
      const v = new Voice(SR, 1);
      v.slots[PARAM_INDEX['lfo1.rate']].setBase(200); // fast ⇒ clearly cyclic in-window
      if (route) v.setMatrixSlot(0, lfo1Src, levelIdx, 1);
      v.noteOn(220, 1.0, SR);
      const out = new Float32Array(4096);
      v.renderAdd(out, 0, 4096);
      return out;
    };
    const base = render(false), routed = render(true);
    let maxDiff = 0;
    for (let i = 0; i < base.length; i++) maxDiff = Math.max(maxDiff, Math.abs(base[i] - routed[i]));
    expect(maxDiff).toBeGreaterThan(0.01);
  });

  it('noteOn retriggers LFO phase so a reused voice has no bleed on the first sample', () => {
    // Mirrors the env1Prev bleed test: both voices share identical osc/filter/slot
    // state; only the LFO phase/prev differs between reset (real) and no-reset (broken).
    const lfo1Src = MOD_SOURCES.indexOf('lfo1');
    const levelIdx = PARAM_INDEX['osc1.level'];
    const gate = 11000;

    const a = new Voice(SR, 1); // warmed-up + retriggered → exercises the reset
    const b = new Voice(SR, 1); // fresh reference
    a.slots[PARAM_INDEX['lfo1.rate']].setBase(200);
    b.slots[PARAM_INDEX['lfo1.rate']].setBase(200);

    a.noteOn(220, 1.0, gate); b.noteOn(220, 1.0, gate);
    const buf = new Float32Array(gate);
    a.renderAdd(buf, 0, gate);          // advances A's LFO well past phase 0
    b.renderAdd(buf.fill(0), 0, gate);

    a.setMatrixSlot(0, lfo1Src, levelIdx, 1); // route on A only, after warmup
    a.noteOn(220, 1.0, SR); b.noteOn(220, 1.0, SR); // retrigger both

    const outA = new Float32Array(1); const outB = new Float32Array(1);
    a.renderAdd(outA, 0, 1); b.renderAdd(outB, 0, 1);
    // With phase + lfo1Prev reset: lfo1Prev=0 on the first frame ⇒ A's route is inert ⇒ A==B.
    expect(outA[0]).toBeCloseTo(outB[0], 6);
  });
});
```

(`Voice`, `MOD_SOURCES`, `PARAM_INDEX` are already imported at the top of `Voice.test.ts`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @fiddle/client -- Voice`
Expected: FAIL — `lfo1` source reads 0 (no LFO wired), so `maxDiff` is ~0 in the first test.

- [ ] **Step 3: Wire the LFOs into `Voice.ts`**

In `packages/client/src/engine/synth2/kernel/Voice.ts`:

(a) Add the import near the other kernel imports:
```ts
import { Lfo } from './Lfo';
```

(b) Add the source-index constants next to the existing `SRC_*` consts:
```ts
const SRC_LFO1 = MOD_SOURCES.indexOf('lfo1');
const SRC_LFO2 = MOD_SOURCES.indexOf('lfo2');
```

(c) Add fields (near `env1Prev`/`env2Prev`/`noisePrev`):
```ts
  private readonly lfo1: Lfo;
  private readonly lfo2: Lfo;
  private lfo1Prev = 0;
  private lfo2Prev = 0;
```

(d) In the constructor, after the existing slot wiring, instantiate the LFOs:
```ts
    this.lfo1 = new Lfo(slot('lfo1.rate'), slot('lfo1.shape'), sampleRate);
    this.lfo2 = new Lfo(slot('lfo2.rate'), slot('lfo2.shape'), sampleRate);
```

(e) In `noteOn`, alongside the existing prev resets, add the LFO retrigger + prev reset:
```ts
    this.env1Prev = 0;
    this.env2Prev = 0;
    this.noisePrev = 0;
    this.lfo1.reset();
    this.lfo2.reset();
    this.lfo1Prev = 0;
    this.lfo2Prev = 0;
```

(f) In `renderAdd`, at the loop **top** where the other sources are filled (before `this.matrix.apply(...)`), add:
```ts
      this.sources[SRC_LFO1] = this.lfo1Prev;
      this.sources[SRC_LFO2] = this.lfo2Prev;
```

(g) In `renderAdd`, at the loop **bottom** where `env1Prev`/`env2Prev`/`noisePrev` are captured, add the LFO advance + capture. **Each LFO's `next()` must run exactly once per sample**:
```ts
      this.lfo1Prev = this.lfo1.next();
      this.lfo2Prev = this.lfo2.next();
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w @fiddle/client -- Voice`
Expected: PASS. Also re-run the full kernel suite to confirm no regression in the matrix/slot once-per-sample invariants:
Run: `npm test -w @fiddle/client -- synth2`
Expected: PASS.

- [ ] **Step 5: Run the gate and commit**

```bash
npm run typecheck && npm test
git add packages/client/src/engine/synth2/kernel/Voice.ts packages/client/src/engine/synth2/kernel/Voice.test.ts
git commit -m "feat(client): wire lfo1/lfo2 into Voice as live matrix sources (I3b)"
```

---

### Task 6: Client — engine encode + sync round-trip tests (no production edits)

**Files:**
- Test: `packages/client/src/engine/Synth2Engine.test.ts`
- Test: `packages/client/src/composables/useSynth.test.ts`

LFO leaves are ordinary numeric descriptor leaves one level under `engines.synth2` (like `osc1.morph`), so the engine's descriptor-walk encode, the kernel block layout, and the `emitLeafDiff` sync watcher already cover them. These tests lock that. **No production code changes.**

- [ ] **Step 1: Write the engine encode test**

Add to `packages/client/src/engine/Synth2Engine.test.ts`, inside `describe('Synth2Engine protocol', …)`:

```ts
  it('encodes lfo leaves into the param block via the descriptor walk (I3b)', () => {
    const engine = new Synth2Engine(mockCtx());
    engine.applyParams({ lfo1: { rate: 12, shape: 2 }, lfo2: { rate: 3 } });
    const msg = lastNode(engine).port.posted.at(-1);
    expect(msg.type).toBe('params');
    expect(msg.block[PARAM_INDEX['lfo1.rate']]).toBeCloseTo(12);
    expect(msg.block[PARAM_INDEX['lfo1.shape']]).toBeCloseTo(2);
    expect(msg.block[PARAM_INDEX['lfo2.rate']]).toBeCloseTo(3);
    // untouched lfo leaf stays at its default
    expect(msg.block[PARAM_INDEX['lfo2.shape']]).toBeCloseTo(DEFAULT_SYNTH2_PARAMS.lfo2.shape);
  });
```

- [ ] **Step 2: Write the sync round-trip tests**

Add to `packages/client/src/composables/useSynth.test.ts`, inside `describe('sync integration', …)`, next to the I3a matrix sync tests:

```ts
  it('emits a synth2 lfo1.rate change to a leaf path (throttled continuous) (I3b)', async () => {
    const { fake, synth } = await bootWithFakeSocket();
    synth.project.tracks[0].engines.synth2.lfo1.rate = 12;
    vi.advanceTimersByTime(50); // clear the throttle window
    const op = fake.sent.find(
      (o) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'engines', 'synth2', 'lfo1', 'rate']),
    );
    expect(op).toBeDefined();
    expect(op!.value).toBe(12);
    // never a whole-module write
    expect(fake.sent.some(
      (o) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'engines', 'synth2', 'lfo1']),
    )).toBe(false);
  });

  it('applies a remote lfo1.rate op without echoing it back out (I3b)', async () => {
    const { fake, synth } = await bootWithFakeSocket();
    fake._opts.onMessage({
      v: 1, type: 'set', opId: 1, clientId: 'other',
      path: ['tracks', 0, 'engines', 'synth2', 'lfo1', 'rate'], value: 7,
    });
    expect(synth.project.tracks[0].engines.synth2.lfo1.rate).toBe(7);
    vi.advanceTimersByTime(100);
    expect(fake.sent.some(
      (o) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'engines', 'synth2', 'lfo1', 'rate']),
    )).toBe(false);
  });
```

- [ ] **Step 3: Run to confirm they PASS immediately**

Run: `npm test -w @fiddle/client -- Synth2Engine useSynth`
Expected: PASS on first run — the derivation already covers the LFO leaves. If any FAILS, the derivation is broken (investigate the engine walk / watcher); do **not** special-case LFO.

- [ ] **Step 4: Run the gate and commit**

```bash
npm run typecheck && npm test
git add packages/client/src/engine/Synth2Engine.test.ts packages/client/src/composables/useSynth.test.ts
git commit -m "test(client): lock lfo encode + sync round-trip derivation (I3b)"
```

---

### Task 7: Client — `Synth2Panel.vue` LFO column

**Files:**
- Modify: `packages/client/src/components/Synth2Panel.vue`
- Test: `packages/client/src/components/Synth2Panel.test.ts`

Add an LFO column (two module-groups) between the FILTER ENV column and the MATRIX column. `rate` mirrors the existing wide-range `cutoff` knob (`format="hz"`); `shape` mirrors the `morph` knob (0..4 continuous).

- [ ] **Step 1: Write the failing test**

Add to `packages/client/src/components/Synth2Panel.test.ts`, a new `describe` block. Use the file's existing real-DOM harness: `mountPanel(params)` (which does `createApp(Synth2Panel, { params, analyser: null, color }).mount(host)`) and `querySelectorAll`. `Knob.vue` renders its label as `<label class="knob-label">`; `Synth2Engine.DEFAULT_PARAMS` now carries `lfo1`/`lfo2`. No other panel knob is labelled `Rate` or `Shape`, so each must appear exactly twice (LFO1 + LFO2):

```ts
describe('Synth2Panel LFO column (I3b)', () => {
  it('renders LFO1 + LFO2 rate/shape knobs', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    const labels = Array.from(el.querySelectorAll<HTMLLabelElement>('.knob-label'))
      .map((n) => n.textContent?.trim());
    expect(labels.filter((l) => l === 'Rate')).toHaveLength(2);
    expect(labels.filter((l) => l === 'Shape')).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @fiddle/client -- Synth2Panel`
Expected: FAIL — no `Rate`/`Shape` knobs rendered yet.

- [ ] **Step 3: Add the LFO column**

In `packages/client/src/components/Synth2Panel.vue`, insert a new column between the `<!-- Column 6: Filter envelope (env2) -->` block and the `<!-- Column 7: Mod matrix -->` block. Renumber the trailing comments (matrix → Column 8, visualizer → Column 9):

```html
    <!-- Column 7: LFOs -->
    <div class="rack-column">
      <div class="module-group">
        <h3>LFO 1</h3>
        <div class="knob-row">
          <Knob label="Rate" :min="0.01" :max="2000" :step="0.01" format="hz" :defaultValue="DEFAULTS.lfo1.rate" v-model="params.lfo1.rate" :syncPath="ks.pathFor(['lfo1', 'rate'])" @gesture-end="ks.end(['lfo1', 'rate'])" />
          <Knob label="Shape" :min="0" :max="4" :step="0.01" :defaultValue="DEFAULTS.lfo1.shape" v-model="params.lfo1.shape" :syncPath="ks.pathFor(['lfo1', 'shape'])" @gesture-end="ks.end(['lfo1', 'shape'])" />
        </div>
      </div>
      <div class="module-group">
        <h3>LFO 2</h3>
        <div class="knob-row">
          <Knob label="Rate" :min="0.01" :max="2000" :step="0.01" format="hz" :defaultValue="DEFAULTS.lfo2.rate" v-model="params.lfo2.rate" :syncPath="ks.pathFor(['lfo2', 'rate'])" @gesture-end="ks.end(['lfo2', 'rate'])" />
          <Knob label="Shape" :min="0" :max="4" :step="0.01" :defaultValue="DEFAULTS.lfo2.shape" v-model="params.lfo2.shape" :syncPath="ks.pathFor(['lfo2', 'shape'])" @gesture-end="ks.end(['lfo2', 'shape'])" />
        </div>
      </div>
    </div>
```

No script or style changes are needed (the column reuses `module-group`/`knob-row`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w @fiddle/client -- Synth2Panel`
Expected: PASS.

- [ ] **Step 5: Full gate + build, then commit**

```bash
npm run typecheck && npm test && npm run build
git add packages/client/src/components/Synth2Panel.vue packages/client/src/components/Synth2Panel.test.ts
git commit -m "feat(client): Synth2Panel LFO column (rate + shape) (I3b)"
```
Expected: gate green; `npm run build` emits `worklets/synth2-processor.js` (the bundle now includes `Lfo`).

---

## Verification (end-to-end)

- **Gate:** `npm run typecheck && npm test && npm run build` across all 3 workspaces; build emits `worklets/synth2-processor.js` containing the LFO code.
- **Append-only:** `SYNTH2_DESCRIPTORS` grew by exactly 4 rows at the tail; `MOD_SOURCES` unchanged.
- **Allocation discipline:** spot-check `Lfo.next()` and `Voice.renderAdd()` — no `new`, no array growth in the per-sample path.
- **Browser (Playwright MCP, then close the session — AGENTS.md cleanup rule):**
  1. `npm run dev`; create/open a session; add a synth2 track.
  2. In the matrix, set a slot `source: lfo1`, `dest: filter.cutoff`, amount ≈ 0.6. Enter a step; Play — confirm the cutoff wobbles at ~5 Hz (the LFO1 default).
  3. Turn LFO1 **Rate** up — the wobble speeds up; turn **Shape** across 0→4 — the modulation contour changes (sine → … → square).
  4. Route `lfo2 → lfo1.rate` (amount > 0) to confirm LFO→LFO modulation works (LFO1 speed drifts).
  5. Two-client check: change `lfo1.rate` in client A; confirm client B converges and the audible rate follows.
  6. **Close the browser/session.**
- Keep the branch after verify — user browser-verifies before merge (don't auto-merge).

## Out of scope (later slices)

- env3 + loop mode on all envelopes → **I3c** (`env3` stays an inert source).
- Morph filter (`filter.model` enum + `filter.morph` + `MorphFilter`) → **I3d**.
- Free-running / global LFO mode, tempo-synced rates → **I4** niceties.
- **Band-limited (PolyBLEP) LFO shapes** → filed future follow-up (naive shapes ship in v1).
- Server-side old-session deep-heal → known-deferred backlog item.
