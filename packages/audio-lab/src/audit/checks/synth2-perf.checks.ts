// synth2 tuning, glide, voice allocation, and fingerprint checks (Task 9).
// Complements synth2.checks.ts (the 51-check knob table): this table covers
// the four things a knob-sweep table can't — absolute pitch accuracy,
// portamento timing via pitchSettle, mono/poly voice-allocation behavior, and
// two "does the patch sound like synth2" fingerprints (the audit-levels
// patch and the TRUE descriptor-default patch, which legitimately clips the
// raw kernel — see baselines.ts header).
//
// CALIBRATED (Task 9, two consecutive `npm run lab:audit` runs; full numbers
// in the commit body / task-9-report.md).
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
  // poly-snaps: note1 and note2 land on DIFFERENT voices (poly), so unlike
  // the mono checks above, note1's voice keeps ringing through its own
  // release tail while note2 renders — the two additively mix in the
  // output. At the default env1.r=0.5s, note1 (gate off at 0.45s, released
  // from ~sustain 0.5) is still audibly present for ~450ms after note2's
  // 0.5s onset, and the pitch tracker locks onto the mix rather than
  // note2's tone alone: measured settle 0.400s (vs the expected near-0),
  // FAILing against tol 0.05s. This is a real overlap artifact of two
  // independent poly voices ringing together, not a glide/allocation bug —
  // confirmed by giving note1 a fast release (env1.r 0.5->0.05s) so its
  // voice is silent well before note2's window is measured: settle then
  // reads 0.000s, matching the mono-instant baseline exactly.
  { ...glide('poly-snaps', 0.001, 0.05, false, 'poly ignores glide even with knob at 300ms'),
    baseline: (() => { const b = glide('x', 0.001, 0.05, false, '').baseline;
      return { ...b, params: { ...b.params, 'glide.time': 0.3, 'env1.r': 0.05 } }; })() },
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
  // audit-patch peakDb: the plan's placeholder -24..-3 window undershot the
  // real value — measured -2.945dB, just over the -3 ceiling. ROOT CAUSE:
  // the same cold-start ParamSlot glide documented in synth2.checks.ts
  // (osc1/osc2.level.dir header) — a fresh kernel's very first note glides
  // from the COMPILED default (osc1/osc2.level = 0.8) toward the configured
  // 0.2 over ~5-20ms, so the onset transient peaks much louder than the
  // 0.2/0.2 sustained level would alone. Real, already-documented engine
  // behavior, not a bug. Recalibrated min/max to measured ±6dB (per plan).
  { id: 'synth2.fingerprint.audit-patch', engine: 'synth2', title: 'audit patch fingerprint',
    baseline: synth2Base({}), assertion: { kind: 'absolute', metric: 'peakDb', min: -9, max: 3 } },
  // meanCentroidHz: measured 2180.8Hz sat comfortably inside the plan's
  // broad 300-4000 placeholder (margins +1880/-1819) — recalibrated to
  // measured ±40% (per plan) so the window actually pins the fingerprint
  // instead of just confirming "it's audio-shaped".
  { id: 'synth2.fingerprint.default-centroid', engine: 'synth2', title: 'audit patch centroid window',
    baseline: synth2Base({}), assertion: { kind: 'absolute', metric: 'meanCentroidHz', min: 1308, max: 3053 } },
  { id: 'synth2.fingerprint.true-defaults', engine: 'synth2', title: 'true default patch (raw kernel clips: known)',
    baseline: { engine: 'synth2', notes: [{ time: 0, note: 'A3', duration: 0.5 }], seconds: 1.2 },
    assertion: { kind: 'absolute', metric: 'peakDb', min: 0, max: 8 },
    allowedHealth: ['CLIPPING'] },
];
