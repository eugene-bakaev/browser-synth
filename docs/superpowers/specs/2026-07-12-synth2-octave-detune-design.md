# synth2 pitch knobs → Octave switch + ±1 octave detune

**Date:** 2026-07-12
**Branch:** `feat/synth2-octave-detune`
**Status:** Design approved, awaiting spec review

## Problem

Each synth2 oscillator (osc1/osc2/osc3) exposes two pitch knobs today:

- **Coarse** — `oscN.coarse`, semitones, range ±36 (±3 octaves), 1-semitone steps.
- **Fine** — `oscN.fine`, cents, range ±100 (±1 semitone), 1-cent steps.

The user wants to keep two knobs per oscillator but re-cast them as a musician-friendly
pair: an **Octave switch** (jumps in whole octaves) plus a **Detune** knob that spans a
full **±1 octave** with continuous (cent-level) resolution — so the second knob fills the
entire octave around each octave detent rather than only ±1 semitone.

## Key insight: the kernel needs no change

`MorphOscillator.next()` computes pitch as:

```ts
const semis = this.coarse.next() + this.fine.next() / 100; // total semitones
const f = baseFreq * Math.pow(2, semis / 12);
```

The kernel only ever sums `coarse` (semitones) + `fine/100` (cents-as-semitones). As long
as we keep the **leaf units unchanged** (coarse = semitones, fine = cents), we can re-skin
the two knobs purely at the UI + descriptor-range level. The kernel, the worklet param
block, sync, and the server are all untouched.

## Knob → leaf mapping

Applies identically to **osc1, osc2, osc3**.

| Knob (new) | Leaf (path unchanged) | Unit (unchanged) | Range | Step | Readout |
|------------|----------------------|------------------|-------|------|---------|
| **Octave** | `oscN.coarse` | semitones | ±36 st (= ±3 oct) | **12** | octaves (`-1`, `0`, `+2`) |
| **Detune** | `oscN.fine` | cents | **±1200 c (= ±1 oct)** | 1 | cents (`+743c`) |

- Octave switch detents at −36, −24, −12, 0, +12, +24, +36 semitones → displayed as
  −3…+3 octaves. The `coarse` **descriptor range is unchanged** (±36 already = ±3 oct);
  only the knob's `step` and readout change.
- Detune covers the full octave around the current detent. Total reachable pitch =
  ±3 oct (octave) + ±1 oct (detune) = **±4 octaves**, and every pitch in between is
  reachable because the detune knob spans a whole octave.

## Changes

### 1. `packages/shared/src/engines/synth2-descriptors.ts` — `fine` rows (osc1/2/3)

Three edits per oscillator row (`osc1.fine`, `osc2.fine`, `osc3.fine`):

- **Widen range:** `min: -100 → -1200`, `max: 100 → 1200`.
  - Array **position is unchanged** ⇒ the append-only param-block layout is preserved.
  - Old `fine` values (including the `osc2.fine` default of `7`) remain in-range and decode
    to the exact same pitch. No data migration.
  - The Zod leaf schema (`schema.ts`, generated `z.number().min(d.min).max(d.max)`) and the
    kernel-side `ParamSlot` clamp both derive from the descriptor, so they follow
    automatically. The leaf→block writer (`Synth2Engine`) does not clamp, so there is no
    hardcoded ±100 anywhere to update.
- **Preserve mod depth:** `modScale: 1 → 1/12`.
  - A linear mod destination sweeps `mod · modScale · range` (see `ParamSlot.next()`).
    Widening `range` 200 → 2400 would blow an existing LFO→fine vibrato from ±2 semitones
    to ±2 octaves. `modScale = 1/12` keeps full-depth modulation at ±200 cents (±2 st) —
    identical to today's behavior.
  - `MOD_DESTS` ordering is derived from `modulatable` + `key`, both unchanged, so the
    destination list and its wire encoding are unaffected.

`coarse` descriptor rows are **not** changed.

### 2. `packages/client/src/ui/knobFormat.ts` — one new format

Add a format case that renders a **semitone leaf value as octaves** for the Octave switch,
e.g. `round(value / 12)` → `-1` / `0` / `+2` (a short signed label; a `0` shows as `0`).
The existing `octave` format is unsuitable — it treats its value as *already* in octaves
and renders filter-flavored `↑/↓` arrows. Name the new case descriptively (e.g.
`'octaveSwitch'`). Add a unit test in the `knobFormat` spec.

The **Detune** knob reuses the existing `cents` format (renders `+1200c` etc.).

### 3. `packages/client/src/components/Synth2Panel.vue` — 6 knobs

For each oscillator (osc1/2/3):

- Coarse knob → `label="Octave"`, `:step="12"`, `format="octaveSwitch"` (min/max stay
  ±36), path still `['oscN','coarse']`.
- Fine knob → `label="Detune"`, `:min="-1200"`, `:max="1200"` (keep `:step="1"`,
  `format="cents"`), path still `['oscN','fine']`.

### 4. Tests

- Update `synth2-descriptors.test.ts` (and any other contract test) that pins `fine`'s old
  `min/max` (±100) or `modScale` (1) to the new values.
- Add the `knobFormat` unit test for the octave readout.
- The full gate (`shared` / `client` + tsc + build / `server`) must stay green.

## Accepted tradeoffs

- **Old non-octave coarse values.** A synth2 session saved with a non-octave `coarse`
  (e.g. +7 st for a fifth) will render at a fractional octave position and snap to the
  nearest octave on the first knob turn. The **sound is preserved** (the leaf value is not
  migrated), and that interval is still reachable via the Detune knob (+700c). synth2
  `coarse` defaults to 0, so the blast radius is tiny. No migration is performed — migrating
  would risk changing stored pitch and is not worth the complexity (YAGNI).
- **Vibrato depth on `fine` is preserved, not "improved."** We deliberately keep the old
  ±2-semitone full-depth mod range via `modScale = 1/12` rather than letting mod scale with
  the wider knob range.

## Out of scope

- No change to synth1 (`SynthEngine`) pitch knobs.
- No kernel, worklet param-block, sync-protocol, or server changes.
- No new leaves; no migration.
