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
