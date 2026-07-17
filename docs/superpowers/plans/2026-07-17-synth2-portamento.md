# Synth2 Portamento (Glide) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a portamento (glide) knob to the synth2 engine: mono-mode notes slide from the previous pitch to the new pitch over a configurable, optionally tempo-synced time.

**Architecture:** One appended descriptor triple (`glide.time` continuous+modulatable, `glide.sync`/`glide.div` main-thread-only dead slots) drives everything derived (schema, accept-list, defaults, block layout, MOD_DESTS). The kernel change is a small pure `Glide` class owned by `Voice` that bends the per-sample master frequency in log2-pitch space; `Synth2Kernel` forwards the existing per-event `mono` flag. AudioEngine derives synced seconds from BPM exactly like the env/LFO sync paths. The panel adds one knob + SYNC toggle next to MONO/POLY.

**Tech Stack:** TypeScript, Vue 3, vitest, Web Audio worklet kernel (pure TS), audio-lab for acoustic verification.

**Spec:** `docs/superpowers/specs/2026-07-16-synth2-portamento-design.md`

## Global Constraints

- Branch: all work on `feat/synth2-portamento` (already created). NEVER commit to main; merging needs an explicit user instruction.
- Every commit message ends with the two trailer lines:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01UxytFpxAxQ9zViyqjmEu4j`
- Stage files by exact path only — never `git add -A`, never `git add .`. Untracked repo-root scratch files (`studio-focused.md`, `*.png`) must NEVER be staged.
- The synth2 descriptor table is APPEND-ONLY: new rows go at the END of `SYNTH2_DESCRIPTORS`, never inserted or reordered.
- `SYNTH2_DESCRIPTORS` lives in `packages/shared`; the kernel imports from `@fiddle/shared`. Run commands from the repo root with `-w` workspace flags as shown.
- Worklets are PREBUILT (`packages/client/public/worklets/*-processor.js`, gitignored): kernel changes are invisible in a running browser until `npm run build:worklet -w packages/client` + a full page reload. Unit tests import the kernel source directly and don't need this.
- Never start `npm run dev` (prod Supabase — data-loss risk). Local browser testing uses the user's `npm run dev:obs` stack; never kill dev servers you didn't start (EADDRINUSE ⇒ reuse or ask).
- Merge gate before declaring the branch done: `npm run typecheck && npm test && npm run build` all green from the repo root.
- Renders are not bit-identical across runs (kernel PRNGs seed from Math.random) — never assert sample equality across separately constructed kernels; the tests below use fixed Voice seeds or zero-crossing pitch measurement, which is why they're written the way they are.

---

### Task 1: Shared package — descriptor rows, params interface, module label

**Files:**
- Modify: `packages/shared/src/engines/synth2-descriptors.ts` (import at line 13, table end at line 213)
- Modify: `packages/shared/src/engines/synth2.ts` (interfaces around line 50, `Synth2EngineParams` at line 69)
- Modify: `packages/shared/src/engines/synth2-labels.ts` (`SYNTH2_MODULE_LABELS`, line 10)
- Test: `packages/shared/src/engines/synth2.test.ts`, `packages/shared/src/engines/synth2-descriptors.test.ts`, `packages/shared/src/engines/synth2-labels.test.ts`

**Interfaces:**
- Consumes: existing `ENV_SYNC_LABELS`, `ENV_SYNC_DEFAULT_INDEX` from `env-sync.ts` (`ENV_SYNC_DEFAULT_INDEX` is the index of label `'1'`).
- Produces: descriptor rows `glide.time` / `glide.sync` / `glide.div` (in that order, at the table end); `Synth2GlideParams { time: number; sync: boolean; div: string }`; `Synth2EngineParams.glide`; `DEFAULT_SYNTH2_PARAMS.glide === { time: 0.001, sync: false, div: '1' }`; `MOD_DESTS` containing `'glide.time'`. Schema, accept-list, and the kernel block layout derive automatically — no edits there.

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/src/engines/synth2.test.ts` (inside the existing `describe('DEFAULT_SYNTH2_PARAMS', ...)`):

```ts
  it('defaults glide to a 1ms (inaudible) free-run slide over a 1-step division (portamento 2026-07-16)', () => {
    expect(DEFAULT_SYNTH2_PARAMS.glide).toEqual({ time: 0.001, sync: false, div: '1' });
    expect(typeof DEFAULT_SYNTH2_PARAMS.glide.sync).toBe('boolean');
  });
```

Append to `packages/shared/src/engines/synth2-descriptors.test.ts` (inside `describe('SYNTH2_DESCRIPTORS', ...)`), and add `'glide.sync', 'glide.div'` to the END of the `DISCRETE_KEYS` array at the top of that file:

```ts
  it('glide.time is a mod dest; glide.sync/div are dead main-thread slots (portamento 2026-07-16)', () => {
    expect(MOD_DESTS).toContain('glide.time');
    expect(MOD_DESTS).not.toContain('glide.sync');
    expect(MOD_DESTS).not.toContain('glide.div');
    const time = SYNTH2_DESCRIPTORS.find(d => d.key === 'glide.time')!;
    expect(time).toMatchObject({ min: 0.001, max: 2, default: 0.001, taper: 'expOctaves', modulatable: true, modScale: 4, curve: 'exp', label: 'Glide' });
    const div = SYNTH2_DESCRIPTORS.find(d => d.key === 'glide.div')!;
    expect(div.enumValues).toEqual(ENV_SYNC_LABELS);
    expect(ENV_SYNC_LABELS[div.default]).toBe('1');
  });
```

Append to `packages/shared/src/engines/synth2-labels.test.ts` (inside `describe('modDestLabel', ...)`):

```ts
  it('renders glide rows bare (module prefix null, like fm)', () => {
    expect(SYNTH2_MODULE_LABELS.glide).toBeNull();
    expect(modDestLabel('glide.time')).toBe('Glide');
    expect(knobLabel('glide.time')).toBe('Glide');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w packages/shared -- --run synth2`
Expected: the three new tests FAIL (`glide` undefined / `MOD_DESTS` missing `glide.time` / `SYNTH2_MODULE_LABELS.glide` undefined). Everything else passes.

- [ ] **Step 3: Implement**

In `packages/shared/src/engines/synth2-descriptors.ts`, change line 13 from
`import { ENV_SYNC_LABELS } from './env-sync.js';` to:

```ts
import { ENV_SYNC_LABELS, ENV_SYNC_DEFAULT_INDEX } from './env-sync.js';
```

Append at the END of the `SYNTH2_DESCRIPTORS` array (after the `lfo2.mode` row):

```ts
  // --- Portamento (2026-07-16, append-only). glide.time is the mono-mode
  // pitch-glide duration (constant-time, log2-pitch domain; see the Glide
  // kernel module). Modulatable like env times (expOctaves, ±4 oct at full
  // depth) so velocity→glide / LFO→glide work through the matrix. glide.sync
  // and glide.div are MAIN-THREAD-ONLY dead block slots exactly like
  // env*.sync/env*.aDiv: when sync is on, AudioEngine derives seconds from
  // the step division × bpm (envDivisionToSeconds) and writes them into
  // glide.time before the block reaches the kernel — the kernel never reads
  // these two rows. Default div '1' = the glide spans exactly one sequencer
  // step (the TB-303 slide), scaling with BPM. min = default = 0.001 s is the
  // same "effectively instant ⇒ off" convention as env attack.
  { key: 'glide.time', min: 0.001, max: 2, default: 0.001, taper: 'expOctaves', modulatable: true,  modScale: 4, curve: 'exp', label: 'Glide' },
  { key: 'glide.sync', min: 0, max: 1, default: 0, taper: 'linear', modulatable: false, modScale: 0, kind: 'bool', label: 'Sync' },
  { key: 'glide.div',  min: 0, max: ENV_SYNC_LABELS.length - 1, default: ENV_SYNC_DEFAULT_INDEX, taper: 'linear', modulatable: false, modScale: 0, kind: 'enum', enumValues: ENV_SYNC_LABELS, label: 'Glide Div' },
```

In `packages/shared/src/engines/synth2.ts`, add after `Synth2FilterParams` (line 61):

```ts
export interface Synth2GlideParams {
  time: number;  // seconds — free-mode glide; when sync is on the kernel receives
                 // a main-thread-derived duration instead (this leaf is never overwritten)
  sync: boolean; // tempo-sync on/off (time derived from div × bpm on the main thread)
  div: string;   // step-division label from ENV_SYNC_DIVISIONS (used when sync is on)
}
```

and add to `Synth2EngineParams` after the `filter` field:

```ts
  glide: Synth2GlideParams; // portamento — mono-mode pitch slide (2026-07-16)
```

In `packages/shared/src/engines/synth2-labels.ts`, add `glide: null` to `SYNTH2_MODULE_LABELS` (the `fm: null` convention — the 'Glide' label stands alone):

```ts
  noise: 'Noise', fm: null, glide: null,
```

- [ ] **Step 4: Run the shared suite and typecheck**

Run: `npm test -w packages/shared -- --run` then `npm run typecheck`
Expected: all shared tests PASS (the derivation contract tests in schema.test.ts / accept-list.test.ts / synth2.test.ts pick the new rows up automatically); typecheck green across workspaces (the client kernel contract tests are exercised in Task 2's run).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/engines/synth2-descriptors.ts packages/shared/src/engines/synth2.ts packages/shared/src/engines/synth2-labels.ts packages/shared/src/engines/synth2.test.ts packages/shared/src/engines/synth2-descriptors.test.ts packages/shared/src/engines/synth2-labels.test.ts
git commit -m "feat(synth2): glide descriptor rows + params interface (portamento)"
```

---

### Task 2: Kernel — pure `Glide` class (TDD)

**Files:**
- Create: `packages/client/src/engine/synth2/kernel/Glide.ts`
- Test: `packages/client/src/engine/synth2/kernel/Glide.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks (pure math).
- Produces: `class Glide { constructor(sampleRate: number); noteOn(targetFreq: number, mono: boolean): void; next(freq: number, glideSeconds: number): number }`. Task 3 wires it into `Voice`.

- [ ] **Step 1: Write the failing tests**

Create `packages/client/src/engine/synth2/kernel/Glide.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Glide } from './Glide';

const SR = 48000;

describe('Glide (portamento, spec 2026-07-16)', () => {
  it('first-ever note snaps (no previous pitch to glide from)', () => {
    const g = new Glide(SR);
    g.noteOn(440, true);
    expect(g.next(440, 0.5)).toBe(440);
  });

  it('mono note glides from the previous pitch: starts there, lands exactly on target and stays', () => {
    const g = new Glide(SR);
    g.noteOn(220, true);
    g.noteOn(440, true); // one octave up — glide begins
    const first = g.next(440, 0.5);
    expect(first).toBeGreaterThan(219); // ≈220: one octave below target, one sample in
    expect(first).toBeLessThan(222);
    let v = first;
    for (let i = 1; i < 0.5 * SR; i++) v = g.next(440, 0.5);
    expect(v).toBe(440);
    expect(g.next(440, 0.5)).toBe(440);
  });

  it('constant-time law: any interval completes in glideSeconds', () => {
    for (const target of [440, 880, 233.08]) { // 1 oct up, 2 oct up, odd interval
      const g = new Glide(SR);
      g.noteOn(220, true);
      g.noteOn(target, true);
      let samples = 0;
      while (g.next(target, 0.25) !== target) samples++;
      expect(samples).toBeGreaterThan(0.25 * SR - 10);
      expect(samples).toBeLessThan(0.25 * SR + 10);
    }
  });

  it('downward glide decreases monotonically and never undershoots the target', () => {
    const g = new Glide(SR);
    g.noteOn(880, true);
    g.noteOn(110, true);
    let prev = Infinity;
    for (let i = 0; i < 1000; i++) {
      const v = g.next(110, 0.5);
      expect(v).toBeLessThan(prev);
      expect(v).toBeGreaterThanOrEqual(110);
      prev = v;
    }
  });

  it('poly note (mono=false) snaps but still updates the pitch memory', () => {
    const g = new Glide(SR);
    g.noteOn(220, true);
    g.noteOn(880, false);               // poly: snap
    expect(g.next(880, 0.5)).toBe(880);
    g.noteOn(220, true);                // mono again: glides from 880, not 220
    const first = g.next(220, 0.5);
    expect(first).toBeGreaterThan(870);
  });

  it('same-pitch retrigger does not glide', () => {
    const g = new Glide(SR);
    g.noteOn(330, true);
    g.noteOn(330, true);
    expect(g.next(330, 2)).toBe(330);
  });

  it('retrigger mid-glide restarts from the previous note TARGET (deterministic)', () => {
    const g = new Glide(SR);
    g.noteOn(110, true);
    g.noteOn(220, true);
    for (let i = 0; i < 100; i++) g.next(220, 0.5); // partway up from 110
    g.noteOn(440, true); // latches from 220 (previous target), not the mid-glide pitch
    const first = g.next(440, 0.5);
    expect(first).toBeGreaterThan(219);
    expect(first).toBeLessThan(222);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w packages/client -- --run Glide`
Expected: FAIL — `Cannot find module './Glide'` (or equivalent).

- [ ] **Step 3: Implement**

Create `packages/client/src/engine/synth2/kernel/Glide.ts`:

```ts
//
// Portamento (spec 2026-07-16): constant-time glide in log2-pitch space.
// Pure per-voice state — no ParamSlot, no allocation; the Voice feeds it the
// per-sample glide.time slot value. noteOn latches the interval from the
// PREVIOUS NOTE'S TARGET pitch (not the mid-glide instantaneous pitch), so
// fast retriggers stay deterministic. Both endpoints are Nyquist-capped by
// the callers, and the rendered freq is always between them, so no clamp here.

export class Glide {
  private remainOct = 0;   // current offset from the target pitch (octaves), decays to 0
  private intervalOct = 0; // |offset at noteOn| — fixes the constant-time rate
  private lastFreq = 0;    // previous note's target freq; 0 = never played

  constructor(private readonly sampleRate: number) {}

  /** Latch glide state for a new note. Glides only for mono notes with a
   *  previous pitch to glide from; poly notes and the first-ever note snap.
   *  lastFreq updates unconditionally so a mono note after a poly note
   *  glides from whatever this voice played last. */
  noteOn(targetFreq: number, mono: boolean): void {
    if (mono && this.lastFreq > 0) {
      this.remainOct = Math.log2(this.lastFreq / targetFreq);
      this.intervalOct = Math.abs(this.remainOct);
    } else {
      this.remainOct = 0;
      this.intervalOct = 0;
    }
    this.lastFreq = targetFreq;
  }

  /** Per-sample frequency for target `freq`, advancing the glide by one
   *  sample of `glideSeconds` (the smoothed/modulated glide.time slot value,
   *  already clamped ≥ 0.001 by ParamSlot). Constant-time: the latched
   *  interval crosses in glideSeconds; re-reading the time per sample lets
   *  matrix mod bend the rate mid-glide without ever overshooting. */
  next(freq: number, glideSeconds: number): number {
    if (this.remainOct === 0) return freq;
    const step = this.intervalOct / (glideSeconds * this.sampleRate);
    const r = this.remainOct;
    this.remainOct = r > step ? r - step : r < -step ? r + step : 0;
    return this.remainOct === 0 ? freq : freq * Math.pow(2, this.remainOct);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w packages/client -- --run Glide`
Expected: 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/engine/synth2/kernel/Glide.ts packages/client/src/engine/synth2/kernel/Glide.test.ts
git commit -m "feat(synth2): Glide kernel module — constant-time log-pitch portamento"
```

---

### Task 3: Kernel — wire Glide into Voice + pass `mono` through Synth2Kernel (TDD)

**Files:**
- Modify: `packages/client/src/engine/synth2/kernel/Voice.ts` (imports; fields+constructor ~lines 33-111; `noteOn` line 149; `renderAdd` lines 194-207)
- Modify: `packages/client/src/engine/synth2/kernel/Synth2Kernel.ts` (line 138)
- Test: `packages/client/src/engine/synth2/kernel/Voice.test.ts`, `packages/client/src/engine/synth2/kernel/Synth2Kernel.test.ts`

**Interfaces:**
- Consumes: `Glide` from Task 2 (`new Glide(sampleRate)`, `.noteOn(targetFreq, mono)`, `.next(freq, glideSeconds)`); descriptor row `glide.time` from Task 1 (slot exists at `PARAM_INDEX['glide.time']`).
- Produces: `Voice.noteOn(freq: number, velocity: number, gateFrames: number, mono = true)` — the new 4th parameter defaults to `true` so all existing callers/tests keep mono semantics; `Synth2Kernel` forwards `ev.mono`. Audible contract: mono retriggers glide, poly notes snap.

- [ ] **Step 1: Write the failing tests**

Append to `packages/client/src/engine/synth2/kernel/Voice.test.ts` (top-level; the file already imports `Voice` and `PARAM_INDEX`):

```ts
describe('Voice portamento (spec 2026-07-16)', () => {
  const SR = 48000;

  // Rising zero-crossing frequency estimate over out[from..to). Valid for the
  // clean single-sine voice configured below (no noise, filter wide open).
  function measureFreq(out: Float32Array, from: number, to: number): number {
    let first = -1; let last = -1; let count = 0;
    for (let i = from + 1; i < to; i++) {
      if (out[i - 1] <= 0 && out[i] > 0) {
        if (first < 0) first = i; else last = i;
        count++;
      }
    }
    return count < 2 ? 0 : ((count - 1) * SR) / (last - first);
  }

  // Single sine through a wide-open static filter: env1 sustain 1 for steady
  // amplitude, env2→cutoff off so pitch is the only thing moving.
  function sineVoice(glideTime: number): Voice {
    const v = new Voice(SR, 1);
    const set = (key: string, val: number) => v.slots[PARAM_INDEX[key]].setBase(val);
    set('osc1.morph', 0);
    set('osc2.level', 0);
    set('osc3.level', 0);
    set('noise.level', 0);
    set('filter.cutoff', 20000);
    set('filter.resonance', 0);
    set('filter.envAmount', 0);
    set('env1.a', 0.001);
    set('env1.s', 1);
    set('glide.time', glideTime);
    return v;
  }

  // 1s of the second note after 0.2s of the first (slot smoothers settled).
  function secondNote(v: Voice, freq1: number, freq2: number, mono = true): Float32Array {
    v.noteOn(freq1, 1, SR);
    const warm = new Float32Array(9600);
    v.renderAdd(warm, 0, 9600);
    v.noteOn(freq2, 1, SR, mono);
    const out = new Float32Array(SR);
    v.renderAdd(out, 0, SR);
    return out;
  }

  it('mono retrigger glides: mid-glide pitch sits between the notes, then lands on target', () => {
    const out = secondNote(sineVoice(0.1), 110, 220);
    const mid = measureFreq(out, 480, 1920);       // 10–40ms into a 100ms glide
    expect(mid).toBeGreaterThan(115);
    expect(mid).toBeLessThan(205);
    const settled = measureFreq(out, 7200, 12000); // 150–250ms: glide done
    expect(Math.abs(settled - 220)).toBeLessThan(3);
  });

  it('default glide time (1ms) is an inaudible snap: pitch at target immediately', () => {
    const out = secondNote(sineVoice(0.001), 110, 220);
    const early = measureFreq(out, 240, 2640);     // 5–55ms window
    expect(Math.abs(early - 220)).toBeLessThan(3);
  });

  it('poly notes (mono=false) never glide', () => {
    const out = secondNote(sineVoice(0.1), 110, 220, false);
    const early = measureFreq(out, 240, 2640);
    expect(Math.abs(early - 220)).toBeLessThan(3);
  });

  it('first-ever note snaps even with a long glide time', () => {
    const v = sineVoice(1.0);
    v.noteOn(220, 1, SR);
    const out = new Float32Array(4800);
    v.renderAdd(out, 0, 4800);
    const early = measureFreq(out, 240, 2640);
    expect(Math.abs(early - 220)).toBeLessThan(3);
  });
});
```

Append to `packages/client/src/engine/synth2/kernel/Synth2Kernel.test.ts` (the file already imports `Synth2Kernel`; if `defaultParamBlock`/`PARAM_INDEX` are not yet imported there, extend its import from `./params`):

```ts
describe('Synth2Kernel portamento pass-through (spec 2026-07-16)', () => {
  // Same zero-crossing estimator as Voice.test.ts (12 lines, duplicated by
  // convention — kernel tests stay self-contained).
  function measureFreq(out: Float32Array, from: number, to: number, sr: number): number {
    let first = -1; let last = -1; let count = 0;
    for (let i = from + 1; i < to; i++) {
      if (out[i - 1] <= 0 && out[i] > 0) {
        if (first < 0) first = i; else last = i;
        count++;
      }
    }
    return count < 2 ? 0 : ((count - 1) * sr) / (last - first);
  }

  it('mono events glide with glide.time from the param block (full applyParams path)', () => {
    const k = new Synth2Kernel(48000);
    const block = defaultParamBlock();
    const set = (key: string, val: number) => { block[PARAM_INDEX[key]] = val; };
    set('osc1.morph', 0);
    set('osc2.level', 0);
    set('osc3.level', 0);
    set('noise.level', 0);
    set('filter.cutoff', 20000);
    set('filter.resonance', 0);
    set('filter.envAmount', 0);
    set('env1.s', 1);
    set('glide.time', 0.5);
    k.applyParams(block);
    k.noteOn(0, 110, 0.3, 1, true);
    k.noteOn(0.3, 220, 0.6, 1, true);
    const out = new Float32Array(48000);
    for (let f = 0; f < out.length; f += 128) k.process(out.subarray(f, f + 128), 128, f);
    // 0.35–0.42s = 50–120ms into a 500ms glide: pitch has left 110 but is far from 220.
    const mid = measureFreq(out, 16800, 20160, 48000);
    expect(mid).toBeGreaterThan(112);
    expect(mid).toBeLessThan(160);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w packages/client -- --run "synth2/kernel"`
Expected: the new Voice glide test FAILS on the first assertion (`mid` measures ≈220 — retrigger snaps today); the kernel test FAILS the `mid < 160` bound the same way. All pre-existing kernel tests still PASS.

- [ ] **Step 3: Implement**

In `packages/client/src/engine/synth2/kernel/Voice.ts`:

1. Add the import next to the other module imports:

```ts
import { Glide } from './Glide';
```

2. Add fields (next to the `matrix`/`lfo` fields, ~line 65):

```ts
  private readonly glide: Glide;
  private readonly glideSlot: ParamSlot;
```

3. In the constructor (after the `lfo2` assignment, line 110):

```ts
    this.glideSlot = slot('glide.time');
    this.glide = new Glide(sampleRate);
```

4. Change the `noteOn` signature (line 149) from
`noteOn(freq: number, velocity: number, gateFrames: number): void {` to:

```ts
  noteOn(freq: number, velocity: number, gateFrames: number, mono = true): void {
```

and after the `this.keyTrackOctaves = ...` line (line 159) add:

```ts
    // Portamento (spec 2026-07-16): mono notes glide from the last played
    // pitch; poly notes and the first-ever note snap. Keytrack stays latched
    // to the TARGET pitch (above), so the filter doesn't re-sweep mid-glide.
    this.glide.noteOn(this.freq, mono);
```

5. In `renderAdd`, after `const env2v = this.env2.next();` (line 195) add:

```ts
      // Portamento: per-sample gliding master frequency. The glide.time slot
      // is consumed every sample (exactly-once contract) so matrix mod
      // reaches a glide in progress; non-gliding voices pay one comparison.
      const freq = this.glide.next(this.freq, this.glideSlot.next());
```

and replace the three oscillator frequency arguments — `this.osc1.next(this.freq)`, `this.osc2.next(this.freq, ...)`, `this.osc3.next(this.freq, ...)` — with `freq` (three occurrences; the TZFM/sync chain then sees one coherent gliding master frequency).

In `packages/client/src/engine/synth2/kernel/Synth2Kernel.ts`, change line 138 from
`this.voices[v].noteOn(ev.freq, ev.velocity, ev.gateFrames);` to:

```ts
      this.voices[v].noteOn(ev.freq, ev.velocity, ev.gateFrames, ev.mono);
```

- [ ] **Step 4: Run the full kernel suite**

Run: `npm test -w packages/client -- --run "synth2/kernel"`
Expected: ALL kernel tests PASS — the new glide tests plus every pre-existing Voice/Kernel/fuzz/soak test (default glide.time 0.001 ⇒ a 48-sample inaudible ramp; existing tests retrigger at the same pitch, so their outputs are unchanged where they assert sample equality).

- [ ] **Step 5: Run the whole client suite + typecheck**

Run: `npm test -w packages/client -- --run` then `npm run typecheck`
Expected: green. (`Synth2Engine`/worklet-entry need no changes — the engine already walks nested modules generically and already sends `mono`.)

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/engine/synth2/kernel/Voice.ts packages/client/src/engine/synth2/kernel/Synth2Kernel.ts packages/client/src/engine/synth2/kernel/Voice.test.ts packages/client/src/engine/synth2/kernel/Synth2Kernel.test.ts
git commit -m "feat(synth2): wire portamento into Voice; kernel forwards the mono flag"
```

---

### Task 4: AudioEngine — synced glide time derivation (TDD)

**Files:**
- Modify: `packages/client/src/audio/AudioEngine.ts` (helper after `effectiveEnvTimes` ~line 93; `syncTrackToEngine` synth2 branch lines 233-242; bpm handler lines 287-304; `engines` case lines 329-338)
- Test: `packages/client/src/audio/AudioEngine.test.ts`

**Interfaces:**
- Consumes: `Synth2EngineParams.glide` from Task 1; existing `envDivisionToSeconds`, `ENV_SYNC_DEFAULT_LABEL` (both already imported in AudioEngine.ts); existing `snapshot()` helper and `makeEngine()` test harness.
- Produces: `effectiveGlideTime(glide: { sync?: boolean; div?: string; time: number }, bpm: number): number` — module-private; the derived `glide.time` reaching `applyParams` on full sync, per-edit, and BPM change.

- [ ] **Step 1: Write the failing tests**

Append to `packages/client/src/audio/AudioEngine.test.ts` (top-level, after the envelope tempo-sync describe; same harness conventions):

```ts
describe('AudioEngine — glide tempo-sync time derivation', () => {
  async function synth2GlideEngine(glide: Partial<{ sync: boolean; div: string; time: number }>) {
    const h = makeEngine();
    h.project.bpm = 120;
    h.project.tracks[0].engineType = 'synth2';
    Object.assign(h.project.tracks[0].engines.synth2.glide, glide);
    const state = await h.engine.ensureAudio();
    const spy = vi.spyOn(state.engines[0]!, 'applyParams');
    spy.mockClear();
    return { ...h, state, spy };
  }

  it('re-pushes a derived glide time on BPM change (default div "1" = one step)', async () => {
    const { set, spy } = await synth2GlideEngine({ sync: true });
    set(['bpm'], 120);
    expect(spy).toHaveBeenCalledWith({ glide: expect.objectContaining({ time: 0.125 }) }); // 1 step @120
  });

  it('does NOT re-push a free-mode glide on BPM change', async () => {
    const { set, spy } = await synth2GlideEngine({ sync: false });
    set(['bpm'], 120);
    expect(spy).not.toHaveBeenCalled();
  });

  it('derives the time when a synced glide div changes', async () => {
    const { set, spy } = await synth2GlideEngine({ sync: true });
    set(['tracks', 0, 'engines', 'synth2', 'glide', 'div'], '2'); // 2 steps @120 → 250ms
    expect(spy).toHaveBeenCalledWith({ glide: expect.objectContaining({ time: 0.25 }) });
  });

  it('derives the time when SYNC is turned on', async () => {
    const { set, spy } = await synth2GlideEngine({ sync: false });
    set(['tracks', 0, 'engines', 'synth2', 'glide', 'sync'], true);
    expect(spy).toHaveBeenCalledWith({ glide: expect.objectContaining({ time: 0.125 }) });
  });

  it('passes raw seconds through for a free-mode time edit', async () => {
    const { set, spy } = await synth2GlideEngine({ sync: false });
    set(['tracks', 0, 'engines', 'synth2', 'glide', 'time'], 0.3);
    expect(spy).toHaveBeenCalledWith({ glide: expect.objectContaining({ time: 0.3 }) });
  });

  it('clamps the derived time at the 2s knob ceiling (long division, slow BPM)', async () => {
    const { set, spy } = await synth2GlideEngine({ sync: true, div: '32' }); // 32 steps @40 BPM = 12s
    set(['bpm'], 40);
    expect(spy).toHaveBeenCalledWith({ glide: expect.objectContaining({ time: 2 }) });
  });

  it('a raw time write on a SYNCED glide still reaches audio derived (leaf preserved, derived wins)', async () => {
    const { set, spy, project } = await synth2GlideEngine({ sync: true });
    set(['tracks', 0, 'engines', 'synth2', 'glide', 'time'], 1.7);
    expect(spy).toHaveBeenCalledWith({ glide: expect.objectContaining({ time: 0.125 }) });
    expect(project.tracks[0].engines.synth2.glide.time).toBe(1.7);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w packages/client -- --run AudioEngine`
Expected: the sync-derivation tests FAIL (raw `time` passed through / no glide-specific push); the free-mode passthrough tests may already pass via the generic module path — that's fine.

- [ ] **Step 3: Implement**

In `packages/client/src/audio/AudioEngine.ts`:

1. After `effectiveEnvTimes` (line 93) add:

```ts
// A synced glide's time is derived on the main thread from its step division
// and the project BPM (the kernel is tempo-agnostic); a free glide uses its
// stored seconds. The clamp ceiling is the glide.time descriptor max (2s) —
// at 40 BPM a 32-step division derives 12s, so it is load-bearing at the
// slow extreme; the floor is defensive.
function effectiveGlideTime(
  glide: { sync?: boolean; div?: string; time: number },
  bpm: number,
): number {
  if (!glide.sync) return glide.time;
  return Math.min(2, Math.max(0.001, envDivisionToSeconds(glide.div ?? ENV_SYNC_DEFAULT_LABEL, bpm)));
}
```

2. In `syncTrackToEngine` (lines 233-242), extend the `s2` cast and the spread:

```ts
        const s2 = params as unknown as { lfo1: any; lfo2: any; env1: any; env2: any; env3: any; glide: any };
        engines[i]!.applyParams({
          ...params,
          lfo1: { ...s2.lfo1, rate: effectiveLfoRate(s2.lfo1, project.bpm) },
          lfo2: { ...s2.lfo2, rate: effectiveLfoRate(s2.lfo2, project.bpm) },
          env1: { ...s2.env1, ...effectiveEnvTimes(s2.env1, project.bpm) },
          env2: { ...s2.env2, ...effectiveEnvTimes(s2.env2, project.bpm) },
          env3: { ...s2.env3, ...effectiveEnvTimes(s2.env3, project.bpm) },
          glide: { ...s2.glide, time: effectiveGlideTime(s2.glide, project.bpm) },
        });
```

3. In the `p[0] === 'bpm'` handler, after the env re-push loop (line 301) add:

```ts
          const glide = project.tracks[i].engines.synth2.glide;
          if (glide.sync) {
            engine.applyParams({ glide: { ...snapshot(glide), time: effectiveGlideTime(glide, project.bpm) } });
          }
```

4. In the `case 'engines':` block, after the env1/env2/env3 branch (line 338) add:

```ts
          if (slice === 'synth2' && key === 'glide') {
            const glide = liveSlice[key] as { sync?: boolean; div?: string; time: number };
            engine.applyParams({ [key]: { ...snapshot(glide), time: effectiveGlideTime(glide, project.bpm) } });
            return;
          }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w packages/client -- --run AudioEngine`
Expected: all PASS, including the pre-existing LFO/env sync suites.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/audio/AudioEngine.ts packages/client/src/audio/AudioEngine.test.ts
git commit -m "feat(synth2): derive tempo-synced glide time on the main thread"
```

---

### Task 5: Synth2Panel — glide knob + SYNC toggle (TDD)

**Files:**
- Modify: `packages/client/src/components/Synth2Panel.vue` (template: `.synth-mode-selector` block at lines 3-21; scoped styles at the bottom)
- Test: `packages/client/src/components/Synth2Panel.test.ts`

**Interfaces:**
- Consumes: `params.glide` (Task 1); existing panel imports `knobLabel`, `ENV_SYNC_LABELS`, `ENV_SYNC_KNOB_LABELS`, `envDivisionLabelToIndex` (all already imported), `DEFAULTS`, `ks` (knobSync).
- Produces: UI only — wire writes `['glide','time']` / `['glide','div']` / `['glide','sync']` through `ks.set`, identical to every other knob.

- [ ] **Step 1: Write the failing tests**

Append to `packages/client/src/components/Synth2Panel.test.ts` (uses the existing `mountPanel`/`dispatchLocal`/`SYN2` helpers):

```ts
describe('Synth2Panel glide (portamento) control', () => {
  it('renders the Glide knob and SYNC toggle in the mode-selector row', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    const cell = el.querySelector('.synth-mode-selector .glide-control');
    expect(cell).not.toBeNull();
    const labels = Array.from(cell!.querySelectorAll('.knob-label')).map(n => n.textContent?.trim());
    expect(labels).toContain('Glide');
    expect(cell!.querySelector('.glide-sync-btn')!.textContent?.trim()).toBe('SYNC');
  });

  it('dispatches glide.sync on SYNC click', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    el.querySelector<HTMLButtonElement>('.glide-sync-btn')!.click();
    expect(dispatchLocal).toHaveBeenCalledWith(SYN2('glide', 'sync'), true);
  });

  it('swaps to the step-division knob when glide.sync is on (readout shows the div label)', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    params.glide.sync = true;
    const el = mountPanel(params);
    const readout = el.querySelector('.glide-control .knob-value')?.textContent?.trim();
    expect(readout).toBe('1 st'); // default div '1' rendered via ENV_SYNC_KNOB_LABELS
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w packages/client -- --run Synth2Panel`
Expected: the three new tests FAIL (`.glide-control` null); all pre-existing panel tests PASS.

- [ ] **Step 3: Implement**

In `packages/client/src/components/Synth2Panel.vue`, inside the `.synth-mode-selector` div, add after the POLY `</button>`:

```html
      <div class="glide-control">
        <Knob v-if="!params.glide.sync" :label="knobLabel('glide.time')" :min="0.001" :max="2" :step="0.001" format="ms" curve="exp" :defaultValue="DEFAULTS.glide.time" :modelValue="params.glide.time" @update:modelValue="ks.set(['glide', 'time'], $event)" :syncPath="ks.pathFor(['glide', 'time'])" @gesture-end="ks.end(['glide', 'time'])" />
        <Knob v-else :label="knobLabel('glide.time')" :min="0" :max="ENV_SYNC_LABELS.length - 1" :step="1" :labels="ENV_SYNC_KNOB_LABELS" :defaultValue="envDivisionLabelToIndex(DEFAULTS.glide.div)" :modelValue="envDivisionLabelToIndex(params.glide.div)" @update:modelValue="ks.set(['glide', 'div'], ENV_SYNC_LABELS[$event])" :syncPath="ks.pathFor(['glide', 'div'])" @gesture-end="ks.end(['glide', 'div'])" />
        <button type="button" class="glide-sync-btn" :class="{ active: params.glide.sync }" @click="ks.set(['glide', 'sync'], !params.glide.sync)">SYNC</button>
      </div>
```

Add to the `<style scoped>` block (after the `.env-knob-row` rule):

```css
/* Glide (portamento) rides the shared mode-selector row. The selector's flex
   styling is global (App.vue, shared with synth1); these scoped rules only
   affect synth2's instance. Knob centers against the taller row; step labels
   ("1/16 st") need the wider readout, same as the env rows. */
.synth-mode-selector { align-items: center; }
.glide-control {
  display: flex;
  align-items: center;
  gap: 8px;
  --knob-value-width: 56px;
}
.glide-sync-btn {
  background: #181818;
  color: #666;
  border: 1px solid #2a2a2a;
  border-radius: 4px;
  padding: 5px 10px;
  font-family: monospace;
  font-size: 0.7rem;
  font-weight: bold;
  letter-spacing: 0.05em;
  cursor: pointer;
  transition: all 0.2s ease;
}
.glide-sync-btn:hover { color: #aaa; border-color: #444; }
.glide-sync-btn.active { background: #222; color: #fff; border-color: #555; }
```

(The `.glide-sync-btn` deliberately does NOT join the `.sync-btn/.loop-btn/...` group selector — that group carries `width: 100%; margin-top: 6px`, which is wrong inside a flex row.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w packages/client -- --run Synth2Panel`
Expected: all PASS. (The `'1 st'` readout is exact: `formatKnobValue` returns `labels[Math.round(value)]` when `labels` is set, and `envDivisionLabelToIndex('1')` indexes `ENV_SYNC_KNOB_LABELS` at the `'1 st'` entry.)

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/components/Synth2Panel.vue packages/client/src/components/Synth2Panel.test.ts
git commit -m "feat(synth2): glide knob + tempo-sync toggle in the mode-selector row"
```

---

### Task 6: Verification — merge gate, audio lab A/B, browser pass (controller-executed)

This task is run INLINE by the session controller (not a subagent): it needs the audio-lab Read-tool workflow, the user's dev:obs stack, and Playwright MCP.

**Files:** none created in the repo (lab run dirs land under `packages/audio-lab/.audio-lab/runs/`, gitignored).

- [ ] **Step 1: Merge gate**

Run from the repo root: `npm run typecheck && npm test && npm run build`
Expected: all green. (If unrelated client tests flake on timeouts under load, re-run the failing suite standalone before suspecting the branch.)

- [ ] **Step 2: Audio-lab A/B (the acceptance test this feature was queued for)**

Consult `.claude/skills/audio-lab/SKILL.md` for flag syntax. Render baseline and glide runs of the same two-note mono phrase (levels reduced to avoid the known raw-kernel CLIPPING flag):

```bash
npm run lab -- render-engine synth2 --label glide-baseline --mono --notes "A2:0:0.4,A3:0.5:0.4" --set osc1.level=0.2 --set osc2.level=0.2
npm run lab -- render-engine synth2 --label glide-300ms   --mono --notes "A2:0:0.4,A3:0.5:0.4" --set osc1.level=0.2 --set osc2.level=0.2 --set glide.time=0.3
npm run lab -- compare .audio-lab/runs/<baseline-dir> .audio-lab/runs/<glide-dir>
```

Acceptance (read `report.json` + pitch plot via the Read tool at `packages/audio-lab/.audio-lab/runs/<dir>/...`):
- Baseline: pitch snaps at the A3 onset — `pitchSettleTime` after the second onset ≈ 0 (< 30ms).
- Glide run: `pitchSettleTime` ≈ 0.3s ± 50ms; the f0 track shows a smooth 110→220Hz ramp starting at 0.5s; tail-segment `medianF0` = 220 ± 1Hz in BOTH runs (glide must not detune the landing pitch).
- No new healthFlags relative to baseline.
- Tolerances only — renders are not bit-identical (free-running PRNGs).

- [ ] **Step 3: Browser verification (MANDATORY — Stop-hook enforced)**

Prerequisites: worklet rebuild so the browser runs the new kernel:

```bash
npm run build:worklet -w packages/client
```

Then, against the user's running `npm run dev:obs` stack (if not running, ask the user — never start `npm run dev`):
1. Open the app via Playwright MCP; hard-reload so the rebuilt worklet loads.
2. On a synth2 track: place two steps at different pitches (e.g. A2 and A3), play, GLIDE at default — notes snap (today's behavior).
3. Turn GLIDE up (~300ms) — audible slide between the steps; check the knob readout and that the value survives a page reload (wire round-trip).
4. Toggle SYNC on — knob becomes a step-division selector showing "1 st"; change BPM and confirm no errors; set div "2" and confirm the slide lengthens.
5. Switch the track to POLY — knob stays visible; chord steps do NOT smear (glide inert).
6. Check the browser console is clean (no errors/warnings from our code).
7. Screenshot the mode-selector row (layout check: MONO/POLY buttons + glide knob + SYNC aligned) — save to the scratchpad, NOT the repo root.
8. Close all tabs/sessions opened for testing; stop any server the session itself started (none expected).

- [ ] **Step 4: Report**

Summarize: gate results, lab metrics table (baseline vs glide `pitchSettleTime`, `medianF0`), browser observations. Keep the branch for user verification — do NOT merge without an explicit user instruction.
