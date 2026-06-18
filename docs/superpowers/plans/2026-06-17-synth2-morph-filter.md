# synth2 I3d — Morph Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second filter (`MorphFilter`) behind the existing `FilterModule` seam — a continuous LP→BP→HP morph whose blend point is a mod-matrix destination — selected per track by a new `filter.model` enum.

**Architecture:** Two descriptor rows (`filter.morph` continuous + modulatable; `filter.model` enum) drive everything via the existing single-source-of-truth derivations. A new `MorphFilter` reuses the shared `SvfCore` and equal-power-crossfades its low/band/high outputs by `morph` 0..2. The Voice preallocates both filters and the kernel selects the active one at the block boundary (hard switch + reset, like `filter.type`). Panel gets a CLASSIC|MORPH toggle that swaps the LP/BP/HP selector for a Morph knob.

**Tech Stack:** TypeScript, Vue 3, Vitest, Web Audio AudioWorklet; npm workspaces (`@fiddle/shared`, `@fiddle/client`).

## Global Constraints

- **`SYNTH2_DESCRIPTORS` is APPEND-ONLY.** New rows go at the tail; never insert/reorder (the array index is the Float32Array param-block index = wire ABI).
- **No positional param-block literals.** `PARAM_COUNT`/`MATRIX_BASE`/`BLOCK_LENGTH`/`PARAM_INDEX` are all derived; reference by key, never by integer.
- **Hot path stays allocation-free.** Both filters are preallocated per voice; `MorphFilter.process` and the render loop allocate nothing.
- **`ClassicFilter` behavior is preserved byte-for-byte** when `model === 'classic'`. Its only edit is an ignored optional 4th `process` arg.
- **Spec:** `docs/superpowers/specs/2026-06-17-synth2-morph-filter-design.md`. Single-file test run convention: `npm test --workspace <pkg> -- <file-filter>`. Full gate (from repo root): `npm run typecheck && npm test && npm run build`.
- Commit-message trailer on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

### Task 1: Shared — descriptor rows + params interface + derivation tests

**Files:**
- Modify: `packages/shared/src/engines/synth2-descriptors.ts` (append 2 rows)
- Modify: `packages/shared/src/engines/synth2.ts` (`Synth2FilterParams` interface)
- Test: `packages/shared/src/engines/synth2-descriptors.test.ts`, `packages/shared/src/engines/synth2.test.ts`, `packages/shared/src/project/schema.test.ts`, `packages/shared/src/project/accept-list.test.ts`

**Interfaces:**
- Produces: two descriptor keys `'filter.morph'` (continuous, modulatable, min 0 / max 2 / default 0 / modScale 1) and `'filter.model'` (`kind:'enum'`, `enumValues ['classic','morph']`, default 0, not modulatable). `MOD_DESTS` gains `'filter.morph'`; `SYNTH2_ENUM_VALUES['filter.model'] === ['classic','morph']`. `Synth2FilterParams` gains `morph: number` and `model: 'classic' | 'morph'`; `DEFAULT_SYNTH2_PARAMS.filter.morph === 0`, `.model === 'classic'`.

- [ ] **Step 1: Write the failing descriptor tests**

In `synth2-descriptors.test.ts`: (a) add `'filter.model'` to the `DISCRETE_KEYS` array near the top:

```ts
const DISCRETE_KEYS = ['osc1.sync', 'osc2.sync', 'osc3.sync', 'filter.type', 'env1.loop', 'env2.loop', 'env3.loop', 'filter.model'];
```

(b) append the two keys to the end of the "covers exactly" expected array and rename the test to I3d:

```ts
  it('covers exactly the I3d param set (append-only from here)', () => {
    expect(SYNTH2_DESCRIPTORS.map(d => d.key)).toEqual([
      // ...existing rows unchanged through 'env1.loop', 'env2.loop', 'env3.loop',
      'env1.loop', 'env2.loop', 'env3.loop',
      'filter.morph', 'filter.model',
    ]);
  });
```

(c) add a new describe block at the end of the file:

```ts
describe('morph filter descriptor rows (I3d)', () => {
  const byKey = Object.fromEntries(SYNTH2_DESCRIPTORS.map(d => [d.key, d]));

  it('filter.morph is a continuous 0..2 modulatable blend (auto mod dest)', () => {
    expect(byKey['filter.morph']).toMatchObject({
      min: 0, max: 2, default: 0, taper: 'linear', modulatable: true, modScale: 1,
    });
    expect(byKey['filter.morph'].kind).toBeUndefined();
    expect(MOD_DESTS).toContain('filter.morph');
  });

  it('filter.model is the second enum (classic/morph), not a mod dest', () => {
    const d = byKey['filter.model'];
    expect(d.kind).toBe('enum');
    expect(d.enumValues).toEqual(['classic', 'morph']);
    expect(d.modulatable).toBe(false);
    expect(SYNTH2_ENUM_VALUES['filter.model']).toEqual(['classic', 'morph']);
    expect(MOD_DESTS).not.toContain('filter.model');
  });
});
```

