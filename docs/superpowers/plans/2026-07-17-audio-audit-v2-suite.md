# Audio Audit v2 Kernel Regression Suite — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A permanent, committed audit suite (`npm run lab:audit`) that renders the five `*2` kernels through the audio lab and asserts every wire control does what it claims — including the full synth2 mod matrix — plus the four lab extensions the suite needs.

**Architecture:** Data-driven `CheckSpec` tables (one module per engine) executed by a single executor through `@fiddle/audio-lab`'s public in-process API; a heavy vitest entry (`audit.test.ts`) runs outside the normal gate under its own config and writes `audit-report.md`/`.json` per run. Spec: `docs/superpowers/specs/2026-07-17-audio-audit-v2-suite-design.md`.

**Tech Stack:** TypeScript, vitest, tsx, the existing `@fiddle/audio-lab` renderer/analyzers. No new dependencies.

## Global Constraints

- Branch: `feat/audio-lab-audit`. Never commit to main. Do not delete any branch.
- All audit code lives under `packages/audio-lab/src/audit/` (tsconfig only includes `src/**`; the spec's `audit/` sketch is realized inside `src/`).
- The normal gate (`npm test`, `vitest run` in the workspace) must NEVER run `src/audit/audit.test.ts`. Fast unit tests of audit infrastructure (executor, metrics) DO run in the gate.
- No DSP/engine changes anywhere in this plan. If a check fails against real kernels, record it (known-issues register or triage list) — do not "fix" the engine.
- Never assert exact sample values or bit-identical renders: kernel PRNGs free-run by design. Tolerances: dB ±1, f0 ±1Hz steady tones, times ±10ms unless a check states otherwise.
- `NON_FINITE` is never allowed in any render. Health flags are `CLIPPING`, `NON_FINITE`, `DC_OFFSET`, `MOSTLY_SILENT` (see `src/analyze/health.ts`).
- Standard synth2 audit patches set `osc1.level`/`osc2.level` ≤ 0.25 (default 0.8+0.8 clips raw kernels — known truth, not a bug). Only the default-patch fingerprint check uses default levels, with `CLIPPING` allowed.
- Public API rule: other packages import from `packages/audio-lab/src/index.ts` only; new analyzers get exported there.
- Every commit message ends with the standard Co-Authored-By + Claude-Session trailer used in this repo.
- **Calibration rule (used by Tasks 6–10):** after implementing a check table, run the audit filtered to that table TWICE; open the two `audit-report.json` files; for every directional/route check confirm (a) the measured |delta| ≥ 2 × `minDelta`, and (b) the run-to-run variance of each metric < `minDelta` / 2. If (a) fails, the knob's real effect is smaller than assumed — lower `minDelta` (floor: 2 × observed variance) or change the metric; if (b) fails, raise `minDelta` or lengthen the render. Record every adjusted constant in the commit message body.

## File Structure

```
packages/audio-lab/
  vitest.config.ts                # MODIFY: exclude src/audit/audit.test.ts
  vitest.audit.config.ts          # NEW: runs ONLY src/audit/audit.test.ts
  package.json                    # MODIFY: audit / audit:fast scripts
  src/
    index.ts                      # MODIFY: export new analyzers + report types
    report/report.ts              # MODIFY: null-typed envelope, centroid series, pitchSettle
    report/report.test.ts         # MODIFY: cover the above
    cli.ts                        # MODIFY: pass noteTargets to writeRunDir
    analyze/moddepth.ts(.test.ts) # NEW: modDepth metric
    analyze/bands.ts(.test.ts)    # NEW: bandEnergyRatio metric
    audit/
      types.ts                    # NEW: CheckSpec/Assertion/CheckResult
      metrics.ts                  # NEW: analyzeForAudit -> MetricId record
      executor.ts                 # NEW: runCheck
      executor.test.ts            # NEW: stub-backend unit tests (in gate)
      known-issues.ts             # NEW: expected-failure register
      report.ts                   # NEW: audit-report.md/json writer
      report.test.ts              # NEW: writer unit test (in gate)
      audit.test.ts               # NEW: the heavy suite entry (audit config only)
      checks/
        baselines.ts              # NEW: shared per-engine baseline specs
        kick2.checks.ts           # NEW  \
        snare2.checks.ts          # NEW   \ data tables
        hat2.checks.ts            # NEW   /
        clap2.checks.ts           # NEW  /
        synth2.checks.ts          # NEW: knobs/enums/bools
        synth2-perf.checks.ts     # NEW: tuning/glide/mono-poly/fingerprint
        synth2-matrix.ts          # NEW: families + generator + EXPECTED_INERT
        completeness.test.ts      # NEW: descriptor-coverage meta-tests (in gate)
root package.json                 # MODIFY: lab:audit / lab:audit:fast
```

Root `.gitignore` already ignores `.audio-lab/` (run dirs + audit reports land there).

---

### Task 1: Report hygiene — null-typed envelope, per-frame centroid, pitchSettle

The Phase-1 review flagged `report.ts`'s `as number` casts (lines 61–66) as unsafe for regression reuse, and per-frame centroid + `pitchSettleTime` as missing from `report.json`. Fix all three. The analyzers themselves don't change.

**Files:**
- Modify: `packages/audio-lab/src/report/report.ts`
- Modify: `packages/audio-lab/src/cli.ts` (render-engine branch, ~line 134)
- Modify: `packages/audio-lab/src/index.ts`
- Test: `packages/audio-lab/src/report/report.test.ts`

**Interfaces:**
- Consumes: existing `analyzeEnvelope`, `analyzePitch` (+ `pitchSettleTime`), `analyzeSpectrum` (`SpectrumAnalysis.hopSeconds` and `.centroidHz` already exist), `noteToFreq`.
- Produces: `ReportEnvelope`, `ReportEnvelopePoint`, `PitchSettleEntry` types; `RunSummary.pitchSettle: PitchSettleEntry[] | null`; `RunReport.envelope: ReportEnvelope`; `RunReport.spectrum` gains `hopSeconds: number` and `centroidHz: (number | null)[]`; `buildReport(clip, opts?)` and `writeRunDir({ …, noteTargets? })`.

- [ ] **Step 1: Write the failing tests** — append to `report.test.ts`:

```ts
import { pitchSettleTime } from '../analyze/pitch';

function sineClip(freq: number, seconds: number, sampleRate = 44100) {
  const n = Math.round(seconds * sampleRate);
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return { samples, sampleRate };
}

describe('report null-safety + new fields', () => {
  it('silent clip serializes envelope dB as null, not -Infinity', () => {
    const clip = { samples: new Float32Array(44100), sampleRate: 44100 };
    const r = buildReport(clip);
    expect(r.envelope.peakDb).toBeNull();
    expect(r.envelope.rmsDb).toBeNull();
    expect(r.envelope.points.every((p) => p.rmsDb === null && p.peakDb === null)).toBe(true);
    // must survive JSON round-trip without "null"-as-string or Infinity
    const round = JSON.parse(JSON.stringify(r));
    expect(round.envelope.peakDb).toBeNull();
  });

  it('spectrum block carries the per-frame centroid series and its hop', () => {
    const r = buildReport(sineClip(440, 1));
    expect(r.spectrum.hopSeconds).toBeGreaterThan(0);
    expect(r.spectrum.centroidHz.length).toBeGreaterThan(10);
    const mid = r.spectrum.centroidHz[Math.floor(r.spectrum.centroidHz.length / 2)];
    expect(mid).not.toBeNull();
  });

  it('summary.pitchSettle appears when noteTargets are given', () => {
    const clip = sineClip(220, 1);
    const r = buildReport(clip, { noteTargets: [{ time: 0, freq: 220 }] });
    expect(r.summary.pitchSettle).not.toBeNull();
    expect(r.summary.pitchSettle![0].targetHz).toBe(220);
    expect(r.summary.pitchSettle![0].settleSeconds).not.toBeNull();
    // and absent (null) when not given
    expect(buildReport(clip).summary.pitchSettle).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w @fiddle/audio-lab -- report.test`
Expected: FAIL — `pitchSettle` / `centroidHz` / `hopSeconds` missing; envelope typing test fails on `-Infinity`.

- [ ] **Step 3: Implement in `report.ts`**

Replace the envelope handling and extend the interfaces (delete the old `safeEnvelope` cast block entirely):

```ts
export interface ReportEnvelopePoint { time: number; rmsDb: number | null; peakDb: number | null }
export interface ReportEnvelope {
  hopSeconds: number;
  points: ReportEnvelopePoint[];
  peakDb: number | null;
  rmsDb: number | null;
  onsets: number[];
  attackSeconds: number | null;
  decaySeconds: number | null;
}
export interface PitchSettleEntry { time: number; targetHz: number; settleSeconds: number | null }
```

`RunSummary` gains `pitchSettle: PitchSettleEntry[] | null;`. `RunReport.envelope` becomes `ReportEnvelope`; `RunReport.spectrum` gains `hopSeconds: number;` and `centroidHz: (number | null)[];`.

```ts
export interface BuildReportOpts { noteTargets?: Array<{ time: number; freq: number }> }

export function buildReport(clip: AudioClip, opts: BuildReportOpts = {}): RunReport {
  const envelope = analyzeEnvelope(clip);
  const pitch = analyzePitch(clip);
  const spectrum = analyzeSpectrum(clip);
  const health = analyzeHealth(clip);

  const safeEnvelope: ReportEnvelope = {
    hopSeconds: envelope.hopSeconds,
    onsets: envelope.onsets,
    attackSeconds: envelope.attackSeconds,
    decaySeconds: envelope.decaySeconds,
    peakDb: finite(envelope.peakDb),
    rmsDb: finite(envelope.rmsDb),
    points: envelope.points.map((p) => ({ time: p.time, rmsDb: finite(p.rmsDb), peakDb: finite(p.peakDb) })),
  };

  const pitchSettle = opts.noteTargets
    ? opts.noteTargets.map((t) => ({
        time: t.time,
        targetHz: t.freq,
        settleSeconds: pitchSettleTime(pitch.frames, t.time, t.freq),
      }))
    : null;
  // … summary as before, plus pitchSettle; spectrum block spreads in
  // hopSeconds: spectrum.hopSeconds, centroidHz: spectrum.centroidHz.
}
```

Import `pitchSettleTime` from `../analyze/pitch`. Keep every existing summary field byte-compatible. Thread `noteTargets` through `writeRunDir`: add `noteTargets?: BuildReportOpts['noteTargets']` to its options object and pass to `buildReport`.

- [ ] **Step 4: CLI passes note targets** — in `cli.ts`'s render-engine branch (~line 134):

```ts
const noteTargets = cmd.spec.notes.map((n) => ({
  time: n.time,
  freq: n.freq ?? noteToFreq(n.note!),
}));
const report = await writeRunDir({ dir, spec: cmd.spec, clip, noteTargets });
```

(`noteToFreq` is already exported from `./render/engine`; import it in cli.ts if not present.)

- [ ] **Step 5: Export the new types** from `src/index.ts`: `ReportEnvelope`, `ReportEnvelopePoint`, `PitchSettleEntry`, `BuildReportOpts` (type-only).

- [ ] **Step 6: Run the full workspace tests + typecheck**

Run: `npm test -w @fiddle/audio-lab && npm run typecheck -w @fiddle/audio-lab`
Expected: PASS. If existing report tests asserted `envelope.peakDb` as a number on non-silent clips they still pass (finite values stay numbers). Fix any test that asserted the old `-Infinity`-cast behavior — the new null contract is the correct one.

- [ ] **Step 7: Smoke the CLI once** (proves the plumbing, not committed):

Run: `npm run lab -- render-engine kick2 --notes "C3:0:0.4" --seconds 1 --label t1-smoke`
Expected: run dir printed; its `report.json` `summary.pitchSettle` is an array with one entry (settleSeconds may be null for a kick — fine), `spectrum.centroidHz` present.

- [ ] **Step 8: Commit**

```bash
git add packages/audio-lab/src
git commit -m "fix(audio-lab): null-typed report envelope; centroid series + pitchSettle in report.json"
```

---

### Task 2: modDepth analyzer

Oscillation depth + rate of a per-frame series (RMS dB, centroid Hz, f0 Hz) after linear detrend — the workhorse metric for LFO-route and env-loop assertions.

**Files:**
- Create: `packages/audio-lab/src/analyze/moddepth.ts`
- Test: `packages/audio-lab/src/analyze/moddepth.test.ts`
- Modify: `packages/audio-lab/src/index.ts`

**Interfaces:**
- Produces: `modDepth(series: ReadonlyArray<number | null>, stepSeconds: number): ModDepthResult` where `ModDepthResult = { depth: number | null; rateHz: number | null }`. `depth` is in the series' own unit (dB/Hz); `rateHz` null when < 2 zero crossings. Task 4's metrics module consumes exactly this signature.

- [ ] **Step 1: Write the failing tests** — `moddepth.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { modDepth } from './moddepth';

const sine = (n: number, stepS: number, freq: number, amp: number, offset = 0, slope = 0) =>
  Array.from({ length: n }, (_, i) => offset + slope * i + amp * Math.sin(2 * Math.PI * freq * i * stepS));

describe('modDepth', () => {
  it('recovers amplitude and rate of a clean sine series', () => {
    const r = modDepth(sine(400, 0.005, 5, 3, 100), 0.005); // 2s of 5Hz, amp 3
    expect(r.depth).toBeGreaterThan(2.4);
    expect(r.depth).toBeLessThan(3.3);
    expect(r.rateHz).toBeGreaterThan(4.5);
    expect(r.rateHz).toBeLessThan(5.5);
  });
  it('detrends: a pure ramp has ~zero depth', () => {
    const r = modDepth(sine(400, 0.005, 0, 0, 10, 0.05), 0.005);
    expect(r.depth).not.toBeNull();
    expect(r.depth!).toBeLessThan(0.02);
  });
  it('tolerates interspersed nulls', () => {
    const s = sine(400, 0.005, 5, 3, 100).map((v, i) => (i % 7 === 0 ? null : v));
    const r = modDepth(s, 0.005);
    expect(r.depth).toBeGreaterThan(2.2);
  });
  it('returns nulls for fewer than 8 valid points', () => {
    expect(modDepth([1, 2, null, 3], 0.01)).toEqual({ depth: null, rateHz: null });
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npm test -w @fiddle/audio-lab -- moddepth` → FAIL (module not found).

- [ ] **Step 3: Implement `moddepth.ts`**

```ts
// Oscillation depth of a per-frame metric series (RMS dB, centroid Hz, f0 Hz)
// after removing a linear trend: depth = (p95 - p5)/2 of the residual, rate
// from residual zero crossings. Nulls (unvoiced/silent frames) are skipped.
export interface ModDepthResult { depth: number | null; rateHz: number | null }

export function modDepth(series: ReadonlyArray<number | null>, stepSeconds: number): ModDepthResult {
  const idx: number[] = [];
  const val: number[] = [];
  series.forEach((v, i) => {
    if (v != null && Number.isFinite(v)) { idx.push(i); val.push(v); }
  });
  const n = val.length;
  if (n < 8) return { depth: null, rateHz: null };

  const mx = idx.reduce((a, b) => a + b, 0) / n;
  const my = val.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sxx += (idx[i] - mx) ** 2; sxy += (idx[i] - mx) * (val[i] - my); }
  const slope = sxx > 0 ? sxy / sxx : 0;
  const resid = val.map((v, i) => v - (my + slope * (idx[i] - mx)));

  const sorted = [...resid].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))))];
  const depth = (q(0.95) - q(0.05)) / 2;

  let crossings = 0;
  for (let i = 1; i < n; i++) {
    if ((resid[i - 1] < 0 && resid[i] >= 0) || (resid[i - 1] >= 0 && resid[i] < 0)) crossings++;
  }
  const duration = (idx[n - 1] - idx[0]) * stepSeconds;
  const rateHz = crossings >= 2 && duration > 0 ? crossings / 2 / duration : null;
  return { depth, rateHz };
}
```

- [ ] **Step 4: Run tests** — `npm test -w @fiddle/audio-lab -- moddepth` → PASS.

- [ ] **Step 5: Export** `modDepth` + `ModDepthResult` from `src/index.ts`, run `npm run typecheck -w @fiddle/audio-lab` → PASS.

- [ ] **Step 6: Commit** — `git add packages/audio-lab/src && git commit -m "feat(audio-lab): modDepth analyzer (oscillation depth + rate of metric series)"`

---

### Task 3: bandEnergyRatio analyzer

Lo/mid/hi energy split of the averaged spectrum — for noise-character knobs (hat/snare/clap tone, noiseHp, kick click) where centroid alone is too blunt. Spec fixes the edges: 20–200 / 200–2000 / 2000–Nyquist.

**Files:**
- Create: `packages/audio-lab/src/analyze/bands.ts`
- Test: `packages/audio-lab/src/analyze/bands.test.ts`
- Modify: `packages/audio-lab/src/index.ts`

**Interfaces:**
- Produces: `bandEnergyRatio(averageMagnitudeDb: ReadonlyArray<number>, binHz: number): BandRatios` with `BandRatios = { lo: number; mid: number; hi: number }` (linear-power fractions summing to 1, or all 0 for silence). Consumed by Task 4's metrics module with `SpectrumAnalysis.averageMagnitudeDb` + `.binHz`.

- [ ] **Step 1: Write the failing tests** — `bands.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { bandEnergyRatio } from './bands';

// 1024 bins at ~21.5Hz/bin ≈ a 44.1kHz / 2048-point analysis.
const FLOOR = -100;
const spectrumWithPeak = (hz: number, binHz = 21.533): number[] => {
  const bins = new Array(1024).fill(FLOOR);
  bins[Math.round(hz / binHz)] = 0; // 0dB single-bin peak
  return bins;
};

describe('bandEnergyRatio', () => {
  it('a 100Hz peak lands in lo', () => {
    expect(bandEnergyRatio(spectrumWithPeak(100), 21.533).lo).toBeGreaterThan(0.9);
  });
  it('a 1kHz peak lands in mid', () => {
    expect(bandEnergyRatio(spectrumWithPeak(1000), 21.533).mid).toBeGreaterThan(0.9);
  });
  it('a 5kHz peak lands in hi', () => {
    expect(bandEnergyRatio(spectrumWithPeak(5000), 21.533).hi).toBeGreaterThan(0.9);
  });
  it('ratios sum to ~1 for any non-silent spectrum', () => {
    const r = bandEnergyRatio(spectrumWithPeak(1000), 21.533);
    expect(r.lo + r.mid + r.hi).toBeCloseTo(1, 6);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npm test -w @fiddle/audio-lab -- bands` → FAIL.

- [ ] **Step 3: Implement `bands.ts`**

```ts
// Linear-power split of the averaged magnitude spectrum into three bands.
// Edges per the audit spec: 20-200Hz (lo), 200-2000Hz (mid), 2000Hz-Nyquist (hi).
// Bins below 20Hz are excluded (DC / sub-audio garbage would swamp `lo`).
export interface BandRatios { lo: number; mid: number; hi: number }

export function bandEnergyRatio(averageMagnitudeDb: ReadonlyArray<number>, binHz: number): BandRatios {
  let lo = 0, mid = 0, hi = 0;
  for (let b = 0; b < averageMagnitudeDb.length; b++) {
    const hz = b * binHz;
    if (hz < 20) continue;
    const p = Math.pow(10, averageMagnitudeDb[b] / 10);
    if (hz < 200) lo += p;
    else if (hz < 2000) mid += p;
    else hi += p;
  }
  const total = lo + mid + hi;
  if (total <= 0) return { lo: 0, mid: 0, hi: 0 };
  return { lo: lo / total, mid: mid / total, hi: hi / total };
}
```

- [ ] **Step 4: Run tests** — PASS. Note the -100dB floor bins contribute tiny but nonzero power; the >0.9 assertions absorb that.

- [ ] **Step 5: Export** `bandEnergyRatio` + `BandRatios` from `src/index.ts`; `npm run typecheck -w @fiddle/audio-lab` → PASS.

- [ ] **Step 6: Commit** — `git add packages/audio-lab/src && git commit -m "feat(audio-lab): bandEnergyRatio analyzer (lo/mid/hi spectrum split)"`

---

### Task 4: Audit core — types, metrics bag, executor (with stub-backend tests)

The executor is the ONLY code that renders and asserts; check tables are pure data. Its unit tests use a stub render function (synthetic clips, no kernels) and run in the normal gate.

**Files:**
- Create: `packages/audio-lab/src/audit/types.ts`
- Create: `packages/audio-lab/src/audit/metrics.ts`
- Create: `packages/audio-lab/src/audit/executor.ts`
- Test: `packages/audio-lab/src/audit/executor.test.ts`

**Interfaces:**
- Consumes: `EngineRenderSpec`, `EngineId`, `MatrixRoute`, `AudioClip` from the lab's existing modules; `modDepth` (Task 2), `bandEnergyRatio` (Task 3), `pitchSettleTime`.
- Produces (used verbatim by Tasks 5–11): everything in `types.ts` below, `analyzeForAudit(clip): AnalysisBundle`, and `runCheck(check, opts): Promise<CheckResult>`.

- [ ] **Step 1: Write `types.ts`** (data first — the tests need the types):

```ts
// Audit check definitions. Checks are DATA; src/audit/executor.ts is the only
// code that renders and asserts. Sub-project C (Tier 2) reuses these types
// with a different render backend.
import type { EngineId, EngineRenderSpec } from '../render/engine';

export type MetricId =
  | 'peakDb' | 'rmsDb' | 'attackSeconds' | 'decaySeconds' | 'onsetCount'
  | 'medianF0' | 'f0WidthHz' | 'meanCentroidHz' | 'domPeakHz'
  | 'bandLo' | 'bandMid' | 'bandHi'
  | 'modDepthRms' | 'modDepthCentroid' | 'modDepthF0' | 'modRateCentroidHz';

export type Direction = 'up' | 'down' | 'change';

export type Assertion =
  // Render baseline with {param: from}, then {param: to}; metric must move.
  | { kind: 'directional'; param: string; from: number; to: number;
      metric: MetricId; direction: Direction; minDelta: number }
  // Single render of the baseline; metric inside [min, max].
  | { kind: 'absolute'; metric: MetricId; min?: number; max?: number }
  // One render per value; each must be healthy and audible; optionally the
  // metric must spread across values by at least minSpread.
  | { kind: 'enum'; param: string; values: number[]; minPeakDb: number;
      distinct?: { metric: MetricId; minSpread: number } }
  // Baseline must contain exactly two overlapping/adjacent mono notes;
  // pitchSettleTime from note 2 onset to note 2 freq ~ knobSeconds.
  | { kind: 'pitchSettle'; knobSeconds: number; toleranceSeconds: number }
  // Render baseline WITHOUT the route, then WITH it; metric must move.
  // 'velocity-pair' instead renders WITH the route at velocity 0.3 vs 1.0.
  | { kind: 'route'; source: string; dest: string; amount: number;
      compare: 'off-vs-on' | 'velocity-pair';
      metric: MetricId; direction: Direction; minDelta: number }
  // Health-only: render must obey the health policy, nothing else asserted.
  | { kind: 'health' };

export interface CheckSpec {
  id: string;                      // 'synth2.filter.cutoff.dir'
  engine: EngineId;
  title: string;                   // one line for the report
  baseline: EngineRenderSpec;
  assertion: Assertion;
  allowedHealth?: string[];        // default []; NON_FINITE never allowed
}

export type CheckStatus = 'PASS' | 'FAIL' | 'KNOWN' | 'STALE_KNOWN';

export interface CheckResult {
  id: string;
  engine: EngineId;
  title: string;
  status: CheckStatus;
  detail: string;                          // human-readable outcome
  values: Record<string, number | null>;   // every measured metric, both legs
  failureDirs: string[];                   // run dirs written for FAILs
}
```

- [ ] **Step 2: Write `metrics.ts`**:

```ts
// One analysis pass -> every MetricId. Computed eagerly; renders dominate
// the cost anyway and eager keeps the executor branch-free.
import type { AudioClip } from '../types';
import { analyzeEnvelope } from '../analyze/envelope';
import { analyzePitch, type PitchAnalysis } from '../analyze/pitch';
import { analyzeSpectrum } from '../analyze/spectrum';
import { analyzeHealth } from '../analyze/health';
import { modDepth } from '../analyze/moddepth';
import { bandEnergyRatio } from '../analyze/bands';
import type { MetricId } from './types';

export interface AnalysisBundle {
  metrics: Record<MetricId, number | null>;
  healthFlags: string[];
  pitch: PitchAnalysis;     // for pitchSettle assertions
}

const finite = (x: number | null | undefined): number | null =>
  x != null && Number.isFinite(x) ? x : null;

export function analyzeForAudit(clip: AudioClip): AnalysisBundle {
  const env = analyzeEnvelope(clip);
  const pitch = analyzePitch(clip);
  const spec = analyzeSpectrum(clip);
  const health = analyzeHealth(clip);
  const bands = bandEnergyRatio(spec.averageMagnitudeDb, spec.binHz);

  const rmsSeries = env.points.map((p) => (Number.isFinite(p.rmsDb) ? p.rmsDb : null));
  const f0Series = pitch.frames.map((f) => f.f0);
  const pitchHop = pitch.frames.length >= 2 ? pitch.frames[1].time - pitch.frames[0].time : 0.01;
  const mdRms = modDepth(rmsSeries, env.hopSeconds);
  const mdCent = modDepth(spec.centroidHz, spec.hopSeconds);
  const mdF0 = modDepth(f0Series, pitchHop);

  const f0WidthHz =
    pitch.minF0 != null && pitch.maxF0 != null ? pitch.maxF0 - pitch.minF0 : null;

  return {
    healthFlags: health.flags,
    pitch,
    metrics: {
      peakDb: finite(env.peakDb),
      rmsDb: finite(env.rmsDb),
      attackSeconds: env.attackSeconds,
      decaySeconds: env.decaySeconds,
      onsetCount: env.onsets.length,
      medianF0: pitch.medianF0,
      f0WidthHz,
      meanCentroidHz: spec.meanCentroidHz,
      domPeakHz: spec.peaks[0]?.hz ?? null,
      bandLo: bands.lo,
      bandMid: bands.mid,
      bandHi: bands.hi,
      modDepthRms: mdRms.depth,
      modDepthCentroid: mdCent.depth,
      modDepthF0: mdF0.depth,
      modRateCentroidHz: mdCent.rateHz,
    },
  };
}
```

- [ ] **Step 3: Write the failing executor tests** — `executor.test.ts`. The stub backend fabricates clips whose properties depend on the render spec, so every assertion kind and status path is exercised without kernels:

```ts
import { describe, expect, it } from 'vitest';
import type { EngineRenderSpec } from '../render/engine';
import { runCheck } from './executor';
import type { CheckSpec } from './types';

const SR = 44100;
// Louder when params.gain is higher; brighter (higher freq) when params.bright is higher.
function stubRender(spec: EngineRenderSpec) {
  const gain = spec.params?.gain ?? 0.3;
  const freq = 200 + 2000 * (spec.params?.bright ?? 0.2) + 500 * (spec.matrix?.length ?? 0);
  const vel = spec.notes[0]?.velocity ?? 1;
  const n = Math.round(spec.seconds * SR);
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = gain * vel * Math.sin((2 * Math.PI * freq * i) / SR);
  return { samples, sampleRate: SR };
}
const brokenRender = (spec: EngineRenderSpec) => {
  const c = stubRender(spec);
  c.samples[100] = Number.NaN;
  return c;
};

const base = (params: Record<string, number> = {}): EngineRenderSpec => ({
  engine: 'synth2', params, notes: [{ time: 0, note: 'A3', duration: 0.5 }], seconds: 1,
});
const check = (over: Partial<CheckSpec>): CheckSpec => ({
  id: 't.check', engine: 'synth2', title: 't', baseline: base(), assertion: { kind: 'health' }, ...over,
});
const opts = { render: stubRender, knownIssues: {} as Record<string, string> };

describe('runCheck', () => {
  it('directional up PASSes when the metric rises', async () => {
    const r = await runCheck(check({ assertion: { kind: 'directional', param: 'bright', from: 0.1, to: 0.9, metric: 'meanCentroidHz', direction: 'up', minDelta: 200 } }), opts);
    expect(r.status).toBe('PASS');
    expect(r.values['meanCentroidHz.from']).not.toBeNull();
    expect(r.values['meanCentroidHz.to']).not.toBeNull();
  });
  it('directional FAILs when the metric does not move enough', async () => {
    const r = await runCheck(check({ assertion: { kind: 'directional', param: 'unused', from: 0, to: 1, metric: 'meanCentroidHz', direction: 'up', minDelta: 200 } }), opts);
    expect(r.status).toBe('FAIL');
    expect(r.detail).toContain('meanCentroidHz');
  });
  it("direction 'change' accepts movement either way", async () => {
    const r = await runCheck(check({ assertion: { kind: 'directional', param: 'bright', from: 0.9, to: 0.1, metric: 'meanCentroidHz', direction: 'change', minDelta: 200 } }), opts);
    expect(r.status).toBe('PASS');
  });
  it('absolute enforces min/max', async () => {
    const ok = await runCheck(check({ assertion: { kind: 'absolute', metric: 'peakDb', min: -20, max: 0 } }), opts);
    expect(ok.status).toBe('PASS');
    const bad = await runCheck(check({ assertion: { kind: 'absolute', metric: 'peakDb', min: -1 } }), opts);
    expect(bad.status).toBe('FAIL');
  });
  it('enum renders every value and enforces audibility + distinctness', async () => {
    const r = await runCheck(check({ assertion: { kind: 'enum', param: 'bright', values: [0, 0.5, 1], minPeakDb: -30, distinct: { metric: 'meanCentroidHz', minSpread: 500 } } }), opts);
    expect(r.status).toBe('PASS');
    const dull = await runCheck(check({ assertion: { kind: 'enum', param: 'unused', values: [0, 1], minPeakDb: -30, distinct: { metric: 'meanCentroidHz', minSpread: 500 } } }), opts);
    expect(dull.status).toBe('FAIL');
  });
  it('route off-vs-on sees the matrix-driven change', async () => {
    const r = await runCheck(check({ assertion: { kind: 'route', source: 'lfo1', dest: 'filter.cutoff', amount: 0.8, compare: 'off-vs-on', metric: 'meanCentroidHz', direction: 'change', minDelta: 200 } }), opts);
    expect(r.status).toBe('PASS');
  });
  it('route velocity-pair compares velocity 0.3 vs 1.0 (both routed)', async () => {
    const r = await runCheck(check({ assertion: { kind: 'route', source: 'velocity', dest: 'osc1.level', amount: 1, compare: 'velocity-pair', metric: 'peakDb', direction: 'up', minDelta: 3 } }), opts);
    expect(r.status).toBe('PASS');
  });
  it('NON_FINITE always FAILs regardless of assertion or allowedHealth', async () => {
    const r = await runCheck(check({ allowedHealth: ['NON_FINITE'] }), { ...opts, render: brokenRender });
    expect(r.status).toBe('FAIL');
    expect(r.detail).toContain('NON_FINITE');
  });
  it('disallowed health flag FAILs; allowed one PASSes', async () => {
    const loud = check({ baseline: base({ gain: 1.4 }) }); // clips the stub sine
    const fail = await runCheck(loud, opts);
    expect(fail.status).toBe('FAIL');
    const ok = await runCheck({ ...loud, allowedHealth: ['CLIPPING'] }, opts);
    expect(ok.status).toBe('PASS');
  });
  it('a failing check in knownIssues reports KNOWN; a passing one reports STALE_KNOWN', async () => {
    const failing = check({ id: 'k1', assertion: { kind: 'absolute', metric: 'peakDb', min: 100 } });
    const known = { k1: 'expected', k2: 'stale' };
    expect((await runCheck(failing, { ...opts, knownIssues: known })).status).toBe('KNOWN');
    const passing = check({ id: 'k2' });
    expect((await runCheck(passing, { ...opts, knownIssues: known })).status).toBe('STALE_KNOWN');
  });
  it('writes a failure dir when saveFailure is provided and the check FAILs', async () => {
    const saved: string[] = [];
    const r = await runCheck(check({ assertion: { kind: 'absolute', metric: 'peakDb', min: 100 } }), {
      ...opts,
      saveFailure: async (id) => { saved.push(id); return `/fake/${id}`; },
    });
    expect(r.status).toBe('FAIL');
    expect(saved).toEqual(['t.check']);
    expect(r.failureDirs).toEqual(['/fake/t.check']);
  });
});
```

- [ ] **Step 4: Run to verify failure** — `npm test -w @fiddle/audio-lab -- audit/executor` → FAIL (executor missing).

- [ ] **Step 5: Implement `executor.ts`**:

```ts
// Renders a CheckSpec's legs, analyzes them, and produces a CheckResult.
// KNOWN/STALE_KNOWN classification against the known-issues register happens
// here so the vitest entry and the report writer both see final statuses.
import type { AudioClip } from '../types';
import type { EngineRenderSpec } from '../render/engine';
import { analyzeForAudit, type AnalysisBundle } from './metrics';
import { pitchSettleTime } from '../analyze/pitch';
import type { CheckResult, CheckSpec, CheckStatus } from './types';

export type RenderFn = (spec: EngineRenderSpec) => AudioClip;

export interface RunCheckOpts {
  render: RenderFn;
  knownIssues: Record<string, string>;
  // Persist a failing render for inspection; returns the run-dir path.
  saveFailure?: (id: string, spec: EngineRenderSpec, clip: AudioClip) => Promise<string>;
}

interface Leg { label: string; spec: EngineRenderSpec; clip: AudioClip; bundle: AnalysisBundle }

const withParam = (spec: EngineRenderSpec, param: string, value: number): EngineRenderSpec =>
  ({ ...spec, params: { ...spec.params, [param]: value } });

export async function runCheck(check: CheckSpec, opts: RunCheckOpts): Promise<CheckResult> {
  const failures: string[] = [];
  const values: Record<string, number | null> = {};
  const problems: string[] = [];
  const legs: Leg[] = [];

  const renderLeg = (label: string, spec: EngineRenderSpec): Leg => {
    const clip = opts.render(spec);
    const bundle = analyzeForAudit(clip);
    const leg = { label, spec, clip, bundle };
    legs.push(leg);
    return leg;
  };

  const a = check.assertion;
  try {
    // --- render legs + evaluate the assertion ---
    if (a.kind === 'directional') {
      const from = renderLeg('from', withParam(check.baseline, a.param, a.from));
      const to = renderLeg('to', withParam(check.baseline, a.param, a.to));
      const mFrom = from.bundle.metrics[a.metric];
      const mTo = to.bundle.metrics[a.metric];
      values[`${a.metric}.from`] = mFrom;
      values[`${a.metric}.to`] = mTo;
      evalDelta(problems, a.metric, mFrom, mTo, a.direction, a.minDelta);
    } else if (a.kind === 'absolute') {
      const leg = renderLeg('render', check.baseline);
      const m = leg.bundle.metrics[a.metric];
      values[a.metric] = m;
      if (m == null) problems.push(`${a.metric} is null`);
      else {
        if (a.min !== undefined && m < a.min) problems.push(`${a.metric}=${fmt(m)} < min ${a.min}`);
        if (a.max !== undefined && m > a.max) problems.push(`${a.metric}=${fmt(m)} > max ${a.max}`);
      }
    } else if (a.kind === 'enum') {
      const seen: (number | null)[] = [];
      for (const v of a.values) {
        const leg = renderLeg(`v${v}`, withParam(check.baseline, a.param, v));
        const peak = leg.bundle.metrics.peakDb;
        values[`peakDb.v${v}`] = peak;
        if (peak == null || peak < a.minPeakDb) problems.push(`value ${v}: peakDb=${fmt(peak)} < ${a.minPeakDb}`);
        if (a.distinct) {
          const m = leg.bundle.metrics[a.distinct.metric];
          values[`${a.distinct.metric}.v${v}`] = m;
          seen.push(m);
        }
      }
      if (a.distinct) {
        const nums = seen.filter((x): x is number => x != null);
        const spread = nums.length ? Math.max(...nums) - Math.min(...nums) : 0;
        values[`${a.distinct.metric}.spread`] = spread;
        if (nums.length < seen.length) problems.push(`${a.distinct.metric} null for some values`);
        else if (spread < a.distinct.minSpread) problems.push(`${a.distinct.metric} spread ${fmt(spread)} < ${a.distinct.minSpread}`);
      }
    } else if (a.kind === 'route') {
      const route = { source: a.source, dest: a.dest, amount: a.amount };
      if (a.compare === 'off-vs-on') {
        const off = renderLeg('off', { ...check.baseline, matrix: check.baseline.matrix ?? [] });
        const on = renderLeg('on', { ...check.baseline, matrix: [...(check.baseline.matrix ?? []), route] });
        const mOff = off.bundle.metrics[a.metric];
        const mOn = on.bundle.metrics[a.metric];
        values[`${a.metric}.off`] = mOff;
        values[`${a.metric}.on`] = mOn;
        evalDelta(problems, a.metric, mOff, mOn, a.direction, a.minDelta);
      } else {
        const routed = { ...check.baseline, matrix: [...(check.baseline.matrix ?? []), route] };
        const soft = renderLeg('v0.3', { ...routed, notes: routed.notes.map((n) => ({ ...n, velocity: 0.3 })) });
        const hard = renderLeg('v1.0', { ...routed, notes: routed.notes.map((n) => ({ ...n, velocity: 1 })) });
        const mSoft = soft.bundle.metrics[a.metric];
        const mHard = hard.bundle.metrics[a.metric];
        values[`${a.metric}.v0.3`] = mSoft;
        values[`${a.metric}.v1.0`] = mHard;
        evalDelta(problems, a.metric, mSoft, mHard, a.direction, a.minDelta);
      }
    } else if (a.kind === 'pitchSettle') {
      const leg = renderLeg('render', check.baseline);
      const notes = check.baseline.notes;
      if (notes.length !== 2) throw new Error(`pitchSettle needs exactly 2 notes, got ${notes.length}`);
      const target = noteFreq(notes[1]);
      const settle = pitchSettleTime(leg.bundle.pitch.frames, notes[1].time, target);
      values['pitchSettleSeconds'] = settle;
      if (settle == null) problems.push('pitch never settled on note 2');
      else if (Math.abs(settle - a.knobSeconds) > a.toleranceSeconds) {
        problems.push(`settle ${fmt(settle)}s vs knob ${a.knobSeconds}s (tol ${a.toleranceSeconds}s)`);
      }
    } else {
      renderLeg('render', check.baseline); // health-only
    }

    // --- health policy: every rendered leg ---
    const allowed = new Set(check.allowedHealth ?? []);
    allowed.delete('NON_FINITE'); // never allowed
    for (const leg of legs) {
      const bad = leg.bundle.healthFlags.filter((f) => !allowed.has(f));
      if (bad.length) problems.push(`${leg.label}: disallowed health flags [${bad.join(', ')}]`);
    }
  } catch (err) {
    problems.push(`executor error: ${(err as Error).message}`);
  }

  // --- status classification ---
  let status: CheckStatus;
  const known = Object.prototype.hasOwnProperty.call(opts.knownIssues, check.id);
  if (problems.length === 0) status = known ? 'STALE_KNOWN' : 'PASS';
  else if (known) status = 'KNOWN';
  else status = 'FAIL';

  if (status === 'FAIL' && opts.saveFailure) {
    // Save only the last-rendered leg: the interesting one for single-leg
    // checks; for two-leg checks one render keeps the disk cost sane.
    const last = legs[legs.length - 1];
    if (last) failures.push(await opts.saveFailure(check.id, last.spec, last.clip));
  }

  const detail =
    status === 'PASS' ? 'ok'
    : status === 'STALE_KNOWN' ? `passes but listed in known-issues (${opts.knownIssues[check.id]}) — remove the entry`
    : problems.join('; ') + (known ? ` [known: ${opts.knownIssues[check.id]}]` : '');
  return { id: check.id, engine: check.engine, title: check.title, status, detail, values, failureDirs: failures };
}

function evalDelta(problems: string[], metric: string, from: number | null, to: number | null,
    direction: 'up' | 'down' | 'change', minDelta: number): void {
  if (from == null || to == null) { problems.push(`${metric} null (from=${fmt(from)}, to=${fmt(to)})`); return; }
  const delta = to - from;
  const ok = direction === 'up' ? delta >= minDelta
    : direction === 'down' ? delta <= -minDelta
    : Math.abs(delta) >= minDelta;
  if (!ok) problems.push(`${metric} delta ${fmt(delta)} failed ${direction} ≥ ${minDelta}`);
}

function noteFreq(n: { note?: string; freq?: number }): number {
  if (n.freq != null) return n.freq;
  // noteToFreq lives in render/engine; import it at top of file
  return noteToFreq(n.note!);
}
const fmt = (x: number | null | undefined) => (x == null ? 'null' : x.toFixed(3));
```

Add `import { noteToFreq } from '../render/engine';` at the top (already exported).

- [ ] **Step 6: Run tests** — `npm test -w @fiddle/audio-lab -- audit/executor` → PASS (all 11).

- [ ] **Step 7: Run whole workspace + typecheck** — `npm test -w @fiddle/audio-lab && npm run typecheck -w @fiddle/audio-lab` → PASS.

- [ ] **Step 8: Commit** — `git add packages/audio-lab/src/audit && git commit -m "feat(audio-lab): audit core — CheckSpec types, metric bag, executor"`

---

### Task 5: Audit harness — report writer, known-issues, configs, scripts, smoke pipeline

Everything that turns `runCheck` into `npm run lab:audit`: the per-run report, the register, the vitest split, and a two-check smoke table proving the pipeline end-to-end against real kernels.

**Files:**
- Create: `packages/audio-lab/src/audit/report.ts`, `packages/audio-lab/src/audit/report.test.ts`
- Create: `packages/audio-lab/src/audit/known-issues.ts`
- Create: `packages/audio-lab/src/audit/audit.test.ts`
- Create: `packages/audio-lab/src/audit/checks/baselines.ts`
- Create: `packages/audio-lab/vitest.audit.config.ts`
- Modify: `packages/audio-lab/vitest.config.ts`, `packages/audio-lab/package.json`, root `package.json`

**Interfaces:**
- Consumes: `runCheck`, `RenderFn`, `CheckResult`, `CheckSpec` (Task 4); `renderEngine`, `writeRunDir` (existing).
- Produces: `writeAuditReport(results: CheckResult[], dir: string): Promise<{ md: string; json: string }>`; `KNOWN_ISSUES: Record<string, string>`; `allChecks(fast: boolean): CheckSpec[]` assembled in `audit.test.ts` (Tasks 6–10 append their tables to its imports); `SYNTH2_BASE`, `DRUM_BASE(engine)` baselines; scripts `npm run lab:audit`, `npm run lab:audit:fast`.

- [ ] **Step 1: Write the failing report-writer test** — `report.test.ts`:

```ts
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeAuditReport } from './report';
import type { CheckResult } from './types';

const res = (over: Partial<CheckResult>): CheckResult => ({
  id: 'x', engine: 'kick2', title: 't', status: 'PASS', detail: 'ok', values: { peakDb: -6.2 }, failureDirs: [], ...over,
});

describe('writeAuditReport', () => {
  it('writes md + json grouped by engine with a status summary line', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'audit-'));
    const results = [
      res({ id: 'kick2.a' }),
      res({ id: 'synth2.b', engine: 'synth2', status: 'FAIL', detail: 'delta too small', failureDirs: ['/runs/f1'] }),
      res({ id: 'synth2.c', engine: 'synth2', status: 'KNOWN', detail: 'expected' }),
      res({ id: 'kick2.d', status: 'STALE_KNOWN', detail: 'remove entry' }),
    ];
    await writeAuditReport(results, dir);
    const md = await readFile(join(dir, 'audit-report.md'), 'utf8');
    const json = JSON.parse(await readFile(join(dir, 'audit-report.json'), 'utf8'));
    expect(md).toContain('## synth2');
    expect(md).toContain('## kick2');
    expect(md).toContain('1 FAIL');
    expect(md).toContain('/runs/f1');
    expect(md).toContain('STALE');
    expect(json.results).toHaveLength(4);
    expect(json.counts).toEqual({ PASS: 1, FAIL: 1, KNOWN: 1, STALE_KNOWN: 1 });
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npm test -w @fiddle/audio-lab -- audit/report` → FAIL.

- [ ] **Step 3: Implement `report.ts`**:

```ts
// Writes audit-report.md (human) + audit-report.json (machine) for one run.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CheckResult, CheckStatus } from './types';

const ORDER: CheckStatus[] = ['FAIL', 'STALE_KNOWN', 'KNOWN', 'PASS'];
const ICON: Record<CheckStatus, string> = { PASS: '✅', FAIL: '❌', KNOWN: '🟡', STALE_KNOWN: '⚠️ STALE' };

export async function writeAuditReport(results: CheckResult[], dir: string): Promise<{ md: string; json: string }> {
  await mkdir(dir, { recursive: true });
  const counts: Record<CheckStatus, number> = { PASS: 0, FAIL: 0, KNOWN: 0, STALE_KNOWN: 0 };
  for (const r of results) counts[r.status]++;

  const engines = [...new Set(results.map((r) => r.engine))];
  let md = `# Audit report — ${new Date().toISOString()}\n\n`;
  md += `**${results.length} checks: ${counts.PASS} PASS, ${counts.FAIL} FAIL, ${counts.KNOWN} KNOWN, ${counts.STALE_KNOWN} STALE_KNOWN**\n\n`;
  for (const engine of engines) {
    md += `## ${engine}\n\n`;
    const rows = results.filter((r) => r.engine === engine)
      .sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
    for (const r of rows) {
      md += `- ${ICON[r.status]} \`${r.id}\` — ${r.title}`;
      if (r.status !== 'PASS') md += `\n  - ${r.detail}`;
      for (const d of r.failureDirs) md += `\n  - render: ${d}`;
      md += '\n';
    }
    md += '\n';
  }
  const mdPath = join(dir, 'audit-report.md');
  const jsonPath = join(dir, 'audit-report.json');
  await writeFile(mdPath, md);
  await writeFile(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), counts, results }, null, 2));
  return { md: mdPath, json: jsonPath };
}
```

- [ ] **Step 4: Run** — `npm test -w @fiddle/audio-lab -- audit/report` → PASS.

- [ ] **Step 5: `known-issues.ts`** (starts empty):

```ts
// Expected-failure register: check id -> one-line reason. A failing check
// listed here reports KNOWN (suite stays green); a PASSING check listed here
// reports STALE_KNOWN so dead entries get removed. Keep reasons specific.
export const KNOWN_ISSUES: Record<string, string> = {};
```

- [ ] **Step 6: `checks/baselines.ts`** — the shared render bases every check table builds on:

```ts
// Shared audit baselines. Synth2 renders at osc levels 0.2/0.2 — raw kernels
// have no mixer gain staging and CLIP at the 0.8/0.8 defaults (known truth;
// only the default-patch fingerprint checks render defaults, with CLIPPING
// allowed). Drums render one hit and enough tail to measure decay.
import type { EngineId, EngineRenderSpec } from '../../render/engine';

