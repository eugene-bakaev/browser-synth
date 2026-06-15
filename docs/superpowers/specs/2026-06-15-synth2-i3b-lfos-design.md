# synth2 I3b — LFOs design

**Status:** approved (brainstorm 2026-06-15)
**Slice of:** `docs/superpowers/specs/2026-06-12-worklet-synth-engine-design.md` (§5.5 LFOs, §5.6 mod matrix, §6.3 ParamSlot, §6.4 descriptor table). This document refines I3b only; env3 + loop mode (I3c) and the morph filter (I3d) are separate slices.
**Predecessor:** I3a (mod matrix core) — merged `e37698b`. I3a already routes the live sources (env1, env2, velocity, noise) to every continuous destination and reserves `lfo1`/`lfo2` as inert sources (positions 1–2 in `MOD_SOURCES`).

## Goal

Two per-voice, retriggered LFOs that fill the already-routed-but-inert `lfo1`/`lfo2` matrix sources, so the modulation matrix can produce continuous cyclic modulation. Audible the moment it lands: set any matrix slot `source: lfo1` (or `lfo2`) and a continuous `dest`, and the destination sweeps.

**Exit criterion:** add a synth2 track, route `lfo1 → filter.cutoff` (amount > 0) in the matrix, press Play, and hear the cutoff wobble at the LFO rate; changing `lfo1.rate`/`lfo1.shape` audibly changes the wobble; the change syncs to a second client.

## What the parent spec already settles (§5.5)

- **2 LFOs** (`lfo1`, `lfo2`).
- Per-voice phase, **retriggered on note-on** (free-running/global LFOs are a later I4 nicety, out of scope here).
- `rate` **0.01 Hz .. 2000 Hz** (log knob). The audio-rate top end is intentional — at >20 Hz routed to pitch/cutoff it becomes an FM / filter-FM effect.
- `shape` is a **continuous 0..4 morph**: sine → triangle → saw-up → saw-down → square. Continuous, so it is a `ParamSlot` and modulatable.
- Defaults: **LFO1 = 5 Hz sine, LFO2 = 0.5 Hz triangle**.

## Decisions taken in this brainstorm

1. **Shape control = continuous morph Knob** (not a discrete 5-way selector). Matches the parent spec; keeps shape a modulatable descriptor row, consistent with the rest of the engine (osc morph is also a continuous knob).
2. **Waveforms are computed naively** (directly from phase, no anti-aliasing). Cheap, standard for an LFO even when used as an audio-rate modulator. **Band-limiting (PolyBLEP on the saw/square edges) is filed as a future follow-up** (see "Future follow-ups") — not built in v1.
3. **LFO `rate` and `shape` are themselves modulation destinations.** All four new descriptor rows are `modulatable: true`, so they automatically join the derived `MOD_DESTS`. The matrix can therefore sweep an LFO's rate or shape — including LFO→LFO and env→rate routings. This is safe by construction because the matrix already reads *previous-sample* source values (I3a's design), so an LFO modulating its own rate cannot create a within-sample feedback cycle.
4. **Output is bipolar −1..+1**, so an LFO sums into `ParamSlot.mod` exactly like the existing `noise` source (sine/tri/saw/square all swing −1..+1).

## Components & data flow

All changes are additive. Nothing existing changes shape.

### 1. Shared — descriptor table (append-only, +4 rows) · `packages/shared/src/engines/synth2-descriptors.ts`

Append exactly four rows after the current last row (`filter.type`). The param-block index is the array position, so these MUST be appended, never inserted.

| key | min | max | default | taper | modulatable | modScale |
|---|---|---|---|---|---|---|
| `lfo1.rate` | 0.01 | 2000 | 5 | `expOctaves` | true | 4 |
| `lfo1.shape` | 0 | 4 | 0 | `linear` | true | 1 |
| `lfo2.rate` | 0.01 | 2000 | 0.5 | `expOctaves` | true | 4 |
| `lfo2.shape` | 0 | 4 | 1 | `linear` | true | 1 |

