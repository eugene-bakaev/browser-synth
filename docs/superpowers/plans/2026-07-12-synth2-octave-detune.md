# synth2 Octave switch + ±1 octave detune — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-cast each synth2 oscillator's Coarse/Fine knob pair as an **Octave switch** (whole-octave steps) + a **Detune** knob spanning a full **±1 octave** of continuous cents.

**Architecture:** Pure re-skin. The kernel already computes pitch as `coarse(st) + fine/100(cents)`, so we keep the leaf units unchanged and only (a) widen the `fine` descriptor range to ±1200 cents while preserving mod depth, (b) add a knob readout that renders the semitone `coarse` leaf as octaves, and (c) rewire the six panel knobs. Kernel, worklet param block, sync protocol, and server are untouched.

**Tech Stack:** TypeScript, Vue 3, Vitest, Zod. Monorepo packages: `@fiddle/shared`, `@fiddle/client`.

## Global Constraints

- **Append-only param block:** `SYNTH2_DESCRIPTORS` array positions are the wire ABI — never insert, remove, or reorder rows. Editing an existing row's `min`/`max`/`modScale` is allowed (positions unchanged).
- **Leaf units are frozen:** `oscN.coarse` stays semitones, `oscN.fine` stays cents. The kernel math depends on this; do not change it.
- **No data migration, no kernel/worklet/sync/server changes.** This plan touches only `packages/shared/src/engines/synth2-descriptors.ts`, `packages/client/src/ui/knobFormat.ts`, `packages/client/src/components/Synth2Panel.vue`, and their test files.
- **Local dev/test = `npm run dev:obs`** (LOCAL Docker DB), never `npm run dev` (prod Supabase).
- **Gate before merge:** shared tests + client tests + `vue-tsc` typecheck + client `build` + server tests all green, plus a browser verification pass with a clean console.
- Applies identically to **osc1, osc2, osc3**.

---

## File Structure

- `packages/shared/src/engines/synth2-descriptors.ts` — widen `osc1/2/3.fine` range + `modScale` (Task 1).
- `packages/shared/src/engines/synth2-descriptors.test.ts` — lock in the new `fine` range/modScale (Task 1).
- `packages/client/src/ui/knobFormat.ts` — add the `octaveSwitch` readout format (Task 2).
- `packages/client/src/ui/knobFormat.test.ts` — unit-test the new format (Task 2).
- `packages/client/src/components/Synth2Panel.vue` — rewire the six pitch knobs (Task 3).
- `packages/client/src/components/Synth2Panel.test.ts` — assert the new Octave/Detune labels (Task 3).

---

## Task 1: Widen `fine` to ±1 octave, preserve mod depth (shared descriptors)

