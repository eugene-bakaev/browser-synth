# synth2 I2c-1 — Discrete-Param Channel + Hard Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the synth2 engine's first *discrete* kernel parameters (the `osc.sync` booleans) end-to-end — descriptor table → schema/accept-list → engine encode → kernel raw-read — and wire oscillator **hard sync** (osc1→osc2→osc3 phase-reset chain) so a synth2 patch can produce the classic sync sweep.

**Architecture:** The descriptor table (`@fiddle/shared`) gains an optional `kind` discriminant; a `kind: 'bool'` descriptor still occupies a Float32Array param-block index (encoded 0/1) but is **excluded from the mod matrix and applied at block boundaries with no smoother** — discrete params ride the *same* param message as continuous ones (spec §6.6: "enums and booleans encoded as floats"). Hard sync is a `Voice.ts`-only wiring change: each `MorphOscillator` exposes whether it wrapped this sample (`wrapped`/`wrapFrac`) and accepts a sub-sample-accurate `syncReset`; the voice resets osc2 on osc1 wraps and osc3 on osc2 wraps. No protocol/message-shape change (the block grows 3 floats automatically because `PARAM_COUNT` derives from the table).

**Tech Stack:** TypeScript, npm workspaces (`@fiddle/shared`, `@fiddle/client`), Vitest, Zod, Vue 3 (panel), Web Audio AudioWorklet (kernel is pure TS, tested in Node).

---

## Context for the implementer (read once)

This is slice **I2c-1** of the synth2 engine. The approved design spec is
`docs/superpowers/specs/2026-06-12-worklet-synth-engine-design.md` — the
load-bearing sections are §5.1 (voice signal flow / sync chain), §5.2 (`sync`
boolean, "ignored on osc1"), §6.3 (ParamSlot + "modulation coverage rule":
discrete/structural params are NOT mod destinations), §6.4 (descriptor table is
the single source of truth, **append-only**), §6.6 (param protocol: discrete
params "switch at block boundaries"), and §6.8 (hard-sync DSP note). You do
**not** need to read the whole spec to execute this plan — the relevant rules
are inlined below.

**Three invariants you must not break:**

1. **The descriptor table is append-only.** `SYNTH2_DESCRIPTORS` array position
   *is* the Float32Array param-block index. Never insert or reorder — only
   append. The three new rows (`osc1.sync`, `osc2.sync`, `osc3.sync`) go at the
   **end** of the array, after `fm.osc3`. (They land at block indices 23/24/25;
   their semantic grouping under `osc1`/`osc2`/`osc3` is by `key`, not array
   position — `PARAM_INDEX` and `buildDefaults` group by the dotted key.)

2. **Kernel files import only from `kernel/` and `@fiddle/shared`.** No Web
   Audio / DOM / `postMessage` types under
   `packages/client/src/engine/synth2/kernel/`. Zero allocation in the
   `process`/`renderAdd` hot path (no `new`, no array-growth, no closures).

3. **Discrete params are NOT smoothed and NOT mod-matrix destinations.** A
   `kind: 'bool'` descriptor has `modulatable: false`, `modScale: 0`. The kernel
   reads it raw at the block boundary (`block[idx] >= 0.5`), never through a
   `ParamSlot.next()` smoother.

**Why osc1.sync exists even though it does nothing:** spec §7.2 specifies a
*uniform* oscillator param shape `{morph, pulseWidth, coarse, fine, level,
sync}` for all three oscillators. osc1 is the sync **master**, so its `sync`
field is inert (the kernel never reads it). Keeping the shape uniform means
`Synth2OscParams` stays a single type and the descriptor-derivation machinery
(`buildDefaults`, schema grouping, accept-list) stays uniform. The panel renders
the SYNC toggle only on osc2/osc3 (Task 9), where it has an effect.

**Accepted simplification (spec-sanctioned).** Spec §6.8 calls for a PolyBLEP
correction at the sync-reset discontinuity but explicitly accepts "good enough
over perfect — minor residual aliasing at extreme settings is accepted in v1."
This slice implements the **hard phase reset** (the audible sync effect); each
oscillator shape's *own* edges remain PolyBLEP/BLAMP-corrected as today, but the
sync-reset edge itself is left un-BLEPed. A dedicated sync-edge BLEP is deferred
to I4 polish. This is a deliberate, documented scope cut, not an oversight.

**Out of scope for I2c-1 (do not build):**
- The filter (`SvfCore`/`ClassicFilter`), env2, keytrack, `filterEnvAmount` →
  **I2c-2** (next slice).
- `kind: 'enum'` descriptors (`filter.model`, `filter.type`) → introduced in
  **I2c-2**; this slice adds only `kind: 'bool'`. The `Synth2Kind` union is
  authored as `'continuous' | 'bool'` and widened in I2c-2.
- The mod matrix, LFOs, env3 → I3.
- The `env.loop` boolean → I3 (this slice does not touch envelopes at all).
- `sessions.ts` `as unknown as Project` double-cast — orthogonal latent debt;
  adding bool descriptors does not fix or worsen it. Leave it.

**Branch:** `feat/synth2-i2c1-hardsync` (already created off `main`). Do not
merge — the user browser-verifies before merge.

---

## File Structure (what changes and why)

**`@fiddle/shared`:**
- `packages/shared/src/engines/synth2-descriptors.ts` — add `Synth2Kind`, the
  optional `kind` field, `isDiscrete`/`encodeBool`/`decodeBool` helpers, and the
  3 appended `*.sync` bool rows. *Single source of truth.*
- `packages/shared/src/engines/synth2-descriptors.test.ts` — update exact-key
  guard (23 → 26 keys) + assert the new descriptors are `kind: 'bool'`,
  `modulatable: false`.
- `packages/shared/src/engines/synth2.ts` — add `sync: boolean` to
  `Synth2OscParams`; make `buildDefaults` decode bool descriptors to `boolean`.
- `packages/shared/src/engines/synth2.test.ts` — assert default `osc*.sync` is
  `false`.
- `packages/shared/src/project/schema.ts` — map bool descriptors to
  `z.boolean()` leaves; widen `SYNTH2_LEAF_SCHEMAS` value type to `z.ZodTypeAny`.
