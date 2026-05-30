# Slice-down panel binding — design

**Date:** 2026-05-30
**Status:** approved (design)
**Scope:** `@fiddle/client` — `useSynth.ts`, `App.vue`, engine/drum panel components. No
changes to the sync protocol, the audio engines, the sequencer, or `@fiddle/shared`.

## Problem

A single editable parameter's name is currently repeated ~6 times across 4 layers:

1. `useSynth.ts` — `const filterCutoff = trackParam('synth', 'filterCutoff', 2000)` (declaration)
2. `useSynth.ts` — listed again in the `return { … }` block
3. `App.vue` — listed again in the destructure of `useSynth()`
4. `App.vue` — `v-model:filterCutoff="filterCutoff"` on `<SynthPanel>`
5. `SynthPanel.vue` — re-declared `defineModel('filterCutoff')` and re-threaded `v-model` to a child
6. leaf panel (e.g. `FilterPanel.vue`) — `defineModel('cutoff')` + `<Knob v-model="cutoff" :syncPath="ks.pathFor('filterCutoff')">`

Every one of the ~30 `trackParam(engine, param, fallback)` refs is the *identical*
mechanical projection of `project.tracks[activeTrackIndex].engines[engine][param]`.
The `fallback` argument only exists to cover `activeTrackIndex === null`, but panels
render only inside the focused view where the index is never null, so it is largely
dead. The boilerplate is two `v-model` walls deep (App→SynthPanel, SynthPanel→leaf).

Cost: every new parameter, track, or per-step field walks this 6-layer gauntlet. The
no-pivot roadmap items (more tracks, p-locks, variable-length patterns) are all
parameter/field multipliers, so they each pay this tax. This refactor clears it.

There is also a latent trap: `FilterPanel`'s local model name `cutoff` differs from the
real field / sync-path name `filterCutoff`. The two can drift independently.

## Goal

Bind panels directly to the reactive engine slice. Delete the `trackParam` wall, the
`useSynth` export list for params, the App destructure wall, and both `v-model` walls.
Behavior-preserving: the audio reaction and the WebSocket sync must be unchanged.

This is **Phase 1** of a two-phase plan. Phase 2 (descriptor-driven panels — render
knobs from a `{field,label,min,max,curve}` list) is explicitly deferred and will only
be revisited if param/track growth makes per-panel boilerplate hurt again. Phase 2 is
out of scope here.

## Approach (chosen)

**Approach A — `:params` prop, panel mutates the reactive slice directly.**

App passes the reactive engine slice as a single prop; the panel binds its Knobs with
`v-model="params.<field>"`. Because `params` *is* the reactive `project` sub-object (Vue
does not clone reactive objects passed as props), the write propagates straight to
`project`. The existing `useSynth` watchers — unchanged — fire and drive
`engine.applyParams()` and the outbox. The sync-path layer (`knobSync`) is untouched: it
is already `(engine, field)`-based and reads the injected `activeTrackIndex`, so it does
not depend on the value-binding plumbing at all.

Alternatives considered and rejected:

- **B — `:params` down, `@update` event up.** Avoids prop mutation philosophically but
  reintroduces handler-per-field plumbing, i.e. the exact wall being removed.
- **C — panels pull their slice from a `useEngineSlice()` composable** (no prop). Removes
  prop drilling and the prop-mutation concern entirely, but couples panels to the
  global `project` singleton, making them harder to render in isolation. Rejected in
  favor of keeping panels as explicit, prop-driven view components.

## Data flow

**Before:** `project` → `trackParam()` writable-computed (×~30) → App destructure (~40
names) → `v-model:field` → `SynthPanel` `defineModel` (×13) → re-threaded `v-model` →
leaf `defineModel` → `<Knob v-model>`. Sync path computed separately via `knobSync`.

**After:** `project` → App `focusedTrack` computed → one `:params` prop per panel →
panel binds `v-model="params.<field>"` on each `<Knob>`. Writes mutate the reactive
`project` sub-object → existing `useSynth` watchers fire → `engine.applyParams()` +
outbox. Sync path via `knobSync` (unchanged).

## Components

### `useSynth.ts`

- **Delete:** the `trackParam` helper; all ~30 param ref declarations (`osc1Type`,
  `osc1Coarse`, … `clapSloppy`, including `filterEnv`/`ampEnv`); and their entries in the
  `return` object.
- **Delete and replace:** the `engineType` and `synthMode` writable-computeds. Their
  consumers move to reading/writing through `focusedTrack` (see below).
- **Add:** a `focusedTrack` computed:
  ```ts
  const focusedTrack = computed(() =>
    activeTrackIndex.value !== null ? project.tracks[activeTrackIndex.value] : null
  );
  ```
  Returned from `useSynth()`.
