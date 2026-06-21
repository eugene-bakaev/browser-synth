# Non-Linear Knob Tapers — Design Spec

**Date:** 2026-06-21
**Status:** Approved (brainstorm complete) — ready for implementation plan
**Scope:** Give knobs perceptual (non-linear) response curves so wide-range
params — filter cutoff, ADSR times, LFO rates, drum tones/decays — are usable
across the whole dial instead of bunching into a sliver of travel.

## 1. Problem

`packages/client/src/components/Knob.vue` is **purely linear**. Both the dial
angle (`currentAngle`) and the drag-to-value math (`onPointerMove`) use
`pct = (value − min) / (max − min)`. On a wide-range param this is perceptually
wrong:

- `filter.cutoff` spans `20–20000 Hz` (≈10 octaves). Linear puts the dial's
  midpoint at `10010 Hz` — the **bottom five octaves are crammed into the last
  ~3% of travel**. Dialing a 200 Hz cutoff is nearly impossible.
- Envelope times (`env*.a/d/r`, `0.001–10 s`) and LFO rates
  (`lfo*.rate`, `0.01–2000 Hz`) have the same problem: the musically useful low
  end is unreachable with any precision.
- The drum engines have the same issue on their frequency/time knobs
  (`tune`, `tone`, `hpf`, `decay`, `pitchDecay`, `bodyDecay`, `noiseDecay`).

There **is** a `taper: 'linear' | 'expOctaves'` field on the synth2 descriptors,
but it is consumed **only in the kernel `ParamSlot`** to scale *modulation*
(mod-in-octaves). It never reaches the UI — the Knob is linear regardless. The
drum descriptors have no taper field at all.

## 2. Goal

Knobs respond on a per-param perceptual curve declared by the descriptor, so a
wide-range param spreads its useful range evenly across the dial. The change is
**purely presentational**: the stored/synced/kernel-bound value is unchanged
(still the real Hz / seconds / fraction). On `filter.cutoff` the dial midpoint
moves from `10010 Hz` (linear) to the **geometric mean ≈ 632 Hz** (`exp`), so the
low five octaves occupy the bottom half of the travel.

Non-goals: no change to stored project JSON, the sync protocol, the param block,
the schema, or the kernel `taper`/modulation behavior. The analog drum panels
(`KickPanel`, `SnarePanel`, `HatPanel`, `ClapPanel`) are out of scope.

## 3. The Curve Model

Every curve is a **warp** `w(p): [0,1] → [0,1]` applied to dial travel `p`, then
mapped linearly to the value range:

```
value = min + (max − min) · w(p)
pos   = w⁻¹( (value − min) / (max − min) )
```

`pos` is the normalized dial travel (`0` = full CCW / `min`, `1` = full CW /
`max`). Each curve provides `w` and `w⁻¹` (the inverse is needed to place the dial
from a stored value, for both the rendered angle and the drag start).

| Curve     | `w(p)`                                   | Feel                                              | Range constraint        |
|-----------|------------------------------------------|---------------------------------------------------|-------------------------|
| `linear`  | `p`                                      | even                                              | any (incl. 0, negative) |
| `exp`     | `(rᵖ − 1)/(r − 1)`, `r = max/min`        | equal **ratio** per travel; fine at the **low** end | **min > 0**, same sign  |
| `invexp`  | `1 − wₑₓₚ(1 − p)`                         | mirror of `exp`; fine at the **high** end         | **min > 0**, same sign  |
| `s`       | `3p² − 2p³` (smoothstep)                 | fine at **both** ends, coarse in the middle       | any                     |

Inverses:

- `linear⁻¹(u) = u`
- `exp⁻¹(u) = log(u·(r − 1) + 1) / log(r)`
- `invexp⁻¹(u) = 1 − exp⁻¹(1 − u)`
- `s⁻¹(u) = 0.5 − sin( asin(1 − 2u) / 3 )` (closed-form smoothstep inverse)

where `u = (value − min)/(max − min) ∈ [0,1]`.

**Shape sketch:**

```
value
 max┤      linear ╱      exp ╱╱      invexp ╭──   s   ╭─╯
    │          ╱       ╭──╯           ╱        │     │
 min┤      ╱       ╭──╯          ────╯       ╰─╯   ╰─╯
    └────────── p ──────────────────────────────────────
```