- `packages/shared/src/project/schema.test.ts` — assert sync leaves are boolean
  schemas (accept `true`/`false`, reject numbers).
- `packages/shared/src/project/accept-list.test.ts` — assert
  `engines.synth2.osc2.sync` round-trips a boolean and rejects a non-boolean.
  (No accept-list *code* change — patterns + `resolveLeafSchema` are already
  descriptor-driven.)

**`@fiddle/client`:**
- `packages/client/src/engine/Synth2Engine.ts` — `applyParams` encodes
  `boolean` values into the block (`true`→1, `false`→0).
- `packages/client/src/engine/Synth2Engine.test.ts` — assert a sync toggle
  writes 1/0 to the block index and posts.
- `packages/client/src/engine/synth2/kernel/MorphOscillator.ts` — `wrapped` /
  `wrapFrac` public fields + `syncReset` parameter + hard phase reset.
- `packages/client/src/engine/synth2/kernel/MorphOscillator.test.ts` — sync-off
  bit-identical; finite/bounded under sync; slave period locks to master.
- `packages/client/src/engine/synth2/kernel/Voice.ts` — `setSync(...)` + sync
  chain wiring in `renderAdd`.
- `packages/client/src/engine/synth2/kernel/Synth2Kernel.ts` — propagate sync
  booleans from the block to every voice in `applyParams`.
- `packages/client/src/engine/synth2/kernel/Synth2Kernel.test.ts` — integration:
  `osc2.sync` locks the slave period; sync-on differs from sync-off.
- `packages/client/src/components/Synth2Panel.vue` — SYNC toggle on osc2/osc3.
- `packages/client/src/components/Synth2Panel.test.ts` — toggle flips
  `params.osc2.sync`.
- `packages/client/src/project/reconcile.test.ts` — assert an old synth2 slice
  lacking `sync` heals to `sync: false` via `reconcileWithDefaults`. (No
  reconcile *code* change — `storage.ts` already `deepMerge`s
  `Synth2Engine.DEFAULT_PARAMS`, which now carries the sync defaults.)

---

## The merge gate (run before declaring the slice done)

From the repo root:

```bash
npm run typecheck && npm test && npm run build
```

Expected: typecheck clean across all 3 workspaces; all tests green; the build
emits `packages/client/public/worklets/synth2-processor.js` (the synth2 worklet
bundle). Per-task you run the *narrower* commands shown in each task; the full
gate is Task 10.

---

### Task 1: Discrete descriptor `kind` + bool helpers + the 3 sync rows

**Files:**
- Modify: `packages/shared/src/engines/synth2-descriptors.ts`
- Test: `packages/shared/src/engines/synth2-descriptors.test.ts`

- [ ] **Step 1: Update the failing exact-key + kind tests**

In `synth2-descriptors.test.ts`, replace the `'covers exactly the I2b param
set …'` test and add a discrete-descriptor test. The full updated test file
`describe` body:

```ts
import { describe, it, expect } from 'vitest';
import { SYNTH2_DESCRIPTORS, isDiscrete, encodeBool, decodeBool } from './synth2-descriptors.js';

describe('SYNTH2_DESCRIPTORS', () => {
  it('has unique keys in <module>.<field> form', () => {
    const keys = SYNTH2_DESCRIPTORS.map(d => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toMatch(/^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*$/);
  });

  it('every default lies within [min, max]', () => {
    for (const d of SYNTH2_DESCRIPTORS) {
      expect(d.default, d.key).toBeGreaterThanOrEqual(d.min);
      expect(d.default, d.key).toBeLessThanOrEqual(d.max);
      expect(d.min, d.key).toBeLessThan(d.max);
    }
  });

  it('covers exactly the I2c-1 param set (append-only from here)', () => {
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
    ]);
  });

  it('sync rows are discrete booleans, excluded from the mod matrix', () => {
    for (const key of ['osc1.sync', 'osc2.sync', 'osc3.sync']) {
      const d = SYNTH2_DESCRIPTORS.find(x => x.key === key)!;
      expect(d.kind, key).toBe('bool');
      expect(isDiscrete(d), key).toBe(true);
      expect(d.modulatable, key).toBe(false);
      expect(d.default, key).toBe(0); // false
    }
  });

  it('all I2b-and-earlier rows are continuous (kind undefined or "continuous")', () => {
    const continuousKeys = SYNTH2_DESCRIPTORS.filter(d => !isDiscrete(d)).map(d => d.key);
    expect(continuousKeys).not.toContain('osc1.sync');
    for (const d of SYNTH2_DESCRIPTORS.filter(d => !d.key.endsWith('.sync'))) {
      expect(isDiscrete(d), d.key).toBe(false);
    }
  });

  it('encodeBool/decodeBool round-trip', () => {
    expect(encodeBool(true)).toBe(1);
    expect(encodeBool(false)).toBe(0);
    expect(decodeBool(1)).toBe(true);
    expect(decodeBool(0)).toBe(false);
    expect(decodeBool(0.4)).toBe(false);
    expect(decodeBool(0.6)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -w @fiddle/shared -- synth2-descriptors`
Expected: FAIL — `isDiscrete`/`encodeBool`/`decodeBool` not exported; key list mismatch.

- [ ] **Step 3: Implement the kind discriminant, helpers, and rows**

In `synth2-descriptors.ts`, add the kind type + helpers and append the 3 rows.
After the existing `Synth2Taper` line add:

```ts
export type Synth2Taper = 'linear' | 'expOctaves';
// Discrete kinds ride the SAME Float32Array param block as continuous params
// (spec §6.6: "enums and booleans encoded as floats") but are applied at block
// boundaries WITHOUT a smoother and are excluded from the mod matrix. I2c-1
// adds only 'bool' (osc hard-sync toggles); 'enum' (filter model/type) lands in
// I2c-2 — widen this union then.
export type Synth2Kind = 'continuous' | 'bool';
```

Extend the interface with the optional `kind` field (omitted ⇒ continuous, so
the 23 existing rows are untouched):

