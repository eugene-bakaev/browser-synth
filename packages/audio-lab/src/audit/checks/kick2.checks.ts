// kick2 audit check table. Descriptor ground truth (packages/shared/src/engines/kick2.ts):
// tune 30-120 def 50 · punch 0-1 · pitchDecay 0.005-0.2 · decay 0.05-1.5 · click 0-1 ·
// drive 0-1 · droop 0-1 · level 0-1 def 0.9.
//
// CALIBRATED (Task 6, two consecutive `npm run lab:audit` runs, numbers in the
// commit body / task-6-report.md). Deviations from the original plan draft:
//  - PERC allows CLIPPING: kick2's default patch (level=0.9, no mixer gain
//    staging on the raw kernel) measures +0.09dB — every check that touches
//    a default-ish level clips by design, not a bug (known truth, see
//    baselines.ts header and memory `audio-lab-tool`).
//  - fingerprint.peak max bumped 0 -> 0.5 to fit that +0.09dB.
//  - punch.dir: meanCentroidHz was near-flat (Δ15.5Hz vs minDelta 60) ->
//    switched to bandMid per the plan's documented fallback (Δ0.307).
//  - click.dir: bandHi never moves (click's 4ms noise burst is a rounding
//    error against the averaged spectrum) -> switched to peakDb, the only
//    metric that actually responds to the click transient (Δ2.93dB).
//  - droop.dir: f0WidthHz was unstable/CLIPPING-only-driven -> switched to
//    the plan's documented fallback (medianF0, direction down) rendered
//    over a body-long decay=1.2 patch so the droop ramp has time to act
//    before the amp envelope dies (Δ-7.26Hz).
//  - tune/drive/level.dir: correct metric+direction, but margin was <2x
//    (1.88x / 1.43x / 1.91x) -> minDelta lowered to restore >=2x margin.
import type { CheckSpec } from '../types';
import { drumBase } from './baselines';

const PERC = ['MOSTLY_SILENT', 'CLIPPING']; // one-shots in a longer window flag
// MOSTLY_SILENT by design; kick2's raw, unstaged kernel clips at its own
// default level (+0.09dB measured) — CLIPPING is truth, not a bug.
const d = (id: string, title: string, a: CheckSpec['assertion'], params: Record<string, number> = {}, seconds = 1.2): CheckSpec => ({
  id: `kick2.${id}`, engine: 'kick2', title, baseline: drumBase('kick2', params, seconds),
  assertion: a, allowedHealth: PERC,
});

export const kick2Checks: CheckSpec[] = [
  d('fingerprint.peak', 'default hit is audible', { kind: 'absolute', metric: 'peakDb', min: -12, max: 0.5 }),
  d('fingerprint.decay', 'default decay in expected window', { kind: 'absolute', metric: 'decaySeconds', min: 0.1, max: 0.9 }),
  d('fingerprint.centroid', 'default spectral centroid in kick range', { kind: 'absolute', metric: 'meanCentroidHz', min: 40, max: 2500 }),
  d('tune.dir', 'tune raises the dominant spectral peak', { kind: 'directional', param: 'tune', from: 40, to: 100, metric: 'domPeakHz', direction: 'up', minDelta: 20 }),
  d('punch.dir', 'punch changes the spectral balance (mid-band energy)', { kind: 'directional', param: 'punch', from: 0, to: 1, metric: 'bandMid', direction: 'change', minDelta: 0.1 }),
  d('pitchDecay.dir', 'longer pitch decay = more time spent high', { kind: 'directional', param: 'pitchDecay', from: 0.01, to: 0.18, metric: 'medianF0', direction: 'up', minDelta: 5 }),
  d('decay.dir', 'decay knob lengthens the tail', { kind: 'directional', param: 'decay', from: 0.1, to: 1.2, metric: 'decaySeconds', direction: 'up', minDelta: 0.2 }, {}, 2),
  d('click.dir', 'click raises peak output (added transient)', { kind: 'directional', param: 'click', from: 0, to: 1, metric: 'peakDb', direction: 'up', minDelta: 1.2 }),
  d('drive.dir', 'drive brightens via added harmonics', { kind: 'directional', param: 'drive', from: 0, to: 1, metric: 'meanCentroidHz', direction: 'up', minDelta: 30 }),
  d('droop.dir', 'droop pulls the sustained pitch down (body-long decay)', { kind: 'directional', param: 'droop', from: 0, to: 1, metric: 'medianF0', direction: 'down', minDelta: 3 }, { decay: 1.2 }, 2),
  d('level.dir', 'level raises output', { kind: 'directional', param: 'level', from: 0.3, to: 0.9, metric: 'peakDb', direction: 'up', minDelta: 4 }),
];
