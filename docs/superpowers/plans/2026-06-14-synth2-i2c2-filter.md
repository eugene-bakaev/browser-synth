# synth2 I2c-2 — ClassicFilter + env2 + keytrack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give synth2 its filter: a shared zero-delay-feedback state-variable core (`SvfCore`) behind a swappable `FilterModule` seam, a `ClassicFilter` (LP/BP/HP) selected by the engine's first **enum** descriptor (`filter.type`), a second envelope (`env2`) hardwired to cutoff via a bipolar-octaves `filter.envAmount`, and **keytrack** (cutoff follows note pitch) — end-to-end from descriptor table → schema/accept-list → engine encode → kernel DSP → panel.

**Architecture:** Continuous filter params (`cutoff`/`resonance`/`keyTrack`/`envAmount`) ride the Float32Array param block as normal smoothed `ParamSlot`s. `filter.type` is the first `kind: 'enum'` descriptor — like the I2c-1 booleans it rides the *same* block (encoded as the value's **index**: `lp=0,bp=1,hp=2`), is applied at block boundaries with no smoother, and is excluded from the mod matrix. The DSP is a `Voice.ts`-only patch change: each voice gains a second `LoopEnvelope` (env2) and a `ClassicFilter`; the mixer output is filtered before the env1 VCA. Cutoff is computed per-sample in octaves: `baseCutoff × 2^(keyTrack·log2(noteFreq/C4) + envAmount·env2)`. No worklet protocol change — the block grows automatically because `PARAM_COUNT` derives from the descriptor table.

**Tech Stack:** TypeScript, npm workspaces (`@fiddle/shared`, `@fiddle/client`), Vitest, Zod, Vue 3 (panel), Web Audio AudioWorklet (kernel is pure TS, tested in Node).

---

## Context for the implementer (read once)

This is slice **I2c-2** of the synth2 engine — the last slice of I2 (the "first full voice"). The approved design spec is `docs/superpowers/specs/2026-06-12-worklet-synth-engine-design.md`; the load-bearing sections are **§5.1** (signal flow: osc → mixer → **filter** → VCA), **§5.3** (two swappable filters on one ZDF SVF core; `classic` = LP/BP/HP; shared `cutoff`/`resonance`/`keyTrack`; hardwired `env2 → cutoff` in bipolar octaves ±4 = `filterEnvAmount`), **§5.4** (env2 is a plain ADSR here — loop is I3), **§6.3** (ParamSlot + the *modulation coverage rule*: discrete/structural params are NOT mod destinations), **§6.4** (the descriptor table is the single source of truth, **append-only**), **§6.6** (param protocol: "enums and booleans encoded as floats", discrete params "switch at block boundaries"), and the I2 iteration scope at lines 563–567. You do **not** need to read the whole spec — the relevant rules are inlined below.

**Five invariants you must not break:**

1. **The descriptor table is append-only.** `SYNTH2_DESCRIPTORS` array position *is* the Float32Array param-block index. Never insert or reorder — only append. The 9 new rows (`env2.{a,d,s,r}`, `filter.{cutoff,resonance,keyTrack,envAmount,type}`) go at the **end**, after `osc3.sync`. Their semantic grouping under `env2`/`filter` is by dotted `key`, not array position.

2. **Kernel files import only from `kernel/` and `@fiddle/shared`.** No Web Audio / DOM / `postMessage` types under `packages/client/src/engine/synth2/kernel/`. Zero allocation in the `process`/`renderAdd` hot path (no `new`, no array growth, no closures).

3. **Discrete params (bool AND enum) are NOT smoothed and NOT mod-matrix destinations.** `filter.type` has `modulatable: false`, `modScale: 0`, `kind: 'enum'`. The kernel reads it raw at the block boundary (`Math.round(block[idx])`), never through a `ParamSlot.next()` smoother.

4. **`filter.envAmount` is continuous but NOT a mod destination.** It is the depth of a *hardwired* modulation (env2 → cutoff), analogous to the matrix's own `amount` field, which §6.3 keeps a plain non-modulatable param ("modulating modulation depth is a deliberate non-goal"). The spec's destination list (§5.6, lines 205–206) lists `filter cutoff/resonance/keyTrack` but **omits** `filterEnvAmount`. So it is the first `continuous` row with `modulatable: false`. This is deliberate — do not "fix" it to `true`, and do not assume `continuous ⟺ modulatable` anywhere.

5. **`env2` runs but does not extend voice life.** Voice `active` stays env1-driven (the VCA). env2 is a cutoff modulator; when env1 closes, the voice is silent regardless of env2's stage.

**Spec-ambiguity resolutions (decisions already made — implement these, do not re-litigate):**

- **Param key is `filter.type`, not `classic.type`.** §6.3 line 313 writes `classic.type` in prose, but the persistence/schema section (§9, lines 438–440) is authoritative for wire/storage paths and specifies the filter as **one flat group** `{model, type, morph, cutoff, resonance, keyTrack}`. So both models' params live under a single `filter` module; classic reads `filter.type`, the future morph filter will read `filter.morph`. Path: `engines.synth2.filter.type`.
- **`filter.model` selector + `MorphFilter` are DEFERRED to I3.** Only one filter model exists in I2c-2, so a runtime model *selector* is premature (YAGNI), and the spec puts `MorphFilter` in I3 (lines 569–575). We build the **`FilterModule` seam** now (the interface + `ClassicFilter`), and `Voice` instantiates `ClassicFilter` directly. I3 adds the `filter.model` enum, `MorphFilter`, `filter.morph`, and the per-block pointer-swap behind this same seam.
- **`filter.envAmount` (descriptor key) is the spec's prose `filterEnvAmount`.** The descriptor key regex requires `module.field` form, so the flat scalar lives as `filter.envAmount`. Default **2.4** octaves (spec's §5.8 default patch, line 232).
- **Resonance→Q mapping** in `SvfCore`: `Q = 0.5 + resonance·9.5` (res 0→Q 0.5, res 1→Q 10), `k = 1/Q`. Bounded and musical — no self-oscillation blow-up at res 1.
- **Keytrack reference pitch** is middle C, `C4 = 261.6256 Hz`. `keyTrack 1` ⇒ cutoff tracks note pitch 1:1; `keyTrack 0` ⇒ no tracking.

**Accepted simplification (spec-sanctioned).** §10 line 426 calls for a per-block denormal flush of filter/envelope state below 1e-15. With the ZDF SVF and bounded Q this is a performance hygiene item, not a correctness one; a per-block flush + per-sample `tan`/`pow` optimization are deferred to **I4 polish** (the same bucket as the I2c-1 sync-edge BLEP). The DSP is correct and bounded without them. This is a deliberate, documented scope cut.

**Out of scope for I2c-2 (do not build):**
- `filter.model` enum, `MorphFilter`, `filter.morph` → **I3** (see resolution above).
- The mod matrix, LFOs, env3, `env.loop` boolean → **I3** (env2 is a plain ADSR here).
- A per-block denormal flush / `tan`/`pow` coefficient caching → **I4 polish**.
- `sessions.ts` `as unknown as Project` double-cast — orthogonal latent debt; adding filter descriptors does not fix or worsen the numeric-module `z.infer` inference. Leave it.

**Branch:** `feat/synth2-i2c2-filter` (already created off `main`). Do not merge — the user browser-verifies before merge.

---

## File Structure (what changes and why)

**`@fiddle/shared`:**
- `packages/shared/src/engines/synth2-descriptors.ts` — widen `Synth2Kind` to add `'enum'`; add optional `enumValues` field; add `encodeEnum`/`decodeEnum` helpers + the derived `SYNTH2_ENUM_VALUES` map; append the 9 `env2.*`/`filter.*` rows. *Single source of truth.*
- `packages/shared/src/engines/synth2-descriptors.test.ts` — update exact-key guard (26 → 35 keys); assert `filter.type` is `kind:'enum'` with `['lp','bp','hp']`; assert `filter.envAmount` is continuous yet `modulatable:false`; `encodeEnum`/`decodeEnum` round-trip.
- `packages/shared/src/engines/synth2.ts` — add `Synth2FilterParams` + `env2`/`filter` fields to `Synth2EngineParams`; make `buildDefaults` decode `enum` descriptors to their string value.
- `packages/shared/src/engines/synth2.test.ts` — assert filter/env2 defaults (`filter.type==='lp'`, cutoff 2000, resonance 0.15, envAmount 2.4, env2 a/d/s/r).
- `packages/shared/src/project/schema.ts` — add the `z.enum(...)` leaf branch (replacing the I2c-1 enum-fallthrough caveat).
- `packages/shared/src/project/schema.test.ts` — assert `filter.type` is a string-enum leaf (accepts `'lp'/'bp'/'hp'`, rejects `'xyz'`/numbers); `filter.cutoff` numeric.
- `packages/shared/src/project/accept-list.test.ts` — assert `engines.synth2.filter.type` round-trips an enum string and rejects a number; `filter.cutoff` numeric round-trip. (No accept-list *code* change — patterns + `resolveLeafSchema` are descriptor-driven.)