```ts
export interface Synth2ParamDescriptor {
  /** '<module>.<field>' — also the wire-path tail under engines.synth2 */
  key: string;
  min: number;
  max: number;
  /** Continuous: the value. bool: 0 = false, 1 = true. */
  default: number;
  /** How modulation is applied in the kernel (spec §6.3). Base values are linear. */
  taper: Synth2Taper;
  /** Whether the mod matrix (I3) may target this slot. Discrete rows: false. */
  modulatable: boolean;
  /** At |amount|=1: linear → fraction of full range; expOctaves → octaves. */
  modScale: number;
  /** Discrete kinds skip the smoother and the mod matrix. Omitted ⇒ 'continuous'. */
  kind?: Synth2Kind;
}

/** A param is discrete (block-boundary, no smoother, not a mod dest) when it
 *  declares a non-continuous kind. Continuous rows omit `kind`. */
export const isDiscrete = (d: Synth2ParamDescriptor): boolean =>
  d.kind !== undefined && d.kind !== 'continuous';

/** Bool ⇄ float-block encoding (spec §6.6). Threshold at 0.5 on decode so a
 *  float32-roundtripped 1 still reads true. */
export const encodeBool = (v: boolean): number => (v ? 1 : 0);
export const decodeBool = (n: number): boolean => n >= 0.5;
```

Then append after the `fm.osc3` row (keep it the last entry in the array):

```ts
  { key: 'fm.osc2',         min: 0,    max: 4,    default: 0,   taper: 'linear',     modulatable: true, modScale: 1 },
  { key: 'fm.osc3',         min: 0,    max: 4,    default: 0,   taper: 'linear',     modulatable: true, modScale: 1 },
  // --- I2c-1 hard sync (append-only). Discrete booleans: ride the block as 0/1,
  // applied at the block boundary (no smoother), excluded from the mod matrix.
  // osc1.sync is inert (osc1 is the sync master) but kept so all 3 oscs share
  // one uniform param shape (spec §7.2). Kernel wires osc2←osc1, osc3←osc2.
  { key: 'osc1.sync',       min: 0,    max: 1,    default: 0,   taper: 'linear',     modulatable: false, modScale: 0, kind: 'bool' },
  { key: 'osc2.sync',       min: 0,    max: 1,    default: 0,   taper: 'linear',     modulatable: false, modScale: 0, kind: 'bool' },
  { key: 'osc3.sync',       min: 0,    max: 1,    default: 0,   taper: 'linear',     modulatable: false, modScale: 0, kind: 'bool' },
```

- [ ] **Step 4: Run it to confirm green**

Run: `npm test -w @fiddle/shared -- synth2-descriptors`
Expected: PASS (all `SYNTH2_DESCRIPTORS` tests).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/engines/synth2-descriptors.ts packages/shared/src/engines/synth2-descriptors.test.ts
git commit -m "feat(shared): synth2 discrete descriptor kind + osc.sync bool rows (I2c-1)"
```

---

### Task 2: `Synth2OscParams.sync` + bool-aware defaults

**Files:**
- Modify: `packages/shared/src/engines/synth2.ts`
- Test: `packages/shared/src/engines/synth2.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `synth2.test.ts` (a `describe('DEFAULT_SYNTH2_PARAMS', …)` block likely
exists — add these `it`s there, or create the block):

```ts
import { DEFAULT_SYNTH2_PARAMS } from './synth2.js';

it('defaults each oscillator sync to false (boolean, not number)', () => {
  expect(DEFAULT_SYNTH2_PARAMS.osc1.sync).toBe(false);
  expect(DEFAULT_SYNTH2_PARAMS.osc2.sync).toBe(false);
  expect(DEFAULT_SYNTH2_PARAMS.osc3.sync).toBe(false);
  expect(typeof DEFAULT_SYNTH2_PARAMS.osc2.sync).toBe('boolean');
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -w @fiddle/shared -- synth2.test`
Expected: FAIL — `osc1.sync` is `0` (number) not `false`, or a TS error on the
new property.

- [ ] **Step 3: Implement**

In `synth2.ts`, add `sync` to `Synth2OscParams` and decode bool descriptors in
`buildDefaults`:

```ts
import { SYNTH2_DESCRIPTORS, decodeBool } from './synth2-descriptors.js';

export interface Synth2OscParams {
  morph: number;       // 0 sine → 1 tri → 2 saw → 3 pulse (continuous)
  pulseWidth: number;
  coarse: number;      // semitones
  fine: number;        // cents
  level: number;
  sync: boolean;       // hard-sync to the previous osc (inert on osc1 — master)
}
```

And replace `buildDefaults`:

```ts
function buildDefaults(): Synth2EngineParams {
  const out: Record<string, Record<string, number | boolean>> = {};
  for (const d of SYNTH2_DESCRIPTORS) {
    const [mod, field] = d.key.split('.');
    (out[mod] ??= {})[field] = d.kind === 'bool' ? decodeBool(d.default) : d.default;
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
git commit -m "feat(shared): synth2 osc.sync param + bool-aware defaults (I2c-1)"
```

---

### Task 3: Boolean leaf schemas (Zod)

**Files:**
- Modify: `packages/shared/src/project/schema.ts:90-108`
- Test: `packages/shared/src/project/schema.test.ts`

- [ ] **Step 1: Write the failing test**

In `schema.test.ts`, add (near the existing synth2 schema-derivation tests):

```ts
import { SYNTH2_LEAF_SCHEMAS, Schemas } from './schema.js';

describe('synth2 discrete (bool) leaves', () => {
  it('maps osc.sync to a boolean leaf schema', () => {
    for (const key of ['osc1.sync', 'osc2.sync', 'osc3.sync']) {
      expect(SYNTH2_LEAF_SCHEMAS[key].safeParse(true).success, key).toBe(true);
      expect(SYNTH2_LEAF_SCHEMAS[key].safeParse(false).success, key).toBe(true);
      expect(SYNTH2_LEAF_SCHEMAS[key].safeParse(1).success, key).toBe(false);
      expect(SYNTH2_LEAF_SCHEMAS[key].safeParse('x').success, key).toBe(false);
    }
  });

  it('Synth2ParamsSchema requires osc.sync to be boolean', () => {
    const ok = Schemas.Synth2Params.shape.osc2.safeParse({
      morph: 2, pulseWidth: 0.5, coarse: 0, fine: 7, level: 0.8, sync: false,
    });
    expect(ok.success).toBe(true);
    const bad = Schemas.Synth2Params.shape.osc2.safeParse({
      morph: 2, pulseWidth: 0.5, coarse: 0, fine: 7, level: 0.8, sync: 1,
    });
    expect(bad.success).toBe(false);
  });
});
```

