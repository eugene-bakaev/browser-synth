// The full synth2 mod-matrix audit: MOD_SOURCES x MOD_DESTS, each real cell
// asserted through its destination family's metric template. 'none' cells
// and EXPECTED_INERT cells render health-only.
//
// CALIBRATED (Task 10, two consecutive `npm run lab:audit` runs; full numbers
// in the commit body / task-10-report.md). Highlights (full writeup in the
// report):
//
//  - direction is ALWAYS 'change' (never 'up'), for every family, both depth
//    and scalar metrics. The plan's draft used 'up' for periodic (depth)
//    sources on the theory that adding a route only ever INCREASES an
//    oscillation depth metric. Measured reality: several real, working
//    routes swing the metric in the negative direction just as often as
//    positive (e.g. lfo1->osc1.morph -48, lfo1->lfo1.rate -1193, most of the
//    envtime family) because destinations like morph/pulseWidth/shape are
//    NON-MONOTONIC (a bipolar sweep can net out to a smaller p95-p5 spread
//    than the unmodulated baseline) and because "off-vs-on" for a mod matrix
//    can legitimately reduce a metric already inflated by baseline transients.
//    'change' (|delta| >= minDelta) is the only direction that's robust to
//    this without chasing a sign convention cell-by-cell.
//  - LEVEL family (osc*.level/noise.level): the generic held baseline mixes
//    the tested channel with an unchanged second oscillator (dilution) AND,
//    at the default route amount 0.8, clips — NOT from the modulated LEVEL
//    itself (linear taper clamps at 1.0) but from the well-known cold-start
//    ParamSlot glide (synth2.checks.ts header): a fresh kernel's first note
//    always glides from the COMPILED default (0.8) toward the configured
//    level over ~5-20ms, and a matrix route adds its contribution ON TOP of
//    that still-elevated transient, overshooting the clamp into a real,
//    sample-level clip. Fixed by (1) soloing the tested channel (mute the
//    others) and (2) lowering this family's route amount to 0.25 (measured:
//    0.3 still clips on velocity's v1.0 leg; 0.25 is clean and still gives a
//    huge, healthy modDepthRms/rmsDb margin).
//  - TIMBRE family (osc*.morph, osc*.pulseWidth): same dilution problem
//    (mixing with an unchanged second oscillator) — soloing the tested osc
//    (and setting morph:3 as the pulseWidth baseline, matching
//    synth2.checks.ts's calibrated pulseWidth checks) turned deltas of
//    16-52 (below the 60 threshold) into 130-567 (comfortably above it).
//  - FM family (fm.osc2/fm.osc3): the generic baseline mixed all three
//    oscillators; fm.osc2/fm.osc3 = 'FM 1->2'/'FM 2->3' per the descriptor
//    labels, so the CARRIER must be soloed and the MODULATOR detuned (exact
//    mirror of the calibrated non-matrix fm.osc2.dir/fm.osc3.dir checks) —
//    otherwise the modulator's FM sidebands land on a channel mixed at
//    level 0, and velocity's scalar check failed outright (64.8 < 80).
//  - PITCH family scalar metric swapped f0WidthHz -> medianF0. f0WidthHz
//    (max-min f0 over the clip) is built to catch a PERIODIC pitch wobble;
//    a one-shot/velocity source shifts pitch by a roughly CONSTANT amount
//    for the whole note, which doesn't widen the observed range at all
//    (measured: velocity->osc1.coarse via f0WidthHz was 0.265, a full 30x
//    under the minDelta of 8). medianF0 (the shifted value itself) measured
//    145.6 for the same cell — matches the metric already used by the
//    calibrated non-matrix osc1.coarse.dir/osc1.fine.dir checks.
//  - filter.drive: WAS engineered into the resonance:0.95 self-oscillation
//    zone (Task 8/10) because the drive saturator used to be a no-op below
//    resonance 0.9. FIXED (audit-fix campaign Task 3, 2026-07-19): SvfCore.ts
//    now saturates the normal path too, so this dest uses the same normal
//    moderate-resonance patch as every other filter-family cell. Un-inerted
//    lfo2 and noise (both now measurably live — see MIN_DELTA_OVERRIDE and
//    EXPECTED_INERT for the numbers); see synth2.checks.ts's filter.drive.dir
//    for the full drive-curve measurement.
//  - ENVTIME family (env1/2/3 x a/d/s/r, 12 dests) needed the most
//    engineering — see the ENVTIME_SPEC table below and the report for the
//    full per-dest writeup. Short version: 'a'/'d'/'r' are one-shot-per-note
//    trajectory stages (only sampled once, or during one brief stage, per
//    note) so a periodic source's "depth" isn't a meaningful concept the way
//    it is for a continuously-modulated destination; each dest gets its own
//    bespoke baseline (short trajectory-dominated window for a/d, low
//    sustain override so the stage crosses the health analyzer's decay
//    floor, short-gate+long-tail for r) and either one shared metric across
//    all 8 sources or a depth/scalar split, whichever measurement supported.
//    'env3.s' defaults to 0 in the descriptor (a percussive mod-env
//    convention) — used as a SOURCE against any other dest, that meant it
//    free-runs at 0 for the whole sustain plateau, killing any test that
//    routes env3 elsewhere; fixed with a universal env3.s:0.4 baseline
//    default (skipped only where 'env3.s' is itself the tested dest).
//  - GLIDE (glide.time) needed a from-scratch baseline: the plan's two-note
//    render (long plateaus either side of a fast, mostly-complete glide)
//    left f0WidthHz/medianF0/modDepthF0 all measuring the STEP TRANSIENT
//    itself (present with or without any route) rather than the route's
//    effect. Rebuilt as a tight window dominated by the transition (base
//    glide 0.3s, note2 duration matched to it) with medianF0 as the single
//    metric across all 8 sources.
//  - Discovered self-averaging: a HIGH-RATE periodic source modulating a
//    duration-integrated metric (decaySeconds) over an entire release can
//    net out near zero because the modulation's own up/down swings happen
//    faster than the stage they're modulating and cancel when integrated —
//    real, not a bug (env1.r: lfo1/noise, see EXPECTED_INERT).
//  - Self-reference cells beyond the plan's lfoN->lfoN.shape: env3->env3.s
//    (its own default-0 sustain gives it nothing to reference) and
//    lfo2->env3.s (measured negative/near-zero even after retuning).
//
// RECALIBRATED (F2 fix, 2026-07-19, audit-fix campaign Task 2; two
// consecutive `npm run lab:audit` runs, both fully green): Voice.noteOn now
// snaps every ParamSlot to its target on a cold voice instead of gliding
// from the compiled default (ParamSlot.ts / Voice.ts) — see synth2.checks.ts
// header for the full mechanism. ENVTIME_SPEC['env2.a']'s baseline left
// env2.d/env2.s at their compiled defaults (0.2 / 0.5), so the note's own
// attack-THEN-decay-to-sustain arc (env2 modulates cutoff via the 2.4
// default filter.envAmount) produced a big, nonlinear rise-then-fall
// centroid trajectory — present in every render regardless of any matrix
// route. modDepth's linear-detrend residual (analyze/moddepth.ts) can't
// separate that curvature from a genuine periodic modulation, so it
// dominated: off=272.0, on=271.7 (lfo2 routed), delta -0.29, nowhere near
// minDepth 8. This was ALWAYS true of the baseline's shape (not something
// the F2 fix introduced) — it was masked before the fix because the
// cold-start glide added its own transient noise on top, which happened to
// make the two legs differ by enough to clear the old (too-low, coincidental)
// margin. Fixed by adding env2.d:0.01, env2.s:1 — env2 now ramps up during
// attack and HOLDS at full level (no decay-back-down arc), isolating the
// attack-shape effect. Measured (env2.a baseline only, amount 0.8, direct
// probing before committing): off=213.74, on(lfo2)=252.56, delta 38.83 (4.85x
// minDepth 8). Verified this baseline change doesn't regress env2.a's other
// 6 real (non-inert) sources sharing the same object — all improved or held
// comfortable margins: lfo1 depth delta 14.00->57.50; env1/env2/env3/
// velocity/noise scalar (meanCentroidHz) deltas all stayed in the
// hundreds, minScalar 4.5 unchanged.
import { MOD_DESTS, MOD_SOURCES } from '@fiddle/shared';
import type { CheckSpec, MetricId } from '../types';
import type { EngineRenderSpec, MatrixRoute, NoteEvent } from '../../render/engine';
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
// render; they assert health only. Every entry needs a reason (measured
// during Task 10 calibration; see the header + report for full numbers).
export const EXPECTED_INERT: ReadonlyArray<readonly [string, string]> = [
  // lfoN.shape modulated by lfoN itself is self-referential and sub-noise:
  ['lfo1', 'lfo1.shape'], ['lfo2', 'lfo2.shape'],
  // noise's depth into a short attack stage measured 0.041 (minDepth would
  // have to sit at the noise floor) — 'noise' is an inherently
  // nondeterministic source (Task 6-9 finding), too risky at that margin.
  ['noise', 'env1.a'],
  // High-rate periodic sources modulating env1.r's duration-integrated
  // decaySeconds self-average to ~0 over the release window (their own
  // up/down swings happen faster than the release itself and cancel out
  // when integrated) — measured -0.005..-0.010 across several lfo1 rates.
  ['lfo1', 'env1.r'],
  // noise similarly self-averages against decaySeconds/rmsDb for the same
  // release-timing reason (measured -0.039..-0.045).
  ['noise', 'env1.r'],
  // lfo2's default shape (triangle) into env3's sustain measured
  // near-zero/negative (-2.6) even after retuning lfo2.rate.
  ['lfo2', 'env3.s'],
  // env3 modulating its OWN sustain is self-referential exactly like the
  // lfoN->lfoN.shape case, and env3.s's descriptor default is 0 (percussive
  // mod-env convention) giving it nothing to reference: measured delta 0.000.
  ['env3', 'env3.s'],
  // noise's mod-source amplitude for an additive linear-taper LEVEL param
  // measured negligible depth (osc1.level: -0.02..0.34, noise.level: -0.02)
  // versus lfo1/lfo2's 6-200+ range — far below any safe, seed-stable
  // margin for a nondeterministic source. Assumed symmetric across the
  // three oscillators (mechanism is per-param, not per-oscillator); the two
  // mandatory full-grid runs corroborate osc1.level directly.
  ['noise', 'osc1.level'], ['noise', 'osc2.level'], ['noise', 'osc3.level'], ['noise', 'noise.level'],
  // noise -> lfo1.rate/lfo2.rate: measured over 20 fresh renders each, the
  // modDepthCentroid delta ranges from -21.8 to +39.3 (min abs 1.9) — no
  // fixed threshold can pass reliably for a source this variable against
  // this metric; health+audibility only.
  ['noise', 'lfo1.rate'], ['noise', 'lfo2.rate'],
  // noise -> filter.keyTrack: measured -3.5..-5.1, far below any threshold
  // that still fits lfo1/lfo2's real (10-30) range — same nondeterminism
  // caution as the other noise entries above.
  ['noise', 'filter.keyTrack'],
  // envtime noise cases weaker than the env-owner sources the scalar
  // threshold was calibrated to: env2.d measured -90.3 (needs <=130 margin
  // from env-owners) and env3.a measured 0.9 (needs <=40) — both far under
  // a safe 2x margin for a nondeterministic source.
  ['noise', 'env2.d'], ['noise', 'env3.a'],
];

