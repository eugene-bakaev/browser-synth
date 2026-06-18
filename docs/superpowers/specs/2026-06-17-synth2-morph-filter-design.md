# synth2 I3d — morph filter design

**Status:** approved (brainstorm 2026-06-17)
**Slice of:** `docs/superpowers/specs/2026-06-12-worklet-synth-engine-design.md` (§5.3 filter / two swappable modules, §5.6 mod matrix, §6.3 ParamSlot / FilterModule seam / discrete params, §6.4 descriptor table, §5.8 defaults). This document refines I3d only.
**Predecessors:** I2c-2 (filter, merged) built the shared `SvfCore`, the `FilterModule` seam, and `ClassicFilter` (the only implementation today) behind it — its header comment already reserves this slice: "MorphFilter arrives in I3 behind this same interface, selected per voice by a future `filter.model` enum." I3a (mod matrix, merged) routes the live sources to every continuous destination; I3b/I3c made `lfo1`/`lfo2`/`env3` live. This slice is the **last I3 feature** — after it the modulation iteration is complete.

## Goal

A second filter behind the existing `FilterModule` seam: a continuous LP→BP→HP **morph** whose blend point (`filter.morph`, 0..2) is a mod-matrix destination, selected per track by a new `filter.model` enum (`'classic' | 'morph'`). The classic discrete LP/BP/HP filter is untouched; switching models is non-destructive. Everything is additive — defaults (`model: 'classic'`) leave behavior unchanged.

**Exit criterion:** add a synth2 track; switch the filter to `morph`; sweep the Morph knob and hear the response move continuously LP → BP → HP. Then route `lfo1 → filter.morph` (amount > 0) in the matrix and hear the filter **architecture** sweep under the LFO — the thing the classic model structurally can't do. Switch back to `classic` and confirm the LP/BP/HP selector and sound are exactly as before. The model + morph changes sync to a second client.

## What the parent spec already settles (§5.3, §5.8)

- **Two filters behind one seam.** Both built on the shared trapezoidal-integration ZDF state-variable core (`SvfCore`), which already yields LP/BP/HP simultaneously from one state. They are two implementations of the `FilterModule` interface, selected per track by `filter.model`.
  - **`classic`** — fixed `type` enum `'lp' | 'bp' | 'hp'`, picking one SVF output. The v1 default. (Exists today as `ClassicFilter`.)
  - **`morph`** — continuous `morph` 0..2 sweeping LP → BP → HP by **equal-power blending adjacent SVF outputs**. `morph` is itself a ParamSlot, i.e. a mod-matrix destination — an LFO or envelope can sweep the filter *architecture*.
- **Shared params (both models, all already present + modulatable):** `cutoff`, `resonance`, `keyTrack`, plus the hardwired `env2 → cutoff` amount (`filter.envAmount`). These are unchanged by this slice.
- **Both param sets persist independently; switching models is non-destructive** (same pattern as the per-track `engines` map). `filter.type` and `filter.morph` coexist; flipping `filter.model` does not clobber either.

## Decisions taken in this brainstorm