> Note: `Schemas.Synth2Params` is already exported (see `Schemas` map in
> `schema.ts`). `Schemas.Synth2Params.shape.osc2` is the per-module object
> schema.

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -w @fiddle/shared -- schema`
Expected: FAIL — `osc2.sync` leaf is `z.number()`, parses `1` as success and
`true` may fail the `.min/.max` etc.

- [ ] **Step 3: Implement**

In `schema.ts`, change the leaf-entry map to branch on `kind`, and widen the
exported map type:

```ts
const synth2LeafEntries = SYNTH2_DESCRIPTORS.map(
  d => [d.key, d.kind === 'bool' ? z.boolean() : z.number().min(d.min).max(d.max)] as const,
);

export const SYNTH2_LEAF_SCHEMAS: Readonly<Record<string, z.ZodTypeAny>> =
  Object.fromEntries(synth2LeafEntries);

const synth2Modules: Record<string, Record<string, z.ZodTypeAny>> = {};
for (const [key, schema] of synth2LeafEntries) {
  const [mod, field] = key.split('.');
  (synth2Modules[mod] ??= {})[field] = schema;
}
```

(The `Synth2ParamsSchema = z.object({ ...modules, mode })` builder below is
unchanged — `z.object(fields).strict()` accepts the now-mixed
number/boolean field map.)

- [ ] **Step 4: Run it to confirm green**

Run: `npm test -w @fiddle/shared -- schema`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/project/schema.ts packages/shared/src/project/schema.test.ts
git commit -m "feat(shared): synth2 bool leaves get z.boolean() schema (I2c-1)"
```

---

### Task 4: Accept-list round-trip for the sync boolean

**Files:**
- Test: `packages/shared/src/project/accept-list.test.ts`
- (No production change — `accept-list.ts` patterns + `resolveLeafSchema` are
  already descriptor-driven and resolve `SYNTH2_LEAF_SCHEMAS[key]`, now a
  boolean schema.)

- [ ] **Step 1: Write the test**

Add to `accept-list.test.ts`:

```ts
import { validatePathAndValue, pathIsWritable } from './accept-list.js';

describe('synth2 osc.sync wire validation', () => {
  it('accepts a boolean at engines.synth2.osc2.sync', () => {
    const path = 'tracks.0.engines.synth2.osc2.sync';
    expect(pathIsWritable(path)).toBe(true);
    expect(validatePathAndValue(path, true).ok).toBe(true);
    expect(validatePathAndValue(path, false).ok).toBe(true);
  });

  it('rejects a non-boolean at engines.synth2.osc2.sync', () => {
    const path = 'tracks.0.engines.synth2.osc2.sync';
    const r = validatePathAndValue(path, 1);
    expect(r.ok).toBe(false);
  });

  it('accepts osc1.sync and osc3.sync paths too', () => {
    expect(pathIsWritable('tracks.0.engines.synth2.osc1.sync')).toBe(true);
    expect(pathIsWritable('tracks.0.engines.synth2.osc3.sync')).toBe(true);
  });
});
```

> Check the existing imports at the top of `accept-list.test.ts` — if
> `validatePathAndValue` / `pathIsWritable` are already imported, don't
> duplicate the import.

- [ ] **Step 2: Run it**