Add `SYNTH2_ENUM_VALUES` to the existing import from `'./synth2-descriptors.js'` if not already imported.

- [ ] **Step 2: Run the descriptor tests to verify they fail**

Run: `npm test --workspace @fiddle/shared -- synth2-descriptors`
Expected: FAIL — keys `filter.morph`/`filter.model` not present.

- [ ] **Step 3: Append the two descriptor rows**

In `synth2-descriptors.ts`, after the `env3.loop` row (current last row), append:

```ts
  // --- I3d morph filter (append-only). filter.morph is the continuous LP→BP→HP
  // blend (0..2), modulatable so the matrix can sweep the filter ARCHITECTURE
  // (auto-joins MOD_DESTS). filter.model selects the FilterModule per track — the
  // 2nd enum after filter.type, riding the block as an index (classic=0, morph=1),
  // applied at the block boundary, NOT a mod dest (modulatable:false).
  { key: 'filter.morph', min: 0, max: 2, default: 0, taper: 'linear', modulatable: true,  modScale: 1 },
  { key: 'filter.model', min: 0, max: 1, default: 0, taper: 'linear', modulatable: false, modScale: 0, kind: 'enum', enumValues: ['classic', 'morph'] },
```

- [ ] **Step 4: Run the descriptor tests to verify they pass**

Run: `npm test --workspace @fiddle/shared -- synth2-descriptors`
Expected: PASS.

- [ ] **Step 5: Write the failing params/schema tests**

In `synth2.test.ts`, add (near the existing filter-defaults assertions):

```ts
  it('filter morph defaults to 0 (LP) and model to classic', () => {
    expect(DEFAULT_SYNTH2_PARAMS.filter.morph).toBe(0);
    expect(DEFAULT_SYNTH2_PARAMS.filter.model).toBe('classic');
  });
```

In `schema.test.ts`, add:

```ts
  it('accepts filter.morph in range and filter.model classic/morph', () => {
    const p = freshSynth2();
    p.filter.morph = 2; p.filter.model = 'morph';
    expect(() => Synth2ParamsSchema.parse(p)).not.toThrow();
  });

  it('rejects out-of-range filter.morph and unknown filter.model', () => {
    const p1 = freshSynth2(); (p1.filter as any).morph = 3;
    expect(() => Synth2ParamsSchema.parse(p1)).toThrow();
    const p2 = freshSynth2(); (p2.filter as any).model = 'lp';
    expect(() => Synth2ParamsSchema.parse(p2)).toThrow();
  });
```

(Use whatever fresh-params helper `schema.test.ts` already uses; if it builds from `DEFAULT_SYNTH2_PARAMS`, clone that.) In `accept-list.test.ts`, add an assertion that `engines.synth2.filter.morph` and `engines.synth2.filter.model` resolve to a leaf schema (mirror the existing `filter.type`/`filter.cutoff` round-trip cases).

- [ ] **Step 6: Run the params/schema tests to verify they fail**

Run: `npm test --workspace @fiddle/shared -- synth2.test schema.test accept-list`
Expected: FAIL — `filter.morph`/`filter.model` missing from the interface/defaults.

- [ ] **Step 7: Add the interface fields**

In `synth2.ts`, add to the `Synth2FilterParams` interface (after `type`):

```ts
  type: 'lp' | 'bp' | 'hp';
  morph: number;               // 0 LP → 1 BP → 2 HP (continuous MorphFilter blend)
  model: 'classic' | 'morph';  // which FilterModule the voice uses
```

`buildDefaults()` needs **no change**: it already decodes `kind:'enum'` rows via `decodeEnum(d.default, d.enumValues!)` (so `filter.model` → `'classic'`) and continuous rows to their `default` (so `filter.morph` → `0`). The schema (`schema.ts`) and accept-list (`accept-list.ts`) are descriptor-derived (`z.enum(enumValues)` for enum rows, ranged number for continuous), so they auto-gain both leaves with **no edit**.

- [ ] **Step 8: Run the full shared suite to verify green**

Run: `npm test --workspace @fiddle/shared`
Expected: PASS (all files, including the unchanged derivation contract tests).

