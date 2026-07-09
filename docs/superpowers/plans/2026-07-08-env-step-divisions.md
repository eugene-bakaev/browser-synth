# Envelope A/D/R Step-Fraction Divisions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the note-division vocabulary on synth2 envelope A/D/R tempo-sync with a step-fraction vocabulary (19 entries measured in sequencer steps, 9 at or under one step), envelopes only — LFO sync untouched.

**Architecture:** New shared module `env-sync.ts` owns the step-division table and the label→seconds/index helpers. The 9 existing `env*.aDiv/dDiv/rDiv` descriptor rows swap their `enumValues` **in place** (no rows added or removed — block layout/ABI unchanged; the slots are dead to the kernel). AudioEngine's `effectiveEnvTimes` and Synth2Panel's synced A/D/R knobs switch to the new vocabulary. `divisionToSeconds` is deleted from `lfo-sync.ts` (its only consumer was the envelope derivation).

**Tech Stack:** TypeScript monorepo (`@fiddle/shared`, `@fiddle/client`), Vitest, Vue 3.5 `<script setup>`.

**Source spec:** `docs/superpowers/specs/2026-07-08-env-step-divisions-design.md` (approved, `dd317a0`).

## Global Constraints

- One step = a 1/16 note = `(60/bpm)/4` seconds. `envDivisionToSeconds(label, bpm) = steps × 15 / bpm`.
- The `ENV_SYNC_DIVISIONS` table is EXACTLY the 19 entries in Task 1, ordered slowest → fastest: `32, 24, 16, 12, 8, 6, 4, 3, 2, 1.5, 1, 3/4, 2/3, 1/2, 1/3, 1/4, 1/6, 1/8, 1/16` (labels are those strings verbatim).
- Per-stage defaults: aDiv `'1/2'`, dDiv `'2'`, rDiv `'4'` — always expressed as `ENV_SYNC_LABELS.indexOf(...)`, never hardcoded indices. `ENV_SYNC_DEFAULT_LABEL = '1'` (unknown-label fallback).
- **No descriptor rows added, removed, or reordered.** Only the 9 `env{1,2,3}.aDiv/dDiv/rDiv` rows change (`enumValues`, `max`, `default`); the `env*.sync` bool rows and everything else are untouched.
- **LFO sync is untouched**: `LFO_SYNC_DIVISIONS`, `divisionToHz`, `divisionLabelToIndex`, the `lfo*.sync/div` rows, and the two LFO Rate knobs keep the note-division vocabulary.
- The persisted `env*.a/d/r` seconds leaves are never overwritten by sync; derivation happens main-thread only; the kernel/worklet is not touched.
- No legacy-label shim: unknown labels fall back (seconds → 1 step, knob index → default index). No server change, no migration.
- Every commit leaves the whole monorepo green — Task 2's cross-package flip is ONE commit.
- Stage only named files (`git add <paths>`), never `git add -A`/`-u`. Never stage `studio-focused.md`, `studio-initial.png`, `synth2-wave-previews.png`.
- Commit messages end with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01DFmmWXyd9uJAiJ6cdbE4ir`
- Local testing is `npm run dev:obs` ONLY (never `npm run dev` — it targets prod Supabase).

---

### Task 1: Shared `env-sync` module (purely additive)

**Files:**
- Create: `packages/shared/src/engines/env-sync.ts`
- Create: `packages/shared/src/engines/env-sync.test.ts`
- Modify: `packages/shared/src/engines/index.ts` (add one export line)

**Interfaces:**
- Consumes: nothing (self-contained module; mirrors the shape of `lfo-sync.ts`).
- Produces (Tasks 2 and 3 rely on these exact names, re-exported from `@fiddle/shared`):
  - `ENV_SYNC_DIVISIONS: readonly EnvSyncDivision[]` (19 entries, `{ label: string; steps: number }`)
  - `ENV_SYNC_LABELS: readonly string[]`
  - `ENV_SYNC_DEFAULT_LABEL = '1'`, `ENV_SYNC_DEFAULT_INDEX` (= 10)
  - `envDivisionToSeconds(label: string, bpm: number): number`
  - `envDivisionLabelToIndex(label: string): number`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/engines/env-sync.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  ENV_SYNC_DIVISIONS, ENV_SYNC_LABELS, ENV_SYNC_DEFAULT_LABEL,
  ENV_SYNC_DEFAULT_INDEX, envDivisionToSeconds, envDivisionLabelToIndex,
} from './env-sync.js';

describe('ENV_SYNC_DIVISIONS', () => {
  it('is exactly the 19 step divisions, slowest → fastest', () => {
    expect(ENV_SYNC_LABELS).toEqual([
      '32', '24', '16', '12', '8', '6', '4', '3', '2', '1.5', '1',
      '3/4', '2/3', '1/2', '1/3', '1/4', '1/6', '1/8', '1/16',
    ]);
    // Strictly decreasing steps guards the knob sweep direction.
    for (let i = 1; i < ENV_SYNC_DIVISIONS.length; i++) {
      expect(ENV_SYNC_DIVISIONS[i].steps).toBeLessThan(ENV_SYNC_DIVISIONS[i - 1].steps);
    }
  });

  it('defaults to one step', () => {
    expect(ENV_SYNC_DEFAULT_LABEL).toBe('1');
    expect(ENV_SYNC_DEFAULT_INDEX).toBe(ENV_SYNC_LABELS.indexOf('1'));
    expect(ENV_SYNC_DIVISIONS[ENV_SYNC_DEFAULT_INDEX].steps).toBe(1);
  });
});

describe('envDivisionToSeconds', () => {
  it('derives seconds = steps × 15 / bpm', () => {
    expect(envDivisionToSeconds('1', 120)).toBeCloseTo(0.125, 10);      // one step @120
    expect(envDivisionToSeconds('4', 120)).toBeCloseTo(0.5, 10);        // = old 1/4-note default
    expect(envDivisionToSeconds('1/2', 120)).toBeCloseTo(0.0625, 10);   // = old 1/32-note default
    expect(envDivisionToSeconds('1/16', 120)).toBeCloseTo(0.0078125, 10);
    expect(envDivisionToSeconds('32', 40)).toBeCloseTo(12, 10);         // pre-clamp slow extreme
  });

  it('matches steps × 15 / bpm for every entry', () => {
    for (const d of ENV_SYNC_DIVISIONS) {
      expect(envDivisionToSeconds(d.label, 97)).toBeCloseTo((d.steps * 15) / 97, 10);
    }
  });

  it('falls back to one step for an unknown label (never NaN)', () => {
    expect(envDivisionToSeconds('1/32T', 120)).toBeCloseTo(0.125, 10); // legacy note label
    expect(envDivisionToSeconds('bogus', 120)).toBeCloseTo(0.125, 10);
  });
});

describe('envDivisionLabelToIndex', () => {
  it('maps labels to their index', () => {
    expect(envDivisionLabelToIndex('32')).toBe(0);
    expect(envDivisionLabelToIndex('1/16')).toBe(18);
  });
  it('maps an unknown label to the default index', () => {
    expect(envDivisionLabelToIndex('1/32.')).toBe(ENV_SYNC_DEFAULT_INDEX); // legacy note label
    expect(envDivisionLabelToIndex('bogus')).toBe(ENV_SYNC_DEFAULT_INDEX);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/engines/env-sync.test.ts` (cwd `packages/shared`)
