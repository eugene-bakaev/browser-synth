# Synth2 per-module wave preview — design

**Date:** 2026-06-19
**Status:** Draft for review
**Branch:** `feat/synth2-wave-preview`

## 1. Goal

Give the user an at-a-glance picture of the waveform each synth2 **oscillator**
(OSC 1/2/3) and **LFO** (LFO 1/2) currently produces. Today the only cue for a
module's shape is a bare number on the `Morph` / `Shape` knob (e.g. `1.4`), and
because those controls are *continuous morphs* — not a discrete shape switch —
the number tells the user nothing about what the wave actually looks like. A
small static waveform thumbnail next to each module turns `morph 1.4` into an
immediately legible "triangle-into-saw."

## 2. What this is (and is not)

- **Is:** a small canvas thumbnail per osc/LFO that draws a few cycles of the
  shape the module is configured to generate, repainted when a shape-affecting
  knob moves. It is a **shape indicator**, not a live signal scope.
- **Is accurate (Option B):** the drawn shape is produced by the **real kernel
  DSP** — the actual `MorphOscillator` for oscillators and the actual `Lfo.wave`
  shape function for LFOs — not a re-implemented look-alike. What you see is the
  engine's own output (PolyBLEP-corrected edges, leaky-integrator triangle, the
  exact morph crossfade), captured at a fixed representative pitch.
- **Is static:** one fixed render of a few cycles, recomputed only on a
  shape-param change. No `requestAnimationFrame` loop. (Contrast the existing
  `Visualizer.vue`, which is a 60 fps live analyser scope of the whole mixed
  output and stays.)
- **Is not** a per-module live oscilloscope. It does **not** reflect, in real
  time, FM, hard-sync, the mod matrix bending `morph`/`shape`, envelope state, or
  the note being played. Those need per-module audio taps out of the worklet —
  explicitly out of scope (see §10).

## 3. Decisions already settled (during brainstorming)

1. **Computed preview, not a live tap.** No worklet/audio-graph changes.
2. **Static, multi-cycle.** Draw ~3 cycles so it reads as a "wave," repaint on
   change only.
3. **Option B — accuracy via the real DSP.** Run the engine's own oscillator /
   LFO code to produce the samples, rather than an idealized look-alike. The cost
   is light (§7) and the UI stays decoupled from kernel internals behind one
   render helper.
4. **Modules covered:** OSC 1, OSC 2, OSC 3, LFO 1, LFO 2 (five thumbnails).
5. **Shape-determining params only:**
   - Osc thumbnail depends on `morph` (0..3) and `pulseWidth` (0.05..0.95).
     `coarse`/`fine`/`level` do not change the shape and are fixed to neutral in
     the render.
   - LFO thumbnail depends on `shape` (0..4). `rate` does not change the shape.

## 4. The display-pitch decision (the one real modelling choice)

The engine's true oscillator output is **frequency-dependent**: PolyBLEP rounds a
discontinuity over a window of ±`dt` (= `freq / sampleRate`) of a cycle, and the
leaky-integrator triangle rolls off with pitch. So "the accurate shape" is not a
single curve — it changes with the note. A static preview must therefore pick a
**representative display pitch**.

We render at a fixed nominal sample rate and a per-sample phase increment chosen
to show `PREVIEW_CYCLES` cycles across `PREVIEW_POINTS` samples:

```
PREVIEW_SR     = 48000   // nominal; the preview is a drawing, not tied to the audio context
PREVIEW_CYCLES = 3
PREVIEW_POINTS  = 512     // samples captured = polyline points drawn
SAMPLES_PER_CYCLE = floor(PREVIEW_POINTS / PREVIEW_CYCLES)  // 170 — whole samples
displayFreq     = PREVIEW_SR / SAMPLES_PER_CYCLE            // ≈ 282 Hz (intuition only)
```

**Whole-sample period (implementation refinement).** The intuitive increment
`dt = PREVIEW_CYCLES / PREVIEW_POINTS` gives a 170.67-sample period, which is
non-integer: phase-aligned capture (start at a wrap) of exactly `PREVIEW_CYCLES`
such periods lands the final saw-fall precisely on the buffer's closing boundary,
outside the captured window — so the last tooth is clipped and a forward scan only
sees `PREVIEW_CYCLES − 1` falls. Flooring the period to a whole sample count (170)
makes `PREVIEW_CYCLES` periods span 510 ≤ `PREVIEW_POINTS` samples, so every
discontinuity lands on an interior sample and the thumbnail shows complete cycles.
The PolyBLEP edge is then anti-aliased across ~2 samples (correct band-limiting),
so the saw unit test counts each fall as a 1–2 sample *event*, not a single >1.0
step. Display pitch shifts ≈ 0.4 % (281 → 282 Hz) — negligible against the window
below.

