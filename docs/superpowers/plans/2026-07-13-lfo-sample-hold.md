# LFO Sample & Hold / Smooth Random Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each synth2 per-voice LFO a 3-state Mode — Off (today's morph), S&H (stepped random), Smooth (interpolated random) — selectable from a segmented UI control.

**Architecture:** Two append-only enum descriptor rows (`lfo1.mode`, `lfo2.mode`) auto-plumb the accept-list, schema, defaults, and Float32 param-block layout — same as `filter.type`. `mode` is a *real kernel param* (unlike `sync`/`div`): the `Lfo` kernel class reads it per-sample and, for S&H/Smooth, draws a per-cycle random value from a per-instance xorshift32 PRNG (the `Noise.ts` generator), holding it (S&H) or ramping between targets (Smooth). The UI adds a segmented `OFF | S&H | SMOOTH` control mirroring the existing `.filter-type-selector`, hides the Shape knob when mode ≠ Off, and passes mode to the wave preview.

**Tech Stack:** TypeScript, Vue 3, Web Audio AudioWorklet, Vitest. Monorepo workspaces `@fiddle/shared` + `@fiddle/client`.

## Global Constraints

- **Append-only descriptors:** never reorder or insert into `SYNTH2_DESCRIPTORS` — the array index IS the param-block ABI. New rows go at the **end** of the array.
- **Off is unchanged:** `mode` default is `0` (`'off'`) everywhere; every existing/new track and preset must behave byte-for-byte as today until explicitly switched.
- **Kernel ABI:** `Lfo` stays pure and allocation-free; `next()` advances all its ParamSlots' smoothers **and** the phase **exactly once per rendered sample**.
- **Enum storage:** the store leaf holds the label string (`'off' | 's&h' | 'smooth'`), like `filter.type`; the kernel reads the numeric index (0/1/2) from the block.
- **Determinism:** the PRNG is per-voice deterministic (xorshift32 seeded), re-seeded on `reset()`; lfo1 and lfo2 get **distinct** seeds.
- **Local run:** browser verification uses `npm run dev:obs` (LOCAL Docker DB) — **never** `npm run dev` (prod Supabase).
- **Never stage** the untracked scratch files (`studio-focused.md`, `studio-initial.png`, `synth2-wave-previews.png`).
- Branch is `feat/lfo-sample-hold` (already created).

---

### Task 1: Shared descriptor rows + interface field

Adds the two `lfoN.mode` enum descriptors and the `Synth2LfoParams.mode` field. All derived
artifacts (accept-list `PATTERNS`, `SYNTH2_LEAF_SCHEMAS`, `SYNTH2_ENUM_VALUES`, `buildDefaults`,
`PARAM_INDEX`, block layout) update automatically from the table.

**Files:**
- Modify: `packages/shared/src/engines/synth2-descriptors.ts` (add `LFO_MODE_LABELS`; append 2 rows before the closing `];` at line 194)
- Modify: `packages/shared/src/engines/synth2.ts` (add `mode` to `Synth2LfoParams`, ~line 49)
- Test: `packages/shared/src/engines/synth2.test.ts` (update lfo1/lfo2 default assertions, lines 63-64)

**Interfaces:**
- Produces: `LFO_MODE_LABELS: readonly ['off','s&h','smooth']` (exported from `@fiddle/shared`); descriptor keys `'lfo1.mode'` / `'lfo2.mode'`; `Synth2LfoParams.mode: 'off' | 's&h' | 'smooth'`.

- [ ] **Step 1: Update the failing default test first (TDD)**

In `packages/shared/src/engines/synth2.test.ts`, change the two LFO default assertions (lines 63-64) to include `mode`:

```ts
    expect(DEFAULT_SYNTH2_PARAMS.lfo1).toEqual({ rate: 5, shape: 0, sync: false, div: '1/16', mode: 'off' });
    expect(DEFAULT_SYNTH2_PARAMS.lfo2).toEqual({ rate: 0.5, shape: 1, sync: false, div: '1/16', mode: 'off' });
```

- [ ] **Step 2: Run the shared tests to verify they fail**

Run: `npm run test -w @fiddle/shared`
Expected: FAIL — the `lfo1`/`lfo2` defaults still lack `mode` (`toEqual` mismatch), and the leaf-count agreement test (`leafCount === SYNTH2_DESCRIPTORS.length`) is still balanced (both change together in Step 3).

- [ ] **Step 3: Add the label constant + descriptor rows**

In `packages/shared/src/engines/synth2-descriptors.ts`, add the constant just below the imports (near the top, after the `LFO_SYNC_*` import line ~12):

```ts
/** LFO Mode enum (2026-07-13). Off = continuous morph; S&H = stepped random;
 *  Smooth = interpolated random. Stored as the label; kernel reads the index. */
export const LFO_MODE_LABELS = ['off', 's&h', 'smooth'] as const;
```

