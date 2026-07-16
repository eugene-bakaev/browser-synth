// Sanity metrics an agent checks before trusting any other number: a render
// with NON_FINITE or MOSTLY_SILENT flags means the patch (or the DSP) is
// broken, not that the feature under test misbehaved.
import type { AudioClip } from '../types';
import { SILENCE_FLOOR_DB, db } from './envelope';

export interface HealthReport {
  clippedSamples: number;
  nonFiniteSamples: number;
  dcOffset: number;
  longestSilenceSeconds: number;
  flags: string[];
}

const CLIP_LEVEL = 0.999;
const DC_FLAG_LEVEL = 0.01;
const SILENCE_HOP_S = 0.005;
// 0.85 (not 0.9): flag with margin — the canonical "mostly silent" test case is a
// 90%-silent clip, and a 0.9 threshold puts it exactly on a float-fragile boundary.
const MOSTLY_SILENT_RATIO = 0.85;

export function analyzeHealth(clip: AudioClip): HealthReport {
  const { samples, sampleRate } = clip;
  let clipped = 0;
  let nonFinite = 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (!Number.isFinite(s)) {
      nonFinite++;
      continue;
    }
    if (Math.abs(s) >= CLIP_LEVEL) clipped++;
    sum += s;
  }
  const finiteCount = samples.length - nonFinite;
  const dcOffset = finiteCount ? sum / finiteCount : 0;

  const hop = Math.max(1, Math.round(SILENCE_HOP_S * sampleRate));
  let longestRun = 0;
  let run = 0;
  for (let start = 0; start + hop <= samples.length; start += hop) {
    let sq = 0;
    for (let i = start; i < start + hop; i++) {
      const s = samples[i];
      if (Number.isFinite(s)) sq += s * s;
    }
    if (db(Math.sqrt(sq / hop)) < SILENCE_FLOOR_DB) {
      run++;
      if (run > longestRun) longestRun = run;
    } else {
      run = 0;
    }
  }
  const longestSilenceSeconds = longestRun * SILENCE_HOP_S;
  const durationSeconds = samples.length / sampleRate;

  const flags: string[] = [];
  if (clipped > 0) flags.push('CLIPPING');
  if (nonFinite > 0) flags.push('NON_FINITE');
  if (Math.abs(dcOffset) > DC_FLAG_LEVEL) flags.push('DC_OFFSET');
  if (durationSeconds > 0 && longestSilenceSeconds / durationSeconds > MOSTLY_SILENT_RATIO) {
    flags.push('MOSTLY_SILENT');
  }

  return { clippedSamples: clipped, nonFiniteSamples: nonFinite, dcOffset, longestSilenceSeconds, flags };
}
