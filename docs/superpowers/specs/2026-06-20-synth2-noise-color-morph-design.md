# synth2 Noise-Color Morph — Design Spec

**Date:** 2026-06-20
**Status:** Approved (brainstorm complete) — ready for implementation plan
**Scope:** Replace synth2's single lowpass "color" control with a continuous
morph across five textbook noise colors.

## 1. Problem

synth2's noise generator (`packages/client/src/engine/synth2/kernel/Noise.ts`) is
white noise (xorshift32) through a one-pole lowpass whose cutoff *is* the
`noise.color` knob. That makes "color" a **bandwidth** control — it removes a band
above a moving corner — so it reads as a filter sweep, not a change of noise
*color*. It can only go white → darker, and its taper is lopsided (even color 0.5
sits near ~5 kHz), so most of the knob travel sounds muffled.

"Real" noise color is a constant **spectral slope** (tilt) across the whole
spectrum, not a corner. This spec replaces the lowpass with a morph across genuine
colored-noise slopes.

## 2. Goal

One `noise.color` knob (0..1) that continuously morphs across five named colors,
white at center, each at its real textbook spectral slope, loudness-matched so the
knob is purely tonal:

```
 0.0       0.25       0.5        0.75       1.0
brown ───► pink ───► white ───► blue ───► violet
-6 dB/oct  -3 dB/oct  0 (flat)   +3 dB/oct  +6 dB/oct
```

## 3. Decisions (settled during brainstorming)

| # | Decision | Choice |
|---|----------|--------|
| D1 | Palette scope | **Full bipolar sweep** — brown ↔ pink ↔ white ↔ blue ↔ violet (5 anchors). |
| D2 | Backward-compat for saved patches | **Reinterpret in place** — reuse the raw 0..1 field as the new morph position; new default 0.5 (white). No migration/versioning. |
| D3 | DSP topology | **Derived-anchor crossfade** — build white + Kellet pink, derive brown/blue/violet by integration/differentiation, crossfade by knob with per-anchor loudness gain. |

Rejected alternatives: single first-order tilt filter (named colors only
approximate, esp. pink); discrete stepped colors (loses the morph feel).

## 4. Behavior & UX

- `noise.color` stays a 0..1 percent knob. **Default becomes 0.5 = white** (was 1).
  The knob's default tick therefore sits at center.
- White lives exactly at `color = 0.5`; the output at 0.5 *is* the raw white stream.
- Loudness is matched across the entire sweep (per-anchor gain calibration), so
  turning the knob never changes perceived volume — it only changes timbre.
- The colored output also feeds the `noise` **mod source** (`Voice.noisePrev`), so
  the chosen color shapes that modulation signal too (pink = smoother random
  movement; violet = jitterier). No special handling — it falls out for free.
- `noise.color` remains a mod **destination** (modulatable, `modScale 1`): a mod
  amount of 1 sweeps the full color range, same wiring as today.

## 5. DSP design

All work happens inside `Noise.next(color: number): number`. **The public API is
unchanged** — same constructor `new Noise(seed)`, same `next(color)` signature —
so `Voice.ts` (`const nz = this.noise.next(this.noiseColor.next())`) is untouched.

### 5.1 Building blocks (per sample, from one white draw)

`white` is the existing xorshift32 bipolar sample. Every other anchor derives from
it, exploiting that integration lowers the spectral slope by 6 dB/oct and
differentiation raises it by 6 dB/oct:

| Anchor | Slope | Construction |
|--------|------:|--------------|
| white  | 0 dB/oct | raw xorshift32 (unchanged generator) |
| pink   | −3 dB/oct | Paul Kellet **refined** filter (7 one-pole accumulators) |
| brown  | −6 dB/oct | leaky integrator of white (Kellet `/1.02` form — bounded, no DC runaway) |
| blue   | +3 dB/oct | first difference of **pink**: `pink − pinkPrev` (−3 + 6 = +3) |
| violet | +6 dB/oct | first difference of **white**: `white − whitePrev` (0 + 6 = +6) |

**Kellet refined pink** (canonical coefficients; `b0..b6` are per-instance state,
init 0):

```
b0 = 0.99886*b0 + white*0.0555179;
b1 = 0.99332*b1 + white*0.0750759;
b2 = 0.96900*b2 + white*0.1538520;
b3 = 0.86650*b3 + white*0.3104856;
b4 = 0.55000*b4 + white*0.5329522;
b5 = -0.7616*b5 - white*0.0168980;
pinkRaw = b0+b1+b2+b3+b4+b5+b6 + white*0.5362;
b6 = white*0.115926;
```

**Brown** (leaky integrator, per-instance state `brownState` init 0):

```
brownState = (brownState + 0.02*white) / 1.02;
brownRaw = brownState;
```

**Blue / violet** (per-instance state `pinkPrev`, `whitePrev` init 0):

```
blueRaw   = pink  - pinkPrev;   pinkPrev  = pink;    // pink is the GAIN-NORMALIZED pink
violetRaw = white - whitePrev;  whitePrev = white;
```

(Differencing the gain-normalized pink/white keeps the loudness bookkeeping in one
place; the additional blue/violet gain is folded into their own anchor gains.)

### 5.2 Loudness normalization