- **Keep unchanged:** `project`, `sequencer`, `bpm`, `activeTrackIndex`, `currentStep`,
  `waveforms`, `trackAnalysers`, `trackGains`, `shortestActiveNoteDuration`,
  `togglePlay`, `selectTrack`, `getTrackEngineType`, `ensureAudio`, and the sync surface
  (`fatalError`, `roster`, `selfClientId`). **All watchers, the engine wiring, and the
  sync/outbox logic stay exactly as they are.**

### `App.vue`

- Destructure of `useSynth()` shrinks from ~40 names to ~12 (the "kept" list plus
  `focusedTrack`).
- Each engine/drum panel receives a single `:params` prop instead of the `v-model:`
  wall, e.g. `<SynthPanel :params="focusedTrack!.engines.synth" … />`,
  `<KickPanel :params="focusedTrack!.engines.kick" … />`. The `!` is safe because the
  panels render only inside the `v-else` focused branch (`activeTrackIndex !== null`).
- The engine-selector buttons and the focused-view header read/write
  `focusedTrack!.engineType` instead of the deleted `engineType` computed. The Tracker's
  `:mode` reads `focusedTrack!.engines.synth.mode`.
- `analyser` (`activeAnalyser`), `color`, `waveforms`, and `shortestActiveNoteDuration`
  continue to be passed as plain props — they are not editable slice data.

### `SynthPanel.vue`

- Replace the 13 `defineModel(...)` declarations with a single `params` prop typed as the
  synth engine slice.
- Pass the same `params` object down to the four sub-panels
  (`OscillatorPanel`, `MixerPanel`, `FilterPanel`, `EnvelopePanel`); each binds the
  fields it owns. (Decision: pass the whole synth slice rather than carving sub-objects —
  simplest, and matches how they already share one slice.)
- The mono/poly toggle writes `params.mode` directly.
- `waveforms`, `shortestActiveNoteDuration`, `analyser`, `color` remain plain props.

### Leaf panels — `FilterPanel`, `OscillatorPanel`, `MixerPanel`, `EnvelopePanel`, `KickPanel`, `HatPanel`, `SnarePanel`, `ClapPanel`

- Replace `defineModel(...)` declarations with a `params` prop (the relevant engine
  slice).
- Bind each `<Knob>` with `v-model="params.<field>"`, using the **real field name** so it
  matches `ks.pathFor('<field>')` (this removes the `cutoff`↔`filterCutoff` style
  aliasing). `EnvelopePanel` reads `params.filterEnv` / `params.ampEnv` and binds the
  nested `a/d/s/r` knobs to `params.filterEnv.a` etc.
- `knobSync` usage (`useKnobSync('<engine>')`, `ks.pathFor`, `ks.end`) is unchanged.

## What does NOT change

- The sync protocol, the path accept-list, `knobSync`, and the `flush:'sync'` suppression
  invariant.
- All `useSynth` watchers (engine slice / mixer / steps / bpm / engineType) and the
  outbox/applyOp logic.
- The audio engines, the sequencer, `@fiddle/shared`, the server.
- Panel CSS / layout / markup structure (only the value bindings change).

## Testing & verification

- **Behavior-preserving.** The source of truth (`project`) and every watcher are
  untouched.
- `useSynth.test.ts` exercises the watcher layer by mutating `project` directly (e.g.
  `synth.project.tracks[0].engines.synth.filterCutoff = 1234` → assert `applyParams` /
  outbox path). It does **not** reference the `trackParam` refs, so deleting them leaves
  these tests green and unchanged.
- There are **no component-mount tests** for the panels, so no panel test churn.
- Verification gate (must be green before merge):
  `npm run typecheck && npm test && npm run build`.
- Manual/Playwright check: turning a knob in the focused view still (a) changes the audio
  and (b) broadcasts the op to a second client — covering both the engine and sync paths
  that the deleted indirection used to carry.

## Risks

- **`vue/no-mutating-props`** may flag nested writes to the `params` prop
  (`params.filterCutoff = …` via `v-model`). This is the one real unknown. Resolution
  options, in order of preference: (1) set the rule's `shallowOnly: true` if nested
  mutation is the only thing flagged; (2) scope a documented disable for the slice-prop
  panels, treating `params` as an intentional shared-reactive-store binding (functionally
  identical to today's writable-computed, which already mutates shared `project`).
  Confirm the project's ESLint config during implementation and pick the narrowest fix.
- Everything else is mechanical and TypeScript-checked: a wrong field name or slice type
  fails `typecheck`.

## Out of scope

- Phase 2 descriptor-driven panels.
- Any roadmap feature (more tracks, p-locks, variable-length patterns). This refactor
  only removes the boilerplate that those features would otherwise multiply.