At `dt ≈ 0.0059`, the BLEP window is ±0.59 % of a cycle — on a thumbnail that is
sub-pixel, so the edges read clean while still being the genuine engine output.
This is the deliberate "faithful but legible" point we discussed: lowering the
display pitch makes edges look more ideal, raising it exposes the rounding but
gets busier. `PREVIEW_CYCLES` / `PREVIEW_POINTS` are the tuning knobs and will be
confirmed during browser verification.

LFOs have no pitch issue — they are naive (non-band-limited) by engine design, so
`Lfo.wave(shape, phase)` is exact at any sampling; the LFO thumbnail just
evaluates that function across `PREVIEW_CYCLES` cycles.

## 5. Architecture

Three units, each with one responsibility and a narrow interface:

```
shape params (reactive) ──► wavePreview.ts (render helper, pure-ish)
                                 │  Float32Array of bipolar samples
                                 ▼
                            WavePreview.vue (dumb canvas painter)
                                 ▲  placed 5×
                            Synth2Panel.vue (wires each osc/LFO's params in)
```

### 5.1 `packages/client/src/engine/synth2/preview/wavePreview.ts` — render helper

The **only** place that touches kernel DSP for previews. Keeps the Vue layer
ignorant of `ParamSlot`, sample rates, warm-up, etc.

```ts
export const PREVIEW_POINTS = 512;
export const PREVIEW_CYCLES = 3;
export const PREVIEW_SR = 48000;

/** Bipolar samples (≈ −1..+1) of one osc's morphed shape over PREVIEW_CYCLES
 *  cycles, produced by the real MorphOscillator. Length === PREVIEW_POINTS. */
export function renderOscShape(morph: number, pulseWidth: number): Float32Array;

/** Bipolar samples of one LFO's morphed shape over PREVIEW_CYCLES cycles,
 *  produced by the real Lfo.wave. Length === PREVIEW_POINTS. */
export function renderLfoShape(shape: number): Float32Array;
```

**`renderOscShape` (genuine Option B — stateful DSP):**
1. Build the four `ParamSlot`s the oscillator needs (`osc1.morph`,
   `osc1.pulseWidth`, `osc1.coarse`, `osc1.fine`) from the **real descriptors**
   (look up via `PARAM_INDEX` → `SYNTH2_DESCRIPTORS`, so min/max/taper match the
   engine), at `PREVIEW_SR`. Construct one `MorphOscillator`.
2. `setBase(morph)` / `setBase(pulseWidth)`; coarse and fine slots keep their
   neutral defaults (0).
3. **Warm-up:** call `osc.next(displayFreq)` for `WARMUP_SAMPLES` to let the
   triangle leaky-integrator reach steady state, discarding output. `displayFreq
   = PREVIEW_SR / SAMPLES_PER_CYCLE` (whole-sample period; see §4). (Slots built
   with `default` = value need no smoother warm-up — `next()` returns the value
   immediately when unmodulated.)
4. **Phase-align:** keep calling `next` (bounded by one period, defensively) until
   `osc.wrapped === true`, so capture begins at phase ≈ 0. This stops the drawing
   from sliding horizontally as the user sweeps `morph`.
5. **Capture:** the next `PREVIEW_POINTS` outputs into a preallocated
   `Float32Array`. Those points span ~`PREVIEW_CYCLES` cycles (510 of 512 samples),
   with all `PREVIEW_CYCLES` falls interior. Return it.

   Input hardening: `morph`/`pulseWidth` go through `ParamSlot.setBase`, which is
   already NaN-safe and range-clamping (I4), so a garbage prop cannot produce
   NaN/Inf samples.

