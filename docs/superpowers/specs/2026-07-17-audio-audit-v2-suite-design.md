# Audio Audit — Sub-project A: v2 Kernel Regression Suite

**Date:** 2026-07-17 · **Status:** approved design, pre-plan
**Branch:** `feat/audio-lab-audit`

## Campaign context

The user asked for a comprehensive, tool-powered verification of the app's
sound: engines sound correct, the sequencer behaves, every control does what
it claims. One audit can't cover that today — the audio lab's Tier 1 renders
only the five `*2` kernels; the sequencer, the five v1 engines, and the full
mix need the Tier 2 harness (specced in the Phase-1 audio-lab spec, not
built). The campaign therefore decomposes into three sub-projects, each with
its own spec → plan → build cycle, in this order (user-approved):

- **A (this spec): v2 kernel regression suite** on today's Tier 1 — a
  permanent, committed, re-runnable audit of the five `*2` engines' sound and
  controls. Its first run is the audit of that half of the surface.
- **B: Tier 2 harness** — Sequencer pure-walk extraction, OfflineAudioContext
  rendering driven via Playwright, `render-project` / `--solo` CLI. Makes the
  sequencer and v1 engines reachable.
- **C: sequencer + v1 + full-mix audit suite** on top of B, reusing A's
  check-spec format.

User decisions recorded: expand the lab rather than shrink the audit; the
deliverable is a permanent regression suite, not a one-off report; coverage
is every control **plus the full synth2 mod matrix** (not a sampled subset).

## Goals

1. Every wire control of synth2, kick2, snare2, hat2, clap2 has at least one
   automated, tolerance-based check that fails if the control stops doing
   what it should.
2. The full synth2 mod matrix (7 real sources × 42 destinations = 294 cells)
   is exercised, each cell asserted via its destination family's template.
3. Each engine's default patch has a "fingerprint" check that catches
   unintended changes to the default sound.
4. The suite runs on demand (`npm run lab:audit`), separate from the normal
   test gate, and writes a human-readable audit report per run.
5. The lab gains the small analyzer/report extensions the suite needs
   (listed below) — all through the existing public API.
6. The first full run is executed and its findings triaged with the user
   (fix-now / backlog / known-issue), including an ear pass over each
   engine's default-patch WAV.

## Non-goals

- No sequencer, v1 engine, mixer, or full-project coverage (sub-projects
  B/C).
- No aesthetic pass/fail automation — "sounds good" is judged by the user's
  ear against attached WAVs; the suite checks mechanics only.
- No changes to any engine's DSP. The suite *measures*; fixes it motivates
  are separate branches. (Exception: none. Even trivial-looking DSP fixes
  found by the audit go through their own branch.)
- No bit-exact assertions ever — kernel PRNGs free-run by design.

## Architecture

New directory `packages/audio-lab/audit/`:

```
audit/
  types.ts            # CheckSpec + assertion type definitions
  executor.ts         # expand CheckSpecs -> render -> analyze -> assert
  metrics.ts          # derived metrics used only by assertions (thin, over public API)
  known-issues.ts     # expected-failure register (id -> reason)
  checks/
    synth2.checks.ts
    synth2-matrix.checks.ts   # generated cell list, family templates
    kick2.checks.ts
    snare2.checks.ts
    hat2.checks.ts
    clap2.checks.ts
  audit.test.ts       # the vitest entry: it.each over all checks
  report.ts           # audit-report.md + .json writer (vitest reporter hook or afterAll)
```

- Checks are **data**: plain TS objects. The executor is the only code that
  renders/asserts. Sub-project C reuses `types.ts` + `executor.ts` with a
  different render backend.
- Rendering and analysis run **in-process** via `@fiddle/audio-lab`'s public
  API (`renderEngine`, `analyzeEnvelope`, `analyzePitch`, `analyzeSpectrum`,
  `analyzeHealth`, `pitchSettleTime`) — no CLI shelling. The index.ts comment
  already names "future regression tests" as the intended consumer.
- Runner: a separate vitest config (`vitest.audit.config.ts`) so
  `npm test` / the merge gate never pay the audit's runtime.
  - `npm run lab:audit` — everything, including all 294 matrix cells.
  - `npm run lab:audit:fast` — matrix reduced to one cell per destination
    family per source archetype; everything else unchanged.
- On assertion failure the executor writes the offending render(s) as a
  normal run dir (WAV + spectrogram + report.json) under
  `.audio-lab/audit/<stamp>/failures/` and includes the path in the failure
  message, so every red check is immediately inspectable and hearable.

## CheckSpec format

