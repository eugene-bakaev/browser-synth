# Audio Lab — offline sound rendering + analysis for agent verification

**Date:** 2026-07-16
**Status:** approved design, pre-plan
**Owner package:** `packages/audio-lab` (new workspace, dev-only)

## Problem

There is no way for an AI agent (or CI) to *hear* the synth. Browser verification
today confirms UI state and console cleanliness, but "does portamento actually
glide?" or "did the filter cutoff move?" requires a human ear. We want a tool
that renders the app's real DSP offline and produces machine-readable metrics
plus visualizations (oscilloscope, envelope, pitch track, spectrogram) that an
agent can rely on to check whether produced sound matches expectations.

## Goals

- Render **individual engines** and the **whole project mix** to raw samples
  without speakers or human listening.
- Produce **machine-readable metrics** (`report.json`) as the primary output,
  plus plot images (readable by the agent) and a `.wav` (listenable by the
  user) as secondary outputs.
- Be usable **ad-hoc from the CLI** during feature work now; expose the metric
  functions as a library so they can become Vitest regression assertions later
  ("both, ad-hoc first").
- Stay **detached from the app**: a separate workspace package, never shipped,
  zero footprint in the client bundle. One narrow client refactor is allowed
  (see Sequencer extraction) because it removes duplication rather than adding
  coupling.
- Ship a **project skill** (`.claude/skills/audio-lab/SKILL.md`) so future
  agent sessions know the tool exists, how to invoke it, and how to interpret
  its output.

## Non-goals

- No user-facing UI in the app (no oscilloscope panel for end users).
- No reimplementation of any DSP: the lab renders through the app's own code
  paths, never a copy.
- No realtime analysis (tapping the live AudioContext while the user plays).
- No perceptual audio quality scoring (PEAQ etc.) — targeted signal metrics only.
- Pulling sessions from the local DB is out of scope (input = saved project
  JSON; a DB fetch can layer on later).

## Architecture overview

Two render tiers feed one shared analysis core:

```
Tier 1 (Node, instant)          Tier 2 (browser, on demand)
  *2 kernels imported directly     harness page + OfflineAudioContext
  notes + params -> Float32Array   project JSON -> rendered mix channels
            \                          /
             \   (same sample format) /
              v                      v
            analysis core (pure functions)
              |-- report.json  (agent-readable metrics)
              |-- plots: waveform, envelope, pitch track, spectrogram (PNG/SVG)
              `-- render.wav   (user-listenable)
```

Rationale: the `*2` engines are pure TypeScript kernels
(`packages/client/src/engine/<name>2/kernel/`) already exercised in Node by
their unit tests — Tier 1 costs milliseconds and no browser. The v1 engines
and the mixer chain are native Web Audio graphs, so the *only* faithful way to
render them is a real browser `OfflineAudioContext` — Tier 2 pays that cost
only when asked.

## Package layout

```
packages/audio-lab/
  package.json            # @fiddle/audio-lab, private, dev-only
  src/
    render/
      engine.ts           # Tier 1: kernel renderer (Node)
      harness/            # Tier 2: minimal Vite page building the real graph
      driver.ts           # Tier 2: Playwright driver (launch, pipe samples back)
    analyze/
      pitch.ts            # autocorrelation/YIN pitch track
      envelope.ts         # RMS/peak envelope, attack/decay, onsets
      spectrum.ts         # FFT, spectral centroid, band energy, spectrogram data
      health.ts           # clipping, DC offset, silence, NaN/denormal
      compare.ts          # A/B metric deltas between two runs
    report/
      plots.ts            # SVG line plots; PNG spectrogram raster
      wav.ts              # hand-rolled 16-bit PCM WAV writer
      report.ts           # assembles report.json + writes the output directory
    cli.ts                # command dispatch