1. **`filter.morph` is a continuous, modulatable descriptor row** (range 0..2, default 0 = LP, `taper linear`, `modScale 1`). Continuous + `modulatable: true` ⇒ it auto-joins the derived `MOD_DESTS` with no hand-listing — that derivation *is* the headline feature (LFO/env → filter architecture). `modScale 1` means `|amount| = 1` sweeps the full LP→HP range, matching `osc*.morph` (also a 0..N morph with `modScale 1`).
2. **`filter.model` is a `kind:'enum'` descriptor row** with `enumValues ['classic','morph']`, default index 0 (`classic`), `modulatable: false`. It rides the Float32Array param block as an index and is applied at the **block boundary without a smoother** — the exact pattern as `filter.type` (the only existing enum). This makes schema, accept-list, defaults, engine encode, and sync all derive automatically, exactly like `filter.type`.
3. **The `FilterModule.process` signature gains a 4th arg: `morph`.** `morph` is a per-sample modulatable ParamSlot value (like `cutoffHz`/`resonance`), so it is passed per-sample into `process(input, cutoffHz, resonance, morph)`. `ClassicFilter` **ignores** the new arg (keeps its block-set `type`); `MorphFilter`'s `setType` is an inert no-op. This keeps the Voice's per-sample loop identical regardless of model and matches the codebase's "uniform shape, some fields inert" house style (e.g. `osc1.sync`).
4. **The Voice preallocates both filters; the kernel selects at the block boundary.** A Voice owns one `ClassicFilter` and one `MorphFilter` (both allocated at construction — the zero-alloc hot-path invariant is preserved) plus a `slot('filter.morph')`. The kernel decodes `filter.model` next to the existing `filter.type` decode and tells the Voice which filter is active. Only the **active** filter is `process()`-ed per sample (no double filtering / no extra CPU for the inactive model).
5. **Model switch is a hard switch at the block boundary, with a reset.** Like `filter.type` today, there is no crossfade. On a model **change**, the newly-active filter's `SvfCore` state is `reset()` so its stale state from before cannot click. `filter.type` continues to be applied to the `ClassicFilter` regardless of the active model (non-destructive: the type is ready when you switch back).
6. **`filter.morph`'s ParamSlot is advanced every rendered sample** (once-per-sample invariant), regardless of the active model, and passed into `process()`. In classic mode the value is computed and discarded — cheap, and it keeps the slot's smoother/modulation phase consistent so switching to morph mid-note doesn't jump.

## Components & data flow

All changes are additive. Nothing existing changes shape; `ClassicFilter` behavior is preserved (its only edit is an ignored 4th `process` arg).

### 1. Shared — descriptor table (append-only, +2 rows) · `packages/shared/src/engines/synth2-descriptors.ts`

Append exactly two rows after the current last row (`env3.loop`). The param-block index is the array position, so these MUST be appended, never inserted.

| key | min | max | default | taper | modulatable | modScale | kind | enumValues |
|---|---|---|---|---|---|---|---|---|
| `filter.morph` | 0 | 2 | 0 | `linear` | true | 1 | — | — |
| `filter.model` | 0 | 1 | 0 | `linear` | false | 0 | `enum` | `['classic','morph']` |

- `filter.morph` auto-joins the derived `MOD_DESTS` (`'none' + every modulatable descriptor key`) — the matrix can target it (incl. `lfo1 → filter.morph`, `env3 → filter.morph`).
- `filter.model` mirrors `filter.type` exactly: `kind:'enum'`, `modulatable:false`, `modScale:0`. It is **not** a mod destination; it rides the block as its value's index (classic=0, morph=1). `SYNTH2_ENUM_VALUES` picks it up automatically (it filters `kind === 'enum'` rows).
- `MOD_SOURCES` is **unchanged**.
- `PARAM_COUNT` (= `SYNTH2_DESCRIPTORS.length`) goes 46 → 48. `MATRIX_BASE = PARAM_COUNT` and `BLOCK_LENGTH` shift automatically — all derived, no positional literals.

### 2. Shared — params + defaults · `packages/shared/src/engines/synth2.ts`

- Add `morph: number;` and `model: 'classic' | 'morph';` to the `filter` slice of `Synth2EngineParams` (beside `type`/`cutoff`/`resonance`/`keyTrack`/`envAmount`).
- `buildDefaults()` already groups descriptor rows by module prefix and decodes `kind:'enum'` rows via `decodeEnum` (the `filter.type` enum already proves this), so `params.filter.morph` (0) and `params.filter.model` (`'classic'`, = `enumValues[0]`) populate automatically from the new rows. **No change to the build logic** — only the interface gains the typed fields (the contract test asserts interface ↔ table agreement).

### 3. Shared — Zod schema + accept-list: zero hand-edits · `schema.ts`, `accept-list.ts`

