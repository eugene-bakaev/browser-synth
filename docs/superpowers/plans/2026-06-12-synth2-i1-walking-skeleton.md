# Synth2 I1 — Walking Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A sixth engine type `synth2` working end-to-end — 1 morphing oscillator + amp ADSR rendered by a TypeScript DSP kernel inside an AudioWorklet, fully wired through shared schema/accept-list/sync, with a minimal panel.

**Architecture:** Iteration 1 of `docs/superpowers/specs/2026-06-12-worklet-synth-engine-design.md` (read §5–§8 before starting). A descriptor table in `@fiddle/shared` is the single source for params (schema, accept-list, defaults, kernel param-block layout). The kernel (`packages/client/src/engine/synth2/kernel/`) is pure TS — no Web Audio types, Node-testable — wrapped by a thin worklet entry, pre-bundled to `public/worklets/` with esbuild (mirrors the server's D12 esbuild precedent). `Synth2Engine` implements the existing `SoundEngine` contract and talks to the worklet only via `MessagePort`.

**Tech Stack:** TypeScript, Zod, Vitest, Vue 3 (panel), esbuild (worklet bundle), Web Audio AudioWorklet.

**Branch:** `git checkout spec/worklet-synth-engine && git checkout -b feat/synth2-i1-walking-skeleton` (the spec branch holds the spec; if it has been merged to main by execution time, branch off `main` instead).

**⚠️ Red-typecheck window:** Task 4 adds `'synth2'` to the `EngineType` union, which makes the client's `engineFactories: Record<EngineType, …>` (useSynth.ts) fail repo-wide `npm run typecheck` until Task 12 wires the factory. Per-task verification commands are package-scoped on purpose; the full gate runs in Task 14. Do not "fix" the factory early with a stub.

**Spec amendment (approved deviation):** kernel files may import from `@fiddle/shared` (the descriptor table is pure data and Node-safe); the §6.7 "kernel imports only from kernel/" rule means *no client/, DOM, or Web Audio imports*.

---

### Task 1: Descriptor table (`@fiddle/shared`)

**Files:**
- Create: `packages/shared/src/engines/synth2-descriptors.ts`
- Create: `packages/shared/src/engines/synth2-descriptors.test.ts`
- Modify: `packages/shared/src/engines/index.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/engines/synth2-descriptors.test.ts
import { describe, it, expect } from 'vitest';
import { SYNTH2_DESCRIPTORS } from './synth2-descriptors.js';

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

  it('covers exactly the I1 param set (append-only from here)', () => {
    expect(SYNTH2_DESCRIPTORS.map(d => d.key)).toEqual([
      'osc1.morph', 'osc1.pulseWidth', 'osc1.coarse', 'osc1.fine', 'osc1.level',
      'env1.a', 'env1.d', 'env1.s', 'env1.r',
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/engines/synth2-descriptors.test.ts -w @fiddle/shared` — if `-w` doesn't pass through to vitest, run from the package dir: `cd packages/shared && npx vitest run src/engines/synth2-descriptors.test.ts`
Expected: FAIL — cannot resolve `./synth2-descriptors.js`

- [ ] **Step 3: Write the implementation**

```ts
// packages/shared/src/engines/synth2-descriptors.ts
//
// THE single source of truth for synth2 parameters (spec §6.4). Everything
// else derives from this table: the Zod schema + leaf validators (schema.ts),
// the accept-list patterns (accept-list.ts), DEFAULT_SYNTH2_PARAMS (synth2.ts),
// the kernel's Float32Array param-block layout (client kernel/params.ts), and
// panel knob ranges. Contract tests in each consumer assert the derivation.
//
// APPEND-ONLY once I1 merges: the param block index is the array position, so
// inserting/reordering would silently scramble every older client's params.

export type Synth2Taper = 'linear' | 'expOctaves';

export interface Synth2ParamDescriptor {
  /** '<module>.<field>' — also the wire-path tail under engines.synth2 */
  key: string;
  min: number;
  max: number;
  default: number;
  /** How modulation is applied in the kernel (spec §6.3). Base values are linear. */
  taper: Synth2Taper;
  /** Whether the mod matrix (I3) may target this slot. */
  modulatable: boolean;
  /** At |amount|=1: linear → fraction of full range; expOctaves → octaves. */
  modScale: number;
}

export const SYNTH2_DESCRIPTORS: ReadonlyArray<Synth2ParamDescriptor> = [
  // osc1 — spec §5.2. morph: 0 sine → 1 triangle → 2 saw → 3 pulse.
  { key: 'osc1.morph',      min: 0,     max: 3,    default: 2,    taper: 'linear',     modulatable: true, modScale: 1 },
  { key: 'osc1.pulseWidth', min: 0.05,  max: 0.95, default: 0.5,  taper: 'linear',     modulatable: true, modScale: 1 },
  // coarse is semitones (spec §5.2 — wider than synth1's octaves), fine is cents.
  { key: 'osc1.coarse',     min: -36,   max: 36,   default: 0,    taper: 'linear',     modulatable: true, modScale: 24 / 72 },
  { key: 'osc1.fine',       min: -100,  max: 100,  default: 0,    taper: 'linear',     modulatable: true, modScale: 1 },
  { key: 'osc1.level',      min: 0,     max: 1,    default: 0.8,  taper: 'linear',     modulatable: true, modScale: 1 },
  // env1 (amp) — same a/d/s/r units as synth1 (seconds / 0..1 sustain).
  { key: 'env1.a',          min: 0.001, max: 10,   default: 0.01, taper: 'expOctaves', modulatable: true, modScale: 4 },
  { key: 'env1.d',          min: 0.001, max: 10,   default: 0.2,  taper: 'expOctaves', modulatable: true, modScale: 4 },
  { key: 'env1.s',          min: 0,     max: 1,    default: 0.5,  taper: 'linear',     modulatable: true, modScale: 1 },
  { key: 'env1.r',          min: 0.001, max: 10,   default: 0.5,  taper: 'expOctaves', modulatable: true, modScale: 4 },
];
```

Append to `packages/shared/src/engines/index.ts`:

```ts
export * from './synth2-descriptors.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/shared && npx vitest run src/engines/synth2-descriptors.test.ts`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/engines/synth2-descriptors.ts packages/shared/src/engines/synth2-descriptors.test.ts packages/shared/src/engines/index.ts
git commit -m "feat(shared): synth2 param descriptor table (I1 set: osc1 + env1)"
```

---

### Task 2: Params interface + defaults derived from descriptors

**Files:**
- Create: `packages/shared/src/engines/synth2.ts`
- Create: `packages/shared/src/engines/synth2.test.ts`
- Modify: `packages/shared/src/engines/index.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/engines/synth2.test.ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_SYNTH2_PARAMS } from './synth2.js';
import { SYNTH2_DESCRIPTORS } from './synth2-descriptors.js';