.claude/skills/audio-lab/SKILL.md   # agent-facing usage + interpretation guide
```

Dependencies (audio-lab only, all dev-time): `fft.js`, `pngjs` (both pure JS),
`playwright` (Tier 2 driver), `vite` (harness dev server). No new dependencies
in client/server/shared.

## Tier 1 — engine renderer (Node)

**Covers:** the five kernel engines (`synth2`, `kick2`, `hat2`, `snare2`,
`clap2`). This is the default tier and the one that unblocks verifying the
upcoming synth2 portamento knob.

**Input spec** (programmatic and via CLI flags):

```ts
interface EngineRenderSpec {
  engine: 'synth2' | 'kick2' | 'hat2' | 'snare2' | 'clap2';
  params?: Record<string, number>;   // app-facing param paths, e.g. 'filter.cutoff'
  notes: NoteEvent[];                // { time, note|freq, duration, velocity }
  seconds: number;                   // total render length (tail included)
  sampleRate?: number;               // default 48000
}
```

**Mechanism:** instantiate the kernel exactly as the worklet entry does
(`new Synth2Kernel(sampleRate)`), build the param block via each kernel's
`params.ts` (`defaultParamBlock()` + `PARAM_INDEX` name lookup), `applyParams`,
call `noteOn(...)` per note, then `process()` in 128-frame blocks into one
Float32Array. Notes use the same trigger signature the worklet message handler
uses (`noteOn(time, freq, duration, velocity, mono)`).

Param names accepted are the same wire keys the app uses (per
`SYNTH2_DESCRIPTORS` and each engine's descriptor table), so a render spec
reads like project state. Unknown names fail loudly with the list of valid keys.

**Output:** mono Float32Array → analysis core.

## Tier 2 — mix renderer (browser)

**Covers:** whole-project renders and anything Tier 1 cannot reach: v1 engines
(Synth, Kick, Hat, Snare, Clap), the TrackMixer chain, engine interaction in
the mix. Per-track **solo renders** of a real project give per-engine analysis
for v1 engines without a Node port.

**Input:** a saved project JSON (the app's Save format, validated by
`@fiddle/shared` ProjectSchema) + `bars` count + optional `soloTrack`.

**Mechanism:**

1. A minimal harness page (its own tiny Vite root inside audio-lab, serving
   `public/worklets/` from the client package) receives the project JSON.
2. It constructs an `OfflineAudioContext` (48kHz, `bars` worth of frames at
   project BPM), loads the worklet modules, builds tracks through the app's
   real `engineFactories` and mixer chain.
3. It schedules **all steps upfront** (no `setInterval` lookahead loop —
   `OfflineAudioContext` renders faster than realtime, so incremental
   scheduling cannot work). BPM is fixed for the render.
4. `startRendering()` → Float32Array channels → returned to Node.
5. `driver.ts` runs the page headlessly with Playwright, passes the project in,
   receives samples back (chunked transfer), and hands them to the same
   analysis core. It starts the harness Vite server itself on a free port and
   shuts everything down when done — it never touches the user's running dev
   servers.

**Enabling client refactor (the only client change):** extract the pure
"steps in range → ordered trigger calls" walk out of `Sequencer`'s
`setInterval` closure (`packages/client/src/sequencer/Sequencer.ts`) into an
exported pure function, and have the live timer call it. The offline harness
calls the same function for the full render window. This guarantees the lab
schedules with identical semantics (polymeter, per-track loop lengths, step
timing math) instead of maintaining a parallel implementation that drifts.
`Sequencer.test.ts` extends to pin the extracted function; live behavior is
unchanged and browser-verified.

## Analysis core

Pure functions over `{ samples: Float32Array, sampleRate: number }`. Each is
unit-tested against synthesized ground truth (a generated 440Hz sine must
report 440±1Hz; a generated linear ramp must report its attack time; a
constructed glide must show the glide in the pitch track).

| Metric | Function | Verifies (examples) |
| --- | --- | --- |
| Pitch track | autocorrelation (YIN-style), ~10ms hop, per-frame f0 + confidence | tuning, octave switches, **portamento glides**, vibrato rate/depth |
| Amplitude | RMS + peak envelope (per-hop), attack/decay times, onset list | envelopes, velocity response, decay knobs, steps firing on time |
| Spectrum | windowed FFT: magnitude spectrum, spectral centroid, per-band energy; spectrogram matrix over time | filter cutoff/resonance moves, LFO wobble, noise vs tonal balance, waveform character |
| Health | clip sample count, DC offset, longest silence, NaN/Inf count | broken voices, stuck notes, dead output, DSP blowups |
| Onset timing | detected onsets vs expected step grid (Tier 2) | sequencer/schedule correctness in the mix |
| A/B compare | metric deltas between two run directories | "porta 0 vs 0.8: pitch settles 3ms vs 180ms"; before/after refactor bit-drift |

## Outputs — the run directory

Every render command writes one directory (default under
`.audio-lab/runs/<timestamp>-<label>/`, gitignored):

```
report.json      # all metrics, machine-readable; the agent's primary input
render.wav       # 16-bit PCM for human listening
waveform.png     # oscilloscope view (full render + zoomed onset)
envelope.svg     # RMS/peak over time
pitch.svg        # f0 track with confidence shading
spectrogram.png  # log-frequency heatmap
spec.json        # the exact input spec (replayability)
```

`report.json` leads with a compact `summary` block (top-level facts an agent
reads first: duration, peak dB, f0 range, onset count, health flags) followed
by full per-hop arrays.

## CLI

Run from repo root as `npm run lab -- <command>`:

```
render-engine <engine> [--set k=v ...] [--notes A3:0:0.5,C4:0.5:0.5]
              [--seconds N] [--label name] [--out dir]
