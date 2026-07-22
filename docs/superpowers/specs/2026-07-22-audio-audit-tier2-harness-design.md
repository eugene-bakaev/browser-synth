# Audio Audit — Sub-project B: Tier-2 Harness

**Date:** 2026-07-22 · **Status:** approved design, pre-plan
**Branch:** `feat/audio-lab-tier2`

## Campaign context

Third cycle of the audio-audit series. Sub-project **A** (`feat/audio-lab-audit`,
merged) built the Tier-1 kernel regression suite over the five `*2` engines.
This is **B**: the Tier-2 harness that renders a whole project through a real
browser `OfflineAudioContext`, making the **sequencer** and the five **v1**
engines (Synth, Kick, Hat, Snare, Clap) reachable for measurement. Sub-project
**C** (later) builds the comprehensive sequencer + v1 + full-mix audit suite on
top of this harness.

The A/B/C decomposition and order were user-approved in the sub-project A design
(`docs/superpowers/specs/2026-07-17-audio-audit-v2-suite-design.md`). B was
scoped there as: "Sequencer pure-walk extraction, OfflineAudioContext rendering
driven via Playwright, `render-project` / `--solo` CLI."

**Two decisions taken for this cycle (user-approved during brainstorming):**

1. **Deliverable = harness + a thin sequencer-correctness slice.** B lands the
   reusable Tier-2 harness *and* a small onset-timing-vs-grid check set that
   proves the harness end-to-end. The comprehensive v1/full-mix audit stays in C.
2. **Full trigger-intent walk, shared.** The offline schedule must match the live
   app exactly. Today the scheduling is split — `Sequencer` does the *timing*
   walk (which absolute steps fall in a window), `AudioEngine.togglePlay` does the
   *step→trigger mapping* (per-track modulo, note/mute/velocity/duration,
   poly-chord vs mono vs fire-and-forget drums). We extract the drift-prone
   mapping into one pure function that **both** the live path and the offline
   harness call, so they cannot diverge.

## Goals