Then append two rows immediately **before** the closing `];` of `SYNTH2_DESCRIPTORS` (currently line 194), after the `env3.rDiv` row:

```ts
  // --- LFO random modes (2026-07-13, append-only). A REAL kernel enum (unlike
  // lfo*.sync/div which are main-thread-only): the Lfo kernel reads mode per
  // sample. 0 off = continuous morph; 1 s&h = per-cycle stepped random; 2 smooth
  // = linearly-interpolated random. Not modulatable. Mirrors filter.type's kind.
  { key: 'lfo1.mode', min: 0, max: 2, default: 0, taper: 'linear', modulatable: false, modScale: 0, kind: 'enum', enumValues: LFO_MODE_LABELS },
  { key: 'lfo2.mode', min: 0, max: 2, default: 0, taper: 'linear', modulatable: false, modScale: 0, kind: 'enum', enumValues: LFO_MODE_LABELS },
```

- [ ] **Step 4: Add the interface field**

In `packages/shared/src/engines/synth2.ts`, add to `Synth2LfoParams` (after the `div` field, ~line 48):

```ts
  mode: 'off' | 's&h' | 'smooth'; // Off = continuous morph; S&H / Smooth = random (shape ignored)
```

- [ ] **Step 5: Run the shared tests to verify they pass**

Run: `npm run test -w @fiddle/shared`
Expected: PASS. `buildDefaults()` now emits `mode: 'off'` for lfo1/lfo2 (decoded from the enum default index 0), the two `toEqual` assertions match, and `leafCount` (+2) equals `SYNTH2_DESCRIPTORS.length` (+2).

- [ ] **Step 6: Typecheck shared**

Run: `npm run typecheck -w @fiddle/shared`
Expected: PASS. The descriptor↔interface agreement is satisfied; no other literal `Synth2LfoParams` exists in shared.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/engines/synth2-descriptors.ts packages/shared/src/engines/synth2.ts packages/shared/src/engines/synth2.test.ts
git commit -m "feat(shared): lfo1/lfo2 mode enum descriptor (off/s&h/smooth)"
```

---

### Task 2: Kernel — S&H + Smooth in `Lfo`, wired through `Voice`

Rewrites `Lfo` to accept a `modeSlot` + seed, adds the xorshift32 PRNG and held-value state, and
implements the S&H / Smooth generation. `Voice` threads `lfoN.mode` and distinct seeds. Signature
change and its only call site travel together so the client keeps building.

**Files:**
- Modify: `packages/client/src/engine/synth2/kernel/Lfo.ts` (whole class)
- Modify: `packages/client/src/engine/synth2/kernel/Voice.ts:109-110` (constructor wiring)
- Test: `packages/client/src/engine/synth2/kernel/Lfo.test.ts` (helper signature + new cases)

**Interfaces:**
- Consumes: descriptor key `'lfo1.mode'` / `'lfo2.mode'` (Task 1) via `slot('lfoN.mode')`.
- Produces: `new Lfo(rateSlot, shapeSlot, modeSlot, sampleRate, seed?)`; instance methods `next(): number`, `reset(): void`; unchanged static `Lfo.wave(s, p): number`.

- [ ] **Step 1: Update the test helper + add failing tests**

Replace the helper block and add cases in `packages/client/src/engine/synth2/kernel/Lfo.test.ts`. Change `lfoWith` to build a third `modeSlot` and accept `mode`/`seed`, then append the new `describe` block. Full replacement for lines 15-20 (the `lfoWith` const) plus new tests before the final `});`:

```ts
const lfoWith = (rate: number, shape: number, mode = 0, seed = 1) =>
  new Lfo(
    new ParamSlot(desc(0.01, 2000, rate, 'expOctaves', 4), SR),
    new ParamSlot(desc(0, 4, shape, 'linear', 1), SR),
    new ParamSlot(desc(0, 2, mode, 'linear', 0), SR),
    SR,
    seed,
  );
