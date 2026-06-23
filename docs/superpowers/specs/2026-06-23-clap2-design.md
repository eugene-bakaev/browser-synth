# clap2 — worklet hand-clap engine (design)

**Date:** 2026-06-23
**Status:** approved (brainstorm) — pending spec review
**Branch:** `feat/clap2-worklet-engine` (from `main` 6e631ce)

## Goal

Add `clap2`, a fourth AudioWorklet drum engine, **alongside** the existing
main-thread `clap` (which stays untouched). It mirrors the kick2/snare2/hat2
host/kernel/worklet pattern exactly (see `docs/DRUM_WORKLETS.md`) and models the
classic TR-909 hand-clap: a burst of several tightly-spaced noise transients plus
a longer reverberant "room" tail, the whole thing bandpass-shaped. Users opt in by
selecting `clap2` on a track; existing saved sessions are unaffected.

## Scope & non-goals

- **Additive.** New engine type `clap2`. The legacy `clap` engine, its descriptor,
  panel, and tests are not modified. No existing session changes behaviour.
- **No factory presets.** Matches its shipped siblings (kick2/snare2/hat2 all ship
  with only their "modern" descriptor defaults). The factory-preset picker is a
  separate, already-deferred cross-cutting feature (see `docs/BACKLOG.md`) intended
  to land for all engines at once. clap2 ships with one built-in voicing: the
  descriptor defaults. File Save/Open of presets already covers clap2 once it is a
  registered engine type.
- **No choke/hat-interaction group.** Out of scope (future work, as for hats).
- **Reuses the new knob tapers.** clap2's descriptor-driven panel binds
  `:curve="d.curve"`, so wide-range knobs get the perceptual response shipped in
  `feat/knob-tapers` for free. No taper code changes.

## Architecture (mirrors synth2 / the `*2` drum engines)

Per `docs/DRUM_WORKLETS.md` "Architecture (per engine)". New files:

- **Descriptor table** — `packages/shared/src/engines/clap2.ts`: the single source
  of truth. Built on the shared `drum-descriptors.ts` shape; drives the TS params
  interface (`Clap2EngineParams`), `DEFAULT_CLAP2_PARAMS` (via `buildDrumDefaults`),
  the Zod leaf schema, the kernel's Float32Array block-index layout, and the panel
  knob ranges/labels. **APPEND-ONLY once shipped** — block index = array position.
- **Shared shape (additive)** — `drum-descriptors.ts`: add optional `step?: number`
  and relax `format` to optional (`format?: DrumKnobFormat`) on
  `DrumParamDescriptor`, for the integer `bursts` knob (see Descriptor section).
  Backward-compatible; the existing engines' descriptors and panels are unchanged.
- **Pure kernel** — `packages/client/src/engine/clap2/kernel/Clap2Kernel.ts`, no
  AudioContext (unit-testable). Same contract as `Hat2Kernel`:
  `process(out, frames, blockStartFrame)` + `noteOn(time, _freq, _duration,
  velocity)` (schedules against the sample clock via the event ring-buffer, so
  sequencer look-ahead stays sample-accurate) + `applyParams(block)`. Deterministic
  xorshift32 noise (seeded) so kernel tests are reproducible.
- **Block layout** — `packages/client/src/engine/clap2/kernel/params.ts`:
  `PARAM_COUNT` / `PARAM_INDEX` / `defaultParamBlock()` generated from
  `CLAP2_DESCRIPTORS` (copy of hat2's `params.ts`, addressed by key never position).
- **Worklet entry** — `packages/client/src/engine/clap2/worklet-entry.ts`, the only
  file touching `AudioWorkletGlobalScope`; `registerProcessor('clap2', …)`. Message
  protocol identical to siblings: `params` / `trigger` / `dispose`.
- **Host engine** — `packages/client/src/engine/Clap2Engine.ts` (`SoundEngine`):
  `new AudioWorkletNode(ctx, 'clap2', …) → out GainNode → destination` (keeps the D4
  engine-swap fade), diffs `applyParams` into a Float32Array block and posts on
  change; `trigger` posts a message.
- **Panel** — `packages/client/src/components/Clap2Panel.vue`: descriptor-driven
  `<Knob v-for>` with `:curve="d.curve"` (model on `Hat2Panel.vue`).

### Worklet build
Add a `build:worklet` esbuild bundle for `clap2/worklet-entry.ts` →
`public/worklets/clap2-processor.js`, and an `addModule('…/clap2-processor.js')`
await in `useSynth.buildAudioState` before any engine constructs its node (same
invariant as pulse/synth2/kick2/snare2/hat2).

### "Append an engine" touch-points
Per `docs/DRUM_WORKLETS.md` checklist:
`EngineType` union (`shared/src/index.ts`) · `EngineTypeSchema` + `EnginesMapSchema`
+ `Schemas` (`schema.ts`) · `EngineParamsMap` (`types.ts`) · `freshTrack` seed
(`factory.ts`) · `ENGINE_KEYS` deep-heal (`normalize.ts`) · accept-list sync paths
(`accept-list.ts`) · `engineFactories` + `ENGINE_SLICES` + `addModule`
(`useSynth.ts`) · `DEFAULTS`/`ALL_ENGINE_TYPES` (`preset.ts`) · `reconcileTrack`
engines map (`storage.ts`) · `engineLabel` display label · panel + StudioView
selector button/slot · `build:worklet` (`client/package.json`).

The shared normalize/heal must deep-merge the new `clap2` engine slice at the
boundary so old sessions don't drop ops when the slice is added (the documented
*synth2 old-session sync gap*). Verify the `ENGINE_KEYS` deep-heal covers `clap2`.

