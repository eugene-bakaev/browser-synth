# Non-Linear Knob Tapers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give knobs perceptual (non-linear) response curves so wide-range params (filter cutoff, ADSR times, LFO rates, drum tones/decays) are usable across the whole dial instead of bunching into a sliver of travel.

**Architecture:** A per-param `curve` (`linear | exp | invexp | s`) declared on the shared descriptor tables drives a pure client taper module (`knobTaper.ts`) that maps dial position ↔ value. `Knob.vue` routes its dial-angle and drag math through that module. The change is **purely presentational** — the value stored / synced / sent to the kernel is never warped, so there is no ABI, schema, migration, or sync impact.

**Tech Stack:** TypeScript, Vue 3 SFCs, Vitest (+ jsdom for component tests), pnpm/npm workspaces (`@fiddle/shared` + client).

**Spec:** `docs/superpowers/specs/2026-06-21-knob-tapers-design.md` (read §3 for the curve math, §5 for the assignment table).

## Global Constraints

- **Presentational only.** Never change the value flowing through `v-model` → store → sync → param block → kernel. No edits to schema, normalize, factory, storage, accept-list, or any kernel file.
- **Curve math lives in exactly one place:** `packages/client/src/ui/knobTaper.ts`. `Knob.vue` and tests call it; no curve formula is duplicated anywhere else.
- **`exp`/`invexp` are valid only on a strictly-positive range** (`min > 0`, `max > min`). The taper functions fall back to `linear` for any other range or non-finite input — a knob must never emit `NaN`. A contract test enforces no descriptor violates this.
- **Descriptor `curve` tags are canonical.** The synth2 panel mirrors them as static literals (it is hand-written, not descriptor-driven); the drum panels read `d.curve` directly.
- **Back-compat:** the `Knob` `curve` prop defaults to `'linear'`; any knob that doesn't pass it behaves exactly as today, including value-space `step` snapping.
- **Git:** branch `feat/knob-tapers` already exists and is checked out. Never `git add -A`/`git add .` — stage only the named files. Never commit on `main`. Do not push. Every commit ends with the trailer:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **Gate (AGENTS.md):** `npm run typecheck && npm test && npm run build` must be green before a task is done. Worklet bundles under `public/worklets/` are gitignored — never stage them.

---

### Task 1: Shared — `KnobCurve` type, descriptor `curve` field, per-param tags, contract test

**Files:**
- Create: `packages/shared/src/engines/knob-curve.ts`
- Create: `packages/shared/src/engines/knob-curve.test.ts`
- Modify: `packages/shared/src/engines/index.ts` (add one export line)
- Modify: `packages/shared/src/engines/drum-descriptors.ts` (import type + add field to `DrumParamDescriptor`)
- Modify: `packages/shared/src/engines/synth2-descriptors.ts` (import type + add field to `Synth2ParamDescriptor` + tag 13 rows)
- Modify: `packages/shared/src/engines/kick2.ts` (tag 3 rows)
- Modify: `packages/shared/src/engines/snare2.ts` (tag 4 rows)
- Modify: `packages/shared/src/engines/hat2.ts` (tag 3 rows)

**Interfaces:**
- Produces: `export type KnobCurve = 'linear' | 'exp' | 'invexp' | 's'` (from `@fiddle/shared`); an optional `curve?: KnobCurve` field on both `DrumParamDescriptor` and `Synth2ParamDescriptor`.

- [ ] **Step 1: Create the type module**

`packages/shared/src/engines/knob-curve.ts`:
```ts
// UI knob response curve (presentational only — see
// docs/superpowers/specs/2026-06-21-knob-tapers-design.md §3). Declared per-param
// on the descriptor tables; consumed by the client knob taper. Adding/omitting a
// curve never changes a stored/synced value, so this is NOT an ABI concern.
export type KnobCurve = 'linear' | 'exp' | 'invexp' | 's';
```

- [ ] **Step 2: Export it from the engines barrel**

In `packages/shared/src/engines/index.ts`, add (anywhere in the list):
```ts
export * from './knob-curve.js';
```

- [ ] **Step 3: Add the optional field to `DrumParamDescriptor`**

