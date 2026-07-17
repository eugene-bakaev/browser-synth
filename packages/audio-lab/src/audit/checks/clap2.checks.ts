// clap2 audit check table. Descriptor ground truth (packages/shared/src/engines/clap2.ts):
// tone 500-3000 def 1000 · spread 0.005-0.04 def 0.012 · bursts 2-5 def 3 ·
// body 0.002-0.03 def 0.008 · room 0.05-0.8 def 0.25 · mix 0-1 def 0.5 · level 0-1 def 0.8.
//
// CALIBRATED (Task 7, two consecutive `npm run lab:audit` runs, numbers in the
// commit body / task-7-report.md). Deviations from the plan draft:
//  - spread.dir: attackSeconds barely moved (delta -0.010, wrong direction vs
//    the drafted 'up') -> switched to decaySeconds (still direction 'up',
//    minDelta unchanged): wider spread pushes the burst train's last onset
//    later, delaying the -40dB decay crossing (delta +0.065, monotonic across
//    the full 0.006-0.04 sweep).
//  - bursts.dir: attackSeconds never moved (delta 0.000) and neither did the
//    brief's suggested fallback onsetCount (always 1 — inter-burst gaps never
//    dip 10dB below the -45dB onset floor at any spread/body tested, so the
//    fallback's stated assumption doesn't hold for this kernel) -> switched to
//    rmsDb, direction 'up', with an added `mix: 0` override (on top of the
//    draft's `spread: 0.03`) to make the check pure-burst (room tail off):
//    more overlapping-but-not-fully-masking transients raise total energy
//    monotonically (measured at bursts=2..5). Retitled.
//  - room.dir: decaySeconds was null at room=0.7 (the drafted `to` value) in
//    the draft's 1.5s window — the true reverberant tail hadn't crossed -40dB
//    yet. Render window lengthened 1.5s -> 3.0s (confirmed room=0.7 resolves
//    to a stable, window-independent 2.625s at both 3.0s and 4.0s); minDelta
//    raised 0.1 -> 1.0 to match the real magnitude of the effect once
//    correctly measured (delta +2.315, was previously an untested 23x-margin
//    triviality at minDelta 0.1).
//  - No CLIPPING was ever observed on any clap2 leg across all 8 checks in
//    this table (max measured peak -8.776dBFS) — PERC stays
//    ['MOSTLY_SILENT'] only, unlike kick2/snare2. clap2's known aesthetic
//    problem ("doesn't sound like a clap", see BACKLOG) is untouched here —
//    every check below is mechanical correctness, not a timbre judgment.
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
  d('spread.dir', 'wider spread lengthens the measured decay (burst train spans more time)', { kind: 'directional', param: 'spread', from: 0.006, to: 0.038, metric: 'decaySeconds', direction: 'up', minDelta: 0.02 }),
  d('bursts.dir', 'more bursts raise total energy (pure-burst, room off)', { kind: 'directional', param: 'bursts', from: 2, to: 5, metric: 'rmsDb', direction: 'up', minDelta: 1.2 }, { spread: 0.03, mix: 0 }),
  d('body.dir', 'burst body decay audibly changes the envelope', { kind: 'directional', param: 'body', from: 0.003, to: 0.028, metric: 'decaySeconds', direction: 'change', minDelta: 0.02 }, { mix: 0.1 }), // burst-dominant
  d('room.dir', 'room lengthens the reverberant tail', { kind: 'directional', param: 'room', from: 0.08, to: 0.7, metric: 'decaySeconds', direction: 'up', minDelta: 1.0 }, { mix: 0.9 }, 3.0), // room-dominant; needs a 3.0s window to resolve the tail
  d('mix.dir', 'mix moves energy from bursts to room tail', { kind: 'directional', param: 'mix', from: 0.1, to: 0.9, metric: 'decaySeconds', direction: 'up', minDelta: 0.05 }),
  d('level.dir', 'level raises output', { kind: 'directional', param: 'level', from: 0.3, to: 0.8, metric: 'peakDb', direction: 'up', minDelta: 4 }),
];
