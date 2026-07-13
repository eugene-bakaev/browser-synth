# synth2 LFOs → S&H + Smooth random modes

**Date:** 2026-07-13
**Branch:** `feat/lfo-sample-hold`
**Status:** Design approved, awaiting spec review

## Problem

Each synth2 voice has two per-voice LFOs (`lfo1`, `lfo2`) that feed the mod matrix.
Their only waveform control today is **Shape** — a continuous `0..4` morph that
crossfades sine → triangle → saw-up → saw-down → square, produced by the pure static
function `Lfo.wave(shape, phase)` in `packages/client/src/engine/synth2/kernel/Lfo.ts`.

The user wants a **Sample & Hold (S&H)** waveform: instead of a periodic shape, the LFO
draws a *random* value and holds it. S&H does not fit the continuous morph — it is not a
periodic curve and it needs state (a held value + a PRNG), so it cannot live inside the
pure `Lfo.wave(shape, phase)`.

## What we're building

A per-LFO **3-state Mode**: **Off / S&H / Smooth**.

- **Off** — today's continuous morph, byte-for-byte unchanged.
- **S&H** — at each LFO cycle (phase wrap) draw a new random value in `[−1, +1]` and hold
  it flat until the next cycle. Classic stepped random.
- **Smooth** — same random targets, but the output ramps **linearly** from the previous
  value to the new one across the cycle (`lerp(prev, curr, phase)`) → a continuous,
  wandering LFO with no discontinuities. **No extra parameter** — one linear segment per
  cycle, so the existing Rate already sets how fast it wanders.

Because Rate (and SYNC) already govern *how often* a new value is drawn, **tempo-synced
S&H** (a fresh random value every 1/16, etc.) comes for free — SYNC needs no S&H-specific
code.

### Key insight: the plumbing is generated

The shared param stack is derived from the descriptor table
(`packages/shared/src/engines/synth2-descriptors.ts`). Adding two descriptor rows
(`lfo1.mode`, `lfo2.mode`) automatically propagates to:

| Derived artifact | Source | Effect of the new rows |
|---|---|---|
| `SYNTH2_ENUM_VALUES` | `.filter(kind==='enum')` | `lfoN.mode` enum labels available to the encoder |
| accept-list `PATTERNS` | `SYNTH2_DESCRIPTORS.map(...)` (accept-list.ts:88) | `tracks.*.engines.synth2.lfoN.mode` becomes writable |
| leaf schemas (`SYNTH2_LEAF_SCHEMAS`) | generated from descriptors | Zod validation for the new leaf |
| defaults (`buildDefaults`) | iterates descriptors | `mode` defaults to `'off'` |
| `PARAM_INDEX` + Float32 block layout | derived from descriptors | new block slot, append-stable ABI |

So the only **hand-written** changes are: the `Synth2LfoParams` interface field, the kernel
DSP (`Lfo.ts` + `Voice.ts` wiring), the UI control + preview, and tests.

