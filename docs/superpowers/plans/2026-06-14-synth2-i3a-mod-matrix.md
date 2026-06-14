# synth2 I3a — Mod Matrix Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the 8-slot modulation matrix as a thin per-sample kernel layer that writes the already-live `ParamSlot.mod` seam, routing the existing sources (env1, env2, velocity, noise) to every continuous destination — audible at landing, with LFOs/env3 stubbed as zero sources for I3b/I3c.

**Architecture:** The matrix is a fixed 8-element array of `{source, dest, amount}` persisted on `engines.synth2.matrix`. It reaches the kernel by **extending the Float32Array param block** with a 24-float region after the descriptor params (`dest` encoded as `PARAM_INDEX+1`, 0=none, so it rides the descriptor table's append-only ABI). A per-voice `ModMatrix` clears and accumulates `source × amount` into each destination slot's `mod` field once per sample, using the **previous sample's** source values to avoid modulator/modulee ordering hazards. The existing `ParamSlot.next()` already applies the descriptor's taper/modScale and clamps, so the matrix adds no scaling logic. Sync needs a dedicated matrix watcher because the array-of-objects shape breaks `emitLeafDiff`'s single-level drill.

**Tech Stack:** TypeScript (npm-workspace monorepo: `@fiddle/shared`, `@fiddle/client`), Zod (wire schema), Vitest, Vue 3 (panel), Web Audio AudioWorklet (kernel runs as pure TS, WASM-shaped ABI).

---

## Context for the implementer

This is the first slice of **I3** (the modulation system), following the merged I2a–I2c slices. Read these before starting:

- **Design spec:** `docs/superpowers/specs/2026-06-12-worklet-synth-engine-design.md` §5.6 (mod matrix), §6.3 (ParamSlot + coverage rule), §6.4 (descriptor table), §6.6 (param protocol), §7 (shared integration). This plan implements the I3 matrix **only**; LFOs (I3b), env3 + loop mode (I3c), and the morph filter (I3d) are separate slices.
- **Append-only rule:** `SYNTH2_DESCRIPTORS` (`packages/shared/src/engines/synth2-descriptors.ts`) is append-only — its array order is the param-block index = wire ABI. **This slice does NOT add descriptor rows** (the matrix is structural, not a ParamSlot — spec §6.3 excludes `source`/`dest`/`amount` from being descriptors). The matrix block region is appended *after* the descriptor params, preserving the ABI.
- **The mod seam already exists.** `ParamSlot` (`packages/client/src/engine/synth2/kernel/ParamSlot.ts`) already has a `mod` field and applies `expTaper ? v*2^(mod·modScale) : v + mod·modScale·range`, then clamps, in `next()`. The matrix's only job is to write `slot.mod` each sample. Do **not** add scaling math to the matrix.
- **Source ordering is load-bearing.** The source enum order `['none','lfo1','lfo2','env1','env2','env3','velocity','noise']` is the wire encoding for `matrix[*].source` and the index into the per-sample `sources` array. Append new sources at the end only.
- **Out of scope (do NOT build here):** LFO/env3 DSP (they're zero sources for now); synthetic `pitch`/`amp` destinations (spec §5.6 — they need bespoke voice routing, deferred); modulating `amount` (spec §6.3 non-goal); the server-side old-session deep-heal (a known deferred bug — new sessions get `matrix` from factory defaults; old sessions won't sync it, same as every prior descriptor append).

### Per-task gate

After each task's tests pass, run the workspace typecheck for the package(s) you touched (`npm run typecheck` from repo root covers all three) and the relevant test suite. The full merge gate (`npm run typecheck && npm test && npm run build` across all workspaces; build must still emit `public/worklets/synth2-processor.js`) runs once at the end (Verification).

## File Structure

**Shared (`packages/shared/src/`):**
- `engines/synth2-descriptors.ts` — *modify*: add `MOD_SOURCES`, `Synth2ModSource`, `MOD_DESTS` (derived from `modulatable` descriptors).
- `engines/synth2.ts` — *modify*: `Synth2MatrixSlot` interface, `matrix` field on `Synth2EngineParams`, default 8-slot matrix in `buildDefaults()`.
- `project/schema.ts` — *modify*: `Synth2MatrixSlotSchema`, `matrix` on `Synth2ParamsSchema`, export in `Schemas`.
- `project/accept-list.ts` — *modify*: matrix `PATTERNS`, `indicesInRange` bound, `resolveLeafSchema` 7-token branch.

**Client kernel (`packages/client/src/engine/synth2/kernel/`):**
- `params.ts` — *modify*: matrix block-region constants + grown `defaultParamBlock()`.
- `ModMatrix.ts` — *create*: the 8-slot accumulator (clear + `source × amount → dest.mod`).
- `Voice.ts` — *modify*: per-sample matrix eval with previous-sample sources + `setMatrixSlot`.
- `Synth2Kernel.ts` — *modify*: decode the block's matrix region → configure each voice.

**Client engine + sync + UI (`packages/client/src/`):**
- `engine/Synth2Engine.ts` — *modify*: encode `params.matrix` into the block matrix region.
- `composables/useSynth.ts` — *modify*: `emitLeafDiff` array guard, dedicated matrix watcher, `DISCRETE_LEAF_FIELDS` += `source`/`dest`.
- `components/Synth2Panel.vue` — *modify*: a MATRIX column of 8 rows (source select, dest select, amount knob).

---

## Task 1: Shared — mod source/dest enums + matrix param shape

**Files:**
- Modify: `packages/shared/src/engines/synth2-descriptors.ts`
- Modify: `packages/shared/src/engines/synth2.ts`
- Test: `packages/shared/src/engines/synth2-descriptors.test.ts`, `packages/shared/src/engines/synth2.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `packages/shared/src/engines/synth2-descriptors.test.ts` (import `MOD_SOURCES, MOD_DESTS` from `./synth2-descriptors.js`):

```ts
describe('mod matrix enums (I3a)', () => {
  it('MOD_SOURCES is the fixed, append-only source list', () => {
    // Order is the wire encoding for matrix[*].source AND the sources[] index.
    expect(MOD_SOURCES).toEqual(['none', 'lfo1', 'lfo2', 'env1', 'env2', 'env3', 'velocity', 'noise']);
  });

  it('MOD_DESTS is none + every modulatable descriptor key, in descriptor order', () => {
    const expected = ['none', ...SYNTH2_DESCRIPTORS.filter(d => d.modulatable).map(d => d.key)];
    expect(MOD_DESTS).toEqual(expected);
  });

  it('discrete + hardwired params are NOT matrix destinations', () => {
    // sync toggles, filter.type (enum), filter.envAmount (modulatable:false) excluded.
    for (const key of ['osc1.sync', 'osc2.sync', 'osc3.sync', 'filter.type', 'filter.envAmount']) {
      expect(MOD_DESTS).not.toContain(key);
    }
  });
});
```

Add to `packages/shared/src/engines/synth2.test.ts`:

```ts
it('default matrix is 8 inert slots (I3a)', () => {
  expect(DEFAULT_SYNTH2_PARAMS.matrix).toHaveLength(8);
  for (const slot of DEFAULT_SYNTH2_PARAMS.matrix) {
    expect(slot).toEqual({ source: 'none', dest: 'none', amount: 0 });
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test --workspace @fiddle/shared -- synth2-descriptors synth2.test`
Expected: FAIL — `MOD_SOURCES`/`MOD_DESTS` undefined; `DEFAULT_SYNTH2_PARAMS.matrix` undefined.

- [ ] **Step 3: Add the enums to `synth2-descriptors.ts`**

Append at the bottom of the file (after `SYNTH2_ENUM_VALUES`):

```ts
// --- I3 modulation matrix (spec §5.6) -------------------------------------
// Source enum: ORDER IS THE WIRE ENCODING for matrix[*].source and the index
// into the kernel's per-sample sources[] array. Append-only. lfo1/lfo2/env3
// exist in the list from I3a but read 0 until I3b/I3c add their DSP.
export const MOD_SOURCES = [
  'none', 'lfo1', 'lfo2', 'env1', 'env2', 'env3', 'velocity', 'noise',
] as const;
export type Synth2ModSource = typeof MOD_SOURCES[number];

// Destination enum: 'none' plus every CONTINUOUS, modulatable descriptor key,
// in descriptor order. Derived (not hand-listed) so it can't drift from the
// table. The kernel encodes a dest as PARAM_INDEX+1 (0 = none); this string
// list is the persisted/validation form. A dest is therefore append-stable for
// the same reason the descriptor block is.
export const MOD_DESTS: readonly string[] = [
  'none', ...SYNTH2_DESCRIPTORS.filter(d => d.modulatable).map(d => d.key),
];
export type Synth2ModDest = string; // 'none' | <modulatable descriptor key>
```

- [ ] **Step 4: Add the matrix shape + defaults to `synth2.ts`**

Add the interface (near the other `Synth2*Params` interfaces) and import `MOD_SOURCES` is not needed in synth2.ts; just use literal defaults:

```ts
export interface Synth2MatrixSlot {
  source: import('./synth2-descriptors.js').Synth2ModSource;
  dest: string;   // 'none' | modulatable descriptor key (see MOD_DESTS)
  amount: number; // bipolar -1..1
}
```

Add `matrix` to `Synth2EngineParams` (after `mode`):

```ts
  mode: 'mono' | 'poly';
  // I3 mod matrix — fixed 8 slots (static wire shape, like the step buffer).
  matrix: Synth2MatrixSlot[];
```

In `buildDefaults()`, change the return to append the matrix:

```ts
  return {
    ...(out as unknown as Synth2EngineParams),
    mode: 'mono',
    matrix: Array.from({ length: 8 }, () => ({ source: 'none', dest: 'none', amount: 0 })),
  };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test --workspace @fiddle/shared -- synth2-descriptors synth2.test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/engines/synth2-descriptors.ts packages/shared/src/engines/synth2.ts packages/shared/src/engines/synth2-descriptors.test.ts packages/shared/src/engines/synth2.test.ts
git commit -m "feat(shared): synth2 mod source/dest enums + 8-slot matrix param shape (I3a)"
```

---

## Task 2: Shared — Zod schema for the matrix

**Files:**
- Modify: `packages/shared/src/project/schema.ts`
- Test: `packages/shared/src/project/schema.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/shared/src/project/schema.test.ts`:

```ts
describe('synth2 matrix schema (I3a)', () => {
  const base = () => structuredClone(DEFAULT_SYNTH2_PARAMS); // import DEFAULT_SYNTH2_PARAMS

  it('accepts the default 8-slot matrix', () => {
    expect(Schemas.Synth2Params.safeParse(base()).success).toBe(true);
  });

  it('accepts a valid route', () => {
    const p = base();
    p.matrix[0] = { source: 'env1', dest: 'filter.cutoff', amount: 0.5 };
    expect(Schemas.Synth2Params.safeParse(p).success).toBe(true);
  });

  it('rejects an unknown source', () => {
    const p = base();
    (p.matrix[0] as { source: string }).source = 'lfo9';
    expect(Schemas.Synth2Params.safeParse(p).success).toBe(false);
  });

  it('rejects a non-modulatable dest', () => {
    const p = base();
    (p.matrix[0] as { dest: string }).dest = 'filter.type';
    expect(Schemas.Synth2Params.safeParse(p).success).toBe(false);
  });

  it('rejects amount outside [-1, 1] and a wrong slot count', () => {
    const over = base(); over.matrix[0].amount = 1.5;
    expect(Schemas.Synth2Params.safeParse(over).success).toBe(false);
    const short = base(); short.matrix = short.matrix.slice(0, 7);
    expect(Schemas.Synth2Params.safeParse(short).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --workspace @fiddle/shared -- schema.test`
Expected: FAIL — `matrix` not in `Synth2ParamsSchema` (default parse fails on the extra key, or the route assertions don't validate).

- [ ] **Step 3: Add the matrix schema**

In `packages/shared/src/project/schema.ts`, import the enums at the top alongside the existing descriptor import:

```ts
import { SYNTH2_DESCRIPTORS, MOD_SOURCES, MOD_DESTS } from '../engines/synth2-descriptors.js';
```

Add the slot schema just before `const Synth2ParamsSchema = z.object({`:

```ts
const Synth2MatrixSlotSchema = z.object({
  source: z.enum(MOD_SOURCES as unknown as [string, ...string[]]),
  dest: z.enum(MOD_DESTS as unknown as [string, ...string[]]),
  amount: z.number().min(-1).max(1),
}).strict();
```

Add `matrix` to `Synth2ParamsSchema`:

```ts
const Synth2ParamsSchema = z.object({
  ...Object.fromEntries(
    Object.entries(synth2Modules).map(([mod, fields]) => [mod, z.object(fields).strict()]),
  ),
  mode: z.union([z.literal('mono'), z.literal('poly')]),
  matrix: z.array(Synth2MatrixSlotSchema).length(8),
});
```

Export the slot schema in `Schemas` (so the accept-list can resolve matrix leaves in Task 3):

```ts
  Synth2Params: Synth2ParamsSchema,
  Synth2MatrixSlot: Synth2MatrixSlotSchema,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test --workspace @fiddle/shared -- schema.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/project/schema.ts packages/shared/src/project/schema.test.ts
git commit -m "feat(shared): Zod schema for synth2 mod matrix (8 slots, enum source/dest, bipolar amount) (I3a)"
```

---

## Task 3: Shared — accept-list matrix paths, bounds, leaf schema

**Files:**
- Modify: `packages/shared/src/project/accept-list.ts`
- Test: `packages/shared/src/project/accept-list.test.ts`

The matrix introduces a 7-token path: `tracks.<i>.engines.synth2.matrix.<0-7>.<source|dest|amount>`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/shared/src/project/accept-list.test.ts`:

```ts
describe('synth2 matrix accept-list (I3a)', () => {
  it('accepts valid matrix leaf writes', () => {
    expect(validatePathAndValue('tracks.0.engines.synth2.matrix.0.source', 'env1').ok).toBe(true);
    expect(validatePathAndValue('tracks.0.engines.synth2.matrix.7.dest', 'filter.cutoff').ok).toBe(true);
    expect(validatePathAndValue('tracks.0.engines.synth2.matrix.3.amount', -0.5).ok).toBe(true);
  });

  it('rejects an out-of-range slot index', () => {
    const r = validatePathAndValue('tracks.0.engines.synth2.matrix.8.amount', 0.5);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('path.invalid');
  });

  it('rejects a bad matrix value', () => {
    expect(validatePathAndValue('tracks.0.engines.synth2.matrix.0.source', 'nope').ok).toBe(false);
    expect(validatePathAndValue('tracks.0.engines.synth2.matrix.0.amount', 2).ok).toBe(false);
    expect(validatePathAndValue('tracks.0.engines.synth2.matrix.0.dest', 'filter.type').ok).toBe(false);
  });

  it('forbids a whole-slot object write (leaves only)', () => {
    expect(pathIsWritable('tracks.0.engines.synth2.matrix.0')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test --workspace @fiddle/shared -- accept-list`
Expected: FAIL — no matrix patterns, no 7-token leaf schema.

- [ ] **Step 3: Add the matrix patterns**

In `packages/shared/src/project/accept-list.ts`, add to `PATTERNS` just after the synth2 mode pattern (line ~74):

```ts
  // synth2 mod matrix — 8 fixed slots, leaves only (no whole-slot writes).
  ['tracks', '*', 'engines', 'synth2', 'matrix', '*', 'source'],
  ['tracks', '*', 'engines', 'synth2', 'matrix', '*', 'dest'],
  ['tracks', '*', 'engines', 'synth2', 'matrix', '*', 'amount'],
```

- [ ] **Step 4: Add the index bound to `indicesInRange`**

After the existing `steps` index block inside `indicesInRange`:

```ts
  if (tokens[2] === 'engines' && tokens[3] === 'synth2' && tokens[4] === 'matrix') {
    const slotIdx = Number(tokens[5]);
    if (!Number.isInteger(slotIdx) || slotIdx < 0 || slotIdx >= 8) return false;
  }
```

- [ ] **Step 5: Add the 7-token leaf schema branch to `resolveLeafSchema`**

Inside the `if (trackKey === 'engines')` block, after the existing `tokens.length === 6 && engineName === 'synth2'` branch:

```ts
    if (tokens.length === 7 && engineName === 'synth2' && tokens[4] === 'matrix') {
      // tracks.<i>.engines.synth2.matrix.<s>.<source|dest|amount>
      const field = tokens[6] as keyof typeof Schemas.Synth2MatrixSlot.shape;
      return Schemas.Synth2MatrixSlot.shape[field] ?? null;
    }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test --workspace @fiddle/shared -- accept-list`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/project/accept-list.ts packages/shared/src/project/accept-list.test.ts
git commit -m "feat(shared): accept-list patterns + bounds + leaf schema for synth2 matrix (I3a)"
```

---

## Task 4: Client — reconcile heals a missing matrix; fresh track carries it

**Files:**
- Test: `packages/client/src/project/reconcile.test.ts` (existing; imports `reconcileWithDefaults` from `./storage`, `freshProject`/`freshTrack` from `./factory`).
- (Possibly modify `packages/client/src/utils/deepMerge.ts` — only if Step 2 shows array merge is wrong.)

Test-first verification that the existing client deep-merge heal (`reconcileTrack` → `deepMerge(Synth2Engine.DEFAULT_PARAMS, loaded)`) restores `matrix` for sessions saved before it existed, and that `freshTrack()` carries it. No production change is expected unless `deepMerge` mishandles the array.

- [ ] **Step 1: Write the failing/regression tests**

Add to `packages/client/src/project/reconcile.test.ts` (it already imports `reconcileWithDefaults`, `freshProject`, `freshTrack`):

```ts
describe('synth2 matrix reconcile (I3a)', () => {
  it('heals a synth2 slice missing matrix to 8 default slots', () => {
    const p = freshProject();
    const synth2 = p.tracks[0].engines.synth2 as unknown as Record<string, unknown>;
    delete synth2.matrix;
    const healed = reconcileWithDefaults(p);
    const m = healed.tracks[0].engines.synth2.matrix;
    expect(m).toHaveLength(8);
    expect(m[0]).toEqual({ source: 'none', dest: 'none', amount: 0 });
  });

  it('preserves an existing matrix route through reconcile', () => {
    const p = freshProject();
    p.tracks[0].engines.synth2.matrix[2] = { source: 'env1', dest: 'filter.cutoff', amount: 0.7 };
    const healed = reconcileWithDefaults(p);
    expect(healed.tracks[0].engines.synth2.matrix[2]).toEqual({ source: 'env1', dest: 'filter.cutoff', amount: 0.7 });
  });

  it('fresh track carries the default 8-slot matrix', () => {
    expect(freshTrack().engines.synth2.matrix).toHaveLength(8);
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npm test --workspace @fiddle/client -- reconcile`
Expected: the fresh-track test PASSES already (Task 1 added the default to `buildDefaults`, which the factory spreads). The heal test should PASS if `deepMerge` deep-clones absent keys from the default. **If the "preserves an existing matrix route" test fails** (deepMerge merges arrays element-wise and corrupts the route, or shares references), inspect `packages/client/src/utils/deepMerge.ts`: arrays should be **replaced wholesale by the override when present, deep-cloned from the default when absent**. Fix only if a test is red — do not refactor deepMerge otherwise.

- [ ] **Step 3: Make any required fix green**

If `deepMerge` needed an array-handling fix, apply the minimal change and re-run until all three tests pass. Otherwise this is a test-only task.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/project/reconcile.test.ts
# include packages/client/src/utils/deepMerge.ts ONLY if you changed it
git commit -m "test(client): synth2 matrix survives reconcile + fresh-track heal (I3a)"
```

---

## Task 5: Kernel — extend the param block with the matrix region

**Files:**
- Modify: `packages/client/src/engine/synth2/kernel/params.ts`
- Test: `packages/client/src/engine/synth2/kernel/params.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/client/src/engine/synth2/kernel/params.test.ts` (import the new constants):

```ts
import { PARAM_COUNT, MATRIX_BASE, MATRIX_SLOTS, MATRIX_STRIDE, BLOCK_LENGTH, defaultParamBlock } from './params.js';

describe('matrix block region (I3a)', () => {
  it('appends an 8×3 matrix region after the descriptor params', () => {
    expect(MATRIX_SLOTS).toBe(8);
    expect(MATRIX_STRIDE).toBe(3);
    expect(MATRIX_BASE).toBe(PARAM_COUNT);
    expect(BLOCK_LENGTH).toBe(PARAM_COUNT + 24);
  });

  it('default block has the descriptor defaults then an all-zero matrix region', () => {
    const b = defaultParamBlock();
    expect(b.length).toBe(BLOCK_LENGTH);
    for (let i = MATRIX_BASE; i < BLOCK_LENGTH; i++) expect(b[i]).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --workspace @fiddle/client -- kernel/params`
Expected: FAIL — `MATRIX_BASE` etc. undefined.

- [ ] **Step 3: Implement**

Replace the body of `packages/client/src/engine/synth2/kernel/params.ts` below `PARAM_INDEX` with:

```ts
// I3 mod matrix rides the SAME param block, appended after the descriptor
// params (preserving the descriptor block's append-only ABI). 8 slots × 3
// floats: [sourceIndex, destEncoded, amount]. destEncoded = 0 means "none";
// otherwise it is PARAM_INDEX(destKey)+1, so the dest encoding is append-stable
// for the same reason the descriptor block is.
export const MATRIX_SLOTS = 8;
export const MATRIX_STRIDE = 3; // source, dest, amount
export const MATRIX_BASE = PARAM_COUNT;
export const BLOCK_LENGTH = PARAM_COUNT + MATRIX_SLOTS * MATRIX_STRIDE;

export function defaultParamBlock(): Float32Array {
  const block = new Float32Array(BLOCK_LENGTH);
  SYNTH2_DESCRIPTORS.forEach((d, i) => { block[i] = d.default; });
  // Matrix region stays all-zero: source=none(0), dest=none(0), amount=0.
  return block;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test --workspace @fiddle/client -- kernel/params`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/engine/synth2/kernel/params.ts packages/client/src/engine/synth2/kernel/params.test.ts
git commit -m "feat(client): extend synth2 param block with 8×3 matrix region (I3a)"
```

---

## Task 6: Kernel — `ModMatrix` accumulator

**Files:**
- Create: `packages/client/src/engine/synth2/kernel/ModMatrix.ts`
- Test: `packages/client/src/engine/synth2/kernel/ModMatrix.test.ts`

The matrix is the **only** writer of `ParamSlot.mod`. It clears every slot's `mod` then accumulates `source × amount` into each routed destination. No taper/scaling here — `ParamSlot.next()` already applies the descriptor's taper/modScale and clamps.

- [ ] **Step 1: Write the failing test**

Create `packages/client/src/engine/synth2/kernel/ModMatrix.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ModMatrix } from './ModMatrix.js';

// Minimal slot stub: only `.mod` matters to the matrix.
const slots = (n: number) => Array.from({ length: n }, () => ({ mod: 0 }));

describe('ModMatrix (I3a)', () => {
  it('clears all slot mods when no routes are active', () => {
    const s = slots(3); s[0].mod = 99;
    const m = new ModMatrix();
    m.apply(s as never, new Float32Array(8));
    expect(s[0].mod).toBe(0);
  });

  it('writes source × amount into the destination slot', () => {
    const s = slots(3);
    const m = new ModMatrix();
    m.setSlot(0, /*src*/ 3, /*destSlot*/ 1, /*amount*/ 0.5);
    const src = new Float32Array(8); src[3] = 0.8; // env1-ish
    m.apply(s as never, src);
    expect(s[1].mod).toBeCloseTo(0.4, 6);
    expect(s[0].mod).toBe(0);
  });

  it('sums multiple routes to one destination before the slot clamps', () => {
    const s = slots(3);
    const m = new ModMatrix();
    m.setSlot(0, 3, 1, 0.5);
    m.setSlot(1, 6, 1, -0.25);
    const src = new Float32Array(8); src[3] = 1; src[6] = 1;
    m.apply(s as never, src);
    expect(s[1].mod).toBeCloseTo(0.25, 6);
  });

  it('ignores dest = none (-1) and amount = 0', () => {
    const s = slots(3);
    const m = new ModMatrix();
    m.setSlot(0, 3, -1, 0.9);
    m.setSlot(1, 3, 2, 0);
    const src = new Float32Array(8); src[3] = 1;
    m.apply(s as never, src);
    expect(s[2].mod).toBe(0);
  });

  it('re-clears each apply (no accumulation across samples)', () => {
    const s = slots(2);
    const m = new ModMatrix();
    m.setSlot(0, 3, 0, 1);
    const src = new Float32Array(8); src[3] = 0.5;
    m.apply(s as never, src);
    m.apply(s as never, src);
    expect(s[0].mod).toBeCloseTo(0.5, 6); // not 1.0
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --workspace @fiddle/client -- ModMatrix`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `ModMatrix.ts`**

```ts
//
// Per-voice mod matrix (spec §5.6). The ONLY writer of ParamSlot.mod. Each
// sample: clear every slot's mod, then for each active route add
// source × amount into the destination slot's mod. Scaling/taper/clamp is the
// slot's job (ParamSlot.next), not ours — keep this a pure multiply-add so it
// stays WASM-shaped (kernel ABI §6.7: no allocation, no polymorphic calls).
//
// Fixed 8 slots. src[i] = MOD_SOURCES index (into the per-sample sources[]
// array). dest[i] = destination slot index, or -1 for 'none'. amt[i] bipolar.

import { MATRIX_SLOTS } from './params';

interface ModTarget { mod: number }

export class ModMatrix {
  private readonly src = new Int32Array(MATRIX_SLOTS);
  private readonly dest = new Int32Array(MATRIX_SLOTS).fill(-1);
  private readonly amt = new Float32Array(MATRIX_SLOTS);

  /** Configure route `i` (block-boundary). destSlot < 0 ⇒ inactive (none). */
  setSlot(i: number, srcIndex: number, destSlot: number, amount: number): void {
    this.src[i] = srcIndex;
    this.dest[i] = destSlot;
    this.amt[i] = amount;
  }

  /** Clear, then accumulate into the destination slots. Called once per sample. */
  apply(slots: ModTarget[], sources: Float32Array): void {
    for (let i = 0; i < slots.length; i++) slots[i].mod = 0;
    for (let s = 0; s < MATRIX_SLOTS; s++) {
      const d = this.dest[s];
      if (d < 0) continue;
      const a = this.amt[s];
      if (a === 0) continue;
      slots[d].mod += sources[this.src[s]] * a;
    }
  }
}
```

Note: `new Int32Array(MATRIX_SLOTS).fill(-1)` — `.fill` returns the array, so the field initializes to all `-1` (every route inactive until configured).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test --workspace @fiddle/client -- ModMatrix`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/engine/synth2/kernel/ModMatrix.ts packages/client/src/engine/synth2/kernel/ModMatrix.test.ts
git commit -m "feat(client): synth2 ModMatrix accumulator (clear + source×amount → dest.mod) (I3a)"
```

---

## Task 7: Kernel — wire the matrix into the Voice (previous-sample sources)

**Files:**
- Modify: `packages/client/src/engine/synth2/kernel/Voice.ts`
- Test: `packages/client/src/engine/synth2/kernel/Voice.test.ts`

The Voice evaluates the matrix once per sample at the **top** of the render loop, using the **previous sample's** source values (envelopes/noise are unipolar-or-bipolar audio-rate signals; a one-sample modulation delay removes all modulator/modulee ordering hazards and is inaudible). Velocity is constant per note so it has no delay artifact — making `velocity → dest` the cleanest deterministic test.

- [ ] **Step 1: Write the failing test**

Add to `packages/client/src/engine/synth2/kernel/Voice.test.ts`:

```ts
import { MOD_SOURCES } from '@fiddle/shared';
import { PARAM_INDEX } from './params.js';

describe('Voice mod matrix (I3a)', () => {
  const SR = 48000;

  it('routes velocity → osc1.level (audible gain change)', () => {
    const levelIdx = PARAM_INDEX['osc1.level']; // descriptor index == slot index
    const velSrc = MOD_SOURCES.indexOf('velocity');

    const render = (withRoute: boolean) => {
      const v = new Voice(SR, 1);
      if (withRoute) v.setMatrixSlot(0, velSrc, levelIdx, 1); // +full-range level mod
      v.noteOn(220, 1.0, SR); // full velocity, 1s gate
      const out = new Float32Array(2048);
      v.renderAdd(out, 0, 2048);
      let rms = 0; for (const x of out) rms += x * x;
      return Math.sqrt(rms / out.length);
    };

    // With velocity=1 routed to level at amount=1, the level slot's base (0.8)
    // is pushed up (clamped at 1.0): louder than the unrouted render.
    expect(render(true)).toBeGreaterThan(render(false));
  });

  it('a none/zero matrix leaves output identical to no matrix', () => {
    const v1 = new Voice(SR, 1); v1.noteOn(220, 1, SR);
    const v2 = new Voice(SR, 1);
    for (let s = 0; s < 8; s++) v2.setMatrixSlot(s, 0, -1, 0); // explicit inert
    v2.noteOn(220, 1, SR);
    const a = new Float32Array(1024); const b = new Float32Array(1024);
    v1.renderAdd(a, 0, 1024); v2.renderAdd(b, 0, 1024);
    for (let i = 0; i < a.length; i++) expect(b[i]).toBeCloseTo(a[i], 6);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --workspace @fiddle/client -- kernel/Voice`
Expected: FAIL — `setMatrixSlot` undefined.

- [ ] **Step 3: Implement the Voice changes**

In `packages/client/src/engine/synth2/kernel/Voice.ts`:

Add imports at the top (alongside the existing `SYNTH2_DESCRIPTORS` import):

```ts
import { SYNTH2_DESCRIPTORS, MOD_SOURCES } from '@fiddle/shared';
import { ModMatrix } from './ModMatrix';
```

Add module-level source-index constants (after `KEYTRACK_REF_HZ`):

```ts
// Source slots the I3a voice actually produces (others read 0 until I3b/I3c).
const SRC_ENV1 = MOD_SOURCES.indexOf('env1');
const SRC_ENV2 = MOD_SOURCES.indexOf('env2');
const SRC_VELOCITY = MOD_SOURCES.indexOf('velocity');
const SRC_NOISE = MOD_SOURCES.indexOf('noise');
```

Add fields (near `keyTrackOctaves`):

```ts
  private readonly matrix = new ModMatrix();
  private readonly sources = new Float32Array(MOD_SOURCES.length);
  private env1Prev = 0;
  private env2Prev = 0;
  private noisePrev = 0;
```

Add the configuration method (next to `setFilterType`):

```ts
  /** Block-boundary matrix route config. destSlot < 0 ⇒ none (spec §5.6). */
  setMatrixSlot(i: number, srcIndex: number, destSlot: number, amount: number): void {
    this.matrix.setSlot(i, srcIndex, destSlot, amount);
  }
```

In `noteOn`, reset the previous-sample source memory (so a stolen voice doesn't carry the prior note's tail into the matrix for one sample):

```ts
    this.env1Prev = 0; this.env2Prev = 0; this.noisePrev = 0;
```

In `renderAdd`, at the **very top of the per-sample loop** (before `const e = this.env1.next();`), fill the sources from the previous sample and run the matrix:

```ts
      // Mod matrix (spec §5.6): previous-sample source values → dest slot.mod,
      // BEFORE any slot.next() consumes its mod this sample. lfo1/lfo2/env3
      // sources stay 0 until I3b/I3c. velocity is constant (no delay artifact).
      this.sources[SRC_ENV1] = this.env1Prev;
      this.sources[SRC_ENV2] = this.env2Prev;
      this.sources[SRC_VELOCITY] = this.velocity;
      this.sources[SRC_NOISE] = this.noisePrev;
      this.matrix.apply(this.slots, this.sources);
```

At the **end of the per-sample loop** (after `out[n] += filtered * e * this.velocity;`), capture this sample's source values for the next iteration. `e` and `env2v` are already computed; the noise sample currently lives in the local `nz` — keep that name and store it:

```ts
      this.env1Prev = e;
      this.env2Prev = env2v;
      this.noisePrev = nz;
```

(`nz` is the existing `const nz = this.noise.next(this.noiseColor.next());` — it is in scope at loop end.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test --workspace @fiddle/client -- kernel/Voice`
Expected: PASS. Run the full kernel suite too (`npm test --workspace @fiddle/client -- kernel`) — the existing osc/sync/filter Voice tests must stay green (the matrix is inert by default).

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/engine/synth2/kernel/Voice.ts packages/client/src/engine/synth2/kernel/Voice.test.ts
git commit -m "feat(client): wire ModMatrix into synth2 Voice (previous-sample sources) (I3a)"
```

---

## Task 8: Kernel — decode the matrix region and configure voices

**Files:**
- Modify: `packages/client/src/engine/synth2/kernel/Synth2Kernel.ts`
- Test: `packages/client/src/engine/synth2/kernel/Synth2Kernel.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/client/src/engine/synth2/kernel/Synth2Kernel.test.ts` (import `defaultParamBlock, PARAM_INDEX, MATRIX_BASE, MATRIX_STRIDE`):

```ts
it('applyParams routes a matrix slot from the block (velocity → osc1.level) (I3a)', () => {
  const SR = 48000;
  const kernel = new Synth2Kernel(SR);

  const render = (route: boolean) => {
    const block = defaultParamBlock();
    if (route) {
      const base = MATRIX_BASE + 0 * MATRIX_STRIDE;
      block[base] = MOD_SOURCES.indexOf('velocity');   // source
      block[base + 1] = PARAM_INDEX['osc1.level'] + 1; // dest encoded (+1)
      block[base + 2] = 1;                             // amount
    }
    const k = new Synth2Kernel(SR);
    k.applyParams(block);
    k.noteOn(0, 220, 1.0, 1.0, true);
    const out = new Float32Array(2048);
    k.process(out, 2048, 0);
    let rms = 0; for (const x of out) rms += x * x;
    return Math.sqrt(rms / out.length);
  };

  expect(render(true)).toBeGreaterThan(render(false));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --workspace @fiddle/client -- kernel/Synth2Kernel`
Expected: FAIL — the matrix region of the block is ignored, so both renders match.

- [ ] **Step 3: Implement the decode**

In `packages/client/src/engine/synth2/kernel/Synth2Kernel.ts`:

Extend the imports from `./params`:

```ts
import { PARAM_COUNT, PARAM_INDEX, MATRIX_BASE, MATRIX_SLOTS, MATRIX_STRIDE, defaultParamBlock } from './params';
```

Rework `applyParams` so it (a) copies the **whole** block (now longer than `PARAM_COUNT`), (b) bounds the slot-base loop to `PARAM_COUNT` (each voice has exactly `PARAM_COUNT` slots), and (c) decodes the matrix region:

```ts
  applyParams(block: Float32Array): void {
    const n = Math.min(block.length, this.block.length);
    for (let i = 0; i < n; i++) this.block[i] = block[i];
    const slotN = Math.min(n, PARAM_COUNT);
    for (const voice of this.voices) {
      for (let i = 0; i < slotN; i++) voice.slots[i].setBase(this.block[i]);
    }
    // Discrete (bool/enum) params: block-boundary, no smoother.
    const osc2Sync = this.block[PARAM_INDEX['osc2.sync']] >= 0.5;
    const osc3Sync = this.block[PARAM_INDEX['osc3.sync']] >= 0.5;
    const filterType = Math.round(this.block[PARAM_INDEX['filter.type']]);
    for (const voice of this.voices) {
      voice.setSync(osc2Sync, osc3Sync);
      voice.setFilterType(filterType);
    }
    // Mod matrix region (spec §5.6): [sourceIdx, destEncoded, amount] per slot.
    // destEncoded 0 = none; else it is PARAM_INDEX(key)+1 ⇒ slot index = enc-1.
    for (let s = 0; s < MATRIX_SLOTS; s++) {
      const base = MATRIX_BASE + s * MATRIX_STRIDE;
      const srcIdx = Math.round(this.block[base]);
      const destEnc = Math.round(this.block[base + 1]);
      const destSlot = destEnc <= 0 ? -1 : destEnc - 1;
      const amount = this.block[base + 2];
      for (const voice of this.voices) voice.setMatrixSlot(s, srcIdx, destSlot, amount);
    }
  }
```

- [ ] **Step 4: Verify the worklet entry forwards the full block**

Open `packages/client/src/engine/synth2/worklet-entry.ts`; confirm the `'params'` message handler calls `kernel.applyParams(msg.block)` (or equivalent) with the full Float32Array and does not truncate to `PARAM_COUNT`. No change expected — just confirm. If it copies into a fixed-length buffer, widen it to `BLOCK_LENGTH`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test --workspace @fiddle/client -- kernel/Synth2Kernel`
Expected: PASS. Run `npm test --workspace @fiddle/client -- kernel` — all kernel tests green.

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/engine/synth2/kernel/Synth2Kernel.ts packages/client/src/engine/synth2/kernel/Synth2Kernel.test.ts
git commit -m "feat(client): Synth2Kernel decodes matrix region + configures voices (I3a)"
```

---

## Task 9: Engine — encode `params.matrix` into the block

**Files:**
- Modify: `packages/client/src/engine/Synth2Engine.ts`
- Test: `packages/client/src/engine/Synth2Engine.test.ts`

- [ ] **Step 1: Write the failing test**

The file already has `mockCtx()`, `lastNode(engine)` (→ `MockWorkletNode` with `.port.posted`), and imports `PARAM_INDEX` from `./synth2/kernel/params`. Add `MATRIX_BASE` to that import and `MOD_SOURCES` to the `@fiddle/shared` import, then add:

```ts
it('encodes a matrix route into the block (source idx, dest+1, amount) (I3a)', () => {
  const engine = new Synth2Engine(mockCtx());
  engine.applyParams({
    matrix: [
      { source: 'env1', dest: 'filter.cutoff', amount: 0.5 },
      ...Array.from({ length: 7 }, () => ({ source: 'none', dest: 'none', amount: 0 })),
    ],
  });
  const msg = lastNode(engine).port.posted.at(-1);
  expect(msg.type).toBe('params');
  expect(msg.block[MATRIX_BASE]).toBe(MOD_SOURCES.indexOf('env1'));     // slot 0 source
  expect(msg.block[MATRIX_BASE + 1]).toBe(PARAM_INDEX['filter.cutoff'] + 1); // dest encoded (+1)
  expect(msg.block[MATRIX_BASE + 2]).toBeCloseTo(0.5, 6);              // amount
});

it('encodes dest = none as 0 (I3a)', () => {
  const engine = new Synth2Engine(mockCtx());
  engine.applyParams({ matrix: [{ source: 'lfo1', dest: 'none', amount: 0.9 },
    ...Array.from({ length: 7 }, () => ({ source: 'none', dest: 'none', amount: 0 }))] });
  const msg = lastNode(engine).port.posted.at(-1);
  expect(msg.block[MATRIX_BASE + 1]).toBe(0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --workspace @fiddle/client -- Synth2Engine`
Expected: FAIL — matrix is currently skipped (no `params` message posted, or the region stays 0).

- [ ] **Step 3: Implement the encode**

In `packages/client/src/engine/Synth2Engine.ts`:

Extend the shared import to include `MOD_SOURCES`, and the kernel-params import to include the matrix constants:

```ts
import { DEFAULT_SYNTH2_PARAMS, encodeBool, encodeEnum, SYNTH2_ENUM_VALUES, MOD_SOURCES, type Synth2EngineParams } from '@fiddle/shared';
import { PARAM_INDEX, MATRIX_BASE, MATRIX_SLOTS, MATRIX_STRIDE, defaultParamBlock } from './synth2/kernel/params';
```

In `applyParams`, handle the matrix before/within the entries loop. Add this block at the start of `applyParams` (before the `for (const [mod, fields] ...)` loop), then add `if (mod === 'matrix') continue;` as the first line inside that loop:

```ts
    // Matrix is an array of routes (not a nested module object): encode each
    // slot into the block's matrix region. source → MOD_SOURCES index; dest →
    // PARAM_INDEX(key)+1 (0 = none, append-stable); amount → float32.
    const matrix = (params as { matrix?: unknown }).matrix;
    if (Array.isArray(matrix)) {
      for (let s = 0; s < MATRIX_SLOTS; s++) {
        const slot = matrix[s] as { source?: string; dest?: string; amount?: number } | undefined;
        if (!slot) continue;
        const base = MATRIX_BASE + s * MATRIX_STRIDE;
        const srcIdx = Math.max(0, MOD_SOURCES.indexOf((slot.source ?? 'none') as never));
        const destKey = slot.dest ?? 'none';
        const destEnc = destKey === 'none' || PARAM_INDEX[destKey] === undefined ? 0 : PARAM_INDEX[destKey] + 1;
        const amt = Math.fround(typeof slot.amount === 'number' ? slot.amount : 0);
        if (this.block[base] !== srcIdx) { this.block[base] = srcIdx; changed = true; }
        if (this.block[base + 1] !== destEnc) { this.block[base + 1] = destEnc; changed = true; }
        if (this.block[base + 2] !== amt) { this.block[base + 2] = amt; changed = true; }
      }
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test --workspace @fiddle/client -- Synth2Engine`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/engine/Synth2Engine.ts packages/client/src/engine/Synth2Engine.test.ts
git commit -m "feat(client): Synth2Engine encodes matrix routes into the block region (I3a)"
```

---

## Task 10: Sync — array guard + dedicated matrix watcher

**Files:**
- Modify: `packages/client/src/composables/useSynth.ts`
- Test: `packages/client/src/composables/useSynth.test.ts` (the existing synth2 sync tests live here — see the `osc.sync`/`filter.type` cases at ~line 339, which use the `bootWithFakeSocket()` → `{ fake, synth }` harness and assert against `fake.sent`).

The synth2 engine-slice watcher diffs the whole slice; `matrix` (an array of objects) lands in `changed`, but `emitLeafDiff` only drills one level and would emit a forbidden whole-slot write. Fix: make `emitLeafDiff` skip arrays, and add a dedicated matrix watcher that drills `matrix[s].<field>` (mirroring the steps watcher). `source`/`dest` are discrete enum flips (flush immediately); `amount` rides the 50 ms throttle.

- [ ] **Step 1: Write the failing tests**

Add next to the existing synth2 sync tests in `packages/client/src/composables/useSynth.test.ts` (same `bootWithFakeSocket()` harness; `vi` is already imported):

```ts
it('emits a synth2 matrix source change immediately (discrete leaf) (I3a)', async () => {
  const { fake, synth } = await bootWithFakeSocket();
  synth.project.tracks[0].engines.synth2.matrix[1].source = 'env2';
  // No timer advance: 'source' is in DISCRETE_LEAF_FIELDS → flushes immediately.
  const op = fake.sent.find(
    (o) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'engines', 'synth2', 'matrix', 1, 'source']),
  );
  expect(op).toBeDefined();
  expect(op.value).toBe('env2');
});

it('emits a synth2 matrix amount (throttled) and never a whole-slot write (I3a)', async () => {
  const { fake, synth } = await bootWithFakeSocket();
  synth.project.tracks[0].engines.synth2.matrix[0].amount = 0.3;
  // Throttled: not flushed until the 50ms timer.
  const path0 = JSON.stringify(['tracks', 0, 'engines', 'synth2', 'matrix', 0, 'amount']);
  expect(fake.sent.find((o) => JSON.stringify(o.path) === path0)).toBeUndefined();
  vi.advanceTimersByTime(50);
  const op = fake.sent.find((o) => JSON.stringify(o.path) === path0);
  expect(op?.value).toBeCloseTo(0.3);
  // The array guard prevents a forbidden whole-slot object write.
  for (const o of fake.sent) {
    expect(o.path).not.toEqual(['tracks', 0, 'engines', 'synth2', 'matrix', 0]);
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test --workspace @fiddle/client -- useSynth`
Expected: FAIL — the matrix change either emits nothing (no dedicated watcher) or emits a whole-slot write via the engine-slice watcher.

- [ ] **Step 3: Add the array guard to `emitLeafDiff`**

In `packages/client/src/composables/useSynth.ts`, inside `emitLeafDiff`'s loop, skip arrays (they are handled by dedicated watchers — only the matrix is an array in any synced slice):

```ts
  for (const [key, value] of Object.entries(changed)) {
    if (Array.isArray(value)) continue; // arrays (synth2.matrix) → dedicated watcher
    if (value !== null && typeof value === 'object') {
```

- [ ] **Step 4: Add `source`/`dest` to `DISCRETE_LEAF_FIELDS`**

```ts
const DISCRETE_LEAF_FIELDS = new Set<string>([
  'engineType', 'muted', 'soloed', 'note', 'octave', 'isChord', 'chordType', 'patternLength', 'enabled',
  'sync',
  'type',
  'source', // synth2 matrix route source enum — discrete selector flip
  'dest',   // synth2 matrix route dest enum — discrete selector flip
]);
```

(`amount` is continuous — intentionally omitted so it rides the 50 ms throttle.)

- [ ] **Step 5: Add the dedicated matrix watcher**

In the per-track `for (let i = 0; i < TRACK_POOL_SIZE; i++)` loop, alongside the steps watcher, add:

```ts
      watch(
        () => snapshot(project.tracks[i].engines.synth2.matrix),
        (newM, oldM) => {
          if (!outbox || !syncReady || isApplyingFromNetwork() || !oldM) return;
          for (let s = 0; s < newM.length; s++) {
            for (const field of ['source', 'dest', 'amount'] as const) {
              const a = (newM[s] as Record<string, unknown>)[field];
              const b = (oldM[s] as Record<string, unknown>)[field];
              if (a === b) continue;
              outbox.enqueue(['tracks', i, 'engines', 'synth2', 'matrix', s, field], a, b, gestureEndForLeaf(field));
            }
          }
        },
        { flush: 'sync' },
      );
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test --workspace @fiddle/client -- useSynth`
Expected: PASS. Confirm the existing engine-slice/mixer/step sync tests stay green (the array guard must not affect non-array slices).

- [ ] **Step 7: Commit**

```bash
git add packages/client/src/composables/useSynth.ts packages/client/src/composables/useSynth.test.ts
git commit -m "feat(client): sync synth2 matrix routes (array guard + dedicated watcher) (I3a)"
```

---

## Task 11: UI — MATRIX column in Synth2Panel

**Files:**
- Modify: `packages/client/src/components/Synth2Panel.vue`
- Test: `packages/client/src/components/Synth2Panel.test.ts` (existing; uses a `mountPanel(params)` helper that returns the host `HTMLElement` and asserts against the DOM — see the mode-toggle and filter-section blocks).

- [ ] **Step 1: Write the failing test**

Add a new `describe` block to `packages/client/src/components/Synth2Panel.test.ts` (reuse the file's `mountPanel`):

```ts
describe('Synth2Panel mod matrix (I3a)', () => {
  it('renders 8 matrix rows', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    expect(el.querySelectorAll('.matrix-row').length).toBe(8);
  });

  it('updates a route source via the select', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    const sel = el.querySelector<HTMLSelectElement>('.matrix-row .matrix-source')!;
    sel.value = 'env1';
    sel.dispatchEvent(new Event('change')); // v-model on <select> listens to 'change'
    expect(params.matrix[0].source).toBe('env1');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --workspace @fiddle/client -- Synth2Panel`
Expected: FAIL — no `.matrix-row` elements.

- [ ] **Step 3: Implement the MATRIX column**

In `packages/client/src/components/Synth2Panel.vue`, add a new column **before** the Visualizer column (so the visualizer stays last). Use the descriptor-derived enums for the option lists. Add to `<script setup>`:

```ts
import { MOD_SOURCES, MOD_DESTS } from '@fiddle/shared';
```

Add the column in the template (after the FILTER ENV column, before the Visualizer column):

```html
    <!-- Column 7: Mod matrix -->
    <div class="rack-column">
      <div class="module-group">
        <h3>MATRIX</h3>
        <div class="matrix-grid">
          <div v-for="(slot, s) in params.matrix" :key="s" class="matrix-row">
            <select class="matrix-source" v-model="slot.source">
              <option v-for="src in MOD_SOURCES" :key="src" :value="src">{{ src }}</option>
            </select>
            <select class="matrix-dest" v-model="slot.dest">
              <option v-for="dst in MOD_DESTS" :key="dst" :value="dst">{{ dst }}</option>
            </select>
            <Knob
              label="" :min="-1" :max="1" :step="0.01" :defaultValue="0"
              v-model="slot.amount"
              :syncPath="ks.pathFor(['matrix', s, 'amount'])"
              @gesture-end="ks.end(['matrix', s, 'amount'])"
            />
          </div>
        </div>
      </div>
    </div>
```

(The Visualizer column comment bumps to Column 8.) Add minimal styles in the `<style scoped>` block:

```css
.matrix-grid { display: flex; flex-direction: column; gap: 4px; }
.matrix-row { display: flex; align-items: center; gap: 4px; }
.matrix-row select {
  flex: 1; min-width: 0; background: #181818; color: #aaa;
  border: 1px solid #2a2a2a; border-radius: 4px; padding: 3px 4px;
  font-family: monospace; font-size: 0.65rem;
}
```

Note: `v-model="slot.source"` mutates `params.matrix[s].source` in place — the dedicated matrix watcher (Task 10) sees the deep change and syncs it. `source`/`dest` are `<select>`s (discrete, flush immediately); `amount` is a `Knob` wired through `ks.pathFor` for the remote-activity ring + gesture-end, exactly like every other knob.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test --workspace @fiddle/client -- Synth2Panel`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/components/Synth2Panel.vue packages/client/src/components/Synth2Panel.test.ts
git commit -m "feat(client): Synth2Panel MATRIX column (8 source/dest/amount rows) (I3a)"
```

---

## Verification (end-to-end, before merge)

- [ ] **Full gate (must be green):**

```bash
npm run typecheck && npm test && npm run build
```

Across all three workspaces. The build must still emit `packages/client/public/worklets/synth2-processor.js` (confirm the file is rebuilt and non-trivial in size). The descriptor table must be **unchanged** (no new rows) — `git diff main -- packages/shared/src/engines/synth2-descriptors.ts` should show only the appended `MOD_SOURCES`/`MOD_DESTS` exports, never a reordered/inserted descriptor.

- [ ] **Zero-allocation spot check:** the matrix hot path (`ModMatrix.apply`, the Voice per-sample source fill) allocates nothing — `sources` and the matrix arrays are preallocated; `apply` is a plain loop. Eyeball the Voice loop and `ModMatrix.apply` for any `new`/array-literal/closure. (Soak test is I4.)

- [ ] **Browser (Playwright MCP, then close the session — AGENTS.md cleanup rule):**
  1. `npm run dev`; **create a FRESH session** (old sessions won't carry `matrix` — the deferred server-heal gap); add a synth2 track; open the Synth2 panel.
  2. Confirm the MATRIX column shows 8 rows (source/dest selects + amount knob).
  3. Route **env1 → filter.cutoff**, amount ≈ +0.7. Play a note: the filter should open over the amp envelope's contour (a clear "filter follows the env" sweep) on top of the existing hardwired env2→cutoff.
  4. Route **velocity → osc1.level** (or `filter.cutoff`), amount +1: low-velocity steps should be quieter/darker than high-velocity steps.
  5. Route **noise → filter.cutoff**, small amount: audible "fizz"/cutoff jitter — confirms the noise source feeds the matrix per-sample.
  6. Set a route's dest back to **none**: modulation stops (inert).
  7. **Two-client check** (reuse the synth2 sync harness): set a matrix route in client A; confirm client B converges (the route appears in B's panel and is audible) — verifies Task 10.
  8. **Close the browser/session.**

- [ ] Keep the branch after verify — the user browser-verifies before merge (do **not** auto-merge).

## Branch & roadmap

- **Branch:** `feat/synth2-i3a-mod-matrix` (off `main`, not on `main`).
- **Next slices (separate plans/branches):** I3b LFOs (fill the `lfo1`/`lfo2` sources — they become audible immediately via this matrix), I3c env3 + loop mode (fill the `env3` source + `loop` on all envelopes), I3d morph filter (`filter.model` enum + `filter.morph` + `MorphFilter` behind the existing seam — the matrix can then sweep `morph`).
- **Known deferred (not this slice):** old sessions saved before `matrix` existed won't sync it until the server-side deep-heal lands (memory `synth2-old-session-sync-gap`). New sessions are unaffected.