Expected: FAIL — cannot resolve `./env-sync.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/shared/src/engines/env-sync.ts`:

```ts
// Single source of truth for envelope tempo-sync STEP divisions (spec
// 2026-07-08-env-step-divisions-design.md). Envelope A/D/R stage lengths are
// measured in sequencer steps (one step = a 1/16 note = (60/bpm)/4 seconds),
// unlike the LFO's note divisions (lfo-sync.ts) — the two vocabularies are
// deliberately separate. Consumed by the synth2 descriptor table (enum
// values), AudioEngine (seconds derivation), and Synth2Panel (knob labels).

export interface EnvSyncDivision {
  /** Display label, also the persisted enum value (e.g. "1/2", "1.5", "16"). */
  readonly label: string;
  /** Length in sequencer steps; one step = a 1/16 note = (60/bpm)/4 seconds. */
  readonly steps: number;
}

// Ordered slowest → fastest so the knob sweeps left(slow)→right(fast),
// matching the free-mode seconds knob and the LFO sync knob.
export const ENV_SYNC_DIVISIONS: readonly EnvSyncDivision[] = [
  { label: '32',   steps: 32 },
  { label: '24',   steps: 24 },
  { label: '16',   steps: 16 },
  { label: '12',   steps: 12 },
  { label: '8',    steps: 8 },
  { label: '6',    steps: 6 },
  { label: '4',    steps: 4 },
  { label: '3',    steps: 3 },
  { label: '2',    steps: 2 },
  { label: '1.5',  steps: 1.5 },
  { label: '1',    steps: 1 },
  { label: '3/4',  steps: 3 / 4 },
  { label: '2/3',  steps: 2 / 3 },
  { label: '1/2',  steps: 1 / 2 },
  { label: '1/3',  steps: 1 / 3 },
  { label: '1/4',  steps: 1 / 4 },
  { label: '1/6',  steps: 1 / 6 },
  { label: '1/8',  steps: 1 / 8 },
  { label: '1/16', steps: 1 / 16 },
];

export const ENV_SYNC_LABELS: readonly string[] = ENV_SYNC_DIVISIONS.map(d => d.label);
export const ENV_SYNC_DEFAULT_LABEL = '1';
export const ENV_SYNC_DEFAULT_INDEX = ENV_SYNC_LABELS.indexOf(ENV_SYNC_DEFAULT_LABEL);

/** Step-division label + BPM → duration in seconds (steps × one step's length,
 *  (60/bpm)/4). Unknown label falls back to the default division, so a
 *  corrupt/legacy note-division value can never yield NaN. */
export function envDivisionToSeconds(label: string, bpm: number): number {
  const entry = ENV_SYNC_DIVISIONS.find(d => d.label === label)
    ?? ENV_SYNC_DIVISIONS[ENV_SYNC_DEFAULT_INDEX];
  return (entry.steps * 15) / bpm;
}

/** Division label → its index; unknown label → the default index. */
export function envDivisionLabelToIndex(label: string): number {
  const i = ENV_SYNC_LABELS.indexOf(label);
  return i < 0 ? ENV_SYNC_DEFAULT_INDEX : i;
}
```