Both are fully descriptor-derived for synth2:
- `schema.ts` `synth2Modules` groups leaf schemas by module prefix; a `kind:'enum'` row becomes a `z.union` of its `enumValues` literals (as `filter.type` already does), and `filter.morph` becomes a ranged number. So `Synth2ParamsSchema`'s `filter` object auto-gains a `morph` number and a `model` `'classic'|'morph'` union.
- `accept-list.ts` maps every descriptor to a leaf pattern; `resolveLeafSchema` resolves `engines.synth2.filter.morph` and `engines.synth2.filter.model` via `SYNTH2_LEAF_SCHEMAS`.

No code edits required. Add contract tests asserting the two leaves validate (morph accepts in-range / rejects out-of-range; model accepts `'classic'`/`'morph'` / rejects other strings) and that `MOD_DESTS` contains `filter.morph` but **not** `filter.model`.

### 4. Client kernel — `FilterModule.ts` seam + `MorphFilter.ts` (new) · `packages/client/src/engine/synth2/kernel/`

- **`FilterModule.ts`** — extend `process` to `process(input: number, cutoffHz: number, resonance: number, morph: number): number`. Update the interface doc comment: `morph` is the per-sample 0..2 blend used by `MorphFilter`; `ClassicFilter` ignores it and uses its block-set `type`.
- **`ClassicFilter.ts`** — add the `morph` parameter to `process` and ignore it (one-line signature change; body unchanged). `setType` unchanged.
- **`MorphFilter.ts`** (new, implements `FilterModule`) — owns its own `SvfCore`. `setType` is a no-op (morph has no discrete type). `reset()` resets the SVF. `process` ticks the SVF once, then **equal-power crossfades** adjacent outputs by `morph`:
  ```ts
  process(input: number, cutoffHz: number, resonance: number, morph: number): number {
    let m = morph; if (m < 0) m = 0; else if (m > 2) m = 2;
    this.svf.tick(input, cutoffHz, resonance);
    const lo = this.svf.low, bd = this.svf.band, hi = this.svf.high;
    let a: number, b: number, frac: number;
    if (m <= 1) { a = lo; b = bd; frac = m; }       // LP → BP
    else        { a = bd; b = hi; frac = m - 1; }    // BP → HP
    const g = frac * (Math.PI / 2);
    return Math.cos(g) * a + Math.sin(g) * b;        // equal-power
  }
  ```
  Endpoints: `morph 0` → pure low (LP), `morph 1` → pure band (BP), `morph 2` → pure high (HP).

### 5. Client kernel — `Voice.ts` wiring · `packages/client/src/engine/synth2/kernel/Voice.ts`

- Replace the single `private readonly filter: ClassicFilter` with `private readonly classicFilter: ClassicFilter;`, `private readonly morphFilter: MorphFilter;`, and `private activeFilter: FilterModule;` (typed by the interface). Add `private readonly morphSlot: ParamSlot = slot('filter.morph');`.
- Constructor: construct both filters; `this.activeFilter = this.classicFilter` (model default `classic`).
- `setFilterType(type)` → `this.classicFilter.setType(type)` (type only meaningful for classic; set regardless of active model so it survives a round trip).
- Add `setFilterModel(modelIndex: number): void` — `const next = modelIndex >= 1 ? this.morphFilter : this.classicFilter; if (next !== this.activeFilter) { next.reset(); this.activeFilter = next; }` (reset the newly-active filter on a change to drop stale SVF state).
- `noteOn(...)`: reset the active filter (`this.activeFilter.reset()`) in place of the current `this.filter.reset()`.
- `renderAdd` per-sample: `const filtered = this.activeFilter.process(mix, fc, this.resSlot.next(), this.morphSlot.next());` — `morphSlot.next()` is called once per sample regardless of model (once-per-sample invariant; classic discards it).

### 6. Client kernel — `Synth2Kernel.ts` model decode · `packages/client/src/engine/synth2/kernel/Synth2Kernel.ts`