**`renderLfoShape` (exact — stateless shape fn):**
- For `i` in `0..PREVIEW_POINTS`: `phase = (i / PREVIEW_POINTS) * PREVIEW_CYCLES`,
  fractional part in `[0,1)`; sample = `Lfo.wave(shape, frac)`. This calls the
  engine's own shape function, so it is the single source of truth (no
  reimplementation). Clamp/guard `shape` defensively (`Lfo.wave` already clamps
  `s` to `[0,4]`).

**One small kernel change required:** `Lfo.wave` is currently `private static`.
Widen it to `static wave(...)` (public) so the preview can call the engine's own
function. This only widens visibility — no behavior change — preserving
single-source-of-truth. (Alternative considered: extract `lfoWave(s,p)` into a
shared module imported by both `Lfo` and the preview. Rejected as more churn for
no benefit; revisit only if a second consumer appears.)

### 5.2 `packages/client/src/components/WavePreview.vue` — canvas painter

A dumb, self-contained component. Given the shape params, it computes the buffer
(via the helper) and paints it. No engine knowledge beyond the helper import.

- **Props:** `{ kind: 'osc' | 'lfo'; morph?: number; pulseWidth?: number;
  shape?: number; color: string }`.
- Computes the sample buffer in a `watch`/`computed` over the relevant props
  (`morph`+`pulseWidth` for osc, `shape` for lfo) and repaints on change. No
  `requestAnimationFrame`.
- Canvas sizing mirrors `Visualizer.vue`: internal resolution = CSS size ×
  `devicePixelRatio`; re-measure on `resize`.
- Draw: clear to the panel's dark background, a faint horizontal center axis,
  then the bipolar polyline mapping sample index → x across the width and value
  → y (`y = height/2 − v * height/2 * VPAD`), stroked in `color` with a soft glow
  to match the existing oscilloscope aesthetic. `VPAD ≈ 0.9` leaves headroom so a
  full-scale wave isn't clipped at the canvas edge.
- Small fixed height (~44 px), full column width.
- Lifecycle: paint `onMounted`; `removeEventListener` + nothing else to tear down
  on unmount (no animation loop, no audio handles).

### 5.3 `packages/client/src/components/Synth2Panel.vue` — integration

Add one `<WavePreview>` inside each osc and LFO `module-group`, directly under its
`knob-row`:

- OSC 1/2/3 (`<h3>OSC n</h3>` groups, after the knob row and before the SYNC
  button on osc2/osc3):
  `<WavePreview kind="osc" :morph="params.oscN.morph" :pulseWidth="params.oscN.pulseWidth" :color="color" />`
- LFO 1/2 (`<h3>LFO n</h3>` groups, after the knob row):
  `<WavePreview kind="lfo" :shape="params.lfoN.shape" :color="color" />`

`color` is the prop the panel already receives and passes to `Visualizer`.
Reuse it so previews match the track's accent color.

## 6. Data flow

Knob turn → `v-model` mutates `params.oscN.morph` (existing reactive path, with
its existing sync/persistence behavior — **unchanged**, previews are read-only) →
`WavePreview`'s watcher fires → `renderOscShape` returns a fresh buffer →
component repaints the canvas. No new state, no store, nothing serialized,
nothing sent over the wire. The preview is a pure projection of existing params.

## 7. Performance

- Recompute happens **only on a shape-param change** — during a knob drag at most
  ~60/s for the one module being dragged; zero when idle. No rAF loop.
- `renderOscShape` ≈ `WARMUP_SAMPLES + ~POINTS` ≈ ~2.5 k samples of float math +
  a few `Math.sin/pow` per sample = microseconds. `renderLfoShape` is
  `PREVIEW_POINTS` evaluations of a closed-form function — cheaper still.
- Draw is a ≤512-segment 2D-canvas polyline; no WebGL/shaders. GPU only
  composites the finished canvas.
- Net: strictly **cheaper than the always-on 60 fps `Visualizer`** already in the
  panel. Buffers are preallocated and reused per component to keep the hot path
  allocation-free.

## 8. Error handling / edge cases

- **Bad params (NaN/Inf/out-of-range):** absorbed by `ParamSlot.setBase` (osc)
  and `Lfo.wave`'s internal clamp (lfo); output stays finite and in `[-1,1]`.
- **jsdom (unit/component tests) has no real 2D canvas:** the component must
  guard `canvas.getContext('2d')` returning `null` and no-op the paint, so tests
  that mount the panel don't throw. The *render helper* is pure data (no canvas)
  and is unit-tested directly.
