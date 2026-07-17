// hat2 audit check table. Descriptor ground truth (packages/shared/src/engines/hat2.ts):
// tone 3000-14000 def 9000 · decay 0.02-0.8 def 0.08 · hpf 3000-12000 def 7000 ·
// metallic 0-1 def 0.7 · ring 0-1 def 0.2 · level 0-1 def 0.8.
//
// CALIBRATED (Task 7, two consecutive `npm run lab:audit` runs, numbers in the
// commit body / task-7-report.md). Deviations from the plan draft:
//  - fingerprint.peak: measured peakDb = -16.784 (deterministic) at the default
//    patch, below the drafted `min: -15` -> lowered to -18. Not a clipping
//    issue (health flags = [MOSTLY_SILENT] only, no CLIPPING) — hat2's default
//    level=0.8 patch is simply quieter than the draft assumed.
//  - ring.dir: decaySeconds barely moved (delta 0.015 vs minDelta 0.03, <1x
//    margin) -> switched to meanCentroidHz, direction 'down' (not the generic
//    'change' the draft used elsewhere): ring-mod between two cluster members
//    adds low sum/difference-tone energy that pulls the averaged centroid down
//    monotonically as ring rises 0->1 (measured at all 5 sampled points).
//    Retitled to describe what's actually asserted.
//  - No CLIPPING was ever observed on any hat2 leg across all 8 checks in this
//    table (max measured peak -7.585dBFS at ring=1) — PERC stays
//    ['MOSTLY_SILENT'] only, unlike kick2/snare2.
import type { CheckSpec } from '../types';
import { drumBase } from './baselines';

const PERC = ['MOSTLY_SILENT']; // hat2 default decay is ~0.08s — flags by design
const d = (id: string, title: string, a: CheckSpec['assertion'], params: Record<string, number> = {}, seconds = 1.2): CheckSpec => ({
  id: `hat2.${id}`, engine: 'hat2', title, baseline: drumBase('hat2', params, seconds),
  assertion: a, allowedHealth: PERC,
});

export const hat2Checks: CheckSpec[] = [
  d('fingerprint.peak', 'default hit is audible', { kind: 'absolute', metric: 'peakDb', min: -18, max: 0 }),
  d('fingerprint.bright', 'default hat is HF-dominant', { kind: 'absolute', metric: 'bandHi', min: 0.6 }),
  d('tone.dir', 'tone brightens the metal band', { kind: 'directional', param: 'tone', from: 4000, to: 13000, metric: 'meanCentroidHz', direction: 'up', minDelta: 500 }),
  d('decay.dir', 'decay knob lengthens the tail', { kind: 'directional', param: 'decay', from: 0.03, to: 0.6, metric: 'decaySeconds', direction: 'up', minDelta: 0.1 }, {}, 1.5),
  d('hpf.dir', 'hpf removes body from below', { kind: 'directional', param: 'hpf', from: 3000, to: 11000, metric: 'meanCentroidHz', direction: 'up', minDelta: 400 }),
  d('metallic.dir', 'metallic reshapes the partial mix', { kind: 'directional', param: 'metallic', from: 0, to: 1, metric: 'meanCentroidHz', direction: 'change', minDelta: 200 }),
  d('ring.dir', 'ring pulls the spectral centroid down (ring-mod sum/difference energy)', { kind: 'directional', param: 'ring', from: 0, to: 1, metric: 'meanCentroidHz', direction: 'down', minDelta: 600 }, { decay: 0.3 }, 1.5),
  d('level.dir', 'level raises output', { kind: 'directional', param: 'level', from: 0.3, to: 0.8, metric: 'peakDb', direction: 'up', minDelta: 4 }),
];