export const SYNTH2_LEVELS = { 'osc1.level': 0.2, 'osc2.level': 0.2, 'osc3.level': 0 };

export const synth2Base = (over: Partial<EngineRenderSpec> = {}): EngineRenderSpec => ({
  engine: 'synth2',
  params: { ...SYNTH2_LEVELS, ...(over.params ?? {}) },
  notes: over.notes ?? [{ time: 0, note: 'A3', duration: 0.5 }],
  seconds: over.seconds ?? 1.2,
  matrix: over.matrix,
});

// A held 2s note for modulation checks (LFO cycles, env loops need room).
export const synth2Held = (params: Record<string, number> = {}, matrix?: EngineRenderSpec['matrix']): EngineRenderSpec =>
  synth2Base({ params, matrix, notes: [{ time: 0, note: 'A3', duration: 2 }], seconds: 2.4 });

export const drumBase = (engine: EngineId, params: Record<string, number> = {}, seconds = 1.2): EngineRenderSpec => ({
  engine, params, notes: [{ time: 0, note: 'C3', duration: 0.3 }], seconds,
});
```

- [ ] **Step 7: `audit.test.ts`** — the heavy entry. Tasks 6–10 only edit the marked import/spread lines:

```ts
// THE audit suite entry. Runs ONLY under vitest.audit.config.ts
// (npm run lab:audit); the normal gate excludes this file.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { renderEngine, type EngineRenderSpec } from '../render/engine';
import type { AudioClip } from '../types';
import { writeRunDir } from '../report/report';
import { runCheck } from './executor';
import { writeAuditReport } from './report';
import { KNOWN_ISSUES } from './known-issues';
import type { CheckResult, CheckSpec } from './types';
// task-6..10 imports go here:
// import { kick2Checks } from './checks/kick2.checks';
// …