- **Zero-size canvas before layout:** guard `width/height === 0` (skip paint),
  same as `Visualizer.vue`.
- **devicePixelRatio undefined:** default to 1 (mirrors `Visualizer.vue`).

## 9. Testing

**Unit — `wavePreview.test.ts` (the core logic, no DOM):**
- `renderOscShape(0, 0.5)` (sine): length `PREVIEW_POINTS`; all finite and within
  `[-1.05, 1.05]`; near-zero mean; starts ≈ 0 (phase-aligned) and rises (sine).
- `renderOscShape(2, 0.5)` (saw): roughly monotonic ramp within each cycle with a
  sharp fall — assert it spans close to the full `[-1, 1]` range and has exactly
  `PREVIEW_CYCLES` falling edges (sign of large negative jumps).
- `renderOscShape(3, pw)` (pulse): two distinct levels; the high-portion fraction
  tracks `pw` (e.g. `pw=0.25` → ~¼ of each cycle high) — verifies pulseWidth is
  honored.
- `renderOscShape(NaN, NaN)`: still finite, length `PREVIEW_POINTS` (hardening).
- `renderLfoShape(0)` ≈ sine; `renderLfoShape(4)` ≈ ±1 square; `renderLfoShape`
  output equals `Lfo.wave` sampled at the same phases (locks single-source).
- Determinism: same inputs → identical buffers.

**Component — `WavePreview.test.ts`:**
- Mounts for `kind:'osc'` and `kind:'lfo'` without throwing under jsdom (canvas
  guard works).
- Changing `morph` (osc) / `shape` (lfo) recomputes the buffer — spy on the
  helper, or assert the internal computed buffer changed.
- `kind:'lfo'` ignores `pulseWidth`; `kind:'osc'` ignores `shape`.

**Panel — extend `Synth2Panel.test.ts`:**
- Renders exactly 5 `WavePreview` instances bound to osc1/2/3 + lfo1/2 params,
  passing the panel `color` through.

**Gate (must be green before merge):**
`npm run typecheck && npm test && npm run build` across all workspaces; build
still emits `worklets/synth2-processor.js`.

**Browser (Playwright MCP, then close the session) — mandatory per AGENTS.md:**
1. `npm run dev`; open/create a session; add a synth2 track; open Synth2Panel.
2. OSC 1: sweep `Morph` 0→3 and confirm the thumbnail morphs sine → triangle →
   saw → pulse; on the pulse end, turn `PW` and confirm the duty cycle visibly
   changes. Repeat-spot-check OSC 2/3.
3. LFO 1: sweep `Shape` 0→4 and confirm sine → triangle → saw-up → saw-down →
   square. Spot-check LFO 2.
4. Confirm the preview is static (no animation) and only repaints on knob change;
   confirm console is clean and no frame-rate/CPU regression on the panel.
5. Close the browser/session; stop the dev server.

## 10. Out of scope (YAGNI / future)

- **Live per-module scope** (real-time FM/sync/mod-matrix/note-driven shape via
  worklet taps) — the heavier alternative we rejected.
- Reflecting **mod-matrix routing** to `morph`/`shape` in the preview.
- A preview for the **filter** response, envelopes, or the noise color.
- Animated/scrolling motion.
- User-configurable cycles/pitch/size.

## 11. File-by-file change list

| File | Change |
|---|---|
| `packages/client/src/engine/synth2/kernel/Lfo.ts` | Widen `private static wave` → `static wave` (visibility only). |
| `packages/client/src/engine/synth2/preview/wavePreview.ts` | **New.** `renderOscShape`, `renderLfoShape`, preview constants. |
| `packages/client/src/engine/synth2/preview/wavePreview.test.ts` | **New.** Unit tests for the helper. |
| `packages/client/src/components/WavePreview.vue` | **New.** Static canvas painter. |
| `packages/client/src/components/WavePreview.test.ts` | **New.** Component tests. |
| `packages/client/src/components/Synth2Panel.vue` | Add 5 `<WavePreview>` (osc1/2/3, lfo1/2). |
| `packages/client/src/components/Synth2Panel.test.ts` | Assert 5 previews wired to the right params. |

No changes to `@fiddle/shared`, the worklet, the kernel hot path, the schema,
sync, or persistence. The descriptor table is untouched (read-only use).
```