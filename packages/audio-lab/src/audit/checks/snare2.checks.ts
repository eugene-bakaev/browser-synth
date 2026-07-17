// snare2 audit check table. Descriptor ground truth (packages/shared/src/engines/snare2.ts):
// tune 100-340 def 180 · bodyDecay 0.02-0.4 · noiseDecay 0.02-0.5 · snappy 0-1 def 0.6 ·
// tone 800-8000 def 3500 · noiseHp 0-1 def 0.4 · level 0-1 def 0.9.
//
// CALIBRATED (Task 6, two consecutive `npm run lab:audit` runs, numbers in the
// commit body / task-6-report.md). Deviations from the original plan draft:
//  - PERC allows CLIPPING: at snappy=0.9 (a noise-dominant patch, needed to
//    isolate tone/noiseHp from the shell), extreme tone/noiseHp values clip
//    the raw, unstaged kernel — same known truth as kick2, not a bug.
//  - tone.dir: meanCentroidHz moved the WRONG direction (Δ-264Hz — the
//    per-frame unweighted centroid is dominated by the always-bright
//    "wires" noise band regardless of `tone`) -> switched to domPeakHz,
//    which tracks the averaged-spectrum peak crossing from the shell's low
//    partial to the brightened noise band as tone rises (Δ+5320Hz).
//  - noiseHp.dir: bandLo moved the WRONG direction (Δ+0.006 — bandLo is
//    already near its floor at the default 300Hz highpass cutoff, so a
//    shrinking "wires" share just lets the fixed-low shell residue take a
//    bigger slice of a smaller pie) -> switched to bandMid, direction down,
//    which cleanly tracks energy leaving the mid band as the highpass
//    cutoff rises (Δ-0.0745).
//  - level.dir: correct metric+direction but margin was 1.91x -> minDelta
//    lowered 5 -> 4 to restore >=2x margin (same log-ratio math as kick2's
//    level.dir, hence the identical constant).
import type { CheckSpec } from '../types';
import { drumBase } from './baselines';

const PERC = ['MOSTLY_SILENT', 'CLIPPING'];
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
  d('tone.dir', 'tone brightens the noise band (dominant peak shifts up)', { kind: 'directional', param: 'tone', from: 1200, to: 7000, metric: 'domPeakHz', direction: 'up', minDelta: 2000 }, { snappy: 0.9 }),
  d('noiseHp.dir', 'noise highpass shifts energy out of the mid band', { kind: 'directional', param: 'noiseHp', from: 0, to: 1, metric: 'bandMid', direction: 'down', minDelta: 0.03 }, { snappy: 0.9 }),
  d('level.dir', 'level raises output', { kind: 'directional', param: 'level', from: 0.3, to: 0.9, metric: 'peakDb', direction: 'up', minDelta: 4 }),
];