In `packages/shared/src/engines/drum-descriptors.ts`, add the import near the top (beside the existing `DrumKnobFormat` definition area):
```ts
import type { KnobCurve } from './knob-curve.js';
```
Then add this field to the `DrumParamDescriptor` interface, immediately after the `format: DrumKnobFormat;` line:
```ts
  /** Optional UI knob response curve (presentational only). Omitted ⇒ 'linear'. */
  curve?: KnobCurve;
```

- [ ] **Step 4: Add the optional field to `Synth2ParamDescriptor`**

In `packages/shared/src/engines/synth2-descriptors.ts`, add the import near the other top-of-file types:
```ts
import type { KnobCurve } from './knob-curve.js';
```
Then add this field to the `Synth2ParamDescriptor` interface, immediately after the `enumValues?: readonly string[];` line (i.e. as the last field before the closing `}`):
```ts
  /** Optional UI knob response curve (presentational only). Omitted ⇒ 'linear'.
   *  Distinct from `taper`, which scales kernel modulation, not the UI. */
  curve?: KnobCurve;
```

- [ ] **Step 5: Tag the synth2 rows**

In `packages/shared/src/engines/synth2-descriptors.ts`, append `, curve: 'exp'` immediately before the closing `}` of each of these 12 descriptor rows (identified by `key`):
`filter.cutoff`, `env1.a`, `env1.d`, `env1.r`, `env2.a`, `env2.d`, `env2.r`, `env3.a`, `env3.d`, `env3.r`, `lfo1.rate`, `lfo2.rate`.

And append `, curve: 's'` before the closing `}` of the `filter.resonance` row.

Example — the `filter.cutoff` row changes from:
```ts
  { key: 'filter.cutoff',   min: 20,    max: 20000, default: 2000, taper: 'expOctaves', modulatable: true,  modScale: 4 },
```
to:
```ts
  { key: 'filter.cutoff',   min: 20,    max: 20000, default: 2000, taper: 'expOctaves', modulatable: true,  modScale: 4, curve: 'exp' },
```
Change nothing else on any row (no reordering — the array position is the param-block ABI).

- [ ] **Step 6: Tag the drum rows**

Append `, curve: 'exp'` before the closing `}` of these rows (the freq/time params):
- `packages/shared/src/engines/kick2.ts`: rows `tune`, `pitchDecay`, `decay`.
- `packages/shared/src/engines/snare2.ts`: rows `tune`, `bodyDecay`, `noiseDecay`, `tone`.
- `packages/shared/src/engines/hat2.ts`: rows `tone`, `decay`, `hpf`.

Example — kick2 `tune` changes from:
```ts
  { key: 'tune',       min: 30,    max: 120, default: 50,   label: 'Tune',  format: 'hz' },
```
to:
```ts
  { key: 'tune',       min: 30,    max: 120, default: 50,   label: 'Tune',  format: 'hz', curve: 'exp' },
```

- [ ] **Step 7: Write the contract test**

`packages/shared/src/engines/knob-curve.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import {
  SYNTH2_DESCRIPTORS, KICK2_DESCRIPTORS, SNARE2_DESCRIPTORS, HAT2_DESCRIPTORS,
} from './index.js';

const ALL = [
  ['synth2', SYNTH2_DESCRIPTORS],
  ['kick2', KICK2_DESCRIPTORS],
  ['snare2', SNARE2_DESCRIPTORS],
  ['hat2', HAT2_DESCRIPTORS],
] as const;

describe('knob curve assignments', () => {
  it('exp/invexp are only declared on strictly-positive ranges', () => {
    for (const [name, table] of ALL) {
      for (const d of table) {
        if (d.curve === 'exp' || d.curve === 'invexp') {
          expect(d.min, `${name}.${d.key} min must be > 0`).toBeGreaterThan(0);
          expect(d.max, `${name}.${d.key} max must be > min`).toBeGreaterThan(d.min);
        }
      }
    }
  });

  it('the expected synth2 params carry exp, and resonance carries s', () => {
    const curveOf = new Map(SYNTH2_DESCRIPTORS.map(d => [d.key, d.curve]));
    for (const k of [
      'filter.cutoff',
      'env1.a', 'env1.d', 'env1.r',
      'env2.a', 'env2.d', 'env2.r',
      'env3.a', 'env3.d', 'env3.r',
      'lfo1.rate', 'lfo2.rate',
    ]) {
      expect(curveOf.get(k), `${k} should be exp`).toBe('exp');
    }
    expect(curveOf.get('filter.resonance')).toBe('s');
  });

  it('the expected drum freq/time params carry exp', () => {
    const has = (table: readonly { key: string; curve?: string }[], key: string) =>
      table.find(d => d.key === key)?.curve;
    expect(has(KICK2_DESCRIPTORS, 'tune')).toBe('exp');
    expect(has(KICK2_DESCRIPTORS, 'pitchDecay')).toBe('exp');
    expect(has(KICK2_DESCRIPTORS, 'decay')).toBe('exp');
    expect(has(SNARE2_DESCRIPTORS, 'tune')).toBe('exp');
    expect(has(SNARE2_DESCRIPTORS, 'bodyDecay')).toBe('exp');
    expect(has(SNARE2_DESCRIPTORS, 'noiseDecay')).toBe('exp');
    expect(has(SNARE2_DESCRIPTORS, 'tone')).toBe('exp');
    expect(has(HAT2_DESCRIPTORS, 'tone')).toBe('exp');
    expect(has(HAT2_DESCRIPTORS, 'decay')).toBe('exp');
    expect(has(HAT2_DESCRIPTORS, 'hpf')).toBe('exp');
  });
});
```