- [ ] **Step 9: Commit**

```bash
git add packages/shared/src/engines/synth2-descriptors.ts packages/shared/src/engines/synth2.ts packages/shared/src/engines/synth2-descriptors.test.ts packages/shared/src/engines/synth2.test.ts packages/shared/src/project/schema.test.ts packages/shared/src/project/accept-list.test.ts
git commit -m "feat(shared): synth2 filter.morph + filter.model descriptors (I3d)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Kernel — MorphFilter module + FilterModule arity

**Files:**
- Modify: `packages/client/src/engine/synth2/kernel/FilterModule.ts` (interface arity)
- Modify: `packages/client/src/engine/synth2/kernel/ClassicFilter.ts` (ignored 4th arg)
- Create: `packages/client/src/engine/synth2/kernel/MorphFilter.ts`
- Test: `packages/client/src/engine/synth2/kernel/MorphFilter.test.ts`

**Interfaces:**
- Consumes: `SvfCore` (`tick(input, cutoffHz, resonance)`, exposes `.low`/`.band`/`.high`, `reset()`).
- Produces: `FilterModule.process(input, cutoffHz, resonance, morph): number` (4-arg). `class MorphFilter implements FilterModule` with `reset()`, `setType()` no-op, `process(...)` equal-power LP→BP→HP blend. `ClassicFilter.process` accepts an optional ignored `_morph?`.

- [ ] **Step 1: Write the failing MorphFilter test**

Create `MorphFilter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { MorphFilter } from './MorphFilter.js';
import { SvfCore } from './SvfCore.js';

const SR = 48000;

// Drive a bare SvfCore identically to get reference low/band/high at the same sample.
function refOutputs(input: Float32Array, cutoff: number, res: number) {
  const svf = new SvfCore(SR);
  const low: number[] = [], band: number[] = [], high: number[] = [];
  for (let i = 0; i < input.length; i++) { svf.tick(input[i], cutoff, res); low.push(svf.low); band.push(svf.band); high.push(svf.high); }
  return { low, band, high };
}

function noise(n: number): Float32Array {
  const b = new Float32Array(n); let s = 12345;
  for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; b[i] = (s / 0x3fffffff) - 1; }
  return b;
}