// Per-family: metric for a periodic/stochastic source (modDepth-style, on a
// held note) and scalar metric for one-shot (env) / static (velocity)
// sources. envtime and glide are dispatched separately (see below) — they
// don't fit one metric pair per the report's findings.
// minScalar note: velocity is a CONSTANT contribution from t=0, so its
// scalar deltas run large (100+); env1/2/3-as-source ramp up from their own
// attack, so by the time they've settled the note is often partway through
// (or the family's window is short) — their deltas measured 5-30x smaller
// than velocity's for the same dest. minScalar is calibrated to the weaker
// env-source case (measured), not velocity's, per family.
const FAMILY_METRIC: Record<Exclude<DestFamily, 'envtime' | 'glide'>, { depth: MetricId; scalar: MetricId; minDepth: number; minScalar: number }> = {
  pitch:   { depth: 'modDepthF0',       scalar: 'medianF0',        minDepth: 5,    minScalar: 40 },
  timbre:  { depth: 'modDepthCentroid', scalar: 'meanCentroidHz',  minDepth: 60,   minScalar: 13 },
  level:   { depth: 'modDepthRms',      scalar: 'rmsDb',           minDepth: 3,    minScalar: 1 },
  filter:  { depth: 'modDepthCentroid', scalar: 'meanCentroidHz',  minDepth: 80,   minScalar: 100 },
  fm:      { depth: 'modDepthCentroid', scalar: 'meanCentroidHz',  minDepth: 25,   minScalar: 5.5 },
  lforate: { depth: 'modDepthCentroid', scalar: 'modRateCentroidHz', minDepth: 8,  minScalar: 1.5 },
};