const FAST = process.env.AUDIT_FAST === '1';
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const AUDIT_DIR = join(import.meta.dirname, '..', '..', '.audio-lab', 'audit', STAMP);

const checks: CheckSpec[] = [
  // task-6..10 spreads go here, e.g. …kick2Checks,
];

const saveFailure = async (id: string, spec: EngineRenderSpec, clip: AudioClip): Promise<string> => {
  const dir = join(AUDIT_DIR, 'failures', id);
  await mkdir(dir, { recursive: true });
  await writeRunDir({ dir, spec, clip });
  return dir;
};

const results: CheckResult[] = [];
const byEngine = new Map<string, CheckSpec[]>();
for (const c of checks) {
  if (!byEngine.has(c.engine)) byEngine.set(c.engine, []);
  byEngine.get(c.engine)!.push(c);
}

for (const [engine, engineChecks] of byEngine) {
  describe(engine, () => {
    it.each(engineChecks.map((c) => [c.id, c] as const))('%s', async (_id, check) => {
      const r = await runCheck(check, { render: renderEngine, knownIssues: KNOWN_ISSUES, saveFailure });
      results.push(r);
      // KNOWN keeps the suite green; STALE_KNOWN nags in the report only.
      expect(r.status === 'FAIL' ? `${r.status}: ${r.detail}` : 'ok').toBe('ok');
    }, 120_000);
  });
}