In `packages/shared/src/engines/index.ts`, after `export * from './lfo-sync.js';` add:

```ts
export * from './env-sync.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run (cwd `packages/shared`): `npx vitest run src/engines/env-sync.test.ts` — PASS.
Then the full shared gate: `npx vitest run && npx tsc --noEmit` — all green (this task is purely additive).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/engines/env-sync.ts packages/shared/src/engines/env-sync.test.ts packages/shared/src/engines/index.ts
git commit -m "feat(shared): env-sync step-division table + envDivisionToSeconds/envDivisionLabelToIndex"
```

(Append the two standard trailer lines from Global Constraints to the commit message.)

---

### Task 2: The vocabulary flip — descriptors + AudioEngine + fixtures (ONE commit)

This is the atomic cross-package flip. Splitting it leaves a red tree: the
descriptor swap changes `DEFAULT_SYNTH2_PARAMS` labels, which client fixtures
assert. Everything below lands in a single commit.

**Files:**
- Modify: `packages/shared/src/engines/synth2-descriptors.ts` (imports, comment block ~168-174, the 9 div rows at 176-186)
- Modify: `packages/shared/src/engines/synth2-descriptors.test.ts` (env sync describe block, ~line 256)
- Modify: `packages/shared/src/engines/lfo-sync.ts` (delete `divisionToSeconds`, lines 54-61)
- Modify: `packages/shared/src/engines/lfo-sync.test.ts` (delete the `divisionToSeconds` describe block + its import)
- Modify: `packages/shared/src/engines/synth2.ts` (doc comment on `Synth2EnvParams` only)
- Modify: `packages/shared/src/project/schema.test.ts:141` (env3 fixture labels)
- Modify: `packages/client/src/audio/AudioEngine.ts` (import line 2, comment ~80-83, `effectiveEnvTimes` ~84-92)
- Modify: `packages/client/src/audio/AudioEngine.test.ts` (env sync describe block, ~line 237)
- Modify: `packages/client/src/project/reconcile.test.ts:152` (defaults fixture labels)

