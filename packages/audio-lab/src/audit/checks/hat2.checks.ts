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
//
// F4 (Task 4, 2026-07-19): the ring branch used to crossfade the 6-square
// cluster average toward a raw ±1 ring-mod product — inherently much louder,
// so `ring` rode overall level (+7.28dB peak ring 0->1) more than it changed
// timbre. Fixed in Hat2Kernel.ts with a RING_TRIM=0.40 level-match constant.
// Consequences for this table:
//  - fingerprint.peak (default patch, ring=0.2): measured peakDb dropped from
//    -16.784 to -17.427 (the ring branch's default 0.2-weighted contribution
//    is now trimmed too) -> margin against `min: -18` thinned from 1.216dB to
//    0.573dB. Lowered min to -18.5 to restore a ~1dB margin.
//  - ring.dir: level-matching the two ring.dir legs necessarily shrinks the
//    centroid swing between them too — most of the old -1541.6Hz drop was
//    driven by the raw ring-mod branch's disproportionate loudness dominating
//    the mix, not a pure timbral effect. Post-trim measured delta is only
//    -189.2Hz (ring=0 11427.4Hz -> ring=1 11238.2Hz, decay=0.3, 1.5s) — still
//    reliably 'down' but far smaller. minDelta recalibrated 600 -> 80 (>=2x
//    margin per the calibration rule: 189.2/80 = 2.36x). The timbral change
//    itself is NOT gone — Hat2Kernel.test.ts's metallic=1 rmsDiff check
//    (isolated cluster, no noise dilution) measures 0.0247, ~25x its 1e-3
//    floor — it's just that the DEFAULT patch's 30% noise floor (metallic
//    0.7) now dilutes the ring-mod's centroid contribution much more once its
//    amplitude no longer dominates.
//  - ring.levelride (new): direct regression net for the fixed defect — pins
//    ring=1's peakDb into [-15.84, -11.84] (measured -13.845 +/- 2dB) so the
//    +7.3dB ride can't silently come back.
//  - New max measured peak across this table is -13.845dBFS (ring=1,
//    ring.dir/ring.levelride's shared baseline) — was -7.585dBFS pre-fix.
import type { CheckSpec } from '../types';
import { drumBase } from './baselines';

const PERC = ['MOSTLY_SILENT']; // hat2 default decay is ~0.08s — flags by design
const d = (id: string, title: string, a: CheckSpec['assertion'], params: Record<string, number> = {}, seconds = 1.2): CheckSpec => ({
  id: `hat2.${id}`, engine: 'hat2', title, baseline: drumBase('hat2', params, seconds),
  assertion: a, allowedHealth: PERC,
});

export const hat2Checks: CheckSpec[] = [
  d('fingerprint.peak', 'default hit is audible', { kind: 'absolute', metric: 'peakDb', min: -18.5, max: 0 }),
  d('fingerprint.bright', 'default hat is HF-dominant', { kind: 'absolute', metric: 'bandHi', min: 0.6 }),
  d('tone.dir', 'tone brightens the metal band', { kind: 'directional', param: 'tone', from: 4000, to: 13000, metric: 'meanCentroidHz', direction: 'up', minDelta: 500 }),
  d('decay.dir', 'decay knob lengthens the tail', { kind: 'directional', param: 'decay', from: 0.03, to: 0.6, metric: 'decaySeconds', direction: 'up', minDelta: 0.1 }, {}, 1.5),
  d('hpf.dir', 'hpf removes body from below', { kind: 'directional', param: 'hpf', from: 3000, to: 11000, metric: 'meanCentroidHz', direction: 'up', minDelta: 400 }),
  d('metallic.dir', 'metallic reshapes the partial mix', { kind: 'directional', param: 'metallic', from: 0, to: 1, metric: 'meanCentroidHz', direction: 'change', minDelta: 200 }),
  d('ring.dir', 'ring pulls the spectral centroid down (ring-mod sum/difference energy)', { kind: 'directional', param: 'ring', from: 0, to: 1, metric: 'meanCentroidHz', direction: 'down', minDelta: 80 }, { decay: 0.3 }, 1.5),
  d('ring.levelride', 'ring=1 stays level-matched to ring=0 (F4: was a +7.3dB ride)', { kind: 'absolute', metric: 'peakDb', min: -15.84, max: -11.84 }, { ring: 1, decay: 0.3 }, 1.5),
  d('level.dir', 'level raises output', { kind: 'directional', param: 'level', from: 0.3, to: 0.8, metric: 'peakDb', direction: 'up', minDelta: 4 }),
];