```

Add these tests (inside the top-level `describe('Lfo', ...)`, before its closing `});`):

```ts
  // rate = SR/100 ⇒ phase steps 0.01/sample ⇒ a new cycle every 100 samples.
  const CYCLE = 100;
  const shRate = SR / CYCLE;

  it('S&H holds a constant value across each cycle and only steps at wraps', () => {
    const buf = collect(lfoWith(shRate, 0, 1, 42), 3 * CYCLE);
    const changes: number[] = [];
    for (let i = 1; i < buf.length; i++) if (buf[i] !== buf[i - 1]) changes.push(i);
    // Exactly one step per completed cycle, each ~CYCLE samples apart.
    expect(changes.length).toBeGreaterThanOrEqual(2);
    expect(changes.length).toBeLessThanOrEqual(3);
    for (const c of changes) expect(Math.abs((c % CYCLE)) <= 1 || Math.abs((c % CYCLE) - CYCLE) <= 1).toBe(true);
    for (const v of buf) { expect(v).toBeLessThanOrEqual(1); expect(v).toBeGreaterThanOrEqual(-1); }
  });

  it('S&H is deterministic per seed and reproducible after reset', () => {
    const a = lfoWith(shRate, 0, 1, 42);
    const b = lfoWith(shRate, 0, 1, 42);
    expect([...collect(a, 400)]).toEqual([...collect(b, 400)]);
    const c = lfoWith(shRate, 0, 1, 7);
    expect([...collect(c, 400)]).not.toEqual([...collect(lfoWith(shRate, 0, 1, 42), 400)]);
    const r = lfoWith(shRate, 0, 1, 42);
    const first = [...collect(r, 400)];
    r.reset();
    expect([...collect(r, 400)]).toEqual(first);
  });

  it('Smooth starts flat, is continuous, and passes through the S&H targets', () => {
    const smooth = collect(lfoWith(shRate, 0, 2, 42), 3 * CYCLE);
    // First cycle (before the first wrap) is flat: prev == curr at construction.
    for (let i = 1; i < CYCLE - 1; i++) expect(smooth[i]).toBeCloseTo(smooth[0], 6);
    // No discontinuity: per-sample delta bounded by the ramp step (target span ≤ 2 over CYCLE).
    for (let i = 1; i < smooth.length; i++) expect(Math.abs(smooth[i] - smooth[i - 1])).toBeLessThan(0.05);
    // At the end of a cycle the smooth ramp has reached that cycle's S&H target.
    const sh = collect(lfoWith(shRate, 0, 1, 42), 3 * CYCLE);
    expect(smooth[2 * CYCLE - 2]).toBeCloseTo(sh[2 * CYCLE - 2], 2);
  });

  it('Off mode (0) is byte-identical to the static morph waveform', () => {
    const buf = collect(lfoWith(37, 2.3, 0, 99), 2000);
    // Re-derive phase the same way and compare to Lfo.wave.
    let phase = 0;
    for (let i = 0; i < buf.length; i++) {
      expect(buf[i]).toBeCloseTo(Lfo.wave(2.3, phase), 6);
      phase += 37 / SR; if (phase >= 1) phase -= 1;
    }
  });
```

- [ ] **Step 2: Run the LFO tests to verify they fail**

Run: `npm run test -w @fiddle/client -- src/engine/synth2/kernel/Lfo.test.ts`
Expected: FAIL to compile — `Lfo` constructor currently takes 3 args, the helper now passes 5; the S&H/Smooth cases have no implementation.

- [ ] **Step 3: Rewrite `Lfo.ts`**

Replace the entire contents of `packages/client/src/engine/synth2/kernel/Lfo.ts` with:

```ts
// Per-voice LFO (spec §5.5 + random modes 2026-07-13): a bipolar −1..+1 signal
// feeding the mod matrix as the lfo1/lfo2 sources.
//
//   mode 0 Off    — a morphed waveform. shape 0..4 linearly crossfades the
//                   adjacent waveforms sine → triangle → saw-up → saw-down →
//                   square. Naive (non-band-limited) by decision — band-limiting
//                   is a filed future follow-up.
//   mode 1 S&H    — each cycle (phase wrap) draw a fresh random value in [−1,+1)
//                   and hold it flat until the next wrap. shape is ignored.
//   mode 2 Smooth — the same per-cycle random targets, but the output ramps
//                   linearly from the previous target to the new one across the
//                   cycle (one segment per cycle, no discontinuity). shape ignored.
//
// Randomness is a per-instance xorshift32 (the Noise.ts generator), deterministic
// from the seed and re-seeded on reset() — reproducible per voice, no shared state.
// Pure, allocation-free (kernel ABI §6.7). next() must be called exactly once per
// rendered sample: it advances all three ParamSlots' smoothers and the phase.

import type { ParamSlot } from './ParamSlot';

const TWO_PI = Math.PI * 2;

export class Lfo {
  private phase = 0;   // [0, 1)
  private rngState: number;
  private prev = 0;    // previous random target (Smooth ramp start)
  private curr = 0;    // current random target (S&H hold value / Smooth ramp end)

  constructor(
    private readonly rateSlot: ParamSlot,
    private readonly shapeSlot: ParamSlot,
    private readonly modeSlot: ParamSlot,
    private readonly sampleRate: number,
    private readonly seed = 1,
  ) {
    this.rngState = (seed | 0) || 0x9e3779b9; // avoid the xorshift zero fixed-point
    this.curr = this.draw();
    this.prev = this.curr;
  }

  /** Note-on / voice-steal retrigger: restart the waveform and re-seed the RNG so
   *  the random sequence is reproducible per voice. */
  reset(): void {
    this.phase = 0;
    this.rngState = (this.seed | 0) || 0x9e3779b9;
    this.curr = this.draw();
    this.prev = this.curr;
  }