**Range guard.** `exp`/`invexp` involve a `log`, so they are valid only on a
strictly-positive range (`min > 0`, `max > min`, same sign). A contract test
asserts no shipped descriptor declares `exp`/`invexp` on a range with `min ≤ 0`.
At runtime, if the taper functions are ever handed such a range they **fall back
to `linear`** so a knob can never break or emit `NaN`. This is why `min = 0`
params (resonance, levels, crossfades) use `linear` or `s`, never `exp`.

**Robustness.** The taper functions must be defensive against the same bad input
the Knob already guards in `formattedValue`: a non-finite `value`/`pos` (an
unhealed snapshot leaf) clamps to the range rather than throwing.

## 4. Architecture (Approach A — descriptor-declared curve, pure taper module)

Four touch points. The value flowing through `v-model` → store → sync → param
block → kernel is **never warped**, so there is no ABI, migration, or sync impact.

### 4.1 Shared — curve type + optional descriptor field
`packages/shared/src/engines/` (exported from the package index):

```ts
export type KnobCurve = 'linear' | 'exp' | 'invexp' | 's';
```

Add **optional** `curve?: KnobCurve` to `Synth2ParamDescriptor` and to
`DrumParamDescriptor`. Optional ⇒ no existing row is forced to change and the
descriptor table's array order (the param-block ABI) is untouched — `curve` is a
compile-time constant on the table, never stored per session.

### 4.2 Client — pure taper module
`packages/client/src/ui/knobTaper.ts` (new). The only home for the §3 math:

```ts
export function posToValue(curve: KnobCurve, pos: number, min: number, max: number): number
export function valueToPos(curve: KnobCurve, value: number, min: number, max: number): number
```

No Vue, no audio → unit-tested directly.

Curve assignments are **explicit** on the descriptor rows (§5) — not derived from
the kernel `taper` field. (An earlier draft derived `exp` from
`taper: 'expOctaves'`; that was dropped because the synth2 panel is *not*
descriptor-driven — see §4.4 — so derivation saved no edits, and the §7 contract
test needs the assignments to live on the descriptors to be checkable.) An omitted
`curve` means `linear`, handled by the Knob prop default — no resolver needed.

### 4.3 Client — `Knob.vue` gains a `curve` prop
- New prop `curve?: KnobCurve`, default `'linear'`. A knob that doesn't pass it
  behaves exactly as today (full back-compat).
- Two call sites route through the module:
  - **Dial angle** (`currentAngle`, `activePath`):
    `-135 + valueToPos(curve, value, min, max) · 270` instead of the linear `pct`.
  - **Drag** (`onPointerMove`): convert `startValue → startPos` via
    `valueToPos`, add the pixel delta **in position space** (`deltaY / dragRange`),
    clamp to `[0,1]`, convert back via `posToValue`. Equal *ratio* per pixel on
    `exp`. `shift` fine-tune (×4 drag range) and double-click-to-default are
    unchanged.
- `formattedValue` is **untouched** — the readout always shows the real value, so
  it stays honest under any curve.

### 4.4 Client — panels pass the curve through
The two panel styles differ and are wired accordingly:

- **Drum panels** (`Kick2Panel.vue`, `Snare2Panel.vue`, `Hat2Panel.vue`) **are**
  descriptor-driven (`v-for="d in <ENGINE>_DESCRIPTORS"`), so each gains a one-line
  `:curve="d.curve"` on its `<Knob>` (omitted ⇒ Knob default `linear`).
- **`Synth2Panel.vue` is hand-written** — ~40 individual `<Knob>` tags with
  hardcoded `:min`/`:max`/`:step` (it does not iterate the descriptor table). The
  per-knob `curve` is therefore a static literal on the relevant knobs:
  `curve="exp"` on `filter.cutoff`, the nine `env*.{a,d,r}`, and both `lfo*.rate`;
  `curve="s"` on `filter.resonance`. This matches the file's existing style (it
  already duplicates `min`/`max` as literals); the descriptor `curve` tags (§5)
  remain the canonical source the §7 contract test validates.

### 4.5 Data flow

```
descriptor.curve  (canonical; drum panels read it, synth2 mirrors it as literals)
        │
        ▼
  <Knob :curve> ──► knobTaper.posToValue / valueToPos   (dial angle + drag only)
        │            (omitted curve ⇒ Knob prop default 'linear')
        ▼
   v-model value  ──►  UNCHANGED: project store → sync → param block → kernel
   (real Hz / ms / fraction, never warped)
```