render-project <file.json> [--bars N] [--solo <trackIndex>] [--label name]
analyze <file.wav>                  # metrics for any existing audio file
compare <runDirA> <runDirB>         # A/B metric deltas
```

## The skill (`.claude/skills/audio-lab/SKILL.md`)

Agent-facing documentation, kept in-repo so it travels with the code:

- when to reach for the lab (any audible-behavior change; before claiming DSP
  work done — complements, does not replace, the browser-verification rule);
- command reference with copy-paste examples;
- interpretation heuristics: what a portamento glide looks like in `pitch.svg`,
  what filter-cutoff motion looks like in a spectrogram, meaningful dB
  thresholds, when to trust/ignore low-confidence pitch frames;
- the A/B workflow: render baseline on `main`-equivalent params → make change →
  render again → `compare` → read deltas;
- reminder to attach `render.wav` for the user's ears on contested calls.

## Testing

- Analysis functions: Vitest against synthesized ground-truth signals
  (generated inside the tests — no fixture files).
- Tier 1 renderer: smoke tests per engine (render default patch → non-silent,
  no NaN, onset where the note is).
- Sequencer extraction: existing + extended unit tests pin identical scheduling
  before/after; live playback browser-verified.
- Tier 2 driver: one e2e-style test behind an explicit script (not in `npm test`)
  since it launches a browser.
- Gate as usual: `npm run typecheck && npm test && npm run build` stay green;
  audio-lab joins the workspaces so its tests run with the suite.

## Phasing

- **Phase 1 (first branch, unblocks portamento verification):** package
  scaffold + analysis core + Tier 1 renderer + CLI (`render-engine`, `analyze`,
  `compare`) + skill + `.audio-lab/` gitignore entry.
- **Phase 2 (second branch):** Sequencer extraction + harness page + Playwright
  driver + `render-project` / `--solo` + skill update.

Each phase gets its own implementation plan. The portamento knob task proceeds
after Phase 1, using the lab for its verification.

## Open follow-ups (explicitly deferred)

- Reusing analysis metrics as golden regression assertions in engine test suites.
- Fetching session snapshots from the local Docker DB by ID.
- Stereo-aware metrics (Tier 2 returns channels; initial metrics analyze a
  mono mixdown, per-channel analysis can layer on).