afterAll(async () => {
  if (!results.length) return;
  const { md } = await writeAuditReport(results, AUDIT_DIR);
  console.log(`\naudit report: ${md} (fast=${FAST})`);
});
```

(`import.meta.dirname` works under vitest/esbuild with Node ≥20; if typecheck complains, use `new URL('.', import.meta.url).pathname` instead.)

- [ ] **Step 8: vitest configs + scripts**

`vitest.audit.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/audit/audit.test.ts'],
    testTimeout: 120_000,
    // renders are CPU-bound; default pool parallelism is fine, but keep
    // one file = one worker (it's a single file anyway).
  },
});
```

`vitest.config.ts` — add the exclusion:

```ts
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '**/src/audit/audit.test.ts'],
  },
});
```

`packages/audio-lab/package.json` scripts:

```json
"audit": "vitest run --config vitest.audit.config.ts",
"audit:fast": "AUDIT_FAST=1 vitest run --config vitest.audit.config.ts"
```

Root `package.json` scripts (next to the existing `"lab"`):

```json
"lab:audit": "npm run audit -w @fiddle/audio-lab",
"lab:audit:fast": "npm run audit:fast -w @fiddle/audio-lab"
```

- [ ] **Step 9: Prove the pipeline with two temporary smoke checks** — in `audit.test.ts`, temporarily set:

```ts
import { drumBase } from './checks/baselines';
const checks: CheckSpec[] = [
  { id: 'smoke.kick2.audible', engine: 'kick2', title: 'default kick is audible',
    baseline: drumBase('kick2'), assertion: { kind: 'absolute', metric: 'peakDb', min: -30 },
    allowedHealth: ['MOSTLY_SILENT'] },
  { id: 'smoke.kick2.decay', engine: 'kick2', title: 'decay knob lengthens decay',
    baseline: drumBase('kick2'), allowedHealth: ['MOSTLY_SILENT'],
    assertion: { kind: 'directional', param: 'decay', from: 0.1, to: 1.0, metric: 'decaySeconds', direction: 'up', minDelta: 0.15 } },
];
```

Run: `npm run lab:audit` (from repo root)
Expected: 2 passing tests; console prints the audit-report path; open the md — 2 PASS lines under `## kick2`. Then run `npm test -w @fiddle/audio-lab` and confirm audit.test.ts is NOT in its file list (exclusion works).
The smoke checks STAY in the file until Task 6 replaces them (they're real checks; Task 6's kick2 table subsumes them).

- [ ] **Step 10: Full gate** — `npm test -w @fiddle/audio-lab && npm run typecheck -w @fiddle/audio-lab` → PASS.

- [ ] **Step 11: Commit** — `git add packages/audio-lab package.json && git commit -m "feat(audio-lab): audit harness — report writer, known-issues register, lab:audit runner"`

---

### Task 6: kick2 + snare2 check tables

Pure data + one calibration pass. Descriptor ground truth (from `packages/shared/src/engines/kick2.ts` / `snare2.ts`):
kick2 `tune 30–120 def 50 · punch 0–1 · pitchDecay 0.005–0.2 · decay 0.05–1.5 · click 0–1 · drive 0–1 · droop 0–1 · level 0–1 def 0.9`;
snare2 `tune 100–340 def 180 · bodyDecay 0.02–0.4 · noiseDecay 0.02–0.5 · snappy 0–1 def 0.6 · tone 800–8000 def 3500 · noiseHp 0–1 def 0.4 · level 0–1 def 0.9`.

**Files:**
- Create: `packages/audio-lab/src/audit/checks/kick2.checks.ts`, `packages/audio-lab/src/audit/checks/snare2.checks.ts`
- Modify: `packages/audio-lab/src/audit/audit.test.ts` (imports + spreads; delete the Task-5 smoke checks)

**Interfaces:**
- Consumes: `CheckSpec` (Task 4), `drumBase` (Task 5).
- Produces: `kick2Checks: CheckSpec[]`, `snare2Checks: CheckSpec[]`.

- [ ] **Step 1: Write `kick2.checks.ts`**

```ts
import type { CheckSpec } from '../types';
import { drumBase } from './baselines';

const PERC = ['MOSTLY_SILENT']; // one-shots in a longer window flag this by design
const d = (id: string, title: string, a: CheckSpec['assertion'], seconds = 1.2): CheckSpec => ({
  id: `kick2.${id}`, engine: 'kick2', title, baseline: drumBase('kick2', {}, seconds),
  assertion: a, allowedHealth: PERC,
});

export const kick2Checks: CheckSpec[] = [
  d('fingerprint.peak', 'default hit is audible', { kind: 'absolute', metric: 'peakDb', min: -12, max: 0 }),
  d('fingerprint.decay', 'default decay in expected window', { kind: 'absolute', metric: 'decaySeconds', min: 0.1, max: 0.9 }),
  d('fingerprint.centroid', 'default spectral centroid in kick range', { kind: 'absolute', metric: 'meanCentroidHz', min: 40, max: 2500 }),
  d('tune.dir', 'tune raises the dominant spectral peak', { kind: 'directional', param: 'tune', from: 40, to: 100, metric: 'domPeakHz', direction: 'up', minDelta: 25 }),
  d('punch.dir', 'punch changes the attack spectrum', { kind: 'directional', param: 'punch', from: 0, to: 1, metric: 'meanCentroidHz', direction: 'change', minDelta: 60 }),
  d('pitchDecay.dir', 'longer pitch decay = more time spent high', { kind: 'directional', param: 'pitchDecay', from: 0.01, to: 0.18, metric: 'medianF0', direction: 'up', minDelta: 5 }),
  d('decay.dir', 'decay knob lengthens the tail', { kind: 'directional', param: 'decay', from: 0.1, to: 1.2, metric: 'decaySeconds', direction: 'up', minDelta: 0.2 }, 2),
  d('click.dir', 'click adds high-frequency attack energy', { kind: 'directional', param: 'click', from: 0, to: 1, metric: 'bandHi', direction: 'up', minDelta: 0.02 }),
  d('drive.dir', 'drive brightens via added harmonics', { kind: 'directional', param: 'drive', from: 0, to: 1, metric: 'meanCentroidHz', direction: 'up', minDelta: 50 }),
  d('droop.dir', 'droop widens the pitch trajectory', { kind: 'directional', param: 'droop', from: 0, to: 1, metric: 'f0WidthHz', direction: 'up', minDelta: 4 }),
  d('level.dir', 'level raises output', { kind: 'directional', param: 'level', from: 0.3, to: 0.9, metric: 'peakDb', direction: 'up', minDelta: 5 }),
];
```