Precedent: `filter.type` (`enumValues: ['lp','bp','hp']`) and `filter.model`
(`['classic','morph']`) are already **kernel-read** enums that flow through
`Synth2Engine`'s `encodeEnum` into the param block. `lfoN.mode` is the same pattern.
This is distinct from `lfoN.sync`/`lfoN.div`, which are main-thread-only ("dead to
kernel") — `mode` **must** reach the kernel because it selects the waveform generator.

## Changes

### 1. `packages/shared/src/engines/synth2-descriptors.ts` — two append-only rows

Append (do **not** reorder — array position is the block-layout ABI):

```ts
{ key: 'lfo1.mode', min: 0, max: 2, default: 0, taper: 'linear', modulatable: false, modScale: 0, kind: 'enum', enumValues: LFO_MODE_LABELS },
{ key: 'lfo2.mode', min: 0, max: 2, default: 0, taper: 'linear', modulatable: false, modScale: 0, kind: 'enum', enumValues: LFO_MODE_LABELS },
```

with a shared constant near the other LFO constants:

```ts
export const LFO_MODE_LABELS = ['off', 's&h', 'smooth'] as const;
```

- `default: 0` → `'off'` → existing behavior for every existing and new track.
- `modulatable: false`, `modScale: 0` — a discrete mode switch, not a mod destination
  (mirrors `filter.type`).

### 2. `packages/shared/src/engines/synth2.ts` — interface field

Add to `Synth2LfoParams`:

```ts
mode: 'off' | 's&h' | 'smooth'; // Off = continuous morph; S&H / Smooth = random (Shape ignored)
```

The descriptor↔interface agreement test (already asserts table ↔ interface) will require
this field; the generated `buildDefaults()` supplies `'off'`.

### 3. `packages/client/src/engine/synth2/kernel/Lfo.ts` — random modes

`Lfo` gains a `modeSlot: ParamSlot` (constructor arg, after `shapeSlot`), a per-instance
xorshift32 PRNG (state + immutable seed), and held-value state `prev`/`curr`.

- **PRNG**: reuse the xorshift32 pattern from `Noise.ts` (deterministic, allocation-free,
  kernel-ABI safe). One white draw mapped to `[−1, +1)`.
- **`next()`**:
  1. Read `mode` as a rounded integer (`Math.round(modeSlot.next())`; snap, not smoothed —
     an enum, like the filter reads its type). Reading the slot each sample keeps the
     smoother advancing, preserving the ABI contract that `next()` advances both slots once
     per sample.
  2. **`mode === 0` (Off)** → existing path: `Lfo.wave(shape, phase)`, then advance phase.
     `Lfo.wave` and `Lfo.base` are untouched.
  3. **`mode === 1|2` (S&H / Smooth)** → still read `shapeSlot.next()` (to keep its smoother
     advancing per the ABI) but ignore the value. Advance phase; if this sample **wrapped**
     (phase crossed 1 → 0), set `prev = curr` and draw a new `curr`. Output:
     - S&H: `curr` (held; the jump lands exactly on the wrap sample).
     - Smooth: `prev + (curr − prev) * phase` (continuous; `phase` is post-advance in
       `[0,1)`, so at the wrap sample it restarts near `prev` and ramps toward the fresh
       `curr`).
  4. Rate ≤ 2000 ≪ SR ⇒ at most one wrap per sample (existing invariant) ⇒ at most one draw
     per sample. Audio-rate S&H is supported and correct.
- **`reset()`** (note-on / voice-steal): re-seed the PRNG to the fixed per-instance seed,
  draw the first `curr` (and set `prev = curr` so Smooth starts flat rather than ramping
  from a stale value), zero the phase. Deterministic per voice — matches the `Noise`/
  `SvfCore` seeded-reset ethos, no clicks from shared state.

Stays pure and allocation-free (kernel ABI §6.7).

### 4. `packages/client/src/engine/synth2/kernel/Voice.ts` — wiring + seeds

- Pass `slot('lfo1.mode')` / `slot('lfo2.mode')` into the two `Lfo` constructors.
- Give each `Lfo` a **distinct** seed derived from the voice `seed` so lfo1, lfo2, and the
  noise source don't produce correlated streams (e.g. `seed ^ 0xA5A5A5A5` and
  `seed ^ 0x5A5A5A5A`, or `hash(seed, k)` — exact scheme is an implementation detail, the
  requirement is "distinct, deterministic, non-zero").

### 5. `packages/client/src/engine/synth2/preview/wavePreview.ts` — preview a random pattern

`renderLfoShape` gains a `mode` argument:

```ts
export function renderLfoShape(shape: number, mode: 'off' | 's&h' | 'smooth'): Float32Array
```

- `mode === 'off'` → unchanged (`Lfo.wave(shape, phase)` per sample).
- S&H / Smooth → render `PREVIEW_CYCLES` cycles of the random pattern using a **fixed seed**
  so the thumbnail is stable across redraws (no flicker). Stepped for S&H, piecewise-linear
  for Smooth, matching the kernel. The preview is a drawing, so it can either reuse a tiny
  `Lfo` instance driven at a preview rate or replicate the step/lerp logic directly against
  the same xorshift32 — whichever keeps the preview honest to the kernel with least
  duplication (decided in the plan).

