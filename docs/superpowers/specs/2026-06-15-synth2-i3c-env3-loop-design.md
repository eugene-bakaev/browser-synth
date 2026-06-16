# synth2 I3c — env3 + loop mode design

**Status:** approved (brainstorm 2026-06-15)
**Slice of:** `docs/superpowers/specs/2026-06-12-worklet-synth-engine-design.md` (§5.4 envelopes, §5.6 mod matrix, §6.3 ParamSlot/discrete params, §6.4 descriptor table, §5.8 defaults). This document refines I3c only; the morph filter (I3d) is a separate slice.
**Predecessors:** I3a (mod matrix core, merged) routes the live sources to every continuous destination and reserves `env3` as an **inert** source (position 5 in `MOD_SOURCES`). I3b (LFOs, merged `d7a9014`) made `lfo1`/`lfo2` live and established the per-voice modulator wiring pattern (previous-sample source memory, retrigger-on-note-on) this slice reuses for env3.

## Goal

A third per-voice envelope (`env3`) that fills the already-reserved-but-inert `env3` matrix source, plus a `loop` toggle on **all three** envelopes that turns any ADSR into a tempo-free, note-retriggered LFO. Both additive: defaults leave behavior unchanged.

**Exit criterion:** add a synth2 track; route `env3 → filter.cutoff` (amount > 0) in the matrix and hear the cutoff swept by env3's contour on each note; turn `loop` on for env3 (or the AMP/FILTER envelopes) and hear the contour cycle continuously while a note is held; the changes sync to a second client.

## What the parent spec already settles (§5.4, §5.8)