// LEVEL family cells clip at the default route amount 0.8 (cold-start
// ParamSlot glide overshoot, see header) — dialed back per-dest below.
const ROUTE_AMOUNT: Partial<Record<string, number>> = {
  'osc1.level': 0.25, 'osc2.level': 0.25, 'osc3.level': 0.25, 'noise.level': 0.25,
};
const DEFAULT_AMOUNT = 0.8;

// Per-dest overrides of FAMILY_METRIC's minima, for dests whose real
// response is measurably weaker than the rest of their family (measured
// during the full-grid calibration pass; see header). Filled in only where
// the family default would fail a real, surviving (non-EXPECTED_INERT) cell.
const MIN_DELTA_OVERRIDE: Partial<Record<string, { minDepth?: number; minScalar?: number }>> = {
  // keyTrack's effect on cutoff is a much subtler lever than cutoff itself:
  // lfo1/lfo2 measured 16.9/32.8 (family default 80 fails both); env-owners
  // measured 66-79 (family default 100 fails all three).
  'filter.keyTrack': { minDepth: 8, minScalar: 33 },
  // filter.drive (F1 fix, 2026-07-19): re-baselined off the self-oscillation
  // zone onto the normal-path patch (see baselineFor + synth2.checks.ts).
  // Periodic sources (modDepthCentroid, off-vs-on): lfo1 138.05, lfo2 8.815
  // (weakest — both fully deterministic, repeat-verified), noise worst-seed
  // 26.98 over 60 fresh renders (nondeterministic mod-source RNG, same
  // caveat as elsewhere in this file). minDepth 4 gives lfo2 2.2x, noise's
  // worst seed 6.7x, lfo1 34x. Scalar sources (meanCentroidHz): env1/env2
  // 163.27 (identical — both sit at the same default sustain plateau for
  // most of the held note), env3 40.89 (weakest — env3.s defaults to 0, a
  // smaller sustained drive contribution), velocity 352.34. minScalar 20
  // gives env3 2.04x margin (deterministic — no seed risk), the rest 8-18x.
  // The `on`/hard leg for env1/env2/velocity (a large, CONSTANT drive
  // contribution held for the whole plateau, unlike lfo1/lfo2's oscillating
  // contribution) trips DC_OFFSET — same saturation artifact as the
  // non-matrix filter.drive.dir check; scoped via allowedHealth below, not
  // re-parameterized.
  'filter.drive': { minDepth: 4, minScalar: 20 },
  // resonance's depth response has high seed-to-seed variance for the noise
  // source (30 fresh renders: min 58, median 131, max 198 — 3/30 dipped
  // under the family default 80, the audit's first observed flake) and lfo2
  // sits thin too (85.3, only 1.07x over 80). 25 gives noise's worst seed
  // 2.3x and lfo2 3.4x while staying far above the inert floor (~0-5).
  'filter.resonance': { minDepth: 25 },
};