- [ ] **Step 2: Write `snare2.checks.ts`**

```ts
import type { CheckSpec } from '../types';
import { drumBase } from './baselines';

const PERC = ['MOSTLY_SILENT'];
const d = (id: string, title: string, a: CheckSpec['assertion'], params: Record<string, number> = {}, seconds = 1.2): CheckSpec => ({
  id: `snare2.${id}`, engine: 'snare2', title, baseline: drumBase('snare2', params, seconds),
  assertion: a, allowedHealth: PERC,
});

export const snare2Checks: CheckSpec[] = [
  d('fingerprint.peak', 'default hit is audible', { kind: 'absolute', metric: 'peakDb', min: -12, max: 0 }),
  d('fingerprint.decay', 'default decay in expected window', { kind: 'absolute', metric: 'decaySeconds', min: 0.05, max: 0.6 }),
  d('tune.dir', 'tune raises the shell peak', { kind: 'directional', param: 'tune', from: 120, to: 320, metric: 'domPeakHz', direction: 'up', minDelta: 60 },
    { snappy: 0.15 }), // body-dominant so the shell peak wins the spectrum
  d('bodyDecay.dir', 'body decay lengthens the tail (body-dominant patch)', { kind: 'directional', param: 'bodyDecay', from: 0.03, to: 0.38, metric: 'decaySeconds', direction: 'up', minDelta: 0.08 }, { snappy: 0.1 }),
  d('noiseDecay.dir', 'noise decay lengthens the tail (noise-dominant patch)', { kind: 'directional', param: 'noiseDecay', from: 0.03, to: 0.48, metric: 'decaySeconds', direction: 'up', minDelta: 0.1 }, { snappy: 0.9 }),
  d('snappy.dir', 'snappy shifts balance toward bright noise', { kind: 'directional', param: 'snappy', from: 0.1, to: 0.9, metric: 'meanCentroidHz', direction: 'up', minDelta: 250 }),
  d('tone.dir', 'tone brightens the noise band', { kind: 'directional', param: 'tone', from: 1200, to: 7000, metric: 'meanCentroidHz', direction: 'up', minDelta: 400 }, { snappy: 0.9 }),
  d('noiseHp.dir', 'noise highpass removes lows', { kind: 'directional', param: 'noiseHp', from: 0, to: 1, metric: 'bandLo', direction: 'down', minDelta: 0.01 }, { snappy: 0.9 }),
  d('level.dir', 'level raises output', { kind: 'directional', param: 'level', from: 0.3, to: 0.9, metric: 'peakDb', direction: 'up', minDelta: 5 }),
];
```

- [ ] **Step 3: Wire into `audit.test.ts`** — delete the two Task-5 smoke checks; add imports + spreads:

```ts
import { kick2Checks } from './checks/kick2.checks';
import { snare2Checks } from './checks/snare2.checks';
const checks: CheckSpec[] = [...kick2Checks, ...snare2Checks];
```

- [ ] **Step 4: Run + calibrate (Global Constraints calibration rule)**

Run: `npm run lab:audit` TWICE. Open both `packages/audio-lab/.audio-lab/audit/<stamp>/audit-report.json`.
For every directional check apply the calibration rule ((a) margin ≥ 2×, (b) variance < minDelta/2). Metrics chosen with `change` direction (punch) or uncertain physical direction (pitchDecay's medianF0, droop's f0WidthHz — the pitch tracker may return sparse f0 on clicky content): if a metric comes back null or unstable across the two runs, switch that check to the nearest robust alternative (punch → `bandMid`; pitchDecay → `meanCentroidHz` up; droop → `medianF0` down with body-long decay params) and re-run. Every change lands in the commit body.
Expected end state: all kick2+snare2 checks PASS twice consecutively.

- [ ] **Step 5: Gate** — `npm test -w @fiddle/audio-lab && npm run typecheck -w @fiddle/audio-lab` → PASS (audit file still excluded).

- [ ] **Step 6: Commit** — `git add packages/audio-lab/src/audit && git commit -m "feat(audio-lab): kick2 + snare2 audit check tables (calibrated)"`

---

### Task 7: hat2 + clap2 check tables

Descriptor ground truth: hat2 `tone 3000–14000 def 9000 · decay 0.02–0.8 def 0.08 · hpf 3000–12000 def 7000 · metallic 0–1 def 0.7 · ring 0–1 def 0.2 · level 0–1 def 0.8`;
clap2 `tone 500–3000 def 1000 · spread 0.005–0.04 def 0.012 · bursts 2–5 def 3 · body 0.002–0.03 def 0.008 · room 0.05–0.8 def 0.25 · mix 0–1 def 0.5 · level 0–1 def 0.8`. Both are noise engines — no f0 metrics anywhere (tracker nulls are expected, not failures).

**Files:**
- Create: `packages/audio-lab/src/audit/checks/hat2.checks.ts`, `packages/audio-lab/src/audit/checks/clap2.checks.ts`
- Modify: `packages/audio-lab/src/audit/audit.test.ts` (imports + spreads)

**Interfaces:**
- Consumes: `CheckSpec`, `drumBase`.
- Produces: `hat2Checks: CheckSpec[]`, `clap2Checks: CheckSpec[]`.

- [ ] **Step 1: Write `hat2.checks.ts`**

```ts
import type { CheckSpec } from '../types';
import { drumBase } from './baselines';

const PERC = ['MOSTLY_SILENT']; // hat2 default decay is ~0.08s — flags by design
const d = (id: string, title: string, a: CheckSpec['assertion'], params: Record<string, number> = {}, seconds = 1.2): CheckSpec => ({
  id: `hat2.${id}`, engine: 'hat2', title, baseline: drumBase('hat2', params, seconds),
  assertion: a, allowedHealth: PERC,
});

export const hat2Checks: CheckSpec[] = [
  d('fingerprint.peak', 'default hit is audible', { kind: 'absolute', metric: 'peakDb', min: -15, max: 0 }),
  d('fingerprint.bright', 'default hat is HF-dominant', { kind: 'absolute', metric: 'bandHi', min: 0.6 }),
  d('tone.dir', 'tone brightens the metal band', { kind: 'directional', param: 'tone', from: 4000, to: 13000, metric: 'meanCentroidHz', direction: 'up', minDelta: 500 }),
  d('decay.dir', 'decay knob lengthens the tail', { kind: 'directional', param: 'decay', from: 0.03, to: 0.6, metric: 'decaySeconds', direction: 'up', minDelta: 0.1 }, {}, 1.5),
  d('hpf.dir', 'hpf removes body from below', { kind: 'directional', param: 'hpf', from: 3000, to: 11000, metric: 'meanCentroidHz', direction: 'up', minDelta: 400 }),
  d('metallic.dir', 'metallic reshapes the partial mix', { kind: 'directional', param: 'metallic', from: 0, to: 1, metric: 'meanCentroidHz', direction: 'change', minDelta: 200 }),
  d('ring.dir', 'ring changes the tail character', { kind: 'directional', param: 'ring', from: 0, to: 1, metric: 'decaySeconds', direction: 'change', minDelta: 0.03 }, { decay: 0.3 }, 1.5),
  d('level.dir', 'level raises output', { kind: 'directional', param: 'level', from: 0.3, to: 0.8, metric: 'peakDb', direction: 'up', minDelta: 4 }),
];
```

- [ ] **Step 2: Write `clap2.checks.ts`**

```ts
import type { CheckSpec } from '../types';
import { drumBase } from './baselines';

const PERC = ['MOSTLY_SILENT'];
const d = (id: string, title: string, a: CheckSpec['assertion'], params: Record<string, number> = {}, seconds = 1.5): CheckSpec => ({
  id: `clap2.${id}`, engine: 'clap2', title, baseline: drumBase('clap2', params, seconds),
  assertion: a, allowedHealth: PERC,
});

export const clap2Checks: CheckSpec[] = [
  d('fingerprint.peak', 'default clap is audible', { kind: 'absolute', metric: 'peakDb', min: -15, max: 0 }),
  d('tone.dir', 'tone brightens the bandpass', { kind: 'directional', param: 'tone', from: 600, to: 2600, metric: 'meanCentroidHz', direction: 'up', minDelta: 300 }),
  d('spread.dir', 'wider spread stretches the burst train', { kind: 'directional', param: 'spread', from: 0.006, to: 0.038, metric: 'attackSeconds', direction: 'up', minDelta: 0.02 }),
  d('bursts.dir', 'more bursts lengthen the pre-peak train', { kind: 'directional', param: 'bursts', from: 2, to: 5, metric: 'attackSeconds', direction: 'up', minDelta: 0.015 }, { spread: 0.03 }),
  d('body.dir', 'burst body decay audibly changes the envelope', { kind: 'directional', param: 'body', from: 0.003, to: 0.028, metric: 'decaySeconds', direction: 'change', minDelta: 0.02 }, { mix: 0.1 }), // burst-dominant
  d('room.dir', 'room lengthens the reverberant tail', { kind: 'directional', param: 'room', from: 0.08, to: 0.7, metric: 'decaySeconds', direction: 'up', minDelta: 0.1 }, { mix: 0.9 }), // room-dominant
  d('mix.dir', 'mix moves energy from bursts to room tail', { kind: 'directional', param: 'mix', from: 0.1, to: 0.9, metric: 'decaySeconds', direction: 'up', minDelta: 0.05 }),
  d('level.dir', 'level raises output', { kind: 'directional', param: 'level', from: 0.3, to: 0.8, metric: 'peakDb', direction: 'up', minDelta: 4 }),
];
```

- [ ] **Step 3: Wire into `audit.test.ts`** (imports + spreads, same pattern as Task 6).

- [ ] **Step 4: Run + calibrate** — `npm run lab:audit` twice; apply the calibration rule. Specific fallbacks if a metric proves unstable: clap2 `spread`/`bursts` → `onsetCount` `up` (wide spreads may register multiple onsets past the 20ms refractory) or `decaySeconds` `change`; hat2 `metallic` → `bandMid` `change`. All clap2/hat2 checks must PASS twice consecutively; note that clap2 passing here is *mechanical* correctness — its known aesthetic problem ("doesn't sound like a clap", BACKLOG) stays open and is NOT entered in known-issues (nothing here fails on it).

- [ ] **Step 5: Gate** — `npm test -w @fiddle/audio-lab && npm run typecheck -w @fiddle/audio-lab` → PASS.

- [ ] **Step 6: Commit** — `git add packages/audio-lab/src/audit && git commit -m "feat(audio-lab): hat2 + clap2 audit check tables (calibrated)"`

---

### Task 8: synth2 knob / enum / boolean checks (non-matrix)

The big table: all 52 kernel-live synth2 rows except `glide.time` (Task 9). The 18 `*.sync`/`*.div` rows are Tier-1 dead slots and belong to the blind-spot registry (Task 11), NOT here. Key facts from `SYNTH2_DESCRIPTORS`: `osc*.morph 0–3 def 2`, `osc*.pulseWidth 0.05–0.95`, `osc*.coarse ±36 st`, `osc*.fine ±1200 c`, `filter.cutoff 20–20000 def 2000`, `filter.envAmount −4..4 def 2.4`, `filter.type enum lp|bp|hp`, `filter.model enum classic|morph`, `lfo*.rate 0.01–2000`, `lfo*.mode enum off|s&h|smooth`, env stages `0.001–10`. LFO/env3 knobs are only audible through a matrix route, so those baselines carry one.

**Files:**
- Create: `packages/audio-lab/src/audit/checks/synth2.checks.ts`
- Modify: `packages/audio-lab/src/audit/audit.test.ts` (import + spread)

**Interfaces:**
- Consumes: `CheckSpec`, `synth2Base`, `synth2Held`, `SYNTH2_LEVELS`.
- Produces: `synth2Checks: CheckSpec[]`.

- [ ] **Step 1: Write `synth2.checks.ts`** — helpers then the table. `solo1/solo2/solo3/noiseSolo` zero the other sources so pitch/level metrics are unambiguous:

```ts
import type { CheckSpec } from '../types';
import { synth2Base, synth2Held } from './baselines';

const solo1 = { 'osc1.level': 0.25, 'osc2.level': 0, 'osc3.level': 0 };
const solo2 = { 'osc1.level': 0, 'osc2.level': 0.25, 'osc3.level': 0 };
const solo3 = { 'osc1.level': 0, 'osc2.level': 0, 'osc3.level': 0.25 };
const noiseSolo = { 'osc1.level': 0, 'osc2.level': 0, 'osc3.level': 0, 'noise.level': 0.3 };

const c = (id: string, title: string, a: CheckSpec['assertion'],
    params: Record<string, number> = {}, held = false,
    matrix?: { source: string; dest: string; amount: number }[]): CheckSpec => ({
  id: `synth2.${id}`, engine: 'synth2', title,
  baseline: held ? synth2Held(params, matrix) : synth2Base({ params, matrix }),
  assertion: a,
});
const dir = (param: string, from: number, to: number, metric: MetricId,
    direction: 'up' | 'down' | 'change', minDelta: number): CheckSpec['assertion'] =>
  ({ kind: 'directional', param, from, to, metric, direction, minDelta });
```

(Add `import type { MetricId } from '../types';` to the imports.) The table; every entry is `(id, title, assertion, params, held?, matrix?)`:

```ts
const LFO1_CUT = [{ source: 'lfo1', dest: 'filter.cutoff', amount: 0.8 }];
const LFO2_CUT = [{ source: 'lfo2', dest: 'filter.cutoff', amount: 0.8 }];
const ENV3_FINE = [{ source: 'env3', dest: 'osc1.fine', amount: 0.8 }];

export const synth2Checks: CheckSpec[] = [
  // --- oscillator 1 (solo) ---
  c('osc1.morph.dir', 'morph sweeps to a brighter shape', dir('osc1.morph', 0, 3, 'meanCentroidHz', 'up', 200), solo1),
  c('osc1.pulseWidth.dir', 'narrow pulse is brighter', dir('osc1.pulseWidth', 0.5, 0.08, 'meanCentroidHz', 'up', 150), { ...solo1, 'osc1.morph': 3 }),
  c('osc1.coarse.dir', '+12 st doubles f0', dir('osc1.coarse', 0, 12, 'medianF0', 'up', 150), solo1),
  c('osc1.fine.dir', '+700 c raises f0 ~1.5x', dir('osc1.fine', 0, 700, 'medianF0', 'up', 60), solo1),
  c('osc1.level.dir', 'level raises output', dir('osc1.level', 0.05, 0.25, 'peakDb', 'up', 8), { 'osc2.level': 0, 'osc3.level': 0 }),
  c('osc1.sync.chg', 'osc1 hard sync changes the spectrum', dir('osc1.sync', 0, 1, 'meanCentroidHz', 'change', 100), { ...solo1, 'osc1.coarse': 7 }),
  // --- oscillator 2 / 3 (solo; same shapes as osc1) ---
  c('osc2.morph.dir', 'morph sweeps brighter', dir('osc2.morph', 0, 3, 'meanCentroidHz', 'up', 200), solo2),
  c('osc2.pulseWidth.dir', 'narrow pulse brighter', dir('osc2.pulseWidth', 0.5, 0.08, 'meanCentroidHz', 'up', 150), { ...solo2, 'osc2.morph': 3 }),
  c('osc2.coarse.dir', '+12 st doubles f0', dir('osc2.coarse', 0, 12, 'medianF0', 'up', 150), { ...solo2, 'osc2.fine': 0 }),
  c('osc2.fine.dir', '+700 c raises f0', dir('osc2.fine', 0, 700, 'medianF0', 'up', 60), solo2),
  c('osc2.level.dir', 'level raises output', dir('osc2.level', 0.05, 0.25, 'peakDb', 'up', 8), { 'osc1.level': 0, 'osc3.level': 0 }),
  c('osc2.sync.chg', 'hard sync vs free detuned osc2', dir('osc2.sync', 0, 1, 'meanCentroidHz', 'change', 100), { ...solo2, 'osc2.coarse': 7 }),
  c('osc3.morph.dir', 'morph sweeps brighter', dir('osc3.morph', 0, 3, 'meanCentroidHz', 'up', 200), solo3),
  c('osc3.pulseWidth.dir', 'narrow pulse brighter', dir('osc3.pulseWidth', 0.5, 0.08, 'meanCentroidHz', 'up', 150), { ...solo3, 'osc3.morph': 3 }),
  c('osc3.coarse.dir', '+12 st doubles f0', dir('osc3.coarse', 0, 12, 'medianF0', 'up', 150), solo3),
  c('osc3.fine.dir', '+700 c raises f0', dir('osc3.fine', 0, 700, 'medianF0', 'up', 60), solo3),
  c('osc3.level.dir', 'level raises output', dir('osc3.level', 0.05, 0.25, 'peakDb', 'up', 8), { 'osc1.level': 0, 'osc2.level': 0 }),
  c('osc3.sync.chg', 'hard sync vs free detuned osc3', dir('osc3.sync', 0, 1, 'meanCentroidHz', 'change', 100), { ...solo3, 'osc3.coarse': 7 }),
  // --- noise + FM ---
  c('noise.level.dir', 'noise level raises output', dir('noise.level', 0, 0.35, 'rmsDb', 'up', 10), { 'osc1.level': 0, 'osc2.level': 0, 'osc3.level': 0 }),
  c('noise.color.dir', 'color morphs dark to bright', dir('noise.color', 0.1, 0.9, 'meanCentroidHz', 'up', 800), noiseSolo),
  c('fm.osc2.dir', 'osc2->osc1 FM adds sidebands', dir('fm.osc2', 0, 3, 'meanCentroidHz', 'up', 250), { ...solo1, 'osc2.coarse': 19 }),
  c('fm.osc3.dir', 'osc3->osc1 FM adds sidebands', dir('fm.osc3', 0, 3, 'meanCentroidHz', 'up', 250), { ...solo1, 'osc3.coarse': 19 }),
  // --- env1 (amp) ---
  c('env1.a.dir', 'attack knob slows the attack', dir('env1.a', 0.001, 0.4, 'attackSeconds', 'up', 0.2), {}, true),
  c('env1.d.dir', 'decay knob lengthens decay (s=0)', dir('env1.d', 0.05, 1.0, 'decaySeconds', 'up', 0.3), { 'env1.s': 0 }, true),
  c('env1.s.dir', 'sustain raises held level', dir('env1.s', 0.05, 0.9, 'rmsDb', 'up', 6), { 'env1.d': 0.15 }, true),
  c('env1.r.rel', 'release lengthens the tail', dir('env1.r', 0.05, 1.2, 'decaySeconds', 'up', 0.3),
    {}, false), // gate 0.5 in a 1.2s window: tail dominates the decay measurement
  // --- env2 (filter; envAmount 2.4 default, dark base cutoff) ---
  c('env2.a.chg', 'filter-env attack shifts brightness over time', dir('env2.a', 0.001, 0.8, 'meanCentroidHz', 'change', 150), { 'filter.cutoff': 300 }, true),
  c('env2.d.dir', 'filter-env decay keeps it bright longer', dir('env2.d', 0.05, 1.0, 'meanCentroidHz', 'up', 150), { 'filter.cutoff': 300, 'env2.s': 0 }, true),
  c('env2.s.dir', 'filter-env sustain holds brightness', dir('env2.s', 0, 1, 'meanCentroidHz', 'up', 200), { 'filter.cutoff': 300 }, true),
  c('env2.r.chg', 'filter-env release shapes the tail', dir('env2.r', 0.05, 1.2, 'meanCentroidHz', 'change', 100), { 'filter.cutoff': 300 }),
  // --- filter ---
  c('filter.cutoff.dir', 'cutoff darkens when lowered', dir('filter.cutoff', 8000, 300, 'meanCentroidHz', 'down', 800)),
  c('filter.resonance.chg', 'resonance reshapes the spectrum', dir('filter.resonance', 0, 0.9, 'meanCentroidHz', 'change', 100), { 'filter.cutoff': 800 }),
  c('filter.keyTrack.dir', 'keytrack opens the filter on a high note', dir('filter.keyTrack', 0, 1, 'meanCentroidHz', 'up', 200),
    { 'filter.cutoff': 300 }), // note override below
  c('filter.envAmount.dir', 'env amount opens the filter', dir('filter.envAmount', 0, 4, 'meanCentroidHz', 'up', 250), { 'filter.cutoff': 300 }),
  c('filter.drive.dir', 'drive adds harmonics', dir('filter.drive', 0, 1, 'meanCentroidHz', 'up', 80), { 'filter.cutoff': 1200 }),
  c('filter.type.enum', 'lp/bp/hp are audible and spectrally ordered',
    { kind: 'enum', param: 'filter.type', values: [0, 1, 2], minPeakDb: -40, distinct: { metric: 'meanCentroidHz', minSpread: 600 } },
    { 'filter.cutoff': 800 }),
  c('filter.model.enum', 'classic vs morph model both sound', 
    { kind: 'enum', param: 'filter.model', values: [0, 1], minPeakDb: -40, distinct: { metric: 'meanCentroidHz', minSpread: 20 } },
    { 'filter.cutoff': 800, 'filter.resonance': 0.5 }),
  c('filter.morph.chg', 'morph-model sweep reshapes the spectrum', dir('filter.morph', 0, 2, 'meanCentroidHz', 'change', 200), { 'filter.model': 1, 'filter.cutoff': 800 }),
  // --- LFOs (audible only through a route) ---
  c('lfo1.rate.dir', 'lfo1 rate speeds the wobble', dir('lfo1.rate', 0.5, 6, 'modRateCentroidHz', 'up', 3), { 'filter.cutoff': 1200 }, true, LFO1_CUT),
  c('lfo1.shape.chg', 'lfo1 shape changes the wobble contour', dir('lfo1.shape', 0, 4, 'modDepthCentroid', 'change', 80), { 'filter.cutoff': 1200, 'lfo1.rate': 4 }, true, LFO1_CUT),
  c('lfo2.rate.dir', 'lfo2 rate speeds the wobble', dir('lfo2.rate', 0.5, 6, 'modRateCentroidHz', 'up', 3), { 'filter.cutoff': 1200 }, true, LFO2_CUT),
  c('lfo2.shape.chg', 'lfo2 shape changes the wobble contour', dir('lfo2.shape', 0, 4, 'modDepthCentroid', 'change', 80), { 'filter.cutoff': 1200, 'lfo2.rate': 4 }, true, LFO2_CUT),
  c('lfo1.mode.enum', 'off/s&h/smooth all render healthily',
    { kind: 'enum', param: 'lfo1.mode', values: [0, 1, 2], minPeakDb: -40 },
    { 'lfo1.rate': 2 }, true, [{ source: 'lfo1', dest: 'osc1.fine', amount: 0.5 }]),
  c('lfo2.mode.enum', 'off/s&h/smooth all render healthily',
    { kind: 'enum', param: 'lfo2.mode', values: [0, 1, 2], minPeakDb: -40 },
    { 'lfo2.rate': 2 }, true, [{ source: 'lfo2', dest: 'osc1.fine', amount: 0.5 }]),
  // --- env3 (mod env; audible via env3->osc1.fine) ---
  c('env3.a.chg', 'mod-env attack shifts the pitch trajectory', dir('env3.a', 0.01, 0.8, 'medianF0', 'change', 5), solo1, true, ENV3_FINE),
  c('env3.d.dir', 'mod-env decay holds the offset longer', dir('env3.d', 0.05, 1.0, 'medianF0', 'up', 8), { ...solo1, 'env3.a': 0.001, 'env3.s': 0 }, true, ENV3_FINE),
  c('env3.s.dir', 'mod-env sustain sustains the offset', dir('env3.s', 0, 1, 'medianF0', 'up', 12), { ...solo1, 'env3.a': 0.001 }, true, ENV3_FINE),
  c('env3.r.chg', 'mod-env release shapes the pitch tail', dir('env3.r', 0.05, 1.2, 'medianF0', 'change', 4), { ...solo1, 'env3.s': 0.8 }, false, ENV3_FINE),
  // --- env loops ---
  c('env1.loop.dir', 'looping amp env pulses the level', dir('env1.loop', 0, 1, 'modDepthRms', 'up', 2), { 'env1.d': 0.15, 'env1.s': 0 }, true),
  c('env2.loop.dir', 'looping filter env pulses brightness', dir('env2.loop', 0, 1, 'modDepthCentroid', 'up', 80), { 'filter.cutoff': 400, 'env2.d': 0.2, 'env2.s': 0 }, true),
  c('env3.loop.dir', 'looping mod env pulses pitch', dir('env3.loop', 0, 1, 'modDepthF0', 'up', 8), { ...solo1, 'env3.d': 0.2, 'env3.s': 0 }, true, ENV3_FINE),
];
```

Two baseline tweaks the helper can't express — apply directly after the array literal:

```ts
// keytrack check must play a HIGH note for tracking to matter:
const kt = synth2Checks.find((x) => x.id === 'synth2.filter.keyTrack.dir')!;
kt.baseline = { ...kt.baseline, notes: [{ time: 0, note: 'C5', duration: 0.5 }] };
// env1.r release check: short gate, long window, so the tail IS the decay:
const rel = synth2Checks.find((x) => x.id === 'synth2.env1.r.rel')!;
rel.baseline = { ...rel.baseline, notes: [{ time: 0, note: 'A3', duration: 0.5 }], seconds: 2.2 };
const rel2 = synth2Checks.find((x) => x.id === 'synth2.env2.r.chg')!;
rel2.baseline = { ...rel2.baseline, notes: [{ time: 0, note: 'A3', duration: 0.5 }], seconds: 2.2 };
const rel3 = synth2Checks.find((x) => x.id === 'synth2.env3.r.chg')!;
rel3.baseline = { ...rel3.baseline, notes: [{ time: 0, note: 'A3', duration: 0.5 }], seconds: 2.2 };
```

- [ ] **Step 2: Wire into `audit.test.ts`** (import + spread).