describe('MorphFilter', () => {
  it('morph 0 = low, 1 = band, 2 = high (equal-power endpoints)', () => {
    const x = noise(2000);
    const ref = refOutputs(x, 1200, 0.4);
    const at = (m: number) => { const f = new MorphFilter(SR); const out: number[] = []; for (let i = 0; i < x.length; i++) out.push(f.process(x[i], 1200, 0.4, m)); return out; };
    const lo = at(0), bd = at(1), hi = at(2);
    for (let i = 0; i < x.length; i++) {
      expect(lo[i]).toBeCloseTo(ref.low[i], 10);
      expect(bd[i]).toBeCloseTo(ref.band[i], 10);
      expect(hi[i]).toBeCloseTo(ref.high[i], 10);
    }
  });

  it('morph 0.5 is the equal-power blend of low and band', () => {
    const x = noise(2000);
    const ref = refOutputs(x, 1200, 0.4);
    const f = new MorphFilter(SR);
    const g = Math.PI / 4; // 0.5 * pi/2
    for (let i = 0; i < x.length; i++) {
      const y = f.process(x[i], 1200, 0.4, 0.5);
      expect(y).toBeCloseTo(Math.cos(g) * ref.low[i] + Math.sin(g) * ref.band[i], 10);
    }
  });

  it('clamps morph outside 0..2', () => {
    const x = noise(500);
    const refLo = refOutputs(x, 1200, 0.4).low;
    const f = new MorphFilter(SR);
    for (let i = 0; i < x.length; i++) expect(f.process(x[i], 1200, 0.4, -1)).toBeCloseTo(refLo[i], 10);
  });

  it('reset clears state (post-reset tick equals a fresh filter)', () => {
    const a = new MorphFilter(SR); const b = new MorphFilter(SR);
    for (let i = 0; i < 500; i++) a.process(Math.random() * 2 - 1, 1200, 0.5, 1);
    a.reset();
    expect(a.process(0.7, 1200, 0.5, 1)).toBeCloseTo(b.process(0.7, 1200, 0.5, 1), 12);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test --workspace @fiddle/client -- MorphFilter`
Expected: FAIL — `MorphFilter` module does not exist.

- [ ] **Step 3: Widen the FilterModule interface**

In `FilterModule.ts`, change `process` and update the doc comment:

```ts
  /** One sample. cutoffHz is the final cutoff (keytrack + env already applied);
   *  resonance is 0..1; morph is the 0..2 LP→BP→HP blend used by MorphFilter
   *  (ClassicFilter ignores it and uses its block-set type). Returns the output. */
  process(input: number, cutoffHz: number, resonance: number, morph: number): number;
```

In `ClassicFilter.ts`, add the ignored optional arg (keeps existing 3-arg call sites/tests compiling):

```ts
  process(input: number, cutoffHz: number, resonance: number, _morph = 0): number {
    this.svf.tick(input, cutoffHz, resonance);
    return this.type === 0 ? this.svf.low : this.type === 1 ? this.svf.band : this.svf.high;
  }
```

- [ ] **Step 4: Create MorphFilter**

Create `MorphFilter.ts`:

```ts
//
// Morph filter (spec §5.3, I3d) — the 2nd FilterModule behind the shared seam.
// One SvfCore; a continuous `morph` 0..2 equal-power crossfades adjacent outputs
// (0 = LP, 1 = BP, 2 = HP). `morph` arrives per-sample (it is a modulatable
// ParamSlot), so the matrix can sweep the filter architecture. setType is inert —
// morph has no discrete type. Pure DSP, no allocation after construction.
//
import type { FilterModule } from './FilterModule';
import { SvfCore } from './SvfCore';

export class MorphFilter implements FilterModule {
  private readonly svf: SvfCore;

  constructor(sampleRate: number) {
    this.svf = new SvfCore(sampleRate);
  }

  reset(): void {
    this.svf.reset();
  }

  // No discrete type — morph is continuous. Kept for the uniform FilterModule shape.
  setType(_type: number): void {}

  process(input: number, cutoffHz: number, resonance: number, morph: number): number {
    let m = morph < 0 ? 0 : morph > 2 ? 2 : morph;
    this.svf.tick(input, cutoffHz, resonance);
    let a: number, b: number, frac: number;
    if (m <= 1) { a = this.svf.low; b = this.svf.band; frac = m; }       // LP → BP
    else        { a = this.svf.band; b = this.svf.high; frac = m - 1; }  // BP → HP
    const g = frac * (Math.PI / 2);
    return Math.cos(g) * a + Math.sin(g) * b;                            // equal-power
  }
}
```

- [ ] **Step 5: Run MorphFilter + ClassicFilter tests to verify green**

Run: `npm test --workspace @fiddle/client -- MorphFilter ClassicFilter`
Expected: PASS (ClassicFilter's existing 3-arg test calls still compile and pass; the new MorphFilter tests pass).

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/engine/synth2/kernel/FilterModule.ts packages/client/src/engine/synth2/kernel/ClassicFilter.ts packages/client/src/engine/synth2/kernel/MorphFilter.ts packages/client/src/engine/synth2/kernel/MorphFilter.test.ts
git commit -m "feat(client): MorphFilter (equal-power LP->BP->HP) behind the filter seam (I3d)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Kernel — Voice holds both filters + block-boundary model select

**Files:**
- Modify: `packages/client/src/engine/synth2/kernel/Voice.ts`
- Modify: `packages/client/src/engine/synth2/kernel/Synth2Kernel.ts`
- Test: `packages/client/src/engine/synth2/kernel/Voice.test.ts`, `packages/client/src/engine/synth2/kernel/Synth2Kernel.test.ts`

**Interfaces:**
- Consumes: `MorphFilter` (Task 2), `FilterModule` type, `slot('filter.morph')`, `PARAM_INDEX['filter.model']`.
- Produces: `Voice.setFilterModel(modelIndex: number): void` (0 = classic, ≥1 = morph; resets the newly-active filter on a change). `Voice` renders through the active filter passing per-sample `morph`. `Synth2Kernel` decodes `filter.model` and calls `voice.setFilterModel(...)` each block.

- [ ] **Step 1: Write the failing Voice tests**

In `Voice.test.ts`, add a describe block:

```ts
describe('Voice filter model (I3d)', () => {
  const SR = 48000;
  const morphIdx = PARAM_INDEX['filter.morph'];

  const render = (v: Voice, frames = 1024) => { const o = new Float32Array(frames); v.renderAdd(o, 0, frames); return o; };
  const sumAbsDiff = (a: Float32Array, b: Float32Array) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s; };

  it('morph model at morph=0 is sample-identical to classic LP (both are the SVF low output)', () => {
    const classic = new Voice(SR, 1); classic.setFilterModel(0); classic.setFilterType(0); classic.noteOn(220, 1, SR);
    const morph0 = new Voice(SR, 1); morph0.setFilterModel(1); morph0.slots[morphIdx].setBase(0); morph0.noteOn(220, 1, SR);
    const a = render(classic); const b = render(morph0);
    for (let i = 0; i < a.length; i++) expect(b[i]).toBeCloseTo(a[i], 6);
  });

  it('morph=2 (HP) differs from morph=0 (LP) on the same note', () => {
    const lp = new Voice(SR, 1); lp.setFilterModel(1); lp.slots[morphIdx].setBase(0); lp.noteOn(220, 1, SR);
    const hp = new Voice(SR, 1); hp.setFilterModel(1); hp.slots[morphIdx].setBase(2); hp.noteOn(220, 1, SR);
    expect(sumAbsDiff(render(lp), render(hp))).toBeGreaterThan(1); // clearly different signals
  });

  it('switching back to classic restores the classic path', () => {
    const a = new Voice(SR, 1); a.noteOn(440, 1, SR);            // default model classic
    const b = new Voice(SR, 1); b.setFilterModel(1); b.setFilterModel(0); b.noteOn(440, 1, SR);
    const oa = new Float32Array(512); const ob = new Float32Array(512);
    a.renderAdd(oa, 0, 512); b.renderAdd(ob, 0, 512);
    for (let i = 0; i < oa.length; i++) expect(ob[i]).toBeCloseTo(oa[i], 6);
  });

  it('re-selecting morph resets its filter (no stale-state bleed across a classic detour)', () => {
    // A: morph → render (accumulate morph-filter state) → classic → morph (reset) → sample.
    // B: morph from clean, never detoured → sample. Reset makes A's first re-morph sample == B.
    const A = new Voice(SR, 1); const B = new Voice(SR, 1);
    A.setFilterModel(1); A.slots[morphIdx].setBase(1); A.noteOn(440, 1, 200000);
    B.setFilterModel(1); B.slots[morphIdx].setBase(1); B.noteOn(440, 1, 200000);
    const warm = new Float32Array(2048);
    A.renderAdd(warm, 0, 2048);            // A's morph filter now holds state
    B.renderAdd(warm.fill(0), 0, 2048);    // B identical so osc/env states match A
    A.setFilterModel(0);                   // detour to classic
    A.renderAdd(warm.fill(0), 0, 64);      // run classic a bit (morph filter idle, would go stale)
    B.renderAdd(warm.fill(0), 0, 64);      // keep B in lockstep on the SAME (morph) model
    A.setFilterModel(1);                   // back to morph → reset() drops A's stale state
    const oa = new Float32Array(1); const ob = new Float32Array(1);
    A.renderAdd(oa, 0, 1); B.renderAdd(ob, 0, 1);
    expect(oa[0]).toBeCloseTo(ob[0], 6);   // fails if setFilterModel doesn't reset on change
  });
});
```

> Note: the third test's teeth come from the reset. If `setFilterModel` is changed to NOT reset, A re-enters morph with stale `SvfCore` state and `oa[0]` diverges from `ob[0]`. (B stays on morph the whole time, so its morph-filter state is the "clean continuation" reference. The 64-sample classic detour on A is what would otherwise leave A's morph state stale.)

- [ ] **Step 2: Run the Voice tests to verify they fail**

Run: `npm test --workspace @fiddle/client -- Voice.test`
Expected: FAIL — `setFilterModel` is not a function.

- [ ] **Step 3: Wire both filters into the Voice**

In `Voice.ts`:

Add the import and a `FilterModule` type import:

```ts
import { ClassicFilter } from './ClassicFilter';
import { MorphFilter } from './MorphFilter';
import type { FilterModule } from './FilterModule';
```

Replace the single filter field (`private readonly filter: ClassicFilter;`) with:

```ts
  private readonly classicFilter: ClassicFilter;
  private readonly morphFilter: MorphFilter;
  private activeFilter: FilterModule;
  private readonly morphSlot: ParamSlot;
```

In the constructor, replace `this.filter = new ClassicFilter(sampleRate);` with:

```ts
    this.classicFilter = new ClassicFilter(sampleRate);
    this.morphFilter = new MorphFilter(sampleRate);
    this.activeFilter = this.classicFilter; // model default 'classic'
    this.morphSlot = slot('filter.morph');
```

Change `setFilterType` to target the classic filter explicitly (type is only meaningful for classic; set regardless of active model so it survives a round trip):

```ts
  /** Block-boundary discrete update: select LP(0)/BP(1)/HP(2) on the classic filter. */
  setFilterType(type: number): void {
    this.classicFilter.setType(type);
  }

  /** Block-boundary discrete update: select classic(0) / morph(≥1). On a change,
   *  reset the newly-active filter so its stale SvfCore state can't click. */
  setFilterModel(modelIndex: number): void {
    const next: FilterModule = modelIndex >= 1 ? this.morphFilter : this.classicFilter;
    if (next !== this.activeFilter) { next.reset(); this.activeFilter = next; }
  }
```

In `noteOn`, change `this.filter.reset();` to `this.activeFilter.reset();`.

In `renderAdd`, change the filter call to pass per-sample morph (called once per sample, classic ignores it):

```ts
      const filtered = this.activeFilter.process(mix, fc, this.resSlot.next(), this.morphSlot.next());
```

- [ ] **Step 4: Run the Voice tests to verify they pass**

Run: `npm test --workspace @fiddle/client -- Voice.test`
Expected: PASS.

- [ ] **Step 5: Write the failing kernel test**

In `Synth2Kernel.test.ts`, add (mirror the existing `filter.type` decode test):

```ts
  it('decodes filter.model so the morph filter reaches the voices (output differs from classic default)', () => {
    const render = (model: number, morph: number) => {
      const k = new Synth2Kernel(48000);
      const block = defaultParamBlock();
      block[PARAM_INDEX['filter.model']] = model;
      block[PARAM_INDEX['filter.morph']] = morph;
      k.applyParams(block);
      k.noteOn(0, 220, 1, 48000);           // match the kernel's real noteOn signature
      const out = new Float32Array(2048);
      k.process(out);
      return out;
    };
    const classic = render(0, 0);            // default model classic (LP)
    const morphHp = render(1, 2);            // morph model, HP end
    let diff = 0; for (let i = 0; i < classic.length; i++) diff += Math.abs(classic[i] - morphHp[i]);
    expect(diff).toBeGreaterThan(1);         // model decode took effect; voices used the morph path
  });
```

> Adjust the `Synth2Kernel` constructor/`noteOn`/`process` calls to match their real signatures in `Synth2Kernel.ts` (the existing kernel tests in this file show the exact shape — reuse their setup helper if one exists).

- [ ] **Step 6: Run the kernel test to verify it fails**

Run: `npm test --workspace @fiddle/client -- Synth2Kernel`
Expected: FAIL — model not decoded; both renders use classic LP, so `hp ≈ lp`.

- [ ] **Step 7: Decode filter.model in the kernel**

In `Synth2Kernel.ts` `applyParams`, beside the existing `const filterType = ...` line:

```ts
    const filterModel = Math.round(this.block[PARAM_INDEX['filter.model']]);
```

and in the existing voice loop, beside `voice.setFilterType(filterType);`:

```ts
      voice.setFilterModel(filterModel);
```

- [ ] **Step 8: Run the kernel + full client kernel tests to verify green**

Run: `npm test --workspace @fiddle/client -- Synth2Kernel Voice.test params.test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/client/src/engine/synth2/kernel/Voice.ts packages/client/src/engine/synth2/kernel/Synth2Kernel.ts packages/client/src/engine/synth2/kernel/Voice.test.ts packages/client/src/engine/synth2/kernel/Synth2Kernel.test.ts
git commit -m "feat(client): Voice selects classic/morph filter at the block boundary (I3d)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Client — engine encode + immediate model flush + heal

**Files:**
- Modify: `packages/client/src/composables/useSynth.ts` (`DISCRETE_LEAF_FIELDS`)
- Test: `packages/client/src/engine/Synth2Engine.test.ts`, `packages/client/src/composables/useSynth.test.ts`, `packages/client/src/project/reconcile.test.ts`

**Interfaces:**
- Consumes: `filter.morph`/`filter.model` descriptors + defaults (Task 1); the existing descriptor-walk encode in `Synth2Engine` (already handles continuous + `kind:'enum'` leaves via `encodeEnum`/`SYNTH2_ENUM_VALUES`).
- Produces: `filter.model` flushes immediately to the network (added to `DISCRETE_LEAF_FIELDS`); both leaves round-trip and heal.

- [ ] **Step 1: Write the failing engine + sync + heal tests**

In `Synth2Engine.test.ts`, add (mirror the existing `filter.type` encode test):

```ts
  it('encodes filter.morph (continuous) and filter.model (enum index) into the block', () => {
    const { engine, lastBlock } = makeEngine(); // reuse this file's existing harness
    engine.applyParams({ ...DEFAULT_SYNTH2_PARAMS, filter: { ...DEFAULT_SYNTH2_PARAMS.filter, morph: 2, model: 'morph' } });
    expect(lastBlock()[PARAM_INDEX['filter.morph']]).toBeCloseTo(2, 6);
    expect(lastBlock()[PARAM_INDEX['filter.model']]).toBe(1); // enumValues.indexOf('morph')
  });
```

In `useSynth.test.ts`, add a convergence test (mirror the existing `filter.type`/`osc.sync` convergence tests):

```ts
  it('filter.morph change and filter.model flip converge between two clients (no echo)', async () => {
    const { a, b } = await twoClients();           // reuse this file's existing harness
    a.params.filter.model = 'morph';
    a.params.filter.morph = 1.5;
    await settle();
    expect(b.params.filter.model).toBe('morph');
    expect(b.params.filter.morph).toBeCloseTo(1.5, 6);
  });
```

In `reconcile.test.ts`, add to the existing synth2 filter-heal area:

```ts
  it('heals a synth2 slice missing filter.morph/filter.model to defaults', () => {
    const p = freshProject();
    const synth2 = p.tracks[0].engines.synth2 as any;
    delete synth2.filter.morph;
    delete synth2.filter.model;
    const healed = reconcileWithDefaults(p);
    expect(healed.tracks[0].engines.synth2.filter.morph).toBe(0);
    expect(healed.tracks[0].engines.synth2.filter.model).toBe('classic');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test --workspace @fiddle/client -- Synth2Engine useSynth.test reconcile`
Expected: FAIL — the `useSynth` convergence test fails because `filter.model` (a discrete enum) is not flushed immediately. (The engine-encode and heal tests may already pass on the descriptor-derived paths from Task 1 — confirm which fail and proceed.)

- [ ] **Step 3: Add `'model'` to the immediate-flush set**

In `useSynth.ts`, add to `DISCRETE_LEAF_FIELDS`:

```ts
  'model', // synth2 filter.model enum: a discrete selector flip — flush immediately
```

(`filter.morph` is continuous and is covered by the existing synth2 leaf-diff drill; no edit. The `Synth2Engine` descriptor-walk already encodes both leaves — no edit.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test --workspace @fiddle/client -- Synth2Engine useSynth.test reconcile`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/composables/useSynth.ts packages/client/src/engine/Synth2Engine.test.ts packages/client/src/composables/useSynth.test.ts packages/client/src/project/reconcile.test.ts
git commit -m "feat(client): flush filter.model immediately + heal morph/model leaves (I3d)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: UI — Synth2Panel FILTER column model toggle + morph knob

**Files:**
- Modify: `packages/client/src/components/Synth2Panel.vue`
- Test: `packages/client/src/components/Synth2Panel.test.ts`

**Interfaces:**
- Consumes: `params.filter.model` (`'classic'|'morph'`), `params.filter.morph` (0..2), `DEFAULTS.filter.morph`, the `ks` keyboard-sync helper, the `Knob` component.
- Produces: a CLASSIC|MORPH toggle that swaps the LP/BP/HP selector for a Morph knob.

- [ ] **Step 1: Write the failing component test**

In `Synth2Panel.test.ts`, add (mirror the existing filter-type-selector tests):

```ts
  it('classic model shows the LP/BP/HP selector and no Morph knob', () => {
    const wrapper = mountPanel();                       // reuse this file's existing mount helper
    wrapper.vm.params.filter.model = 'classic';
    return wrapper.vm.$nextTick().then(() => {
      expect(wrapper.find('.filter-type-selector').exists()).toBe(true);
      expect(wrapper.findAll('.knob').some(k => k.text().includes('Morph') && k.html().includes('filter'))).toBe(false);
    });
  });

  it('morph model hides the type selector and shows a Morph knob bound to params.filter.morph', async () => {
    const wrapper = mountPanel();
    wrapper.vm.params.filter.model = 'morph';
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.filter-type-selector').exists()).toBe(false);
    const morphKnob = wrapper.findComponent({ name: 'Knob', props: { /* identify by label */ } });
    // Simplest robust assertion: the FILTER column renders a knob whose label is "Morph".
    expect(wrapper.html()).toContain('Morph');
  });

  it('the CLASSIC|MORPH toggle updates params.filter.model', async () => {
    const wrapper = mountPanel();
    wrapper.vm.params.filter.model = 'classic';
    await wrapper.vm.$nextTick();
    await wrapper.find('.filter-model-btn.to-morph').trigger('click');
    expect(wrapper.vm.params.filter.model).toBe('morph');
  });
```

> Match the existing test file's mounting/query idiom (it already mounts `Synth2Panel` and asserts on `.filter-type-btn`). Use the same selectors style; the assertions above are illustrative of intent — keep them green-able against the markup in Step 3.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test --workspace @fiddle/client -- Synth2Panel`
Expected: FAIL — no `.filter-model-btn`, Morph knob absent.

- [ ] **Step 3: Add the toggle + conditional control to the FILTER column**

In `Synth2Panel.vue`, replace the FILTER `<h3>` + `filter-type-selector` block (currently lines ~112–117) with:

```html
        <h3>FILTER</h3>
        <div class="filter-model-selector">
          <button type="button" class="filter-model-btn to-classic" :class="{ active: params.filter.model === 'classic' }" @click="params.filter.model = 'classic'">CLASSIC</button>
          <button type="button" class="filter-model-btn to-morph" :class="{ active: params.filter.model === 'morph' }" @click="params.filter.model = 'morph'">MORPH</button>
        </div>
        <div v-if="params.filter.model === 'classic'" class="filter-type-selector">
          <button type="button" class="filter-type-btn" :class="{ active: params.filter.type === 'lp' }" @click="params.filter.type = 'lp'">LP</button>
          <button type="button" class="filter-type-btn" :class="{ active: params.filter.type === 'bp' }" @click="params.filter.type = 'bp'">BP</button>
          <button type="button" class="filter-type-btn" :class="{ active: params.filter.type === 'hp' }" @click="params.filter.type = 'hp'">HP</button>
        </div>
        <div v-else class="knob-row">
          <Knob label="Morph" :min="0" :max="2" :step="0.01" :defaultValue="DEFAULTS.filter.morph" v-model="params.filter.morph" :syncPath="ks.pathFor(['filter', 'morph'])" @gesture-end="ks.end(['filter', 'morph'])" />
        </div>
```

The Cutoff/Res/KeyTrk/EnvAmt `knob-row` below stays unchanged. Add a CSS rule so the model buttons reuse the type-button look — append to the component's `<style>` (find the existing `.filter-type-selector`/`.filter-type-btn` rules and add the model selectors to the same declarations), e.g.:

```css
.filter-model-selector { display: flex; gap: 4px; margin-bottom: 6px; }
.filter-model-btn { /* copy the .filter-type-btn rule body */ }
.filter-model-btn.active { /* copy the .filter-type-btn.active rule body */ }
```

- [ ] **Step 4: Run the component test to verify it passes**

Run: `npm test --workspace @fiddle/client -- Synth2Panel`
Expected: PASS.

- [ ] **Step 5: Rebuild the worklet and run the full gate**

Run (from repo root): `npm run typecheck && npm test && npm run build`
Expected: PASS across `@fiddle/shared`, `@fiddle/client`, `@fiddle/server`; `npm run build` emits `packages/client/public/worklets/synth2-processor.js` containing the `MorphFilter` blend (the build runs `build:worklet` first).

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/components/Synth2Panel.vue packages/client/src/components/Synth2Panel.test.ts
git commit -m "feat(client): Synth2Panel CLASSIC|MORPH toggle + Morph knob (I3d)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification (whole implementation)

- **Gate (must be green):** `npm run typecheck && npm test && npm run build` at repo root — all three workspaces; build emits the worklet with the MorphFilter code.
- **Allocation discipline:** no `new`/array growth in the Voice render loop or `MorphFilter.process`; both filters preallocated in the Voice constructor.
- **Browser verify (Playwright MCP, then close the session/tab):**
  1. `npm run dev`; open/create a session; add a synth2 track.
  2. In the FILTER column click **MORPH** — confirm the LP/BP/HP selector is replaced by a **Morph** knob; sweep it and hear LP → BP → HP.
  3. In the MATRIX column route `lfo1 → filter.morph` (amount > 0); confirm the filter **architecture** sweeps under the LFO.
  4. Click **CLASSIC** — confirm the LP/BP/HP selector returns and the sound matches the pre-change classic behavior (non-destructive; `filter.type` preserved).
  5. Two-client check: flip `filter.model` and move the Morph knob in client A; confirm client B converges and hears it.
  6. **Close the browser/session** (AGENTS.md cleanup rule).
- Keep the branch after verify — the user browser-verifies before merge (don't auto-merge).

## Spec coverage self-check

- Spec §1 descriptor rows → Task 1. §2 params/defaults → Task 1. §3 schema/accept-list (derived) → Task 1 tests. §4 MorphFilter + FilterModule arity → Task 2. §5 Voice/kernel wiring → Task 3. §6 kernel model decode → Task 3. §7 engine/params/useSynth → Task 4. §8 panel UI → Task 5. §9 heal → Task 4. Testing matrix → distributed across the per-task tests + final gate. No spec requirement is left without a task.