**`@fiddle/client`:**
- `packages/client/src/engine/synth2/kernel/SvfCore.ts` *(new)* — shared ZDF SVF math + state; exposes `low`/`band`/`high` after `tick(input, cutoffHz, resonance)`.
- `packages/client/src/engine/synth2/kernel/SvfCore.test.ts` *(new)* — LP/HP/BP behaviour + stability under cutoff/resonance sweeps.
- `packages/client/src/engine/synth2/kernel/FilterModule.ts` *(new)* — the swappable filter interface.
- `packages/client/src/engine/synth2/kernel/ClassicFilter.ts` *(new)* — `FilterModule` impl picking one `SvfCore` output by `type`.
- `packages/client/src/engine/synth2/kernel/ClassicFilter.test.ts` *(new)* — type selection, `setType` clamp, `reset`.
- `packages/client/src/engine/synth2/kernel/Voice.ts` — add env2 (`LoopEnvelope`) + `ClassicFilter` + the 4 filter `ParamSlot`s; per-sample cutoff routing (keytrack + env2·envAmount); filter the mix before the VCA; `setFilterType`; cache keytrack octaves at note-on; reset filter/env2 on fresh start.
- `packages/client/src/engine/synth2/kernel/Synth2Kernel.ts` — broadcast `filter.type` (rounded) to every voice in `applyParams`.
- `packages/client/src/engine/synth2/kernel/Synth2Kernel.test.ts` — integration: low cutoff attenuates vs high; lp≠hp; keytrack raises effective cutoff with pitch; envAmount changes the sound; finite/bounded.
- `packages/client/src/engine/Synth2Engine.ts` — `applyParams` encodes `enum` (string) values to their block index via `SYNTH2_ENUM_VALUES`.
- `packages/client/src/engine/Synth2Engine.test.ts` — `filter.type='hp'` writes 2; `'lp'` writes 0; `mode:'poly'` still skipped (top-level string).
- `packages/client/src/components/Synth2Panel.vue` — a FILTER module-group (LP/BP/HP segmented selector + cutoff/resonance/keytrack/envAmount knobs) and an ENV2 module-group (a/d/s/r knobs).
- `packages/client/src/components/Synth2Panel.test.ts` — filter-type selector renders + click sets `params.filter.type`; cutoff knob bound.
- `packages/client/src/composables/useSynth.ts` — add `'type'` to `DISCRETE_LEAF_FIELDS` so the filter-type flip flushes immediately (like `sync`/`muted`).
- `packages/client/src/composables/useSynth.test.ts` — `filter.type` change flushes immediately (no throttle).
- `packages/client/src/project/reconcile.test.ts` — an old synth2 slice lacking `filter`/`env2` heals to defaults via `reconcileWithDefaults`. (No reconcile *code* change — `storage.ts` already `deepMerge`s `Synth2Engine.DEFAULT_PARAMS`.)

---

## The merge gate (run before declaring the slice done)

From the repo root:

```bash
npm run typecheck && npm test && npm run build
```

Expected: typecheck clean across all 3 workspaces; all tests green; the build emits `packages/client/public/worklets/synth2-processor.js`. Per-task you run the *narrower* commands shown in each task; the full gate is Task 11.

---

### Task 1: `enum` descriptor kind + helpers + the env2/filter rows

**Files:**
- Modify: `packages/shared/src/engines/synth2-descriptors.ts`
- Test: `packages/shared/src/engines/synth2-descriptors.test.ts`

- [ ] **Step 1: Update the failing exact-key + kind tests**

In `synth2-descriptors.test.ts`, update the imports, replace the exact-key list test, add enum tests, and make the "continuous" test self-maintaining. Replace the existing import line and the `'covers exactly the I2c-1 param set …'` / `'all I2b-and-earlier rows are continuous …'` tests with:

```ts
import { describe, it, expect } from 'vitest';
import {
  SYNTH2_DESCRIPTORS, isDiscrete, encodeBool, decodeBool, encodeEnum, decodeEnum,
} from './synth2-descriptors.js';

// The complete set of discrete (non-continuous) descriptor keys. Continuous
// rows are everything else. Update this when appending discrete params.
const DISCRETE_KEYS = ['osc1.sync', 'osc2.sync', 'osc3.sync', 'filter.type'];
```

Replace the exact-key list assertion body with:

```ts
  it('covers exactly the I2c-2 param set (append-only from here)', () => {
    expect(SYNTH2_DESCRIPTORS.map(d => d.key)).toEqual([
      // I1 — osc1 + env1
      'osc1.morph', 'osc1.pulseWidth', 'osc1.coarse', 'osc1.fine', 'osc1.level',
      'env1.a', 'env1.d', 'env1.s', 'env1.r',
      // I2b — osc2, osc3, noise, fm
      'osc2.morph', 'osc2.pulseWidth', 'osc2.coarse', 'osc2.fine', 'osc2.level',
      'osc3.morph', 'osc3.pulseWidth', 'osc3.coarse', 'osc3.fine', 'osc3.level',
      'noise.level', 'noise.color',
      'fm.osc2', 'fm.osc3',
      // I2c-1 — hard sync (discrete booleans)
      'osc1.sync', 'osc2.sync', 'osc3.sync',
      // I2c-2 — env2 + classic filter
      'env2.a', 'env2.d', 'env2.s', 'env2.r',
      'filter.cutoff', 'filter.resonance', 'filter.keyTrack', 'filter.envAmount', 'filter.type',
    ]);
  });

  it('discrete rows are exactly DISCRETE_KEYS; everything else is continuous', () => {
    const discrete = SYNTH2_DESCRIPTORS.filter(isDiscrete).map(d => d.key);
    expect(discrete.sort()).toEqual([...DISCRETE_KEYS].sort());
  });

  it('filter.type is the first enum descriptor (lp/bp/hp, not a mod dest)', () => {
    const d = SYNTH2_DESCRIPTORS.find(x => x.key === 'filter.type')!;
    expect(d.kind).toBe('enum');
    expect(d.enumValues).toEqual(['lp', 'bp', 'hp']);
    expect(isDiscrete(d)).toBe(true);
    expect(d.modulatable).toBe(false);
    expect(d.default).toBe(0); // 'lp'
  });

  it('filter.envAmount is continuous but NOT a mod destination (hardwired depth)', () => {
    const d = SYNTH2_DESCRIPTORS.find(x => x.key === 'filter.envAmount')!;
    expect(isDiscrete(d)).toBe(false);     // continuous: smoothed ParamSlot
    expect(d.modulatable).toBe(false);     // but excluded from the matrix
    expect(d.min).toBe(-4);
    expect(d.max).toBe(4);
  });

  it('encodeEnum/decodeEnum round-trip by index', () => {
    const v = ['lp', 'bp', 'hp'] as const;
    expect(encodeEnum('lp', v)).toBe(0);
    expect(encodeEnum('bp', v)).toBe(1);
    expect(encodeEnum('hp', v)).toBe(2);
    expect(encodeEnum('nope', v)).toBe(0);   // unknown → first value
    expect(decodeEnum(0, v)).toBe('lp');
    expect(decodeEnum(2, v)).toBe('hp');
    expect(decodeEnum(1.6, v)).toBe('hp');   // rounds to nearest index
    expect(decodeEnum(9, v)).toBe('hp');     // clamps to last
    expect(decodeEnum(-3, v)).toBe('lp');    // clamps to first
  });
```

> Keep the existing `'has unique keys …'`, `'every default lies within [min, max]'`, `'sync rows are discrete booleans …'`, and `'encodeBool/decodeBool round-trip'` tests unchanged — they still pass (2.4 ∈ [−4, 4]; 0 ∈ [0, 2]; min < max for both new ranges).

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -w @fiddle/shared -- synth2-descriptors`
Expected: FAIL — `encodeEnum`/`decodeEnum` not exported; key list mismatch; `filter.type` not found.

- [ ] **Step 3: Implement the enum kind, helpers, the derived map, and the rows**

In `synth2-descriptors.ts`, widen the kind union (update the comment) and add the `enumValues` field:

```ts
// Discrete kinds ride the SAME Float32Array param block as continuous params
// (spec §6.6: "enums and booleans encoded as floats") but are applied at block
// boundaries WITHOUT a smoother and are excluded from the mod matrix.
//   'bool' — I2c-1 osc hard-sync toggles (encoded 0/1).
//   'enum' — I2c-2 filter.type (encoded as the value's index; see enumValues).
export type Synth2Kind = 'continuous' | 'bool' | 'enum';
```

Add `enumValues` to the interface (after `kind?`):

```ts
  /** Discrete kinds skip the smoother and the mod matrix. Omitted ⇒ 'continuous'. */
  kind?: Synth2Kind;
  /** For kind:'enum' only — the ordered value set; the block stores the index. */
  enumValues?: readonly string[];