- [ ] **Step 8: Run typecheck + tests**

Run: `npm run typecheck && npm test`
Expected: typecheck exit 0; all tests pass including the new `knob curve assignments` suite (3 tests).

- [ ] **Step 9: Commit**

```bash
git add packages/shared/src/engines/knob-curve.ts packages/shared/src/engines/knob-curve.test.ts packages/shared/src/engines/index.ts packages/shared/src/engines/drum-descriptors.ts packages/shared/src/engines/synth2-descriptors.ts packages/shared/src/engines/kick2.ts packages/shared/src/engines/snare2.ts packages/shared/src/engines/hat2.ts
git commit -m "feat(knob-tapers): KnobCurve type + per-param curve tags on descriptors

Adds an optional presentational 'curve' field to the synth2 and drum descriptor
shapes, tags wide-range freq/time params exp (and synth2 resonance s), and a
contract test that exp/invexp live only on strictly-positive ranges.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Client — pure `knobTaper` module + unit tests

**Files:**
- Create: `packages/client/src/ui/knobTaper.ts`
- Create: `packages/client/src/ui/knobTaper.test.ts`

**Interfaces:**
- Consumes: `KnobCurve` from `@fiddle/shared` (Task 1).
- Produces:
  - `posToValue(curve: KnobCurve, pos: number, min: number, max: number): number` — dial travel `pos∈[0,1]` → value `∈[min,max]`.
  - `valueToPos(curve: KnobCurve, value: number, min: number, max: number): number` — value → dial travel `∈[0,1]`.
  - Both are mutual inverses (within float tolerance) and total — never throw, never return `NaN`.

- [ ] **Step 1: Write the failing tests**

`packages/client/src/ui/knobTaper.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { posToValue, valueToPos } from './knobTaper';
import type { KnobCurve } from '@fiddle/shared';

const CURVES: KnobCurve[] = ['linear', 'exp', 'invexp', 's'];
// Only strictly-positive ranges for exp/invexp; linear/s also fine here.
const RANGES: [number, number][] = [[20, 20000], [0.001, 10], [0.01, 2000], [30, 120]];