**Interfaces:**
- Consumes (from Task 1, via `@fiddle/shared`): `ENV_SYNC_LABELS`, `ENV_SYNC_DEFAULT_LABEL`, `envDivisionToSeconds(label: string, bpm: number): number`.
- Produces: `DEFAULT_SYNTH2_PARAMS.env*.{aDiv,dDiv,rDiv}` become `'1/2'`/`'2'`/`'4'`; `divisionToSeconds` no longer exists (Task 3 must not reference it).

- [ ] **Step 1: Update the shared tests to the new vocabulary (failing first)**

In `packages/shared/src/engines/synth2-descriptors.test.ts`, add `ENV_SYNC_LABELS` to the existing import from the engines barrel (alongside `LFO_SYNC_LABELS`), and replace the envelope tempo-sync describe block (~line 256) with:

```ts
describe('envelope tempo-sync descriptor rows (step divisions, 2026-07-08)', () => {
  it('envelope div rows: bool + three ENV_SYNC_LABELS enums per envelope, defaults 1/2 / 2 / 4 steps', () => {
    for (const env of ['env1', 'env2', 'env3']) {
      const sync = SYNTH2_DESCRIPTORS.find(d => d.key === `${env}.sync`)!;
      expect(sync.kind, sync.key).toBe('bool');
      expect(sync.default, sync.key).toBe(0); // off
      expect(sync.modulatable, sync.key).toBe(false);
      const stageDefaults = { aDiv: '1/2', dDiv: '2', rDiv: '4' } as const;
      for (const [field, label] of Object.entries(stageDefaults)) {
        const d = SYNTH2_DESCRIPTORS.find(x => x.key === `${env}.${field}`)!;
        expect(d.kind, d.key).toBe('enum');
        expect(d.enumValues, d.key).toBe(ENV_SYNC_LABELS);
        expect(d.min, d.key).toBe(0);
        expect(d.max, d.key).toBe(ENV_SYNC_LABELS.length - 1);
        expect(d.default, d.key).toBe(ENV_SYNC_LABELS.indexOf(label));
        expect(d.modulatable, d.key).toBe(false);
      }
    }
  });

  it('LFO div rows keep the note-division vocabulary (two vocabularies stay separate)', () => {
    for (const key of ['lfo1.div', 'lfo2.div']) {
      expect(SYNTH2_DESCRIPTORS.find(d => d.key === key)!.enumValues).toBe(LFO_SYNC_LABELS);
    }
  });
});
```

In `packages/shared/src/engines/lfo-sync.test.ts`: remove `divisionToSeconds` from the import at line 4 and delete the entire `describe('divisionToSeconds', …)` block (lines ~57-72; it ends with the reciprocal-of-`divisionToHz` loop test). Everything else in the file stays.

In `packages/shared/src/project/schema.test.ts` line 141, replace the env3 override labels with valid step labels:

```ts
    base.env3 = { a: 1, d: 2, s: 0.3, r: 1.5, loop: true, sync: false, aDiv: '1/2', dDiv: '2', rDiv: '4' };
```

- [ ] **Step 2: Run shared tests to verify the expected failures**

Run (cwd `packages/shared`): `npx vitest run`
Expected: the new descriptor assertions FAIL (rows still carry `LFO_SYNC_LABELS` / old defaults); everything else passes.

- [ ] **Step 3: Flip the descriptor rows**

In `packages/shared/src/engines/synth2-descriptors.ts`:

Line 12, extend the imports:

```ts
import { LFO_SYNC_LABELS, LFO_SYNC_DEFAULT_INDEX } from './lfo-sync.js';
import { ENV_SYNC_LABELS } from './env-sync.js';
```

Replace the comment block above `env1.sync` (~lines 168-174) with:

```ts
  // --- Envelope tempo-sync (2026-07-06; step-fraction vocabulary 2026-07-08,
  // in-place enumValues swap — row count/positions unchanged, so append-only
  // holds). Opt-in per ENVELOPE: one sync toggle switches that envelope's
  // A/D/R to sequencer-step fractions (each stage keeps its own division).
  // Derived SECONDS are computed on the MAIN THREAD (AudioEngine,
  // envDivisionToSeconds) and written into env*.a/d/r before reaching the
  // kernel — these 12 rows are dead block slots exactly like lfo*.sync/div,
  // kept so the leaves auto-derive (schema/accept-list/defaults). Per-stage
  // defaults keep the old note-division defaults' durations
  // (62.5ms / 250ms / 500ms @ 120 BPM).
```

Replace the 9 div rows (the `env*.sync` bool rows between them are untouched):

```ts
  { key: 'env1.aDiv', min: 0, max: ENV_SYNC_LABELS.length - 1, default: ENV_SYNC_LABELS.indexOf('1/2'), taper: 'linear', modulatable: false, modScale: 0, kind: 'enum', enumValues: ENV_SYNC_LABELS },
  { key: 'env1.dDiv', min: 0, max: ENV_SYNC_LABELS.length - 1, default: ENV_SYNC_LABELS.indexOf('2'),   taper: 'linear', modulatable: false, modScale: 0, kind: 'enum', enumValues: ENV_SYNC_LABELS },
  { key: 'env1.rDiv', min: 0, max: ENV_SYNC_LABELS.length - 1, default: ENV_SYNC_LABELS.indexOf('4'),   taper: 'linear', modulatable: false, modScale: 0, kind: 'enum', enumValues: ENV_SYNC_LABELS },
```

…and identically for `env2.aDiv/dDiv/rDiv` and `env3.aDiv/dDiv/rDiv` (same three lines with the key prefix changed).

In `packages/shared/src/engines/lfo-sync.ts`: delete the `divisionToSeconds` function and its doc comment (lines 54-61). `divisionToHz`, `divisionLabelToIndex`, and everything else stay.

In `packages/shared/src/engines/synth2.ts`, update the `Synth2EnvParams` doc comments only (fields unchanged):

```ts
  sync: boolean;  // tempo-sync on/off (a/d/r derived from divs × bpm on the main thread)
  aDiv: string;   // step-division labels from ENV_SYNC_DIVISIONS (used when sync is on)
  dDiv: string;
  rDiv: string;
```

- [ ] **Step 4: Run the shared suite**

Run (cwd `packages/shared`): `npx vitest run && npx tsc --noEmit`
Expected: all green. (Client is now red until Step 5 — that is why this task is one commit.)

- [ ] **Step 5: Switch AudioEngine derivation**

In `packages/client/src/audio/AudioEngine.ts` line 2:

```ts
import { TRACK_POOL_SIZE, divisionToHz, envDivisionToSeconds, ENV_SYNC_DEFAULT_LABEL, LFO_SYNC_DEFAULT_LABEL } from '@fiddle/shared';
```