Blast radius: 1 shared type + 1 optional field × 2 descriptor shapes + the curve
tags on the listed rows; 1 new pure client module; `Knob.vue`; `:curve="d.curve"`
in the 3 drum panels and `curve` literals on the ~13 non-linear synth2 knobs. No
kernel, schema, normalize, factory, or storage changes.

## 5. Per-Param Curve Assignment

Every assignment is an explicit `curve` tag on the descriptor row. Rows not listed
omit `curve` (⇒ `linear`).

**synth2 — `curve: 'exp'`:** `filter.cutoff` (20–20k), all nine
`env{1,2,3}.{a,d,r}` (0.001–10 s), `lfo1.rate`, `lfo2.rate` (0.01–2000 Hz).

**synth2 — `curve: 's'`:** `filter.resonance` (0–1) (finer control near
self-oscillation at the top and near zero). Everything else stays `linear`:
bipolar `coarse`/`fine` are already perceptually linear (semitones / cents);
`morph`, `level`, `noise.color`, `fm.*` are acceptable linear (YAGNI).

**drums — explicit `curve: 'exp'` (frequency + time params):**

| Engine | `exp` params                          |
|--------|----------------------------------------|
| kick2  | `tune`, `pitchDecay`, `decay`          |
| snare2 | `tune`, `bodyDecay`, `noiseDecay`, `tone` |
| hat2   | `tone`, `decay`, `hpf`                 |

All drum `percent` params (`punch`, `click`, `drive`, `droop`, `level`,
`snappy`, `noiseHp`, `metallic`, `ring`) stay `linear`.

## 6. Interaction Details

- **Step / quantization.** Today the knob snaps to `step` in *value* units and
  derives display precision from `step`. On a tapered knob that is uneven
  (sticky-fine at the bottom, coarse at the top). For non-linear curves, snap in
  **position space** (the drag is already pixel-quantized via `dragRange`), then
  round the resulting value to a magnitude-appropriate precision (~4 significant
  figures) for clean storage. **Linear knobs keep today's exact `step`
  behavior** — no regression. `step` remains a valid prop; it is bypassed only
  when `curve !== 'linear'`.
- **Unchanged:** dial fill (`activePath`), `shift` fine-tune, double-click reset
  to default, the remote-touch ring, and `formattedValue` — all just read
  position through the module where relevant.

## 7. Testing & Verification

- **`knobTaper.test.ts` (pure — the core gate):**
  - round-trip bijection `posToValue(valueToPos(v)) ≈ v` sampled across each curve
    and several ranges;
  - endpoints (`pos 0 → min`, `pos 1 → max`; `value min → 0`, `value max → 1`);
  - strict monotonicity in `p`;
  - known midpoints: `exp` `p=0.5` = geometric mean (assert ≈ 632 on 20/20000),
    `linear` `p=0.5` = arithmetic mean, `s` `p=0.5` = 0.5;
  - `exp`/`invexp` with `min ≤ 0` falls back to `linear` (no `NaN`);
  - non-finite input clamps to range, never throws.
- **Contract test:** no shipped descriptor (all four tables) declares
  `exp`/`invexp` on a range with `min ≤ 0`.
- **Gate (AGENTS.md):** `npm run typecheck && npm test && npm run build`.
- **Browser-verify (MANDATORY, per AGENTS.md / browser-verify-before-done):**
  Playwright MCP — open a session, drag `filter.cutoff`, an `env.d`, and an
  `lfo.rate` and confirm the low end is reachable across mid-travel with the
  readout matching; drag a drum `tone`/`decay`; confirm a `linear` knob (e.g. a
  `level`) is unchanged; clean console; close the tab.

## 8. Open Notes

- `invexp` is defined and tested but unused in the initial assignment (§5). It is
  kept in the curve set because it is the natural mirror of `exp` and costs
  nothing to carry; a future param (e.g. a drive/saturation knob wanting fine
  control near max) can adopt it without new plumbing.
- The kernel `taper: 'expOctaves'` field is deliberately left intact and separate
  from `curve` — they encode different concerns (modulation scaling vs. UI
  response). `resolveCurve` only *reads* `taper` to pick a sensible UI default.