## Synthesis model — 909 burst + room

The 909 hand-clap is a noise source gated by a short train of fast amplitude pulses
(the individual claps of cupped hands) summed with a single longer reverberant tail
(the room), then bandpass-filtered around ~1 kHz. The kernel renders this per-sample
in the mono voice (a retrigger restarts it, like hat2):

- **Source:** white noise (deterministic xorshift32), shared by burst and tail.
- **Bandpass:** a 2-pole resonant bandpass centred at `tone`, **fixed Q ≈ 1.2** (the
  analog `ClapEngine` value — not a knob; YAGNI). State-variable or biquad-bandpass
  form in the kernel; coefficients recomputed per render block from `tone`.
- **Burst envelope:** `bursts` transients (integer 2–5), the first at the hit time
  and each subsequent one delayed by `spread` seconds. Each transient is a fast
  attack + exponential decay of time-constant `body` (e.g. ~8 ms). Implemented by
  tracking elapsed voice time `t` and, for each transient `j` at offset `j·spread`,
  adding `exp(-(t − j·spread)/τ_body)` for `t ≥ j·spread`.
- **Room (tail) envelope:** a single exponential decay of time-constant `room`
  (e.g. ~250 ms) starting at the hit time — the reverberant wash after the claps.
- **Mix:** `mix` crossfades burst-sum vs room: `env = burst·(1−mix·0.5)` blended
  with `tail·mix` (exact blend tuned during build so neither path disappears at the
  extremes; default `mix=0.5` gives a balanced 909 clap). A short (~0.5 ms) attack
  ramp on each transient avoids onset clicks.
- **Output:** `bandpass(noise) · env · velocity · level`. The voice deactivates when
  the combined envelope falls below ~1e-4 (so `process` stops summing once silent).

The total active span is roughly `(bursts−1)·spread + room`; the event-driven
`process` loop renders any scheduled hit at its sample offset exactly as in hat2.

## Descriptor / param table (append-only ABI)

`CLAP2_DESCRIPTORS` (7 params). `curve` drives the panel knob taper only
(presentational); `format` drives the value readout; `step` (where set) is the
linear drag snap.

| # | key      | label   | min  | max  | default | step | format    | curve   | role                                            |
|---|----------|---------|------|------|---------|------|-----------|---------|-------------------------------------------------|
| 0 | `tone`   | Tone    | 500  | 3000 | 1000    | —    | `hz`      | `exp`   | bandpass centre frequency (Q fixed ≈ 1.2)       |
| 1 | `spread` | Spread  | 0.005| 0.040| 0.012   | —    | `ms`      | `exp`   | spacing between burst transients (tight↔loose)  |
| 2 | `bursts` | Bursts  | 2    | 5    | 3       | 1    | *(none)*  | `linear`| number of transients in the burst (integer)    |
| 3 | `body`   | Body    | 0.002| 0.030| 0.008   | —    | `ms`      | `exp`   | per-transient decay time-constant               |
| 4 | `room`   | Room    | 0.050| 0.800| 0.250   | —    | `ms`      | `exp`   | reverberant tail decay time-constant            |
| 5 | `mix`    | Mix     | 0    | 1    | 0.5     | —    | `percent` | `linear`| burst-body ↔ room-tail balance                  |
| 6 | `level`  | Level   | 0    | 1    | 0.8     | —    | `percent` | `linear`| output level                                    |