- `rate` as a mod **destination** is exponential ±4 octaves (`expOctaves`/`modScale 4`, mirroring `filter.cutoff` and the spec's "cutoff/rate destinations exponential ±4 octaves"). Its **base value** is plain Hz; the log response is a panel-knob mapping, not a stored transform. ParamSlot smooths the Hz value linearly — fine for 0.01..2000.
- `shape` is `linear`/`modScale 1` (±full range at |amount|=1), exactly like `osc1.morph`.
- `MOD_SOURCES` is **unchanged** — `lfo1`/`lfo2` already exist there (inert since I3a). Only their DSP is added.
- `MOD_DESTS` is derived (`'none' + every modulatable descriptor key`), so it auto-grows by these four keys.
- `PARAM_COUNT` (= `SYNTH2_DESCRIPTORS.length`) goes 35 → 39. `MATRIX_BASE = PARAM_COUNT` and `BLOCK_LENGTH = PARAM_COUNT + MATRIX_SLOTS*MATRIX_STRIDE` shift automatically — all derived, no positional literals. The append-only ABI invariant holds (every client rebuilds the layout from the same table).

### 2. Shared — params + defaults · `packages/shared/src/engines/synth2.ts`

- Add `export interface Synth2LfoParams { rate: number; shape: number }`.
- Add `lfo1: Synth2LfoParams` and `lfo2: Synth2LfoParams` to `Synth2EngineParams` (placed near the other module fields).
- `buildDefaults()` already groups descriptor rows by module prefix into nested objects, so `params.lfo1.rate`, `params.lfo1.shape`, `params.lfo2.rate`, `params.lfo2.shape` populate automatically from the new rows. No change to the build logic; only the interface gains the typed fields (the test asserts interface ↔ table agreement).

### 3. Shared — Zod schema + accept-list: zero hand-edits · `schema.ts`, `accept-list.ts`

Both are **fully descriptor-derived** for synth2:
- `schema.ts` `synth2Modules` loop groups leaf schemas by module prefix, so `Synth2ParamsSchema` auto-gains `lfo1`/`lfo2` objects.
- `accept-list.ts` line ~73 maps every descriptor to a leaf pattern, and `resolveLeafSchema` resolves `engines.synth2.<module>.<field>` via `SYNTH2_LEAF_SCHEMAS`.

No code edits required. Add contract tests asserting the four LFO leaves validate (accept in-range, reject out-of-range) and that `MOD_DESTS` contains all four keys.

### 4. Client kernel — `Lfo.ts` (the one genuinely new module) · `packages/client/src/engine/synth2/kernel/Lfo.ts`

Follows the `DspModule` convention (constructor takes its `ParamSlot`s, `reset()`, per-sample `next()`):

- `constructor(rateSlot: ParamSlot, shapeSlot: ParamSlot, sampleRate: number)`.
- `reset(): void` — sets phase to 0 (called on note-on for per-voice retrigger).
- `next(): number` — advances a `phase` accumulator in [0,1) by `rateSlot.next() / sampleRate` (wrapping), then returns the morphed waveform value, **bipolar −1..+1**.
- `rateSlot.next()` and `shapeSlot.next()` are each called **exactly once** inside `next()` (the once-per-sample smoother-advance invariant).
- Alloc-free: no `new`, no array growth in `next()`.

**Naive shapes from phase `p` ∈ [0,1):**
- sine: `Math.sin(2π·p)`
- triangle: `1 − 4·|((p + 0.25) mod 1) − 0.5|` (−1..+1, peak at p=0.25)
- saw-up: `2·p − 1`
- saw-down: `1 − 2·p`
- square: `p < 0.5 ? 1 : −1`

**Morph (`shape` s ∈ [0,4]):** linear crossfade between the two adjacent integer shapes. `i = floor(s)` clamped to 0..3, `f = s − i`; return `wave[i]·(1−f) + wave[i+1]·f` where `wave` is the ordered list above (index 4 = square). At integer `s` the result is exactly that waveform. (Only the two adjacent shapes are evaluated per sample, not all five.)

### 5. Client kernel — `Voice.ts` wiring · `packages/client/src/engine/synth2/kernel/Voice.ts`

- Instantiate `lfo1`/`lfo2` on their rate/shape slots (`slot('lfo1.rate')`, `slot('lfo1.shape')`, …).
- Add module-level `const SRC_LFO1 = MOD_SOURCES.indexOf('lfo1')`, `SRC_LFO2 = MOD_SOURCES.indexOf('lfo2')`.
- Add fields `lfo1Prev = 0`, `lfo2Prev = 0` (previous-sample source memory, mirroring `env1Prev`/`env2Prev`/`noisePrev`).
- `noteOn(...)`: call `this.lfo1.reset(); this.lfo2.reset();` (retrigger) and zero `lfo1Prev`/`lfo2Prev` alongside the existing prev resets, so a reused/stolen voice doesn't bleed the prior note's LFO value into the matrix for one sample.
- `renderAdd` loop **top** (before `matrix.apply`): `this.sources[SRC_LFO1] = this.lfo1Prev; this.sources[SRC_LFO2] = this.lfo2Prev;`
- `renderAdd` loop **bottom** (with the existing prev captures): `this.lfo1Prev = this.lfo1.next(); this.lfo2Prev = this.lfo2.next();`

This reuses I3a's previous-sample source pattern exactly: a 1-sample (~21 µs) delay, inaudible, and it makes LFO-as-matrix-destination feedback (e.g. `lfo2 → lfo1.rate`) cycle-free.

### 6. Client engine / params.ts / useSynth.ts: ride existing rails (no new logic)

LFO leaves are ordinary numeric descriptor leaves, one level under `engines.synth2` (like `osc1.morph`):
- `Synth2Engine.ts` — the descriptor-walk encode already covers any `params.<module>.<field>`; the `if (mod === 'matrix') continue;` guard is unaffected. `lfo1`/`lfo2` modules are walked automatically. (No array complications — that was matrix-specific.)
- `kernel/params.ts` — `PARAM_COUNT`/`MATRIX_BASE`/`BLOCK_LENGTH` are all derived; the new rows extend the block with no code change.
- `useSynth.ts` — the existing synth2 `emitLeafDiff` one-level drill covers `engines.synth2.lfo1.rate` etc.; no dedicated watcher needed (the matrix needed one only because it is an array). `lfo1.rate`/`lfo1.shape` are continuous leaves → throttled like other continuous params.

Add regression tests (engine encodes lfo leaves into the block; `lfo1.rate` converges between two clients) but no new production logic in these files.

### 7. Client UI — `Synth2Panel.vue`

Add an **LFO section**: two module-groups (LFO1, LFO2), each with a `rate` Knob (log response, 0.01–2000 Hz) and a `shape` Knob (0–4). Bind via the existing slice pattern — `v-model="params.lfo1.rate"`, sync paths via `ks.pathFor(['lfo1','rate'])` and `@gesture-end="ks.end(['lfo1','rate'])"`, mirroring the existing osc/filter module-groups. Place as a new column adjacent to the MATRIX column; bump the visualizer column index accordingly.

### 8. Normalize / healing

- Old **client** snapshots lacking `lfo1`/`lfo2` heal via `reconcileWithDefaults` → `deepMerge(DEFAULT_SYNTH2_PARAMS, loaded)` (already in place; the I3a `structuredClone` fix covers nested objects).
- The **server-side** old-session deep-heal remains the known-deferred gap — same as every prior descriptor append. New sessions get `lfo1`/`lfo2` from factory defaults; old sessions won't sync the new leaves until the deep-heal lands. Not fixed in this slice (tracked in memory/backlog).

## Testing

- **shared `synth2-descriptors.test.ts`:** descriptor table grows by exactly 4 (append-only assertion on the tail keys/values); `MOD_SOURCES` unchanged; `MOD_DESTS` contains `lfo1.rate`, `lfo1.shape`, `lfo2.rate`, `lfo2.shape`.
- **shared `synth2.test.ts`:** defaults — `lfo1 {rate:5, shape:0}`, `lfo2 {rate:0.5, shape:1}`; interface ↔ table agreement still holds.
- **shared `schema.test.ts` / `accept-list.test.ts`:** the four LFO leaves accept in-range values, reject out-of-range; the accept-list round-trips `engines.synth2.lfo1.rate` etc.
- **kernel `Lfo.test.ts`:** phase advances at the expected rate (cycles/sec); each integer `shape` yields the textbook waveform (sample at known phases); morph at a half-integer crossfades the two neighbours; `reset()` returns phase to 0; output stays within [−1, 1]; `next()` is allocation-free.
- **kernel `Voice.test.ts`:** routing `lfo1 → <dest>` with amount > 0 produces cyclic modulation on that dest (compare a windowed measurement to the unrouted baseline); note-on retrigger resets LFO phase (bleed test with verified teeth — fails if `reset()` is removed).
- **client `Synth2Engine.test.ts`:** `applyParams` encodes `lfo1.rate`/`shape` into the correct block indices.
- **client sync (`useSynth.test.ts`):** `lfo1.rate` change converges between two clients (no echo).
- **client `Synth2Panel.test.ts`:** LFO knobs render and update `params.lfo1.*` / `params.lfo2.*`.
- **Gate (must be green before merge):** `npm run typecheck && npm test && npm run build` across all three workspaces; build still emits `worklets/synth2-processor.js` and it contains the LFO code.

## Out of scope (explicit)

- **env3 + loop mode** on all three envelopes → I3c. `env3` stays an inert matrix source.
- **Morph filter** (`filter.model` enum + `filter.morph` + `MorphFilter`) → I3d.
- **Free-running / global LFO mode** → I4 nicety (per-LFO retrigger toggle). v1 is always per-voice retriggered.
- **Tempo-synced LFO rates** → I4 nicety.
- **Server-side old-session deep-heal** → known-deferred backlog item, not this slice.

## Future follow-ups

- **Band-limited LFO shapes (PolyBLEP).** If audio-rate LFO → pitch/cutoff FM sounds harsh in practice, add PolyBLEP to the saw/square edges (reusing the oscillator technique). Deferred from v1 by decision; revisit if the naive shapes prove audibly poor.

- **Waveshape visualizer for morph controls (osc + LFO).** Render the *actual* current waveform next to (or inside) every continuous morph knob — the osc `MORPH` knobs (sine→tri→saw→pulse) and the LFO `SHAPE` knobs (sine→tri→saw-up→saw-down→square) — so the user can see what they're dialing in rather than reading a bare 0..4 number. Motivation: during I3b browser-verify, both LFO `SHAPE` knobs were parked at ≈2.5, the saw-up↔saw-down crossfade null where the morph output cancels to ~0 (mathematically inherent: `wave(2.5) = 0.5·(2p−1) + 0.5·(1−2p) = 0`), which read as "the LFO does nothing." A small inline waveform preview would make such dead zones (and the chosen shape generally) immediately legible. Spans the I2 osc panel and the I3b LFO panel — a shared `WaveformPreview` mini-component driven by the same shape math the kernel uses. Optional companion: reconsider the shape ordering so the knob midpoint isn't a null (e.g. sine→tri→saw→square), though the visualizer largely removes the need.

## ABI / invariants touched

- `SYNTH2_DESCRIPTORS` append-only honored (+4 rows at the tail; no row reordered or changed).
- Param-block layout grows by 4 floats before the matrix region; `MATRIX_BASE`/`BLOCK_LENGTH` recomputed from `PARAM_COUNT` — no positional literals at call sites.
- Hot path stays allocation-free (the two LFOs preallocated per voice; `Lfo.next()` does no allocation).