  /** One bipolar −1..+1 sample. Advances all slot smoothers and the phase. */
  next(): number {
    const shape = this.shapeSlot.next();          // read every sample (ABI: advance smoother)
    const mode = Math.round(this.modeSlot.next()); // 0/1/2; snap, not smoothed (an enum)
    const rate = this.rateSlot.next();

    if (mode <= 0) {
      // Off: value at the current phase, then advance (unchanged behavior).
      const value = Lfo.wave(shape, this.phase);
      this.advance(rate);
      return value;
    }

    // S&H / Smooth: advance first; redraw on wrap; then read the held / ramped value.
    const wrapped = this.advance(rate);
    if (wrapped) { this.prev = this.curr; this.curr = this.draw(); }
    return mode === 1 ? this.curr : this.prev + (this.curr - this.prev) * this.phase;
  }

  /** Advance the phase by one sample at `rate`; returns true if it wrapped. */
  private advance(rate: number): boolean {
    this.phase += rate / this.sampleRate;
    if (this.phase >= 1) { this.phase -= 1; return true; } // rate ≤ 2000 ≪ SR ⇒ ≤ one wrap
    return false;
  }

  /** One xorshift32 draw mapped to [−1, +1). */
  private draw(): number {
    let x = this.rngState;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.rngState = x >>> 0;
    return (this.rngState / 0xffffffff) * 2 - 1;
  }

  /** Morphed shape s∈[0,4] at phase p∈[0,1): linear crossfade of two neighbours. */
  static wave(s: number, p: number): number {
    const c = s < 0 ? 0 : s > 4 ? 4 : s;
    const i = Math.min(3, Math.floor(c)); // 0..3; i+1 reaches 4 (square)
    const f = c - i;
    return Lfo.base(i, p) * (1 - f) + Lfo.base(i + 1, p) * f;
  }

  /** A single naive waveform at phase p∈[0,1), bipolar −1..+1. */
  private static base(shape: number, p: number): number {
    switch (shape) {
      case 0: return Math.sin(TWO_PI * p);                        // sine
      case 1: return 1 - 4 * Math.abs(((p + 0.25) % 1) - 0.5);  // triangle: shift peak to p=0.25, fold around 0.5, scale to [-1,1] (0 at p=0)
      case 2: return 2 * p - 1;                                   // saw-up
      case 3: return 1 - 2 * p;                                   // saw-down
      default: return p < 0.5 ? 1 : -1;                           // square (case 4)
    }
  }
}
```

- [ ] **Step 4: Wire `Voice` — modeSlot + distinct seeds**

In `packages/client/src/engine/synth2/kernel/Voice.ts`, replace the two `Lfo` constructor lines (109-110):

```ts
    this.lfo1 = new Lfo(slot('lfo1.rate'), slot('lfo1.shape'), slot('lfo1.mode'), sampleRate, (seed ^ 0xa5a5a5a5) | 0);
    this.lfo2 = new Lfo(slot('lfo2.rate'), slot('lfo2.shape'), slot('lfo2.mode'), sampleRate, (seed ^ 0x5a5a5a5a) | 0);