- **3 loopable ADSRs.** `env1` hardwired to the VCA, `env2` hardwired to cutoff, **`env3` not hardwired** — it exists solely as a selectable mod-matrix source. All three are selectable matrix sources (env1/env2 already are; env3 goes live here).
- Fields per envelope: `a`, `d`, `s`, `r` (same units as the existing engine: a/d/r seconds, s 0..1) **plus `loop: boolean`**.
- **Loop semantics:** while the gate is held and `loop` is on, the envelope cycles **attack → decay → attack → …**. The sustain level is ignored as a resting stage but **still shapes the decay target** (decay runs toward `s`, so `s` is the loop's floor). Gate-off always enters release from the current value. With `loop` off it is a textbook ADSR.
- Retrigger uses the 1 ms ramp-from-held-value (D3 STEAL_RAMP) already in `LoopEnvelope`.
- Defaults (§5.8): **env3 = a 0.2 / d 0.3 / s 0 / r 0.3, loop false**; env1/env2 `loop: false`.

## Decisions taken in this brainstorm

1. **`loop` is encoded as a `kind:'bool'` descriptor row per envelope** (`env1.loop`, `env2.loop`, `env3.loop`) — the exact pattern as the osc `sync` toggles (spec §6.3 line 312 groups "toggles (`sync`, `loop`)"). It rides the Float32Array param block as 0/1, is applied at the **block boundary without a smoother**, and is **excluded from the mod matrix** (`modulatable:false`). This makes schema, accept-list, defaults, and sync all derive automatically, exactly like `sync`.
2. **Loop re-attacks from the held level (no steal ramp mid-cycle).** At the decay→loop transition the level is already at `s`; attack ramps `s → 1` continuously. No discontinuity, so no click and no steal ramp is needed inside the loop. The 1 ms steal ramp stays reserved for note-on retrigger only.
3. **Loop is responsive to a live toggle.** The `sustain` stage also re-enters `attack` when `loop` is on, so flipping `loop` on while a held note is resting in sustain starts it cycling immediately (not only on the next note-on). Symmetric: flipping `loop` off during a cycle lets the next decay settle into sustain.
4. **`s` sets the loop floor (per spec).** `s 0` → full-depth ramp (1→0→1…); high `s` → shallow flutter (1→s→1…). The env3 default `s 0` makes a looping env3 a full-depth ramp LFO out of the box.
5. **env3 advances every rendered sample but does not gate the voice.** `Voice.active` stays tied to `env1` (the VCA). env3 is a modulator: it is retriggered and advanced per note, and simply stops being rendered once env1 ends the voice.

## Components & data flow

All changes are additive. Nothing existing changes shape.

### 1. Shared — descriptor table (append-only, +7 rows) · `packages/shared/src/engines/synth2-descriptors.ts`

Append exactly seven rows after the current last row (`lfo2.shape`). The param-block index is the array position, so these MUST be appended, never inserted.

| key | min | max | default | taper | modulatable | modScale | kind |
|---|---|---|---|---|---|---|---|
| `env3.a` | 0.001 | 10 | 0.2 | `expOctaves` | true | 4 | — |
| `env3.d` | 0.001 | 10 | 0.3 | `expOctaves` | true | 4 | — |
| `env3.s` | 0 | 1 | 0 | `linear` | true | 1 | — |
| `env3.r` | 0.001 | 10 | 0.3 | `expOctaves` | true | 4 | — |
| `env1.loop` | 0 | 1 | 0 | `linear` | false | 0 | `bool` |
| `env2.loop` | 0 | 1 | 0 | `linear` | false | 0 | `bool` |
| `env3.loop` | 0 | 1 | 0 | `linear` | false | 0 | `bool` |

- env3 a/d/r mirror env1/env2 (`expOctaves` time taper, `modScale 4`); `s` is `linear`/`modScale 1`. So env3's a/d/s/r auto-join the derived `MOD_DESTS` (matrix can target them, incl. LFO→env3.a).
- The three `loop` rows mirror the `sync` rows exactly: `kind:'bool'`, `modulatable:false`, `modScale:0`. They are **not** mod destinations (discrete) and ride the block as 0/1.
- `MOD_SOURCES` is **unchanged** — `env3` already exists there (inert since I3a). Only its DSP is added.
- `MOD_DESTS` is derived (`'none' + every modulatable descriptor key`), so it auto-grows by `env3.a`, `env3.d`, `env3.s`, `env3.r` (the loop bools are excluded — `modulatable:false`).
- `PARAM_COUNT` (= `SYNTH2_DESCRIPTORS.length`) goes 39 → 46. `MATRIX_BASE = PARAM_COUNT` and `BLOCK_LENGTH` shift automatically — all derived, no positional literals.

### 2. Shared — params + defaults · `packages/shared/src/engines/synth2.ts`

- Add `loop: boolean;` to `Synth2EnvParams` (env1/env2/env3 all share this interface, so all three gain the field — matching "all three loopable").
- Add `env3: Synth2EnvParams;` to `Synth2EngineParams` (near `env1`/`env2`).
- `buildDefaults()` already groups descriptor rows by module prefix and decodes `kind:'bool'` rows via `decodeBool`, so `params.env3.{a,d,s,r}` and `params.{env1,env2,env3}.loop` populate automatically from the new rows. **No change to the build logic** — only the interface gains the typed fields (the test asserts interface ↔ table agreement).

### 3. Shared — Zod schema + accept-list: zero hand-edits · `schema.ts`, `accept-list.ts`

Both are fully descriptor-derived for synth2:
- `schema.ts` `synth2Modules` groups leaf schemas by module prefix (`z.boolean()` for `kind:'bool'`), so `Synth2ParamsSchema` auto-gains an `env3` object and a `loop` boolean on each of env1/env2/env3.
- `accept-list.ts` maps every descriptor to a leaf pattern; `resolveLeafSchema` resolves `engines.synth2.env3.a`, `engines.synth2.env1.loop`, etc. via `SYNTH2_LEAF_SCHEMAS`.

No code edits required. Add contract tests asserting the env3 leaves + the three loop leaves validate (accept in-range / correct type, reject out-of-range / wrong type) and that `MOD_DESTS` contains the four env3 keys but **not** the loop keys.

### 4. Client kernel — `LoopEnvelope.ts` loop mode · `packages/client/src/engine/synth2/kernel/LoopEnvelope.ts`

The class was named and laid for this (header comment: "the class is named for its I3 destiny — `loop` mode … is appended then"). Add:

- Field `private loop = false;`
- Method `setLoop(loop: boolean): void { this.loop = loop; }` — called at the block boundary (no smoother), mirroring how `setSync`/`setType` apply discrete params.
- **decay → loop:** at the decay target, branch on `loop`:
  ```ts
  if (this.level <= sus) {
    this.level = sus;
    this.stage = this.loop ? 'attack' : 'sustain';
  }
  ```
- **sustain → loop (live-toggle responsiveness):**
  ```ts
  case 'sustain':
    if (this.loop) { this.stage = 'attack'; }
    else { this.level = this.s.next(); }
    break;
  ```

Attack/release/steal/idle and the gate countdown are unchanged. Gate-off still forces release from the current level regardless of stage, so a looping envelope releases correctly on note-off. The once-per-stage slot-advance cadence (existing CADENCE NOTE) is preserved: attack reads `a`, decay reads `d`+`s`, sustain reads `s` only when not looping.

### 5. Client kernel — `Voice.ts` wiring · `packages/client/src/engine/synth2/kernel/Voice.ts`

- Add module-level `const SRC_ENV3 = MOD_SOURCES.indexOf('env3');`
- Add field `private readonly env3: LoopEnvelope;` (with env1/env2) and `private env3Prev = 0;` (with the prev group).
- Constructor: `this.env3 = new LoopEnvelope(slot('env3.a'), slot('env3.d'), slot('env3.s'), slot('env3.r'), sampleRate);`
- Add `setEnvLoop(env1Loop: boolean, env2Loop: boolean, env3Loop: boolean): void` forwarding to `this.env1.setLoop(...)`, `this.env2.setLoop(...)`, `this.env3.setLoop(...)` — mirrors `setSync`.
- `noteOn(...)`: `this.env3.noteOn(gateFrames);` and zero `this.env3Prev = 0;` alongside the existing prev resets.
- `renderAdd` loop **top** (before `matrix.apply`): `this.sources[SRC_ENV3] = this.env3Prev;`
- `renderAdd` loop **bottom** (with the existing prev captures): `this.env3Prev = this.env3.next();` — env3 is advanced every rendered sample even though it feeds nothing but the matrix.

`Voice.active` stays `env1.active` (unchanged): env3 modulates but does not keep the voice alive.

### 6. Client kernel — `Synth2Kernel.ts` loop decode · `packages/client/src/engine/synth2/kernel/Synth2Kernel.ts`

In `applyParams`, beside the existing `osc2Sync`/`osc3Sync`/`filterType` decode:
```ts
const env1Loop = this.block[PARAM_INDEX['env1.loop']] >= 0.5;
const env2Loop = this.block[PARAM_INDEX['env2.loop']] >= 0.5;
const env3Loop = this.block[PARAM_INDEX['env3.loop']] >= 0.5;
```
and in the existing voice loop: `voice.setEnvLoop(env1Loop, env2Loop, env3Loop);`. (Uses the `>= 0.5` bool threshold already used for sync.)

### 7. Client engine / params.ts / useSynth.ts: ride existing rails (no new logic)

- `Synth2Engine.ts` — the descriptor-walk encode already covers any `params.<module>.<field>`, encoding `kind:'bool'` leaves via `encodeBool` (the `sync` toggles already prove this). `env3` and the `loop` leaves are walked automatically.
- `kernel/params.ts` — `PARAM_COUNT`/`MATRIX_BASE`/`BLOCK_LENGTH`/`PARAM_INDEX`/`defaultParamBlock` are all derived; the new rows extend the block with no code change.
- `useSynth.ts` — the existing synth2 leaf-diff drill covers `engines.synth2.env3.a`, `engines.synth2.env1.loop`, etc. (the `osc2.sync` bool already syncs through this path). Continuous env3 knobs are throttled like other continuous params; the loop bools emit on toggle like `sync`.

Add regression tests (engine encodes env3 + loop leaves into the block; an `env3.a` change and an `env1.loop` toggle converge between two clients) but no new production logic in these files.

### 8. Client UI — `Synth2Panel.vue`

Per the approved layout (**in-place LOOP buttons + a new ENV 3 column by the LFOs**):

- **AMP ENV** group (column 1): add a `LOOP` toggle button under the A/D/S/R row, bound to `params.env1.loop` (mirrors the existing `SYNC` button pattern — `:class="{ active: params.env1.loop }"`, `@click="params.env1.loop = !params.env1.loop"`).
- **FILTER ENV** group (column 6): add the same `LOOP` toggle bound to `params.env2.loop`.
- **New ENV 3 column** inserted **after** the FILTER ENV column (becomes column 7; LFOs → 8, matrix → 9, visualizer → 10): a module-group titled `ENV 3` with A/D/S/R knobs bound to `params.env3.{a,d,s,r}` (same Knob props/format as AMP ENV) plus a `LOOP` toggle bound to `params.env3.loop`. Sync paths via `ks.pathFor(['env3','a'])` / `@gesture-end="ks.end(['env3','a'])"` etc.
- Reuse the existing toggle-button visual: extend the `.sync-btn` CSS rule selector to `.sync-btn, .loop-btn` (or apply the `loop-btn` class to the same styles) so the LOOP buttons match SYNC.

### 9. Normalize / healing

- Old **client** snapshots lacking `env3`/`loop` heal via `reconcileWithDefaults` → `deepMerge(DEFAULT_SYNTH2_PARAMS, loaded)` (already in place; nested objects covered).
- The **server-side** old-session deep-heal remains the known-deferred gap — same as every prior descriptor append. New sessions get `env3`/`loop` from factory defaults; old sessions won't sync the new leaves until the deep-heal lands. Not fixed in this slice.

## Testing

- **shared `synth2-descriptors.test.ts`:** descriptor table grows by exactly 7 (append-only assertion on the tail keys/values/kinds); `MOD_SOURCES` unchanged; `MOD_DESTS` contains `env3.a/d/s/r` and does **not** contain `env1.loop`/`env2.loop`/`env3.loop`.
- **shared `synth2.test.ts`:** defaults — `env3 {a:0.2, d:0.3, s:0, r:0.3, loop:false}`, and `env1.loop`/`env2.loop` default `false`; interface ↔ table agreement still holds.
- **shared `schema.test.ts` / `accept-list.test.ts`:** env3 leaves accept in-range / reject out-of-range; loop leaves accept booleans / reject non-booleans; the accept-list round-trips `engines.synth2.env3.a` and `engines.synth2.env1.loop`.
- **kernel `LoopEnvelope.test.ts`:** with `loop` off, behavior is the textbook ADSR (unchanged regression); with `loop` on and a held gate, the level **cycles** (reaches the decay floor `s` then climbs back toward 1 — assert a second attack happens, e.g. level rises again after first reaching `s`); `s` sets the floor (low `s` → deeper swing than high `s`); gate-off from a looping env enters release and reaches 0; toggling `loop` on while in sustain resumes cycling.
- **kernel `Voice.test.ts`:** routing `env3 → <dest>` with amount > 0 modulates that dest on a note (compare to the unrouted baseline — env3 source is no longer 0); note-on retrigger resets `env3Prev` (bleed test with verified teeth — fails if the reset is removed); `setEnvLoop(_, _, true)` makes env3's contribution cyclic over a held note.
- **kernel `Synth2Kernel.test.ts`:** `applyParams` with `env3.loop = 1` in the block drives `voice.setEnvLoop(..., true)` (loop reaches the voices); the `>= 0.5` threshold decodes a float32-roundtripped 1 as true.
- **client `Synth2Engine.test.ts`:** `applyParams` encodes `env3.a` and `env1.loop` (as 0/1) into the correct block indices.
- **client sync (`useSynth.test.ts`):** an `env3.a` change and an `env1.loop` toggle converge between two clients (no echo).
- **client `Synth2Panel.test.ts`:** the ENV 3 knobs render and update `params.env3.*`; the three LOOP buttons toggle `params.{env1,env2,env3}.loop`.
- **Gate (must be green before merge):** `npm run typecheck && npm test && npm run build` across all three workspaces; build still emits `worklets/synth2-processor.js` and it contains the loop branch.

## Out of scope (explicit)

- **Morph filter** (`filter.model` enum + `filter.morph` + `MorphFilter`) → I3d.
- **Free-running / global envelope-LFO mode** (un-retriggered loop) → later nicety; loop is per-voice, retriggered on note-on like the LFOs.
- **Tempo-synced loop rate** → later nicety.
- **Server-side old-session deep-heal** → known-deferred backlog item, not this slice.
- **env3 hardwired routing** — env3 is *only* a matrix source by design (§5.4); no hardwired destination.

## Future follow-ups

- **Waveshape / envelope-contour visualizer** — the I3b-filed inline `WaveformPreview` follow-up (osc MORPH + LFO SHAPE) naturally extends to a small ADSR contour preview per envelope (and a "looping" indicator when `loop` is on). Same motivation: make the shape legible rather than read from bare numbers. Tracked with the I3b follow-up.

## ABI / invariants touched

- `SYNTH2_DESCRIPTORS` append-only honored (+7 rows at the tail; no row reordered or changed).
- Param-block layout grows by 7 floats before the matrix region; `MATRIX_BASE`/`BLOCK_LENGTH` recomputed from `PARAM_COUNT` — no positional literals at call sites.
- Hot path stays allocation-free (env3 preallocated per voice; `LoopEnvelope.next()` and the new loop branch do no allocation).
- `Voice.active` semantics unchanged (env1-gated); env3 is a non-gating modulator.