```ts
interface CheckSpec {
  id: string;                 // 'synth2.filter.cutoff.directional'
  engine: EngineId;
  title: string;              // one line for the report
  baseline: EngineRenderSpec; // or a shared named baseline per engine
  assertion: Assertion;
}

type Assertion =
  | { kind: 'directional'; param: string; from: number; to: number;
      metric: MetricId; direction: 'up' | 'down'; minDelta: number }
  | { kind: 'absolute'; metric: MetricId; min?: number; max?: number }
  | { kind: 'enum'; param: string; perValue: Assertion[] | null;
      distinct?: { metric: MetricId; minSpread: number } }
  | { kind: 'matrix'; source: string; dest: string; amount: number;
      family: DestFamily }   // family supplies the metric template
  | { kind: 'health'; allowed: HealthFlag[] };  // implicit on every render too
```

- `MetricId` draws from the report summary plus the new metrics below:
  `peakDb`, `medianF0`, `f0Range`, `onsets`, `attackSeconds`,
  `decaySeconds`, `meanCentroidHz`, `pitchSettleTime`, `modDepth(metric)`,
  `bandEnergyRatio(lo|mid|hi)`.
- Every render implicitly asserts `NON_FINITE` never appears and that
  `healthFlags ⊆ allowed` for that check (percussion checks allow
  `MOSTLY_SILENT`; `CLIPPING` allowed only where declared).
- Tolerances follow the lab's documented rules: dB ±1, f0 ±1Hz for steady
  tones, times ±10ms; noise-heavy engines assert on RMS envelope and band
  energy with looser bounds, never on sample values.
- Standard synth2 baseline renders at osc levels 0.2 (default levels clip
  raw kernels — known Tier-1 truth, not a bug). The default-patch
  fingerprint check is the one place default levels are used, with
  `CLIPPING` in its allowed set.

## Coverage matrix

### synth2 (70 descriptor rows)

- **Continuous knobs** (osc octave/coarse/fine/level, FM amounts, noise
  level + color morph, filter cutoff/res/drive/keytrack/env amount, env
  A/D/S/R ×3, LFO rate/amount, glide time, velocity depth): one
  `directional` check each, metric chosen per param (pitch params ⇒ f0;
  cutoff/color/drive ⇒ centroid or band ratio; times ⇒ attack/decay;
  levels ⇒ peakDb/RMS).
- **Enums with live kernel slots** (filter.type ×3, filter.model ×2,
  lfo1/2.mode ×3): `enum` checks — every value healthy + audible, plus
  spectral distinctness where values must differ (e.g. lowpass vs highpass
  centroid ordering; S&H vs off).
- **Booleans** (osc sync, env loop): `directional`-style A/B with the
  appropriate metric (sync ⇒ spectral change at detuned osc2; loop ⇒
  repeated envelope peaks / modDepth > 0 after gate).
- **Tuning:** `absolute` medianF0 within ±1Hz at A2, A3, A4, plus one
  even-harmonic-heavy patch per octave to probe the pitch tracker's known
  octave-up risk (if the tracker itself misreads, that's a lab finding, and
  the check moves to spectral-peak assertion instead).
- **Glide:** `--mono` two-note renders; `pitchSettleTime` ≈ knob value at
  0.001 (instant), 0.1, 0.3s, tolerance = max(±10ms, ±2 pitch hops);
  poly render asserts NO glide.
- **Mono/poly:** chord render in poly ⇒ multiple concurrent f0s impossible
  to assert directly with a mono tracker — assert via spectral peaks
  containing both chord roots; mono render of overlapping notes ⇒ single
  voice (no chord peaks).
- **Matrix (synth2-matrix.checks.ts):** all 7 real sources × 42 dests.
  Destination families and their templates:
  - *pitch family* (fine/coarse dests): f0 movement / f0Range widens.
  - *filter family* (cutoff, res, morph): centroid movement (modDepth of
    centroid for periodic sources).
  - *level family* (osc/noise levels): RMS-envelope modDepth.
  - *time family* (env stage times, lfo rate, glide time): attack/decay or
    modulation-rate shift between amount 0 and amount ±.
  - Source archetypes shape the render + metric: **periodic** (lfo1/2 ⇒
    modDepth over time), **one-shot** (env1-3 ⇒ delta between early/late
    segments of a held note), **static** (velocity ⇒ two renders at
    velocity 0.3 vs 1.0, metric delta), **stochastic** (noise ⇒ modDepth
    with loose bounds).
  - A vitest exhaustiveness test asserts every MOD_DEST is assigned to
    exactly one family — appending a dest without classifying it fails the
    suite at compile/run time.
- **Fingerprint:** default patch (levels 0.2 variant) absolute windows on
  peakDb, meanCentroidHz, decaySeconds, healthFlags.

### kick2 / snare2 / hat2 / clap2 (8 / 7 / 6 / 7 knobs)

Per knob one `directional` check with the right metric (tune ⇒ dominant
spectral peak; decay knobs ⇒ decaySeconds; droop ⇒ pitch-trajectory range;
snappy/tone/noiseHp ⇒ centroid or bandEnergyRatio; level ⇒ peakDb; clap2
bursts/spread ⇒ onset/envelope structure via envelope peaks). Plus per-engine
default-patch fingerprints. Unpitched content never asserts f0 (tracker
returns null there by design).