```

(The two XOR masks give lfo1, lfo2, and the noise source — seeded with the raw `seed` — distinct, deterministic, non-zero streams.)

- [ ] **Step 5: Run the LFO tests to verify they pass**

Run: `npm run test -w @fiddle/client -- src/engine/synth2/kernel/Lfo.test.ts`
Expected: PASS — all existing cases (mode defaults to 0) plus the four new S&H/Smooth/Off/determinism cases.

- [ ] **Step 6: Typecheck the client**

Run: `npm run typecheck:client`
Expected: PASS — `Voice.ts` matches the new 5-arg `Lfo` signature; no other `Lfo` constructor call sites exist.

- [ ] **Step 7: Commit**

```bash
git add packages/client/src/engine/synth2/kernel/Lfo.ts packages/client/src/engine/synth2/kernel/Voice.ts packages/client/src/engine/synth2/kernel/Lfo.test.ts
git commit -m "feat(client): Lfo S&H + Smooth random modes (per-voice xorshift32)"
```

---

### Task 3: Preview — stable random thumbnail

Extends `renderLfoShape` to render S&H / Smooth with a fixed seed (stable, no flicker) by driving a
real `Lfo`, and adds a `mode` prop to `WavePreview.vue` (default `'off'` so nothing else changes yet).

**Files:**
- Modify: `packages/client/src/engine/synth2/preview/wavePreview.ts` (LFO descriptors + `renderLfoShape` signature)
- Modify: `packages/client/src/components/WavePreview.vue` (`mode` prop + forward)
- Test: `packages/client/src/engine/synth2/preview/wavePreview.test.ts` (new S&H/Smooth cases)

**Interfaces:**
- Consumes: `new Lfo(...)` (Task 2); descriptor keys `lfo1.rate/shape/mode` (Tasks 1-2).
- Produces: `renderLfoShape(shape: number, mode?: 'off' | 's&h' | 'smooth'): Float32Array`; `WavePreview` prop `mode?: 'off' | 's&h' | 'smooth'`.

- [ ] **Step 1: Add failing preview tests**

In `packages/client/src/engine/synth2/preview/wavePreview.test.ts`, add inside `describe('renderLfoShape', ...)` (before its closing `});`):

```ts
  it('s&h is stepped, stable across calls, and in range', () => {
    const a = renderLfoShape(0, 's&h');
    const b = renderLfoShape(0, 's&h');
    expect(a.length).toBe(PREVIEW_POINTS);
    expect([...a]).toEqual([...b]); // fixed seed ⇒ no flicker on redraw
    for (const v of a) { expect(v).toBeLessThanOrEqual(1); expect(v).toBeGreaterThanOrEqual(-1); }
    // Stepped: at least one flat run and at least one jump across the buffer.
    let flats = 0, jumps = 0;
    for (let i = 1; i < a.length; i++) (a[i] === a[i - 1] ? flats++ : jumps++);
    expect(flats).toBeGreaterThan(0);
    expect(jumps).toBeGreaterThan(0);
  });

  it('smooth is continuous and stable across calls', () => {
    const a = renderLfoShape(0, 'smooth');
    const b = renderLfoShape(0, 'smooth');
    expect([...a]).toEqual([...b]);
    for (let i = 1; i < a.length; i++) expect(Math.abs(a[i] - a[i - 1])).toBeLessThan(0.1);
  });

  it('defaults to the off morph when mode is omitted', () => {
    expect([...renderLfoShape(2.3)]).toEqual([...renderLfoShape(2.3, 'off')]);
  });
```

- [ ] **Step 2: Run the preview tests to verify they fail**

Run: `npm run test -w @fiddle/client -- src/engine/synth2/preview/wavePreview.test.ts`
Expected: FAIL — `renderLfoShape` accepts only one argument today.

- [ ] **Step 3: Extend `renderLfoShape`**

In `packages/client/src/engine/synth2/preview/wavePreview.ts`, add the LFO descriptor lookups near the existing OSC ones (after line 46):

```ts
const LFO_RATE = SYNTH2_DESCRIPTORS[PARAM_INDEX['lfo1.rate']];
const LFO_SHAPE = SYNTH2_DESCRIPTORS[PARAM_INDEX['lfo1.shape']];
const LFO_MODE = SYNTH2_DESCRIPTORS[PARAM_INDEX['lfo1.mode']];
// Fixed seed so the random thumbnail never flickers between redraws.
const LFO_PREVIEW_SEED = 0x1234abcd;
// Rate that spans PREVIEW_CYCLES cycles across PREVIEW_POINTS samples (≈281 Hz).
const LFO_PREVIEW_RATE = (PREVIEW_CYCLES * PREVIEW_SR) / PREVIEW_POINTS;
```

Add the `Lfo` import at the top if not already present — it is (line 8: `import { Lfo } from '../kernel/Lfo';`).

Replace the whole `renderLfoShape` function (lines 85-92) with:

```ts
export function renderLfoShape(
  shape: number,
  mode: 'off' | 's&h' | 'smooth' = 'off',
): Float32Array {
  const out = new Float32Array(PREVIEW_POINTS);
  if (mode === 'off') {
    for (let i = 0; i < PREVIEW_POINTS; i++) {
      const phase = ((i / PREVIEW_POINTS) * PREVIEW_CYCLES) % 1;
      out[i] = Lfo.wave(shape, phase);
    }
    return out;
  }
  // S&H / Smooth: drive the real kernel Lfo (single source of truth for the DSP)
  // at a fixed rate + seed so PREVIEW_CYCLES random steps fill the thumbnail.
  const lfo = new Lfo(
    slotWithValue(LFO_RATE, LFO_PREVIEW_RATE),
    slotWithValue(LFO_SHAPE, 0),
    slotWithValue(LFO_MODE, mode === 's&h' ? 1 : 2),
    PREVIEW_SR,
    LFO_PREVIEW_SEED,
  );
  for (let i = 0; i < PREVIEW_POINTS; i++) out[i] = lfo.next();
  return out;
}
```

- [ ] **Step 4: Run the preview tests to verify they pass**

Run: `npm run test -w @fiddle/client -- src/engine/synth2/preview/wavePreview.test.ts`
Expected: PASS — including the existing "equals Lfo.wave" case (mode defaults to `'off'`).

- [ ] **Step 5: Add the `mode` prop to `WavePreview.vue`**

In `packages/client/src/components/WavePreview.vue`, add `mode` to the props (in the `defineProps` object, ~line 16) and its default (~line 19):

```ts
    shape?: number;
    mode?: 'off' | 's&h' | 'smooth';
    color?: string;
  }>(),
  { morph: 0, pulseWidth: 0.5, shape: 0, mode: 'off', color: '#00f0ff' },