const solo = (which: 1 | 2 | 3, level: number): Record<string, number> => ({
  'osc1.level': which === 1 ? level : 0,
  'osc2.level': which === 2 ? level : 0,
  'osc3.level': which === 3 ? level : 0,
});

// Baselines engineered so the dest is LIVE. envtime/glide dests never reach
// this function (dispatched separately below).
function baselineFor(dest: string): CheckSpec['baseline'] {
  // --- LEVEL family: solo the tested channel (avoid mixing dilution + the
  // cold-start-glide clip described in the header). ---
  if (dest === 'osc1.level') return synth2Held({ ...solo(1, 0.15), 'filter.cutoff': 1200 });
  if (dest === 'osc2.level') return synth2Held({ ...solo(2, 0.15), 'filter.cutoff': 1200 });
  if (dest === 'osc3.level') return synth2Held({ ...solo(3, 0.15), 'filter.cutoff': 1200 });
  if (dest === 'noise.level') {
    return synth2Held({ 'osc1.level': 0, 'osc2.level': 0, 'osc3.level': 0, 'noise.level': 0.15, 'filter.cutoff': 1200 });
  }

  // --- TIMBRE family: solo the relevant osc (morph/pulseWidth changes were
  // diluted by an unchanged second oscillator in the generic baseline). ---
  if (dest === 'osc1.morph') return synth2Held({ ...solo(1, 0.25), 'filter.cutoff': 1200 });
  if (dest === 'osc2.morph') return synth2Held({ ...solo(2, 0.25), 'filter.cutoff': 1200 });
  if (dest === 'osc3.morph') return synth2Held({ ...solo(3, 0.25), 'filter.cutoff': 1200 });
  if (dest === 'osc1.pulseWidth') return synth2Held({ ...solo(1, 0.25), 'osc1.morph': 3, 'filter.cutoff': 1200 });
  if (dest === 'osc2.pulseWidth') return synth2Held({ ...solo(2, 0.25), 'osc2.morph': 3, 'filter.cutoff': 1200 });
  if (dest === 'osc3.pulseWidth') return synth2Held({ ...solo(3, 0.25), 'osc3.morph': 3, 'filter.cutoff': 1200 });
  if (dest === 'noise.color') {
    return synth2Held({ 'osc1.level': 0, 'osc2.level': 0, 'osc3.level': 0, 'noise.level': 0.3, 'filter.cutoff': 1200 });
  }

  // --- FM family: solo the CARRIER, detune the MODULATOR (fm.osc2 =
  // 'FM 1->2': osc2 is the carrier; fm.osc3 = 'FM 2->3': osc3 is the
  // carrier) — mirrors the calibrated non-matrix fm.osc2.dir/fm.osc3.dir.
  // env3.s:0.4 needed here too (env3->fm.osc3 measured -3.669, below
  // threshold, without it — the universal generic-path fix doesn't reach
  // these dedicated FM baselines; -14.494 with it, comfortable margin). ---
  if (dest === 'fm.osc2') return synth2Held({ ...solo(2, 0.25), 'osc1.coarse': 19, 'filter.cutoff': 1200, 'env3.s': 0.4 });
  if (dest === 'fm.osc3') return synth2Held({ ...solo(3, 0.25), 'osc2.coarse': 19, 'filter.cutoff': 1200, 'env3.s': 0.4 });

  // --- filter.drive (F1 fix, 2026-07-19): drive now saturates the normal
  // (non-oscillating) path too (SvfCore.ts), so this no longer needs the
  // resonance>0.9 self-oscillation-zone engineering (Task 8) — a normal
  // moderate-resonance patch is enough, matching the calibrated non-matrix
  // filter.drive.dir check (synth2.checks.ts). ---
  if (dest === 'filter.drive') {
    return synth2Held({ 'osc1.level': 0.25, 'osc2.level': 0.25, 'osc3.level': 0, 'filter.cutoff': 800, 'filter.resonance': 0.4 });
  }

  // --- filter.morph is BIT-IDENTICAL to classic at filter.model's default
  // (Task 8 finding: MorphFilter.process(m=0) === ClassicFilter's lp branch)
  // — a mod route into it is inert unless filter.model is switched to
  // 'morph' (1) first. ---
  if (dest === 'filter.morph') {
    return synth2Held({ 'osc1.level': 0.1, 'osc2.level': 0.1, 'osc3.level': 0, 'filter.cutoff': 800, 'filter.model': 1, 'env3.s': 0.4 });
  }

  // --- osc3.coarse/osc3.fine: osc3's default level is 0 (silent) — the
  // shared generic osc1/2 levels below never make osc3 audible, so a pitch
  // shift on it is unmeasurable (measured delta 0.000 for every source).
  // Solo osc3 instead of relying on the shared levels. ---
  if (dest === 'osc3.coarse' || dest === 'osc3.fine') {
    return synth2Held({ 'osc1.level': 0, 'osc2.level': 0, 'osc3.level': 0.15, 'filter.cutoff': 1200, 'env3.s': 0.4 });
  }

  // --- generic path: pitch (osc1/2.coarse/fine), filter.cutoff/resonance/
  // keyTrack, lfo1.rate/lfo1.shape/lfo2.rate/lfo2.shape. env3.s:0.4 is a
  // UNIVERSAL fix so env3-as-source tests against any of these dests have
  // something nonzero to contribute during the held sustain (env3.s's
  // descriptor default is 0 — see header). osc1/2.level dialed back from
  // the 0.2/0.2 default to 0.1/0.1: 'noise' routed into filter.cutoff
  // intermittently opened the filter far enough to clip at 0.2/0.2
  // (measured 4-5/30 renders) — 0.1/0.1 measured 0/60 clean, and confirmed
  // NOT to weaken pitch-family deltas (osc1.coarse<-velocity's medianF0
  // delta was bit-identical at both levels: pitch tracking doesn't depend
  // on absolute level once audible). lfo1.shape/lfo2.shape (timbre family)
  // share this branch with lfo1.rate/lfo2.rate: modulating an LFO's OWN
  // shape or rate is only audible if that LFO is ALREADY routed somewhere
  // — the plan's original condition covered only *.rate, leaving every
  // *.shape cell (bar the two self-reference EXPECTED_INERT ones) at a flat
  // 0.000 delta regardless of source. ---
  const params: Record<string, number> = { 'filter.cutoff': 1200, 'env3.s': 0.4, 'osc1.level': 0.1, 'osc2.level': 0.1 };
  const matrix: MatrixRoute[] = [];
  if (dest === 'lfo1.rate' || dest === 'lfo1.shape') { params['lfo1.rate'] = 4; matrix.push({ source: 'lfo1', dest: 'filter.cutoff', amount: 0.7 }); }
  if (dest === 'lfo2.rate' || dest === 'lfo2.shape') { params['lfo2.rate'] = 4; matrix.push({ source: 'lfo2', dest: 'filter.cutoff', amount: 0.7 }); }
  return synth2Held(params, matrix);
}