In `applyParams`, beside the existing `filterType` decode:
```ts
const filterModel = Math.round(this.block[PARAM_INDEX['filter.model']]);
```
and in the existing voice loop, beside `voice.setFilterType(filterType)`: `voice.setFilterModel(filterModel);`.

### 7. Client engine / params.ts / useSynth.ts: ride existing rails (one accept-list-side edit)

- `Synth2Engine.ts` — the descriptor-walk encode already covers any `params.<module>.<field>`, encoding `kind:'enum'` leaves via `encodeEnum` and `SYNTH2_ENUM_VALUES` (the `filter.type` enum already proves this). `filter.morph` (continuous) and `filter.model` (enum) are walked automatically — no edit.
- `kernel/params.ts` — `PARAM_COUNT`/`MATRIX_BASE`/`BLOCK_LENGTH`/`PARAM_INDEX`/`defaultParamBlock` are all derived; the new rows extend the block with no code change.
- `useSynth.ts` — add `'model'` to `DISCRETE_LEAF_FIELDS` so a filter-model flip flushes immediately (the exact treatment `'type'` already gets). `filter.morph` is a continuous leaf — throttled/smoothed like other continuous params, covered by the existing synth2 leaf-diff drill with no edit.

Add regression tests (engine encodes `filter.morph` + `filter.model` into the correct block indices; a `filter.morph` change and a `filter.model` flip converge between two clients) but no further production logic in these files.

### 8. Client UI — `Synth2Panel.vue` FILTER column

Per the approved layout (**model toggle + swap control**):

- Add a `[CLASSIC | MORPH]` toggle at the top of the FILTER column, above the existing type selector, bound to `params.filter.model` (two buttons mirroring the `SYNC`/`LOOP` pattern: `:class="{ active: params.filter.model === 'classic' }"`, `@click="params.filter.model = 'classic'"`, and the `'morph'` counterpart). Reuse the `.sync-btn`/`.loop-btn` visual (extend the CSS selector).
- When `params.filter.model === 'classic'`: show the existing LP/BP/HP `filter-type-selector` (unchanged).
- When `params.filter.model === 'morph'`: show a single `Morph` Knob (`:min="0" :max="2" :step="0.01"`, `:defaultValue="DEFAULTS.filter.morph"`, `v-model="params.filter.morph"`, sync via `ks.pathFor(['filter','morph'])` / `@gesture-end="ks.end(['filter','morph'])"`) in the selector's place. Label the knob's travel LP–BP–HP.
- The shared Cutoff / Res / KeyTrk / EnvAmt knobs stay below, always visible (unchanged).

### 9. Normalize / healing

- Old **client** snapshots lacking `filter.morph`/`filter.model` heal via `reconcileWithDefaults` → `deepMerge(DEFAULT_SYNTH2_PARAMS, loaded)` (already in place; the `filter` slice is deep-merged, so the two new leaves fill from defaults: `morph 0`, `model 'classic'`). Extend the existing filter heal test to assert this.
- The **server-side** old-session deep-heal remains the known-deferred gap — same as every prior descriptor append. New sessions get `filter.morph`/`filter.model` from factory defaults; old sessions won't sync the new leaves until the deep-heal lands. Not fixed in this slice.

## Testing