### Declared blind spots (in the report, not silently absent)

| Surface | Why | Covered by |
|---|---|---|
| All `*.sync` / `*.div` controls (16 enum rows + sync bools) | Main-thread derived (`effectiveEnvTimes` / `effectiveLfoRate` / `effectiveGlideTime`); dead kernel slots in Tier 1 (renderer has no BPM) | shared unit tests today; sub-project C end-to-end |
| Sequencer timing, patternLength, step OCT/LEN/velocity semantics | No sequencer in Tier 1 | C |
| v1 engines (synth, kick, snare, hat, clap) | Main-thread Web Audio graphs; cannot run in Node | C |
| Mixer / gain staging | Kernels render raw | C |
| Poly voice-stealing details | Only basic mono/poly allocation renderable | C (+ existing client unit tests) |

## Lab extensions (part of A)

1. `pitchSettleTime` and per-frame `centroidHz` promoted into
   `report.json` (both flagged in the Phase-1 final review).
2. Envelope `as number` casts fixed (Phase-1 review: required "before
   regression-assertion reuse" — that's this project).
3. **modDepth metric**: oscillation amplitude of a per-frame series
   (centroidHz, f0, RMS) after detrending — the LFO-route assertion
   workhorse. Exported via public API, unit-tested on synthetic series.
4. **bandEnergyRatio**: energy in lo/mid/hi bands (edges 20–200Hz /
   200–2000Hz / 2000Hz–Nyquist; the plan may adjust after measuring real
   renders, the spec fixes these as defaults) over the STFT — for
   noise-character knobs where centroid is too blunt. Exported,
   unit-tested on synthetic spectra.

No other analyzer work. If executing the suite reveals another missing
metric, it's added by the same rules (public API + unit tests) and noted in
the audit report.

## Runner, reporting, first audit

- `npm run lab:audit` / `npm run lab:audit:fast` (root scripts delegating to
  the audio-lab workspace). Estimated full runtime: several hundred renders
  of 1–2.5s ⇒ minutes, not seconds; acceptable because it is not in the
  gate. If it exceeds ~10 min in practice, matrix renders shorten first.
- Each run writes `packages/audio-lab/.audio-lab/audit/<stamp>/`:
  `audit-report.md` (per-engine sections; per-check PASS / FAIL / KNOWN;
  metric values; failure run-dir links) + `audit-report.json` (machine
  form), + `failures/` run dirs.
- `known-issues.ts` maps check ids to reasons; matching failures report as
  KNOWN, and a KNOWN entry whose check *passes* is flagged for removal
  (stale-register guard).
- **First-audit deliverable:** run the full suite; write up findings; send
  the user each engine's default-patch `render.wav` (SendUserFile) with
  metric-informed observations for the ear pass (clap2's "not a convincing
  clap" is expected to be *mechanically* green and aesthetically open —
  it stays a backlog voicing item unless the user re-prioritizes); triage
  every FAIL with the user into fix-now / backlog / known-issue.

## Testing the suite itself

- New metrics (modDepth, bandEnergyRatio) unit-tested on synthetic inputs
  (known sinusoidal series / constructed spectra).
- Executor unit-tested with a stub render backend (no kernel): assertion
  pass/fail logic, failure-artifact writing, KNOWN classification,
  stale-KNOWN flagging.
- The check tables are themselves validated by meta-tests: every synth2
  descriptor key appears in exactly one check or in the declared blind-spot
  list (compile-time-ish completeness — a future descriptor append fails
  the suite until classified); MOD_DEST family exhaustiveness as above.
- Existing lab tests keep passing; report.json additions are append-only.

## Risks / notes

- **Nondeterminism:** free-running PRNGs mean every tolerance must survive
  seed variance. The plan phase sets minDelta / windows from actual
  render-pair measurements, not guesses; flaky checks are bugs in the
  check, not the DSP.
- **Pitch-tracker octave risk** (known residual from Phase 1) may surface
  as false FAILs on harmonic-rich patches; such cases switch to
  spectral-peak assertions and the tracker limitation gets logged as a lab
  finding.
- **Matrix cell semantics:** some source×dest cells are musically dubious
  but must still be *mechanically* sound (no NaN, amount 0 ⇒ no effect).
  Family templates assert response where the family defines one; for cells
  where the family metric is expected NOT to move (e.g. one-shot env on a
  dest already at rail), the cell asserts health-only — the plan enumerates
  these explicitly rather than letting cells silently degrade to
  health-only.
- **Completeness meta-test is the contract:** future engine/param work will
  be forced by the suite to either add a check or declare the blind spot —
  that is intended behavior, mirroring how the descriptor tables already
  force schema/accept-list coverage.