```

Update the `samples` computed (line 28) to forward mode:

```ts
  props.kind === 'lfo' ? renderLfoShape(props.shape, props.mode) : renderOscShape(props.morph, props.pulseWidth),
```

(The existing `watch([samples, ...])` already repaints when `samples` recomputes, so a mode change redraws with no extra wiring.)

- [ ] **Step 6: Run the WavePreview component tests + typecheck**

Run: `npm run test -w @fiddle/client -- src/components/WavePreview.test.ts && npm run typecheck:client`
Expected: PASS — the mock ignores the extra arg; the `mode` prop defaults to `'off'`.

- [ ] **Step 7: Commit**

```bash
git add packages/client/src/engine/synth2/preview/wavePreview.ts packages/client/src/components/WavePreview.vue packages/client/src/engine/synth2/preview/wavePreview.test.ts
git commit -m "feat(client): lfo wave preview renders S&H / Smooth (fixed seed)"
```

---

### Task 4: UI — segmented mode control in `Synth2Panel`

Adds the `OFF | S&H | SMOOTH` segmented control per LFO (mirroring `.filter-type-selector`), hides
the Shape knob when mode ≠ Off, and passes `mode` to the preview.

**Files:**
- Modify: `packages/client/src/components/Synth2Panel.vue` (LFO 1 + LFO 2 blocks, lines 181-198; CSS)
- Test: `packages/client/src/components/Synth2Panel.test.ts` (mode control present + writes `lfoN.mode`)

**Interfaces:**
- Consumes: store leaf `params.lfoN.mode` (Task 1); `WavePreview` `mode` prop (Task 3); `ks.set(['lfoN','mode'], label)`.

- [ ] **Step 1: Add a failing panel test**

Open `packages/client/src/components/Synth2Panel.test.ts` to match its existing mount/query helpers, then add a test asserting the mode control renders three buttons for LFO 1 and clicking `S&H` writes the leaf. Use the file's established mounting pattern (the same one its other tests use, e.g. how it asserts the `SYNC` button). Concretely:

```ts
  it('renders the LFO mode control and writes lfo1.mode on click', async () => {
    const { host, setSpy } = mountPanel(); // reuse this file's existing mount helper
    const seg = host.querySelector('.lfo-mode-selector');
    expect(seg).not.toBeNull();
    const buttons = seg!.querySelectorAll('.lfo-mode-btn');
    expect(buttons.length).toBe(3); // OFF / S&H / SMOOTH
    (buttons[1] as HTMLButtonElement).click(); // S&H
    await nextTick();
    expect(setSpy).toHaveBeenCalledWith(['lfo1', 'mode'], 's&h');
  });
```

If this test file has no reusable mount helper exposing the `ks.set` spy, model the new test on the closest existing test in that file (adapt the assertion to however it already spies on `ks`/`useKnobSync`). The behavioral contract to assert is fixed: **three `.lfo-mode-btn` buttons under `.lfo-mode-selector`, and clicking the second calls `ks.set(['lfo1','mode'], 's&h')`.**

- [ ] **Step 2: Run the panel test to verify it fails**

Run: `npm run test -w @fiddle/client -- src/components/Synth2Panel.test.ts`
Expected: FAIL — `.lfo-mode-selector` does not exist yet.

- [ ] **Step 3: Add the segmented control + hide Shape (LFO 1)**

In `packages/client/src/components/Synth2Panel.vue`, replace the LFO 1 block (lines 181-188) with:

```html
        <h3>LFO 1</h3>
        <WavePreview kind="lfo" :shape="params.lfo1.shape" :mode="params.lfo1.mode" :color="color" />
        <div class="knob-row">
          <Knob v-if="!params.lfo1.sync" label="Rate" :min="0.01" :max="2000" :step="0.01" format="hz" curve="exp" :defaultValue="DEFAULTS.lfo1.rate" :modelValue="params.lfo1.rate" @update:modelValue="ks.set(['lfo1', 'rate'], $event)" :syncPath="ks.pathFor(['lfo1', 'rate'])" @gesture-end="ks.end(['lfo1', 'rate'])" />
          <Knob v-else label="Rate" :min="0" :max="LFO_SYNC_LABELS.length - 1" :step="1" :labels="LFO_SYNC_LABELS" :defaultValue="divisionLabelToIndex(DEFAULTS.lfo1.div)" :modelValue="divisionLabelToIndex(params.lfo1.div)" @update:modelValue="ks.set(['lfo1', 'div'], LFO_SYNC_LABELS[$event])" :syncPath="ks.pathFor(['lfo1', 'div'])" @gesture-end="ks.end(['lfo1', 'div'])" />
          <Knob v-if="params.lfo1.mode === 'off'" label="Shape" :min="0" :max="4" :step="0.01" :defaultValue="DEFAULTS.lfo1.shape" :modelValue="params.lfo1.shape" @update:modelValue="ks.set(['lfo1', 'shape'], $event)" :syncPath="ks.pathFor(['lfo1', 'shape'])" @gesture-end="ks.end(['lfo1', 'shape'])" />
        </div>
        <div class="lfo-mode-selector">
          <button type="button" class="lfo-mode-btn" :class="{ active: params.lfo1.mode === 'off' }" @click="ks.set(['lfo1', 'mode'], 'off')">OFF</button>
          <button type="button" class="lfo-mode-btn" :class="{ active: params.lfo1.mode === 's&h' }" @click="ks.set(['lfo1', 'mode'], 's&h')">S&amp;H</button>
          <button type="button" class="lfo-mode-btn" :class="{ active: params.lfo1.mode === 'smooth' }" @click="ks.set(['lfo1', 'mode'], 'smooth')">SMOOTH</button>
        </div>
        <button type="button" class="lfo-sync-btn" :class="{ active: params.lfo1.sync }" @click="ks.set(['lfo1', 'sync'], !params.lfo1.sync)">SYNC</button>