// --- envtime family (Task 10 header): one bespoke baseline+metric per dest,
// shared across all 8 sources. Some dests use one metric uniformly; others
// split periodic (lfo1/lfo2) vs one-shot (env1/2/3)/velocity sources onto a
// depth vs scalar metric where that measured better. Direction is always
// 'change' (see header). ---
interface EnvUniform { kind: 'uniform'; metric: MetricId; minDelta: number; baseline: EngineRenderSpec }
interface EnvSplit { kind: 'split'; depthMetric: MetricId; minDepth: number; scalarMetric: MetricId; minScalar: number; baseline: EngineRenderSpec }
type EnvSpec = EnvUniform | EnvSplit;

const ENV3_FINE_SOLO = { 'osc1.level': 0.25, 'osc2.level': 0, 'osc3.level': 0 };
const ENV3_FINE_ROUTE: MatrixRoute = { source: 'env3', dest: 'osc1.fine', amount: 0.6 };
const note = (n: string, duration: number, extra: Partial<NoteEvent> = {}): NoteEvent => ({ time: 0, note: n, duration, ...extra });

const ENVTIME_SPEC: Record<string, EnvSpec> = {
  'env1.a': {
    kind: 'split', depthMetric: 'modDepthRms', minDepth: 0.7, scalarMetric: 'rmsDb', minScalar: 0.15,
    baseline: synth2Base({ params: { 'env1.a': 0.25, 'env1.d': 0.3, 'env1.s': 0.4, 'lfo2.rate': 4 },
      notes: [note('A3', 1.0)], seconds: 1.2 }),
  },
  'env1.d': {
    kind: 'split', depthMetric: 'modDepthRms', minDepth: 1.5, scalarMetric: 'rmsDb', minScalar: 1.0,
    baseline: synth2Base({ params: { 'env1.a': 0.01, 'env1.d': 0.35, 'env1.s': 0.05, 'lfo2.rate': 4 },
      notes: [note('A3', 0.43)], seconds: 0.55 }),
  },
  'env1.s': {
    kind: 'split', depthMetric: 'modDepthRms', minDepth: 1.5, scalarMetric: 'rmsDb', minScalar: 0.6,
    baseline: synth2Base({ params: { 'env1.d': 0.15 }, notes: [note('A3', 2.0)], seconds: 2.4 }),
  },
  'env1.r': {
    // uniform: lfo2 is the sole PASSING periodic source (lfo1/noise
    // self-average, see EXPECTED_INERT + header).
    kind: 'uniform', metric: 'decaySeconds', minDelta: 0.02,
    baseline: synth2Base({ params: { 'env1.r': 0.1 }, notes: [note('A3', 0.43)], seconds: 1.8 }),
  },
  'env2.a': {
    // env2.d:0.01, env2.s:1 (F2 recalibration, 2026-07-19, see header): holds
    // env2 at full level after attack instead of decaying back down, so the
    // centroid trajectory isolates the attack-shape effect instead of being
    // dominated by env2's own decay-to-sustain arc.
    kind: 'split', depthMetric: 'modDepthCentroid', minDepth: 8, scalarMetric: 'meanCentroidHz', minScalar: 4.5,
    baseline: synth2Base({ params: { 'filter.cutoff': 300, 'env2.a': 0.15, 'env2.d': 0.01, 'env2.s': 1, 'lfo2.rate': 4 },
      notes: [note('A3', 0.37)], seconds: 0.47 }),
  },
  'env2.d': {
    kind: 'split', depthMetric: 'modDepthCentroid', minDepth: 25, scalarMetric: 'meanCentroidHz', minScalar: 130,
    baseline: synth2Base({ params: { 'filter.cutoff': 300, 'env2.d': 0.33, 'env2.s': 0, 'lfo2.rate': 4 },
      notes: [note('A3', 0.41)], seconds: 0.51 }),
  },
  'env2.s': {
    kind: 'split', depthMetric: 'modDepthCentroid', minDepth: 90, scalarMetric: 'meanCentroidHz', minScalar: 28,
    baseline: synth2Base({ params: { 'filter.cutoff': 300, 'env2.d': 0.15 }, notes: [note('A3', 2.0)], seconds: 2.4 }),
  },
  'env2.r': {
    // uniform: all 8 sources gave a solid meanCentroidHz delta once lfo1's
    // rate was tuned off its release-aliasing default (see header).
    kind: 'uniform', metric: 'meanCentroidHz', minDelta: 7,
    baseline: synth2Base({ params: { 'filter.cutoff': 300, 'filter.envAmount': 4, 'env2.r': 0.15, 'lfo1.rate': 6.1 },
      notes: [note('A3', 0.43)], seconds: 1.8 }),
  },
  'env3.a': {
    kind: 'split', depthMetric: 'modDepthF0', minDepth: 5, scalarMetric: 'medianF0', minScalar: 40,
    baseline: synth2Base({ params: { ...ENV3_FINE_SOLO, 'env3.a': 0.15, 'env3.d': 3, 'lfo2.rate': 2.7 },
      matrix: [ENV3_FINE_ROUTE], notes: [note('A3', 0.23)], seconds: 0.29 }),
  },
  'env3.d': {
    kind: 'split', depthMetric: 'modDepthF0', minDepth: 20, scalarMetric: 'medianF0', minScalar: 30,
    baseline: synth2Base({ params: { ...ENV3_FINE_SOLO, 'env3.a': 0.01, 'env3.d': 0.31, 'env3.s': 0, 'lfo2.rate': 4 },
      matrix: [ENV3_FINE_ROUTE], notes: [note('A3', 0.39)], seconds: 0.49 }),
  },
  'env3.s': {
    // lfo2->env3.s and env3->env3.s (self-ref) are EXPECTED_INERT; lfo1/noise/env1/env2/velocity carry this dest.
    kind: 'split', depthMetric: 'modDepthF0', minDepth: 20, scalarMetric: 'medianF0', minScalar: 40,
    baseline: synth2Base({ params: { ...ENV3_FINE_SOLO, 'env3.d': 0.15 }, matrix: [ENV3_FINE_ROUTE],
      notes: [note('A3', 2.0)], seconds: 2.4 }),
  },
  'env3.r': {
    kind: 'uniform', metric: 'medianF0', minDelta: 3,
    baseline: synth2Base({ params: { ...ENV3_FINE_SOLO, 'env3.r': 0.1 }, matrix: [ENV3_FINE_ROUTE],
      notes: [note('A3', 0.43)], seconds: 1.8 }),
  },
};