(`LFO_SYNC_DEFAULT_LABEL` stays — `effectiveLfoRate` still uses it.)

Replace the comment above `effectiveEnvTimes` (~lines 80-83) and the function body:

```ts
// A synced envelope's A/D/R times are derived on the main thread from its
// step divisions and the project BPM (the kernel is tempo-agnostic); a free
// envelope uses its stored seconds. Within BPM 40–240 the derived range is
// 3.9ms (1/16 step @240) – 12s (32 steps @40), so the 10s ceiling is
// load-bearing at the slow extreme; the floor is defensive.
function effectiveEnvTimes(
  env: { sync?: boolean; aDiv?: string; dDiv?: string; rDiv?: string; a: number; d: number; r: number },
  bpm: number,
): { a: number; d: number; r: number } {
  if (!env.sync) return { a: env.a, d: env.d, r: env.r };
  const t = (label: string | undefined) =>
    Math.min(10, Math.max(0.001, envDivisionToSeconds(label ?? ENV_SYNC_DEFAULT_LABEL, bpm)));
  return { a: t(env.aDiv), d: t(env.dDiv), r: t(env.rDiv) };
}
```

Nothing else in AudioEngine changes (the three wiring sites call `effectiveEnvTimes` unchanged).

- [ ] **Step 6: Update the client tests**

In `packages/client/src/audio/AudioEngine.test.ts`, `describe('AudioEngine — envelope tempo-sync time derivation')` (~line 237) — the helper stays; update these cases:

The BPM-change test (defaults are now step labels with the same durations):

```ts
  it('re-pushes derived A/D/R seconds to a synced envelope on BPM change', async () => {
    const { set, spy } = await synth2EnvEngine({ sync: true }); // divs at defaults 1/2, 2, 4 steps
    set(['bpm'], 120);
    // @120 (step = 125ms): 1/2 step = 62.5ms, 2 steps = 250ms, 4 steps = 500ms
    expect(spy).toHaveBeenCalledWith({ env1: expect.objectContaining({ a: 0.0625, d: 0.25, r: 0.5 }) });
  });
```

The div-change test:

```ts
  it('derives times when a synced envelope div changes', async () => {
    const { set, spy } = await synth2EnvEngine({ sync: true });
    set(['tracks', 0, 'engines', 'synth2', 'env1', 'dDiv'], '1/4'); // quarter step @120 → 31.25ms
    expect(spy).toHaveBeenCalledWith({ env1: expect.objectContaining({ d: 0.03125 }) });
  });
```

The sustain/loop ride-through test keeps its expected `d` by using the step
label with the same duration (`'2'` steps = 250ms @120):

```ts
  it('sustain and loop ride through unchanged when synced', async () => {
    const { set, spy } = await synth2EnvEngine({ sync: true, dDiv: '2' });
    set(['tracks', 0, 'engines', 'synth2', 'env1', 's'], 0.7);
    expect(spy).toHaveBeenCalledWith({ env1: expect.objectContaining({ s: 0.7, d: 0.25 }) });
  });
```

The 'derives times when SYNC is turned on' and leaf-preservation tests keep
their existing expected values (`a: 0.0625, d: 0.25, r: 0.5` / `d: 0.25`) —
the new defaults produce identical durations; only update the comment on the
leaf-preservation expectation if it mentions note divisions.

Add two new cases at the end of the describe block:

```ts
  it('clamps the slow extreme: 32 steps @ 40 BPM → 10s ceiling', async () => {
    const { set, spy } = await synth2EnvEngine({ sync: true, aDiv: '32' });
    set(['bpm'], 40); // 32 steps @40 = 12s pre-clamp
    expect(spy).toHaveBeenCalledWith({ env1: expect.objectContaining({ a: 10 }) });
  });

  it('falls back to one step for a legacy note-division label', async () => {
    const { set, spy } = await synth2EnvEngine({ sync: true, dDiv: '1/32T' }); // pre-2026-07-08 label
    set(['bpm'], 120);
    expect(spy).toHaveBeenCalledWith({ env1: expect.objectContaining({ d: 0.125 }) }); // 1 step @120
  });
```