describe('knobTaper', () => {
  it('endpoints map to min/max (and back) for every curve and range', () => {
    for (const c of CURVES) for (const [min, max] of RANGES) {
      expect(posToValue(c, 0, min, max)).toBeCloseTo(min, 6);
      expect(posToValue(c, 1, min, max)).toBeCloseTo(max, 6);
      expect(valueToPos(c, min, min, max)).toBeCloseTo(0, 6);
      expect(valueToPos(c, max, min, max)).toBeCloseTo(1, 6);
    }
  });

  it('posToValue ∘ valueToPos is identity (round-trip) for every curve', () => {
    for (const c of CURVES) for (const [min, max] of RANGES) {
      for (let i = 0; i <= 10; i++) {
        const v = min + ((max - min) * i) / 10;
        expect(posToValue(c, valueToPos(c, v, min, max), min, max)).toBeCloseTo(v, 4);
      }
    }
  });

  it('is monotonically increasing in pos for every curve', () => {
    for (const c of CURVES) for (const [min, max] of RANGES) {
      let prev = -Infinity;
      for (let i = 0; i <= 20; i++) {
        const v = posToValue(c, i / 20, min, max);
        expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = v;
      }
    }
  });

  it('exp midpoint is the geometric mean (632 on 20..20000)', () => {
    expect(posToValue('exp', 0.5, 20, 20000)).toBeCloseTo(Math.sqrt(20 * 20000), 0);
  });

  it('linear midpoint is the arithmetic mean; s midpoint is the centre', () => {
    expect(posToValue('linear', 0.5, 0, 100)).toBeCloseTo(50, 6);
    expect(posToValue('s', 0.5, 0, 100)).toBeCloseTo(50, 6);
  });

  it('exp gives the low end real travel (200 Hz sits past 1/3 of the dial)', () => {
    expect(valueToPos('exp', 200, 20, 20000)).toBeGreaterThan(0.33);
    // linear buries the same value in the bottom ~1% of travel:
    expect(valueToPos('linear', 200, 20, 20000)).toBeLessThan(0.01);
  });

  it('exp/invexp on a non-positive range fall back to linear (no NaN)', () => {
    expect(posToValue('exp', 0.5, 0, 1)).toBeCloseTo(0.5, 6);
    expect(posToValue('invexp', 0.5, 0, 1)).toBeCloseTo(0.5, 6);
    expect(Number.isFinite(posToValue('exp', 0.5, -10, 10))).toBe(true);
  });

  it('non-finite / out-of-range input never throws or returns NaN', () => {
    expect(Number.isFinite(posToValue('exp', NaN, 20, 20000))).toBe(true);
    expect(valueToPos('exp', NaN, 20, 20000)).toBe(0);
    expect(valueToPos('exp', 1e9, 20, 20000)).toBeCloseTo(1, 6); // clamped
    expect(valueToPos('exp', -5, 20, 20000)).toBeCloseTo(0, 6);  // clamped
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- knobTaper`
Expected: FAIL — `knobTaper.ts` does not exist yet (module not found).

- [ ] **Step 3: Implement the module**

`packages/client/src/ui/knobTaper.ts`:
```ts
import type { KnobCurve } from '@fiddle/shared';

// A curve is a warp w(p): [0,1] → [0,1] applied to the dial travel p, then mapped
// linearly to [min,max]:  value = min + (max-min)·w(p).  See
// docs/superpowers/specs/2026-06-21-knob-tapers-design.md §3.
//
// exp/invexp involve a log and are valid only on a strictly-positive range
// (min>0, max>min). For any other range — or non-finite input — every function
// falls back to linear / clamps, so a knob can never emit NaN.

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Whether exp/invexp are mathematically valid for this range. */
function expUsable(min: number, max: number): boolean {
  return Number.isFinite(min) && Number.isFinite(max) && min > 0 && max > min;
}

/** Forward warp w(p): [0,1] → [0,1]. */
function warp(curve: KnobCurve, p: number, min: number, max: number): number {
  const t = clamp01(p);
  switch (curve) {
    case 'exp': {
      if (!expUsable(min, max)) return t;
      const r = max / min;
      return (Math.pow(r, t) - 1) / (r - 1);
    }
    case 'invexp': {
      if (!expUsable(min, max)) return t;
      const r = max / min;
      return 1 - (Math.pow(r, 1 - t) - 1) / (r - 1);
    }
    case 's':
      return t * t * (3 - 2 * t); // smoothstep
    case 'linear':
    default:
      return t;
  }
}

/** Inverse warp w⁻¹(u): [0,1] → [0,1]. */
function unwarp(curve: KnobCurve, u: number, min: number, max: number): number {
  const v = clamp01(u);
  switch (curve) {
    case 'exp': {
      if (!expUsable(min, max)) return v;
      const r = max / min;
      return Math.log(v * (r - 1) + 1) / Math.log(r);
    }
    case 'invexp': {
      if (!expUsable(min, max)) return v;
      const r = max / min;
      return 1 - Math.log((1 - v) * (r - 1) + 1) / Math.log(r);
    }
    case 's':
      // Closed-form inverse of smoothstep u = 3t²−2t³.
      return 0.5 - Math.sin(Math.asin(1 - 2 * v) / 3);
    case 'linear':
    default:
      return v;
  }
}

/** Dial travel pos∈[0,1] → parameter value, clamped to [min,max]. */
export function posToValue(curve: KnobCurve, pos: number, min: number, max: number): number {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max === min) return min;
  const value = min + (max - min) * warp(curve, pos, min, max);
  return value < min ? min : value > max ? max : value;
}

/** Parameter value → dial travel pos∈[0,1]. Out-of-range/non-finite values clamp. */
export function valueToPos(curve: KnobCurve, value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max) || max === min) {
    return 0;
  }
  const u = (value - min) / (max - min);
  return clamp01(unwarp(curve, u, min, max));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- knobTaper`
Expected: PASS — all assertions green.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/ui/knobTaper.ts packages/client/src/ui/knobTaper.test.ts
git commit -m "feat(knob-tapers): pure knobTaper module (pos<->value warps)

linear/exp/invexp/s warp + inverse, with linear fallback for non-positive ranges
and non-finite input. Fully unit-tested (round-trip, endpoints, monotonicity,
geometric-mean midpoint, NaN safety).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Client — wire `curve` into `Knob.vue`

**Files:**
- Modify: `packages/client/src/components/Knob.vue`
- Create: `packages/client/src/components/Knob.test.ts`

**Interfaces:**
- Consumes: `posToValue`, `valueToPos` (Task 2); `KnobCurve` from `@fiddle/shared` (Task 1).
- Produces: a `Knob` that accepts a `curve?: KnobCurve` prop (default `'linear'`) and uses it for the dial angle, the active-fill arc, and the drag mapping. Omitting the prop preserves today's exact linear behaviour including `step` snapping.

- [ ] **Step 1: Write the failing component test**

`packages/client/src/components/Knob.test.ts`:
```ts
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { createApp, type App } from 'vue';
import Knob from './Knob.vue';

let app: App | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = null;
  host = null;
});