// --- glide family: single dest, single metric, tight transition-dominated
// window (see header for why the plan's plateau-heavy render didn't work). ---
const GLIDE_BASELINE: EngineRenderSpec = synth2Base({
  params: { 'osc1.level': 0.25, 'osc2.level': 0, 'osc3.level': 0, 'osc1.morph': 0, 'glide.time': 0.3 },
  notes: [
    { time: 0, note: 'A2', duration: 0.15, mono: true },
    { time: 0.2, note: 'A3', duration: 0.6, mono: true },
  ],
  seconds: 0.85,
});
const GLIDE_METRIC: MetricId = 'medianF0';
const GLIDE_MIN_DELTA = 10;

export function synth2MatrixChecks(fast: boolean): CheckSpec[] {
  const checks: CheckSpec[] = [];
  const inert = new Set(EXPECTED_INERT.map(([s, d]) => `${s}->${d}`));
  const seenFastKey = new Set<string>();

  for (const source of MOD_SOURCES) {
    for (const dest of MOD_DESTS) {
      const id = `synth2.matrix.${source}->${dest}`;
      const family = dest === 'none' ? null : DEST_FAMILY[dest];
      const isInert = source === 'none' || dest === 'none' || inert.has(`${source}->${dest}`);

      // Fast mode: "one dest per family per source" (source:family only —
      // NOT source:family:isInert). EXPECTED_INERT organically grew during
      // calibration (2 -> 18 entries; exactly what the plan calls out as
      // expected), and an isInert-aware key means every family where a
      // source's FIRST-encountered dest and a LATER dest disagree on inert
      // status contributes a second representative — that pushed the fast
      // count to exactly 80 (failing the gate test's <80). One rep per
      // source+family keeps the count comfortably under 80 while still
      // smoke-testing every family x source archetype at least once.
      if (fast && family) {
        const key = `${source}:${family}`;
        if (seenFastKey.has(key)) continue;
        seenFastKey.add(key);
      }

      if (isInert) {
        const healthBaseline: EngineRenderSpec =
          dest === 'none' ? synth2Held()
          : family === 'envtime' ? ENVTIME_SPEC[dest].baseline
          : family === 'glide' ? GLIDE_BASELINE
          : baselineFor(dest);
        // dest === 'none' can't be encoded as a matrix route at all (the
        // Tier-1 renderer's MatrixRoute requires a real PARAM_INDEX dest —
        // the kernel's wire-level "no destination" is destEnc=0, a path this
        // API doesn't expose) — a route with no destination is definitionally
        // a no-op, identical to omitting the route, so just render the plain
        // baseline. source === 'none' with a real dest IS safely encodable:
        // Voice.ts never writes sources[0] ('none' is index 0), so it's a
        // permanent, harmless 0 contribution — include the route for those.
        // Must use the SAME (possibly dialed-back) amount as the live path —
        // LEVEL family clips at the default 0.8 (see header); a health-only
        // cell that ignores ROUTE_AMOUNT would spuriously fail on CLIPPING.
        const inertAmount = ROUTE_AMOUNT[dest] ?? DEFAULT_AMOUNT;
        const extraRoute: MatrixRoute[] = dest === 'none' ? [] : [{ source, dest, amount: inertAmount }];
        checks.push({ id, engine: 'synth2', title: `route ${source} -> ${dest} renders healthily`,
          baseline: { ...healthBaseline, matrix: [...(healthBaseline.matrix ?? []), ...extraRoute] },
          assertion: { kind: 'health' } });
        continue;
      }

      if (family === 'envtime') {
        const spec = ENVTIME_SPEC[dest];
        const periodic = source === 'lfo1' || source === 'lfo2';
        const metric = spec.kind === 'uniform' ? spec.metric : periodic ? spec.depthMetric : spec.scalarMetric;
        const minDelta = spec.kind === 'uniform' ? spec.minDelta : periodic ? spec.minDepth : spec.minScalar;
        checks.push(buildRouteCheck(id, spec.baseline, source, dest, metric, minDelta));
        continue;
      }
      if (family === 'glide') {
        checks.push(buildRouteCheck(id, GLIDE_BASELINE, source, dest, GLIDE_METRIC, GLIDE_MIN_DELTA));
        continue;
      }

      const fam = FAMILY_METRIC[family as Exclude<DestFamily, 'envtime' | 'glide'>];
      const override = MIN_DELTA_OVERRIDE[dest];
      const periodic = source === 'lfo1' || source === 'lfo2' || source === 'noise';
      const metric = periodic ? fam.depth : fam.scalar;
      const minDelta = periodic ? override?.minDepth ?? fam.minDepth : override?.minScalar ?? fam.minScalar;
      const check = buildRouteCheck(id, baselineFor(dest), source, dest, metric, minDelta);
      // noise->noise.color: same brown-noise DC-bias flake documented and
      // scoped for the calibrated non-matrix noise.color.dir check
      // (synth2.checks.ts) — measured ~2.7% of fresh renders there; the
      // directional metric itself is never at risk.
      if (source === 'noise' && dest === 'noise.color') check.allowedHealth = ['DC_OFFSET'];
      // filter.drive (F1 fix, 2026-07-19): a large, CONSTANT drive
      // contribution held for the whole plateau (env1/env2/velocity's `on`/
      // hard leg) saturates through tanh long enough to trip DC_OFFSET —
      // same genuine small artifact as the non-matrix filter.drive.dir check
      // (synth2.checks.ts). lfo1/lfo2/noise/env3 don't hit it in practice
      // (oscillating or weaker contribution), but scoping the whole dest is
      // simpler and harmless — it only widens what health flags are
      // permitted, never relaxes the depth/scalar assertion above.
      if (dest === 'filter.drive') check.allowedHealth = ['DC_OFFSET'];
      checks.push(check);
    }
  }
  return checks;
}

function buildRouteCheck(id: string, baseline: EngineRenderSpec, source: string, dest: string,
    metric: MetricId, minDelta: number): CheckSpec {
  const amount = ROUTE_AMOUNT[dest] ?? DEFAULT_AMOUNT;
  const isVelocity = source === 'velocity';
  return {
    id, engine: 'synth2', title: `route ${source} -> ${dest} moves its family metric`,
    baseline,
    assertion: isVelocity
      ? { kind: 'route', source, dest, amount, compare: 'velocity-pair', metric, direction: 'change', minDelta }
      : { kind: 'route', source, dest, amount, compare: 'off-vs-on', metric, direction: 'change', minDelta },
  };
}