In `packages/client/src/project/reconcile.test.ts` line 152, update the expected defaults:

```ts
      sync: false, aDiv: '1/2', dDiv: '2', rDiv: '4',
```

- [ ] **Step 7: Run the client suite**

Run (cwd `packages/client`): `npx vitest run`
Expected: all green, including Synth2Panel tests — the panel still renders env divs through `LFO_SYNC_LABELS` until Task 3. The new defaults resolve as: `'1/2'` exists in the LFO vocabulary, `'2'`/`'4'` do not and hit `divisionLabelToIndex`'s default-index fallback — either way no panel test asserts env div knob positions, so nothing fails. If any panel test unexpectedly fails, STOP and report — do not patch Synth2Panel in this task.

- [ ] **Step 8: Commit (one commit, both packages)**

```bash
git add packages/shared/src/engines/synth2-descriptors.ts packages/shared/src/engines/synth2-descriptors.test.ts packages/shared/src/engines/lfo-sync.ts packages/shared/src/engines/lfo-sync.test.ts packages/shared/src/engines/synth2.ts packages/shared/src/project/schema.test.ts packages/client/src/audio/AudioEngine.ts packages/client/src/audio/AudioEngine.test.ts packages/client/src/project/reconcile.test.ts
git commit -m "feat: swap envelope A/D/R sync to step-fraction divisions (descriptors + AudioEngine)"
```

(Append the two standard trailer lines from Global Constraints to the commit message.)

---

### Task 3: Synth2Panel — synced A/D/R knobs use the step vocabulary

**Files:**
- Modify: `packages/client/src/components/Synth2Panel.vue` (import line ~232; the 9 synced env A/D/R knobs at lines ~40, 42, 45, 148, 150, 153, 166, 168, 171)
- Modify: `packages/client/src/components/Synth2Panel.test.ts` (env tempo-sync describe block, ~line 318)

**Interfaces:**
- Consumes (from Task 1, via `@fiddle/shared`): `ENV_SYNC_LABELS`, `envDivisionLabelToIndex(label: string): number`.
- Produces: nothing downstream; final code task.

- [ ] **Step 1: Update the panel tests to the new vocabulary (failing first)**

In `packages/client/src/components/Synth2Panel.test.ts`, inside `describe('Synth2Panel envelope tempo-sync')`:

Replace the synced-labels test (the old distinctive labels were note divisions that no longer exist in the env vocabulary):

```ts
  it('shows step-division labels on A/D/R when synced while S stays a percent knob', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    params.env1.sync = true;
    params.env1.aDiv = '2/3';  // distinctive step labels that appear nowhere else
    params.env1.dDiv = '1/6';
    params.env1.rDiv = '3/4';
    const el = mountPanel(params);
    expect(el.textContent).toContain('2/3');
    expect(el.textContent).toContain('1/6');
    expect(el.textContent).toContain('3/4');
    expect(el.textContent).toContain('50%'); // env1.s default 0.5 still renders as percent
  });
```

Replace the free-mode test (the old assertion pinned the retired `'1/32'` default):

```ts
  it('free mode still shows time readouts (no division labels)', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    params.env1.aDiv = '2/3'; // distinctive; must stay hidden while free
    const el = mountPanel(params);
    expect(el.textContent).not.toContain('2/3');
  });
```

Add a two-vocabularies guard at the end of the describe block:

```ts
  it('env knobs use step labels while LFO Rate keeps note-division labels', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    params.env1.sync = true;
    params.env1.aDiv = '1/6';   // step label — not in the LFO vocabulary
    params.lfo1.sync = true;
    params.lfo1.div = '1/8.';   // dotted note label — not in the env vocabulary
    const el = mountPanel(params);
    expect(el.textContent).toContain('1/6');
    expect(el.textContent).toContain('1/8.');
  });
```

