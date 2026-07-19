// synth2 non-matrix audit check table. Descriptor ground truth
// (packages/shared/src/engines/synth2-descriptors.ts): osc*.morph 0-3 def 2 ·
// osc*.pulseWidth 0.05-0.95 def 0.5 · osc*.coarse ±36 st def 0 ·
// osc*.fine ±1200 c def 0 (osc2 def 7) · osc*.level 0-1 (osc1/osc2 def 0.8,
// osc3 def 0) · filter.cutoff 20-20000 def 2000 · filter.envAmount -4..4
// def 2.4 · filter.type enum lp|bp|hp · filter.model enum classic|morph ·
// lfo*.rate 0.01-2000 · lfo*.mode enum off|s&h|smooth · env stages
// 0.001-10. Covers all 52 kernel-live synth2 rows except glide.time (Task 9).
// The 18 *.sync/*.div rows are Tier-1 dead slots (main-thread-only; the
// kernel never reads them) -> Task 11 blind-spot registry, not here.
//
// CALIBRATED (Task 8, two consecutive `npm run lab:audit` runs; full numbers
// in the commit body / task-8-report.md). Deviations from the plan draft,
// found by rendering both legs directly (throwaway probes, not committed):
//
//  - osc1.sync.chg -> DEMOTED to `{ kind: 'health', param: 'osc1.sync' }`.
//    Voice.setSync's own comment says it: "osc1.sync is inert — osc1 is the
//    master." Measured delta is exactly 0.000 (bit-identical renders)
//    confirming it. This is a real, permanent no-op, not a calibration miss
//    — flagged for Task 12. The `param` tag (Task 11) tells the completeness
//    meta-test this key HAS a check (just not one that moves a metric), so
//    it isn't forced into the blind-spot registry alongside the genuinely
//    check-less main-thread-derived *.sync/*.div slots.
//  - osc2.sync.chg / osc3.sync.chg: PASS on delta already (margin ~2.4x) but
//    both `to` legs flag DC_OFFSET (~-0.0147, just over the 0.01 threshold).
//    Hard-syncing a detuned slave produces a per-cycle-asymmetric waveform
//    with a small real DC bias — a normal hard-sync artifact, not a bug.
//    Scoped `allowedHealth: ['DC_OFFSET']` to these two checks only.
//  - osc1/osc2/osc3.level.dir: peakDb was dominated by a cold-start
//    transient, not the level knob. ROOT CAUSE: ParamSlot's smoother starts
//    at the COMPILED descriptor default (osc1/osc2.level default = 0.8) and
//    only advances while its Voice is actively rendering (Synth2Kernel
//    gates renderAdd on `voice.active`) — so the very first note played on a
//    freshly-constructed kernel always glides from 0.8 toward the target
//    value over ~5-20ms, regardless of how long applyParams() ran before
//    noteOn(). At low target levels (<=0.4) that onset transient's peak
//    exceeds the sustained level, swamping peakDb. rmsDb (whole-clip energy)
//    is dominated by the ~1.2s sustain instead and scales cleanly with the
//    knob. Swapped metric peakDb -> rmsDb. NOTE for Task 12: this is a real
//    engine behavior, not a test artifact — any brand-new voice (first note
//    of a session, or the first time poly allocation reaches into an unused
//    voice slot) can glide audibly from compiled defaults if the live
//    params differ from them. Worth a follow-up ticket; not fixed here.
//  - fm.osc2.dir / fm.osc3.dir: the plan's routing was backwards. Descriptor
//    labels are explicit — 'FM 1→2' and 'FM 2→3' — so fm.osc2 modulates
//    OSC2 (the slave) using osc1's phase, not the reverse. The original
//    check soloed osc1 and detuned osc2, so the knob swept a channel
//    (osc2) that was mixed at level 0 — no audible effect (delta ~0).
//    Fixed: solo the CARRIER (osc2/osc3) and detune the MODULATOR
//    (osc1/osc2). Range widened 0->3 to 0->4 (full descriptor range) for
//    a comfortable margin.
//  - filter.drive.dir: dead at the default resonance (delta 0.000).
//    SvfCore.tick only applies the tanh(D·x) drive saturator inside the
//    resonance>0.9 self-oscillation zone (see SvfCore.ts comment) — below
//    that, `drive` is read but never used. Moved the check's resonance to
//    0.95 (self-osc zone) with near-zero oscillator levels so the drive
//    knob's effect on the (regulated, cutoff-independent-amplitude)
//    self-oscillation is audible without also stacking oscillator energy
//    into a clip. Real UX note for Task 12: the Drive knob is a total no-op
//    across ~90% of the resonance range; nothing in this task changes that.
//  - filter.model.enum: classic (filter.type default lp) and morph
//    (filter.morph default 0) are BIT-IDENTICAL at their descriptor
//    defaults — MorphFilter.process(m=0) returns `1*svf.low + 0*svf.band`,
//    the same value ClassicFilter's lp branch returns. Not a bug: morph=0
//    is defined as "LP". Added `filter.morph: 2` (HP position) so the two
//    models actually diverge; kept filter.type at its lp default for
//    classic. Also lowered oscillator levels (0.12/0.12) to dodge CLIPPING
//    that showed up at the original 0.2/0.2 + resonance 0.5 combo.
//  - filter.resonance.chg: CLIPPING at resonance>=0.3 with the plan's
//    cutoff=800 + default 0.2/0.2 levels — a classic SVF resonant peak can
//    exceed unity well before the 0.9 self-oscillation boundary; this is
//    expected DSP, not a bug, but the CLIPPING flag isn't scoped here.
//    Instead moved to cutoff=2000, osc1/2.level=0.12 — the sweep is still
//    fully audible (spread 4266Hz on the model check's params; 1071Hz here)
//    with a clean health record.
//  - env2.a.chg / env2.d.dir / env3.a.chg / env3.d.dir: all four were dead
//    or near-dead (deltas 0-27 against minDeltas of 5-150) on the plan's
//    "held" 2-2.4s baseline. Root cause: these knobs shape an ATTACK/DECAY
//    TRAJECTORY, but a long held note spends most of its length at the
//    post-trajectory steady state (sustain), which is identical regardless
//    of how fast the trajectory got there — diluting the averaged metric
//    (meanCentroidHz / medianF0) under a much longer flat segment. Fixed by
//    shortening the note/window so the trajectory itself dominates the
//    average: env2.a.chg -> 0.8s note / 1.0s window; env2.d.dir -> 0.5s
//    note / 0.7s window (env2.s: 0 unchanged); env3.a.chg / env3.d.dir ->
//    1.0s note / 1.2s window (non-held; `held` arg ignored once the
//    baseline's notes/seconds are overridden below, same pattern as the
//    existing kt/rel overrides).
//  - env2.r.chg: correct metric/direction/window already, but margin was
//    only 0.88x. Added `filter.envAmount: 4` (was implicit default 2.4) for
//    a bigger post-release brightness swing (delta 87.6 -> 183.0).
//  - env1.loop.dir: delta was BACKWARDS (-90.3 instead of up) with the
//    plan's `env1.s: 0`. Root cause: modDepth null-filters non-finite
//    (silence-floor) hops and detrends what's left; with s=0 the
//    non-looping leg is almost all silence gated out, leaving only the
//    initial attack+decay hump — a handful of samples a linear detrend
//    fits badly, inflating "depth" far past the looping leg's genuinely
//    periodic (and much better-sampled) pulsing. Fixed with a non-zero
//    sustain (env1.s: 0.2, so the non-loop leg is a flat plateau instead of
//    silence) and a longer 6s note/6.4s window (spreads the one-time
//    attack transient's contribution to the residual over many more loop
//    cycles). allowedHealth left empty — no more MOSTLY_SILENT flag.
//  - noise.level.dir: `from` (noise.level=0, all osc off) legitimately
//    renders MOSTLY_SILENT — there's no way to test a level knob's zero
//    boundary without it. Scoped `allowedHealth: ['MOSTLY_SILENT']`.
//  - env1.d.dir: same MOSTLY_SILENT-at-`from` story (decay=0.05, s=0, held
//    2.4s window — the note is legitimately silent long before the window
//    ends). Scoped `allowedHealth: ['MOSTLY_SILENT']`.
//  - env1.a.dir: `from` (attack=0.001) flagged CLIPPING (2 samples, barely
//    over 0.999) — the cold-start ParamSlot glide (see osc*.level note
//    above) combined with a near-instant attack lets the still-elevated
//    onset level slip through before the smoother settles. Nudged
//    `from` 0.001 -> 0.01 (still a nearly-instant attack for this check's
//    purpose) — clean render, same 0.380s delta.
//  - lfo1.shape.chg / lfo2.shape.chg: shape's response over 0-4 is
//    NON-MONOTONIC (depth dips at shape=2, climbs back by shape=4), so the
//    plan's 0->4 endpoints nearly cancel (delta -18/-12 against minDelta
//    80). Narrowed to 0->2, which brackets the dip cleanly (delta ~-350).
//  - Margin-only fixes (correct metric + direction, but < 2x calibration
//    margin): osc*.coarse.dir minDelta 150->100, osc*.fine.dir 60->50,
//    env1.s.dir 6->5, filter.keyTrack.dir 200->150, filter.envAmount.dir
//    250->200, lfo1/2.rate.dir 3->2.5.
//  - filter.morph.chg (post-review fix): PASSED all along but had no
//    recorded calibration evidence — the one directional check missing
//    from this changelog and the report table. Measured: from(morph=0)
//    1128.94Hz -> to(morph=2) 6321.48Hz, delta 5192.53, clean health both
//    legs, monotonic across 0/0.5/1/1.5/2. Against the original minDelta
//    200 that's a 25.96x margin — the slackest in the whole table, loose
//    enough to hide a regression down to ~4% of the real effect. Raised
//    minDelta 200->1500 (3.46x margin) so the check actually tests
//    something, matching the same "meaningful, not vacuous" judgment
//    applied to filter.model.enum's minSpread above.
//  - No check in this table allows CLIPPING — every clip found during
//    calibration was routed around (lower levels / different cutoff)
//    rather than scoped, since the Global Constraint expects synth2 to stay
//    clean at audit levels. DC_OFFSET (3 checks: 2 hard sync + noise.color,
//    see below) and MOSTLY_SILENT (2 checks, legitimate zero/near-zero
//    boundaries) are scoped, each to exactly the checks that need them.
//  - DISCOVERED: the "Tier-1 renderer is fully deterministic" fact from
//    Tasks 6-7 does NOT hold for any render with noise.level > 0.
//    Synth2Kernel seeds its noise generator from `Math.random()` at
//    construction (per-session entropy, by design). A second `npm run
//    lab:audit` pass flaked exactly one check — noise.color.dir — on a
//    DC_OFFSET health flag that the first pass didn't hit. Measured over
//    300 fresh renders: DC_OFFSET fires on the brown-heavy `from` leg
//    ~2.7% of the time (brown noise's finite-sample mean has real,
//    seed-dependent variance — it's spectrally DC-heavy by definition);
//    the directional metric itself never came close to its margin across
//    the same 300 renders. Scoped `allowedHealth: ['DC_OFFSET']` below —
//    see that override for the full writeup. Everything else in this table
//    keeps noise.level at 0 (seed never reaches the mix) or exercises only
//    LFO mode 0 (Lfo.ts: `mode<=0` is the deterministic periodic path,
//    S&H/Smooth's RNG is untouched), so it stays exactly as deterministic
//    as Tasks 6-7 assumed.
//
// RECALIBRATED (F2 fix, 2026-07-19, audit-fix campaign Task 2; two
// consecutive `npm run lab:audit` runs, both fully green): Voice.noteOn now
// snaps every ParamSlot to its target on a cold voice instead of gliding
// from the compiled default over ~5ms (ParamSlot.ts / Voice.ts). Two checks
// in this table had, without realizing it, calibrated around that removed
// transient:
//  - noise.level.dir: `from`=0 (noise.level=0, all osc off) used to render a
//    quiet-but-nonzero residual (the old osc-level cold-start blip fading
//    out), which is exactly why it needed `allowedHealth: ['MOSTLY_SILENT']`
//    — see the now-obsolete note this replaces, just above. Post-fix, that
//    same config is REAL digital silence (rmsDb -> null, not just quiet),
//    so the check no longer has a valid `from` reading at all. Moved `from`
//    0 -> 0.01: renders clean (no health flags), rmsDb -53.35dB; `to`=0.35
//    still -22.63dB (unchanged); delta 30.72 vs minDelta 6 (5.1x margin).
//    allowedHealth scoping removed — no longer needed.
//  - env1.a.dir: `to`=0.4 used to register a non-null attackSeconds because
//    env1.a's OWN ParamSlot also glided from the compiled (fast) default for
//    its first ~5-20ms, giving the envelope an artificially quick initial
//    climb that happened to satisfy envelope.ts's onset detector (a hop must
//    jump from below -55dB to above -45dB in one 5ms step — see envelope.ts
//    ONSET_ON_DB/ONSET_OFF_DB). Post-fix, a genuinely linear 0.4s attack
//    ramps too smoothly through that 10dB gray zone for any single 5ms hop
//    to span it, so attackSeconds comes back null (onsets: []) — confirmed
//    by direct probing (packages/audio-lab, ad hoc renders): attack values
//    0.01-0.15s all register cleanly, 0.16s+ do not (hard cliff, not a soft
//    threshold). Moved `to` 0.4 -> 0.12 (safe margin below the 0.16 cliff)
//    and minDelta 0.15 -> 0.04 to match: measured attackSeconds 0.025 (from)
//    -> 0.12 (to), delta 0.095, vs minDelta 0.04 (2.4x margin).
//  - synth2.matrix.lfo2->env2.a (synth2-matrix.ts): also recalibrated in
//    this pass — see that file's header for the writeup (the shared
//    ENVTIME_SPEC['env2.a'] baseline picked up env2.d/env2.s overrides that
//    also raised every OTHER env2.a-routed source's margin, verified by
//    direct probing before committing).
import type { CheckSpec } from '../types';
import type { MetricId } from '../types';
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