**Integer `bursts` knob — two additive descriptor fields.** A 2–5 integer count
needs (a) integer drag-snap and (b) a plain-number readout. `Knob.vue` already
supports both: the **linear** drag path snaps to `step` (the `exp` path ignores
`step` — it snaps in position space via `roundSig`), and an **undefined `format`**
renders the raw number (`val.toString()` → "3"). The only gap is that the shared
`DrumParamDescriptor` has no `step` field and requires `format`. So this design
makes two **additive, backward-compatible** changes to `DrumParamDescriptor`:
- add `step?: number` (omitted ⇒ the panel's existing `(max−min)/100`);
- relax `format` to `format?: DrumKnobFormat` (omitted ⇒ raw-number readout).

Both are used **only** by `clap2`'s `bursts` row. The kick2/snare2/hat2 descriptors
(every row sets `format`) and their panels are unchanged. `Clap2Panel.vue` binds
`:step="d.step ?? (d.max - d.min) / 100"` and `:format="d.format"`. The kernel
additionally rounds and clamps `bursts` to `[2, 5]` defensively. No `Knob.vue`
change.

Other notes:
- `spread`/`body`/`room` are seconds, shown via the `ms` format (as kick2's
  `pitchDecay`/`decay` are). `exp` curve makes the short end of each usable, and
  `exp` ignores `step` (position-space snap), so they need no `step`.
- Ranges mirror the analog `ClapEngine` clamps where they overlap (`tone`
  500–3000, `spread`/`sloppy` 0.005–0.03→0.04, `room`/`decay` 0.05–0.8) so the
  classic voicing is reachable. Once shipped, ranges are an ABI: widening and
  default changes are safe; narrowing is not.

## Knob tapers

No taper code changes. The panel binds `:curve="d.curve"` exactly like the other
drum panels, so `tone`/`spread`/`body`/`room` get `exp` perceptual response and the
linear params stay linear. `exp` is valid here because every `exp` param has a
strictly-positive finite range (`knobTaper` falls back to linear otherwise).

## Testing & verification

- **Kernel unit tests** (`Clap2Kernel.test.ts`, no AudioContext — mirror
  `Hat2Kernel.test.ts`): a `noteOn`+`process` produces non-zero output that decays
  to ~0 within the envelope; the burst produces multiple amplitude peaks spaced by
  `spread` (verifies the pulse train); `bursts` count changes the number of peaks;
  output is deterministic for a fixed seed; scheduling a hit at a future frame
  renders it at the right sample offset; `applyParams` ignores non-finite entries.
- **Descriptor ↔ schema ↔ defaults ↔ block-layout contract test**
  (`clap2.test.ts`, mirror `hat2.test.ts`): `CLAP2_DESCRIPTORS` keys match
  `Clap2EngineParams`, `DEFAULT_CLAP2_PARAMS`, the Zod `Clap2Params` schema, and the
  kernel `PARAM_INDEX`; defaults are within `[min,max]`.
- **Gate** (AGENTS.md): `npm run typecheck && npm test && npm run build` green.
- **Browser verify (MANDATORY** — AGENTS.md / browser-verify-before-done): Playwright
  MCP. Create/open a session, set a track to `clap2`, place steps, Play, confirm an
  audible 909-style clap; drag every knob (incl. the velocity slider) and confirm it
  re-renders and audibly changes (Spread loosens the burst, Bursts changes the
  count, Room lengthens the tail, Tone shifts the colour); confirm the descriptor
  knobs show the perceptual taper (dial angle vs curve math); clean console; close
  the browser tab when done.

## Open notes / decisions

- **`bursts` as a knob (confirmed in brainstorm):** kept as a 2–5 integer knob for
  range, rather than fixed at 3 with `spread` carrying all the variation.
- **Bandpass Q fixed** (not exposed) — analog parity, YAGNI.
- **`mix` blend curve** is tuned during build so neither the burst nor the tail
  fully disappears at the knob extremes; the default `0.5` is a balanced clap.
- Trigger timing: the kernel honours the scheduled `time` (sample clock) via the
  event ring-buffer, never fires on message receipt — copied from `Hat2Kernel`.
- Append-only: future additions (e.g. a `drive`/saturation knob, a `width`/Q knob,
  or `invexp` on a future control) go at the **end** of the descriptor.