Each anchor has very different RMS for unit-variance white (integration shrinks it,
differentiation amplifies it). Bake **per-anchor gain constants** `Gwhite (=1),
Gpink, Gbrown, Gblue, Gviolet` chosen so each anchor's RMS matches white's RMS. The
constants are fixed numbers in the source, **calibrated and locked by a test**
(§7) that measures each anchor's RMS over a long white run and asserts it lands
within a tolerance band of white's RMS. The gain-normalized anchors are:

```
W = white;            // Gwhite = 1
P = pinkRaw   * Gpink;
Br = brownRaw * Gbrown;
Bl = blueRaw  * Gblue;
V = violetRaw * Gviolet;
```

Note `blueRaw`/`violetRaw` are differences of the already-normalized `P`/`W`, so
their `Gblue`/`Gviolet` are calibrated *after* that. Output may transiently exceed
±1 for the bright colors (difference signals are peaky); we match **RMS**
(perceptual loudness), not peak — downstream `noiseLevel` and the voice filter
absorb the rare over. No hard clip (YAGNI).

### 5.3 Crossfade

Anchor positions on the knob axis:

```
brown@0.0   pink@0.25   white@0.5   blue@0.75   violet@1.0
```

For `c = clamp(color, 0, 1)`: find the segment `c` falls in, compute the local
fraction `t ∈ [0,1]`, and **linearly crossfade** the two bracketing gain-normalized
anchors:

```
out = (1 - t) * A + t * B
```

where `A`,`B` are the segment's lower/upper anchors. All five anchors are derived
from the *same* white stream and are phase-coherent, so linear crossfade introduces
no comb/cancellation artifacts. At the segment joins the active anchor is reproduced
exactly; at `c = 0.5`, `out = white`.

### 5.4 Invariants preserved

- **Allocation-free**: only scalar per-instance state added (`b0..b6`,
  `brownState`, `pinkPrev`, `whitePrev`). No arrays, no per-sample `new`.
- **Deterministic**: identical seed → identical stream for any fixed `color`.
- **Per-voice**: state lives on the `Noise` instance, one per voice (unchanged).

## 6. Files & back-compat

| File | Change |
|------|--------|
| `packages/client/src/engine/synth2/kernel/Noise.ts` | Rewrite internals per §5. Keep constructor + `next(color)` signature. Add the new scalar state + gain constants. |
| `packages/client/src/engine/synth2/kernel/Noise.test.ts` | Update existing tests (color 0.5 = white) and add slope-ordering, loudness, and white-identity tests (§7). |
| `packages/shared/src/engines/synth2-descriptors.ts` | `noise.color` row: `default 1 → 0.5`; rewrite the comment to describe the morph. **No reorder** — index/append-only order unchanged; min/max/taper/modulatable/modScale unchanged. |
| `packages/client/src/components/Synth2Panel.vue` | Color knob default flows from `Synth2Engine.DEFAULT_PARAMS` automatically (now 0.5); refresh the knob comment/label only. |

**Untouched on purpose:** `Voice.ts` (signature unchanged), the mod matrix wiring,
the accept-list/sync (numeric leaf `noise.color` still a clamped 0..1 float),
`normalizeProject` (defaults derive from the table → missing `color` heals to 0.5;
existing 0..1 values pass through and are reinterpreted as morph position per D2).

**Back-compat (D2):** a saved patch that left `noise.color` at the old white
default (1) now reads as violet. Accepted: `noise.level` defaults to 0, so noise is
silent unless deliberately dialed in, making the affected-patch set negligible.

## 7. Testing

Gate unchanged: `npm run typecheck && npm test && npm run build` across all
workspaces; build still emits `worklets/synth2-processor.js`.

`Noise.test.ts`:

1. **Determinism** — same seed, same `color`, identical stream (retarget the
   existing white check to `next(0.5)`).
2. **Range / zero-mean** — white (`color 0.5`) stays within reasonable bounds and
   is ~zero-mean (existing test, retargeted).
3. **White identity** — `next(0.5)` reproduces the raw xorshift32 white sequence
   sample-for-sample (a reference white generator with the same seed).
4. **Slope ordering** (no FFT) — high-frequency metric `mean(|sample[n] −
   sample[n-1]|)` over a long run is **strictly increasing** across
   `color ∈ {0, 0.25, 0.5, 0.75, 1.0}`: `brown < pink < white < blue < violet`.
5. **Loudness match** — RMS at each of the five anchors lands within a tolerance
   band of white's RMS (this test calibrates/locks `Gpink, Gbrown, Gblue,
   Gviolet`).
6. **Continuity** — sweeping `color` produces no anchor-join discontinuity (RMS/HF
   metrics vary monotonically and smoothly across a fine sweep).

Run the full gate; update any default snapshot that happens to capture
`noise.color` (none found at spec time — the descriptor test checks key order only,
and panel/defaults derive from the table).

Browser verification (Playwright MCP, then close the session): add a synth2 track,
raise `noise.level`, sweep `noise.color` and confirm the audible morph from
dark/rumbly (brown) through neutral (white) to bright/hissy (violet) **without** a
perceived volume change; confirm clean console.

## 8. Out of scope (YAGNI)

- Noise spectrum/waveform preview in the panel — a random signal has no meaningful
  time-domain trace like the osc/LFO `WavePreview`; a spectrum widget is separate
  work.
- A color-name readout (brown/pink/white/blue/violet) under the knob — nice future
  polish, not required.
- The alternate single tilt-filter DSP and discrete-stepped variants (rejected, D3).
- Migration/versioning of old `noise.color` values (rejected, D2).