```

- [ ] **Step 4: Add the segmented control + hide Shape (LFO 2)**

Replace the LFO 2 block (lines 191-198) identically but with `lfo2`:

```html
        <h3>LFO 2</h3>
        <WavePreview kind="lfo" :shape="params.lfo2.shape" :mode="params.lfo2.mode" :color="color" />
        <div class="knob-row">
          <Knob v-if="!params.lfo2.sync" label="Rate" :min="0.01" :max="2000" :step="0.01" format="hz" curve="exp" :defaultValue="DEFAULTS.lfo2.rate" :modelValue="params.lfo2.rate" @update:modelValue="ks.set(['lfo2', 'rate'], $event)" :syncPath="ks.pathFor(['lfo2', 'rate'])" @gesture-end="ks.end(['lfo2', 'rate'])" />
          <Knob v-else label="Rate" :min="0" :max="LFO_SYNC_LABELS.length - 1" :step="1" :labels="LFO_SYNC_LABELS" :defaultValue="divisionLabelToIndex(DEFAULTS.lfo2.div)" :modelValue="divisionLabelToIndex(params.lfo2.div)" @update:modelValue="ks.set(['lfo2', 'div'], LFO_SYNC_LABELS[$event])" :syncPath="ks.pathFor(['lfo2', 'div'])" @gesture-end="ks.end(['lfo2', 'div'])" />
          <Knob v-if="params.lfo2.mode === 'off'" label="Shape" :min="0" :max="4" :step="0.01" :defaultValue="DEFAULTS.lfo2.shape" :modelValue="params.lfo2.shape" @update:modelValue="ks.set(['lfo2', 'shape'], $event)" :syncPath="ks.pathFor(['lfo2', 'shape'])" @gesture-end="ks.end(['lfo2', 'shape'])" />
        </div>
        <div class="lfo-mode-selector">
          <button type="button" class="lfo-mode-btn" :class="{ active: params.lfo2.mode === 'off' }" @click="ks.set(['lfo2', 'mode'], 'off')">OFF</button>
          <button type="button" class="lfo-mode-btn" :class="{ active: params.lfo2.mode === 's&h' }" @click="ks.set(['lfo2', 'mode'], 's&h')">S&amp;H</button>
          <button type="button" class="lfo-mode-btn" :class="{ active: params.lfo2.mode === 'smooth' }" @click="ks.set(['lfo2', 'mode'], 'smooth')">SMOOTH</button>
        </div>
        <button type="button" class="lfo-sync-btn" :class="{ active: params.lfo2.sync }" @click="ks.set(['lfo2', 'sync'], !params.lfo2.sync)">SYNC</button>
