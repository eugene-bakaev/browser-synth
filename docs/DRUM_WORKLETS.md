# Worklet Drum Engines (kick2 / snare2 / hat2)

New AudioWorklet drum engines, added **alongside** the existing main-thread
`kick`/`snare`/`hat`/`clap` (which stay untouched — existing sessions are
unaffected; users opt in by selecting the new engine on a track). The synthesis
follows Gordon Reid's *Sound On Sound* "Synth Secrets" drum installments.

## Why worklets

The analog drum engines are main-thread node graphs (fresh `OscillatorNode`s +
a shared looped noise buffer per hit). A per-sample worklet kernel unlocks the
techniques that make drums sound real — nonlinear drive/saturation, ring-mod,
feedback, custom-spectrum noise, multi-band decay — and removes per-hit node
churn. The host/kernel/worklet split is the one already proven by `synth2`.

## Architecture (per engine — mirrors synth2)

- **Descriptor table** — `packages/shared/src/engines/<name>.ts`, built on the
  shared `drum-descriptors.ts` shape. The single source of truth: drives the TS
  params interface, `DEFAULT_<NAME>_PARAMS`, the Zod leaf schema (`schema.ts`),
  the kernel's Float32Array block index layout, and panel knob ranges/labels.
  **APPEND-ONLY once shipped** — the block index is the array position, so
  inserting/reordering a row scrambles every older client's stored params.
- **Pure kernel** — `packages/client/src/engine/<name>/kernel/<Name>Kernel.ts`,
  no AudioContext (unit-testable). `process(out, frames, blockStartFrame)` +
  `noteOn(time, …)` (schedules against the sample clock like `Synth2Kernel`, so
  sequencer look-ahead stays sample-accurate) + `applyParams(block)`.
- **Worklet entry** — `<name>/worklet-entry.ts`, the only file touching
  `AudioWorkletGlobalScope`; `registerProcessor('<name>', …)`. Message protocol
  is identical to synth2: `params` / `trigger` / `dispose`.
- **Host engine** — `packages/client/src/engine/<Name>Engine.ts`
  (`SoundEngine`): `AudioWorkletNode → out GainNode → destination` (keeps the D4
  engine-swap fade), diffs params into a block and posts on change.

### "Append an engine" checklist (touch-points)
`EngineType` union (`shared/src/index.ts`) · `EngineTypeSchema` +
`EnginesMapSchema` + `Schemas` (`schema.ts`) · `EngineParamsMap` (`types.ts`) ·
`freshTrack` seed (`factory.ts`) · `ENGINE_KEYS` deep-heal (`normalize.ts`) ·
accept-list sync paths (`accept-list.ts`) · `engineFactories` + `ENGINE_SLICES`
+ `addModule` (`useSynth.ts`) · `DEFAULTS`/`ALL_ENGINE_TYPES` (`preset.ts`) ·
`reconcileTrack` engines map (`storage.ts`) · panel + StudioView selector/slot ·
`build:worklet` esbuild bundle (`client/package.json`).

## Synthesis reference (SOS "Synth Secrets", Gordon Reid)

- **Kick** ([theory](https://www.soundonsound.com/techniques/synthesizing-drums-bass-drum),
  [practical](https://www.soundonsound.com/techniques/practical-bass-drum-synthesis)):
  sine body + downward pitch envelope (thump) + separate click transient; 909 =
  dual path (saw→waveshaper sine + noise/pulse click); drive for the "thwack";
  808 goes slightly flat at long decays (the `droop` knob).
- **Snare** ([theory](https://www.soundonsound.com/techniques/synthesizing-drums-snare-drum),
  [practical](https://www.soundonsound.com/techniques/practical-snare-drum-synthesis)):
  two tuned shell oscillators + noise "wires" split into HP-filtered/unfiltered
  bands with independent decays; `snappy` balances shell vs noise.
- **Hats** ([metallic](https://www.soundonsound.com/techniques/analysing-metallic-percussion),
  [cymbal](https://www.soundonsound.com/techniques/practical-cymbal-synthesis)):
  six enharmonic square oscillators (the documented 808 cluster) → bands → HP/BP
  → multiple VCAs with different decay per band (the shimmer); closed vs open =
  envelope length.

## Delivery phases

Each phase: own branch → gate (`typecheck && test && build`) → browser-verify →
merge → review before the next.

1. **kick2 walking skeleton** — all the plumbing + kick2 "modern" default voicing
   + panel. (params: tune, punch, pitchDecay, decay, click, drive, droop, level)
2. **Factory presets** — preset library + panel picker; kick2 `808`/`909`/`Modern`.
3. **snare2** — engine + presets.
4. **hat2** — engine + presets.

Both "modern/original" defaults and "classic 808/909" presets ship per engine.