**Files:**
- Modify: `packages/shared/src/engines/synth2-descriptors.ts` (the `osc1.fine`, `osc2.fine`, `osc3.fine` rows — currently lines ~73, ~85, ~91)
- Test: `packages/shared/src/engines/synth2-descriptors.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `osc1.fine`, `osc2.fine`, `osc3.fine` descriptors now have `min: -1200`, `max: 1200`, `modScale: 1 / 12` (still `taper: 'linear'`, `modulatable: true`, `kind` undefined). Consumed by the schema (Task-independent), `ParamSlot`, and the panel Detune knob (Task 3).

- [ ] **Step 1: Write the failing test**

Add this `it` block inside the top-level `describe` in `packages/shared/src/engines/synth2-descriptors.test.ts` (e.g. right after the `noise.color` test around line 38):

```ts
  it('osc fine is a ±1 octave (±1200 cent) detune with preserved mod depth', () => {
    const byKey = Object.fromEntries(SYNTH2_DESCRIPTORS.map((d) => [d.key, d]));
    for (const key of ['osc1.fine', 'osc2.fine', 'osc3.fine']) {
      const d = byKey[key];
      expect(d.min, key).toBe(-1200);
      expect(d.max, key).toBe(1200);
      // modScale 1/12 keeps a full-depth linear mod at ±200 cents (±2 st) even
      // though the base range widened 200 → 2400 (see ParamSlot.next()).
      expect(d.modScale, key).toBe(1 / 12);
      expect(d.taper, key).toBe('linear');
      expect(d.modulatable, key).toBe(true);
      expect(d.kind, key).toBeUndefined(); // still continuous / a mod dest
    }
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --workspace @fiddle/shared -- synth2-descriptors`
Expected: FAIL — `osc1.fine` still has `min: -100`, `max: 100`, `modScale: 1`.

- [ ] **Step 3: Edit the three `fine` descriptor rows**

In `packages/shared/src/engines/synth2-descriptors.ts`, change each `osc*.fine` row. Replace:

```ts
  { key: 'osc1.coarse',     min: -36,   max: 36,   default: 0,    taper: 'linear',     modulatable: true, modScale: 24 / 72 },
  { key: 'osc1.fine',       min: -100,  max: 100,  default: 0,    taper: 'linear',     modulatable: true, modScale: 1 },
```

with (coarse row unchanged, only the comment above it and the `fine` row change):

```ts
  // osc pitch (spec 2026-07-12): coarse is semitones — the panel's OCTAVE switch
  // steps it in whole octaves (±36 st = ±3 oct). fine is cents — the panel's
  // DETUNE knob spans a full ±1 octave (±1200 c). modScale 1/12 keeps a
  // full-depth linear mod at ±200 c (±2 st), matching the pre-widening depth.
  { key: 'osc1.coarse',     min: -36,   max: 36,   default: 0,    taper: 'linear',     modulatable: true, modScale: 24 / 72 },
  { key: 'osc1.fine',       min: -1200, max: 1200, default: 0,    taper: 'linear',     modulatable: true, modScale: 1 / 12 },
```

For `osc2.fine` change `min: -100, max: 100, ..., modScale: 1` → `min: -1200, max: 1200, ..., modScale: 1 / 12` (keep `default: 7`). For `osc3.fine` do the same (keep `default: 0`). Leave all three `osc*.coarse` rows exactly as they are.

- [ ] **Step 4: Run the descriptor test to verify it passes**

Run: `npm test --workspace @fiddle/shared -- synth2-descriptors`
Expected: PASS (new test + all existing descriptor tests, including the unchanged `covers exactly the I3d param set` key-order test and `every default lies within [min, max]`).

- [ ] **Step 5: Run the full shared gate to confirm no derived consumer broke**

Run: `npm test --workspace @fiddle/shared`
Expected: PASS — in particular `schema.test.ts` ("has one leaf validator per descriptor, enforcing the descriptor range") derives from `d.min`/`d.max`, so it now validates ±1200 automatically; `osc2.fine`'s default of `7` still lies in range.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/engines/synth2-descriptors.ts packages/shared/src/engines/synth2-descriptors.test.ts
git commit -m "feat(shared): synth2 fine → ±1 octave detune (±1200c), modScale 1/12 keeps mod depth"
```

---

## Task 2: `octaveSwitch` knob readout format (client ui)

**Files:**
- Modify: `packages/client/src/ui/knobFormat.ts`
- Test: `packages/client/src/ui/knobFormat.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `KnobFormat` union gains `'octaveSwitch'`; `formatKnobValue('octaveSwitch', v)` renders a semitone value as signed octaves (`round(v / 12)`): `0 → '0'`, `12 → '+1'`, `-24 → '-2'`, `36 → '+3'`. Consumed by the panel Octave knob (Task 3).

- [ ] **Step 1: Write the failing test**

Add this `describe` block to `packages/client/src/ui/knobFormat.test.ts` (e.g. after the existing `octave (LFO depth)` block):

```ts
describe('formatKnobValue — octaveSwitch (semitone leaf → octaves)', () => {
  it('renders whole octaves as signed integers', () => {
    expect(formatKnobValue('octaveSwitch', 0)).toBe('0');
    expect(formatKnobValue('octaveSwitch', 12)).toBe('+1');
    expect(formatKnobValue('octaveSwitch', 36)).toBe('+3');
    expect(formatKnobValue('octaveSwitch', -12)).toBe('-1');
    expect(formatKnobValue('octaveSwitch', -24)).toBe('-2');
  });
  it('rounds an off-octave (legacy) semitone value to the nearest octave label', () => {
    expect(formatKnobValue('octaveSwitch', 7)).toBe('+1'); // round(7/12) = 1
    expect(formatKnobValue('octaveSwitch', -5)).toBe('0'); // round(-5/12) = 0
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --workspace @fiddle/client -- knobFormat`
Expected: FAIL — `'octaveSwitch'` is not a valid `KnobFormat` / falls through to `value.toString()` (e.g. `12` → `'12'`).

- [ ] **Step 3: Implement the format**

In `packages/client/src/ui/knobFormat.ts`, add `'octaveSwitch'` to the union type on line 1:

```ts
export type KnobFormat = 'hz' | 'ms' | 'percent' | 'cents' | 'octave' | 'octaveSwitch' | 'ratio' | 'db';
```

Then add a `case` in the `switch (format)` block (e.g. right after the existing `'octave'` case):

```ts
    case 'octaveSwitch': {
      // The leaf is semitones; the OCTAVE switch steps it in whole octaves, so
      // render as signed octaves. A legacy off-octave value rounds to nearest.
      const oct = Math.round(value / 12);
      if (oct === 0) return '0';
      return oct > 0 ? `+${oct}` : `${oct}`; // negative already carries '-'
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test --workspace @fiddle/client -- knobFormat`
Expected: PASS (new block + all existing `knobFormat` tests).

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/ui/knobFormat.ts packages/client/src/ui/knobFormat.test.ts
git commit -m "feat(client): octaveSwitch knob format — semitone leaf rendered as signed octaves"
```

---

## Task 3: Rewire the six synth2 pitch knobs (client panel)

**Files:**
- Modify: `packages/client/src/components/Synth2Panel.vue` (the Coarse + Fine `<Knob>` for osc1/2/3 — currently lines ~31/32, ~60/61, ~83/84)
- Test: `packages/client/src/components/Synth2Panel.test.ts`

**Interfaces:**
- Consumes: `'octaveSwitch'` format (Task 2); the widened `osc*.fine` range (Task 1). Leaf paths `['oscN','coarse']` / `['oscN','fine']` are unchanged.
- Produces: three knobs labelled `Octave` (step 12, `octaveSwitch` readout, still bound to `coarse`) and three labelled `Detune` (min −1200 / max 1200, `cents` readout, still bound to `fine`).

- [ ] **Step 1: Write the failing test**

Add this `describe` block to `packages/client/src/components/Synth2Panel.test.ts` (e.g. after the LFO column block around line 244). It uses the file's existing `mountPanel` helper and `Synth2Engine.DEFAULT_PARAMS`, mirroring the Rate/Shape test at lines 236–243:

```ts
describe('Synth2Panel oscillator pitch (2026-07-12 octave + detune)', () => {
  it('renders an Octave and a Detune knob for each of the 3 oscillators', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    const labels = Array.from(el.querySelectorAll<HTMLLabelElement>('.knob-label'))
      .map((n) => n.textContent?.trim());
    expect(labels.filter((l) => l === 'Octave')).toHaveLength(3);
    expect(labels.filter((l) => l === 'Detune')).toHaveLength(3);
    // Old labels are gone.
    expect(labels).not.toContain('Coarse');
    expect(labels).not.toContain('Fine');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --workspace @fiddle/client -- Synth2Panel`
Expected: FAIL — labels still read `Coarse`/`Fine`; `Octave`/`Detune` counts are 0.

- [ ] **Step 3: Rewire the osc1 Coarse + Fine knobs**

In `packages/client/src/components/Synth2Panel.vue`, replace the osc1 Coarse knob:

```html
          <Knob label="Coarse" :min="-36" :max="36" :step="1" :defaultValue="DEFAULTS.osc1.coarse" :modelValue="params.osc1.coarse" @update:modelValue="ks.set(['osc1', 'coarse'], $event)" :syncPath="ks.pathFor(['osc1', 'coarse'])" @gesture-end="ks.end(['osc1', 'coarse'])" />
```

with (label, `:step`, and `format` change; path/min/max stay):

```html
          <Knob label="Octave" :min="-36" :max="36" :step="12" format="octaveSwitch" :defaultValue="DEFAULTS.osc1.coarse" :modelValue="params.osc1.coarse" @update:modelValue="ks.set(['osc1', 'coarse'], $event)" :syncPath="ks.pathFor(['osc1', 'coarse'])" @gesture-end="ks.end(['osc1', 'coarse'])" />
```

And replace the osc1 Fine knob:

```html
          <Knob label="Fine" :min="-100" :max="100" :step="1" format="cents" :defaultValue="DEFAULTS.osc1.fine" :modelValue="params.osc1.fine" @update:modelValue="ks.set(['osc1', 'fine'], $event)" :syncPath="ks.pathFor(['osc1', 'fine'])" @gesture-end="ks.end(['osc1', 'fine'])" />
```

with (label + min/max widen; `:step`, `format`, path stay):

```html
          <Knob label="Detune" :min="-1200" :max="1200" :step="1" format="cents" :defaultValue="DEFAULTS.osc1.fine" :modelValue="params.osc1.fine" @update:modelValue="ks.set(['osc1', 'fine'], $event)" :syncPath="ks.pathFor(['osc1', 'fine'])" @gesture-end="ks.end(['osc1', 'fine'])" />
```

- [ ] **Step 4: Rewire osc2 and osc3 identically**

Apply the exact same two edits to the osc2 knobs (paths `['osc2','coarse']` / `['osc2','fine']`, `DEFAULTS.osc2.*`) and the osc3 knobs (paths `['osc3','coarse']` / `['osc3','fine']`, `DEFAULTS.osc3.*`):

osc2 Octave:
```html
          <Knob label="Octave" :min="-36" :max="36" :step="12" format="octaveSwitch" :defaultValue="DEFAULTS.osc2.coarse" :modelValue="params.osc2.coarse" @update:modelValue="ks.set(['osc2', 'coarse'], $event)" :syncPath="ks.pathFor(['osc2', 'coarse'])" @gesture-end="ks.end(['osc2', 'coarse'])" />
```
osc2 Detune:
```html
          <Knob label="Detune" :min="-1200" :max="1200" :step="1" format="cents" :defaultValue="DEFAULTS.osc2.fine" :modelValue="params.osc2.fine" @update:modelValue="ks.set(['osc2', 'fine'], $event)" :syncPath="ks.pathFor(['osc2', 'fine'])" @gesture-end="ks.end(['osc2', 'fine'])" />
```
osc3 Octave:
```html
          <Knob label="Octave" :min="-36" :max="36" :step="12" format="octaveSwitch" :defaultValue="DEFAULTS.osc3.coarse" :modelValue="params.osc3.coarse" @update:modelValue="ks.set(['osc3', 'coarse'], $event)" :syncPath="ks.pathFor(['osc3', 'coarse'])" @gesture-end="ks.end(['osc3', 'coarse'])" />
```
osc3 Detune:
```html
          <Knob label="Detune" :min="-1200" :max="1200" :step="1" format="cents" :defaultValue="DEFAULTS.osc3.fine" :modelValue="params.osc3.fine" @update:modelValue="ks.set(['osc3', 'fine'], $event)" :syncPath="ks.pathFor(['osc3', 'fine'])" @gesture-end="ks.end(['osc3', 'fine'])" />
```

- [ ] **Step 5: Run the panel test to verify it passes**

Run: `npm test --workspace @fiddle/client -- Synth2Panel`
Expected: PASS (new block + all existing Synth2Panel tests).

- [ ] **Step 6: Run the full client gate**

Run: `npm test --workspace @fiddle/client && npm run -w @fiddle/client typecheck && npm run -w @fiddle/client build`
(If the exact script names differ, use the repo's standard client test / `vue-tsc` typecheck / `vite build` commands.)
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/client/src/components/Synth2Panel.vue packages/client/src/components/Synth2Panel.test.ts
git commit -m "feat(client): synth2 pitch knobs → Octave switch + ±1 octave Detune"
```

---

## Final verification (before declaring done / merging)

- [ ] **Full gate:** shared + client (tests, `vue-tsc`, `build`) + server all green.
- [ ] **Browser verification** (MANDATORY, per project rule — use `npm run dev:obs`, LOCAL Docker DB). Load a synth2 track and confirm:
  - Each oscillator shows **Octave** and **Detune** knobs (Coarse/Fine gone).
  - Octave knob snaps in whole octaves −3…+3 and the readout reads `-1` / `0` / `+2`; pitch jumps a full octave per detent.
  - Detune knob sweeps continuously across ±1 octave (readout in cents up to `±1200c`); combined with the octave switch, arbitrary pitches are reachable.
  - An **existing** saved synth2 session still plays at its original pitch (old `fine` values within ±1200 decode unchanged); if it had a non-octave `coarse`, the Octave knob shows the nearest-octave label and snaps on first turn (sound unchanged until then).
  - Console clean (only the known pre-existing favicon 404 / local `/api/presets` noise).
- [ ] Close the browser tab/session when done (AGENTS.md rule).
- [ ] Keep the branch after merge (do not delete); merge only after user browser-verifies.

## Self-review notes (addressed)

- **Spec coverage:** octave switch (coarse, step 12) → Task 3; ±1 octave detune (fine ±1200) → Task 1 + Task 3; preserved mod depth (modScale 1/12) → Task 1; octave readout → Task 2; test touch-ups → each task; accepted legacy-coarse tradeoff → covered by the `octaveSwitch` rounding test (Task 2) + browser check.
- **No kernel/worklet/sync/server edits** anywhere in the plan (verified against the spec's "out of scope").
- **Type consistency:** format id `'octaveSwitch'` and labels `'Octave'`/`'Detune'` are used identically in Tasks 2 and 3.