const LFO1_CUT = [{ source: 'lfo1', dest: 'filter.cutoff', amount: 0.8 }];
const LFO2_CUT = [{ source: 'lfo2', dest: 'filter.cutoff', amount: 0.8 }];
const ENV3_FINE = [{ source: 'env3', dest: 'osc1.fine', amount: 0.8 }];

export const synth2Checks: CheckSpec[] = [
  // --- oscillator 1 (solo) ---
  c('osc1.morph.dir', 'morph sweeps to a brighter shape', dir('osc1.morph', 0, 3, 'meanCentroidHz', 'up', 200), solo1),
  c('osc1.pulseWidth.dir', 'narrow pulse is brighter', dir('osc1.pulseWidth', 0.5, 0.08, 'meanCentroidHz', 'up', 150), { ...solo1, 'osc1.morph': 3 }),
  c('osc1.coarse.dir', '+12 st doubles f0', dir('osc1.coarse', 0, 12, 'medianF0', 'up', 100), solo1),
  c('osc1.fine.dir', '+700 c raises f0 ~1.5x', dir('osc1.fine', 0, 700, 'medianF0', 'up', 50), solo1),
  c('osc1.level.dir', 'level raises output (rmsDb — peakDb is swamped by the cold-start ParamSlot glide, see header)', dir('osc1.level', 0.05, 0.25, 'rmsDb', 'up', 4), { 'osc2.level': 0, 'osc3.level': 0 }),
  // osc1.sync is inert by design — osc1 is the master oscillator and is
  // never reset by a sync target (Voice.setSync doc comment). Measured
  // delta is exactly 0.000 (bit-identical renders). Health-only per plan.
  c('osc1.sync.chg', 'osc1 hard sync is a documented no-op (osc1 is the master, never a sync slave)', { kind: 'health', param: 'osc1.sync' }, { ...solo1, 'osc1.coarse': 7 }),
  // --- oscillator 2 / 3 (solo; same shapes as osc1) ---
  c('osc2.morph.dir', 'morph sweeps brighter', dir('osc2.morph', 0, 3, 'meanCentroidHz', 'up', 200), solo2),
  c('osc2.pulseWidth.dir', 'narrow pulse brighter', dir('osc2.pulseWidth', 0.5, 0.08, 'meanCentroidHz', 'up', 150), { ...solo2, 'osc2.morph': 3 }),
  c('osc2.coarse.dir', '+12 st doubles f0', dir('osc2.coarse', 0, 12, 'medianF0', 'up', 100), { ...solo2, 'osc2.fine': 0 }),
  c('osc2.fine.dir', '+700 c raises f0', dir('osc2.fine', 0, 700, 'medianF0', 'up', 50), solo2),
  c('osc2.level.dir', 'level raises output (rmsDb, see osc1.level.dir)', dir('osc2.level', 0.05, 0.25, 'rmsDb', 'up', 4), { 'osc1.level': 0, 'osc3.level': 0 }),
  // osc2.sync legitimately produces a small DC bias (asymmetric per-cycle
  // waveform from hard-syncing a detuned slave) — a normal hard-sync
  // artifact, not a bug. Scoped, not blanket (see header).
  c('osc2.sync.chg', 'hard sync vs free detuned osc2', dir('osc2.sync', 0, 1, 'meanCentroidHz', 'change', 100), { ...solo2, 'osc2.coarse': 7 }),
  c('osc3.morph.dir', 'morph sweeps brighter', dir('osc3.morph', 0, 3, 'meanCentroidHz', 'up', 200), solo3),
  c('osc3.pulseWidth.dir', 'narrow pulse brighter', dir('osc3.pulseWidth', 0.5, 0.08, 'meanCentroidHz', 'up', 150), { ...solo3, 'osc3.morph': 3 }),
  c('osc3.coarse.dir', '+12 st doubles f0', dir('osc3.coarse', 0, 12, 'medianF0', 'up', 100), solo3),
  c('osc3.fine.dir', '+700 c raises f0', dir('osc3.fine', 0, 700, 'medianF0', 'up', 50), solo3),
  c('osc3.level.dir', 'level raises output (rmsDb, see osc1.level.dir)', dir('osc3.level', 0.05, 0.25, 'rmsDb', 'up', 4), { 'osc1.level': 0, 'osc2.level': 0 }),
  c('osc3.sync.chg', 'hard sync vs free detuned osc3', dir('osc3.sync', 0, 1, 'meanCentroidHz', 'change', 100), { ...solo3, 'osc3.coarse': 7 }),
  // --- noise + FM ---
  // `from` moved 0 -> 0.01 (F2 recalibration, 2026-07-19, see header): with
  // the cold-start ParamSlot glide fixed, noise.level=0 + all osc off is
  // real digital silence (rmsDb -> null, not just quiet) instead of the old
  // transient's residual near-silent hum. 0.01 renders clean (no health
  // flags) at rmsDb -53.35dB; measured delta to the `to` leg (0.35 ->
  // -22.63dB) is 30.72, vs minDelta 6 (5.1x margin).
  c('noise.level.dir', 'noise level raises output', dir('noise.level', 0.01, 0.35, 'rmsDb', 'up', 6), { 'osc1.level': 0, 'osc2.level': 0, 'osc3.level': 0 }),
  c('noise.color.dir', 'color morphs dark to bright', dir('noise.color', 0.1, 0.9, 'meanCentroidHz', 'up', 800), noiseSolo),
  // fm.osc2 = 'FM 1→2' (osc1 modulates osc2, the descriptor label is
  // explicit) — solo the CARRIER (osc2) and detune the MODULATOR (osc1).
  // Range widened to the full 0-4 for a comfortable margin (see header).
  c('fm.osc2.dir', 'osc1->osc2 FM adds sidebands (fm.osc2 = "FM 1→2": osc2 is the carrier)', dir('fm.osc2', 0, 4, 'meanCentroidHz', 'up', 150), { ...solo2, 'osc1.coarse': 19 }),
  c('fm.osc3.dir', 'osc2->osc3 FM adds sidebands (fm.osc3 = "FM 2→3": osc3 is the carrier)', dir('fm.osc3', 0, 4, 'meanCentroidHz', 'up', 150), { ...solo3, 'osc2.coarse': 19 }),
  // --- env1 (amp) ---
  // from=0.01 not 0.001: the descriptor minimum combined with the cold-start
  // ParamSlot glide (see header) clips 2 samples; 0.01 is still a
  // near-instant attack for this check and renders clean.
  // `to` moved 0.4 -> 0.12 (F2 recalibration, 2026-07-19, see header): the
  // onset detector (envelope.ts) needs a hop (5ms) to see the signal jump
  // from below -55dB to above -45dB in one step; a real (post-fix) linear
  // attack ramp only clears that gap fast enough for attackSeconds to
  // register non-null up to ~0.15s at this baseline's levels (measured
  // cliff: 0.15 registers, 0.16 does not). 0.12 keeps a safe margin below
  // that cliff. minDelta lowered 0.15 -> 0.04 to match: measured attackSeconds
  // 0.025 (from) -> 0.12 (to), delta 0.095, vs minDelta 0.04 (2.4x margin).
  c('env1.a.dir', 'attack knob slows the attack', dir('env1.a', 0.01, 0.12, 'attackSeconds', 'up', 0.04), {}, true),
  c('env1.d.dir', 'decay knob lengthens decay (s=0)', dir('env1.d', 0.05, 1.0, 'decaySeconds', 'up', 0.3), { 'env1.s': 0 }, true),
  c('env1.s.dir', 'sustain raises held level', dir('env1.s', 0.05, 0.9, 'rmsDb', 'up', 5), { 'env1.d': 0.15 }, true),
  c('env1.r.rel', 'release lengthens the tail', dir('env1.r', 0.05, 1.2, 'decaySeconds', 'up', 0.3),
    {}, false), // gate 0.5 in a 1.2s window: tail dominates the decay measurement
  // --- env2 (filter; envAmount 2.4 default, dark base cutoff) ---
  // env2.a/d.dir: a "held" 2-2.4s note dilutes the attack/decay TRAJECTORY
  // under a much longer post-trajectory steady state — shortened note/window
  // below (post-array) so the trajectory itself dominates meanCentroidHz.
  c('env2.a.chg', 'filter-env attack shifts brightness over time', dir('env2.a', 0.001, 0.8, 'meanCentroidHz', 'change', 35), { 'filter.cutoff': 300 }, true),
  c('env2.d.dir', 'filter-env decay keeps it bright longer', dir('env2.d', 0.05, 1.0, 'meanCentroidHz', 'up', 150), { 'filter.cutoff': 300, 'env2.s': 0 }, true),
  c('env2.s.dir', 'filter-env sustain holds brightness', dir('env2.s', 0, 1, 'meanCentroidHz', 'up', 200), { 'filter.cutoff': 300 }, true),
  // filter.envAmount bumped 2.4(default)->4 for a bigger post-release swing
  // (delta 87.6->183.0); short-gate/long-window override is post-array.
  c('env2.r.chg', 'filter-env release shapes the tail', dir('env2.r', 0.05, 1.2, 'meanCentroidHz', 'change', 80), { 'filter.cutoff': 300, 'filter.envAmount': 4 }),
  // --- filter ---
  c('filter.cutoff.dir', 'cutoff darkens when lowered', dir('filter.cutoff', 8000, 300, 'meanCentroidHz', 'down', 800)),
  // resonance.chg moved to cutoff=2000 + lower osc levels: the plan's
  // cutoff=800/default levels clip at resonance>=0.3 (a genuine SVF
  // resonant-peak overshoot, not a bug) — see header.
  c('filter.resonance.chg', 'resonance reshapes the spectrum', dir('filter.resonance', 0, 0.9, 'meanCentroidHz', 'change', 450), { 'filter.cutoff': 2000, 'osc1.level': 0.12, 'osc2.level': 0.12, 'osc3.level': 0 }),
  c('filter.keyTrack.dir', 'keytrack opens the filter on a high note', dir('filter.keyTrack', 0, 1, 'meanCentroidHz', 'up', 150),
    { 'filter.cutoff': 300 }), // note override below
  c('filter.envAmount.dir', 'env amount opens the filter', dir('filter.envAmount', 0, 4, 'meanCentroidHz', 'up', 200), { 'filter.cutoff': 300 }),
  // drive is a no-op outside the resonance>0.9 self-oscillation zone
  // (SvfCore only applies its tanh saturator there) — moved into that zone
  // with near-zero oscillator levels so drive's effect on the regulated
  // self-oscillation is audible without stacking a separate clip source.
  c('filter.drive.dir', 'drive adds harmonics (self-oscillation zone — drive is a no-op below resonance 0.9, see header)', dir('filter.drive', 0, 1, 'meanCentroidHz', 'up', 120), { 'filter.cutoff': 800, 'filter.resonance': 0.95, 'osc1.level': 0.1, 'osc2.level': 0.1, 'osc3.level': 0 }),
  c('filter.type.enum', 'lp/bp/hp are audible and spectrally ordered',
    { kind: 'enum', param: 'filter.type', values: [0, 1, 2], minPeakDb: -40, distinct: { metric: 'meanCentroidHz', minSpread: 600 } },
    { 'filter.cutoff': 800 }),
  // classic (type=lp default) and morph (morph=0 default) are BIT-IDENTICAL
  // at their descriptor defaults — MorphFilter.process(m=0) === svf.low,
  // same as ClassicFilter's lp branch. filter.morph:2 (HP position) makes
  // the two models actually diverge; levels lowered to dodge CLIPPING.
  c('filter.model.enum', 'classic vs morph model both sound (morph:2 so they diverge — both are identical at morph:0, see header)',
    { kind: 'enum', param: 'filter.model', values: [0, 1], minPeakDb: -40, distinct: { metric: 'meanCentroidHz', minSpread: 1500 } },
    { 'filter.cutoff': 800, 'filter.resonance': 0.5, 'filter.morph': 2, 'osc1.level': 0.12, 'osc2.level': 0.12, 'osc3.level': 0 }),
  // minDelta 200->1500 (post-review fix): measured delta 5192.53 gave a
  // 25.96x margin, the slackest in the table — high enough to hide a
  // regression down to ~4% of the real effect. 1500 keeps a comfortable
  // 3.46x margin while actually testing something (see header changelog).
  c('filter.morph.chg', 'morph-model sweep reshapes the spectrum', dir('filter.morph', 0, 2, 'meanCentroidHz', 'change', 1500), { 'filter.model': 1, 'filter.cutoff': 800 }),
  // --- LFOs (audible only through a route) ---
  c('lfo1.rate.dir', 'lfo1 rate speeds the wobble', dir('lfo1.rate', 0.5, 6, 'modRateCentroidHz', 'up', 2.5), { 'filter.cutoff': 1200 }, true, LFO1_CUT),
  // shape's depth response over 0-4 is NON-monotonic (dips at shape=2,
  // climbs back by shape=4) — the plan's 0->4 endpoints nearly cancel.
  // Narrowed to 0->2, which brackets the dip (delta ~-350 vs -18).
  c('lfo1.shape.chg', 'lfo1 shape changes the wobble contour (0->2: shape response dips then recovers by 4, see header)', dir('lfo1.shape', 0, 2, 'modDepthCentroid', 'change', 150), { 'filter.cutoff': 1200, 'lfo1.rate': 4 }, true, LFO1_CUT),
  c('lfo2.rate.dir', 'lfo2 rate speeds the wobble', dir('lfo2.rate', 0.5, 6, 'modRateCentroidHz', 'up', 2.5), { 'filter.cutoff': 1200 }, true, LFO2_CUT),
  c('lfo2.shape.chg', 'lfo2 shape changes the wobble contour (0->2, see lfo1.shape.chg)', dir('lfo2.shape', 0, 2, 'modDepthCentroid', 'change', 150), { 'filter.cutoff': 1200, 'lfo2.rate': 4 }, true, LFO2_CUT),
  c('lfo1.mode.enum', 'off/s&h/smooth all render healthily',
    { kind: 'enum', param: 'lfo1.mode', values: [0, 1, 2], minPeakDb: -40 },
    { 'lfo1.rate': 2 }, true, [{ source: 'lfo1', dest: 'osc1.fine', amount: 0.5 }]),
  c('lfo2.mode.enum', 'off/s&h/smooth all render healthily',
    { kind: 'enum', param: 'lfo2.mode', values: [0, 1, 2], minPeakDb: -40 },
    { 'lfo2.rate': 2 }, true, [{ source: 'lfo2', dest: 'osc1.fine', amount: 0.5 }]),
  // --- env3 (mod env; audible via env3->osc1.fine) ---
  // a/d.chg|dir: same held-note dilution as env2.a/d — shortened note/window
  // below (post-array) so the attack/decay trajectory dominates medianF0.
  c('env3.a.chg', 'mod-env attack shifts the pitch trajectory', dir('env3.a', 0.01, 0.8, 'medianF0', 'change', 60), solo1, true, ENV3_FINE),
  c('env3.d.dir', 'mod-env decay holds the offset longer', dir('env3.d', 0.05, 1.0, 'medianF0', 'up', 50), { ...solo1, 'env3.a': 0.001, 'env3.s': 0 }, true, ENV3_FINE),
  c('env3.s.dir', 'mod-env sustain sustains the offset', dir('env3.s', 0, 1, 'medianF0', 'up', 12), { ...solo1, 'env3.a': 0.001 }, true, ENV3_FINE),
  c('env3.r.chg', 'mod-env release shapes the pitch tail', dir('env3.r', 0.05, 1.2, 'medianF0', 'change', 4), { ...solo1, 'env3.s': 0.8 }, false, ENV3_FINE),
  // --- env loops ---
  // env1.loop.dir: s=0 made the non-loop leg near-total silence, which
  // modDepth's null-filtering + linear detrend badly mis-measured as MORE
  // "depth" than the genuinely-periodic looping leg (backwards delta). s:0.2
  // gives a flat (not silent) non-loop plateau; 6s window spreads the
  // one-time attack transient's weight across many more loop cycles.
  c('env1.loop.dir', 'looping amp env pulses the level', dir('env1.loop', 0, 1, 'modDepthRms', 'up', 2), { 'env1.d': 0.15, 'env1.s': 0.2 }, true),
  c('env2.loop.dir', 'looping filter env pulses brightness', dir('env2.loop', 0, 1, 'modDepthCentroid', 'up', 80), { 'filter.cutoff': 400, 'env2.d': 0.2, 'env2.s': 0 }, true),
  c('env3.loop.dir', 'looping mod env pulses pitch', dir('env3.loop', 0, 1, 'modDepthF0', 'up', 8), { ...solo1, 'env3.d': 0.2, 'env3.s': 0 }, true, ENV3_FINE),
];