The `.env-sync-btn` count and `env1.sync` dispatch tests are untouched.

- [ ] **Step 2: Run panel tests to verify the expected failures**

Run (cwd `packages/client`): `npx vitest run src/components/Synth2Panel.test.ts`
Expected: the two rewritten tests FAIL (env knobs still render through `LFO_SYNC_LABELS`, where `'2/3'`/`'1/6'`/`'3/4'` don't exist, so the knobs fall back to the LFO default label); the count/dispatch tests still pass.

- [ ] **Step 3: Swap the knob vocabulary**

In `packages/client/src/components/Synth2Panel.vue` line ~232, extend the shared import:

```ts
import { MOD_SOURCES, MOD_DESTS, LFO_SYNC_LABELS, divisionLabelToIndex, ENV_SYNC_LABELS, envDivisionLabelToIndex } from '@fiddle/shared';
```

In each of the 9 synced env A/D/R knobs (lines ~40, 42, 45 for env1; ~148, 150, 153 for env2; ~166, 168, 171 for env3) replace every `LFO_SYNC_LABELS` with `ENV_SYNC_LABELS` and every `divisionLabelToIndex` with `envDivisionLabelToIndex`. Pattern (env1 A shown; the other eight are the identical transformation with their own field/env names):

```html
<Knob v-else label="A" :min="0" :max="ENV_SYNC_LABELS.length - 1" :step="1" :labels="ENV_SYNC_LABELS" :defaultValue="envDivisionLabelToIndex(DEFAULTS.env1.aDiv)" :modelValue="envDivisionLabelToIndex(params.env1.aDiv)" @update:modelValue="ks.set(['env1', 'aDiv'], ENV_SYNC_LABELS[$event])" :syncPath="ks.pathFor(['env1', 'aDiv'])" @gesture-end="ks.end(['env1', 'aDiv'])" />
```

The two LFO Rate knobs (lines ~185, 195) keep `LFO_SYNC_LABELS`/`divisionLabelToIndex` — do not touch them. No template layout, button, or CSS changes.

- [ ] **Step 4: Run the client suite**

Run (cwd `packages/client`): `npx vitest run`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/components/Synth2Panel.vue packages/client/src/components/Synth2Panel.test.ts
git commit -m "feat(client): step-division labels on synced env A/D/R knobs in Synth2Panel"
```

(Append the two standard trailer lines from Global Constraints to the commit message.)

---

## Whole-Branch Verification (after all tasks)

1. **Full gate** (from repo root):
   - `cd packages/shared && npx vitest run && npx tsc --noEmit`
   - `cd packages/client && npx vitest run && npx vite build`
   - `cd packages/server && npx vitest run`
2. **Browser verification (mandatory, `npm run dev:obs`, throwaway session, Playwright MCP or Claude-in-Chrome):**
   - Patch `MessagePort.prototype.postMessage` in-page to capture synth2 `{type:'params', block}` posts; env1 block slots: a=5, d=6, s=7, r=8.
   - [ ] Sync env1 on @ 120 BPM with defaults → block a/d/r = 0.0625 / 0.25 / 0.5 (same durations as before, now from step labels `1/2`/`2`/`4`) while the store leaves keep their free seconds.
   - [ ] Set aDiv to `1/8` → block a = 0.015625 (an option that did not exist before).
   - [ ] BPM 120 → 60 doubles the derived times (a = 0.03125 with aDiv `1/8`).
   - [ ] SYNC off → block a/d/r return to the stored free values.
   - [ ] UI: synced env A/D/R knobs read step labels (`1/2`, `2`, `4`, `1/8`…); synced LFO Rate still reads note labels (`1/16`, `1/8.`…).
   - [ ] Clean console (favicon 404 tolerated); stop playback; close the browser session.
3. Then use superpowers:finishing-a-development-branch.