- [ ] **Step 3: Run + calibrate** — `npm run lab:audit` twice; apply the calibration rule to all ~50 checks. Documented fallbacks where physical direction was a judgment call: `osc*.morph`/`pulseWidth` → direction `change`; `osc1.sync` → if no measurable effect at all, demote to `{ kind: 'health' }` with a comment naming the observed behavior (its exact routing semantics are the finding — record it for the Task 12 report, DON'T guess); `env2.a.chg` → metric `attackSeconds` on a band-limited render if centroid is stable; `env3.*` medianF0 deltas → recalibrate signs from what the render actually does (positive amount could be up or down — flip `from`/`to`, not the DSP); `lfo*.shape` → if depth spread across shapes is < noise, switch metric to `modRateCentroidHz` `change` (square doubles apparent crossing rate vs sine). Every adjustment in the commit body.

- [ ] **Step 4: Gate** — `npm test -w @fiddle/audio-lab && npm run typecheck -w @fiddle/audio-lab` → PASS.

- [ ] **Step 5: Commit** — `git add packages/audio-lab/src/audit && git commit -m "feat(audio-lab): synth2 knob/enum/boolean audit checks (calibrated)"`

---

### Task 9: synth2 tuning, glide, allocation, fingerprints

**Files:**
- Create: `packages/audio-lab/src/audit/checks/synth2-perf.checks.ts`
- Modify: `packages/audio-lab/src/audit/audit.test.ts` (import + spread)

**Interfaces:**
- Consumes: `CheckSpec`, `synth2Base`, plus `SYNTH2_LEVELS` for the fingerprint.
- Produces: `synth2PerfChecks: CheckSpec[]`.

- [ ] **Step 1: Write `synth2-perf.checks.ts`**

```ts
import type { CheckSpec } from '../types';
import { synth2Base } from './baselines';

const solo1 = { 'osc1.level': 0.25, 'osc2.level': 0, 'osc3.level': 0 };
const sine = { ...solo1, 'osc1.morph': 0 };
const pulse = { ...solo1, 'osc1.morph': 3 };

const tune = (id: string, note: string, hz: number, params: Record<string, number>): CheckSpec => ({
  id: `synth2.tuning.${id}`, engine: 'synth2', title: `${note} renders at ${hz}Hz ±1`,
  baseline: synth2Base({ params, notes: [{ time: 0, note, duration: 0.8 }], seconds: 1 }),
  assertion: { kind: 'absolute', metric: 'medianF0', min: hz - 1, max: hz + 1 },
});

const glide = (id: string, knob: number, tol: number, mono: boolean, title: string): CheckSpec => ({
  id: `synth2.glide.${id}`, engine: 'synth2', title,
  baseline: synth2Base({
    params: { ...sine, 'glide.time': knob },
    notes: [
      { time: 0, note: 'A2', duration: 0.45, mono },
      { time: 0.5, note: 'A3', duration: 0.6, mono },
    ],
    seconds: 1.6,
  }),
  assertion: { kind: 'pitchSettle', knobSeconds: knob, toleranceSeconds: tol },
});

export const synth2PerfChecks: CheckSpec[] = [
  // Tuning at three octaves, sine + a harmonic-rich pulse probe per octave
  // (the pulse probes exist to catch the pitch tracker's known octave-up
  // risk on even-harmonic-heavy content — a FAIL here is a LAB finding).
  tune('a2.sine', 'A2', 110, sine), tune('a3.sine', 'A3', 220, sine), tune('a4.sine', 'A4', 440, sine),
  tune('a2.pulse', 'A2', 110, pulse), tune('a3.pulse', 'A3', 220, pulse), tune('a4.pulse', 'A4', 440, pulse),
  // Glide: settle time tracks the knob (mono only); poly must snap.
  glide('instant', 0.001, 0.05, true, 'glide 1ms = effectively instant'),
  glide('100ms', 0.1, 0.06, true, 'glide 100ms settles in ~100ms'),
  glide('300ms', 0.3, 0.08, true, 'glide 300ms settles in ~300ms'),
  { ...glide('poly-snaps', 0.001, 0.05, false, 'poly ignores glide even with knob at 300ms'),
    baseline: (() => { const b = glide('x', 0.001, 0.05, false, '').baseline;
      return { ...b, params: { ...b.params, 'glide.time': 0.3 } }; })() },
  // Mono voice stealing: overlapping notes, second wins immediately.
  { id: 'synth2.mono.steal', engine: 'synth2', title: 'mono: overlapping second note takes the pitch',
    baseline: synth2Base({ params: sine,
      notes: [{ time: 0, note: 'A2', duration: 1.0, mono: true }, { time: 0.4, note: 'E3', duration: 0.6, mono: true }],
      seconds: 1.4 }),
    assertion: { kind: 'pitchSettle', knobSeconds: 0.001, toleranceSeconds: 0.05 } },
  // Poly chord: both voices sound at once. The mono pitch tracker can't
  // assert two f0s, and the spec's "spectral peaks contain both roots" needs
  // a peak-SET metric the vocabulary doesn't have (deliberate YAGNI — it
  // would exist for this one check). Health+audibility here; true chord
  // semantics stay covered by client voice-allocation unit tests and by
  // sub-project C. Recorded as a partial in the Task-12 coverage statement.
  { id: 'synth2.poly.chord', engine: 'synth2', title: 'poly chord renders healthily (allocation detail: unit tests + C)',
    baseline: synth2Base({ params: sine,
      notes: [{ time: 0, note: 'A3', duration: 0.8 }, { time: 0, note: 'E4', duration: 0.8 }],
      seconds: 1.2 }),
    assertion: { kind: 'absolute', metric: 'peakDb', min: -24, max: 0 } },
  // Fingerprints: audit patch (levels 0.2) and TRUE defaults (0.8+0.8 clips raw — allowed).
  { id: 'synth2.fingerprint.audit-patch', engine: 'synth2', title: 'audit patch fingerprint',
    baseline: synth2Base({}), assertion: { kind: 'absolute', metric: 'peakDb', min: -24, max: -3 } },
  { id: 'synth2.fingerprint.default-centroid', engine: 'synth2', title: 'audit patch centroid window',
    baseline: synth2Base({}), assertion: { kind: 'absolute', metric: 'meanCentroidHz', min: 300, max: 4000 } },
  { id: 'synth2.fingerprint.true-defaults', engine: 'synth2', title: 'true default patch (raw kernel clips: known)',
    baseline: { engine: 'synth2', notes: [{ time: 0, note: 'A3', duration: 0.5 }], seconds: 1.2 },
    assertion: { kind: 'absolute', metric: 'peakDb', min: 0, max: 8 },
    allowedHealth: ['CLIPPING'] },
];
```

- [ ] **Step 2: Wire into `audit.test.ts`**; run + calibrate (rule as before). Specific notes: if a `pulse` tuning probe FAILs with an octave-up reading, that is the Phase-1 pitch-tracker residual surfacing — add it to `known-issues.ts` with reason `pitch tracker octave-up risk on even-harmonic content (lab limitation, see Task 12 findings)` and carry it to the Task-12 report; do NOT change the check to hide it. Fingerprint windows: adjust min/max to measured value ±6dB / ±40% after the first run and note the measured anchors in the commit body.

- [ ] **Step 3: Gate** — `npm test -w @fiddle/audio-lab && npm run typecheck -w @fiddle/audio-lab` → PASS.

- [ ] **Step 4: Commit** — `git add packages/audio-lab/src/audit && git commit -m "feat(audio-lab): synth2 tuning/glide/allocation/fingerprint audit checks"`

---

### Task 10: full synth2 mod matrix — families, generator, exhaustiveness

Every source × dest cell (8 × 42 = 336): real cells get a family-templated assertion; `none` source/dest cells assert health-only (inert by definition). Fast mode collapses to one dest per family per source.

**Files:**
- Create: `packages/audio-lab/src/audit/checks/synth2-matrix.ts`
- Test: `packages/audio-lab/src/audit/checks/synth2-matrix.test.ts` (gate-run; NO renders)
- Modify: `packages/audio-lab/src/audit/audit.test.ts` (import + spread of `synth2MatrixChecks(FAST)`)

**Interfaces:**
- Consumes: `MOD_SOURCES`, `MOD_DESTS` from `@fiddle/shared`; `CheckSpec`; `synth2Held`, `synth2Base`.
- Produces: `synth2MatrixChecks(fast: boolean): CheckSpec[]`, `DEST_FAMILY: Record<string, DestFamily>`, `EXPECTED_INERT: ReadonlyArray<readonly [string, string]>`.

- [ ] **Step 1: Write the gate-run exhaustiveness test first** — `synth2-matrix.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { MOD_DESTS, MOD_SOURCES } from '@fiddle/shared';
import { DEST_FAMILY, EXPECTED_INERT, synth2MatrixChecks } from './synth2-matrix';

describe('synth2 matrix coverage', () => {
  it('every MOD_DEST is classified into exactly one family (appending a dest without classifying it fails here)', () => {
    for (const dest of MOD_DESTS) {
      if (dest === 'none') continue;
      expect(DEST_FAMILY[dest], `unclassified mod dest '${dest}'`).toBeDefined();
    }
    for (const key of Object.keys(DEST_FAMILY)) {
      expect(MOD_DESTS).toContain(key); // no stale entries either
    }
  });
  it('full mode emits one check per source x dest cell', () => {
    expect(synth2MatrixChecks(false)).toHaveLength(MOD_SOURCES.length * MOD_DESTS.length);
  });
  it('fast mode is a strict, much smaller subset', () => {
    const full = new Set(synth2MatrixChecks(false).map((c) => c.id));
    const fast = synth2MatrixChecks(true);
    expect(fast.length).toBeLessThan(80);
    for (const c of fast) expect(full).toContain(c.id);
  });
  it('EXPECTED_INERT only names real cells, with reasons in the source', () => {
    for (const [s, d] of EXPECTED_INERT) {
      expect(MOD_SOURCES).toContain(s);
      expect(MOD_DESTS).toContain(d);
    }
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npm test -w @fiddle/audio-lab -- synth2-matrix` → FAIL (module missing).

- [ ] **Step 3: Implement `synth2-matrix.ts`**

```ts
// The full synth2 mod-matrix audit: MOD_SOURCES x MOD_DESTS, each real cell
// asserted through its destination family's metric template. 'none' cells
// and EXPECTED_INERT cells render health-only.
import { MOD_DESTS, MOD_SOURCES } from '@fiddle/shared';
import type { CheckSpec, MetricId } from '../types';
import { synth2Base, synth2Held } from './baselines';

export type DestFamily = 'pitch' | 'timbre' | 'level' | 'filter' | 'fm' | 'envtime' | 'lforate' | 'glide';

export const DEST_FAMILY: Record<string, DestFamily> = {
  'osc1.coarse': 'pitch', 'osc1.fine': 'pitch', 'osc2.coarse': 'pitch', 'osc2.fine': 'pitch',
  'osc3.coarse': 'pitch', 'osc3.fine': 'pitch',
  'osc1.morph': 'timbre', 'osc1.pulseWidth': 'timbre', 'osc2.morph': 'timbre', 'osc2.pulseWidth': 'timbre',
  'osc3.morph': 'timbre', 'osc3.pulseWidth': 'timbre', 'noise.color': 'timbre',
  'lfo1.shape': 'timbre', 'lfo2.shape': 'timbre',
  'osc1.level': 'level', 'osc2.level': 'level', 'osc3.level': 'level', 'noise.level': 'level',
  'filter.cutoff': 'filter', 'filter.resonance': 'filter', 'filter.keyTrack': 'filter',
  'filter.drive': 'filter', 'filter.morph': 'filter',
  'fm.osc2': 'fm', 'fm.osc3': 'fm',
  'env1.a': 'envtime', 'env1.d': 'envtime', 'env1.s': 'envtime', 'env1.r': 'envtime',
  'env2.a': 'envtime', 'env2.d': 'envtime', 'env2.s': 'envtime', 'env2.r': 'envtime',
  'env3.a': 'envtime', 'env3.d': 'envtime', 'env3.s': 'envtime', 'env3.r': 'envtime',
  'lfo1.rate': 'lforate', 'lfo2.rate': 'lforate',
  'glide.time': 'glide',
};

// Cells whose family metric is not expected to move measurably in a Tier-1
// render; they assert health only. Every entry needs a reason. Populated
// further during calibration — each addition must carry a one-line comment.
export const EXPECTED_INERT: ReadonlyArray<readonly [string, string]> = [
  // lfoN.shape modulated by lfoN itself is self-referential and sub-noise:
  ['lfo1', 'lfo1.shape'], ['lfo2', 'lfo2.shape'],
];

// Per-family: metric for a periodic/stochastic source (modDepth-style, on a
// held note) and scalar metric for one-shot (env) / static (velocity) sources.
const FAMILY_METRIC: Record<DestFamily, { depth: MetricId; scalar: MetricId; minDepth: number; minScalar: number }> = {
  pitch:   { depth: 'modDepthF0',       scalar: 'f0WidthHz',        minDepth: 5,    minScalar: 8 },
  timbre:  { depth: 'modDepthCentroid', scalar: 'meanCentroidHz',   minDepth: 60,   minScalar: 80 },
  level:   { depth: 'modDepthRms',      scalar: 'rmsDb',            minDepth: 1.5,  minScalar: 2 },
  filter:  { depth: 'modDepthCentroid', scalar: 'meanCentroidHz',   minDepth: 80,   minScalar: 100 },
  fm:      { depth: 'modDepthCentroid', scalar: 'meanCentroidHz',   minDepth: 60,   minScalar: 80 },
  envtime: { depth: 'modDepthRms',      scalar: 'decaySeconds',     minDepth: 1,    minScalar: 0.05 },
  lforate: { depth: 'modDepthCentroid', scalar: 'modRateCentroidHz', minDepth: 40,  minScalar: 1.5 },
  glide:   { depth: 'modDepthF0',       scalar: 'medianF0',         minDepth: 4,    minScalar: 3 },
};

// Baselines engineered so the dest is LIVE: env3 dests need env3 routed;
// lfoN.rate/shape dests need that LFO routed; glide needs a mono note pair;
// env2 dests rely on the default filter.envAmount 2.4 with a dark cutoff.
function baselineFor(dest: string): CheckSpec['baseline'] {
  const params: Record<string, number> = { 'filter.cutoff': 1200 };
  const matrix: { source: string; dest: string; amount: number }[] = [];
  if (dest.startsWith('env3.')) matrix.push({ source: 'env3', dest: 'osc1.fine', amount: 0.6 });
  if (dest.startsWith('env2.')) params['filter.cutoff'] = 400;
  if (dest === 'lfo1.rate' || dest === 'lfo1.shape') { params['lfo1.rate'] = 4; matrix.push({ source: 'lfo1', dest: 'filter.cutoff', amount: 0.7 }); }
  if (dest === 'lfo2.rate' || dest === 'lfo2.shape') { params['lfo2.rate'] = 4; matrix.push({ source: 'lfo2', dest: 'filter.cutoff', amount: 0.7 }); }
  if (dest === 'glide.time') {
    return synth2Base({ params: { 'glide.time': 0.05 },
      notes: [{ time: 0, note: 'A2', duration: 0.9, mono: true }, { time: 1.0, note: 'A3', duration: 1.0, mono: true }],
      seconds: 2.4 });
  }
  if (dest.startsWith('env1.')) { params['env1.d'] = 0.3; params['env1.s'] = 0.4; }
  return synth2Held(params, matrix);
}

export function synth2MatrixChecks(fast: boolean): CheckSpec[] {
  const checks: CheckSpec[] = [];
  const inert = new Set(EXPECTED_INERT.map(([s, d]) => `${s}->${d}`));
  const seenFastKey = new Set<string>();

  for (const source of MOD_SOURCES) {
    for (const dest of MOD_DESTS) {
      const id = `synth2.matrix.${source}->${dest}`;
      const family = dest === 'none' ? null : DEST_FAMILY[dest];
      const isInert = source === 'none' || dest === 'none' || inert.has(`${source}->${dest}`);

      if (fast && family) {
        const key = `${source}:${family}:${isInert}`;
        if (seenFastKey.has(key)) continue;
        seenFastKey.add(key);
      }

      const baseline = dest === 'none' ? synth2Held() : baselineFor(dest);
      if (isInert) {
        checks.push({ id, engine: 'synth2', title: `route ${source} -> ${dest} renders healthily`,
          baseline: { ...baseline, matrix: [...(baseline.matrix ?? []), { source, dest, amount: 0.8 }] },
          assertion: { kind: 'health' } });
        continue;
      }
      const fam = FAMILY_METRIC[family!];
      const oneShot = source.startsWith('env');
      const isVelocity = source === 'velocity';
      checks.push({
        id, engine: 'synth2', title: `route ${source} -> ${dest} moves ${family}`,
        baseline,
        assertion: isVelocity
          ? { kind: 'route', source, dest, amount: 0.8, compare: 'velocity-pair', metric: fam.scalar, direction: 'change', minDelta: fam.minScalar }
          : oneShot
            ? { kind: 'route', source, dest, amount: 0.8, compare: 'off-vs-on', metric: fam.scalar, direction: 'change', minDelta: fam.minScalar }
            : { kind: 'route', source, dest, amount: 0.8, compare: 'off-vs-on', metric: fam.depth, direction: 'up', minDelta: fam.minDepth },
      });
    }
  }
  return checks;
}
```

- [ ] **Step 4: Run the gate tests** — `npm test -w @fiddle/audio-lab -- synth2-matrix` → PASS (336 full, <80 fast).

- [ ] **Step 5: Wire into `audit.test.ts`**:

```ts
import { synth2MatrixChecks } from './checks/synth2-matrix';
const checks: CheckSpec[] = [/* …existing spreads…, */ ...synth2MatrixChecks(FAST)];
```

- [ ] **Step 6: Calibrate in two stages** — first `npm run lab:audit:fast` twice (one cell per family per source: fix family metrics/minima at this scale), then the full `npm run lab:audit` twice (expect a long run — hundreds of renders; if wall-clock exceeds ~10 min, shorten `synth2Held` to 2.0s/2.2s total first, then reconsider — the spec caps the full run at roughly this). Cells that genuinely don't move (e.g. `noise` source into `envtime` dests may be sub-noise) go into `EXPECTED_INERT` **with a one-line reason comment each** — that list is reviewed code, not a dumping ground; anything surprising (a route that plainly should work but doesn't) goes to `known-issues.ts` + the Task-12 findings list instead. End state: full run green twice.