### 6. `packages/client/src/components/WavePreview.vue` — `mode` prop

Add an optional `mode` prop (default `'off'`) forwarded to `renderLfoShape`. Osc previews
are unaffected (they never pass `mode`).

### 7. `packages/client/src/components/Synth2Panel.vue` — segmented control + knob swap

Per LFO (lfo1 and lfo2):

- Add a **segmented 3-way** control `OFF | S&H | SMOOTH` near the existing `SYNC` button,
  writing `lfoN.mode` via the command bus (`ks.set(['lfoN','mode'], label)`), matching how
  `SYNC` writes `lfoN.sync`. The active segment reflects `params.lfoN.mode`.
- **Hide the Shape knob when `mode !== 'off'`** (`v-if="params.lfoN.mode === 'off'"`),
  consistent with the existing Rate→Div knob swap under SYNC. Rate and SYNC stay visible and
  functional in all modes (they set how often a random value is drawn).
- Pass `:mode="params.lfoN.mode"` to `<WavePreview kind="lfo" ...>`.

## Interaction with existing features

- **SYNC**: unchanged and orthogonal. SYNC controls the LFO **rate**; mode controls the
  **waveform**. Tempo-synced S&H is the natural, free combination.
- **Mod matrix**: an LFO in S&H/Smooth mode still feeds `lfo1`/`lfo2` as before — only the
  value it produces changes. No matrix changes.
- **Shape modulation**: `lfoN.shape` remains modulatable; while `mode !== 'off'` the shape
  value (modulated or not) is ignored by the generator. No conflict.

## Old-session gap (known, accepted)

Existing saved sessions do not carry the `lfoN.mode` leaf; like every prior descriptor
append, they need a re-save to gain it, and until then the server's slice-level normalize
may drop `mode` ops in those specific old sessions ([[synth2-old-session-sync-gap]]). New
sessions and freshly-normalized projects default `mode` to `'off'`, so behavior is
unchanged. No migration is introduced (consistent with prior appends).

## Testing

- **`Lfo.test.ts`**
  - Off path: output identical to current `Lfo.wave` (regression guard).
  - S&H: value is constant across a full cycle and changes **only** on the wrap sample;
    range within `[−1, +1]`.
  - Smooth: no discontinuity at the wrap (|Δ| between adjacent samples bounded by the
    per-sample ramp step); passes through the same target sequence as S&H at the wraps.
  - Determinism: same seed ⇒ identical sequence; distinct lfo1/lfo2 seeds ⇒ different
    sequences.
  - `reset()` re-seeds (post-reset sequence reproducible) and Smooth starts flat.
  - Audio-rate: at rate near the ceiling, at most one draw per sample.
- **Shared**: descriptor↔interface agreement test picks up `mode`; encode/normalize/
  accept-list round-trip for `lfoN.mode` (writable, validates, heals when missing).
- **Preview**: `renderLfoShape(shape,'s&h')` / `'smooth'` return stable output for the fixed
  seed; `'off'` unchanged.
- **Gate**: shared + client + server unit suites, `tsc`/`vue-tsc`, and `build` all green.
- **Browser verification** (`npm run dev:obs`, local Docker DB): on a synth2 track, toggle
  each LFO through OFF → S&H → SMOOTH, confirm the preview updates, the Shape knob
  hides/returns, audible stepped vs gliding modulation on a routed destination, SYNC + S&H
  together, and a reload persists `mode`. Clean console (modulo known favicon 404 / local
  presets 500). Close the browser when done.

## Out of scope (YAGNI)

- Band-limiting the random steps — naive is consistent with the existing LFO decision
  (`Lfo.ts` header: band-limiting is a filed future follow-up).
- A separate slew / smoothness knob — Smooth is intentionally parameter-free (one linear
  segment per cycle).
- Modulating `mode` from the matrix.
- S&H on synth1 (it has no comparable per-voice LFO).
