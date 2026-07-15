# synth2 Label Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every synth2 param a display label in the shared descriptor table and render the mod-matrix dropdowns, panel knobs, and envelope headers from that single vocabulary so they can never drift again.

**Architecture:** Presentational `label`/`shortLabel` fields ride the existing single-source-of-truth descriptor table in `@fiddle/shared`; a sibling `synth2-labels.ts` adds module/source/env-role maps and a `modDestLabel()` composer. `Synth2Panel.vue` swaps its hand-written strings for lookups. `MOD_SOURCES`/`MOD_DESTS` (the wire encoding) are untouched; labels never travel on the wire.

**Tech Stack:** TypeScript (strict), Vue 3 SFC, Vitest, npm workspaces monorepo.

**Spec:** `docs/superpowers/specs/2026-07-15-synth2-label-unification-design.md`

## Global Constraints

- Branch: `feat/synth2-label-unification` (already created; **never commit on `main`**).
- `MOD_SOURCES` / `MOD_DESTS` arrays and all descriptor `key`/order stay byte-identical — array position is the wire encoding.
- Do **not** mount `.vue` files in tests (repo convention).
- Commit only the files named in each task — never `git add -A`. Untracked scratch files at repo root (`*.png`, `studio-focused.md`) must never be staged.
- Merge gate (run before declaring done): `npm run typecheck && npm test && npm run build`.
- Local browser testing uses `npm run dev:obs` (local Docker DB) — **NEVER `npm run dev`** (prod Supabase, data-loss risk). If the port is already in use, the user's server is running: reuse it, never kill it.
- End commit messages with the trailer:
  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01PNBh9TFQZuxkRjuNuHmQC6
  ```

---

### Task 1: `label` / `shortLabel` fields on the descriptor table

**Files:**
- Modify: `packages/shared/src/engines/synth2-descriptors.ts` (interface + all 68 rows)
- Test: `packages/shared/src/engines/synth2-descriptors.test.ts` (append a describe block)

**Interfaces:**
- Consumes: nothing new.
- Produces: `Synth2ParamDescriptor.label: string` (required), `Synth2ParamDescriptor.shortLabel?: string`. Task 2 reads both; Task 3 reads them via Task 2's helpers.

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/src/engines/synth2-descriptors.test.ts`:

```ts
describe('display labels (2026-07-15 label unification)', () => {
  it('every descriptor has a non-empty label with no dots (never a raw wire key)', () => {
    for (const d of SYNTH2_DESCRIPTORS) {
      expect(d.label, d.key).toBeTruthy();
      expect(d.label, d.key).not.toContain('.');
    }
  });

  it('env stage rows carry the terse knob shortLabel (A/D/S/R); no other row has one', () => {
    const short = Object.fromEntries(
      SYNTH2_DESCRIPTORS.filter(d => d.shortLabel !== undefined).map(d => [d.key, d.shortLabel]),
    );
    expect(short).toEqual({
      'env1.a': 'A', 'env1.d': 'D', 'env1.s': 'S', 'env1.r': 'R',
      'env2.a': 'A', 'env2.d': 'D', 'env2.s': 'S', 'env2.r': 'R',
      'env3.a': 'A', 'env3.d': 'D', 'env3.s': 'S', 'env3.r': 'R',
    });
  });

  it('pins the user-facing vocabulary for the modulatable pitch/filter rows', () => {
    const byKey = Object.fromEntries(SYNTH2_DESCRIPTORS.map(d => [d.key, d]));
    expect(byKey['osc1.coarse'].label).toBe('Octave');
    expect(byKey['osc1.fine'].label).toBe('Detune');
    expect(byKey['osc1.pulseWidth'].label).toBe('PW');
    expect(byKey['filter.resonance'].label).toBe('Res');
    expect(byKey['filter.keyTrack'].label).toBe('KeyTrk');
    expect(byKey['fm.osc2'].label).toBe('FM 1→2');
    expect(byKey['fm.osc3'].label).toBe('FM 2→3');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @fiddle/shared -- synth2-descriptors`