```

Add the enum helpers + derived map after `encodeBool`/`decodeBool`:

```ts
/** Enum ⇄ float-block encoding (spec §6.6): the block stores the value's index.
 *  Unknown value → 0 (first), so a corrupt/old wire value degrades to the default. */
export const encodeEnum = (value: string, values: readonly string[]): number => {
  const i = values.indexOf(value);
  return i < 0 ? 0 : i;
};
export const decodeEnum = (n: number, values: readonly string[]): string => {
  const i = Math.round(n);
  return values[i < 0 ? 0 : i >= values.length ? values.length - 1 : i] ?? values[0];
};

/** key → enum value set, for the descriptors that declare one. Engine + kernel
 *  use this to encode/decode enum leaves without re-walking the table. */
export const SYNTH2_ENUM_VALUES: Readonly<Record<string, readonly string[]>> =
  Object.fromEntries(
    SYNTH2_DESCRIPTORS.filter(d => d.kind === 'enum' && d.enumValues).map(d => [d.key, d.enumValues!]),
  );
```

> `SYNTH2_ENUM_VALUES` references `SYNTH2_DESCRIPTORS`, so it must be declared **after** the array literal. Place it at the very bottom of the file (after the `]` closing `SYNTH2_DESCRIPTORS`). `encodeEnum`/`decodeEnum` can sit with `encodeBool`/`decodeBool` above the array.

Append after the `osc3.sync` row (keep these the last entries):

```ts
  { key: 'osc3.sync',       min: 0,    max: 1,    default: 0,   taper: 'linear',     modulatable: false, modScale: 0, kind: 'bool' },
  // --- I2c-2 filter section (append-only). env2 mirrors env1 (a/d/r expOctaves
  // time taper, s linear). filter cutoff is expOctaves (±4 oct mod range);
  // resonance/keyTrack linear. filter.envAmount is the HARDWIRED env2→cutoff
  // depth in bipolar octaves (±4): continuous (smoothed) but NOT a mod dest
  // (spec §5.6 omits it), so modulatable:false. filter.type is the first ENUM —
  // rides the block as an index (lp=0,bp=1,hp=2), applied at the block boundary.
  { key: 'env2.a',          min: 0.001, max: 10,    default: 0.01, taper: 'expOctaves', modulatable: true,  modScale: 4 },
  { key: 'env2.d',          min: 0.001, max: 10,    default: 0.2,  taper: 'expOctaves', modulatable: true,  modScale: 4 },
  { key: 'env2.s',          min: 0,     max: 1,     default: 0.5,  taper: 'linear',     modulatable: true,  modScale: 1 },
  { key: 'env2.r',          min: 0.001, max: 10,    default: 0.5,  taper: 'expOctaves', modulatable: true,  modScale: 4 },
  { key: 'filter.cutoff',   min: 20,    max: 20000, default: 2000, taper: 'expOctaves', modulatable: true,  modScale: 4 },
  { key: 'filter.resonance',min: 0,     max: 1,     default: 0.15, taper: 'linear',     modulatable: true,  modScale: 1 },
  { key: 'filter.keyTrack', min: 0,     max: 1,     default: 0,    taper: 'linear',     modulatable: true,  modScale: 1 },
  { key: 'filter.envAmount',min: -4,    max: 4,     default: 2.4,  taper: 'linear',     modulatable: false, modScale: 0 },
  { key: 'filter.type',     min: 0,     max: 2,     default: 0,    taper: 'linear',     modulatable: false, modScale: 0, kind: 'enum', enumValues: ['lp', 'bp', 'hp'] },
```

- [ ] **Step 4: Run it to confirm green**

Run: `npm test -w @fiddle/shared -- synth2-descriptors`
Expected: PASS (all `SYNTH2_DESCRIPTORS` tests).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/engines/synth2-descriptors.ts packages/shared/src/engines/synth2-descriptors.test.ts
git commit -m "feat(shared): synth2 enum descriptor kind + env2/filter param rows (I2c-2)"
```

---

### Task 2: `Synth2EngineParams` filter/env2 + enum-aware defaults

**Files:**
- Modify: `packages/shared/src/engines/synth2.ts`
- Test: `packages/shared/src/engines/synth2.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `synth2.test.ts` (in or beside the `DEFAULT_SYNTH2_PARAMS` block):

```ts
import { DEFAULT_SYNTH2_PARAMS } from './synth2.js';

it('defaults the classic filter (type lp, cutoff 2000, res 0.15, envAmount 2.4)', () => {
  const f = DEFAULT_SYNTH2_PARAMS.filter;
  expect(f.type).toBe('lp');
  expect(typeof f.type).toBe('string'); // enum decoded to its value, not an index
  expect(f.cutoff).toBe(2000);
  expect(f.resonance).toBe(0.15);
  expect(f.keyTrack).toBe(0);
  expect(f.envAmount).toBeCloseTo(2.4, 6);
});