- **shared `synth2-descriptors.test.ts`:** descriptor table grows by exactly 2 (append-only assertion on the tail keys/values/kinds/enumValues); `PARAM_COUNT` 48; `MOD_SOURCES` unchanged; `MOD_DESTS` contains `filter.morph` and does **not** contain `filter.model`; `SYNTH2_ENUM_VALUES['filter.model']` is `['classic','morph']`.
- **shared `synth2.test.ts`:** defaults — `filter.morph === 0`, `filter.model === 'classic'`; interface ↔ table agreement still holds.
- **shared `schema.test.ts` / `accept-list.test.ts`:** `filter.morph` accepts in-range (0, 1, 2) / rejects out-of-range (-1, 3); `filter.model` accepts `'classic'`/`'morph'` / rejects `'lp'` and other strings; the accept-list round-trips `engines.synth2.filter.morph` and `engines.synth2.filter.model`.
- **kernel `MorphFilter.test.ts`:** blend endpoints — at `morph 0` the output equals the SVF low output (LP), at `morph 1` the band, at `morph 2` the high (drive the same input through a bare `SvfCore` to get the reference outputs); a midpoint equal-power check (e.g. `morph 0.5` ≈ `cos(π/4)·low + sin(π/4)·band`); `reset()` clears state (a post-reset impulse response matches a fresh instance); `morph` clamps outside 0..2.
- **kernel `Voice.test.ts`:** with `model` = morph and `morph` swept 0→2, the voice's spectral balance moves LP→HP (or simply: the morph path output differs from the classic-LP baseline at `morph 2`); `setFilterModel` switching classic↔morph selects the right module and resets it (a teeth-having test: stale-state bleed appears if the reset is removed); the classic path output is byte-identical to pre-slice behavior when `model` = classic; `morphSlot` is advanced once per sample (no double-advance) — assert via a routed `lfo → filter.morph` producing the expected per-sample morph progression.
- **kernel `Synth2Kernel.test.ts`:** `applyParams` with `filter.model = 1` in the block drives `voice.setFilterModel(1)` (the model reaches the voices); `Math.round` decodes a float32-roundtripped 1 as morph.
- **client `Synth2Engine.test.ts`:** `applyParams` encodes `filter.morph` (continuous) and `filter.model` (as its enum index) into the correct block indices.
- **client sync (`useSynth.test.ts`):** a `filter.morph` change and a `filter.model` flip converge between two clients (no echo); `'model'` flushes immediately (in `DISCRETE_LEAF_FIELDS`).
- **client `Synth2Panel.test.ts`:** the model toggle swaps the control (classic → LP/BP/HP selector visible, Morph knob absent; morph → Morph knob visible, type selector absent); the Morph knob updates `params.filter.morph`; the toggle updates `params.filter.model`.
- **client `reconcile.test.ts`:** a synth2 slice missing `filter.morph`/`filter.model` heals to `0` / `'classic'`.
- **Gate (must be green before merge):** `npm run typecheck && npm test && npm run build` across all three workspaces; build still emits `worklets/synth2-processor.js` and it contains the `MorphFilter` blend.

## Out of scope (explicit)

- **Morph-specific extras** (e.g. a notch/all-pass tap, or morphing beyond the LP→BP→HP path) — v1 morph is the spec's LP→BP→HP equal-power sweep only.
- **Crossfade on model switch** — the switch is a hard block-boundary swap with a reset, like `filter.type`. A smoothed model crossfade is a later nicety, not this slice.
- **Per-voice independent filter models** — `filter.model` is per track (one model per engine slice), like every other filter param.
- **Server-side old-session deep-heal** → known-deferred backlog item, not this slice.

## Future follow-ups

- **Filter-response visualizer** — the I3b/I3c-filed `WaveformPreview` follow-up (osc MORPH + LFO SHAPE + ADSR contour) extends naturally to a small filter magnitude-response curve that animates as `morph`/`cutoff`/`resonance` move (and shows the LP→BP→HP blend). Same motivation: make the shape legible rather than read from bare numbers. Tracked with that follow-up.

## ABI / invariants touched

- `SYNTH2_DESCRIPTORS` append-only honored (+2 rows at the tail; no row reordered or changed).
- Param-block layout grows by 2 floats before the matrix region; `MATRIX_BASE`/`BLOCK_LENGTH` recomputed from `PARAM_COUNT` — no positional literals at call sites.
- `FilterModule.process` arity grows by one (`morph`); both implementations + the single Voice call site update together. The seam stays the only filter boundary.
- Hot path stays allocation-free (both filters preallocated per voice; only the active one is ticked; `MorphFilter.process` does no allocation).
- `Voice.active` semantics unchanged (env1-gated); the filter change does not touch voice lifecycle.