// --- baseline tweaks the c()/held helper can't express (notes/seconds
// overrides, or allowedHealth scoping) — applied directly after the array
// literal, same pattern as the original kt/rel/rel2/rel3 overrides. ---
const find = (id: string): CheckSpec => synth2Checks.find((x) => x.id === id)!;

// keytrack check must play a HIGH note for tracking to matter:
const kt = find('synth2.filter.keyTrack.dir');
kt.baseline = { ...kt.baseline, notes: [{ time: 0, note: 'C5', duration: 0.5 }] };
// env1.r release check: short gate, long window, so the tail IS the decay:
const rel = find('synth2.env1.r.rel');
rel.baseline = { ...rel.baseline, notes: [{ time: 0, note: 'A3', duration: 0.5 }], seconds: 2.2 };
const rel2 = find('synth2.env2.r.chg');
rel2.baseline = { ...rel2.baseline, notes: [{ time: 0, note: 'A3', duration: 0.5 }], seconds: 2.2 };
const rel3 = find('synth2.env3.r.chg');
rel3.baseline = { ...rel3.baseline, notes: [{ time: 0, note: 'A3', duration: 0.5 }], seconds: 2.2 };

// env2.a.chg / env2.d.dir: short note+window so the attack/decay TRAJECTORY
// (not the much-longer post-trajectory steady state) dominates meanCentroidHz.
const env2a = find('synth2.env2.a.chg');
env2a.baseline = { ...env2a.baseline, notes: [{ time: 0, note: 'A3', duration: 0.8 }], seconds: 1.0 };
const env2d = find('synth2.env2.d.dir');
env2d.baseline = { ...env2d.baseline, notes: [{ time: 0, note: 'A3', duration: 0.5 }], seconds: 0.7 };