- [ ] **Step 7: Gate** — `npm test -w @fiddle/audio-lab && npm run typecheck -w @fiddle/audio-lab` → PASS.

- [ ] **Step 8: Commit** — `git add packages/audio-lab/src/audit && git commit -m "feat(audio-lab): full synth2 mod-matrix audit (336 cells, family templates, fast mode)"`

---

### Task 11: completeness meta-tests + blind-spot registry

The contract that keeps the suite honest forever: every descriptor key of every v2 engine is either exercised by a check or explicitly declared a blind spot with a reason. A future descriptor append fails the gate until classified.

**Files:**
- Create: `packages/audio-lab/src/audit/checks/blind-spots.ts`
- Test: `packages/audio-lab/src/audit/checks/completeness.test.ts` (gate-run; NO renders)

**Interfaces:**
- Consumes: all check tables (Tasks 6–10), descriptor tables from `@fiddle/shared` (`SYNTH2_DESCRIPTORS`, `KICK2_DESCRIPTORS`, `SNARE2_DESCRIPTORS`, `HAT2_DESCRIPTORS`, `CLAP2_DESCRIPTORS`).
- Produces: `BLIND_SPOTS: Record<string, string>` (param key → reason), `coveredParams(checks: CheckSpec[]): Set<string>`.

- [ ] **Step 1: Write `blind-spots.ts`** — the 18 Tier-1-dead synth2 rows, each with its reason:

```ts
// Params NO Tier-1 check can exercise, with the reason. The completeness
// meta-test forces every descriptor key to appear either in a check or here —
// appending a param to any v2 engine breaks the gate until it's classified.
const SYNC_DERIVED =
  'main-thread derived (effectiveLfoRate/effectiveEnvTimes/effectiveGlideTime); dead kernel slot in Tier 1 — covered by shared unit tests now, sub-project C end-to-end later';

export const BLIND_SPOTS: Record<string, string> = {
  'lfo1.sync': SYNC_DERIVED, 'lfo1.div': SYNC_DERIVED,
  'lfo2.sync': SYNC_DERIVED, 'lfo2.div': SYNC_DERIVED,
  'env1.sync': SYNC_DERIVED, 'env1.aDiv': SYNC_DERIVED, 'env1.dDiv': SYNC_DERIVED, 'env1.rDiv': SYNC_DERIVED,
  'env2.sync': SYNC_DERIVED, 'env2.aDiv': SYNC_DERIVED, 'env2.dDiv': SYNC_DERIVED, 'env2.rDiv': SYNC_DERIVED,
  'env3.sync': SYNC_DERIVED, 'env3.aDiv': SYNC_DERIVED, 'env3.dDiv': SYNC_DERIVED, 'env3.rDiv': SYNC_DERIVED,
  'glide.sync': SYNC_DERIVED, 'glide.div': SYNC_DERIVED,
};
```

- [ ] **Step 2: Write `completeness.test.ts`**:

```ts
import { describe, expect, it } from 'vitest';
import {
  SYNTH2_DESCRIPTORS, KICK2_DESCRIPTORS, SNARE2_DESCRIPTORS, HAT2_DESCRIPTORS, CLAP2_DESCRIPTORS,
} from '@fiddle/shared';
import type { CheckSpec } from '../types';
import { BLIND_SPOTS } from './blind-spots';
import { kick2Checks } from './kick2.checks';
import { snare2Checks } from './snare2.checks';
import { hat2Checks } from './hat2.checks';
import { clap2Checks } from './clap2.checks';
import { synth2Checks } from './synth2.checks';
import { synth2PerfChecks } from './synth2-perf.checks';
import { synth2MatrixChecks } from './synth2-matrix';

// A param counts as covered when a check moves it (directional/enum), routes
// to it (matrix dest), or pins it in a baseline that an assertion depends on.
export function coveredParams(checks: CheckSpec[]): Set<string> {
  const covered = new Set<string>();
  for (const c of checks) {
    const a = c.assertion;
    if (a.kind === 'directional' || a.kind === 'enum') covered.add(a.param);
    if (a.kind === 'route') covered.add(a.dest);
    if (a.kind === 'pitchSettle') covered.add('glide.time');
    for (const r of c.baseline.matrix ?? []) covered.add(r.dest);
  }
  return covered;
}

const CASES: Array<[string, ReadonlyArray<{ key: string }>, CheckSpec[]]> = [
  ['kick2', KICK2_DESCRIPTORS, kick2Checks],
  ['snare2', SNARE2_DESCRIPTORS, snare2Checks],
  ['hat2', HAT2_DESCRIPTORS, hat2Checks],
  ['clap2', CLAP2_DESCRIPTORS, clap2Checks],
  ['synth2', SYNTH2_DESCRIPTORS, [...synth2Checks, ...synth2PerfChecks, ...synth2MatrixChecks(false)]],
];

describe('audit completeness: every descriptor key is checked or a declared blind spot', () => {
  it.each(CASES.map(([n, d, c]) => [n, d, c] as const))('%s', (_name, descriptors, checks) => {
    const covered = coveredParams(checks);
    const missing = descriptors
      .map((d) => d.key)
      .filter((k) => !covered.has(k) && !(k in BLIND_SPOTS));
    expect(missing, `unclassified params: ${missing.join(', ')} — add a check or a blind-spot entry`).toEqual([]);
  });
  it('blind spots only name real synth2 keys (no stale entries)', () => {
    const keys = new Set(SYNTH2_DESCRIPTORS.map((d) => d.key));
    for (const k of Object.keys(BLIND_SPOTS)) expect(keys.has(k), `stale blind spot '${k}'`).toBe(true);
  });
});
```

- [ ] **Step 3: Run** — `npm test -w @fiddle/audio-lab -- completeness` → likely a few `missing` params on first run (e.g. a drum knob whose check got renamed during calibration). Resolve each by adding the missing check or (only with a real reason) a blind-spot entry — the test's failure message lists them. End: PASS.
Note: exact descriptor-table export names — if e.g. `KICK2_DESCRIPTORS` is actually exported under a different name from `@fiddle/shared`, use the real name (check `packages/shared/src/engines/index.ts`); do not redeclare tables locally.

- [ ] **Step 4: Full gate incl. repo-wide** — `npm test -w @fiddle/audio-lab && npm run typecheck -w @fiddle/audio-lab && npm run typecheck --workspaces --if-present` → PASS.

- [ ] **Step 5: Commit** — `git add packages/audio-lab/src/audit && git commit -m "test(audio-lab): audit completeness meta-tests + Tier-1 blind-spot registry"`

---

### Task 12: THE AUDIT — first full run, findings, ear pass

Everything before this built the instrument; this task plays it. This is an execution + judgment task, not a coding task — it produces the audit findings and the user conversation the campaign was for.

**Files:**
- Create: `docs/superpowers/audits/2026-07-17-v2-engine-audit.md` (committed findings doc)
- Possibly modify: `packages/audio-lab/src/audit/known-issues.ts` (user-triaged entries)

- [ ] **Step 1: Full clean run** — `npm run lab:audit` (full matrix). Save the report path. Run it a second time; confirm no flaky checks (any check that flips between runs gets its tolerance fixed NOW, per the calibration rule, before findings are written).

- [ ] **Step 2: Render the five ear-pass WAVs** — default patch per engine via the CLI (these are for the USER's ears, so true defaults, not audit levels):

```bash
npm run lab -- render-engine synth2 --notes "A2:0:1.0,A3:1.2:1.0,E3:2.4:1.0" --seconds 4 --label earpass-synth2
npm run lab -- render-engine kick2  --notes "C3:0:0.4,C3:0.5:0.4,C3:1.0:0.4,C3:1.5:0.4" --seconds 2.2 --label earpass-kick2
npm run lab -- render-engine snare2 --notes "C3:0:0.4,C3:0.5:0.4,C3:1.0:0.4,C3:1.5:0.4" --seconds 2.2 --label earpass-snare2
npm run lab -- render-engine hat2   --notes "C3:0:0.2,C3:0.25:0.2,C3:0.5:0.2,C3:0.75:0.2,C3:1.0:0.2,C3:1.25:0.2" --seconds 2 --label earpass-hat2
npm run lab -- render-engine clap2  --notes "C3:0:0.4,C3:0.5:0.4,C3:1.0:0.4,C3:1.5:0.4" --seconds 2.2 --label earpass-clap2
```

- [ ] **Step 3: Write the findings doc** — `docs/superpowers/audits/2026-07-17-v2-engine-audit.md` with: run stamp + counts; every non-PASS check with its metric evidence and a proposed disposition (fix-now / backlog / known-issue / lab-limitation); every EXPECTED_INERT and blind-spot entry (so the doc is the audit's honest coverage statement); observations from reading each engine's default-patch spectrogram (open the PNGs with the Read tool); the lab findings register (pitch-tracker octave issues, metric instabilities discovered during calibration).

- [ ] **Step 4: Send the user the ear-pass WAVs + findings.** Use SendUserFile for the five `render.wav` files (from `packages/audio-lab/.audio-lab/runs/<stamp>-earpass-*/render.wav`) with a caption naming each engine, and present the findings summary in the conversation: counts, the non-PASS list with proposed dispositions, and the known aesthetic question (clap2's voicing is a pre-existing BACKLOG item — flag for the ear pass, don't relitigate it silently). **STOP and triage with the user**: each FAIL becomes fix-now (new branch, separate work), backlog entry (docs/BACKLOG.md), or known-issues.ts entry per the user's call. Apply the known-issues/BACKLOG outcomes of that conversation on this branch; fix-now items are follow-up branches.

- [ ] **Step 5: Final gate + commit** — `npm test -w @fiddle/audio-lab && npm run typecheck -w @fiddle/audio-lab`, then:

```bash
git add docs/superpowers/audits packages/audio-lab/src/audit/known-issues.ts docs/BACKLOG.md
git commit -m "docs(audit): first v2 engine audit — findings, triage, known-issues register"
```

- [ ] **Step 6: Housekeeping** — verify `git status` is clean (run dirs live under gitignored `.audio-lab/`), and per repo rules do NOT merge: the branch waits for the user's browser-era verification call and merge decision. Note for the finisher: this branch changes no app code — the mandatory browser-verification Stop hook applies to app changes; the audit's "verification" IS the lab run + the user triage above.

---

## Execution notes for the controller

- **Task order is strict** (each consumes the previous task's exports); no parallel dispatch.
- Tasks 6–10's calibration steps NEED real renders — implementers must actually run `lab:audit` twice and read the JSON, not eyeball the code. Reviewers: ask for the measured numbers.
- Context budget: Tasks 8 and 10 are the big ones (large data tables); they are transcription-heavy but decision-light — good haiku/sonnet candidates with the table verbatim in the brief. Task 12 is judgment-heavy — keep it with the controller or opus.
- The user's standing rules apply: never `npm run dev` (prod DB), reuse a running dev stack, keep branches after merge, browser verification via Playwright MCP if any app surface is ever touched (none should be).