1. A whole saved project (the app's Save format) renders offline through the
   real audio graph — real `engineFactories`, real mixer/compressor chain —
   returning stereo samples to Node for analysis.
2. Per-track **solo renders** (`--solo <trackIndex>`) give clean, single-voice
   audio so v1 engines and individual sequencer tracks can be measured without a
   Node port of their DSP.
3. The step→trigger scheduling is **single-sourced**: live playback and the
   offline render call the same pure function; a new unit test pins it and proves
   live behavior is unchanged.
4. A small, committed **sequencer-correctness check set** (onset count, onset
   alignment to the step grid, polymeter wrapping) runs on demand and fails if
   the sequencer stops firing the right trigger at the right time.
5. A `render-project` CLI command writes a normal audio-lab run directory
   (report.json + WAV + plots) for a project, so a human/agent can listen to and
   inspect a full-mix or solo render.
6. The harness/driver **never touches the user's running dev servers** — it
   starts its own Vite server on a free port and its own headless Playwright
   browser, and tears both down when finished.

## Non-goals

- **No comprehensive audit content.** Only the thin sequencer-correctness slice
  ships here; v1-engine fingerprints, full-mix checks, and the sequencer's full
  control surface are sub-project C.
- **No new analysis code.** The harness feeds the existing analysis core
  (`analyzeEnvelope` / `analyzePitch` / `analyzeSpectrum` / `analyzeHealth`) and
  the existing run-dir writer. If C needs a new metric, C adds it.
- **No DSP changes** to any engine.
- **No bit-exact assertions.** Worklet kernels seed their PRNGs with
  `Math.random()` (per-session entropy) → Tier-2 renders are sample-level
  non-deterministic by design. Every check is structural / tolerance-based.
- **No determinism/seed-injection client change.** The sequencer checks are
  seed-independent (a triggered voice produces energy at time T regardless of the
  noise seed), so none is needed.
- **No mid-render tempo automation.** A render uses one fixed BPM (the project's).
  Live BPM-rebasing stays a live-only concern.

## Architecture

One small, faithful client refactor + a new Tier-2 harness/driver inside
`packages/audio-lab`, reusing the existing analysis core. The dependency edge is
one-directional (`audio-lab → client`), the edge that already exists.

```
packages/client/src/
  sequencer/
    schedule.ts            # NEW: pure step→trigger walk (shared live + offline)
    schedule.test.ts       # NEW: pins resolveStepTriggers + live-unchanged
  audio/
    graph.ts               # NEW (Vue-free): engineFactories, sliderToLinearGain,
                           #   buildMasterChain — imported by AudioEngine + harness
    AudioEngine.ts         # MODIFIED: togglePlay calls resolveStepTriggers;
                           #   imports the primitives from graph.ts

packages/audio-lab/src/
  tier2/
    harness/
      index.html           # NEW: minimal Vite root
      main.ts              # NEW: window.renderProject(project, opts) → channels
    vite.harness.config.ts # NEW: root=harness, publicDir=client/public
    driver.ts              # NEW: start server + Playwright, evaluate, decode samples
    fixtures/
      sequencer-check.project.json  # NEW: known-steps project incl. polymeter
    checks/
      sequencer.checks.ts  # NEW: onset count / alignment / polymeter
    driver.test.ts         # NEW: on-demand smoke + sequencer checks
  cli.ts                   # MODIFIED: add `render-project` command
```

## The client extraction (drift-proofing the schedule)

**`packages/client/src/sequencer/schedule.ts`** — pure, no `AudioContext`, no
engine objects:

```ts
export interface TriggerEvent {
  trackIndex: number;
  freq: number | number[];   // drums → 0; synth mono → Hz; poly → chord Hz[]
  duration: number;          // drums → 0; synth → step.length * stepDuration(bpm)
  time: number;              // seconds on the ctx clock
  velocity: number;
}

export function stepDuration(bpm: number): number; // (60 / bpm) / 4

// Reproduces AudioEngine.onStep (AudioEngine.ts:411–451) verbatim, minus the
// live `state.engines[i]?` existence guard (which stays live):
//   for each enabled track: step = track.steps[absoluteStep % patternLength];
//   fire only if step.note && !step.muted; resolve freq/duration by
//   engineType + poly/mono mode (reusing noteToFreq / resolveChordFreqs).
export function resolveStepTriggers(
  project: Project, absoluteStep: number, time: number,
): TriggerEvent[];
```

- **Live path** — `AudioEngine.togglePlay`'s `onStep` closure shrinks to:
  ```ts
  this.currentStep.value = stepIndex;
  for (const ev of resolveStepTriggers(project, stepIndex, time)) {
    state.engines[ev.trackIndex]?.trigger(ev.freq, ev.duration, ev.time, ev.velocity);
  }
  ```
  `Sequencer` keeps its `setInterval` timing loop + BPM-rebasing (inherently
  stateful, offline-irrelevant). The `?.` missing-engine guard stays live.
- **Offline path** — the harness iterates absolute steps `0 … bars*16 - 1` at
  fixed BPM, flattening `resolveStepTriggers(project, k, k * stepDuration(bpm))`
  for each, then schedules every resulting trigger upfront. (Required:
  `OfflineAudioContext` renders faster than realtime — no lookahead loop can
  work.) Per-track modulo lives inside `resolveStepTriggers`, so polymeter falls
  out for free from iterating absolute steps.

**Why safe:** `resolveStepTriggers` is pure given `project` — everything the live
closure reads (bpm, enabled, engineType, steps, patternLength, mode, velocity)
is in `project`. `schedule.test.ts` pins it against known projects and pins that
the extracted output equals the pre-refactor triggers; live playback is
browser-verified identical before merge.

## Tier-2 harness (browser side)

Minimal Vite root at `packages/audio-lab/src/tier2/harness/`. `vite.harness.config.ts`
sets `root` to the harness dir and `publicDir` to the client package's `public/`
so `/worklets/*-processor.js` resolve to the prebuilt worklet bundles.

`main.ts` exposes one function callable from Playwright:

```ts
window.renderProject(
  project: Project,
  opts: { bars: number; soloTrack?: number },
): Promise<{ channels: string[]; sampleRate: number }>; // base64 of Float32 bytes
```

Inside:
1. `frames = ceil(bars * 16 * stepDuration(bpm) * sampleRate) + tailFrames`
   (a decay tail so the last step's release is captured). `sampleRate = 48000`.
2. `const ctx = new OfflineAudioContext(2, frames, 48000)`.
3. `await ctx.audioWorklet.addModule(url)` for each of the five `*2` worklets.
4. Build the graph (see below); if `soloTrack` is set, zero every other track gain.
5. Schedule **all** triggers upfront via the shared walk.
6. `const buf = await ctx.startRendering()`; return each channel as base64 of its
   `Float32Array` bytes (efficient across the CDP boundary; decoded in Node).

### Graph construction — reuse vs. replicate

The drift-prone complexity (scheduling) is already fully shared. The graph wiring
is trivial and stable, so we **share the parts that encode real decisions and
replicate the ~10 lines of wiring**. The shared primitives move into a new
**Vue-free** module `packages/client/src/audio/graph.ts` — so the audio-lab
harness can import them without dragging Vue (which `AudioEngine.ts` imports)
into the harness bundle:

- **Move** `engineFactories` and `sliderToLinearGain` into `graph.ts` (today
  module-local in `AudioEngine.ts`); `AudioEngine` imports them back.
- **Extract** `buildMasterChain(ctx) → { input: AudioNode, output: AudioNode }`
  into `graph.ts` — the DynamicsCompressor (threshold −12, knee 30, ratio 12,
  attack 0.003, release 0.25) + masterGain (0.6) wired together.
  `AudioEngine.buildAudioState` uses it too, so those constants live once.
- The harness assembles the offline graph from these primitives:
  per-track `GainNode` → `buildMasterChain(ctx)` → `ctx.destination`; engines via
  `engineFactories[type](ctx, trackGain)`; track gains via
  `sliderToLinearGain(volume)` with the same solo/mute rule the live
  `updateMixerGains` uses; `--solo` zeroes non-solo track gains.

This keeps the client change small and avoids a risky extraction of
`AudioEngine`'s reactive lifecycle (shallowRef state, fade-disposes, the
applied-command subscription) while still killing drift on the mixer/engine-map
decisions.

## Tier-2 driver (Node side)

`packages/audio-lab/src/tier2/driver.ts` — a library function used by both the
CLI and the on-demand test:

```ts
renderProjectTier2(
  project: Project,
  opts: { bars: number; soloTrack?: number },
): Promise<{ channels: Float32Array[]; sampleRate: number }>;
```

1. **Precondition:** verify `packages/client/public/worklets/*-processor.js`
   exist; if not, fail loudly ("run `npm run build:worklet -w @fiddle/client`").
2. Start the harness Vite server on a **free port** (programmatic
   `vite.createServer` with `vite.harness.config.ts`).
3. Launch its **own** headless Playwright chromium, navigate to the harness page.
4. `page.evaluate` → `renderProject(project, opts)` → receive base64 channels →
   decode to `Float32Array[]` in Node.
5. Hand samples to the **existing** analysis core + run-dir writer.
6. **Always** close the browser and stop the Vite server in `finally`. Never
   touches the user's dev servers (own port, own browser). Requires
   `npx playwright install chromium` once (already noted in `playwright.config.ts`).

**Error handling:** `addModule` failure, render timeout, or an all-zero (silent)
render each surface a clear driver error; partial output (if any) is still
written; the browser always closes in `finally`.

## The sequencer-correctness slice

**Fixture** — `packages/audio-lab/src/tier2/fixtures/sequencer-check.project.json`,
validated by `@fiddle/shared` ProjectSchema on load. A few tracks with known
steps, **including one polymeter track** (patternLength ≠ 16, e.g. 12), rendered
over ~3–4 bars so the short pattern wraps multiple times against the 16-step bar.

**Checks** (`packages/audio-lab/src/tier2/checks/sequencer.checks.ts`) render the
fixture, **solo each track** (so onsets are unambiguous — no overlapping voices
to misattribute), read the onset list from `analyzeEnvelope`, and assert:

1. **Onset count** per track == the number of firing (`note && !muted`) steps in
   the render window.
2. **Onset alignment** — each onset within tolerance (~±5 ms, covering the attack
   ramp + render-quantum boundary) of its expected grid time
   `absoluteStep * stepDuration(bpm)`.
3. **Polymeter** — the ≠16 track's onsets land at the `absoluteStep %
   patternLength` positions across all bars.

All three are **seed-independent** and tolerance-based.

## CLI

Add to `packages/audio-lab/src/cli.ts` (run from repo root as `npm run lab -- …`):

```
render-project <file.json> [--bars N] [--solo <trackIndex>] [--label name] [--out dir]
```

Runs `renderProjectTier2`, then the existing analysis + run-dir writer — a normal
audio-lab run directory (report.json + WAV + plots) for the whole mix or a solo
track.

## Testing & gate placement

- **In `npm test`** (fast, no browser):
  - `schedule.test.ts` — `resolveStepTriggers` against known projects (exact
    trigger list, poly/mono/drum resolution, polymeter modulo) + the extracted
    output equals the pre-refactor live triggers.
  - Existing `Sequencer.test.ts` stays green (timing loop unchanged).
- **On-demand only** (launches chromium, slow — behind a new `npm run lab:tier2`,
  out of the merge gate, mirroring the existing `e2e` and `lab:audit` scripts):
  - Driver smoke test — fixture renders → non-silent, no NaN, onsets present.
  - The three sequencer-correctness checks.
- **Precondition** for the on-demand path: prebuilt worklets present (driver fails
  loudly otherwise).
- **Gate as usual:** `npm run typecheck && npm test && npm run build` stay green;
  audio-lab already joins the workspaces. The **live app is browser-verified to
  play identically** (real playback, clean console) before merge.

## New scripts

- Root `package.json`: `"lab:tier2": "npm run tier2 -w @fiddle/audio-lab"`.
- `packages/audio-lab/package.json`: `"tier2": "vitest run --config vitest.tier2.config.ts"`
  (a separate config so the browser-launching tests never join `npm test`).

## Dependencies

- `@playwright/test` (^1.49.1) and `vite` (^5) are already present. No new
  runtime dependencies. `audio-lab` adds `@playwright/test` + `vite` to its
  devDependencies (hoisted at the root today; declare them where used).

## Phasing (informs the plan)

1. `schedule.ts` extraction + `schedule.test.ts` + wire `AudioEngine.togglePlay`
   to it (client change, unit-tested, browser-verified).
2. Client graph primitives: move `engineFactories` + `sliderToLinearGain` +
   `buildMasterChain` into a Vue-free `audio/graph.ts`; wire `AudioEngine`
   (both `togglePlay`/factories and `buildAudioState`'s master chain) to it.
3. Harness page + `vite.harness.config.ts` (renders, returns samples).
4. Driver + base64 sample decode + run-dir wiring + smoke test.
5. `render-project` CLI command.
6. Fixture project + sequencer-correctness checks + `lab:tier2` script.

Each phase ends with a testable deliverable; phases 3–6 land the on-demand path.