// env3.a.chg / env3.d.dir: same trajectory-dilution fix as env2 above.
const env3a = find('synth2.env3.a.chg');
env3a.baseline = { ...env3a.baseline, notes: [{ time: 0, note: 'A3', duration: 1.0 }], seconds: 1.2 };
const env3d = find('synth2.env3.d.dir');
env3d.baseline = { ...env3d.baseline, notes: [{ time: 0, note: 'A3', duration: 1.0 }], seconds: 1.2 };

// env1.loop.dir: 6s held note so the one-time attack transient's weight in
// the modDepth residual is spread across many more loop cycles.
const loop1 = find('synth2.env1.loop.dir');
loop1.baseline = { ...loop1.baseline, notes: [{ time: 0, note: 'A3', duration: 6 }], seconds: 6.4 };

// DC_OFFSET is a genuine, small (~-0.0147) hard-sync artifact — scoped to
// exactly the two checks that hard-sync a detuned slave.
find('synth2.osc2.sync.chg').allowedHealth = ['DC_OFFSET'];
find('synth2.osc3.sync.chg').allowedHealth = ['DC_OFFSET'];

// MOSTLY_SILENT is expected at this legitimate zero/near-zero boundary.
// (noise.level.dir's own MOSTLY_SILENT scoping was removed in the F2
// recalibration above: `from` moved 0 -> 0.01, which renders clean.)
find('synth2.env1.d.dir').allowedHealth = ['MOSTLY_SILENT'];

// noise.color.dir: DISCOVERED NON-DETERMINISM. Synth2Kernel seeds its noise
// generator from `Math.random()` at construction (per-session entropy, by
// design — see Noise.ts / Lfo.ts doc comments), so every render() call gets
// a genuinely different noise realization — the Tier-1 "fully deterministic"
// assumption (Tasks 6-7) does NOT hold for any check with noise.level > 0.
// Measured over 300 fresh renders of this check's `from` leg (brown-heavy
// color=0.1): DC_OFFSET fires 8/300 (~2.7%) — brown noise's finite-sample
// mean has real, seed-dependent variance (it's spectrally DC-heavy by
// definition), occasionally crossing the fixed 0.01 flag threshold by
// chance. The directional metric itself is NOT at risk (meanCentroidHz
// delta measured 3256-3358 across the same 300 renders, vs minDelta 800 —
// nowhere near the boundary). Scoped, not re-parameterized: there is no
// (from, to) pair that makes brown noise's DC bias zero-probability.
find('synth2.noise.color.dir').allowedHealth = ['DC_OFFSET'];