it('defaults env2 to the same a/d/s/r as env1', () => {
  expect(DEFAULT_SYNTH2_PARAMS.env2).toEqual({ a: 0.01, d: 0.2, s: 0.5, r: 0.5 });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -w @fiddle/shared -- synth2.test`
Expected: FAIL — `filter`/`env2` missing, or `filter.type` is `0` (number) not `'lp'`, or a TS error on the new properties.

- [ ] **Step 3: Implement**

In `synth2.ts`, import `decodeEnum`, add the filter interface + fields, and decode enums in `buildDefaults`. Change the import:

```ts
import { SYNTH2_DESCRIPTORS, decodeBool, decodeEnum } from './synth2-descriptors.js';
```

Add the filter params interface (after `Synth2FmParams`):

```ts
export interface Synth2FilterParams {
  cutoff: number;     // Hz
  resonance: number;  // 0..1
  keyTrack: number;   // 0..1 — cutoff follows note pitch
  envAmount: number;  // bipolar octaves (±4): env2 → cutoff depth
  type: 'lp' | 'bp' | 'hp';
}
```

Add `env2` and `filter` to `Synth2EngineParams` (env2 reuses `Synth2EnvParams`):

```ts
export interface Synth2EngineParams {
  osc1: Synth2OscParams;
  osc2: Synth2OscParams;
  osc3: Synth2OscParams;
  noise: Synth2NoiseParams;
  fm: Synth2FmParams;
  env1: Synth2EnvParams;
  env2: Synth2EnvParams;
  filter: Synth2FilterParams;
  // Play mode — sequencer-level, like engines.synth.mode. Not a descriptor
  // (it's not a Float32Array param); lives here so presets carry their mode.
  mode: 'mono' | 'poly';
}
```

Replace `buildDefaults` to decode enums (widen the accumulator value type):

```ts
function buildDefaults(): Synth2EngineParams {
  const out: Record<string, Record<string, number | boolean | string>> = {};
  for (const d of SYNTH2_DESCRIPTORS) {
    const [mod, field] = d.key.split('.');
    (out[mod] ??= {})[field] =
      d.kind === 'bool' ? decodeBool(d.default)
      : d.kind === 'enum' ? decodeEnum(d.default, d.enumValues!)
      : d.default;
  }
  return { ...(out as unknown as Synth2EngineParams), mode: 'mono' };
}
```

- [ ] **Step 4: Run it to confirm green**

Run: `npm test -w @fiddle/shared -- synth2.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/engines/synth2.ts packages/shared/src/engines/synth2.test.ts
git commit -m "feat(shared): synth2 filter/env2 params + enum-aware defaults (I2c-2)"
```

---

### Task 3: Enum leaf schema (`z.enum`)

**Files:**
- Modify: `packages/shared/src/project/schema.ts:85-95`
- Test: `packages/shared/src/project/schema.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `schema.test.ts` (near the synth2 schema-derivation / bool-leaf tests):

```ts
import { SYNTH2_LEAF_SCHEMAS, Schemas } from './schema.js';

describe('synth2 enum (filter.type) leaf', () => {
  it('maps filter.type to a string-enum leaf schema', () => {
    const leaf = SYNTH2_LEAF_SCHEMAS['filter.type'];
    expect(leaf.safeParse('lp').success).toBe(true);
    expect(leaf.safeParse('bp').success).toBe(true);
    expect(leaf.safeParse('hp').success).toBe(true);
    expect(leaf.safeParse('xyz').success).toBe(false);
    expect(leaf.safeParse(0).success).toBe(false);    // not a number
  });

  it('keeps filter.cutoff a clamped numeric leaf', () => {
    const leaf = SYNTH2_LEAF_SCHEMAS['filter.cutoff'];
    expect(leaf.safeParse(2000).success).toBe(true);
    expect(leaf.safeParse(99999).success).toBe(false); // > 20000
  });

  it('Synth2ParamsSchema requires a well-formed filter module', () => {
    const ok = Schemas.Synth2Params.shape.filter.safeParse({
      cutoff: 2000, resonance: 0.15, keyTrack: 0, envAmount: 2.4, type: 'lp',
    });
    expect(ok.success).toBe(true);
    const bad = Schemas.Synth2Params.shape.filter.safeParse({
      cutoff: 2000, resonance: 0.15, keyTrack: 0, envAmount: 2.4, type: 'moog',
    });
    expect(bad.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -w @fiddle/shared -- schema`
Expected: FAIL — `filter.type` currently falls through to `z.number()`, so `'lp'` fails and `0` passes.

- [ ] **Step 3: Implement**

In `schema.ts`, replace the I2c-1 enum-fallthrough caveat comment + the leaf-entry map with the enum branch:

```ts
// --- synth2: GENERATED from the descriptor table (spec §6.4) ---------------
// One leaf schema per descriptor: `z.number().min().max()` for continuous rows,
// `z.boolean()` for `kind:'bool'`, `z.enum(values)` for `kind:'enum'` — grouped
// into nested module objects ('osc1.morph' ⇒ { osc1: { morph } }).
// schema.test.ts asserts the derivation, so the table cannot drift from the wire
// validation.

const synth2LeafEntries = SYNTH2_DESCRIPTORS.map(
  d => [
    d.key,
    d.kind === 'bool' ? z.boolean()
      : d.kind === 'enum' ? z.enum(d.enumValues as unknown as [string, ...string[]])
      : z.number().min(d.min).max(d.max),
  ] as const,
);
```

(The `SYNTH2_LEAF_SCHEMAS` / `synth2Modules` / `Synth2ParamsSchema` code below is unchanged — `z.object(fields).strict()` accepts the mixed number/boolean/enum field map.)

- [ ] **Step 4: Run it to confirm green**

Run: `npm test -w @fiddle/shared -- schema`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/project/schema.ts packages/shared/src/project/schema.test.ts
git commit -m "feat(shared): synth2 enum leaves get z.enum() schema (I2c-2)"
```

---

### Task 4: Accept-list round-trip for the filter leaves

**Files:**
- Test: `packages/shared/src/project/accept-list.test.ts`
- (No production change — `accept-list.ts` patterns + `resolveLeafSchema` are descriptor-driven and resolve `SYNTH2_LEAF_SCHEMAS[key]`, now an enum/number schema.)

- [ ] **Step 1: Write the test**

Add to `accept-list.test.ts` (reuse the existing `validatePathAndValue` / `pathIsWritable` imports — do not duplicate them):

```ts
describe('synth2 filter wire validation', () => {
  it('accepts an enum string at engines.synth2.filter.type', () => {
    const path = 'tracks.0.engines.synth2.filter.type';
    expect(pathIsWritable(path)).toBe(true);
    expect(validatePathAndValue(path, 'lp').ok).toBe(true);
    expect(validatePathAndValue(path, 'hp').ok).toBe(true);
  });

  it('rejects a number / unknown string at filter.type', () => {
    const path = 'tracks.0.engines.synth2.filter.type';
    expect(validatePathAndValue(path, 1).ok).toBe(false);
    expect(validatePathAndValue(path, 'moog').ok).toBe(false);
  });

  it('round-trips numeric filter + env2 leaves', () => {
    expect(validatePathAndValue('tracks.0.engines.synth2.filter.cutoff', 2000).ok).toBe(true);
    expect(validatePathAndValue('tracks.0.engines.synth2.filter.cutoff', 99999).ok).toBe(false);
    expect(validatePathAndValue('tracks.0.engines.synth2.filter.envAmount', -4).ok).toBe(true);
    expect(validatePathAndValue('tracks.0.engines.synth2.env2.a', 0.5).ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npm test -w @fiddle/shared -- accept-list`
Expected: PASS immediately (accept-list is descriptor-driven, so the new patterns/schemas come for free). If it FAILS, the descriptor/schema wiring from Tasks 1/3 is wrong — fix there, not here.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/project/accept-list.test.ts
git commit -m "test(shared): synth2 filter accept-list round-trip (I2c-2)"
```

---

### Task 5: Healing — old synth2 slices gain `filter` + `env2`

**Files:**
- Test: `packages/client/src/project/reconcile.test.ts`
- (No production change expected — `storage.ts` `reconcileTrack` does `deepMerge(Synth2Engine.DEFAULT_PARAMS, loadedEngines.synth2)`, and `DEFAULT_SYNTH2_PARAMS` now carries `filter`/`env2`, so a loaded slice missing them heals automatically — the same mechanism that healed I2b's osc2/osc3/noise/fm and I2c-1's osc.sync.)

- [ ] **Step 1: Write the test**

Add to `reconcile.test.ts` (mirror the existing partial-project construction used by the I2c-1 sync-healing test):

```ts
it('heals a synth2 slice missing filter/env2 to defaults', () => {
  // Simulate a pre-I2c-2 snapshot: a synth2 slice with no filter or env2.
  const partial = {
    schemaVersion: 2,
    bpm: 120,
    tracks: [
      {
        engineType: 'synth2',
        engines: {
          synth2: {
            osc1: { morph: 2, pulseWidth: 0.5, coarse: 0, fine: 0, level: 0.8, sync: false },
            mode: 'mono',
          },
        },
        mixer: { volume: 0.8, muted: false, soloed: false },
        patternLength: 16,
        steps: [],
        enabled: true,
      },
    ],
  } as unknown as Parameters<typeof reconcileWithDefaults>[0];

  const healed = reconcileWithDefaults(partial);
  const s2 = healed.tracks[0].engines.synth2;
  expect(s2.filter.type).toBe('lp');
  expect(s2.filter.cutoff).toBe(2000);
  expect(s2.filter.envAmount).toBeCloseTo(2.4, 6);
  expect(s2.env2).toEqual({ a: 0.01, d: 0.2, s: 0.5, r: 0.5 });
});
```

> Match the file's existing helper for building a partial project (some tests pass a raw `unknown`, some a typed partial). The assertion (filter/env2 heal to defaults) is the point.

- [ ] **Step 2: Run it**

Run: `npm test -w @fiddle/client -- reconcile`
Expected: PASS (deepMerge fills `filter`/`env2` from the updated defaults). If it FAILS because `deepMerge` does not recurse into a missing sub-object, that's a real gap — confirm `storage.ts` reaches `deepMerge(Synth2Engine.DEFAULT_PARAMS, loadedEngines.synth2)` and that `deepMerge` is recursive. Do **not** add bespoke filter-healing code.

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/project/reconcile.test.ts
git commit -m "test(client): old synth2 slice heals filter/env2 to defaults (I2c-2)"
```

---

### Task 6: `SvfCore` — the shared ZDF state-variable filter

**Files:**
- Create: `packages/client/src/engine/synth2/kernel/SvfCore.ts`
- Test: `packages/client/src/engine/synth2/kernel/SvfCore.test.ts`

Background: a trapezoidal-integration zero-delay-feedback SVF (Andy Simper / Cytomic). One state pair yields LP/BP/HP **simultaneously**, and it stays stable under per-sample cutoff modulation (the reason the spec abandons the biquad, §5.2). `tick(input, cutoffHz, resonance)` updates state and sets `low`/`band`/`high`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { SvfCore } from './SvfCore.js';

const SR = 48000;

function sine(freq: number, n: number): Float32Array {
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) b[i] = Math.sin((2 * Math.PI * freq * i) / SR);
  return b;
}
// RMS of one SVF output over a sine input, skipping the settling transient.
function outRms(out: 'low' | 'band' | 'high', cutoff: number, res: number, freq: number): number {
  const svf = new SvfCore(SR);
  const x = sine(freq, 12000);
  let s = 0, c = 0;
  for (let i = 0; i < x.length; i++) {
    svf.tick(x[i], cutoff, res);
    if (i >= 4000) { s += svf[out] * svf[out]; c++; }
  }
  return Math.sqrt(s / c);
}

describe('SvfCore', () => {
  it('silence in → silence out', () => {
    const svf = new SvfCore(SR);
    for (let i = 0; i < 256; i++) {
      svf.tick(0, 1000, 0.2);
      expect(svf.low).toBe(0);
      expect(svf.band).toBe(0);
      expect(svf.high).toBe(0);
    }
  });

  it('lowpass passes lows and attenuates highs', () => {
    const lowPass = outRms('low', 800, 0.2, 100);
    const highRej = outRms('low', 800, 0.2, 8000);
    expect(lowPass).toBeGreaterThan(0.5);          // ~unity near DC
    expect(highRej).toBeLessThan(lowPass * 0.25);  // strongly attenuated
  });

  it('highpass passes highs and attenuates lows', () => {
    const highPass = outRms('high', 800, 0.2, 8000);
    const lowRej = outRms('high', 800, 0.2, 100);
    expect(highPass).toBeGreaterThan(0.5);
    expect(lowRej).toBeLessThan(highPass * 0.25);
  });

  it('bandpass peaks near cutoff', () => {
    const atCut = outRms('band', 1000, 0.4, 1000);
    const below = outRms('band', 1000, 0.4, 100);
    const above = outRms('band', 1000, 0.4, 10000);
    expect(atCut).toBeGreaterThan(below);
    expect(atCut).toBeGreaterThan(above);
  });

  it('stays finite and bounded sweeping cutoff at high resonance', () => {
    const svf = new SvfCore(SR);
    const n = 16384;
    for (let i = 0; i < n; i++) {
      const cutoff = 40 + (i / n) * 18000;         // 40 → 18040 Hz
      const x = Math.sin((2 * Math.PI * 300 * i) / SR);
      svf.tick(x, cutoff, 0.95);                    // hot resonance
      expect(Number.isFinite(svf.low)).toBe(true);
      expect(Math.abs(svf.low)).toBeLessThan(20);
    }
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -w @fiddle/client -- SvfCore`
Expected: FAIL — module `SvfCore.js` not found.

- [ ] **Step 3: Implement**

```ts
//
// Shared zero-delay-feedback state-variable filter core (spec §5.3, Andy
// Simper / Cytomic trapezoidal formulation). One state pair, three
// simultaneous outputs (low/band/high). Stable under per-sample cutoff
// modulation — the reason the engine abandons the biquad (§5.2). Pure DSP, no
// allocation after construction. Coefficients (g, k) are recomputed every
// sample from the caller's cutoff/resonance; the per-sample `tan` is accepted
// for v1 (coefficient caching is I4 polish).
//

export class SvfCore {
  /** Outputs, valid after the most recent tick(). */
  low = 0;
  band = 0;
  high = 0;

  private ic1eq = 0; // integrator 1 state
  private ic2eq = 0; // integrator 2 state
  private readonly nyquistish: number;

  constructor(private readonly sampleRate: number) {
    // Keep tan(pi*fc/SR) finite: clamp cutoff below Nyquist.
    this.nyquistish = sampleRate * 0.45;
  }

  /** Note-on / voice-steal: clear integrator state and outputs. */
  reset(): void {
    this.ic1eq = 0;
    this.ic2eq = 0;
    this.low = 0;
    this.band = 0;
    this.high = 0;
  }

  /** Advance one sample. cutoffHz is the final (post keytrack/env) cutoff;
   *  resonance 0..1 maps to Q 0.5..10. */
  tick(input: number, cutoffHz: number, resonance: number): void {
    const fc = cutoffHz < 20 ? 20 : cutoffHz > this.nyquistish ? this.nyquistish : cutoffHz;
    const g = Math.tan((Math.PI * fc) / this.sampleRate);
    const q = 0.5 + resonance * 9.5;             // res 0..1 → Q 0.5..10
    const k = 1 / q;
    const a1 = 1 / (1 + g * (g + k));
    const a2 = g * a1;
    const a3 = g * a2;
    const v3 = input - this.ic2eq;
    const v1 = a1 * this.ic1eq + a2 * v3;
    const v2 = this.ic2eq + a2 * this.ic1eq + a3 * v3;
    this.ic1eq = 2 * v1 - this.ic1eq;
    this.ic2eq = 2 * v2 - this.ic2eq;
    this.low = v2;
    this.band = v1;
    this.high = input - k * v1 - v2;
  }
}
```

- [ ] **Step 4: Run it to confirm green**

Run: `npm test -w @fiddle/client -- SvfCore`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/engine/synth2/kernel/SvfCore.ts packages/client/src/engine/synth2/kernel/SvfCore.test.ts
git commit -m "feat(client): synth2 SvfCore (ZDF state-variable filter) (I2c-2)"
```

---

### Task 7: `FilterModule` seam + `ClassicFilter`

**Files:**
- Create: `packages/client/src/engine/synth2/kernel/FilterModule.ts`
- Create: `packages/client/src/engine/synth2/kernel/ClassicFilter.ts`
- Test: `packages/client/src/engine/synth2/kernel/ClassicFilter.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { ClassicFilter } from './ClassicFilter.js';

const SR = 48000;

function sine(freq: number, n: number): Float32Array {
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) b[i] = Math.sin((2 * Math.PI * freq * i) / SR);
  return b;
}
// RMS of a freshly-constructed filter (type set) over a sine, skipping settling.
function rms(type: number, cutoff: number, res: number, freq: number): number {
  const f = new ClassicFilter(SR);
  f.setType(type);
  const x = sine(freq, 12000);
  let s = 0, c = 0;
  for (let i = 0; i < x.length; i++) {
    const y = f.process(x[i], cutoff, res);
    if (i >= 4000) { s += y * y; c++; }
  }
  return Math.sqrt(s / c);
}

describe('ClassicFilter', () => {
  it('type lp (0) passes lows and attenuates highs', () => {
    expect(rms(0, 800, 0.2, 100)).toBeGreaterThan(0.5);
    expect(rms(0, 800, 0.2, 8000)).toBeLessThan(0.15);
  });

  it('lp and hp differ on the same high-frequency input', () => {
    const lpHigh = rms(0, 800, 0.2, 8000);
    const hpHigh = rms(2, 800, 0.2, 8000);
    expect(hpHigh).toBeGreaterThan(lpHigh * 3); // HP keeps the 8 kHz tone; LP kills it
  });

  it('type bp (1) peaks near cutoff', () => {
    expect(rms(1, 1000, 0.4, 1000)).toBeGreaterThan(rms(1, 1000, 0.4, 100));
    expect(rms(1, 1000, 0.4, 1000)).toBeGreaterThan(rms(1, 1000, 0.4, 10000));
  });

  it('setType clamps and rounds out-of-range indices', () => {
    const f = new ClassicFilter(SR);
    f.setType(-5);  expect(f.currentType).toBe(0);
    f.setType(9);   expect(f.currentType).toBe(2);
    f.setType(1.6); expect(f.currentType).toBe(2);
  });

  it('reset clears state (post-reset tick equals a fresh filter)', () => {
    const a = new ClassicFilter(SR);
    const b = new ClassicFilter(SR);
    for (let i = 0; i < 500; i++) a.process(Math.random() * 2 - 1, 1200, 0.5);
    a.reset();
    expect(a.process(0.7, 1200, 0.5)).toBeCloseTo(b.process(0.7, 1200, 0.5), 12);
  });
});
```

> `currentType` is a read-only getter on the production class (defined in Step 3) so the `setType`-clamp behaviour is testable without exposing internal state.

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -w @fiddle/client -- ClassicFilter`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the interface**

`FilterModule.ts`:

```ts
//
// The swappable filter seam (spec §6.3). ClassicFilter (I2c-2) is the only
// implementation today; MorphFilter arrives in I3 behind this same interface,
// selected per voice by a future `filter.model` enum. The Voice owns the
// cutoff/resonance ParamSlots and passes their per-sample values in, so a
// filter never reaches for global state — it just transforms one sample.
//
export interface FilterModule {
  /** Note-on / voice-steal: clear internal state. */
  reset(): void;
  /** Select the output flavour (ClassicFilter: 0 = lp, 1 = bp, 2 = hp). */
  setType(type: number): void;
  /** One sample. cutoffHz is the final cutoff (keytrack + env already applied);
   *  resonance is 0..1. Returns the selected output. */
  process(input: number, cutoffHz: number, resonance: number): number;
}
```

`ClassicFilter.ts`:

```ts
//
// Classic discrete LP/BP/HP filter (spec §5.3) — a thin selector over one
// SvfCore (which computes all three outputs each sample). `type` is set at the
// block boundary from the `filter.type` enum (lp=0, bp=1, hp=2).
//
import type { FilterModule } from './FilterModule';
import { SvfCore } from './SvfCore';

export class ClassicFilter implements FilterModule {
  private type = 0; // 0 lp, 1 bp, 2 hp
  private readonly svf: SvfCore;

  constructor(sampleRate: number) {
    this.svf = new SvfCore(sampleRate);
  }

  /** Read-only view of the selected type (for tests/diagnostics). */
  get currentType(): number {
    return this.type;
  }

  reset(): void {
    this.svf.reset();
  }

  setType(type: number): void {
    const t = Math.round(type);
    this.type = t < 0 ? 0 : t > 2 ? 2 : t;
  }

  process(input: number, cutoffHz: number, resonance: number): number {
    this.svf.tick(input, cutoffHz, resonance);
    return this.type === 0 ? this.svf.low : this.type === 1 ? this.svf.band : this.svf.high;
  }
}
```

> Production surface = `reset`, `setType`, `process`, and the read-only `get currentType`. Nothing else.

- [ ] **Step 4: Run it to confirm green**

Run: `npm test -w @fiddle/client -- ClassicFilter`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/engine/synth2/kernel/FilterModule.ts packages/client/src/engine/synth2/kernel/ClassicFilter.ts packages/client/src/engine/synth2/kernel/ClassicFilter.test.ts
git commit -m "feat(client): synth2 FilterModule seam + ClassicFilter (I2c-2)"
```

---

### Task 8: Voice filter/env2/keytrack wiring + kernel filter.type propagation

**Files:**
- Modify: `packages/client/src/engine/synth2/kernel/Voice.ts`
- Modify: `packages/client/src/engine/synth2/kernel/Synth2Kernel.ts`
- Test: `packages/client/src/engine/synth2/kernel/Synth2Kernel.test.ts`

- [ ] **Step 1: Write the failing integration tests**

Add a `describe('Synth2Kernel classic filter', …)` to `Synth2Kernel.test.ts` (reuse the file's existing `SR`, `BLOCK`, `renderBlocks`, `defaultParamBlock`, `PARAM_INDEX` helpers — mirror the I2c-1 hard-sync test's `renderOsc2Only` shape):

```ts
describe('Synth2Kernel classic filter', () => {
  // Isolate osc1 (saw) → filter; silence osc2/osc3/noise; play a 220 Hz note.
  function render(opts: {
    cutoff?: number; type?: number; envAmount?: number; keyTrack?: number; freq?: number;
  }): Float32Array {
    const k = new Synth2Kernel(SR);
    const block = defaultParamBlock();
    block[PARAM_INDEX['osc2.level']] = 0;
    block[PARAM_INDEX['osc3.level']] = 0;
    block[PARAM_INDEX['noise.level']] = 0;
    block[PARAM_INDEX['osc1.level']] = 1;
    block[PARAM_INDEX['osc1.morph']] = 2;                  // saw — rich harmonics
    block[PARAM_INDEX['filter.cutoff']] = opts.cutoff ?? 2000;
    block[PARAM_INDEX['filter.type']] = opts.type ?? 0;    // lp
    block[PARAM_INDEX['filter.envAmount']] = opts.envAmount ?? 0;
    block[PARAM_INDEX['filter.keyTrack']] = opts.keyTrack ?? 0;
    k.applyParams(block);
    k.noteOn(0, opts.freq ?? 220, 2, 1, true);             // mono
    return renderBlocks(k, 0, Math.ceil(SR / BLOCK));      // ~1s
  }
  function rms(buf: Float32Array): number {
    let s = 0;
    for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    return Math.sqrt(s / buf.length);
  }
  function diff(a: Float32Array, b: Float32Array): number {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
    return s / a.length;
  }

  it('a low cutoff attenuates more energy than a high cutoff', () => {
    const closed = rms(render({ cutoff: 150 }));   // LP at 150 Hz kills a 220 Hz saw's harmonics
    const open = rms(render({ cutoff: 18000 }));   // nearly unfiltered
    expect(closed).toBeLessThan(open * 0.6);
    expect(closed).toBeGreaterThan(0);
  });

  it('lp and hp produce different output at the same cutoff', () => {
    const lp = render({ cutoff: 1000, type: 0 });
    const hp = render({ cutoff: 1000, type: 2 });
    expect(diff(lp, hp)).toBeGreaterThan(1e-3);
  });

  it('keytrack raises the effective cutoff with pitch', () => {
    // High note, LP at a low base cutoff. With keytrack the cutoff tracks the
    // note up, so MORE of the (now higher) tone's energy passes than with no
    // tracking. Compare the same high note with keytrack 1 vs 0.
    const tracked = rms(render({ cutoff: 400, type: 0, keyTrack: 1, freq: 880 }));
    const untracked = rms(render({ cutoff: 400, type: 0, keyTrack: 0, freq: 880 }));
    expect(tracked).toBeGreaterThan(untracked * 1.2);
  });

  it('envAmount changes the sound (env2 → cutoff)', () => {
    const flat = render({ cutoff: 300, type: 0, envAmount: 0 });
    const swept = render({ cutoff: 300, type: 0, envAmount: 4 });
    expect(diff(flat, swept)).toBeGreaterThan(1e-3);
  });

  it('renders finite, bounded audio with the filter engaged', () => {
    const out = render({ cutoff: 1200, type: 0, envAmount: 2.4 });
    let peak = 0;
    for (let i = 0; i < out.length; i++) {
      expect(Number.isFinite(out[i])).toBe(true);
      peak = Math.max(peak, Math.abs(out[i]));
    }
    expect(peak).toBeLessThan(4);
    expect(peak).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -w @fiddle/client -- Synth2Kernel`
Expected: FAIL — no filter in the voice yet; cutoff/type/keytrack/envAmount have no effect.

- [ ] **Step 3: Implement the Voice filter chain**

In `Voice.ts`, add imports, fields, the keytrack reference, env2, the filter, the new slots, a `setFilterType`, note-on wiring, and the per-sample cutoff routing. Update the header comment's signal-flow line to `… → 4-channel mixer → ClassicFilter(env2) → VCA(env1) → out`.

Imports (add `ClassicFilter`):

```ts
import { ParamSlot } from './ParamSlot';
import { MorphOscillator } from './MorphOscillator';
import { LoopEnvelope } from './LoopEnvelope';
import { Noise } from './Noise';
import { ClassicFilter } from './ClassicFilter';
import { PARAM_INDEX } from './params';
import { SYNTH2_DESCRIPTORS } from '@fiddle/shared';
```

Add the keytrack reference constant above the class:

```ts
// Keytrack reference pitch: keyTrack 1 makes cutoff track the note 1:1 about C4.
const KEYTRACK_REF_HZ = 261.6256;
```

Add fields (after `private osc3Sync = false;`):

```ts
  private readonly env2: LoopEnvelope;
  private readonly filter: ClassicFilter;
  private readonly cutoffSlot: ParamSlot;
  private readonly resSlot: ParamSlot;
  private readonly keyTrackSlot: ParamSlot;
  private readonly envAmountSlot: ParamSlot;
  private keyTrackOctaves = 0; // log2(freq / C4), cached per note
```

In the constructor (after `this.env1 = new LoopEnvelope(...)`):

```ts
    this.env2 = new LoopEnvelope(
      slot('env2.a'), slot('env2.d'), slot('env2.s'), slot('env2.r'), sampleRate,
    );
    this.filter = new ClassicFilter(sampleRate);
    this.cutoffSlot = slot('filter.cutoff');
    this.resSlot = slot('filter.resonance');
    this.keyTrackSlot = slot('filter.keyTrack');
    this.envAmountSlot = slot('filter.envAmount');
```

Add a `setFilterType` (next to `setSync`):

```ts
  /** Block-boundary discrete update: select LP(0)/BP(1)/HP(2). */
  setFilterType(type: number): void {
    this.filter.setType(type);
  }
```

Update `noteOn` — cache keytrack octaves, reset the filter on a fresh start, and trigger env2:

```ts
  noteOn(freq: number, velocity: number, gateFrames: number): void {
    this.freq = freq;
    this.velocity = velocity < 0 ? 0 : velocity > 1 ? 1 : velocity;
    this.keyTrackOctaves = Math.log2(freq / KEYTRACK_REF_HZ);
    if (!this.env1.active) {
      this.osc1.reset(); this.osc2.reset(); this.osc3.reset();
      this.filter.reset(); // steals keep filter state (D3 ramp covers the level); fresh notes start clean
    }
    this.env1.noteOn(gateFrames);
    this.env2.noteOn(gateFrames);
  }
```

Replace `renderAdd`'s body so the mix is filtered before the VCA (env2 advanced once per sample alongside env1; the 4 filter slots advanced once per sample):

```ts
  renderAdd(out: Float32Array, from: number, to: number): void {
    for (let n = from; n < to; n++) {
      const e = this.env1.next();
      const env2v = this.env2.next();
      const o1 = this.osc1.next(this.freq);
      const o2 = this.osc2.next(
        this.freq, o1, this.fmOsc2.next(),
        this.osc2Sync && this.osc1.wrapped ? this.osc1.wrapFrac : -1,
      );
      const o3 = this.osc3.next(
        this.freq, o2, this.fmOsc3.next(),
        this.osc3Sync && this.osc2.wrapped ? this.osc2.wrapFrac : -1,
      );
      const nz = this.noise.next(this.noiseColor.next());
      const mix =
        o1 * this.osc1Level.next() +
        o2 * this.osc2Level.next() +
        o3 * this.osc3Level.next() +
        nz * this.noiseLevel.next();
      // Hardwired cutoff routing (spec §5.3), all in octaves about the base
      // cutoff: keytrack follows the note pitch; env2 (0..1) scaled by the
      // bipolar envAmount (±4 oct). Each ParamSlot.next() called exactly once.
      const octShift =
        this.keyTrackSlot.next() * this.keyTrackOctaves + this.envAmountSlot.next() * env2v;
      let fc = this.cutoffSlot.next() * Math.pow(2, octShift);
      if (fc < 20) fc = 20; else if (fc > 20000) fc = 20000;
      const filtered = this.filter.process(mix, fc, this.resSlot.next());
      out[n] += filtered * e * this.velocity;
    }
  }
```

- [ ] **Step 4: Propagate `filter.type` from the block in the kernel**

In `Synth2Kernel.ts`, fold the filter-type read into the existing discrete-broadcast section of `applyParams` (it already imports `PARAM_INDEX`):

```ts
    // Discrete (bool/enum) params: applied at the block boundary, no smoother.
    // osc1.sync exists in the descriptor table for a uniform osc shape but is
    // intentionally not read here — osc1 is the master and is never reset.
    const osc2Sync = this.block[PARAM_INDEX['osc2.sync']] >= 0.5;
    const osc3Sync = this.block[PARAM_INDEX['osc3.sync']] >= 0.5;
    const filterType = Math.round(this.block[PARAM_INDEX['filter.type']]);
    for (const voice of this.voices) {
      voice.setSync(osc2Sync, osc3Sync);
      voice.setFilterType(filterType);
    }
```

- [ ] **Step 5: Run it to confirm green**

Run: `npm test -w @fiddle/client -- Synth2Kernel`
Expected: PASS. Re-run the kernel suite for no regression: `npm test -w @fiddle/client -- MorphOscillator Voice Synth2Kernel SvfCore ClassicFilter`.

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/engine/synth2/kernel/Voice.ts packages/client/src/engine/synth2/kernel/Synth2Kernel.ts packages/client/src/engine/synth2/kernel/Synth2Kernel.test.ts
git commit -m "feat(client): synth2 Voice filter+env2+keytrack chain + kernel filter.type propagation (I2c-2)"
```

---

### Task 9: Engine encodes enum (string) params into the block

**Files:**
- Modify: `packages/client/src/engine/Synth2Engine.ts:40-66`
- Test: `packages/client/src/engine/Synth2Engine.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `Synth2Engine.test.ts` (mirror the existing harness — `mockCtx()`/`MockPort`/`(engine as any).node.port`/the `PARAM_INDEX` import used by the I2c-1 bool tests):

```ts
describe('Synth2Engine enum (filter.type) params', () => {
  it('encodes filter.type by index (hp → 2, lp → 0)', () => {
    const ctx = mockCtx();
    const engine = new Synth2Engine(ctx);
    const port = (engine as any).node.port as MockPort;
    port.posted.length = 0;

    engine.applyParams({ filter: { type: 'hp' } });
    let msg = port.posted.find(m => m.type === 'params');
    expect(msg.block[PARAM_INDEX['filter.type']]).toBe(2);

    port.posted.length = 0;
    engine.applyParams({ filter: { type: 'lp' } });
    msg = port.posted.find(m => m.type === 'params');
    expect(msg.block[PARAM_INDEX['filter.type']]).toBe(0);
  });

  it('does not repost when the enum value is unchanged', () => {
    const ctx = mockCtx();
    const engine = new Synth2Engine(ctx);
    const port = (engine as any).node.port as MockPort;
    engine.applyParams({ filter: { type: 'bp' } });
    port.posted.length = 0;
    engine.applyParams({ filter: { type: 'bp' } });
    expect(port.posted.some(m => m.type === 'params')).toBe(false);
  });

  it('still ignores the top-level mode string (rides the trigger, not the block)', () => {
    const ctx = mockCtx();
    const engine = new Synth2Engine(ctx);
    const port = (engine as any).node.port as MockPort;
    port.posted.length = 0;
    engine.applyParams({ mode: 'poly' } as any);
    expect(port.posted.some(m => m.type === 'params')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -w @fiddle/client -- Synth2Engine`
Expected: FAIL — `applyParams` `continue`s on strings, so `filter.type` never reaches the block.

- [ ] **Step 3: Implement**

In `Synth2Engine.ts`, import `SYNTH2_ENUM_VALUES` and `encodeEnum`, and add the enum branch in `applyParams`:

```ts
import { DEFAULT_SYNTH2_PARAMS, encodeBool, encodeEnum, SYNTH2_ENUM_VALUES, type Synth2EngineParams } from '@fiddle/shared';
```

Replace the value-coercion block inside the inner loop:

```ts
        // Continuous params arrive as numbers; discrete bools as true/false
        // (encoded 0/1); enum leaves as their string value (encoded to the
        // descriptor's index). Top-level strings (mode) never reach this nested
        // loop, so an unrecognised string here is skipped defensively.
        let f32: number;
        if (typeof value === 'number') {
          f32 = Math.fround(value);
        } else if (typeof value === 'boolean') {
          f32 = encodeBool(value);
        } else if (typeof value === 'string') {
          const values = SYNTH2_ENUM_VALUES[`${mod}.${field}`];
          if (!values) continue;
          f32 = encodeEnum(value, values);
        } else {
          continue;
        }
        if (this.block[idx] === f32) continue;
        this.block[idx] = f32;
        changed = true;
```

- [ ] **Step 4: Run it to confirm green**

Run: `npm test -w @fiddle/client -- Synth2Engine`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/engine/Synth2Engine.ts packages/client/src/engine/Synth2Engine.test.ts
git commit -m "feat(client): Synth2Engine encodes enum params into the block (I2c-2)"
```

---

### Task 10: Panel filter + env2 section; `useSynth` discrete filter-type flush

**Files:**
- Modify: `packages/client/src/components/Synth2Panel.vue`
- Modify: `packages/client/src/composables/useSynth.ts:204-207`
- Test: `packages/client/src/components/Synth2Panel.test.ts`
- Test: `packages/client/src/composables/useSynth.test.ts`

- [ ] **Step 1: Write the failing tests**

`Synth2Panel.test.ts` — add (mirror the file's existing `mountPanel(params)` helper used by the sync-toggle tests):

```ts
describe('Synth2Panel filter section', () => {
  it('renders the LP/BP/HP type selector and a cutoff knob', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    const typeBtns = el.querySelectorAll<HTMLButtonElement>('.filter-type-btn');
    expect(typeBtns.length).toBe(3);
    expect([...typeBtns].map(b => b.textContent?.trim())).toEqual(['LP', 'BP', 'HP']);
  });

  it('clicking HP sets params.filter.type', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    const typeBtns = el.querySelectorAll<HTMLButtonElement>('.filter-type-btn');
    expect(params.filter.type).toBe('lp');
    typeBtns[2].click();
    expect(params.filter.type).toBe('hp');
    typeBtns[1].click();
    expect(params.filter.type).toBe('bp');
  });
});
```

`useSynth.test.ts` — add, mirroring the I2c-1 `'emits a synth2 osc.sync toggle immediately (discrete leaf)'` test (same `bootWithFakeSocket` harness / `fake.sent` spy, different path/value):

```ts
it('emits a synth2 filter.type change immediately (discrete enum leaf)', async () => {
  const { fake, synth } = await bootWithFakeSocket();
  synth.project.tracks[0].engines.synth2.filter.type = 'hp';
  // No timer advance: 'type' is in DISCRETE_LEAF_FIELDS → flushes immediately.
  const op = fake.sent.find(
    (o) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'engines', 'synth2', 'filter', 'type']),
  );
  expect(op).toBeDefined();
  expect(op.value).toBe('hp');
});
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `npm test -w @fiddle/client -- Synth2Panel useSynth`
Expected: FAIL — no `.filter-type-btn`; `filter.type` rides the 50 ms throttle (not flushed immediately).

- [ ] **Step 3: Implement the panel filter + env2 section**

In `Synth2Panel.vue`, add two columns before the Visualizer column (Column 5 becomes Column 7). After the Noise+FM column (`</div>` closing Column 4's `.rack-column`), insert:

```html
    <!-- Column 5: Filter -->
    <div class="rack-column">
      <div class="module-group synth2-panel">
        <h3>FILTER</h3>
        <div class="filter-type-selector">
          <button type="button" class="filter-type-btn" :class="{ active: params.filter.type === 'lp' }" @click="params.filter.type = 'lp'">LP</button>
          <button type="button" class="filter-type-btn" :class="{ active: params.filter.type === 'bp' }" @click="params.filter.type = 'bp'">BP</button>
          <button type="button" class="filter-type-btn" :class="{ active: params.filter.type === 'hp' }" @click="params.filter.type = 'hp'">HP</button>
        </div>
        <div class="knob-row">
          <Knob label="Cutoff" :min="20" :max="20000" :step="1" format="hz" :defaultValue="DEFAULTS.filter.cutoff" v-model="params.filter.cutoff" :syncPath="ks.pathFor(['filter', 'cutoff'])" @gesture-end="ks.end(['filter', 'cutoff'])" />
          <Knob label="Res" :min="0" :max="1" :step="0.01" format="percent" :defaultValue="DEFAULTS.filter.resonance" v-model="params.filter.resonance" :syncPath="ks.pathFor(['filter', 'resonance'])" @gesture-end="ks.end(['filter', 'resonance'])" />
          <Knob label="KeyTrk" :min="0" :max="1" :step="0.01" format="percent" :defaultValue="DEFAULTS.filter.keyTrack" v-model="params.filter.keyTrack" :syncPath="ks.pathFor(['filter', 'keyTrack'])" @gesture-end="ks.end(['filter', 'keyTrack'])" />
          <Knob label="EnvAmt" :min="-4" :max="4" :step="0.1" :defaultValue="DEFAULTS.filter.envAmount" v-model="params.filter.envAmount" :syncPath="ks.pathFor(['filter', 'envAmount'])" @gesture-end="ks.end(['filter', 'envAmount'])" />
        </div>
      </div>
    </div>

    <!-- Column 6: Filter envelope (env2) -->
    <div class="rack-column">
      <div class="module-group">
        <h3>FILTER ENV</h3>
        <div class="knob-row">
          <Knob label="A" :min="0.001" :max="10" :step="0.001" format="ms" :defaultValue="DEFAULTS.env2.a" v-model="params.env2.a" :syncPath="ks.pathFor(['env2', 'a'])" @gesture-end="ks.end(['env2', 'a'])" />
          <Knob label="D" :min="0.001" :max="10" :step="0.001" format="ms" :defaultValue="DEFAULTS.env2.d" v-model="params.env2.d" :syncPath="ks.pathFor(['env2', 'd'])" @gesture-end="ks.end(['env2', 'd'])" />
          <Knob label="S" :min="0" :max="1" :step="0.01" format="percent" :defaultValue="DEFAULTS.env2.s" v-model="params.env2.s" :syncPath="ks.pathFor(['env2', 's'])" @gesture-end="ks.end(['env2', 's'])" />
          <Knob label="R" :min="0.001" :max="10" :step="0.001" format="ms" :defaultValue="DEFAULTS.env2.r" v-model="params.env2.r" :syncPath="ks.pathFor(['env2', 'r'])" @gesture-end="ks.end(['env2', 'r'])" />
        </div>
      </div>
    </div>
```

> Update the `<!-- Column 5: Visualizer -->` comment to `Column 7`. If `Knob` rejects an unknown `format="hz"`, drop the `format` attr on Cutoff (a plain numeric readout is fine) — check `Knob.vue`'s `format` prop union first and only use a value it supports.

Add the type-selector styles to `<style scoped>` (reuse the mode-selector look):

```css
.filter-type-selector {
  display: flex;
  gap: 6px;
  width: 100%;
  margin-bottom: 8px;
}
.filter-type-btn {
  flex: 1;
  background: #181818;
  color: #666;
  border: 1px solid #2a2a2a;
  border-radius: 4px;
  padding: 5px 0;
  font-family: monospace;
  font-size: 0.7rem;
  font-weight: bold;
  letter-spacing: 0.05em;
  cursor: pointer;
  transition: all 0.2s ease;
}
.filter-type-btn:hover { color: #aaa; border-color: #444; }
.filter-type-btn.active { background: #222; color: #fff; border-color: #555; }
```

- [ ] **Step 4: Flush `filter.type` immediately in `useSynth`**

In `useSynth.ts`, add `'type'` to `DISCRETE_LEAF_FIELDS` (it's collision-free — no other engine/step leaf is named `type`; `engineType`/`chordType` are distinct keys):

```ts
const DISCRETE_LEAF_FIELDS = new Set<string>([
  'engineType', 'muted', 'soloed', 'note', 'octave', 'isChord', 'chordType', 'patternLength', 'enabled',
  'sync', // synth2 osc hard-sync toggle: an instantaneous discrete flip, like muted/soloed
  'type', // synth2 filter.type enum: a discrete selector flip — flush immediately
]);
```

> The continuous filter knobs (`cutoff`/`resonance`/`keyTrack`/`envAmount`) and `env2.*` need NO `useSynth` change — they flow through the existing `engines.synth2` slice watcher + `emitLeafDiff` (which drills the `filter`/`env2` module objects to their leaves) exactly like I2b's osc2/osc3/noise/fm. Only the discrete enum needs the immediate-flush hint.

- [ ] **Step 5: Run them to confirm green**

Run: `npm test -w @fiddle/client -- Synth2Panel useSynth`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/components/Synth2Panel.vue packages/client/src/composables/useSynth.ts packages/client/src/components/Synth2Panel.test.ts packages/client/src/composables/useSynth.test.ts
git commit -m "feat(client): Synth2Panel filter+env2 section + immediate filter.type flush (I2c-2)"
```

---

### Task 11: Full gate + browser verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full merge gate**

```bash
npm run typecheck && npm test && npm run build
```

Expected: typecheck clean (all 3 workspaces); every test green; the build emits `packages/client/public/worklets/synth2-processor.js`. Confirm the artifact:

```bash
ls -la packages/client/public/worklets/synth2-processor.js
```

- [ ] **Step 2: Zero-allocation spot-check (manual read)**

Open `Voice.ts` `renderAdd` and confirm the new filter path added only scalar arithmetic + the two `LoopEnvelope.next()` / `ClassicFilter.process()` calls — no `new`, no array growth, no closures inside the per-sample loop. `SvfCore.tick` and `ClassicFilter.process` allocate nothing. (Per-sample `tan`/`pow` cost is acknowledged and deferred to I4; this step is only a no-allocation eyeball.)

- [ ] **Step 3: Browser verification (Playwright MCP, then CLOSE the browser)**

1. `npm run dev` (client + server).
2. Open the app, create/open a session, add a **synth2** track. Enter a step with a note; Play — confirm the default patch sounds and has an audible **filter-envelope sweep** (default cutoff 2000, envAmount +2.4, env2 decay) — a bright attack settling darker.
3. In the FILTER panel: sweep **Cutoff** — confirm the timbre opens/closes. Raise **Res** — confirm a resonant peak/whistle near cutoff.
4. Switch **LP → BP → HP** — confirm the character changes (LP dark, HP thin/bright, BP nasal).
5. Raise **KeyTrk** to ~100% and play a low note vs a high note — confirm the high note is proportionally brighter (cutoff follows pitch).
6. Set **EnvAmt** to 0 — the sweep disappears (static filter). Set it to +4 with a short **FILTER ENV** decay — confirm a pronounced pluck-like sweep; try a negative EnvAmt for a reverse sweep.
7. (Optional, second client) Reuse the sync harness: switch the filter **type** (LP/HP) in client A; confirm client B's panel reflects it and the audio matches — verifies the enum discrete round-trip.
8. **Close the Playwright browser/session** (AGENTS.md cleanup rule).

- [ ] **Step 4: Stop the dev server and report**

Stop `npm run dev`. Report the gate result + browser observations. **Do not merge** — the user browser-verifies and merges. Keep the branch.

---

## Self-review (against spec §5.1/§5.3/§5.4/§6.3/§6.4/§6.6)

- **§5.1 signal flow (osc → mixer → filter → VCA)** → Task 8: `renderAdd` filters `mix` before `* e (env1)`. ✔
- **§5.3 ClassicFilter LP/BP/HP on one SVF core** → Task 6 (`SvfCore` 3 outputs), Task 7 (`ClassicFilter` selects by type). ✔
- **§5.3 shared cutoff/resonance/keyTrack** → Task 1 (descriptors), Task 8 (per-sample routing). ✔
- **§5.3 hardwired env2 → cutoff, bipolar octaves ±4 (`filterEnvAmount`)** → Task 1 (`filter.envAmount` ±4), Task 8 (`octShift += envAmount·env2`). ✔
- **§5.4 env2 is a plain ADSR (loop is I3)** → Task 8 reuses `LoopEnvelope` (loop not yet implemented). ✔
- **§6.6 enums "encoded as floats", "switch at block boundaries"** → Task 1 (`kind:'enum'` index encoding), Task 9 (engine encodes index), Task 8 (kernel reads `Math.round`, no smoother). ✔
- **§6.3 modulation coverage rule (discrete not a dest; envAmount = hardwired depth, not a dest)** → Task 1: `filter.type` `modulatable:false`; `filter.envAmount` continuous but `modulatable:false`; tests pin both. ✔
- **§6.4 append-only descriptor ABI** → Task 1 appends 9 rows at array end; exact-key guard pins order. ✔
- **Healing for old snapshots** → Task 5 (deepMerge of updated defaults). ✔
- **Stability under audio-rate cutoff mod (the reason for the SVF)** → Task 6 sweep test (finite, bounded at res 0.95). ✔
- **Type consistency** → `Synth2Kind`/`enumValues`/`encodeEnum`/`decodeEnum`/`SYNTH2_ENUM_VALUES` (Task 1) reused in Tasks 2/3/9; `Synth2FilterParams` (Task 2) used by panel (Task 10); `FilterModule`/`ClassicFilter`/`SvfCore` (Tasks 6/7) used by Voice (Task 8); `setFilterType` defined Task 8 Voice, called Task 8 kernel. ✔

## Out of scope (restated — do not build in this slice)

- `filter.model` enum, `MorphFilter`, `filter.morph` → **I3** (the seam exists; the runtime swap + second model do not).
- Mod matrix, LFOs, env3, `env.loop` → **I3**.
- Per-block denormal flush + `tan`/`pow` coefficient caching → **I4 polish**.
- `sessions.ts` `as unknown as Project` double-cast — orthogonal latent debt; leave it.