describe('DEFAULT_SYNTH2_PARAMS', () => {
  it('mirrors the descriptor table exactly (derivation contract)', () => {
    for (const d of SYNTH2_DESCRIPTORS) {
      const [mod, field] = d.key.split('.');
      const slice = (DEFAULT_SYNTH2_PARAMS as any)[mod];
      expect(slice, d.key).toBeDefined();
      expect(slice[field], d.key).toBe(d.default);
    }
    // No extra leaves beyond the table.
    const leafCount = Object.values(DEFAULT_SYNTH2_PARAMS)
      .reduce((n, m) => n + Object.keys(m).length, 0);
    expect(leafCount).toBe(SYNTH2_DESCRIPTORS.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && npx vitest run src/engines/synth2.test.ts`
Expected: FAIL — cannot resolve `./synth2.js`

- [ ] **Step 3: Write the implementation**

```ts
// packages/shared/src/engines/synth2.ts
//
// Synth2 param shape + defaults. Unlike synth1, the defaults are GENERATED
// from the descriptor table (spec §6.4) — the interface exists so TypeScript
// consumers get real field names, and the test asserts interface ↔ table
// agreement. Params are uniformly nested per module: descriptor key
// 'osc1.morph' ⇒ params.osc1.morph (spec §7).

import { SYNTH2_DESCRIPTORS } from './synth2-descriptors.js';

export interface Synth2OscParams {
  morph: number;       // 0 sine → 1 tri → 2 saw → 3 pulse (continuous)
  pulseWidth: number;
  coarse: number;      // semitones
  fine: number;        // cents
  level: number;
}

export interface Synth2EnvParams {
  a: number;
  d: number;
  s: number;
  r: number;
}

export interface Synth2EngineParams {
  osc1: Synth2OscParams;
  env1: Synth2EnvParams;
}

function buildDefaults(): Synth2EngineParams {
  const out: Record<string, Record<string, number>> = {};
  for (const d of SYNTH2_DESCRIPTORS) {
    const [mod, field] = d.key.split('.');
    (out[mod] ??= {})[field] = d.default;
  }
  return out as unknown as Synth2EngineParams;
}

export const DEFAULT_SYNTH2_PARAMS: Synth2EngineParams = buildDefaults();
```

Append to `packages/shared/src/engines/index.ts`:

```ts
export * from './synth2.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/shared && npx vitest run src/engines/synth2.test.ts`
Expected: 1 passed

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/engines/synth2.ts packages/shared/src/engines/synth2.test.ts packages/shared/src/engines/index.ts
git commit -m "feat(shared): Synth2EngineParams + defaults generated from descriptors"
```

---

### Task 3: Generated Zod schema + leaf validators

**Files:**
- Modify: `packages/shared/src/project/schema.ts`
- Modify: `packages/shared/src/project/schema.test.ts`

- [ ] **Step 1: Write the failing test** (append to `schema.test.ts`)

```ts
import { SYNTH2_DESCRIPTORS, DEFAULT_SYNTH2_PARAMS } from '../engines/index.js';
import { SYNTH2_LEAF_SCHEMAS } from './schema.js';
// NOTE: `Schemas` is already imported at the top of this file; reuse it.

describe('synth2 schema (generated from descriptors)', () => {
  it('accepts the defaults', () => {
    expect(Schemas.Synth2Params.safeParse(DEFAULT_SYNTH2_PARAMS).success).toBe(true);
  });

  it('rejects out-of-range and missing leaves', () => {
    const bad = structuredClone(DEFAULT_SYNTH2_PARAMS);
    bad.osc1.morph = 99;
    expect(Schemas.Synth2Params.safeParse(bad).success).toBe(false);
    const missing = structuredClone(DEFAULT_SYNTH2_PARAMS) as any;
    delete missing.env1.r;
    expect(Schemas.Synth2Params.safeParse(missing).success).toBe(false);
  });

  it('has one leaf validator per descriptor, enforcing the descriptor range', () => {
    for (const d of SYNTH2_DESCRIPTORS) {
      const leaf = SYNTH2_LEAF_SCHEMAS[d.key];
      expect(leaf, d.key).toBeDefined();
      expect(leaf.safeParse(d.min).success, d.key).toBe(true);
      expect(leaf.safeParse(d.max).success, d.key).toBe(true);
      expect(leaf.safeParse(d.min - 1e-6).success, d.key).toBe(false);
      expect(leaf.safeParse(d.max + 1e-6).success, d.key).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/shared && npx vitest run src/project/schema.test.ts`
Expected: FAIL — `SYNTH2_LEAF_SCHEMAS` not exported / `Schemas.Synth2Params` undefined

- [ ] **Step 3: Implement in `schema.ts`**

Add to the imports at the top:

```ts
import { SYNTH2_DESCRIPTORS } from '../engines/synth2-descriptors.js';
```

Add after `ClapParamsSchema` (the "Engine params" section):

```ts
// --- synth2: GENERATED from the descriptor table (spec §6.4) ---------------
// One z.number().min().max() per descriptor, grouped into nested module
// objects ('osc1.morph' ⇒ { osc1: { morph } }). schema.test.ts asserts the
// derivation, so the table cannot drift from the wire validation.

const synth2LeafEntries = SYNTH2_DESCRIPTORS.map(
  d => [d.key, z.number().min(d.min).max(d.max)] as const,
);

export const SYNTH2_LEAF_SCHEMAS: Readonly<Record<string, z.ZodNumber>> =
  Object.fromEntries(synth2LeafEntries);

const synth2Modules: Record<string, Record<string, z.ZodNumber>> = {};
for (const [key, schema] of synth2LeafEntries) {
  const [mod, field] = key.split('.');
  (synth2Modules[mod] ??= {})[field] = schema;
}

const Synth2ParamsSchema = z.object(
  Object.fromEntries(
    Object.entries(synth2Modules).map(([mod, fields]) => [mod, z.object(fields).strict()]),
  ),
);
```

Add to the `Schemas` export map (after `SynthParams: SynthParamsSchema,`):

```ts
  Synth2Params: Synth2ParamsSchema,
```

Do **not** touch `EngineTypeSchema` / `EnginesMapSchema` yet — that lands with the factory in Task 4 so the "factory output validates" tests never see a half-wired state.

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/shared && npx vitest run src/project/schema.test.ts`
Expected: all passed (existing + 3 new)

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/project/schema.ts packages/shared/src/project/schema.test.ts
git commit -m "feat(shared): synth2 Zod schema + leaf validators generated from descriptors"
```

---

### Task 4: EngineType union, EnginesMap, factory, normalize healing

**Files:**
- Modify: `packages/shared/src/index.ts` (line 6: `EngineType`)
- Modify: `packages/shared/src/project/types.ts` (`EngineParamsMap`)
- Modify: `packages/shared/src/project/schema.ts` (`EngineTypeSchema`, `EnginesMapSchema`)
- Modify: `packages/shared/src/project/factory.ts` (`freshTrack`)
- Modify: `packages/shared/src/project/normalize.ts` (`ENGINE_KEYS`)
- Modify: `packages/shared/src/project/normalize.test.ts`
- Modify: `packages/shared/src/project/factory.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `factory.test.ts`:

```ts
import { DEFAULT_SYNTH2_PARAMS } from '../engines/index.js';

it('freshTrack carries an independent synth2 slice at defaults', () => {
  const t = freshTrack();
  expect(t.engines.synth2).toEqual(DEFAULT_SYNTH2_PARAMS);
  expect(t.engines.synth2).not.toBe(DEFAULT_SYNTH2_PARAMS); // structuredClone, D7
});
```

Append to `normalize.test.ts`:

```ts
import { DEFAULT_SYNTH2_PARAMS } from '../engines/index.js';

describe('synth2 slice healing (old-snapshot regression — spec §7 item 7)', () => {
  it('fills a missing engines.synth2 from defaults and keeps other slices by reference', () => {
    const p = freshProject();
    delete (p.tracks[0].engines as any).synth2;
    const out = normalizeProject(p);
    expect(out).not.toBe(p); // fast path must NOT swallow the repair
    expect(out.tracks[0].engines.synth2).toEqual(DEFAULT_SYNTH2_PARAMS);
    expect(out.tracks[0].engines.synth).toBe(p.tracks[0].engines.synth);
    expect(out.tracks[1]).toBe(p.tracks[1]); // valid tracks ride through by reference
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/shared && npx vitest run src/project/factory.test.ts src/project/normalize.test.ts`
Expected: both new tests FAIL (`engines.synth2` undefined; normalize returns `p` by reference)

- [ ] **Step 3: Implement**

`packages/shared/src/index.ts` line 6:

```ts
export type EngineType = 'synth' | 'kick' | 'hat' | 'snare' | 'clap' | 'synth2';
```

`packages/shared/src/project/types.ts` — extend the type import and map:

```ts
import type {
  SynthEngineParams,
  KickEngineParams,
  HatEngineParams,
  SnareEngineParams,
  ClapEngineParams,
  Synth2EngineParams,
} from '../engines/index.js';
```

```ts
export interface EngineParamsMap {
  synth: SynthEngineParams;
  kick: KickEngineParams;
  hat: HatEngineParams;
  snare: SnareEngineParams;
  clap: ClapEngineParams;
  synth2: Synth2EngineParams;
}
```

`packages/shared/src/project/schema.ts`:

```ts
const EngineTypeSchema = z.union([
  z.literal('synth'),
  z.literal('kick'),
  z.literal('hat'),
  z.literal('snare'),
  z.literal('clap'),
  z.literal('synth2'),
]);
```

```ts
const EnginesMapSchema = z.object({
  synth: SynthParamsSchema,
  kick: KickParamsSchema,
  hat: HatParamsSchema,
  snare: SnareParamsSchema,
  clap: ClapParamsSchema,
  synth2: Synth2ParamsSchema,
});
```

(Move the synth2 generated-schema block from Task 3 **above** `EnginesMapSchema` if it isn't already.)

`packages/shared/src/project/factory.ts` — extend the defaults import and `freshTrack`:

```ts
import {
  DEFAULT_SYNTH_PARAMS,
  DEFAULT_KICK_PARAMS,
  DEFAULT_HAT_PARAMS,
  DEFAULT_SNARE_PARAMS,
  DEFAULT_CLAP_PARAMS,
  DEFAULT_SYNTH2_PARAMS,
} from '../engines/index.js';
```

```ts
    engines: {
      synth: structuredClone(DEFAULT_SYNTH_PARAMS),
      kick:  structuredClone(DEFAULT_KICK_PARAMS),
      hat:   structuredClone(DEFAULT_HAT_PARAMS),
      snare: structuredClone(DEFAULT_SNARE_PARAMS),
      clap:  structuredClone(DEFAULT_CLAP_PARAMS),
      synth2: structuredClone(DEFAULT_SYNTH2_PARAMS),
    },
```

`packages/shared/src/project/normalize.ts` line 24:

```ts
const ENGINE_KEYS = ['synth', 'kick', 'hat', 'snare', 'clap', 'synth2'] as const;
```

- [ ] **Step 4: Run the full shared suite** (this change ripples into snapshot-codec/accept-list/protocol tests — they must all still pass since the shape is additive)

Run: `npm run test -w @fiddle/shared && npm run typecheck -w @fiddle/shared`
Expected: all passed, typecheck clean. (Repo-wide typecheck is now red in the client — expected until Task 12.)

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/index.ts packages/shared/src/project/types.ts packages/shared/src/project/schema.ts packages/shared/src/project/factory.ts packages/shared/src/project/normalize.ts packages/shared/src/project/factory.test.ts packages/shared/src/project/normalize.test.ts
git commit -m "feat(shared): synth2 engine type — union, schema map, factory slice, normalize healing"
```

---

### Task 5: Accept-list patterns + leaf resolution (generated)

**Files:**
- Modify: `packages/shared/src/project/accept-list.ts`
- Modify: `packages/shared/src/project/accept-list.test.ts`

- [ ] **Step 1: Write the failing test** (append to `accept-list.test.ts`)

```ts
import { SYNTH2_DESCRIPTORS } from '../engines/index.js';

describe('synth2 accept-list (generated from descriptors)', () => {
  it('every descriptor key is a writable, validating path', () => {
    for (const d of SYNTH2_DESCRIPTORS) {
      const path = `tracks.0.engines.synth2.${d.key}`;
      expect(pathIsWritable(path), path).toBe(true);
      expect(validatePathAndValue(path, d.default)).toEqual({ ok: true });
      const over = validatePathAndValue(path, d.max + 1);
      expect(over.ok, path).toBe(false);
      if (!over.ok) expect(over.code).toBe('value.invalid');
    }
  });

  it('rejects unknown synth2 paths and whole-module writes', () => {
    expect(pathIsWritable('tracks.0.engines.synth2.osc1.unknown')).toBe(false);
    expect(pathIsWritable('tracks.0.engines.synth2.osc1')).toBe(false);
    expect(pathIsWritable('tracks.0.engines.synth2')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/shared && npx vitest run src/project/accept-list.test.ts`
Expected: FAIL — synth2 paths not writable

- [ ] **Step 3: Implement in `accept-list.ts`**

Add to the imports:

```ts
import { SYNTH2_DESCRIPTORS } from '../engines/synth2-descriptors.js';
import { SYNTH2_LEAF_SCHEMAS } from './schema.js';
```

Append inside the `PATTERNS` array (after the Clap params block):

```ts
  // Synth2 params — GENERATED from the descriptor table (spec §6.4): one
  // leaf pattern per descriptor, nested as engines.synth2.<module>.<field>.
  ...SYNTH2_DESCRIPTORS.map(d => ['tracks', '*', 'engines', 'synth2', ...d.key.split('.')]),
```

In `resolveLeafSchema`, inside the `if (trackKey === 'engines')` block, replace the depth-6 special case:

```ts
    if (tokens.length === 6 && engineName === 'synth') {
      // tracks.<i>.engines.synth.<envName>.<adsrField>
      const envName = tokens[4];
      if (envName !== 'filterEnv' && envName !== 'ampEnv') return null;
      const adsrField = tokens[5] as keyof typeof Schemas.ADSR.shape;
      return Schemas.ADSR.shape[adsrField] ?? null;
    }

    if (tokens.length === 6 && engineName === 'synth2') {
      // tracks.<i>.engines.synth2.<module>.<field> — leaf schemas are
      // generated alongside the nested schema; key format matches the
      // descriptor table.
      return SYNTH2_LEAF_SCHEMAS[`${tokens[4]}.${tokens[5]}`] ?? null;
    }
```

- [ ] **Step 4: Run the shared suite**

Run: `npm run test -w @fiddle/shared`
Expected: all passed

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/project/accept-list.ts packages/shared/src/project/accept-list.test.ts
git commit -m "feat(shared): synth2 accept-list patterns + leaf resolution generated from descriptors"
```

---

### Task 6: Kernel — band-limiting helpers (`blep.ts`)

**Files:**
- Create: `packages/client/src/engine/synth2/kernel/blep.ts`
- Create: `packages/client/src/engine/synth2/kernel/blep.test.ts`

(The existing `engine/worklets/polyblep.ts` stays untouched — it documents the pulse worklet. This is the kernel's home for the same math, per spec §6.8.)

- [ ] **Step 1: Write the failing test**

```ts
// packages/client/src/engine/synth2/kernel/blep.test.ts
import { describe, it, expect } from 'vitest';
import { polyBLEP } from './blep';

describe('polyBLEP', () => {
  it('is zero away from the discontinuity', () => {
    expect(polyBLEP(0.5, 0.01)).toBe(0);
    expect(polyBLEP(0.02, 0.01)).toBe(0);
    expect(polyBLEP(0.97, 0.01)).toBe(0);
  });

  it('corrects toward -1 just after the wrap and +1 just before it', () => {
    expect(polyBLEP(0, 0.01)).toBeCloseTo(-1, 5);
    expect(polyBLEP(0.999999, 0.01)).toBeCloseTo(1, 4);
  });

  it('is continuous across the correction window boundary', () => {
    const dt = 0.01;
    expect(Math.abs(polyBLEP(dt * 0.999999, dt))).toBeLessThan(1e-4);
    expect(Math.abs(polyBLEP(1 - dt * 0.999999, dt))).toBeLessThan(1e-4);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/client && npx vitest run src/engine/synth2/kernel/blep.test.ts`
Expected: FAIL — cannot resolve `./blep`

- [ ] **Step 3: Implement**

```ts
// packages/client/src/engine/synth2/kernel/blep.ts
//
// PolyBLEP residual for band-limiting unit steps in phase-accumulator
// oscillators. Same math as engine/worklets/polyblep.ts (which stays in
// place for the synth1 pulse worklet); the kernel needs its own copy under
// kernel/ because kernel files must stay free of references to worklet-era
// modules and this file is bundled into the synth2 worklet.
//
// t: phase in [0,1) positioned so the discontinuity is at t=0/t=1.
// dt: phase increment per sample (freq / sampleRate).

export function polyBLEP(t: number, dt: number): number {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/client && npx vitest run src/engine/synth2/kernel/blep.test.ts`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/engine/synth2/kernel/blep.ts packages/client/src/engine/synth2/kernel/blep.test.ts
git commit -m "feat(client): synth2 kernel polyBLEP helper"
```

---

### Task 7: Kernel — `ParamSlot`

**Files:**
- Create: `packages/client/src/engine/synth2/kernel/ParamSlot.ts`
- Create: `packages/client/src/engine/synth2/kernel/ParamSlot.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/client/src/engine/synth2/kernel/ParamSlot.test.ts
import { describe, it, expect } from 'vitest';
import { ParamSlot } from './ParamSlot';
import type { Synth2ParamDescriptor } from '@fiddle/shared';

const SR = 48000;
const lin: Synth2ParamDescriptor = {
  key: 't.lin', min: 0, max: 1, default: 0.5, taper: 'linear', modulatable: true, modScale: 1,
};
const exp: Synth2ParamDescriptor = {
  key: 't.exp', min: 20, max: 20000, default: 1000, taper: 'expOctaves', modulatable: true, modScale: 4,
};

describe('ParamSlot', () => {
  it('starts at the descriptor default', () => {
    expect(new ParamSlot(lin, SR).next()).toBeCloseTo(0.5, 3);
  });

  it('smooths a base jump over ~5ms (no instant step)', () => {
    const s = new ParamSlot(lin, SR);
    s.setBase(1);
    const first = s.next();
    expect(first).toBeLessThan(0.51); // one sample in: barely moved
    for (let i = 0; i < SR * 0.05; i++) s.next(); // 50ms ≫ 5ms smoother
    expect(s.next()).toBeCloseTo(1, 3);
  });

  it('clamps setBase to the descriptor range', () => {
    const s = new ParamSlot(lin, SR);
    s.setBase(99);
    for (let i = 0; i < SR * 0.05; i++) s.next();
    expect(s.next()).toBeCloseTo(1, 3);
  });

  it('applies linear modulation as fraction of full range, clamped', () => {
    const s = new ParamSlot(lin, SR);
    s.mod = 0.25; // +25% of (max-min) = +0.25
    for (let i = 0; i < SR * 0.05; i++) s.next();
    expect(s.next()).toBeCloseTo(0.75, 3);
    s.mod = 10; // way over — clamps to max
    expect(s.next()).toBeCloseTo(1, 3);
  });

  it('applies expOctaves modulation multiplicatively', () => {
    const s = new ParamSlot(exp, SR);
    s.mod = 0.25; // 0.25 × 4 octaves = +1 octave
    for (let i = 0; i < SR * 0.05; i++) s.next();
    expect(s.next()).toBeCloseTo(2000, 0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/client && npx vitest run src/engine/synth2/kernel/ParamSlot.test.ts`
Expected: FAIL — cannot resolve `./ParamSlot`

- [ ] **Step 3: Implement**

```ts
// packages/client/src/engine/synth2/kernel/ParamSlot.ts
//
// One cell per continuous parameter (spec §6.3): a smoothed base value
// (written from the param block — knob/sync) plus a per-sample modulation
// accumulator (written by the mod matrix; always 0 in I1 but implemented and
// tested now because every module is built against this contract).
//
// next() must be called EXACTLY once per rendered sample per slot — it
// advances the smoother. The owning module is responsible for that cadence.

import type { Synth2ParamDescriptor } from '@fiddle/shared';

const SMOOTH_SECONDS = 0.005;

export class ParamSlot {
  /** Mod matrix input, bipolar. Cleared/written externally; 0 = unmodulated. */
  mod = 0;

  private target: number;
  private current: number;
  private readonly coeff: number;
  private readonly min: number;
  private readonly max: number;
  private readonly expTaper: boolean;
  private readonly modScale: number;
  private readonly range: number;

  constructor(desc: Synth2ParamDescriptor, sampleRate: number) {
    this.min = desc.min;
    this.max = desc.max;
    this.range = desc.max - desc.min;
    this.expTaper = desc.taper === 'expOctaves';
    this.modScale = desc.modScale;
    this.target = desc.default;
    this.current = desc.default;
    this.coeff = 1 - Math.exp(-1 / (SMOOTH_SECONDS * sampleRate));
  }

  setBase(v: number): void {
    this.target = v < this.min ? this.min : v > this.max ? this.max : v;
  }

  next(): number {
    this.current += (this.target - this.current) * this.coeff;
    let v = this.current;
    if (this.mod !== 0) {
      v = this.expTaper
        ? v * Math.pow(2, this.mod * this.modScale)
        : v + this.mod * this.modScale * this.range;
    }
    return v < this.min ? this.min : v > this.max ? this.max : v;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/client && npx vitest run src/engine/synth2/kernel/ParamSlot.test.ts`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/engine/synth2/kernel/ParamSlot.ts packages/client/src/engine/synth2/kernel/ParamSlot.test.ts
git commit -m "feat(client): synth2 kernel ParamSlot (smoothed base + mod accumulator)"
```

---

### Task 8: Kernel — `MorphOscillator`

**Files:**
- Create: `packages/client/src/engine/synth2/kernel/MorphOscillator.ts`
- Create: `packages/client/src/engine/synth2/kernel/MorphOscillator.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/client/src/engine/synth2/kernel/MorphOscillator.test.ts
import { describe, it, expect } from 'vitest';
import { MorphOscillator } from './MorphOscillator';
import { ParamSlot } from './ParamSlot';
import type { Synth2ParamDescriptor } from '@fiddle/shared';

const SR = 48000;

function slot(key: string, min: number, max: number, def: number): ParamSlot {
  const d: Synth2ParamDescriptor = {
    key, min, max, default: def, taper: 'linear', modulatable: true, modScale: 1,
  };
  return new ParamSlot(d, SR);
}

function makeOsc(morph: number) {
  return new MorphOscillator(
    slot('osc1.morph', 0, 3, morph),
    slot('osc1.pulseWidth', 0.05, 0.95, 0.5),
    slot('osc1.coarse', -36, 36, 0),
    slot('osc1.fine', -100, 100, 0),
    SR,
  );
}

function render(osc: MorphOscillator, freq: number, n: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = osc.next(freq);
  return out;
}

function positiveZeroCrossings(buf: Float32Array): number {
  let c = 0;
  for (let i = 1; i < buf.length; i++) if (buf[i - 1] <= 0 && buf[i] > 0) c++;
  return c;
}

describe('MorphOscillator', () => {
  it('sine (morph 0) runs at the requested frequency', () => {
    const buf = render(makeOsc(0), 440, SR); // 1 second
    expect(positiveZeroCrossings(buf)).toBeGreaterThanOrEqual(439);
    expect(positiveZeroCrossings(buf)).toBeLessThanOrEqual(441);
  });

  it('saw (morph 2) runs at the requested frequency', () => {
    const buf = render(makeOsc(2), 220, SR);
    expect(positiveZeroCrossings(buf)).toBeGreaterThanOrEqual(219);
    expect(positiveZeroCrossings(buf)).toBeLessThanOrEqual(221);
  });

  it('coarse tune shifts pitch by semitones', () => {
    const osc = makeOsc(0);
    // reach into the coarse slot via a fresh osc instead: +12 semitones = 2x freq
    const up = new MorphOscillator(
      slot('osc1.morph', 0, 3, 0),
      slot('osc1.pulseWidth', 0.05, 0.95, 0.5),
      slot('osc1.coarse', -36, 36, 12),
      slot('osc1.fine', -100, 100, 0),
      SR,
    );
    expect(positiveZeroCrossings(render(up, 220, SR))).toBeGreaterThanOrEqual(439);
    expect(positiveZeroCrossings(render(osc, 220, SR))).toBeLessThanOrEqual(221);
  });

  it('stays bounded across the whole morph range', () => {
    for (const m of [0, 0.5, 1, 1.5, 2, 2.5, 3]) {
      const buf = render(makeOsc(m), 440, 4096);
      for (let i = 0; i < buf.length; i++) {
        expect(Math.abs(buf[i]), `morph ${m} sample ${i}`).toBeLessThan(1.5);
        expect(Number.isFinite(buf[i])).toBe(true);
      }
    }
  });

  it('morphing is continuous: a slow sweep produces no per-sample jumps', () => {
    const morphSlot = slot('osc1.morph', 0, 3, 0);
    const osc = new MorphOscillator(
      morphSlot,
      slot('osc1.pulseWidth', 0.05, 0.95, 0.5),
      slot('osc1.coarse', -36, 36, 0),
      slot('osc1.fine', -100, 100, 0),
      SR,
    );
    const n = SR; // sweep morph 0 → 3 over 1s at 110Hz (long, smooth period)
    let prev = osc.next(110);
    let maxJump = 0;
    for (let i = 1; i < n; i++) {
      morphSlot.setBase((i / n) * 3);
      const v = osc.next(110);
      // ignore jumps at the waveform's own discontinuities (saw/pulse edges):
      // those are legitimate. The crossfade itself adds nothing larger.
      maxJump = Math.max(maxJump, Math.abs(v - prev) > 1.2 ? 0 : Math.abs(v - prev));
      prev = v;
    }
    expect(maxJump).toBeLessThan(0.6);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/client && npx vitest run src/engine/synth2/kernel/MorphOscillator.test.ts`
Expected: FAIL — cannot resolve `./MorphOscillator`

- [ ] **Step 3: Implement**

```ts
// packages/client/src/engine/synth2/kernel/MorphOscillator.ts
//
// Continuous-morph oscillator on ONE phase accumulator (spec §5.2/§6.8):
// morph 0 sine → 1 triangle → 2 saw → 3 pulse, equal-power crossfade between
// the two adjacent shapes. Saw and pulse edges are PolyBLEP-corrected.
// Triangle is the classic leaky integration of the BLEP square — proven,
// cheap, and phase-locked to the shared accumulator (slight HF rolloff vs a
// true BLAMP triangle is accepted for I1).
//
// The 50%-duty square feeding the integrator is computed EVERY sample, even
// when triangle isn't audible, so morphing into triangle never starts from a
// stale integrator state.

import { polyBLEP } from './blep';
import type { ParamSlot } from './ParamSlot';

const TWO_PI = Math.PI * 2;
const TRI_LEAK = 0.995;
const HALF_PI = Math.PI / 2;

export class MorphOscillator {
  private phase = 0;
  private tri = 0;

  constructor(
    private readonly morph: ParamSlot,
    private readonly pulseWidth: ParamSlot,
    private readonly coarse: ParamSlot,
    private readonly fine: ParamSlot,
    private readonly sampleRate: number,
  ) {}

  /** Note-on phase reset (only called when the voice was idle — D3 handles steals). */
  reset(): void {
    this.phase = 0;
    this.tri = 0;
  }

  next(baseFreq: number): number {
    const semis = this.coarse.next() + this.fine.next() / 100;
    const f = baseFreq * Math.pow(2, semis / 12);
    const dt = f / this.sampleRate;
    const pw = this.pulseWidth.next();
    const m = this.morph.next();

    // Keep the triangle integrator alive on the 50% square.
    let sq50 = this.phase < 0.5 ? 1 : -1;
    sq50 += polyBLEP(this.phase, dt);
    let tFall50 = this.phase - 0.5;
    if (tFall50 < 0) tFall50 += 1;
    sq50 -= polyBLEP(tFall50, dt);
    this.tri = TRI_LEAK * this.tri + 4 * dt * sq50;

    const seg = m >= 3 ? 2 : Math.floor(m);
    const frac = m - seg;
    let out = Math.cos(frac * HALF_PI) * this.shape(seg, dt, pw);
    if (frac > 0) out += Math.sin(frac * HALF_PI) * this.shape(seg + 1, dt, pw);

    this.phase += dt;
    if (this.phase >= 1) this.phase -= 1;
    return out;
  }

  private shape(index: number, dt: number, pw: number): number {
    switch (index) {
      case 0:
        return Math.sin(TWO_PI * this.phase);
      case 1:
        return this.tri;
      case 2: {
        let s = 2 * this.phase - 1;
        s -= polyBLEP(this.phase, dt);
        return s;
      }
      default: {
        let p = this.phase < pw ? 1 : -1;
        p += polyBLEP(this.phase, dt);
        let tFall = this.phase - pw;
        if (tFall < 0) tFall += 1;
        p -= polyBLEP(tFall, dt);
        return p;
      }
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/client && npx vitest run src/engine/synth2/kernel/MorphOscillator.test.ts`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/engine/synth2/kernel/MorphOscillator.ts packages/client/src/engine/synth2/kernel/MorphOscillator.test.ts
git commit -m "feat(client): synth2 morph oscillator (sine/tri/saw/pulse, PolyBLEP, shared phase)"
```

---

### Task 9: Kernel — `LoopEnvelope` (I1: ADSR, no loop yet)

**Files:**
- Create: `packages/client/src/engine/synth2/kernel/LoopEnvelope.ts`
- Create: `packages/client/src/engine/synth2/kernel/LoopEnvelope.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/client/src/engine/synth2/kernel/LoopEnvelope.test.ts
import { describe, it, expect } from 'vitest';
import { LoopEnvelope } from './LoopEnvelope';
import { ParamSlot } from './ParamSlot';
import type { Synth2ParamDescriptor } from '@fiddle/shared';

const SR = 48000;

function timeSlot(key: string, def: number): ParamSlot {
  const d: Synth2ParamDescriptor = {
    key, min: 0.001, max: 10, default: def, taper: 'expOctaves', modulatable: true, modScale: 4,
  };
  return new ParamSlot(d, SR);
}

function makeEnv(a = 0.01, d = 0.05, s = 0.5, r = 0.05): LoopEnvelope {
  const sus: Synth2ParamDescriptor = {
    key: 'env1.s', min: 0, max: 1, default: s, taper: 'linear', modulatable: true, modScale: 1,
  };
  return new LoopEnvelope(
    timeSlot('env1.a', a), timeSlot('env1.d', d), new ParamSlot(sus, SR), timeSlot('env1.r', r), SR,
  );
}

function run(env: LoopEnvelope, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(env.next());
  return out;
}

describe('LoopEnvelope (I1: plain ADSR)', () => {
  it('is idle (0, inactive) before noteOn', () => {
    const env = makeEnv();
    expect(env.active).toBe(false);
    expect(env.next()).toBe(0);
  });

  it('attack reaches 1 within ~a seconds, then decays to sustain', () => {
    const env = makeEnv(0.01, 0.05, 0.5, 0.05);
    env.noteOn(SR); // 1s gate
    const buf = run(env, Math.round(SR * 0.005)); // halfway through attack
    expect(buf[buf.length - 1]).toBeGreaterThan(0.3);
    run(env, Math.round(SR * 0.01)); // finish attack (1.5×a total)
    expect(env.level).toBeCloseTo(1, 1);
    run(env, Math.round(SR * 0.1)); // well past decay
    expect(env.level).toBeCloseTo(0.5, 1);
  });

  it('releases to 0 over ~r seconds after the gate ends and goes inactive', () => {
    const env = makeEnv(0.001, 0.01, 0.5, 0.05);
    env.noteOn(Math.round(SR * 0.1)); // 100ms gate
    run(env, Math.round(SR * 0.1)); // gate elapses
    expect(env.active).toBe(true);
    run(env, Math.round(SR * 0.06)); // > r
    expect(env.level).toBe(0);
    expect(env.active).toBe(false);
  });

  it('retrigger mid-release ramps to zero over ~1ms first (D3 steal ramp), no upward jump', () => {
    const env = makeEnv(0.05, 0.01, 0.8, 0.5);
    env.noteOn(Math.round(SR * 0.05));
    run(env, Math.round(SR * 0.06)); // into release with level still high
    const heldLevel = env.level;
    expect(heldLevel).toBeGreaterThan(0.1);
    env.noteOn(SR); // steal
    const ramp = run(env, Math.round(SR * 0.001)); // 1ms
    for (let i = 1; i < ramp.length; i++) {
      expect(ramp[i]).toBeLessThanOrEqual(ramp[i - 1] + 1e-9); // monotonically falling
    }
    expect(env.level).toBeLessThan(0.05); // reached ~0, now attacking from the floor
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/client && npx vitest run src/engine/synth2/kernel/LoopEnvelope.test.ts`
Expected: FAIL — cannot resolve `./LoopEnvelope`

- [ ] **Step 3: Implement**

```ts
// packages/client/src/engine/synth2/kernel/LoopEnvelope.ts
//
// Rate-integrating ADSR state machine (spec §5.4): each sample advances the
// level by a slope computed from the CURRENT a/d/s/r slot values, so stage
// times are modulatable mid-flight (matrix arrives in I3; the design is laid
// in now). The class is named for its I3 destiny — `loop` mode (attack⇄decay
// cycling while gated) is appended then; I1 is a plain ADSR.
//
// D3 preserved in-kernel: a retrigger while the level is non-zero enters a
// 1ms 'steal' ramp to 0 before the attack, eliminating retrigger clicks.
//
// Gate timing is sample-counted: noteOn(gateFrames) starts release exactly
// gateFrames samples later, mirroring the trigger(freq, duration, …) contract.

import type { ParamSlot } from './ParamSlot';

type Stage = 'idle' | 'steal' | 'attack' | 'decay' | 'sustain' | 'release';

const STEAL_SECONDS = 0.001;

export class LoopEnvelope {
  level = 0;

  private stage: Stage = 'idle';
  private gateRemaining = 0;
  private releaseFrom = 1;
  private readonly dt: number;
  private readonly stealStep: number;

  constructor(
    private readonly a: ParamSlot,
    private readonly d: ParamSlot,
    private readonly s: ParamSlot,
    private readonly r: ParamSlot,
    sampleRate: number,
  ) {
    this.dt = 1 / sampleRate;
    this.stealStep = 1 / (STEAL_SECONDS * sampleRate);
  }

  get active(): boolean {
    return this.stage !== 'idle';
  }

  noteOn(gateFrames: number): void {
    this.gateRemaining = Math.max(1, gateFrames);
    this.stage = this.level > 0 ? 'steal' : 'attack';
  }

  next(): number {
    switch (this.stage) {
      case 'idle':
        return 0;
      case 'steal':
        this.level -= this.stealStep;
        if (this.level <= 0) {
          this.level = 0;
          this.stage = 'attack';
        }
        break;
      case 'attack':
        this.level += this.dt / this.a.next();
        if (this.level >= 1) {
          this.level = 1;
          this.stage = 'decay';
        }
        break;
      case 'decay': {
        const sus = this.s.next();
        this.level -= (this.dt * (1 - sus)) / this.d.next();
        if (this.level <= sus) {
          this.level = sus;
          this.stage = 'sustain';
        }
        break;
      }
      case 'sustain':
        this.level = this.s.next();
        break;
      case 'release':
        this.level -= (this.dt * this.releaseFrom) / this.r.next();
        if (this.level <= 0) {
          this.level = 0;
          this.stage = 'idle';
        }
        break;
    }

    // Gate countdown runs through steal/attack/decay/sustain; when it
    // expires, enter release from wherever the level currently is.
    if (this.stage !== 'idle' && this.stage !== 'release') {
      this.gateRemaining--;
      if (this.gateRemaining <= 0) {
        this.stage = 'release';
        this.releaseFrom = Math.max(this.level, 0.001);
      }
    }

    return this.level;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/client && npx vitest run src/engine/synth2/kernel/LoopEnvelope.test.ts`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/engine/synth2/kernel/LoopEnvelope.ts packages/client/src/engine/synth2/kernel/LoopEnvelope.test.ts
git commit -m "feat(client): synth2 rate-integrating ADSR with D3 steal ramp"
```

---

### Task 10: Kernel — `params.ts`, `Voice`, `Synth2Kernel`

**Files:**
- Create: `packages/client/src/engine/synth2/kernel/params.ts`
- Create: `packages/client/src/engine/synth2/kernel/Voice.ts`
- Create: `packages/client/src/engine/synth2/kernel/Synth2Kernel.ts`
- Create: `packages/client/src/engine/synth2/kernel/Synth2Kernel.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/client/src/engine/synth2/kernel/Synth2Kernel.test.ts
import { describe, it, expect } from 'vitest';
import { Synth2Kernel } from './Synth2Kernel';
import { PARAM_INDEX, PARAM_COUNT, defaultParamBlock } from './params';
import { SYNTH2_DESCRIPTORS } from '@fiddle/shared';

const SR = 48000;
const BLOCK = 128;

function renderBlocks(kernel: Synth2Kernel, startFrame: number, blocks: number): Float32Array {
  const out = new Float32Array(blocks * BLOCK);
  const buf = new Float32Array(BLOCK);
  for (let b = 0; b < blocks; b++) {
    kernel.process(buf, BLOCK, startFrame + b * BLOCK);
    out.set(buf, b * BLOCK);
  }
  return out;
}

describe('params block layout', () => {
  it('one index per descriptor, in table order', () => {
    expect(PARAM_COUNT).toBe(SYNTH2_DESCRIPTORS.length);
    SYNTH2_DESCRIPTORS.forEach((d, i) => expect(PARAM_INDEX[d.key]).toBe(i));
    const block = defaultParamBlock();
    SYNTH2_DESCRIPTORS.forEach((d, i) => expect(block[i]).toBe(d.default));
  });
});

describe('Synth2Kernel', () => {
  it('renders exact silence (and stays finite) with no notes', () => {
    const out = renderBlocks(new Synth2Kernel(SR), 0, 8);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBe(0);
  });

  it('starts a note at the exact frame offset inside a block', () => {
    const kernel = new Synth2Kernel(SR);
    // note due at absolute frame 64 — mid-block when the block starts at 0
    kernel.noteOn(64 / SR, 440, 0.5, 1);
    const buf = new Float32Array(BLOCK);
    kernel.process(buf, BLOCK, 0);
    for (let i = 0; i < 64; i++) expect(buf[i]).toBe(0);
    let energyAfter = 0;
    for (let i = 64; i < BLOCK; i++) energyAfter += Math.abs(buf[i]);
    expect(energyAfter).toBeGreaterThan(0);
  });

  it('a past-due event starts immediately (graceful degradation)', () => {
    const kernel = new Synth2Kernel(SR);
    kernel.noteOn(0, 440, 0.5, 1); // due at frame 0…
    const buf = new Float32Array(BLOCK);
    kernel.process(buf, BLOCK, 1024); // …but the clock is already at 1024
    let energy = 0;
    for (let i = 0; i < BLOCK; i++) energy += Math.abs(buf[i]);
    expect(energy).toBeGreaterThan(0);
  });

  it('voice gates back to exact zeros after the release tail', () => {
    const kernel = new Synth2Kernel(SR);
    const block = defaultParamBlock();
    block[PARAM_INDEX['env1.r']] = 0.01;
    kernel.applyParams(block);
    kernel.noteOn(0, 440, 0.05, 1); // 50ms gate + 10ms release
    renderBlocks(kernel, 0, Math.ceil((SR * 0.1) / BLOCK)); // 100ms ≫ tail
    const after = renderBlocks(kernel, SR, 4);
    for (let i = 0; i < after.length; i++) expect(after[i]).toBe(0);
  });

  it('applyParams reaches the audio: osc1.level 0 silences a held note', () => {
    const kernel = new Synth2Kernel(SR);
    kernel.noteOn(0, 440, 2, 1);
    renderBlocks(kernel, 0, 8); // note sounding
    const block = defaultParamBlock();
    block[PARAM_INDEX['osc1.level']] = 0;
    kernel.applyParams(block);
    renderBlocks(kernel, 8 * BLOCK, Math.ceil((SR * 0.05) / BLOCK)); // ride out smoothing
    const after = renderBlocks(kernel, SR, 1);
    let peak = 0;
    for (let i = 0; i < after.length; i++) peak = Math.max(peak, Math.abs(after[i]));
    expect(peak).toBeLessThan(1e-3);
  });

  it('velocity scales output amplitude', () => {
    const loud = new Synth2Kernel(SR);
    const quiet = new Synth2Kernel(SR);
    loud.noteOn(0, 440, 1, 1);
    quiet.noteOn(0, 440, 1, 0.25);
    const a = renderBlocks(loud, 0, 16);
    const b = renderBlocks(quiet, 0, 16);
    let pa = 0, pb = 0;
    for (let i = 0; i < a.length; i++) { pa = Math.max(pa, Math.abs(a[i])); pb = Math.max(pb, Math.abs(b[i])); }
    expect(pb).toBeGreaterThan(0);
    expect(pb / pa).toBeCloseTo(0.25, 1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/client && npx vitest run src/engine/synth2/kernel/Synth2Kernel.test.ts`
Expected: FAIL — cannot resolve `./Synth2Kernel` / `./params`

- [ ] **Step 3: Implement all three files**

```ts
// packages/client/src/engine/synth2/kernel/params.ts
//
// Float32Array param-block layout — GENERATED from the descriptor table:
// block[i] is the base value of SYNTH2_DESCRIPTORS[i] (spec §6.4/§6.7).
// Always address via PARAM_INDEX['osc1.morph'], never positional literals.

import { SYNTH2_DESCRIPTORS } from '@fiddle/shared';

export const PARAM_COUNT = SYNTH2_DESCRIPTORS.length;

export const PARAM_INDEX: Readonly<Record<string, number>> = Object.fromEntries(
  SYNTH2_DESCRIPTORS.map((d, i) => [d.key, i]),
);

export function defaultParamBlock(): Float32Array {
  const block = new Float32Array(PARAM_COUNT);
  SYNTH2_DESCRIPTORS.forEach((d, i) => { block[i] = d.default; });
  return block;
}
```

```ts
// packages/client/src/engine/synth2/kernel/Voice.ts
//
// THE PATCH (spec §6.3): the only file that instantiates modules and wires
// them together. I1 voice: osc1 → level → VCA(env1) → out. Each voice owns
// its own ParamSlot set (bases are broadcast by the kernel; per-voice
// modulation arrives with the matrix in I3).

import { ParamSlot } from './ParamSlot';
import { MorphOscillator } from './MorphOscillator';
import { LoopEnvelope } from './LoopEnvelope';
import { PARAM_INDEX } from './params';
import { SYNTH2_DESCRIPTORS } from '@fiddle/shared';

export class Voice {
  readonly slots: ParamSlot[];

  private readonly osc1: MorphOscillator;
  private readonly env1: LoopEnvelope;
  private readonly osc1Level: ParamSlot;
  private freq = 440;
  private velocity = 1;

  constructor(sampleRate: number) {
    this.slots = SYNTH2_DESCRIPTORS.map(d => new ParamSlot(d, sampleRate));
    const slot = (key: string): ParamSlot => this.slots[PARAM_INDEX[key]];

    this.osc1 = new MorphOscillator(
      slot('osc1.morph'), slot('osc1.pulseWidth'),
      slot('osc1.coarse'), slot('osc1.fine'), sampleRate,
    );
    this.osc1Level = slot('osc1.level');
    this.env1 = new LoopEnvelope(
      slot('env1.a'), slot('env1.d'), slot('env1.s'), slot('env1.r'), sampleRate,
    );
  }

  get active(): boolean {
    return this.env1.active;
  }

  noteOn(freq: number, velocity: number, gateFrames: number): void {
    this.freq = freq;
    this.velocity = velocity < 0 ? 0 : velocity > 1 ? 1 : velocity;
    if (!this.env1.active) this.osc1.reset(); // fresh start; steals keep phase (D3 ramp handles the level)
    this.env1.noteOn(gateFrames);
  }

  /** Adds into out[from..to). Caller must skip inactive voices (gating). */
  renderAdd(out: Float32Array, from: number, to: number): void {
    for (let n = from; n < to; n++) {
      const e = this.env1.next();
      out[n] += this.osc1.next(this.freq) * this.osc1Level.next() * e * this.velocity;
    }
  }
}
```

```ts
// packages/client/src/engine/synth2/kernel/Synth2Kernel.ts
//
// Top level (spec §6.2/§6.7): voice pool + sample-accurate event queue +
// block renderer. Pure TS, zero allocation after construction. process()
// takes the absolute frame the block starts at (the worklet passes
// currentFrame; tests pass whatever they like).
//
// I1 is mono: one voice, every note retriggers it (steal ramp keeps it
// clickless). The queue is a fixed ring of preallocated events — events are
// assumed time-ordered (the sequencer schedules in order); a full ring drops
// the oldest event, which at 64 slots only happens under pathological input.

import { Voice } from './Voice';
import { PARAM_COUNT, defaultParamBlock } from './params';

const MAX_EVENTS = 64;

interface NoteEvent {
  frame: number;
  freq: number;
  gateFrames: number;
  velocity: number;
}

export class Synth2Kernel {
  private readonly voices: Voice[];
  private readonly block: Float32Array = defaultParamBlock();
  private readonly events: NoteEvent[];
  private head = 0; // next event to consume
  private count = 0;

  constructor(private readonly sampleRate: number) {
    this.voices = [new Voice(sampleRate)];
    this.events = Array.from({ length: MAX_EVENTS }, () => ({
      frame: 0, freq: 440, gateFrames: 0, velocity: 1,
    }));
  }

  /** Full param block (base values, descriptor order). Broadcast to voices. */
  applyParams(block: Float32Array): void {
    const n = Math.min(block.length, PARAM_COUNT);
    for (let i = 0; i < n; i++) this.block[i] = block[i];
    for (const voice of this.voices) {
      for (let i = 0; i < n; i++) voice.slots[i].setBase(this.block[i]);
    }
  }

  /** time/duration in seconds on the AudioContext clock (SoundEngine contract). */
  noteOn(time: number, freq: number, duration: number, velocity: number): void {
    if (this.count === MAX_EVENTS) { // drop oldest
      this.head = (this.head + 1) % MAX_EVENTS;
      this.count--;
    }
    const ev = this.events[(this.head + this.count) % MAX_EVENTS];
    ev.frame = Math.round(time * this.sampleRate);
    ev.freq = freq;
    ev.gateFrames = Math.max(1, Math.round(duration * this.sampleRate));
    ev.velocity = velocity;
    this.count++;
  }

  process(out: Float32Array, frames: number, blockStartFrame: number): void {
    out.fill(0);
    let cursor = 0;
    while (this.count > 0) {
      const ev = this.events[this.head];
      if (ev.frame >= blockStartFrame + frames) break; // due in a future block
      const offset = Math.max(0, ev.frame - blockStartFrame); // past-due → now
      this.renderActive(out, cursor, offset);
      cursor = offset;
      this.voices[0].noteOn(ev.freq, ev.velocity, ev.gateFrames);
      this.head = (this.head + 1) % MAX_EVENTS;
      this.count--;
    }
    this.renderActive(out, cursor, frames);
  }

  private renderActive(out: Float32Array, from: number, to: number): void {
    if (to <= from) return;
    for (const voice of this.voices) {
      if (voice.active) voice.renderAdd(out, from, to); // gating: idle voices cost nothing
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/client && npx vitest run src/engine/synth2/kernel/Synth2Kernel.test.ts`
Expected: 7 passed

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/engine/synth2/kernel/params.ts packages/client/src/engine/synth2/kernel/Voice.ts packages/client/src/engine/synth2/kernel/Synth2Kernel.ts packages/client/src/engine/synth2/kernel/Synth2Kernel.test.ts
git commit -m "feat(client): synth2 kernel — param block, voice patch, event queue, gating"
```

---

### Task 11: Worklet entry + esbuild bundling

**Files:**
- Create: `packages/client/src/engine/synth2/worklet-entry.ts`
- Modify: `packages/client/package.json`
- Create: `packages/client/.gitignore`

- [ ] **Step 1: Write the worklet entry**

```ts
// packages/client/src/engine/synth2/worklet-entry.ts
//
// The ONLY file that touches AudioWorkletGlobalScope (spec §6.2). Bundled by
// esbuild into public/worklets/synth2-processor.js (see package.json
// build:worklet) and registered in useSynth.buildAudioState via addModule.
//
// Message protocol (spec §6.6):
//   { type: 'params',  block: Float32Array }   full base-value block
//   { type: 'trigger', time, freq, duration, velocity }   seconds on ctx clock
//   { type: 'dispose' }   → process() returns false, node becomes collectable

import { Synth2Kernel } from './kernel/Synth2Kernel';

// AudioWorkletGlobalScope members — not in the DOM lib TS ships for the page.
declare const sampleRate: number;
declare const currentFrame: number;
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare function registerProcessor(
  name: string,
  ctor: new () => AudioWorkletProcessor & {
    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
  },
): void;

class Synth2Processor extends AudioWorkletProcessor {
  private readonly kernel = new Synth2Kernel(sampleRate);
  private alive = true;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.type === 'params') {
        this.kernel.applyParams(msg.block);
      } else if (msg.type === 'trigger') {
        this.kernel.noteOn(msg.time, msg.freq, msg.duration, msg.velocity);
      } else if (msg.type === 'dispose') {
        this.alive = false;
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const channels = outputs[0];
    const mono = channels[0];
    if (!mono) return this.alive;
    this.kernel.process(mono, mono.length, currentFrame);
    for (let c = 1; c < channels.length; c++) channels[c].set(mono);
    return this.alive;
  }
}

registerProcessor('synth2', Synth2Processor);
```

- [ ] **Step 2: Add the bundling scripts**

In `packages/client/package.json`, replace the `scripts` block with:

```json
  "scripts": {
    "build:worklet": "esbuild src/engine/synth2/worklet-entry.ts --bundle --format=esm --outfile=public/worklets/synth2-processor.js",
    "dev": "npm run build:worklet && vite",
    "build": "npm run build:worklet && vue-tsc && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "typecheck": "vue-tsc --noEmit"
  },
```

(Dev note, no action: kernel edits during a running `vite` session need `npm run build:worklet -- --watch` in a spare terminal + a page reload — the bundle is a static public asset, outside Vite's HMR graph. Acceptable for I1; lock-in per spec §6.5.)

Install esbuild as a client devDependency:

```bash
npm install -D esbuild -w @fiddle/client
```

Create `packages/client/.gitignore`:

```
# Generated by `npm run build:worklet` (see package.json) — never commit.
public/worklets/
```

- [ ] **Step 3: Verify the bundle builds and is self-contained**

Run: `npm run build:worklet -w @fiddle/client && head -c 400 packages/client/public/worklets/synth2-processor.js && grep -c "^import\|from \"@fiddle" packages/client/public/worklets/synth2-processor.js || true`
Expected: file exists, starts with bundled code, grep finds **0** import statements (esbuild inlined `@fiddle/shared` + kernel — note `--packages=external` is deliberately NOT used here, unlike the server build).

- [ ] **Step 4: Typecheck the client package compiles the entry**

Run: `npm run typecheck -w @fiddle/client`
Expected: still red ONLY with the known `engineFactories` Record error from Task 4 (the union member without a factory). No errors from `synth2/` files. If other errors appear, fix them now.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/engine/synth2/worklet-entry.ts packages/client/package.json packages/client/.gitignore package-lock.json
git commit -m "feat(client): synth2 worklet entry + esbuild bundle to public/worklets"
```

---

### Task 12: `Synth2Engine` + `useSynth` wiring

**Files:**
- Create: `packages/client/src/engine/Synth2Engine.ts`
- Create: `packages/client/src/engine/Synth2Engine.test.ts`
- Modify: `packages/client/src/composables/useSynth.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/client/src/engine/Synth2Engine.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Synth2Engine } from './Synth2Engine';
import { SYNTH2_DESCRIPTORS, DEFAULT_SYNTH2_PARAMS } from '@fiddle/shared';
import { PARAM_INDEX } from './synth2/kernel/params';

class MockPort {
  posted: any[] = [];
  postMessage = vi.fn((msg: any) => { this.posted.push(msg); });
}

class MockAudioNode {
  connect = vi.fn();
  disconnect = vi.fn();
}

class MockWorkletNode extends MockAudioNode {
  port = new MockPort();
  constructor(public ctx: unknown, public name: string, public options: unknown) { super(); }
}

class MockGainNode extends MockAudioNode {
  gain = { value: 1 };
}

function mockCtx() {
  return {
    state: 'running',
    currentTime: 0,
    destination: new MockAudioNode(),
    resume: vi.fn(),
    createGain: () => new MockGainNode(),
  } as unknown as AudioContext;
}

beforeEach(() => {
  vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function lastNode(engine: Synth2Engine): MockWorkletNode {
  return (engine as any).node as MockWorkletNode;
}

describe('Synth2Engine protocol', () => {
  it('registers as engineType synth2 and builds a synth2 worklet node', () => {
    const engine = new Synth2Engine(mockCtx());
    expect(engine.engineType).toBe('synth2');
    expect(lastNode(engine).name).toBe('synth2');
  });

  it('applyParams maps nested sparse params onto descriptor indices and posts the block', () => {
    const engine = new Synth2Engine(mockCtx());
    engine.applyParams({ osc1: { morph: 1.5 }, env1: { r: 2 } });
    const msg = lastNode(engine).port.posted.at(-1);
    expect(msg.type).toBe('params');
    expect(msg.block[PARAM_INDEX['osc1.morph']]).toBeCloseTo(1.5);
    expect(msg.block[PARAM_INDEX['env1.r']]).toBeCloseTo(2);
    // untouched leaves stay at defaults
    expect(msg.block[PARAM_INDEX['osc1.level']]).toBeCloseTo(DEFAULT_SYNTH2_PARAMS.osc1.level);
  });

  it('applyParams with no effective change posts nothing', () => {
    const engine = new Synth2Engine(mockCtx());
    engine.applyParams(structuredClone(DEFAULT_SYNTH2_PARAMS) as any);
    expect(lastNode(engine).port.posted.filter(m => m.type === 'params')).toHaveLength(0);
  });

  it('applyParams accepts the full slice shape (descriptor coverage)', () => {
    const engine = new Synth2Engine(mockCtx());
    const slice = structuredClone(DEFAULT_SYNTH2_PARAMS) as any;
    for (const d of SYNTH2_DESCRIPTORS) {
      const [mod, field] = d.key.split('.');
      slice[mod][field] = d.min;
    }
    engine.applyParams(slice);
    const msg = lastNode(engine).port.posted.at(-1);
    for (const d of SYNTH2_DESCRIPTORS) {
      expect(msg.block[PARAM_INDEX[d.key]], d.key).toBeCloseTo(d.min);
    }
  });

  it('trigger forwards the sequencer time and takes the first freq of a chord', () => {
    const engine = new Synth2Engine(mockCtx());
    engine.trigger([220, 330], 0.5, 1.25, 0.8);
    const msg = lastNode(engine).port.posted.at(-1);
    expect(msg).toEqual({ type: 'trigger', time: 1.25, freq: 220, duration: 0.5, velocity: 0.8 });
  });

  it('dispose posts dispose and disconnects', () => {
    const engine = new Synth2Engine(mockCtx());
    engine.dispose();
    expect(lastNode(engine).port.posted.at(-1)).toEqual({ type: 'dispose' });
    expect(lastNode(engine).disconnect).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/client && npx vitest run src/engine/Synth2Engine.test.ts`
Expected: FAIL — cannot resolve `./Synth2Engine`

- [ ] **Step 3: Implement `Synth2Engine`**

```ts
// packages/client/src/engine/Synth2Engine.ts
//
// SoundEngine implementation for the worklet synth (spec §6.1/§6.6). One
// AudioWorkletNode per engine instance; ALL communication is MessagePort
// messages (no AudioParams). The engine keeps a Float32Array mirror of the
// param block (descriptor order — see kernel/params.ts) and posts a copy
// whenever applyParams changes anything.
//
// External graph shape matches every other engine: node → out GainNode →
// destination, so useSynth's D4 engine-swap fade works unchanged.
//
// PREREQUISITE: ctx.audioWorklet.addModule(synth2 worklet URL) must have
// resolved before construction — same invariant as the pulse worklet; both
// are awaited in useSynth.buildAudioState.

import { SoundEngine } from './types';
import { DEFAULT_SYNTH2_PARAMS, type Synth2EngineParams } from '@fiddle/shared';
import { PARAM_INDEX, defaultParamBlock } from './synth2/kernel/params';

export class Synth2Engine implements SoundEngine {
  readonly engineType = 'synth2';
  readonly ctx: AudioContext;

  static readonly DEFAULT_PARAMS: Synth2EngineParams = DEFAULT_SYNTH2_PARAMS;

  private readonly node: AudioWorkletNode;
  private readonly out: GainNode;
  private readonly block = defaultParamBlock();

  constructor(ctx: AudioContext, destination?: AudioNode) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.node = new AudioWorkletNode(ctx, 'synth2', {
      numberOfInputs: 0,
      outputChannelCount: [1],
    });
    this.node.connect(this.out);
    this.out.connect(destination ?? ctx.destination);
  }

  applyParams(params: Record<string, any>): void {
    let changed = false;
    for (const [mod, fields] of Object.entries(params)) {
      if (typeof fields !== 'object' || fields === null) continue;
      for (const [field, value] of Object.entries(fields as Record<string, unknown>)) {
        if (typeof value !== 'number') continue;
        const idx = PARAM_INDEX[`${mod}.${field}`];
        if (idx === undefined || this.block[idx] === value) continue;
        this.block[idx] = value;
        changed = true;
      }
    }
    if (changed) {
      this.node.port.postMessage({ type: 'params', block: this.block.slice() });
    }
  }

  trigger(freq: number | number[], duration: number, time?: number, velocity: number = 1.0): void {
    if (this.ctx.state === 'suspended') this.ctx.resume();
    // I1 is mono — chords collapse to their root; poly arrives in I2.
    const f = Array.isArray(freq) ? freq[0] : freq;
    this.node.port.postMessage({
      type: 'trigger',
      time: time ?? this.ctx.currentTime,
      freq: f,
      duration,
      velocity,
    });
  }

  dispose(): void {
    this.node.port.postMessage({ type: 'dispose' });
    this.node.disconnect();
    this.out.disconnect();
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/client && npx vitest run src/engine/Synth2Engine.test.ts`
Expected: 6 passed

- [ ] **Step 5: Wire `useSynth.ts`** (four edits)

(a) Next to the existing `pulseWorkletUrl` near the top (line ~17):

```ts
// synth2 worklet — esbuild-bundled into public/worklets by `build:worklet`
// (a static asset, NOT in Vite's module graph — see client package.json).
const synth2WorkletUrl = '/worklets/synth2-processor.js';
```

(b) Import the engine (with the other engine imports) and extend the factory map + slices:

```ts
import { Synth2Engine } from '../engine/Synth2Engine';
```

```ts
const ENGINE_SLICES: EngineType[] = ['synth', 'kick', 'hat', 'snare', 'clap', 'synth2'];

const engineFactories: Record<EngineType, (ctx: AudioContext, dest: AudioNode) => SoundEngine> = {
  synth: (ctx, dest) => new SynthEngine(ctx, dest),
  kick:  (ctx, dest) => new KickEngine(ctx, dest),
  hat:   (ctx, dest) => new HatEngine(ctx, dest),
  snare: (ctx, dest) => new SnareEngine(ctx, dest),
  clap:  (ctx, dest) => new ClapEngine(ctx, dest),
  synth2: (ctx, dest) => new Synth2Engine(ctx, dest),
};
```

(c) In `buildAudioState`, directly after the existing `await ctx.audioWorklet.addModule(pulseWorkletUrl);`:

```ts
  // synth2 worklet must likewise be registered before any Synth2Engine
  // constructs an AudioWorkletNode('synth2').
  await ctx.audioWorklet.addModule(synth2WorkletUrl);
```

(d) In the sequencer callback (the `togglePlay` step trigger, ~line 757), add a `synth2` branch between the `'synth'` branch and the drum `else`:

```ts
            } else if (engineTypeI === 'synth2') {
              // synth2 I1 is mono — single freq, melodic duration semantics
              // identical to synth mono.
              const tickDuration = (60 / project.bpm) / 4;
              const duration = step.length * tickDuration;
              engine.trigger(noteToFreq(step.note, step.octave), duration, time, step.velocity);
            } else {
```

- [ ] **Step 6: Verify repo-wide typecheck is green again and client tests pass**

Run: `npm run typecheck && npm run test -w @fiddle/client`
Expected: typecheck clean across all workspaces (the Task 4 red window closes here); all client tests pass. NOTE: `useSynth.test.ts` exercises `buildAudioState` via mocks whose `addModule` resolves for any URL — if any test asserts the addModule call count or stubs `AudioWorkletNode` construction by name, extend the stub to accept `'synth2'`.

- [ ] **Step 7: Commit**

```bash
git add packages/client/src/engine/Synth2Engine.ts packages/client/src/engine/Synth2Engine.test.ts packages/client/src/composables/useSynth.ts
git commit -m "feat(client): Synth2Engine (MessagePort protocol) wired into useSynth"
```

---

### Task 13: Panel + StudioView wiring

**Files:**
- Create: `packages/client/src/components/Synth2Panel.vue`
- Modify: `packages/client/src/views/StudioView.vue`

(No unit tests — repo convention: never mount `.vue` files in tests. The panel is verified in Task 14's browser pass.)

- [ ] **Step 1: Create the panel** (mirrors `KickPanel.vue`'s structure; knob ranges come from the descriptor table via `DEFAULT_SYNTH2_PARAMS` + literals matching the descriptors — panels reading descriptors directly is an I2+ refinement, see spec §6.4 table note)

```vue
<template>
  <div class="rack-columns">
    <!-- Column 1: Oscillator 1 -->
    <div class="rack-column">
      <div class="module-group synth2-panel">
        <h3>OSC 1</h3>
        <div class="knob-row">
          <Knob label="Morph" :min="0" :max="3" :step="0.01" :defaultValue="DEFAULTS.osc1.morph" v-model="params.osc1.morph" :syncPath="ks.pathFor(['osc1', 'morph'])" @gesture-end="ks.end(['osc1', 'morph'])" />
          <Knob label="PW" :min="0.05" :max="0.95" :step="0.01" format="percent" :defaultValue="DEFAULTS.osc1.pulseWidth" v-model="params.osc1.pulseWidth" :syncPath="ks.pathFor(['osc1', 'pulseWidth'])" @gesture-end="ks.end(['osc1', 'pulseWidth'])" />
          <Knob label="Coarse" :min="-36" :max="36" :step="1" :defaultValue="DEFAULTS.osc1.coarse" v-model="params.osc1.coarse" :syncPath="ks.pathFor(['osc1', 'coarse'])" @gesture-end="ks.end(['osc1', 'coarse'])" />
          <Knob label="Fine" :min="-100" :max="100" :step="1" format="cents" :defaultValue="DEFAULTS.osc1.fine" v-model="params.osc1.fine" :syncPath="ks.pathFor(['osc1', 'fine'])" @gesture-end="ks.end(['osc1', 'fine'])" />
          <Knob label="Level" :min="0" :max="1" :step="0.01" format="percent" :defaultValue="DEFAULTS.osc1.level" v-model="params.osc1.level" :syncPath="ks.pathFor(['osc1', 'level'])" @gesture-end="ks.end(['osc1', 'level'])" />
        </div>
      </div>
      <div class="module-group">
        <h3>AMP ENV</h3>
        <div class="knob-row">
          <Knob label="A" :min="0.001" :max="10" :step="0.001" format="ms" :defaultValue="DEFAULTS.env1.a" v-model="params.env1.a" :syncPath="ks.pathFor(['env1', 'a'])" @gesture-end="ks.end(['env1', 'a'])" />
          <Knob label="D" :min="0.001" :max="10" :step="0.001" format="ms" :defaultValue="DEFAULTS.env1.d" v-model="params.env1.d" :syncPath="ks.pathFor(['env1', 'd'])" @gesture-end="ks.end(['env1', 'd'])" />
          <Knob label="S" :min="0" :max="1" :step="0.01" format="percent" :defaultValue="DEFAULTS.env1.s" v-model="params.env1.s" :syncPath="ks.pathFor(['env1', 's'])" @gesture-end="ks.end(['env1', 's'])" />
          <Knob label="R" :min="0.001" :max="10" :step="0.001" format="ms" :defaultValue="DEFAULTS.env1.r" v-model="params.env1.r" :syncPath="ks.pathFor(['env1', 'r'])" @gesture-end="ks.end(['env1', 'r'])" />
        </div>
      </div>
    </div>

    <!-- Column 2: Visualizer -->
    <div class="rack-column">
      <Visualizer :analyser="analyser" :color="color" />
    </div>
  </div>
</template>

<script setup lang="ts">
import Knob from './Knob.vue';
import Visualizer from './Visualizer.vue';
import { DEFAULT_SYNTH2_PARAMS } from '@fiddle/shared';
import { useKnobSync } from '../sync/knobSync';
import type { EngineParamsMap } from '../project';

const DEFAULTS = DEFAULT_SYNTH2_PARAMS;
const ks = useKnobSync('synth2');

defineProps<{
  params: EngineParamsMap['synth2'];
  analyser: AnalyserNode | null;
  color: string;
}>();
</script>
```

(If `'../project'` does not re-export `EngineParamsMap` with the synth2 key, import it from `@fiddle/shared` instead — match whatever `KickPanel.vue` resolves at execution time.)

- [ ] **Step 2: Wire StudioView**

In `packages/client/src/views/StudioView.vue`:

(a) Add the import next to the other panel imports (~line 239):

```ts
import Synth2Panel from '../components/Synth2Panel.vue';
```

(b) Add an engine-select button after the `clap` button (~line 108–110), following the exact pattern of its siblings:

```vue
          <button
            :class="{ active: focusedTrack!.engineType === 'synth2' }"
            @click="focusedTrack!.engineType = 'synth2'"
            :style="focusedTrack!.engineType === 'synth2' ? { borderColor: trackColor(activeTrackIndex), color: trackColor(activeTrackIndex) } : {}"
          >
            SYNTH2
          </button>
```

(c) Add the panel branch after the `clap` template branch (~line 180–185):

```vue
            <template v-else-if="focusedTrack!.engineType === 'synth2'">
              <Synth2Panel
                :params="focusedTrack!.engines.synth2"
                :analyser="trackAnalyser"
                :color="trackColor(activeTrackIndex)"
              />
            </template>
```

(Match the exact prop names the sibling panels receive at those lines — if the clap branch passes e.g. `:analyser="trackAnalyser"` under a different name, mirror it.)

- [ ] **Step 3: Typecheck + full client suite**

Run: `npm run typecheck -w @fiddle/client && npm run test -w @fiddle/client`
Expected: clean / all passed

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/components/Synth2Panel.vue packages/client/src/views/StudioView.vue
git commit -m "feat(client): Synth2 panel + StudioView engine button and panel branch"
```

---

### Task 14: Full gate + browser verification

- [ ] **Step 1: Run the merge gate**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green. The client build must emit `dist/worklets/synth2-processor.js` (public assets are copied verbatim) — verify: `ls packages/client/dist/worklets/`.

- [ ] **Step 2: Server e2e canary** (synth2 ops ride the generic per-leaf protocol; this confirms nothing regressed)

Run: `npm run test:e2e:server`
Expected: all passed

- [ ] **Step 3: Browser verification (Playwright MCP — AGENTS.md requirement)**

1. `npm run dev` (background). Open `http://localhost:5173`, create a session from the lobby.
2. Select track 1, click the **SYNTH2** engine button → panel shows OSC 1 (Morph/PW/Coarse/Fine/Level) + AMP ENV knobs.
3. Place 2–3 steps in the tracker, press Play → sound renders; sweep **Morph** 0→3 while playing → timbre changes sine→tri→saw→pulse with no console errors and no clicks on retrigger.
4. **Sync round-trip (I1 exit criterion):** open a second tab on the same session URL. In tab B, confirm track 1 shows SYNTH2; drag Morph in tab A → tab B's knob follows; drag in tab B → tab A follows. Press Play in tab B → it hears the synth2 track locally.
5. **Old-snapshot heal smoke:** reload tab A → session loads, synth2 params persist (server snapshot round-trip).
6. Check both consoles: zero errors/warnings from the worklet path.
7. **Cleanup (mandatory):** close every tab/session opened, stop the dev servers.

- [ ] **Step 4: Report**

Summarize gate + browser observations to the user. Per project rules: **stop here — do not merge**; the user verifies and decides on the merge (memory: verify-before-finalizing, keep branches).

---

## Self-review notes (already applied)

- Spec coverage: §5.2 osc1 (Task 8), §5.4 env1 minus loop (Task 9), §5.8 defaults (Task 1), §6.2–§6.4 layout/slots/descriptors (Tasks 1, 7, 10), §6.5 bundling (Task 11), §6.6 protocol (Tasks 11–12), §6.7 ABI constraints (Tasks 7–10: typed-array block, no allocation in render loops, no Web Audio under `kernel/`), §7 shared integration items 1–7 (Tasks 2–5), §8 client integration (Tasks 12–13), §11 testing strategy I1 slice (throughout), §12 I1 exit criterion (Task 14 step 3.4).
- Out of I1 scope by design: morph filter/classic filter, sync/FM, LFOs, matrix, loop mode, poly, stereo spread, `mode` param, engineLabel changes (default `SYNTH2` uppercase comes free).
- Type consistency: `ParamSlot.next()/setBase/mod`, `PARAM_INDEX` keyed by `'<module>.<field>'`, kernel `process(out, frames, blockStartFrame)`, message shapes identical in worklet-entry (Task 11), Synth2Engine (Task 12), and kernel tests (Task 10).