Run: `npm test -w @fiddle/shared -- accept-list`
Expected: PASS immediately (the accept-list is already descriptor-driven, so the
new patterns/schema come for free). If it FAILS, the descriptor/schema wiring
from Tasks 1/3 is wrong — fix there, not here.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/project/accept-list.test.ts
git commit -m "test(shared): synth2 osc.sync accept-list round-trip (I2c-1)"
```

---

### Task 5: Healing — old synth2 slices gain `sync: false`

**Files:**
- Test: `packages/client/src/project/reconcile.test.ts`
- (No production change expected — `storage.ts` `reconcileTrack` does
  `deepMerge(Synth2Engine.DEFAULT_PARAMS, loadedEngines.synth2)`, and
  `DEFAULT_SYNTH2_PARAMS` now carries `osc*.sync: false`, so a loaded slice
  missing `sync` heals automatically — same mechanism that healed I2b's new
  osc2/osc3/noise/fm modules.)

- [ ] **Step 1: Write the test**

Add to `reconcile.test.ts` (it already imports `reconcileWithDefaults`; match
the file's existing helper for building a partial project — mirror an existing
test that feeds a stripped engine slice):

```ts
it('heals a synth2 slice missing osc.sync to false', () => {
  // Simulate a pre-I2c-1 snapshot: a synth2 slice without the sync fields.
  const partial = {
    schemaVersion: 2,
    bpm: 120,
    tracks: [
      {
        engineType: 'synth2',
        engines: {
          synth2: {
            osc1: { morph: 2, pulseWidth: 0.5, coarse: 0, fine: 0, level: 0.8 }, // no sync
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
  const osc1 = healed.tracks[0].engines.synth2.osc1;
  expect(osc1.sync).toBe(false);
  expect(healed.tracks[0].engines.synth2.osc2.sync).toBe(false);
  expect(healed.tracks[0].engines.synth2.osc3.sync).toBe(false);
});
```

> The exact shape of the `reconcileWithDefaults` argument/return may differ —
> read the existing tests in `reconcile.test.ts` and mirror their construction
> (some pass a raw `unknown`, some a typed partial). The assertion (sync heals
> to `false`) is the point.

- [ ] **Step 2: Run it**

Run: `npm test -w @fiddle/client -- reconcile`
Expected: PASS (deepMerge fills `sync` from the updated defaults). If it FAILS
because `deepMerge` does not recurse into a present sub-object, that's a real
gap — fix by confirming `storage.ts:43`
`deepMerge(Synth2Engine.DEFAULT_PARAMS, loadedEngines.synth2)` is reached and
`deepMerge` is a deep (recursive) merge. Do **not** add bespoke sync-healing
code; the generic deepMerge path must cover it.

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/project/reconcile.test.ts
git commit -m "test(client): old synth2 slice heals osc.sync to false (I2c-1)"
```

---

### Task 6: Engine encodes boolean params into the block

**Files:**
- Modify: `packages/client/src/engine/Synth2Engine.ts:40-61`
- Test: `packages/client/src/engine/Synth2Engine.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `Synth2Engine.test.ts` (it already has `MockWorkletNode` with a `port`
capturing posted messages, and imports `PARAM_INDEX`):

```ts
describe('Synth2Engine boolean (discrete) params', () => {
  it('encodes osc2.sync=true as 1 in the posted block', () => {
    const ctx = mockCtx();
    const engine = new Synth2Engine(ctx);
    const port = (engine as any).node.port as MockPort;
    port.posted.length = 0;

    engine.applyParams({ osc2: { sync: true } });

    const msg = port.posted.find(m => m.type === 'params');
    expect(msg).toBeTruthy();
    expect(msg.block[PARAM_INDEX['osc2.sync']]).toBe(1);
  });

  it('encodes osc2.sync=false as 0 and is a no-op when already 0', () => {
    const ctx = mockCtx();
    const engine = new Synth2Engine(ctx);
    const port = (engine as any).node.port as MockPort;
    port.posted.length = 0;
    // Default sync is 0; setting false again should not post.
    engine.applyParams({ osc2: { sync: false } });
    expect(port.posted.some(m => m.type === 'params')).toBe(false);
    // Flip true then false: the false flip posts a 0.
    engine.applyParams({ osc2: { sync: true } });
    port.posted.length = 0;
    engine.applyParams({ osc2: { sync: false } });
    const msg = port.posted.find(m => m.type === 'params');
    expect(msg.block[PARAM_INDEX['osc2.sync']]).toBe(0);
  });

  it('ignores string params (mode rides the trigger, not the block)', () => {
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
Expected: FAIL — `applyParams` currently `continue`s on non-number values, so
`osc2.sync=true` never reaches the block.

- [ ] **Step 3: Implement**

Replace the inner loop body of `applyParams` so booleans encode to 1/0 while
strings (e.g. `mode`) are still skipped:

```ts
  applyParams(params: Record<string, any>): void {
    let changed = false;
    for (const [mod, fields] of Object.entries(params)) {
      if (typeof fields !== 'object' || fields === null) continue;
      for (const [field, value] of Object.entries(fields as Record<string, unknown>)) {
        const idx = PARAM_INDEX[`${mod}.${field}`];
        if (idx === undefined) continue;
        // Continuous params arrive as numbers; discrete bools as true/false
        // (encoded 0/1 — spec §6.6). Strings (e.g. mode) ride the trigger, not
        // the block, so they're skipped here.
        let f32: number;
        if (typeof value === 'number') f32 = Math.fround(value);
        else if (typeof value === 'boolean') f32 = value ? 1 : 0;
        else continue;
        if (this.block[idx] === f32) continue;
        this.block[idx] = f32;
        changed = true;
      }
    }
    if (changed) {
      this.node.port.postMessage({ type: 'params', block: this.block.slice() });
    }
  }
```

- [ ] **Step 4: Run it to confirm green**

Run: `npm test -w @fiddle/client -- Synth2Engine`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/engine/Synth2Engine.ts packages/client/src/engine/Synth2Engine.test.ts
git commit -m "feat(client): Synth2Engine encodes boolean params into the block (I2c-1)"
```

---

### Task 7: MorphOscillator — wrap reporting + hard-sync reset

**Files:**
- Modify: `packages/client/src/engine/synth2/kernel/MorphOscillator.ts`
- Test: `packages/client/src/engine/synth2/kernel/MorphOscillator.test.ts`

Background: hard sync means the **slave** oscillator's phase is reset whenever
the **master** completes a cycle. Sub-sample accuracy (spec §6.8): when the
master wraps part-way through a sample, the slave should land at
`masterOverflowFraction × slaveDt`. We expose, per master sample, `wrapped`
(did the phase cross 1 this sample) and `wrapFrac` (the fraction of the sample
that elapsed *after* the wrap, `= overflow / dt ∈ [0,1)`). The voice feeds the
master's `wrapFrac` into the slave's new `syncReset` argument.

- [ ] **Step 1: Write the failing tests**

Add a new `describe('MorphOscillator hard sync', …)` to
`MorphOscillator.test.ts`. Reuse the existing `makeOsc`, `render`,
`positiveZeroCrossings`, `SR` helpers already in that file:

```ts
describe('MorphOscillator hard sync', () => {
  it('syncReset = -1 is bit-identical to the no-sync call (saw, morph 2)', () => {
    const n = 512;
    const freq = 220;
    const a = makeOsc(2);
    const b = makeOsc(2);
    for (let i = 0; i < n; i++) {
      // a uses the 4-arg form with the no-sync sentinel; b uses the old 1-arg form.
      expect(a.next(freq, 0, 0, -1)).toBeCloseTo(b.next(freq), 12);
    }
  });

  it('exposes wrapped/wrapFrac when the phase crosses a cycle', () => {
    const osc = makeOsc(2);
    let sawWrap = false;
    for (let i = 0; i < SR; i++) {
      osc.next(440);
      if (osc.wrapped) {
        sawWrap = true;
        expect(osc.wrapFrac).toBeGreaterThanOrEqual(0);
        expect(osc.wrapFrac).toBeLessThan(1);
      }
    }
    expect(sawWrap).toBe(true);
  });

  it('hard sync locks the slave period to the master', () => {
    // Master 220 Hz; slave detuned +7 semitones (free period ≈ 330 Hz) and
    // hard-synced. The synced output must repeat at the MASTER rate (~220),
    // not the slave's free rate (~330).
    const SEMI = 7;
    const masterFreq = 220;
    const master = makeOsc(2);
    const slaveSynced = new MorphOscillator(
      slot('osc2.morph', 0, 3, 2),
      slot('osc2.pulseWidth', 0.05, 0.95, 0.5),
      slot('osc2.coarse', -36, 36, SEMI),
      slot('osc2.fine', -100, 100, 0),
      SR,
    );
    const slaveFree = new MorphOscillator(
      slot('osc2.morph', 0, 3, 2),
      slot('osc2.pulseWidth', 0.05, 0.95, 0.5),
      slot('osc2.coarse', -36, 36, SEMI),
      slot('osc2.fine', -100, 100, 0),
      SR,
    );
    const synced = new Float32Array(SR);
    const free = new Float32Array(SR);
    for (let i = 0; i < SR; i++) {
      const m = master.next(masterFreq);
      void m;
      synced[i] = slaveSynced.next(masterFreq, 0, 0, master.wrapped ? master.wrapFrac : -1);
      free[i] = slaveFree.next(masterFreq);
    }
    // Free slave runs near 330 Hz; synced slave locks to the 220 Hz master.
    const freeHz = positiveZeroCrossings(free);
    const syncHz = positiveZeroCrossings(synced);
    expect(freeHz).toBeGreaterThan(310);   // ~330
    expect(syncHz).toBeLessThan(260);      // locked toward ~220, well below free
    expect(syncHz).toBeGreaterThan(190);
  });

  it('stays finite and bounded under sync while sweeping master pitch', () => {
    const master = makeOsc(2);
    const slave = makeOsc(2);
    for (let i = 0; i < 8192; i++) {
      const f = 110 + i / 8192 * 800; // sweep master 110 → 910 Hz
      master.next(f);
      const s = slave.next(f * 1.5, 0, 0, master.wrapped ? master.wrapFrac : -1);
      expect(Number.isFinite(s)).toBe(true);
      expect(Math.abs(s)).toBeLessThan(2);
    }
  });
});
```

> `slot(...)` and `makeOsc(...)` already exist at the top of
> `MorphOscillator.test.ts` — reuse them; do not redefine.

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -w @fiddle/client -- MorphOscillator`
Expected: FAIL — `next` has no 4th param / `osc.wrapped` is undefined.

- [ ] **Step 3: Implement wrap reporting + sync reset**

In `MorphOscillator.ts`, add the two public fields and extend `next`. Add after
`private tri = 0;`:

```ts
export class MorphOscillator {
  private phase = 0;
  private tri = 0;

  /** Set every sample: did the phase cross a full cycle this sample? */
  wrapped = false;
  /** When `wrapped`, the fraction of the sample elapsed AFTER the wrap
   *  (= overflow / dt ∈ [0,1)); used by a slave for sub-sample sync reset. */
  wrapFrac = 0;
```

Replace the `next` signature and its phase-advance tail. The new signature:

```ts
  /**
   * @param syncReset  -1 = free-running; >= 0 = hard-sync this sample, resetting
   *   phase to `syncReset * |dt|` (the master's post-wrap fraction × this osc's
   *   increment), sub-sample-accurate per spec §6.8. The reset takes effect for
   *   the NEXT sample's output; the sync-edge itself is left un-BLEPed (spec's
   *   accepted v1 residual aliasing).
   */
  next(baseFreq: number, fmInput = 0, fmAmount = 0, syncReset = -1): number {
```

Everything from `const semis = …` through computing `out` stays unchanged.
Replace ONLY the phase-advance tail (currently lines ~59-62):

```ts
    this.phase += dt;
    this.wrapped = false;
    if (this.phase >= 1) {
      this.phase -= 1;
      this.wrapped = true;
      // dt is the per-sample increment (>0 for a free/forward master). After the
      // wrap phase ∈ [0, dt); wrapFrac = phase/dt ∈ [0,1) is the post-wrap
      // fraction of this sample.
      this.wrapFrac = dt > 1e-12 ? this.phase / dt : 0;
    } else if (this.phase < 0) {
      this.phase += 1; // backward wrap (deep TZFM); not used as a sync master in v1
    }
    // Hard sync: master wrapped → reset this slave's phase sub-sample-accurately.
    if (syncReset >= 0) {
      const adt = dt < 0 ? -dt : dt;
      this.phase = syncReset * adt;
      if (this.phase >= 1) this.phase -= 1; // safety; syncReset<1 && adt<1 ⇒ <1
    }
    return out;
```

- [ ] **Step 4: Run it to confirm green**

Run: `npm test -w @fiddle/client -- MorphOscillator`
Expected: PASS (including the pre-existing TZFM/morph tests — the no-sync path
is byte-identical because `syncReset` defaults to `-1`).

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/engine/synth2/kernel/MorphOscillator.ts packages/client/src/engine/synth2/kernel/MorphOscillator.test.ts
git commit -m "feat(client): MorphOscillator wrap reporting + hard-sync reset (I2c-1)"
```

---

### Task 8: Voice sync chain + kernel propagation

**Files:**
- Modify: `packages/client/src/engine/synth2/kernel/Voice.ts`
- Modify: `packages/client/src/engine/synth2/kernel/Synth2Kernel.ts`
- Test: `packages/client/src/engine/synth2/kernel/Synth2Kernel.test.ts`

- [ ] **Step 1: Write the failing integration test**

Add a `describe('Synth2Kernel hard sync', …)` to `Synth2Kernel.test.ts` (reuse
`SR`, `BLOCK`, `renderBlocks`, `defaultParamBlock`, `PARAM_INDEX`):

```ts
describe('Synth2Kernel hard sync', () => {
  function renderOsc2Only(syncOn: boolean): Float32Array {
    const k = new Synth2Kernel(SR);
    const block = defaultParamBlock();
    // Isolate osc2: silence osc1/osc3/noise, detune osc2 up so its free period
    // clearly differs from the 220 Hz played note.
    block[PARAM_INDEX['osc1.level']] = 0;
    block[PARAM_INDEX['osc3.level']] = 0;
    block[PARAM_INDEX['noise.level']] = 0;
    block[PARAM_INDEX['osc2.level']] = 1;
    block[PARAM_INDEX['osc2.coarse']] = 7;          // +7 semitones (~1.5×)
    block[PARAM_INDEX['osc2.sync']] = syncOn ? 1 : 0;
    k.applyParams(block);
    k.noteOn(0, 220, 2, 1, true);                   // mono, 220 Hz master pitch
    return renderBlocks(k, 0, Math.ceil(SR / BLOCK)); // ~1s
  }

  function positiveZeroCrossings(buf: Float32Array): number {
    let c = 0;
    for (let i = 1; i < buf.length; i++) if (buf[i - 1] <= 0 && buf[i] > 0) c++;
    return c;
  }

  it('osc2.sync locks osc2 to the played (master) pitch', () => {
    const free = positiveZeroCrossings(renderOsc2Only(false)); // ~330 Hz
    const sync = positiveZeroCrossings(renderOsc2Only(true));  // ~220 Hz
    expect(free).toBeGreaterThan(300);
    expect(sync).toBeLessThan(free - 40); // measurably pulled toward the master
  });

  it('renders finite, bounded audio with sync on', () => {
    const out = renderOsc2Only(true);
    let peak = 0;
    for (let i = 0; i < out.length; i++) {
      expect(Number.isFinite(out[i])).toBe(true);
      peak = Math.max(peak, Math.abs(out[i]));
    }
    expect(peak).toBeLessThan(2);
    expect(peak).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -w @fiddle/client -- Synth2Kernel`
Expected: FAIL — `osc2.sync` does nothing yet (Voice ignores it); sync count ≈
free count.

- [ ] **Step 3: Implement the Voice sync chain**

In `Voice.ts`, add two boolean fields, a setter, and wire the chain into
`renderAdd`. Add fields after `private velocity = 1;`:

```ts
  private osc2Sync = false;
  private osc3Sync = false;
```

Add a setter (after the constructor, before `get active`):

```ts
  /** Block-boundary discrete update: osc2 syncs to osc1's wraps, osc3 to osc2's.
   *  (osc1.sync is inert — osc1 is the master.) */
  setSync(osc2Sync: boolean, osc3Sync: boolean): void {
    this.osc2Sync = osc2Sync;
    this.osc3Sync = osc3Sync;
  }
```

Replace the three osc `next(...)` calls in `renderAdd` so the master's
`wrapped`/`wrapFrac` drive the slaves:

```ts
      // TZFM + hard-sync chain: osc1 master → osc2 → osc3. Each ParamSlot.next()
      // called exactly once per sample. A slave resets when its master wrapped
      // this sample AND its sync toggle is on.
      const o1 = this.osc1.next(this.freq);
      const o2 = this.osc2.next(
        this.freq, o1, this.fmOsc2.next(),
        this.osc2Sync && this.osc1.wrapped ? this.osc1.wrapFrac : -1,
      );
      const o3 = this.osc3.next(
        this.freq, o2, this.fmOsc3.next(),
        this.osc3Sync && this.osc2.wrapped ? this.osc2.wrapFrac : -1,
      );
```

(The `nz`/`mix`/`out[n] +=` lines below are unchanged.)

- [ ] **Step 4: Propagate sync from the block in the kernel**

In `Synth2Kernel.ts`, import `PARAM_INDEX` and push the sync booleans to every
voice at the end of `applyParams`. Change the import line:

```ts
import { PARAM_COUNT, PARAM_INDEX, defaultParamBlock } from './params';
```

And extend `applyParams` (after the existing slot-broadcast loop, before the
method closes):

```ts
  applyParams(block: Float32Array): void {
    const n = Math.min(block.length, PARAM_COUNT);
    for (let i = 0; i < n; i++) this.block[i] = block[i];
    for (const voice of this.voices) {
      for (let i = 0; i < n; i++) voice.slots[i].setBase(this.block[i]);
    }
    // Discrete (bool) params: applied at the block boundary, no smoother.
    const osc2Sync = this.block[PARAM_INDEX['osc2.sync']] >= 0.5;
    const osc3Sync = this.block[PARAM_INDEX['osc3.sync']] >= 0.5;
    for (const voice of this.voices) voice.setSync(osc2Sync, osc3Sync);
  }
```

> The `*.sync` ParamSlots still get `setBase` in the loop above (harmless — they
> are never read via `.next()`; the voice reads the booleans through
> `setSync`). Leaving them in keeps the broadcast loop uniform and allocation-free.

- [ ] **Step 5: Run it to confirm green**

Run: `npm test -w @fiddle/client -- Synth2Kernel`
Expected: PASS. Also re-run the oscillator suite to confirm no regression:
`npm test -w @fiddle/client -- MorphOscillator Voice Synth2Kernel`.

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/engine/synth2/kernel/Voice.ts packages/client/src/engine/synth2/kernel/Synth2Kernel.ts packages/client/src/engine/synth2/kernel/Synth2Kernel.test.ts
git commit -m "feat(client): synth2 Voice hard-sync chain + kernel sync propagation (I2c-1)"
```

---

### Task 9: Panel — SYNC toggles on osc2 / osc3

**Files:**
- Modify: `packages/client/src/components/Synth2Panel.vue`
- Test: `packages/client/src/components/Synth2Panel.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `Synth2Panel.test.ts`:

```ts
describe('Synth2Panel hard-sync toggles', () => {
  it('renders a SYNC toggle on osc2 and osc3 (not osc1)', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    const syncBtns = el.querySelectorAll<HTMLButtonElement>('.sync-btn');
    expect(syncBtns.length).toBe(2); // osc2 + osc3 only
  });

  it('toggles osc2.sync on click', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    const syncBtns = el.querySelectorAll<HTMLButtonElement>('.sync-btn');
    expect(params.osc2.sync).toBe(false);
    syncBtns[0].click();
    expect(params.osc2.sync).toBe(true);
    syncBtns[0].click();
    expect(params.osc2.sync).toBe(false);
  });

  it('toggles osc3.sync on click', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    const syncBtns = el.querySelectorAll<HTMLButtonElement>('.sync-btn');
    syncBtns[1].click();
    expect(params.osc3.sync).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -w @fiddle/client -- Synth2Panel`
Expected: FAIL — no `.sync-btn` elements.

- [ ] **Step 3: Implement**

In `Synth2Panel.vue`, add a SYNC toggle button inside the OSC 2 and OSC 3
`module-group`s, immediately after each `</div>` closing the osc's `knob-row`.
For OSC 2 (mirror exactly for OSC 3 with `osc3`):

```html
        <button
          type="button"
          class="sync-btn"
          :class="{ active: params.osc2.sync }"
          @click="params.osc2.sync = !params.osc2.sync"
        >
          SYNC
        </button>
```

> Sync to peers and the engine is automatic: mutating `params.osc2.sync` is
> picked up by the existing `engines.synth2` slice watchers in `useSynth.ts`
> (the outbound-sync watcher emits an `engines.synth2.osc2.sync` op via
> `emitLeafDiff`; the audio-reaction watcher calls `engine.applyParams`). This
> is the same path `mode` uses — no `useSynth` change and no `syncPath`/`ks`
> wiring is required for a discrete toggle.

Add the button style to the `<style scoped>` block (reuse the mode-btn look):

```css
.sync-btn {
  width: 100%;
  margin-top: 6px;
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
.sync-btn:hover { color: #aaa; border-color: #444; }
.sync-btn.active { background: #222; color: #fff; border-color: #555; }
```

- [ ] **Step 4: Run it to confirm green**

Run: `npm test -w @fiddle/client -- Synth2Panel`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/components/Synth2Panel.vue packages/client/src/components/Synth2Panel.test.ts
git commit -m "feat(client): Synth2Panel osc2/osc3 SYNC toggles (I2c-1)"
```

---

### Task 10: Full gate + browser verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full merge gate**

```bash
npm run typecheck && npm test && npm run build
```

Expected: typecheck clean (all 3 workspaces); every test green; the build
completes and emits `packages/client/public/worklets/synth2-processor.js`.
Confirm the artifact:

```bash
ls -la packages/client/public/worklets/synth2-processor.js
```

Expected: file exists, freshly written.

- [ ] **Step 2: Zero-allocation spot-check (manual read)**

Open `Voice.ts` `renderAdd` and `Synth2Kernel.ts` `process` and confirm: no
`new`, no array growth, no closure creation inside the per-sample loop. The
sync wiring added only scalar reads/compares — confirm it didn't introduce any
allocation. (Soak/perf profiling is I4; this is just a no-regression eyeball.)

- [ ] **Step 3: Browser verification (Playwright MCP, then CLOSE the browser)**

1. `npm run dev` (starts client + server).
2. Open the app, create/open a session, add a **synth2** track.
3. Enter a step with a note; Play — confirm the default patch sounds (sanity).
4. Turn **osc2 level** up and **osc1 level** down (so osc2 is audible); set
   **osc2 coarse** to ~+7 semitones — you should hear the detune.
5. Click **SYNC** on OSC 2. While a note holds/repeats, sweep **osc2 coarse**
   up and down — you should hear the characteristic **hard-sync sweep** (the
   timbre morphs but the pitch stays locked to the played note).
6. Click SYNC off — confirm the sweep goes back to a plain detune (pitch
   follows osc2 again).
7. (Optional, if a second client is convenient) Reuse the sync harness: toggle
   osc2 SYNC in client A; confirm client B's panel reflects `sync` on and the
   audio matches — verifies the discrete-param sync round-trip.
8. **Close the Playwright browser/session** (AGENTS.md cleanup rule).

- [ ] **Step 4: Stop the dev server and report**

Stop `npm run dev`. Report the gate result and the browser observations. **Do
not merge** — the user browser-verifies and merges. Keep the branch.

---

## Self-review (against spec §5.1/§5.2/§6.3/§6.6/§6.8)

- **§6.6 discrete encoding ("enums and booleans encoded as floats")** → Task 1
  (`kind: 'bool'` rows in the same block), Task 6 (engine encodes 0/1), Task 8
  (kernel reads raw `>= 0.5`). ✔
- **§6.6 "discrete params switch at block boundaries"** → Task 8: `setSync`
  applied in `applyParams`, no smoother. ✔
- **§6.3 "modulation coverage rule" (discrete params are not mod destinations)**
  → Task 1: `modulatable: false`, `modScale: 0`; Task 1 test asserts it. ✔
- **§5.2 `sync` boolean, "ignored on osc1"** → Task 1 (`osc1.sync` present),
  Task 8 (`setSync` only wires osc2/osc3; osc1.sync never read), Task 9 (toggle
  rendered only on osc2/osc3). ✔
- **§5.1 sync chain (osc2←osc1 wrap, osc3←osc2 wrap)** → Task 7 (wrap
  reporting), Task 8 (`renderAdd` chain). ✔
- **§6.8 sub-sample reset `overflow × slaveDt / masterDt`** → Task 7:
  `wrapFrac = overflow/masterDt`, slave `phase = wrapFrac × |slaveDt|`. ✔
- **§6.8 PolyBLEP at the reset edge** → *deliberately deferred* (documented in
  Context + Task 7) under the spec's "good enough over perfect, residual
  aliasing accepted in v1" latitude. Each shape's own edges stay BLEP/BLAMP
  corrected. ✔ (scope cut, surfaced)
- **§7.2 uniform osc shape `{…, sync}`** → Task 2 (`Synth2OscParams.sync`). ✔
- **Append-only descriptor ABI** → Task 1 appends at array end; exact-key guard
  test pins the order. ✔
- **Healing for old snapshots** → Task 5 (deepMerge of updated defaults). ✔
- **Type consistency** → `kind`/`isDiscrete`/`encodeBool`/`decodeBool`
  (Task 1) reused in Tasks 2/3; `wrapped`/`wrapFrac`/`syncReset` (Task 7) reused
  in Task 8; `setSync` defined Task 8 Voice, called Task 8 kernel. ✔

## Out of scope (restated — do not build in this slice)

- Filter (`SvfCore`/`ClassicFilter`), env2, keytrack, `filterEnvAmount` → **I2c-2**.
- `kind: 'enum'` (filter model/type selectors) → I2c-2.
- Mod matrix, LFOs, env3, `env.loop` → I3.
- A dedicated PolyBLEP sync-edge correction → I4 polish.