```

- [ ] **Step 5: Add the CSS**

In the `<style scoped>` block of `Synth2Panel.vue`, add after the `.filter-model-btn.active` rule (~line 322), reusing the segmented-control look:

```css
.lfo-mode-selector { display: flex; gap: 4px; width: 100%; margin-top: 6px; }
.lfo-mode-btn {
  flex: 1;
  background: #181818;
  color: #666;
  border: 1px solid #2a2a2a;
  border-radius: 4px;
  padding: 5px 0;
  font-family: monospace;
  font-size: 0.65rem;
  font-weight: bold;
  letter-spacing: 0.03em;
  cursor: pointer;
  transition: all 0.2s ease;
}
.lfo-mode-btn:hover { color: #aaa; border-color: #444; }
.lfo-mode-btn.active { background: #222; color: #fff; border-color: #555; }
```

- [ ] **Step 6: Run the panel test + typecheck to verify they pass**

Run: `npm run test -w @fiddle/client -- src/components/Synth2Panel.test.ts && npm run typecheck:client`
Expected: PASS — `.lfo-mode-selector` renders three `.lfo-mode-btn`s; the S&H click dispatches `ks.set(['lfo1','mode'],'s&h')`.

- [ ] **Step 7: Commit**

```bash
git add packages/client/src/components/Synth2Panel.vue packages/client/src/components/Synth2Panel.test.ts
git commit -m "feat(client): LFO mode segmented control (OFF/S&H/SMOOTH) + Shape hide"
```

---

### Task 5: Full gate + browser verification

Confirms the whole change is green across packages and audibly/visually correct in the running app.
No new production code — verification only.

**Files:** none (verification).

- [ ] **Step 1: Full unit gate**

Run: `npm test`
Expected: PASS across `@fiddle/shared` and `@fiddle/client` (and `@fiddle/server`, unchanged). Note the counts (shared +? / client +? from the new cases) — no failures.

- [ ] **Step 2: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: PASS — `vue-tsc` clean, `build:worklet` bundles the updated `Lfo.ts` into `synth2-processor.js`, `vite build` succeeds.

- [ ] **Step 3: Launch the app on the LOCAL DB**

Run: `npm run dev:obs`
(Uses the LOCAL Docker DB — never `npm run dev`.) Open the client URL it prints.

- [ ] **Step 4: Browser-verify (Playwright MCP per AGENTS.md)**

On a **synth2** track's LFO 1:
1. Confirm default is **OFF** and the LFO behaves as today (Shape knob visible, morph preview).
2. Click **S&H** → Shape knob hides; preview shows stepped random; route `lfo1` → a filter cutoff in the matrix and confirm audible stepped modulation at the Rate.
3. Click **SMOOTH** → preview shows a continuous wandering line; modulation glides.
4. Toggle **SYNC** on with S&H → confirm the random steps lock to the tempo division.
5. Click **OFF** → Shape knob returns; morph restored.
6. Repeat a quick check on **LFO 2** (distinct random pattern from LFO 1).
7. **Reload** the page → `mode` persists (still S&H/Smooth as left).
8. Console clean except the known favicon 404 / local `/api/presets` 500.

Then **close the browser** (AGENTS.md rule).

- [ ] **Step 5: Record verification result**

If all steps pass, the branch is ready to hand back for the user's merge decision (keep the branch — do not auto-merge). If anything fails, capture the observation and stop for diagnosis rather than patching blindly.

---

## Self-Review

**Spec coverage:**
- 3-state Mode (Off/S&H/Smooth) → Tasks 1 (data) + 2 (DSP) + 4 (UI). ✓
- S&H stepped, Smooth interpolated, no extra param → Task 2 `next()`. ✓
- Rate/SYNC govern draw cadence (tempo-synced S&H free) → unchanged rate path + Task 4 leaves SYNC intact; browser Step 4.4. ✓
- Deterministic per-voice PRNG, distinct seeds, re-seed on reset → Task 2 (ctor/reset/draw, Voice seeds) + tests. ✓
- Real kernel enum via encodeEnum/PARAM_INDEX (like filter.type) → Tasks 1-2; no `Synth2Engine` change needed (derives from descriptors). ✓
- Accept-list/schema/defaults/block auto-derive → Task 1 (verified by shared tests). ✓
- Segmented OFF|S&H|SMOOTH control + hide Shape when mode≠off → Task 4. ✓
- Preview stable (fixed seed) → Task 3. ✓
- Old-session gap accepted, no migration → no task needed (documented in spec); defaults keep `'off'`. ✓
- Testing + browser verify on dev:obs → Task 5. ✓
- Out of scope (band-limiting, slew knob, mode modulation, synth1) → nothing added. ✓

**Placeholder scan:** No TBD/TODO. The only adaptive instruction is Task 4 Step 1 ("reuse this file's existing mount helper"), which is bounded by an explicit fixed contract (three `.lfo-mode-btn`, click 2 → `ks.set(['lfo1','mode'],'s&h')`) — the test file's own pattern is the reference, not a gap.

**Type consistency:** `Lfo` ctor `(rateSlot, shapeSlot, modeSlot, sampleRate, seed?)` matches Voice call (Task 2) and preview call (Task 3). `renderLfoShape(shape, mode='off')` matches WavePreview forward (Task 3) and tests. `mode` label union `'off'|'s&h'|'smooth'` is identical in the interface (Task 1), preview signature (Task 3), WavePreview prop (Task 3), and `ks.set` calls (Task 4). `LFO_MODE_LABELS` order `['off','s&h','smooth']` matches index reads (0/1/2) in `Lfo.next()` and preview.