function mountKnob(props: Record<string, unknown>): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  app = createApp(Knob, props);
  app.mount(host);
  return host;
}

/** The inner dial <g> carries `transform="rotate(angle 25 25)"`. */
function dialRotation(el: HTMLElement): number {
  const g = el.querySelector('g[transform]');
  const m = g?.getAttribute('transform')?.match(/rotate\(\s*([-\d.]+)/);
  return m ? parseFloat(m[1]) : NaN;
}

describe('Knob curve prop', () => {
  it('exp curve puts the geometric-mean value at the dial centre (angle ~0)', () => {
    const el = mountKnob({
      label: 'Cutoff', min: 20, max: 20000, step: 1,
      modelValue: Math.sqrt(20 * 20000), curve: 'exp',
    });
    expect(dialRotation(el)).toBeCloseTo(0, 0); // -135 + 0.5 * 270
  });

  it('without a curve prop, the arithmetic midpoint sits at the dial centre', () => {
    const el = mountKnob({ label: 'X', min: 0, max: 100, step: 1, modelValue: 50 });
    expect(dialRotation(el)).toBeCloseTo(0, 0);
  });

  it('exp curve rotates a low value well off the floor (vs linear)', () => {
    const expEl = mountKnob({ label: 'C', min: 20, max: 20000, step: 1, modelValue: 200, curve: 'exp' });
    const expAngle = dialRotation(expEl);
    app?.unmount(); host?.remove();
    const linEl = mountKnob({ label: 'C', min: 20, max: 20000, step: 1, modelValue: 200 });
    expect(expAngle).toBeGreaterThan(dialRotation(linEl) + 50);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- Knob.test`
Expected: FAIL — `exp` and linear render the same angle (Knob is still linear), so the exp assertions fail.

- [ ] **Step 3: Add the imports + `curve` prop to `Knob.vue`**

In the `<script setup>` of `packages/client/src/components/Knob.vue`, add to the imports (next to `import type { Path } from '@fiddle/shared';`):
```ts
import type { KnobCurve } from '@fiddle/shared';
import { posToValue, valueToPos } from '../ui/knobTaper';
```
In the `defineProps<{…}>()` type literal, add a `curve` field (next to `format?`):
```ts
  curve?: KnobCurve;
```
In the `withDefaults(…, { … })` defaults object, add:
```ts
  curve: 'linear',
```

- [ ] **Step 4: Route the dial angle and active arc through the taper**

Replace the `currentAngle` computed:
```ts
const currentAngle = computed(() => {
  const pct = (props.modelValue - props.min) / (props.max - props.min);
  return -135 + pct * 270;
});
```
with:
```ts
const currentAngle = computed(() => {
  const pos = valueToPos(props.curve, props.modelValue, props.min, props.max);
  return -135 + pos * 270;
});
```
Replace the `activePath` computed:
```ts
const activePath = computed(() => {
  const pct = (props.modelValue - props.min) / (props.max - props.min);
  const endAngle = -135 + pct * 270;
  return describeArc(25, 25, 18, -135, endAngle);
});
```
with:
```ts
const activePath = computed(() => {
  const pos = valueToPos(props.curve, props.modelValue, props.min, props.max);
  const endAngle = -135 + pos * 270;
  return describeArc(25, 25, 18, -135, endAngle);
});
```

- [ ] **Step 5: Route the drag through the taper (position space for non-linear)**

Replace the whole `onPointerMove` handler:
```ts
const onPointerMove = (e: PointerEvent) => {
  const deltaY = startY - e.clientY;
  const isFineTune = e.shiftKey;
  const dragRange = isFineTune ? 800 : 200; // Shift for fine-tuning
  const valueRange = props.max - props.min;
  const valueDelta = (deltaY / dragRange) * valueRange;
  
  let newValue = startValue + valueDelta;
  newValue = Math.max(props.min, Math.min(props.max, newValue));
  
  const stepsCount = Math.round((newValue - props.min) / props.step);
  newValue = props.min + stepsCount * props.step;
  newValue = Math.max(props.min, Math.min(props.max, newValue));
  
  const getPrecision = (num: number) => {
    const parts = num.toString().split('.');
    return parts.length > 1 ? parts[1].length : 0;
  };
  const precision = getPrecision(props.step);
  newValue = parseFloat(newValue.toFixed(precision));
  
  emit('update:modelValue', newValue);
};
```
with:
```ts
// Round to `sig` significant figures — used for tapered knobs, which have no
// value-space `step` to snap to (snapping happens in position space via the drag).
const roundSig = (x: number, sig: number): number => {
  if (x === 0 || !Number.isFinite(x)) return x;
  const mag = Math.pow(10, sig - Math.ceil(Math.log10(Math.abs(x))));
  return Math.round(x * mag) / mag;
};

const onPointerMove = (e: PointerEvent) => {
  const deltaY = startY - e.clientY;
  const isFineTune = e.shiftKey;
  const dragRange = isFineTune ? 800 : 200; // Shift for fine-tuning

  if (props.curve === 'linear') {
    // Unchanged linear path: value-space delta + step snapping.
    const valueRange = props.max - props.min;
    const valueDelta = (deltaY / dragRange) * valueRange;

    let newValue = startValue + valueDelta;
    newValue = Math.max(props.min, Math.min(props.max, newValue));

    const stepsCount = Math.round((newValue - props.min) / props.step);
    newValue = props.min + stepsCount * props.step;
    newValue = Math.max(props.min, Math.min(props.max, newValue));

    const getPrecision = (num: number) => {
      const parts = num.toString().split('.');
      return parts.length > 1 ? parts[1].length : 0;
    };
    const precision = getPrecision(props.step);
    newValue = parseFloat(newValue.toFixed(precision));

    emit('update:modelValue', newValue);
    return;
  }

  // Non-linear: drag in position space so the feel is uniform in perceptual
  // space (equal ratio per pixel on exp). No value-space step; round for storage.
  const startPos = valueToPos(props.curve, startValue, props.min, props.max);
  const newPos = Math.max(0, Math.min(1, startPos + deltaY / dragRange));
  const newValue = roundSig(posToValue(props.curve, newPos, props.min, props.max), 4);

  emit('update:modelValue', newValue);
};
```

- [ ] **Step 6: Run the component test to verify it passes**

Run: `npm test -- Knob.test`
Expected: PASS — exp renders the geometric-mean value at centre and lifts the low value well above the linear angle.

- [ ] **Step 7: Full gate**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck exit 0; all tests pass; build succeeds (vue-tsc compiles the edited SFC).

- [ ] **Step 8: Commit**

```bash
git add packages/client/src/components/Knob.vue packages/client/src/components/Knob.test.ts
git commit -m "feat(knob-tapers): Knob curve prop drives dial angle + drag mapping

Adds a curve prop (default linear). Non-linear curves map dial angle, active-fill
arc, and drag (position space, sig-fig rounding) through knobTaper; linear keeps
today's exact value-space + step behaviour. Component test covers the exp dial.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Client — wire the curve through the panels

**Files:**
- Modify: `packages/client/src/components/Kick2Panel.vue`
- Modify: `packages/client/src/components/Snare2Panel.vue`
- Modify: `packages/client/src/components/Hat2Panel.vue`
- Modify: `packages/client/src/components/Synth2Panel.vue`

**Interfaces:**
- Consumes: the descriptor `curve` field (Task 1) and the `Knob` `curve` prop (Task 3).
- Produces: no new exports — the wide-range knobs now render tapered in the running app.

- [ ] **Step 1: Drum panels — pass the descriptor curve**

In each of `Kick2Panel.vue`, `Snare2Panel.vue`, `Hat2Panel.vue`, the `<Knob v-for="d in <ENGINE>_DESCRIPTORS">` already binds `:format="d.format"`. Add one attribute directly after it:
```html
            :curve="d.curve"
```
(`d.curve` is `KnobCurve | undefined`; the Knob prop default handles the `undefined` rows as `linear`.)

- [ ] **Step 2: synth2 panel — add static curve literals to the 13 wide-range knobs**

In `packages/client/src/components/Synth2Panel.vue`, add a static `curve="exp"` attribute to each `<Knob>` whose `v-model` is one of:
`params.filter.cutoff`, `params.env1.a`, `params.env1.d`, `params.env1.r`, `params.env2.a`, `params.env2.d`, `params.env2.r`, `params.env3.a`, `params.env3.d`, `params.env3.r`, `params.lfo1.rate`, `params.lfo2.rate`.

Add `curve="s"` to the `<Knob>` with `v-model="params.filter.resonance"`.

Example — the cutoff knob changes from:
```html
          <Knob label="Cutoff" :min="20" :max="20000" :step="1" format="hz" :defaultValue="DEFAULTS.filter.cutoff" v-model="params.filter.cutoff" :syncPath="ks.pathFor(['filter', 'cutoff'])" @gesture-end="ks.end(['filter', 'cutoff'])" />
```
to (add `curve="exp"`):
```html
          <Knob label="Cutoff" :min="20" :max="20000" :step="1" format="hz" curve="exp" :defaultValue="DEFAULTS.filter.cutoff" v-model="params.filter.cutoff" :syncPath="ks.pathFor(['filter', 'cutoff'])" @gesture-end="ks.end(['filter', 'cutoff'])" />
```
Change nothing else on those knobs, and add nothing to any other knob (the rest stay linear).

- [ ] **Step 3: Full gate**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck exit 0; all tests pass; build succeeds.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/components/Kick2Panel.vue packages/client/src/components/Snare2Panel.vue packages/client/src/components/Hat2Panel.vue packages/client/src/components/Synth2Panel.vue
git commit -m "feat(knob-tapers): wire curve into synth2 + drum panels

Drum panels pass :curve=\"d.curve\"; the hand-written synth2 panel carries static
curve=\"exp\" on cutoff/env A-D-R/LFO rates and curve=\"s\" on resonance.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 5: Browser verification (controller-run, after Task 4)**

Per AGENTS.md / browser-verify-before-done (Playwright MCP, fresh session, close the tab when done):
- Select a synth2 track; open the panel. Drag **Cutoff** — confirm mid-dial reads ~600–700 Hz (not ~10 kHz) and the low end is reachable across the lower half of travel; the readout matches the dial. Drag an **env D** and an **LFO Rate** — confirm the same perceptual spread.
- Confirm a **linear** knob (e.g. an osc **Level**) drags exactly as before.
- Switch to kick2/snare2/hat2; drag a **tone**/**decay** knob and confirm the tapered feel; drag a **percent** knob (e.g. Level) and confirm it's unchanged.
- Console clean (favicon 404 is benign). Close the browser tab.

---

## Notes for the executor

- Tasks are ordered by dependency: 1 (shared types/tags) → 2 (pure math) → 3 (Knob) → 4 (panels). Each is green at the gate on its own.
- `invexp` is implemented and tested but unused in the initial assignment — it is the natural mirror of `exp` and costs nothing to carry for a future param.
- Do not touch the analog panels (`KickPanel`, `SnarePanel`, `HatPanel`, `ClapPanel`) or the kernel `taper` field — both are out of scope.