Expected: FAIL — `d.label` is `undefined` (also TS errors once the interface changes; that's fine, Vitest runs through the TS pipeline).

- [ ] **Step 3: Add the fields to the interface**

In `packages/shared/src/engines/synth2-descriptors.ts`, extend `Synth2ParamDescriptor` (after the `curve?` member):

```ts
  /** Human-readable param name (presentational only — never on the wire).
   *  Composed with SYNTH2_MODULE_LABELS into mod-matrix option text; also the
   *  panel knob label unless shortLabel overrides it. */
  label: string;
  /** Terse knob-face variant (e.g. 'A' for 'Attack'). Knobs render
   *  shortLabel ?? label; the matrix always uses the full label. */
  shortLabel?: string;
```

Making `label` required is deliberate: a future descriptor append without a label is a compile error (the anti-drift guarantee).

- [ ] **Step 4: Add `label` (and `shortLabel`) to every row**

Add `label: '<value>'` to each of the 68 rows per this complete table (and `shortLabel` only on the 12 env-stage rows). Keys are listed exhaustively; N ∈ {1,2,3} where shown:

| Rows | `label` | `shortLabel` |
|---|---|---|
| `oscN.morph` | `'Morph'` | — |
| `oscN.pulseWidth` | `'PW'` | — |
| `oscN.coarse` | `'Octave'` | — |
| `oscN.fine` | `'Detune'` | — |
| `oscN.level` | `'Level'` | — |
| `oscN.sync` | `'Sync'` | — |
| `envN.a` | `'Attack'` | `'A'` |
| `envN.d` | `'Decay'` | `'D'` |
| `envN.s` | `'Sustain'` | `'S'` |
| `envN.r` | `'Release'` | `'R'` |
| `envN.loop` | `'Loop'` | — |
| `envN.sync` | `'Sync'` | — |
| `envN.aDiv` / `dDiv` / `rDiv` | `'Attack Div'` / `'Decay Div'` / `'Release Div'` | — |
| `noise.level` | `'Level'` | — |
| `noise.color` | `'Color'` | — |
| `fm.osc2` | `'FM 1→2'` | — |
| `fm.osc3` | `'FM 2→3'` | — |
| `filter.cutoff` | `'Cutoff'` | — |
| `filter.resonance` | `'Res'` | — |
| `filter.keyTrack` | `'KeyTrk'` | — |
| `filter.envAmount` | `'EnvAmt'` | — |
| `filter.type` | `'Type'` | — |
| `filter.morph` | `'Morph'` | — |
| `filter.model` | `'Model'` | — |
| `filter.drive` | `'Drive'` | — |
| `lfoN.rate` | `'Rate'` | — |
| `lfoN.shape` | `'Shape'` | — |
| `lfoN.sync` | `'Sync'` | — |
| `lfoN.div` | `'Div'` | — |
| `lfoN.mode` | `'Mode'` | — |

Example of the edit shape (first rows — apply the same pattern everywhere):

```ts
  { key: 'osc1.morph',      min: 0,     max: 3,    default: 2,    taper: 'linear',     modulatable: true, modScale: 1, label: 'Morph' },
  { key: 'osc1.pulseWidth', min: 0.05,  max: 0.95, default: 0.5,  taper: 'linear',     modulatable: true, modScale: 1, label: 'PW' },
  ...
  { key: 'env1.a',          min: 0.001, max: 10,   default: 0.01, taper: 'expOctaves', modulatable: true, modScale: 4, curve: 'exp', label: 'Attack', shortLabel: 'A' },
```

Do NOT touch `key`, order, or any numeric/kind field.

- [ ] **Step 5: Run the shared tests + typecheck**

Run: `npm test -w @fiddle/shared -- synth2-descriptors` then `npm run typecheck`
Expected: all PASS (typecheck across the whole monorepo confirms no row was missed and no consumer broke).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/engines/synth2-descriptors.ts packages/shared/src/engines/synth2-descriptors.test.ts
git commit -m "feat(shared): presentational label/shortLabel on every synth2 descriptor"
```

---

### Task 2: `synth2-labels.ts` — module/source/env-role maps + `modDestLabel()`

**Files:**
- Create: `packages/shared/src/engines/synth2-labels.ts`
- Create: `packages/shared/src/engines/synth2-labels.test.ts`
- Modify: `packages/shared/src/engines/index.ts` (add one export line)

**Interfaces:**
- Consumes: `SYNTH2_DESCRIPTORS`, `MOD_DESTS`, `MOD_SOURCES`, `Synth2ModSource` from `./synth2-descriptors.js`.
- Produces (Task 3 imports all four from `@fiddle/shared`):
  - `SYNTH2_MODULE_LABELS: Readonly<Record<string, string | null>>`
  - `SYNTH2_ENV_ROLES: Readonly<Record<'env1' | 'env2' | 'env3', string>>`
  - `MOD_SOURCE_LABELS: Readonly<Record<Synth2ModSource, string>>`
  - `modDestLabel(key: string): string`
  - `knobLabel(key: string): string`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/engines/synth2-labels.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  SYNTH2_MODULE_LABELS, SYNTH2_ENV_ROLES, MOD_SOURCE_LABELS, modDestLabel, knobLabel,
} from './synth2-labels.js';
import { SYNTH2_DESCRIPTORS, MOD_SOURCES, MOD_DESTS } from './synth2-descriptors.js';

describe('MOD_SOURCE_LABELS', () => {
  it('labels every wire source (spec vocabulary)', () => {
    expect(MOD_SOURCE_LABELS).toEqual({
      none: 'None', lfo1: 'LFO 1', lfo2: 'LFO 2',
      env1: 'Env 1 (Amp)', env2: 'Env 2 (Filter)', env3: 'Env 3 (Mod)',
      velocity: 'Velocity', noise: 'Noise',
    });
    for (const s of MOD_SOURCES) expect(MOD_SOURCE_LABELS[s]).toBeTruthy();
  });

  it('composes env source labels from SYNTH2_ENV_ROLES (role written once)', () => {
    expect(SYNTH2_ENV_ROLES).toEqual({ env1: 'Amp', env2: 'Filter', env3: 'Mod' });
    expect(MOD_SOURCE_LABELS.env1).toBe(`Env 1 (${SYNTH2_ENV_ROLES.env1})`);
  });
});

describe('modDestLabel', () => {
  it('maps none and composes module prefix + param label', () => {
    expect(modDestLabel('none')).toBe('None');
    expect(modDestLabel('osc1.coarse')).toBe('Osc 1 Octave');
    expect(modDestLabel('osc3.fine')).toBe('Osc 3 Detune');
    expect(modDestLabel('filter.resonance')).toBe('Filter Res');
    expect(modDestLabel('env2.a')).toBe('Env 2 Attack');
    expect(modDestLabel('lfo1.rate')).toBe('LFO 1 Rate');
    expect(modDestLabel('noise.color')).toBe('Noise Color');
  });

  it('renders the fm rows with no module prefix', () => {
    expect(SYNTH2_MODULE_LABELS.fm).toBeNull();
    expect(modDestLabel('fm.osc2')).toBe('FM 1→2');
    expect(modDestLabel('fm.osc3')).toBe('FM 2→3');
  });

  it('gives every MOD_DESTS entry a friendly label distinct from the raw key', () => {
    for (const dest of MOD_DESTS) {
      const label = modDestLabel(dest);
      expect(label, dest).toBeTruthy();
      expect(label, dest).not.toBe(dest);
      expect(label, dest).not.toContain('.');
    }
  });

  it('never renders two dests identically (collision guard, incl. prefix-less FM)', () => {
    const labels = MOD_DESTS.map(modDestLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('falls back to the raw key for unknown keys (defensive; old client vs newer data)', () => {
    expect(modDestLabel('future.param')).toBe('future.param');
  });
});

describe('knobLabel', () => {
  it('prefers shortLabel (env stages) and falls back to label', () => {
    expect(knobLabel('env1.a')).toBe('A');
    expect(knobLabel('env3.r')).toBe('R');
    expect(knobLabel('osc1.coarse')).toBe('Octave');
    expect(knobLabel('fm.osc2')).toBe('FM 1→2');
  });

  it('covers every descriptor module with a SYNTH2_MODULE_LABELS entry', () => {
    for (const d of SYNTH2_DESCRIPTORS) {
      const mod = d.key.split('.')[0];
      expect(SYNTH2_MODULE_LABELS[mod], d.key).not.toBeUndefined();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @fiddle/shared -- synth2-labels`
Expected: FAIL — module `./synth2-labels.js` not found.

- [ ] **Step 3: Implement the module**

Create `packages/shared/src/engines/synth2-labels.ts`:

```ts
// Presentational names for synth2 params, modules, and mod sources — the ONE
// vocabulary the panel knobs, headers, and mod-matrix dropdowns all render
// from (spec: docs/superpowers/specs/2026-07-15-synth2-label-unification-design.md).
// Nothing here touches the wire: MOD_SOURCES/MOD_DESTS keep encoding raw keys.

import { SYNTH2_DESCRIPTORS, type Synth2ModSource } from './synth2-descriptors.js';

/** Module prefix for composed dest labels. null = render the param label bare
 *  (the fm rows carry their own routing name, 'FM 1→2'). */
export const SYNTH2_MODULE_LABELS: Readonly<Record<string, string | null>> = {
  osc1: 'Osc 1', osc2: 'Osc 2', osc3: 'Osc 3',
  noise: 'Noise', fm: null,
  env1: 'Env 1', env2: 'Env 2', env3: 'Env 3',
  filter: 'Filter', lfo1: 'LFO 1', lfo2: 'LFO 2',
};

/** What each numbered envelope is for. Composed into matrix source labels
 *  ('Env 1 (Amp)') and panel headers ('ENV 1 · AMP') — written exactly once. */
export const SYNTH2_ENV_ROLES: Readonly<Record<'env1' | 'env2' | 'env3', string>> = {
  env1: 'Amp', env2: 'Filter', env3: 'Mod',
};

export const MOD_SOURCE_LABELS: Readonly<Record<Synth2ModSource, string>> = {
  none: 'None',
  lfo1: 'LFO 1',
  lfo2: 'LFO 2',
  env1: `Env 1 (${SYNTH2_ENV_ROLES.env1})`,
  env2: `Env 2 (${SYNTH2_ENV_ROLES.env2})`,
  env3: `Env 3 (${SYNTH2_ENV_ROLES.env3})`,
  velocity: 'Velocity',
  noise: 'Noise',
};

const byKey = new Map(SYNTH2_DESCRIPTORS.map(d => [d.key, d]));

/** Mod-matrix dest option text: 'none' → 'None'; else module label + param
 *  label ('Osc 1 Octave'), bare param label when the module prefix is null
 *  ('FM 1→2'). Unknown keys fall back to the raw key so an old client never
 *  renders blank options against newer data. */
export const modDestLabel = (key: string): string => {
  if (key === 'none') return 'None';
  const d = byKey.get(key);
  if (!d) return key;
  const prefix = SYNTH2_MODULE_LABELS[key.split('.')[0]];
  return prefix ? `${prefix} ${d.label}` : d.label;
};

/** Knob-face text for a descriptor key: the terse variant when one exists
 *  ('A' for env stages), else the full label. Falls back to the raw key. */
export const knobLabel = (key: string): string => {
  const d = byKey.get(key);
  return d ? (d.shortLabel ?? d.label) : key;
};
```

Add to `packages/shared/src/engines/index.ts` after the `synth2-descriptors.js` line:

```ts
export * from './synth2-labels.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @fiddle/shared -- synth2-labels`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/engines/synth2-labels.ts packages/shared/src/engines/synth2-labels.test.ts packages/shared/src/engines/index.ts
git commit -m "feat(shared): synth2 label vocabulary (module/source/env-role maps + modDestLabel)"
```

---

### Task 3: Render `Synth2Panel.vue` from the shared vocabulary

**Files:**
- Modify: `packages/client/src/components/Synth2Panel.vue` (template + script imports only; no style changes)

**Interfaces:**
- Consumes: `MOD_SOURCE_LABELS`, `modDestLabel`, `knobLabel`, `SYNTH2_ENV_ROLES` from `@fiddle/shared` (Task 2).
- Produces: nothing downstream; this is the leaf.

No unit test (repo convention: never mount `.vue`). Verification = typecheck + build (this task) and the browser pass (Task 4).

- [ ] **Step 1: Update the script imports**

In the `<script setup>` block, extend the existing `@fiddle/shared` import:

```ts
import { MOD_SOURCES, MOD_DESTS, MOD_SOURCE_LABELS, modDestLabel, knobLabel, SYNTH2_ENV_ROLES, LFO_SYNC_LABELS, divisionLabelToIndex, ENV_SYNC_LABELS, ENV_SYNC_KNOB_LABELS, envDivisionLabelToIndex } from '@fiddle/shared';
```

- [ ] **Step 2: Matrix dropdowns render labels (values stay raw keys)**

In the MATRIX module (around lines 218–223), change only the option TEXT:

```html
<option v-for="src in MOD_SOURCES" :key="src" :value="src">{{ MOD_SOURCE_LABELS[src] }}</option>
```
```html
<option v-for="dst in MOD_DESTS" :key="dst" :value="dst">{{ modDestLabel(dst) }}</option>
```

`:value` keeps the raw key — stored projects, sync ops, and the kernel see no change.

- [ ] **Step 3: Envelope headers from the env-role table**

Replace the three headers:

```html
<h3>ENV 1 · {{ SYNTH2_ENV_ROLES.env1.toUpperCase() }}</h3>   <!-- was AMP ENV -->
<h3>ENV 2 · {{ SYNTH2_ENV_ROLES.env2.toUpperCase() }}</h3>   <!-- was FILTER ENV -->
<h3>ENV 3 · {{ SYNTH2_ENV_ROLES.env3.toUpperCase() }}</h3>   <!-- was ENV 3 -->
```

(Renders ENV 1 · AMP / ENV 2 · FILTER / ENV 3 · MOD.) All other `<h3>` headers stay as-is.

- [ ] **Step 4: Knob labels become lookups**

For every `Knob` whose param has a descriptor, replace the literal `label="…"` with `:label="knobLabel('<key>')"`. Complete mapping (values shown are what must render — identical to today except none change visually):

- Osc columns (N = 1,2,3): `knobLabel('oscN.morph')`→Morph, `('oscN.pulseWidth')`→PW, `('oscN.coarse')`→Octave, `('oscN.fine')`→Detune, `('oscN.level')`→Level.
- Noise: `knobLabel('noise.level')`→Level, `knobLabel('noise.color')`→Color.
- FM: `knobLabel('fm.osc2')`→FM 1→2, `knobLabel('fm.osc3')`→FM 2→3.
- Filter: `knobLabel('filter.morph')`→Morph, `('filter.cutoff')`→Cutoff, `('filter.resonance')`→Res, `('filter.keyTrack')`→KeyTrk, `('filter.envAmount')`→EnvAmt, `('filter.drive')`→Drive.
- Envelopes (N = 1,2,3): both the seconds-mode AND the sync-mode (Div) variants of each stage use the stage key: `:label="knobLabel('envN.a')"`→A, `('envN.d')`→D, `('envN.s')`→S, `('envN.r')`→R. The Div knobs deliberately reuse the stage key (the knob face must still read A/D/R in sync mode).
- LFOs (N = 1,2): both rate variants use `:label="knobLabel('lfoN.rate')"`→Rate; the shape knob `:label="knobLabel('lfoN.shape')"`→Shape.
- The matrix amount knob keeps its literal `label="Amt"` (not a descriptor).

Example (osc1 morph knob, line ~29):

```html
<Knob :label="knobLabel('osc1.morph')" :min="0" :max="3" :step="0.01" :defaultValue="DEFAULTS.osc1.morph" ... />
```

- [ ] **Step 5: Typecheck + full test suite + build**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green (this is the merge gate; Synth2Panel has a `.test.ts` that must stay green too).

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/components/Synth2Panel.vue
git commit -m "feat(client): synth2 panel renders matrix/knob/header text from shared label vocabulary"
```

---

### Task 4: Browser verification (mandatory before "done")

**Files:** none (verification only).

**Interfaces:** none.

- [ ] **Step 1: Start (or reuse) the local dev stack**

Run: `npm run dev:obs` in the background — **never `npm run dev`**. If ports are already bound, the user's server is running: reuse it and do not kill anything.

- [ ] **Step 2: Drive the app with Playwright MCP**

Open `http://localhost:5173`, create/open a session, switch a track to the synth2 engine, and verify:

1. Matrix source dropdown lists: None, LFO 1, LFO 2, Env 1 (Amp), Env 2 (Filter), Env 3 (Mod), Velocity, Noise.
2. Matrix dest dropdown shows friendly labels (Osc 1 Octave, Filter Res, FM 1→2, Env 3 Attack, …) — no raw `x.y` keys anywhere.
3. Selecting a source + dest still works: pick LFO 1 → Osc 1 Detune, turn Amt, confirm no console errors and (if playing) audible/updating behavior.
4. Headers read ENV 1 · AMP / ENV 2 · FILTER / ENV 3 · MOD; knob faces are unchanged (Octave, Detune, PW, A/D/S/R, …).
5. Dropdown text fits the narrow selects (no clipping worse than before).
6. Console is clean (no errors/warnings from the change).

- [ ] **Step 3: Report + clean up**

Report observations to the user. Close every browser tab/session opened and stop any dev server started by this task (only ones this task started). Leave the branch unmerged — the user browser-verifies and decides on merge per repo convention.
